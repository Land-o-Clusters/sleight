// In-memory, per relay session. Only the native host's person controls set this state.
export const PAUSED_NOTE = /* notice */ "Paused by the user. Wait for them to resume; don't retry.";
export const PAUSE_DRAIN_NOTE = /* notice */ 'A paused native call is still finishing. Wait for its result before another native call.';
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
