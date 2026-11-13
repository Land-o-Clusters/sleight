// Shared syntax and lexical bindings for page preflight and callback masking.
// Unknown receivers are checked as page code, but never trusted for masking.
import { parseCell, memberCall, literalValue, walk, UNKNOWN } from './code-ast.mjs';

export const isFunction = node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);
export const unchain = node => node?.type === 'ChainExpression' ? node.expression : node;
export const propertyName = node => node?.computed ? literalValue(node.property)
  : node?.property?.type === 'Identifier' ? node.property.name : undefined;
const factories = new Set(['locator', 'frameLocator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'filter', 'first', 'last', 'nth', 'and', 'or']);
const pageKinds = new Set(['tab', 'playwright', 'locator']);
export const evaluationMethods = new Set(['evaluate', 'evaluateAll', 'evaluateHandle', '$eval', '$$eval', 'addInitScript',
  'waitForFunction', 'addScriptTag', 'addStyleTag', 'setContent', 'exposeFunction', 'route']);
const knownKey = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);

export function lexicalIndex(ast) {
  const scopes = new Map(), parents = new Map(), declarations = new Set(), bindings = [];
  const scope = (parent, fn = false) => ({ parent, fn, names: new Map() });
  const root = scope(null, true);
  function lookup(name, at) {
    for (let current = scopes.get(at); current; current = current.parent) {
      if (current.names.has(name)) return current.names.get(name);
    }
  }
  function declare(pattern, current, value, path = []) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      declarations.add(pattern);
      let binding = current.names.get(pattern.name);
      if (!binding) {
        binding = { name: pattern.name, scope: current, values: [], refs: [], writes: [] };
        current.names.set(pattern.name, binding); bindings.push(binding);
      }
      binding.values.push({ node: value, path });
    } else if (pattern.type === 'RestElement') declare(pattern.argument, current, null);
    else if (pattern.type === 'AssignmentPattern') declare(pattern.left, current, value, path);
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((part, i) => declare(part, current, value, [...path, i]));
    else if (pattern.type === 'ObjectPattern') for (const part of pattern.properties) {
      if (part.type === 'RestElement') declare(part.argument, current, null);
      else declare(part.value, current, value, [...path, part.computed ? literalValue(part.key) : part.key.name ?? part.key.value]);
    }
  }
  function visit(node, current, parent) {
    if (!node?.type) return;
    parents.set(node, parent);
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') declare(node.id, current, node);
    if (isFunction(node)) {
      current = scope(current, true);
      if (node.type === 'FunctionExpression') declare(node.id, current, node);
      node.params.forEach(parameter => declare(parameter, current, null));
    } else if (['BlockStatement', 'StaticBlock', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'ClassExpression', 'ClassDeclaration'].includes(node.type)) {
      // Function-body vars are invisible to parameter defaults. Class static
      // blocks also have their own var boundary.
      current = scope(current, node.type === 'StaticBlock' || node.type === 'BlockStatement' && isFunction(parent));
      if (node.type === 'CatchClause') declare(node.param, current, null);
      if (node.type.startsWith('Class')) declare(node.id, current, node);
    }
    scopes.set(node, current);
    if (node.type === 'VariableDeclaration') {
      let target = current;
      if (node.kind === 'var') while (!target.fn) target = target.parent;
      node.declarations.forEach(part => declare(part.id, target, part.init));
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'range') continue;
      if (Array.isArray(value)) value.forEach(child => { if (child?.type) visit(child, current, node); });
      else if (value?.type) visit(value, current, node);
    }
  }
  visit(ast, root, null);
  function targets(node, value) {
    if (!node) return;
    if (node.type === 'Identifier') lookup(node.name, node)?.writes.push(value);
    else if (node.type === 'RestElement') targets(node.argument, null);
    else if (node.type === 'AssignmentPattern') targets(node.left, null);
    else if (node.type === 'ArrayPattern') node.elements.forEach(part => targets(part, null));
    else if (node.type === 'ObjectPattern') node.properties.forEach(part => targets(part.value ?? part.argument, null));
  }
  for (const node of walk(ast)) {
    if (node.type === 'AssignmentExpression') targets(node.left, node.operator === '=' ? node.right : null);
    if (node.type === 'UpdateExpression') targets(node.argument, null);
    if (['ForInStatement', 'ForOfStatement'].includes(node.type) && node.left.type !== 'VariableDeclaration') targets(node.left, null);
    if (node.type !== 'Identifier' || declarations.has(node)) continue;
    const parent = parents.get(node);
    if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed ||
        parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand ||
        ['MethodDefinition', 'PropertyDefinition'].includes(parent?.type) && parent.key === node && !parent.computed ||
        ['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent?.type)) continue;
    lookup(node.name, node)?.refs.push(node);
  }
  return { scopes, parents, bindings, lookup };
}

