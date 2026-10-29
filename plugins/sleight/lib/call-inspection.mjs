import { parseCell, walk, memberCall, literalValue, UNKNOWN, callInventory, handleBindings, invalidHandleNames } from './code-ast.mjs';

export const codeInspectionRefusal = /* notice */ 'sleight: cannot inspect JavaScript. Use direct calls with literal arguments.';

const memberName = node => node?.type === 'MemberExpression'
  ? node.computed ? literalValue(node.property) : node.property.name : undefined;
const guarded = new Set(['typeText', 'setValue', 'pressKey', 'click', 'doubleClick', 'rightClick', 'paste', 'scroll',
  'selectText', 'performAction', 'performSecondaryAction', 'drag', 'fill', 'type', 'pressSequentially', 'press',
  'goto', 'createBrowserTab', 'back', 'forward', 'reload']);
const parentsOf = nodes => {
  const parents = new Map();
  for (const node of nodes) for (const value of Object.values(node)) {
    if (Array.isArray(value)) { for (const child of value) if (child?.type) parents.set(child, node); }
    else if (value?.type) parents.set(value, node);
  }
  return parents;
};

// Trust only the relay's complete lowering shape, never a function somewhere
// inside a sequence, property, argument or detached callable.
export function trustedInvocations(ast, code, trustedFunctions = new Set(), known = new Set(['app'])) {
  const calls = new Set(), handles = new Set(known), invalid = invalidHandleNames(ast);
  for (const node of walk(ast)) {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') handles.delete(node.id.name);
    if (node.type === 'Identifier' && /^__sleightOpenedApp\d+$/.test(node.name)) handles.add(node.name);
  }
  for (const [name, hint] of handleBindings(ast)) if (['app', 'browser', 'locator'].includes(hint.kind)) handles.add(name);
  for (const name of invalid) handles.delete(name);
  for (const outer of walk(ast)) {
    if (outer.type !== 'CallExpression' || outer.optional) continue;
    const bind = outer.callee, member = bind?.callee;
    if (bind?.type !== 'CallExpression' || bind.optional || member?.type !== 'MemberExpression' ||
        member.computed || member.optional || memberName(member) !== 'bind' || member.object.type !== 'FunctionExpression' ||
        !trustedFunctions.has(code.slice(...member.object.range))) continue;
    const [receiver, handle, array] = bind.arguments;
    if (bind.arguments.length !== 3 || literalValue(receiver) !== null || handle?.type !== 'Identifier' || !handles.has(handle.name) ||
        array?.type !== 'ArrayExpression' || literalValue(array) === UNKNOWN) continue;
    calls.add(outer); calls.add(bind);
  }
  return calls;
}

