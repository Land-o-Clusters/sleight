import { walk, literalValue, parseCell, UNKNOWN } from './code-ast.mjs';
import { pageCode, lexicalIndex, propertyName, unchain, isFunction, escapedSyntax } from './page-code.mjs';
import { pageCallbackEscape } from './page-callbacks.mjs';
import { EVALUATE_ACTION } from './tab-errors.mjs';

const setters = { value: 'fill', checked: 'check', innerHTML: 'read', textContent: 'read', className: 'read',
  selected: 'select', selectedIndex: 'select', scrollTop: 'scroll', scrollLeft: 'scroll', fetch: 'read',
  draggable: 'read', cssText: 'read' };
const methods = { click: 'click', dispatchEvent: 'read', createEvent: 'read', addEventListener: 'read',
  append: 'read', prepend: 'read', replaceWith: 'read', remove: 'read', insertAdjacentHTML: 'read',
  setAttribute: 'read', appendChild: 'drag', insertBefore: 'drag', removeChild: 'drag', replaceChild: 'drag',
  submit: 'read', requestSubmit: 'read' };
const ambiguousMethods = new Set(['append', 'prepend', 'replaceWith', 'remove', 'insertAdjacentHTML']);

// Only bindings created inside the transferred function exist in its page realm.
// Captured kernel variables cannot shadow page globals. Nested lexical scopes can.
function writeIn(fn, plan) {
  const localScopes = new Set([...walk(fn)].map(node => plan.scopes.get(node)));
  const inside = binding => binding && localScopes.has(binding.scope);
  const local = node => node?.type === 'Identifier' && inside(plan.lookup(node.name, node));
  const bindingKind = (binding, seen) => {
    if (!inside(binding) || seen.has(binding)) return;
    const next = new Set(seen).add(binding);
    const values = [...binding.values.map(value => {
      let result = kind(value.node, next);
      // Destructuring does not establish a data exemption. Keep page taint and
      // fetch aliases, and let other destructured values remain unknown.
      if (value.path.length && result === 'data') return;
      for (const key of value.path) if (result === 'page' && key === 'fetch') result = 'fetch';
      return result;
    }), ...binding.writes.map(node => kind(node, next))];
    // A data exemption needs every assignment to be data. A page source is kept
    // across branches and reassignments so data never launders a page alias.
    if (values.includes('page')) return 'page';
    if (values.includes('fetch')) return 'fetch';
    if (values.length && values.every(value => value === 'data')) return 'data';
  };
  function kind(node, seen = new Set()) {
    node = unchain(node);
    if (node?.type === 'Identifier') {
      const binding = plan.lookup(node.name, node);
      if (inside(binding)) return bindingKind(binding, seen);
      if (['document', 'window', 'globalThis'].includes(node.name)) return 'page';
      if (node.name === 'fetch') return 'fetch';
      if (node.name === 'location') return 'page';
    }
    if (node?.type === 'Literal' || isFunction(node) || node?.type === 'ClassExpression' || node?.type === 'ClassDeclaration') return 'data';
    if (node?.type === 'ArrayExpression') return node.elements.every(part => part === null || kind(part, seen) === 'data') ? 'data' : 'page';
    if (node?.type === 'ObjectExpression') return node.properties.every(part => part.type === 'Property' &&
      part.kind === 'init' && (!part.computed || literalValue(part.key) !== UNKNOWN) && kind(part.value, seen) === 'data') ? 'data' : 'page';
    if (node?.type === 'AwaitExpression') return kind(node.argument, seen);
    if (['ConditionalExpression', 'LogicalExpression', 'SequenceExpression'].includes(node?.type)) {
      const values = (node.type === 'ConditionalExpression' ? [node.consequent, node.alternate]
        : node.type === 'LogicalExpression' ? [node.left, node.right] : node.expressions).map(part => kind(part, seen));
      if (values.includes('page')) return 'page';
      if (values.includes('fetch')) return 'fetch';
      if (values.every(value => value === 'data')) return 'data';
    }
    if (node?.type === 'MemberExpression') {
      const receiver = kind(node.object, seen);
      return receiver === 'page' && propertyName(node) === 'fetch' ? 'fetch' : receiver;
    }
    if (node?.type === 'CallExpression') {
      const callee = unchain(node.callee);
      if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'JSON' &&
          !local(callee.object) && propertyName(callee) === 'parse') return 'data';
      if (callee.type === 'MemberExpression' && kind(callee.object, seen) === 'page') return 'page';
    }
  }
  const writes = [];
  const add = (node, v, action) => writes.push({ token: { at: node.range[0], v }, action });
  function assignmentTargets(target) {
    target = unchain(target);
    if (!target) return [];
    if (target.type === 'RestElement') return assignmentTargets(target.argument);
    if (target.type === 'AssignmentPattern') return assignmentTargets(target.left);
    if (target.type === 'ArrayPattern') return target.elements.flatMap(assignmentTargets);
    if (target.type === 'ObjectPattern') return target.properties.flatMap(part => assignmentTargets(part.value ?? part.argument));
    return [target];
  }
  for (const node of walk(fn)) {
    if (node.type === 'Identifier' && ['eval', 'Function'].includes(node.name)) {
      const parent = plan.parents.get(node);
      if (!(parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)) add(node, node.name, 'read');
    }
    if (node.type === 'NewExpression') {
      const callee = unchain(node.callee), member = callee.type === 'MemberExpression';
      const name = member ? propertyName(callee) : callee.name;
      if (typeof name === 'string' && (member ? kind(callee.object) !== 'data' : !local(callee))) {
        const action = ['DataTransfer', 'DragEvent'].includes(name) ? 'drag' : /Event$/.test(name) || name === 'Function' ? 'read' : undefined;
        if (action) add(member ? callee.property : callee, name, action);
      }
    }
    if (node.type === 'CallExpression') {
      const callee = unchain(node.callee);
      if (callee.type === 'Identifier') {
        if (callee.name === 'fetch' && !local(callee) || kind(callee) === 'fetch') add(callee, 'fetch', 'read');
        if (kind(callee) === 'page') add(callee, 'evaluate', 'read');
        if (['eval', 'Function'].includes(callee.name)) add(callee, callee.name, 'read');
      } else if (callee.type === 'MemberExpression') {
        const name = propertyName(callee), receiver = kind(callee.object);
        if (callee.computed && !['string', 'number', 'boolean'].includes(typeof name) && name !== null) add(callee.property, 'evaluate', 'read');
        if (['eval', 'Function'].includes(name)) add(callee.property, name, 'read');
        if (['set', 'assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(name) &&
            (kind(node.arguments[0]) !== 'data' || callee.object.type === 'Identifier' && callee.object.name === 'Reflect' && name === 'set')) add(callee.property, name, 'read');
        if (name === 'fetch' && receiver !== 'data') add(callee.property, 'fetch', 'read');
        if (receiver === 'data' || !Object.hasOwn(methods, name)) continue;
        if (ambiguousMethods.has(name) && receiver !== 'page') continue;
        const attribute = literalValue(node.arguments[0]);
        const action = name === 'setAttribute' && ['value', 'checked', 'selected'].includes(attribute) ? setters[attribute] : methods[name];
        add(callee.property, name, action);
      }
    }
    if (['AssignmentExpression', 'UpdateExpression'].includes(node.type)) {
      for (const target of assignmentTargets(node.left ?? node.argument)) {
        if (target.type === 'Identifier' && target.name === 'fetch' && !local(target)) add(target, 'fetch', 'read');
        if (target.type === 'Identifier' && target.name === 'location' && !local(target)) add(target, 'location', 'read');
        if (target.type !== 'MemberExpression' || kind(target.object) === 'data') continue;
        const name = propertyName(target);
        const action = Object.hasOwn(setters, name) ? setters[name]
          : ['location', 'cookie'].includes(name) || typeof name === 'string' && /^on\w+$/.test(name) ||
            kind(target.object) === 'page' && ['href', 'pathname', 'search', 'hash'].includes(name) ||
            target.computed && name === UNKNOWN ? 'read' : undefined;
        if (action) add(target.property, name, action);
      }
    }
  }
  return writes.sort((a, b) => a.token.at - b.token.at)[0];
}

