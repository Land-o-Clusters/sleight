import { COMPOUND_LIMITS, requireCompound } from './intent.mjs';

// Allocate the complete fixed-size disposition list before reserving input.
// Raw labels, field contents, low-entropy value hashes and grants stay out.
export function createCompoundReceipt(intent, binding) {
  const kinds = intent.operation === 'menu' ? intent.segments.map((_, i) => i === 0 ? 'menu.open' :
    i === intent.segments.length - 1 ? 'menu.command' : 'menu.expand') : intent.operation === 'choose' ?
    ['choose.open', 'choose.select'] : ['save.open', 'save.directory', 'save.basename'];
  requireCompound(kinds.length <= COMPOUND_LIMITS.steps, 'INVALID_INTENT');
  const result = { operation: intent.operation, state: 'stopped', completedSteps: 0,
    steps: kinds.map((kind, index) => ({ index, transition: kind, recipient: binding, attempts: 0,
      delivery: 'not-sent', effect: 'not-attempted', effectObserved: false })), remaining: kinds.map((_, i) => i),
    cleanup: [], observation: { status: 'unavailable' }, retry: 'read-first', replayWholeCompound: false };
  if (intent.operation === 'prepareSaveAs') Object.assign(result, { saved: false, commitSent: false });
  // Reserve against the actual bounded binding size before input, independently
  // of an optional current view. No tree is needed to retain every disposition.
  requireCompound(Buffer.byteLength(JSON.stringify(result)) + 8192 <= COMPOUND_LIMITS.receiptBytes, 'RECEIPT_CAPACITY');
  return result;
}
export function finishCompoundReceipt(result, { state, reason, index, observation, redact = false } = {}) {
  result.state = state ?? 'stopped';
  if (reason) result.stop = { index, reason };
  result.completedSteps = 0;
  for (const step of result.steps) { if (!step.effectObserved) break; result.completedSteps++; }
  result.remaining = result.steps.filter(s => s.attempts === 0 && !s.effectObserved).map(s => s.index);
  const unknown = result.steps.find(s => s.attempts > 0 && !s.effectObserved);
  if (unknown) result.unknownStep = unknown.index;
  result.observation = observation && !redact ? { status: 'available', readId: observation.readId, truncated: false } :
    { status: 'unavailable', reason: reason ?? 'FINAL_READ_UNAVAILABLE' };
  result.menuLeftOpen = observation ? observation.domains?.menu?.active === true && observation.domains.menu.container !== 'bar' ||
    observation.domains?.options?.active === true : null;
  return structuredClone(result);
}
export function encodeCompoundReceipt(receipt, cap = COMPOUND_LIMITS.receiptBytes) {
  const encoded = JSON.stringify(receipt);
  requireCompound(Number.isSafeInteger(cap) && cap >= Buffer.byteLength(encoded), 'RECEIPT_CAPACITY');
  return encoded;
}
