import { tokens, invalidTokens, codeInspectionRefusal } from './flow-rules.mjs';

const actions = new Set(['click', 'doubleClick', 'rightClick', 'setValue', 'typeText', 'pressKey', 'paste',
  'scroll', 'selectText', 'performSecondaryAction', 'performAction']);

// Keep occurrences, including repeated targets, so completed actions can leave
// the pending set without discarding another use of the same observed number.
export function literalElements(code) {
  const ts = tokens(code), numbers = [];
  if (invalidTokens(ts)) throw new Error(codeInspectionRefusal);
  if (ts.some(t => t.v === '<template>')) return numbers;
  for (let i = 0; i < ts.length - 4; i++) if (ts[i].v === '.' && actions.has(ts[i + 1].v) &&
      ts[i + 2].v === '(' && !ts[i + 3].string && /^\d+$/.test(ts[i + 3].v) &&
      [',', ')'].includes(ts[i + 4].v)) numbers.push(Number(ts[i + 3].v));
  return numbers;
}