// These operations produce data. Restrict their uses to visible read sinks and
// data transformations, so a method or constructor cannot escape through them.
export function introspectionCalls(ast) {
  const nodes = [...walk(ast)], parents = parentsOf(nodes), safe = new Set();
  const shadowed = invalidHandleNames(ast);
  const forbidden = new Set(['globalThis', 'window', 'self', 'Reflect', 'Function', 'Symbol', 'prototype', '__proto__', 'defineProperty', 'assign']);
  const locals = new Set(ast.body.flatMap(node => node.type === 'VariableDeclaration'
    ? node.declarations.filter(declaration => declaration.id.type === 'Identifier').map(declaration => declaration.id.name) : []));
  const nonLocalWrite = node => {
    if (!node) return false;
    if (node.type === 'MemberExpression') return !locals.has(receiverRoot(node.object));
    if (node.type === 'ArrayPattern') return node.elements.some(nonLocalWrite);
    if (node.type === 'ObjectPattern') return node.properties.some(part => nonLocalWrite(part.type === 'RestElement' ? part.argument : part.value));
    if (node.type === 'AssignmentPattern') return nonLocalWrite(node.left);
    if (node.type === 'RestElement') return nonLocalWrite(node.argument);
    return false;
  };
  let eligible = !nodes.some(node => forbidden.has(node.type === 'Identifier' ? node.name : node.type === 'Literal' ? node.value : undefined));
  for (const node of nodes) {
    const binding = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left
      : node.type === 'UpdateExpression' ? node.argument : undefined;
    if (binding) for (const part of walk(binding)) if (part.type === 'Identifier') shadowed.add(part.name);
    const write = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument
      : node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument
      : ['ForInStatement', 'ForOfStatement'].includes(node.type) ? node.left : undefined;
    if (nonLocalWrite(write)) eligible = false;
    const call = memberCall(node);
    if (call?.receiver.type === 'Identifier' && call.receiver.name === 'Object' && call.method !== 'keys') eligible = false;
    if (node.type.startsWith('Import') && node.local?.type === 'Identifier') shadowed.add(node.local.name);
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      if (node.id) shadowed.add(node.id.name);
      for (const parameter of node.params) for (const part of walk(parameter)) if (part.type === 'Identifier') shadowed.add(part.name);
    }
    if (node.type === 'MemberExpression' && ['String', 'Object'].includes(receiverRoot(node)) &&
        (['AssignmentExpression', 'UpdateExpression'].includes(parents.get(node)?.type) ||
         parents.get(node)?.type === 'UnaryExpression' && parents.get(node).operator === 'delete')) shadowed.add(receiverRoot(node));
  }
  const dataUse = node => {
    if (!eligible) return false;
    const parent = parents.get(node);
    if (!parent || parent.type === 'ExpressionStatement') return true;
    if (['ChainExpression', 'UnaryExpression', 'BinaryExpression', 'LogicalExpression', 'ConditionalExpression', 'TemplateLiteral', 'TemplateElement'].includes(parent.type)) return dataUse(parent);
    if (parent.type === 'CallExpression' && parent.arguments.includes(node)) {
      const call = memberCall(parent);
      if (call?.receiver.type === 'Identifier' && call.receiver.name === 'JSON' && call.method === 'stringify' &&
          !shadowed.has('JSON') && parent.arguments.length === 1) return dataUse(parent);
      return call && call.receiver.type === 'Identifier' &&
        (call.receiver.name === 'nodeRepl' && call.method === 'write' || call.receiver.name === 'console' && call.method === 'log');
    }
    if (parent.type === 'MemberExpression' && parent.object === node && ['slice', 'substring', 'join'].includes(memberName(parent))) {
      const call = parents.get(parent);
      return call?.type === 'CallExpression' && call.callee === parent && dataUse(call);
    }
    return false;
  };
  for (const node of nodes) {
    if (node.type !== 'CallExpression' || node.optional || node.arguments.length !== 1 || !dataUse(node)) continue;
    if (node.callee.type === 'Identifier' && node.callee.name === 'String' && !shadowed.has('String')) safe.add(node);
    const call = memberCall(node);
    if (call?.receiver.type === 'Identifier' && call.receiver.name === 'Object' && call.method === 'keys' && !shadowed.has('Object')) safe.add(node);
  }
  return { calls: safe, dataUse, parents, eligible };
}

export function unsafeHandleRefusal(construct) {
  if (construct === 'String(handle)') construct += /* notice */ '; read-only: Object.keys(handle)';
  return /* notice */ `${codeInspectionRefusal} (${construct})`;
}