// The free conventional handles cover cells referring to a previous REPL cell.
// A local declaration always wins. The relay supplies its confirmed handle set too.
export function pageCode(code, handles = new Set()) {
  const parsed = parseCell(code);
  if (parsed.error) return { ...parsed, evaluations: [], callbacks: [], ranges: [] };
  const index = lexicalIndex(parsed.ast);
  const seeds = new Map([['tab', 'tab'], ['locator', 'locator'], ...[...handles].map(name => [name, 'tab'])]);
  const tainted = new Set(), freeValues = new Map();
  function taintObject(target) {
    for (const part of walk(target)) if (part.type === 'Identifier') {
      const parent = index.parents.get(part);
      if (parent?.type === 'MemberExpression' && parent.property === part && !parent.computed) continue;
      tainted.add(index.lookup(part.name, part) ?? part.name);
    }
    // Writes through the global object can replace a conventional free handle.
    if ([...walk(target)].some(part => part.type === 'Identifier' && part.name === 'globalThis' && !index.lookup(part.name, part))) {
      for (const name of seeds.keys()) tainted.add(name);
      tainted.add('cua');
    }
  }
  function memberTargets(target) {
    if (!target) return;
    if (target.type === 'MemberExpression') { taintObject(target.object); return; }
    if (target.type === 'RestElement') memberTargets(target.argument);
    if (target.type === 'AssignmentPattern') memberTargets(target.left);
    if (target.type === 'ArrayPattern') target.elements.forEach(memberTargets);
    if (target.type === 'ObjectPattern') target.properties.forEach(part => memberTargets(part.value ?? part.argument));
  }
  for (const node of walk(parsed.ast)) {
    const mutation = memberCall(node);
    if (node.type === 'CallExpression' && mutation &&
        mutation.receiver.type === 'Identifier' && ['Object', 'Reflect'].includes(mutation.receiver.name) &&
        ['assign', 'defineProperty', 'defineProperties', 'set', 'setPrototypeOf'].includes(mutation.method)) taintObject(mutation.args[0]);
    const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument
      : ['ForInStatement', 'ForOfStatement'].includes(node.type) ? node.left : null;
    if (!target) continue;
    memberTargets(target);
    // An assignment to a free REPL name can replace a prior handle. A write
    // through a handle can replace evaluate or one of its receiver factories.
    for (const part of walk(target)) if (part.type === 'Identifier') {
      const parent = index.parents.get(part);
      if (parent?.type === 'MemberExpression' && parent.property === part && !parent.computed) continue;
      const binding = index.lookup(part.name, part);
      if (target.type === 'MemberExpression') tainted.add(binding ?? part.name);
      else if (!binding) {
        const values = freeValues.get(part.name) ?? [];
        values.push({ node: node.type === 'AssignmentExpression' && node.operator === '=' && target.type === 'Identifier' ? node.right : null,
          statement: index.parents.get(node) });
        freeValues.set(part.name, values);
      }
    }
  }
  // A receiver alias shares the object it names. Replacing alias.evaluate
  // also invalidates the original handle's page provenance.
  const pending = [...tainted];
  for (let i = 0; i < pending.length; i++) {
    const binding = pending[i];
    if (typeof binding === 'string') continue;
    for (const { node } of binding.values) {
      for (const source of walk(node)) {
        if (source.type !== 'Identifier') continue;
        const parent = index.parents.get(source);
        if (parent?.type === 'MemberExpression' && parent.property === source && !parent.computed ||
            parent?.type === 'Property' && parent.key === source && !parent.computed && !parent.shorthand) continue;
        const original = index.lookup(source.name, source) ?? source.name;
        if (!tainted.has(original)) { tainted.add(original); pending.push(original); }
      }
    }
  }
  function kind(node, seen = new Set()) {
    node = unchain(node);
    if (node?.type === 'AwaitExpression') return kind(node.argument, seen);
    if (node?.type === 'Identifier') {
      const binding = index.lookup(node.name, node);
      if (tainted.has(binding ?? node.name)) return;
      const identity = binding ?? node.name;
      if (seen.has(identity)) return;
      const next = new Set(seen).add(identity);
      if (!binding) {
        const values = freeValues.get(node.name);
        if (!values) return seeds.get(node.name);
        // A free prior-cell value may have been a kernel helper. Require a
        // preceding unconditional assignment in this cell before masking it.
        if (!values.some(value => value.statement?.type === 'ExpressionStatement' &&
            index.parents.get(value.statement)?.type === 'Program' && value.statement.range[1] <= node.range[0])) return;
        const kinds = values.map(value => kind(value.node, next));
        return kinds[0] && kinds.every(value => value === kinds[0]) ? kinds[0] : undefined;
      }
      const kinds = [...binding.values.filter(value => value.node).map(value => {
        let result = kind(value.node, next);
        for (const key of value.path) result = result === 'tab' && key === 'playwright' ? 'playwright' : undefined;
        return result;
      }), ...binding.writes.map(value => kind(value, next))];
      return kinds[0] && kinds.every(value => value === kinds[0]) ? kinds[0] : undefined;
    }
    if (node?.type === 'MemberExpression') {
      const receiver = kind(node.object, seen), key = propertyName(node);
      if (receiver === 'tab' && key === 'playwright') return 'playwright';
      if (['browser', 'tab'].includes(receiver) && key === 'tabs') return 'tabs';
      if (receiver === 'locators' && typeof key === 'number') return 'locator';
    }
    const call = memberCall(node);
    if (!call) return;
    if (call.receiver.type === 'Identifier' && call.receiver.name === 'cua' && !index.lookup('cua', call.receiver) &&
        !tainted.has('cua') && !freeValues.has('cua')) {
      if (['getTab', 'createBrowserTab'].includes(call.method)) return 'tab';
      if (call.method === 'getBrowser') return 'browser';
    }
    const receiver = kind(call.receiver, seen);
    if (receiver === 'tabs' && ['get', 'new'].includes(call.method)) return 'tab';
    if (pageKinds.has(receiver) && factories.has(call.method)) return 'locator';
    if (pageKinds.has(receiver) && call.method === 'all') return 'locators';
  }
  function callback(node, seen = new Set()) {
    if (isFunction(node)) return { fn: node, bindings: [] };
    if (node?.type !== 'Identifier') return;
    const binding = index.lookup(node.name, node);
    if (!binding || binding.writes.length || binding.values.length !== 1 || seen.has(binding)) return;
    const value = binding.values[0];
    if (value.path.length) return;
    const result = callback(value.node, new Set(seen).add(binding));
    if (result) return { fn: result.fn, bindings: [...result.bindings, binding] };
  }
  function candidates(node, seen = new Set()) {
    if (!node) return [];
    // writeIn walks every descendant of a function, including nested functions.
    if (isFunction(node)) return [node];
    if (node.type === 'Identifier') {
      const binding = index.lookup(node.name, node);
      if (!binding || seen.has(binding)) return [];
      const next = new Set(seen).add(binding);
      return [...binding.values.map(value => value.node), ...binding.writes].flatMap(value => candidates(value, next));
    }
    // Include wrappers, IIFEs, bind, await, containers and every branch. Never
    // infer that an unknown call returns the functions we find inside it.
    return Object.values(node).flatMap(value => Array.isArray(value)
      ? value.flatMap(child => child?.type ? candidates(child, seen) : [])
      : value?.type ? candidates(value, seen) : []);
  }
  const evaluations = [], callbacks = [], ranges = [], references = [], pageReferences = new Set();
  const nodes = [...walk(parsed.ast)];
  const directCallee = node => {
    let parent = index.parents.get(node);
    if (parent?.type === 'ChainExpression') { node = parent; parent = index.parents.get(node); }
    return parent?.type === 'CallExpression' && parent.callee === node;
  };
  // Mention-based boundary: a method cannot escape through an alias, key or
  // reflective lookup. This also covers definitions that can replace a method.
  const mentions = nodes.filter(node => {
    if (node.type === 'MemberExpression') return evaluationMethods.has(propertyName(node));
    if (node.type === 'Identifier') return evaluationMethods.has(node.name);
    const parent = index.parents.get(node);
    return ['Literal', 'TemplateLiteral'].includes(node.type) && evaluationMethods.has(literalValue(node)) &&
      (parent?.type === 'Property' && parent.key === node ||
       parent?.type === 'MemberExpression' && parent.property === node);
  });
  for (const node of mentions) {
    const parent = index.parents.get(node);
    if (parent?.type === 'MemberExpression' && parent.property === node) continue;
    if (!directCallee(node)) references.push(node);
  }
  if (mentions.length || nodes.some(node => evaluationMethods.has(literalValue(node)))) for (const node of nodes) {
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'Reflect' &&
        ['apply', 'get'].includes(propertyName(node))) references.push(node);
  }
  for (const node of walk(parsed.ast)) {
    if (node.type !== 'CallExpression') continue;
    const callee = unchain(node.callee);
    const call = memberCall(node) ?? (callee.type === 'Identifier' && evaluationMethods.has(callee.name)
      ? { receiver: undefined, method: callee.name, args: node.arguments } : null);
    if (!call) continue;
    const indirect = ['bind', 'call', 'apply'].includes(call.method) && call.receiver?.type === 'MemberExpression' &&
      evaluationMethods.has(propertyName(call.receiver));
    const dynamic = indirect || call.computed && !knownKey(literalValue(unchain(node.callee).property));
    if (!dynamic && !evaluationMethods.has(call.method)) continue;
    const argument = call.args[['$eval', '$$eval', 'exposeFunction', 'route'].includes(call.method) ? 1 : 0];
    const resolved = callback(argument);
    evaluations.push({ node, call, argument, resolved, dynamic,
      unsafeArgument: ['setContent', 'addScriptTag', 'addStyleTag'].includes(call.method) ||
        !resolved && !(['Literal', 'TemplateLiteral'].includes(argument?.type) && typeof literalValue(argument) === 'string') });
    callbacks.push(...candidates(argument));
    if (resolved) {
      if (argument.type === 'Identifier' && pageKinds.has(kind(call.receiver)) && !dynamic) pageReferences.add(argument);
    }
  }
  // A named function used by kernel code must stay visible in its entirety.
  // Alias references are safe only if each reference ends at a page argument.
  const safeBinding = (binding, seen = new Set()) => {
    if (seen.has(binding)) return false;
    return binding.refs.every(ref => {
      if (pageReferences.has(ref)) return true;
      const parent = index.parents.get(ref);
      const alias = parent?.type === 'VariableDeclarator' && parent.init === ref && parent.id.type === 'Identifier'
        ? index.lookup(parent.id.name, parent.id) : null;
      return alias && !alias.writes.length && safeBinding(alias, new Set(seen).add(binding));
    });
  };
  for (const evaluation of evaluations) {
    const { call, argument, resolved } = evaluation;
    if (evaluation.dynamic || !pageKinds.has(kind(call.receiver)) || !resolved || !resolved.bindings.every(binding => safeBinding(binding))) continue;
    evaluation.masked = true;
    const fn = resolved.fn;
    // Defaults execute in the page too. Retain a declaration's closing brace:
    // it separates a following same-line kernel statement for the diagnostic.
    ranges.push([argument === fn ? fn.range[0] : fn.id?.range[1] ?? fn.range[0],
      fn.range[1] - (fn.type === 'FunctionDeclaration' ? 1 : 0)]);
  }
  return { ...parsed, ...index, kind, references, evaluations, callbacks: [...new Set(callbacks)], ranges };
}

// PS4R's escape boundary stays in force even though Meriyah decodes the names.
export function escapedSyntax(code, ast, spans) {
  return [...walk(ast)].filter(node => node.type === 'Identifier' || node.type === 'MemberExpression' && node.computed)
    .map(node => node.type === 'MemberExpression' ? node.property : node)
    .filter(node => code.slice(...node.range).includes('\\') && spans.some(([start, end]) => node.range[0] >= start && node.range[1] <= end))
    .sort((a, b) => a.range[0] - b.range[0])[0];
}
