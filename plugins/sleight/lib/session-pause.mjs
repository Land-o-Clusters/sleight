// In-memory, per relay session. Only the native host's person controls set this state.
export const PAUSED_NOTE = /* notice */ "Paused by the user. Wait for resume; don't retry.";
export const PAUSE_DRAIN_NOTE = /* notice */ 'Native call finishing. Wait for its result.';
export const PAUSE_CONTROL_LOST_NOTE = /* notice */ 'Resume from the sleight menu bar, or start a new session.';
export const NATIVE_PAUSE_CUT_NOTE = /* notice */ 'Paused. Ran: see result. Unsent: approval or tail. Read window.';
export function createSessionPause() {
  let paused = false, epoch = 0;
  const listeners = new Set();
  return Object.freeze({
    get paused() { return paused; },
    set(value) {
      if (typeof value !== 'boolean' || value === paused) return;
      paused = value;
      if (paused) epoch++;
      for (const listener of listeners) listener(paused);
    },
    checkpoint() {
      const admitted = epoch;
      return () => { if (paused || admitted !== epoch) throw Object.assign(Error(PAUSED_NOTE), { paused: true, notRun: true }); };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
}
