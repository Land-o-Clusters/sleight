import { requireCompound } from './intent.mjs';

// One watch per logical compound, retained across every internal RPC. Sampling
// cannot arbitrate input arriving after the final sample. No wait or reset API.
export function createCompoundPersonWatch(sample) {
  let previous, stopped;
  return Object.freeze({
    async check() {
      if (stopped) throw Object.assign(Error(stopped), { code: stopped });
      try {
        const current = await sample();
        requireCompound(current && current.valid === true && Number.isFinite(current.at) && current.at >= 0 &&
          Number.isFinite(current.lastInput) && current.lastInput <= current.at &&
          Number.isSafeInteger(current.eventSequence) && current.eventSequence >= 0 &&
          typeof current.targetScopedQuiet === 'boolean' && typeof current.heldModifiers === 'boolean' &&
          typeof current.heldButtons === 'boolean' && typeof current.secureInput === 'boolean' &&
          typeof current.locked === 'boolean' && typeof current.onConsole === 'boolean' &&
          typeof current.focusChanged === 'boolean', 'PERSON_STATE_UNAVAILABLE');
        requireCompound(!current.locked && current.onConsole, 'SCREEN_LOCKED');
        requireCompound(!current.secureInput, 'SECURE_INPUT_ACTIVE');
        requireCompound(!current.heldModifiers && !current.heldButtons, 'PERSON_HOLDS_MODIFIER');
        requireCompound(!current.focusChanged, 'BACKGROUND_UNAVAILABLE');
        requireCompound(current.targetScopedQuiet && current.at - current.lastInput >= 500, 'PERSON_TOOK_OVER');
        if (previous) {
          requireCompound(current.at >= previous.at && current.eventSequence >= previous.eventSequence &&
            current.lastInput >= previous.lastInput, 'PERSON_STATE_UNAVAILABLE');
          requireCompound(current.eventSequence === previous.eventSequence && current.lastInput === previous.lastInput,
            'PERSON_TOOK_OVER');
        }
        previous = { ...current }; return current;
      } catch (error) {
        stopped = ['PERSON_TOOK_OVER', 'PERSON_HOLDS_MODIFIER', 'SCREEN_LOCKED', 'SECURE_INPUT_ACTIVE',
          'BACKGROUND_UNAVAILABLE'].includes(error.code) ? error.code : 'PERSON_STATE_UNAVAILABLE';
        throw Object.assign(Error(stopped), { code: stopped });
      }
    },
    get stopped() { return stopped; },
  });
}