// References can carry code through callbacks or containers even when their
// eventual invocation is not visible. This is a mention-based refusal only.
export function unsafeDynamicCode(ast) {
  const nodes = [...walk(ast)], parents = parentsOf(nodes);
  for (const node of nodes) {
    if (node.type === 'MemberExpression' && ['eval', 'Function', 'constructor'].includes(memberName(node)))
      return `.${memberName(node)}`;
    if (node.type === 'Identifier' && ['eval', 'Function'].includes(node.name)) {
      const parent = parents.get(node);
      if (parent?.type !== 'CallExpression' || parent.callee !== node) return `${node.name} reference`;
    }
  }
  return false;
}

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
export function unsafeHandleUse(ast, known = new Set(['app']), { code = '', trustedFunctions } = {}) {
  const dynamic = unsafeDynamicCode(ast);
  if (dynamic) return dynamic;
  const handles = new Set(known);
  for (const node of walk(ast)) if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') handles.delete(node.id.name);
  for (const [name, hint] of handleBindings(ast)) if (['app', 'browser', 'locator'].includes(hint.kind)) handles.add(name);
  for (const node of walk(ast)) if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
      ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot'].includes(memberCall(node.init)?.method)) handles.delete(node.id.name);
  for (const node of walk(ast)) if (node.type === 'Identifier' && /^__sleightOpenedApp\d+$/.test(node.name)) handles.add(node.name);
  const nodes = [...walk(ast)];
  const { calls: readCalls, dataUse, parents, eligible } = introspectionCalls(ast);
  const trusted = trustedInvocations(ast, code, trustedFunctions, known);
  // A lost destination hint never proves that the value stopped being a handle.
  for (const node of nodes) {
    const left = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : undefined;
    const right = node.type === 'VariableDeclarator' ? node.init : node.right;
    if (left?.type === 'Identifier' && ['getApp', 'getTab', 'getBrowser', 'createBrowserTab'].includes(memberCall(right)?.method)) handles.add(left.name);
  }
  const aliasSource = node => {
    if (!node) return false;
    if (node.type === 'Identifier') return handles.has(node.name);
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'globalThis')
      return handles.has(memberName(node));
    if (node.type === 'AwaitExpression') return aliasSource(node.argument);
    if (node.type === 'ChainExpression') return aliasSource(node.expression);
    if (node.type === 'ConditionalExpression') return aliasSource(node.consequent) || aliasSource(node.alternate);
    if (node.type === 'LogicalExpression') return aliasSource(node.left) || aliasSource(node.right);
    if (node.type === 'SequenceExpression') return aliasSource(node.expressions.at(-1));
    if (node.type === 'CallExpression') {
      const call = memberCall(node);
      return call?.receiver.type === 'Identifier' && call.receiver.name === 'cua' &&
        ['getApp', 'getTab', 'getBrowser', 'createBrowserTab'].includes(call.method);
    }
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
  for (const node of nodes) {
    if (node.type === 'MemberExpression' && ['call', 'apply', 'bind'].includes(memberName(node)) && !trusted.has(parents.get(node)) &&
        (guarded.has(memberName(node.object)) || memberName(node.object) === UNKNOWN || memberName(node.object) === undefined))
      return `${String(memberName(node.object) === UNKNOWN ? 'computed method' : memberName(node.object) ?? 'callable')}.${memberName(node)}`;
    if (node.type === 'MemberExpression' && receiverRoot(node.object) === 'Reflect' && ['get', 'apply'].includes(memberName(node)))
      return `Reflect.${memberName(node)}`;
    const call = memberCall(node);
    if (call && node.type === 'CallExpression' && !trusted.has(node)) {
      if (call.receiver.type === 'Identifier' && call.receiver.name === 'Reflect' && ['apply', 'get'].includes(call.method)) return `Reflect.${call.method}`;
      if (['call', 'apply', 'bind'].includes(call.method) && guarded.has(memberName(call.receiver))) return `${memberName(call.receiver)}.${call.method}`;
    }
    const keysRead = readCalls.has(node) && memberCall(node)?.method === 'keys';
    if (['CallExpression', 'NewExpression'].includes(node.type) && !trusted.has(node) && !keysRead && node.arguments.some(aliasSource))
      return `${call?.method ?? (node.callee.type === 'Identifier' ? node.callee.name : 'indirect call')}(handle)`;
    const pattern = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : undefined;
    const source = node.type === 'VariableDeclarator' ? node.init : node.right;
    if (['ObjectPattern', 'ArrayPattern'].includes(pattern?.type) && aliasSource(source)) return `${pattern.type} handle destructuring`;
    if (node.type !== 'MemberExpression' || !handles.has(receiverRoot(node.object))) continue;
    const key = node.computed ? literalValue(node.property) : node.property.name;
    if (['length', 'browserId', 'id', 'name', 'displayName', 'title', 'url', 'width', 'height', 'windows'].includes(key)) continue;
    const parent = parents.get(node);
    if (readCalls.has(parent)) continue;
    if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof' && dataUse(parent)) continue;
    if (parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator) && dataUse(parent)) continue;
    if (parent?.type === 'CallExpression' && parent.callee === node) continue;
    // Traversal through a locator or a method's .call/.apply is inspected at its
    // terminal member. A detached terminal member is never a proven call.
    if (parent?.type === 'MemberExpression' && parent.object === node) {
      const key = parent.computed ? literalValue(parent.property) : parent.property.name;
      if (key === 'toString') {
        const call = parents.get(parent);
        if (call?.type === 'CallExpression' && call.callee === parent && !call.arguments.length && dataUse(call)) continue;
      }
      if (['call', 'apply', 'bind'].includes(key)) return `${String(memberName(node))}.${key}`;
      if (key === 'toString') return `${String(memberName(node))}.toString extraction`;
      continue;
    }
    if (parent?.type === 'ChainExpression' && parents.get(parent)?.type === 'CallExpression') continue;
    if (parent?.type === 'AssignmentExpression' && parent.left === node) return `${String(key)} member assignment`;
    if (parent?.type === 'CallExpression' && parent.callee !== node) return `${String(key)} method argument`;
    let value = node, use = parent;
    while (['AwaitExpression', 'ChainExpression'].includes(use?.type)) { value = use; use = parents.get(use); }
    if (eligible && (use?.type === 'ExpressionStatement' || use?.type === 'ConditionalExpression' && (use.test === value || dataUse(use)))) continue;
    // Every other use detaches the method, including assignment, conditional,
    // getter and object-property aliases. Data fields above carry no callable.
    return `${String(key === UNKNOWN ? 'computed' : key)} method extraction (${use?.type ?? 'unknown use'})`;
  }
  return false;
}
