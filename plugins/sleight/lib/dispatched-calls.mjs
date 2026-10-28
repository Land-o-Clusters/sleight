import { parseCell, walk, memberCall, literalValue, UNKNOWN } from './code-ast.mjs';

// Native acquisitions determine flow destinations. Browser discovery factories
// are read-only helpers; createBrowserTab remains guarded as navigation.
const guarded = new Set(['getApp', 'click', 'doubleClick', 'rightClick', 'setValue', 'typeText', 'pressKey', 'paste',
  'scroll', 'selectText', 'performSecondaryAction', 'performAction', 'drag', 'fill', 'type', 'pressSequentially',
  'press', 'goto', 'createBrowserTab', 'back', 'forward', 'reload']);

function shape(node) {
  if (typeof node === 'bigint') return ['bigint', node.toString()];
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(shape);
  return Object.fromEntries(Object.keys(node).filter(key => !['range', 'start', 'end', 'loc'].includes(key))
    .sort().map(key => [key, shape(node[key])]));
}
function data(value) {
  if (Array.isArray(value)) return ['array', value.map(data)];
  if (value && typeof value === 'object') return ['object', Object.keys(value).sort().map(key => [key, data(value[key])])];
  return [typeof value, typeof value === 'number' ? Object.is(value, -0) ? '-0' : String(value) : value];
}

export function guardedCalls(ast, within = () => true) {
  const records = [];
  for (const node of walk(ast)) {
    if (node.type !== 'CallExpression' || !within(node)) continue;
    const call = memberCall(node);
    if (!call || call.method !== UNKNOWN && !guarded.has(call.method)) continue;
    records.push(JSON.stringify({ receiver: shape(call.receiver), method: call.method === UNKNOWN ? shape(node.callee) : call.method,
      computed: call.computed, optional: call.optional, args: call.args.map(arg => {
        const value = literalValue(arg);
        return value === UNKNOWN ? ['unknown', shape(arg)] : ['literal', data(value)];
      }) }));
  }
  return records.sort();
}

export function sameGuardedCalls(inspected, dispatched) {
  const before = parseCell(inspected), after = parseCell(dispatched);
  return !before.error && !after.error && JSON.stringify(guardedCalls(before.ast)) === JSON.stringify(guardedCalls(after.ast));
}

// Obtain trusted helper calls from the same wrapper around an inert cell. The
// wrapper's caller fragment must retain the inspected multiset independently.
// This keeps source text and comments unchanged, and checks the complete final
// AST instead of relying on a substring that might occur in quoted data too.
export function dispatchInspection(inspected) {
  const before = parseCell(inspected);
  const expected = before.error ? [] : guardedCalls(before.ast);
  let marked = false, trusted = [], valid = !before.error;
  return {
    mark(code) { if (marked) throw new Error('caller source already marked'); marked = true; return code; },
    wrap(code, transform) {
      const source = parseCell(code), baseline = parseCell(transform('void 0;'));
      if (source.error || baseline.error || JSON.stringify(expected) !== JSON.stringify(guardedCalls(source.ast))) valid = false;
      if (!baseline.error) trusted.push(...guardedCalls(baseline.ast));
      return transform(code);
    },
    rewrite(input, transform) {
      const output = transform(input);
      if (output === input) return output;
      const at = output.indexOf(input);
      // A replacement inside the previous cell receives no allowance. Its
      // complete call multiset must stay unchanged, or verification refuses it.
      if (at >= 0 && at === output.lastIndexOf(input)) {
        const parsed = parseCell(output);
        if (!parsed.error) trusted.push(...guardedCalls(parsed.ast,
          node => node.range[1] <= at || node.range[0] >= at + input.length));
      }
      return output;
    },
    verify(dispatched) {
      const after = parseCell(dispatched);
      return valid && marked && !after.error &&
        JSON.stringify([...expected, ...trusted].sort()) === JSON.stringify(guardedCalls(after.ast));
    },
  };
}
