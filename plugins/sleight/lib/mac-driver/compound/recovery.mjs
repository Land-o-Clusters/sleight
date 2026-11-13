import { createStuckEscapes } from '../../stuck-escape.mjs';

// External-call lifecycle only. The compound helper has no reference to this
// coordinator, and internal reads cannot contribute to the two-call episode.
export function createCompoundRecovery({ option, authorize, episodes = createStuckEscapes() }) {
  const calls = new Set(), due = new Set();
  return Object.freeze({
    observeExternal(callId, appId, evidence) {
      if (typeof callId !== 'string' || calls.has(callId) || calls.size >= 1024) return;
      calls.add(callId);
      const next = episodes.observe(appId, evidence);
      if (next === 'escape') due.add(appId);
      if (evidence?.cleared) due.delete(appId);
      return next;
    },
    async recover({ receipt, target, grant, since, personQuiet, modalAbsent, originalBinding, clock }) {
      if (!option || !receipt || !['stopped', 'uncertain'].includes(receipt.state) || !due.has(target?.appId) ||
        personQuiet !== true || modalAbsent !== true || originalBinding !== true)
        return { attempted: false, posted: false, reason: 'RECOVERY_INELIGIBLE' };
      // Global takeover remains latched even if a later sample is quiet.
      if (['PERSON_TOOK_OVER', 'PERSON_STATE_UNAVAILABLE', 'PERSON_HOLDS_MODIFIER', 'SCREEN_LOCKED',
        'SECURE_INPUT_ACTIVE', 'BACKGROUND_UNAVAILABLE'].includes(receipt.stop?.reason))
        return { attempted: false, posted: false, reason: 'RECOVERY_INELIGIBLE' };
      if (await authorize({ target, grant }) !== true)
        return { attempted: false, posted: false, reason: 'RECOVERY_REFUSED' };
      due.delete(target.appId); episodes.tried(target.appId);
      let result;
      try { result = await option.send(target, grant, { since, clock }); }
      catch { result = { posted: false, delivery: 'unknown' }; }
      if (result.posted) episodes.posted(target.appId, result.selected);
      // Independent cleanup is a receipt only. There is no resume callback.
      return { attempted: true, ...result, continuation: false };
    },
  });
}
