import { freezeCompound, requireCompound } from './intent.mjs';
import { allowedCompoundDelta, compoundEqual } from './observation.mjs';

export const COMPOUND_TRANSITIONS = freezeCompound({
  'menu.open': ['press', 'open-menu'], 'menu.expand': ['press', 'open-menu'],
  'menu.command': ['press', 'local-command'], 'choose.open': ['press', 'open-options'],
  'menu.direct': ['press', 'local-command'],
  'choose.select': ['press', 'local-value'], 'save.open': ['press', 'open-save-panel'],
  'save.directory': ['write', 'prepare-field'], 'save.basename': ['write', 'prepare-field'],
});

// Entries are reviewed implementation code, supplied by the embedding parent.
// They are never deserialized from app data, model JSON or renderer messages.
// There are deliberately no production qualifications in this change.
export function createCompoundContracts(entries = []) {
  const records = new Map(), ids = new Set();
  for (const entry of entries) {
    const shape = COMPOUND_TRANSITIONS[entry.kind];
    requireCompound(shape && typeof entry.id === 'string' && /^[a-z0-9.-]{1,80}$/.test(entry.id) && entry.version === 1 &&
      entry.primitive === shape[0] && entry.effectClass === shape[1] && entry.background === true &&
      entry.noClipboard === true && entry.scope === 'whole-window' && typeof entry.qualifies === 'function' &&
      typeof entry.effect === 'function' && typeof entry.basis === 'string' && entry.basis.length > 0, 'INVALID_CONTRACT');
    requireCompound(!records.has(entry) && !ids.has(entry.id), 'INVALID_CONTRACT'); ids.add(entry.id);
    records.set(entry, Object.freeze({ ...entry }));
  }
  return Object.freeze({
    resolve(evidence, context) {
      const contract = records.get(evidence);
      requireCompound(contract && contract.kind === context.transition.kind && contract.qualifies(context) === true,
        'UNSUPPORTED_TRANSITION');
      return contract;
    },
    size: records.size,
  });
}
export const NO_COMPOUND_CONTRACTS = createCompoundContracts();

// Utilities for reviewed contracts. Even a true postcondition cannot waive a
// change elsewhere in the safety context. Callers enumerate exact delta paths.
export function compoundEffect(before, after, { observed, code, delta = [] }) {
  requireCompound(Array.isArray(delta) && delta.every(path => Array.isArray(path) && path.length > 0 &&
    path.every(key => typeof key === 'string' || Number.isSafeInteger(key))), 'INVALID_CONTRACT');
  // Whole binding, context, modal inventory, completeness and routing are never
  // legal exclusions. A qualification needing other semantics is unsupported.
  requireCompound(delta.every(path => ['nodes', 'domains', 'relations', 'panel', 'findUI', 'title'].includes(path[0]) &&
    (path[0] !== 'nodes' || path.length >= 2)), 'INVALID_CONTRACT');
  return { observed: observed === true && allowedCompoundDelta(before, after, delta), code };
}
export function exactPreparedDestination(snapshot, intent) {
  const p = snapshot.panel;
  return !!(p && p.standard === true && p.attachedTo === snapshot.binding.document &&
    p.pid === snapshot.binding.pid && p.processStart === snapshot.binding.processStart &&
    p.directory?.kind === 'literal-local' && p.directory?.resolved === true && typeof p.directory.identity === 'string' &&
    p.directory.identity.length > 0 && p.directory.path === intent.directory && p.basename === intent.basename &&
    p.destination === intent.destination && p.extensionChanged === false && p.formatChanged === false &&
    p.conflict === false && p.authentication === false && p.commitSent === false);
}
export const unchangedCompoundValue = compoundEqual;
