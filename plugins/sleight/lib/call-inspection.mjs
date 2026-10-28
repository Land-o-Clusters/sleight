import { parseCell, walk, memberCall, literalValue, UNKNOWN, callInventory, handleBindings } from './code-ast.mjs';

// Literal consumers share the parser, but retain their own policy for UNKNOWN.
export function inspectCalls(code) {
  const { ast, error } = parseCell(code);
  if (error) return { ast, error, calls: [] };
  return { ast, error, calls: callInventory(ast).map(entry => ({ node: entry.node, call: memberCall(entry.node), kind: entry.kind })) };
}

export function receiverRoot(node) {
  if (node?.type === 'ChainExpression') return receiverRoot(node.expression);
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression') {
    if (node.object.type === 'Identifier' && node.object.name === 'globalThis')
      return node.computed ? typeof literalValue(node.property) === 'string' ? literalValue(node.property) : undefined : node.property.name;
    return receiverRoot(node.object);
  }
  if (node?.type === 'CallExpression') return receiverRoot(node.callee);
}

// Native options can be partly known. Preserve known mistakes beside unknown
// fields, without evaluating expressions or assuming a spread's final value.
export function argumentValue(node) {
  const value = literalValue(node);
  if (value !== UNKNOWN) return value;
  if (node?.type === 'ArrayExpression' && !node.elements.some(item => item?.type === 'SpreadElement'))
    return node.elements.map(item => item ? argumentValue(item) : undefined);
  if (node?.type === 'ObjectExpression') {
    const out = Object.create(null);
    for (const field of node.properties) {
      if (field.type !== 'Property' || field.kind !== 'init' || field.method || field.shorthand || field.computed) return UNKNOWN;
      const key = field.key.type === 'Identifier' ? field.key.name : literalValue(field.key);
      if (!['string', 'number'].includes(typeof key)) return UNKNOWN;
      out[key] = argumentValue(field.value);
    }
    return out;
  }
  return UNKNOWN;
}

// Extracting a method or invoking it through another callable loses the receiver
// and signature proof. Refuse these uses before any guarded handle can dispatch.
export function unsafeHandleUse(ast, known = new Set(['app'])) {
  const handles = new Set(known);
  for (const node of walk(ast)) if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') handles.delete(node.id.name);
  for (const [name, hint] of handleBindings(ast)) if (['app', 'browser', 'locator'].includes(hint.kind)) handles.add(name);
  for (const node of walk(ast)) if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
      ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot'].includes(memberCall(node.init)?.method)) handles.delete(node.id.name);
  for (const node of walk(ast)) if (node.type === 'Identifier' && /^__sleightOpenedApp\d+$/.test(node.name)) handles.add(node.name);
  const nodes = [...walk(ast)], parents = new Map();
  // A lost destination hint never proves that the value stopped being a handle.
  for (const node of nodes) {
    const left = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : undefined;
    const right = node.type === 'VariableDeclarator' ? node.init : node.right;
    if (left?.type === 'Identifier' && ['getApp', 'getTab', 'getBrowser', 'createBrowserTab'].includes(memberCall(right)?.method)) handles.add(left.name);
  }
  const aliasSource = node => {
    if (!node) return false;
    if (node.type === 'Identifier') return handles.has(node.name);
    if (node.type === 'AwaitExpression') return aliasSource(node.argument);
    if (node.type === 'ChainExpression') return aliasSource(node.expression);
    if (node.type === 'ConditionalExpression') return aliasSource(node.consequent) || aliasSource(node.alternate);
    if (node.type === 'LogicalExpression') return aliasSource(node.left) || aliasSource(node.right);
    if (node.type === 'SequenceExpression') return aliasSource(node.expressions.at(-1));
    if (node.type === 'ObjectExpression') return node.properties.some(p => p.type === 'Property' && aliasSource(p.value));
    if (node.type === 'ArrayExpression') return node.elements.some(aliasSource);
    return false;
  };
  // Include assignment aliases and containers, even when declared before the
  // source handle. A fixed point is conservative about loops and nested scopes.
  let changed;
  do {
    changed = false;
    for (const node of nodes) {
      const left = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : undefined;
      const right = node.type === 'VariableDeclarator' ? node.init : node.right;
      if (left?.type === 'Identifier' && !handles.has(left.name) && aliasSource(right)) { handles.add(left.name); changed = true; }
    }
  } while (changed);
  for (const node of nodes) for (const value of Object.values(node)) {
    if (Array.isArray(value)) { for (const child of value) if (child?.type) parents.set(child, node); }
    else if (value?.type) parents.set(value, node);
  }
  for (const node of nodes) {
    if (node.type === 'VariableDeclarator' && ['ObjectPattern', 'ArrayPattern'].includes(node.id.type) && handles.has(receiverRoot(node.init))) return true;
    if (node.type !== 'MemberExpression' || !handles.has(receiverRoot(node.object))) continue;
    const key = node.computed ? literalValue(node.property) : node.property.name;
    if (['length', 'browserId', 'id', 'name', 'displayName', 'title', 'url', 'width', 'height', 'windows'].includes(key)) continue;
    const parent = parents.get(node);
    if (parent?.type === 'CallExpression' && parent.callee === node) continue;
    // Traversal through a locator or a method's .call/.apply is inspected at its
    // terminal member. A detached terminal member is never a proven call.
    if (parent?.type === 'MemberExpression' && parent.object === node) {
      const key = parent.computed ? literalValue(parent.property) : parent.property.name;
      if (['call', 'apply', 'bind'].includes(key)) return true;
      continue;
    }
    if (parent?.type === 'ChainExpression' && parents.get(parent)?.type === 'CallExpression') continue;
    if (parent?.type === 'AssignmentExpression' && parent.left === node) return true;
    if (parent?.type === 'CallExpression' && parent.callee !== node) return true;
    let value = node, use = parent;
    while (['AwaitExpression', 'ChainExpression'].includes(use?.type)) { value = use; use = parents.get(use); }
    if (use?.type === 'ExpressionStatement' || use?.type === 'ConditionalExpression' && use.test === value) continue;
    // Every other use detaches the method, including assignment, conditional,
    // getter and object-property aliases. Data fields above carry no callable.
    return true;
  }
  return false;
}
