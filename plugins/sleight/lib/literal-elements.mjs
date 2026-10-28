import { codeInspectionRefusal } from './flow-rules.mjs';
import { parseCell, walk, memberCall, literalValue, UNKNOWN } from './code-ast.mjs';

import { unsafeHandleUse } from './call-inspection.mjs';

const actions = new Set(['click', 'doubleClick', 'rightClick', 'setValue', 'typeText', 'pressKey', 'paste',
  'scroll', 'selectText', 'performSecondaryAction', 'performAction']);

// Keep occurrences, including repeated targets, so completed actions can leave
// the pending set without discarding another use of the same observed number.
export function literalElements(code) {
  const { ast, error } = parseCell(code), numbers = [];
  if (error || unsafeHandleUse(ast)) throw new Error(codeInspectionRefusal);
  // Deliberate parity with the old pending-number guard. Interpolated templates
  // suppress the entire order, even when an expression contains an action.
  if ([...walk(ast)].some(node => node.type === 'TemplateLiteral' && node.expressions.length)) return numbers;
  for (const node of walk(ast)) {
    if (node.type !== 'CallExpression') continue;
    const call = memberCall(node);
    if (!call) continue;
    if (call.method === UNKNOWN) {
      Object.defineProperty(numbers, 'unknown', { value: (numbers.unknown ?? 0) + 1, configurable: true });
      continue; // The document proxy validates computed targets before input.
    }
    if (!actions.has(call.method)) continue;
    const value = literalValue(call.args[0]);
    // Non-literal selectors are intentionally outside the literal order. The
    // document proxy resolves and validates them before input.
    if (value === UNKNOWN) Object.defineProperty(numbers, 'unknown', { value: (numbers.unknown ?? 0) + 1, configurable: true });
    if (Number.isInteger(value) && value >= 0) numbers.push(value);
  }
  return numbers;
}