export function evaluateWrite(code, handles) {
  if (typeof code !== 'string') return;
  const plan = pageCode(code, handles);
  const escaped = pageCallbackEscape(code, handles, plan);
  let writes = escaped ? [{ token: escaped, action: 'read' }]
    : plan.callbacks.map(fn => writeIn(fn, plan)).filter(Boolean).sort((a, b) => a.token.at - b.token.at);
  if (!escaped) for (const evaluation of plan.evaluations) {
    for (const source of stringArguments(evaluation.argument, plan)) {
      const wrapped = `(${source}\n)`, parsed = parseCell(wrapped);
      const script = parsed.error ? parseCell(source) : parsed;
      const innerCode = parsed.error ? source : wrapped;
      const inner = script.error ? null : { ...script, ...lexicalIndex(script.ast) };
      const escape = inner && escapedSyntax(innerCode, inner.ast, [[0, innerCode.length]]);
      const write = inner && !escape && writeIn(inner.ast, inner);
      if (!inner || escape || write) writes.push({ token: { at: evaluation.argument.range[0], v: write?.token?.v ?? 'evaluate' }, action: write?.action ?? 'read' });
    }
  }
  if (!writes.length) {
    const refused = plan.evaluations.find(evaluation => evaluation.dynamic || evaluation.unsafeArgument);
    if (refused) writes = [{ token: { at: (unchain(refused.node.callee).property ?? unchain(refused.node.callee)).range[0], v: 'evaluate' }, action: 'read' }];
  }
  for (const reference of plan.references ?? []) writes.push({ token: { at: reference.range[0], v: 'evaluate' }, action: 'read' });
  writes.sort((a, b) => a.token.at - b.token.at);
  const write = writes[0];
  if (!write) return;
  const line = code.slice(0, write.token.at).split('\n').length;
  const action = EVALUATE_ACTION[write.action];
  const advice = action ? ` ${write.action === 'read' ? 'Read the controls with' : 'Use'} ${action}.` : '';
  return `Line ${line}: evaluate is read-only; ${write.token.v} cannot run there.${advice} Rejected before the engine call.`;
}

// Resolve source strings without evaluating templates, wrappers or prior cells.
function stringArguments(node, plan, seen = new Set()) {
  if (!node) return [];
  const value = literalValue(node);
  if (typeof value === 'string') return [value];
  if (node.type !== 'Identifier') return [];
  const binding = plan.lookup(node.name, node);
  if (!binding || seen.has(binding)) return [];
  const next = new Set(seen).add(binding);
  return [...binding.values.filter(value => !value.path.length).map(value => value.node), ...binding.writes]
    .flatMap(part => stringArguments(part, plan, next));
}
