import { MAC_DRIVER_SENTENCES, GLIDE_INTERRUPT_NOTICE } from './errors.mjs';

// The session owns the latch across native calls, stepped helpers and restarts.
// Only an attributed person prompt can reset Stop; no worker API exposes this.
export function createGlideStopSession({ control, resetHelper = () => true, stopHelper = () => {} } = {}) {
  let stopped = false, interrupted = false, onStop, cleanup, cleanupFailure, cleaning = false;
  const operations = new Set();
  const check = () => {
    if (stopped || interrupted) throw Object.assign(Error(interrupted ? GLIDE_INTERRUPT_NOTICE : MAC_DRIVER_SENTENCES.USER_STOPPED),
      { code: 'USER_STOPPED', interrupted, next: 'stop-tell-user', delivery: 'not-sent', retry: 'safe' });
  };
  const reset = () => {
    if (operations.size || cleaning || resetHelper() === false) return false;
    stopped = false; interrupted = false; return true;
  };
  const collect = () => {
    cleaning = true;
    const current = Promise.resolve().then(stopHelper).catch(error => { cleanupFailure = error; }).finally(() => {
      if (cleanup !== current) return;
      cleaning = false;
      if (interrupted && !operations.size) reset();
    });
    cleanup = current;
  };
  const stop = () => {
    if (stopped) return false;
    stopped = true; interrupted = false;
    cleanupFailure = undefined;
    for (const operation of operations) operation.cancel();
    collect();
    return true;
  };
  const interrupt = () => {
    // Interruption blocks input only while the current action releases it.
    // A later person Stop promotes that transient block to the session latch.
    if (stopped || interrupted) return false;
    interrupted = true;
    cleanupFailure = undefined;
    for (const operation of operations) operation.cancel();
    collect();
    return true;
  };
  const settled = async () => {
    await cleanup;
    if (cleanupFailure) throw Object.assign(Error(interrupted ? GLIDE_INTERRUPT_NOTICE : MAC_DRIVER_SENTENCES.USER_STOPPED),
      { code: 'USER_STOPPED', interrupted, next: 'stop-tell-user', delivery: 'unknown', retry: 'read-first', unhealthy: true,
        ...cleanupFailure.stopRelease ? { stopRelease: cleanupFailure.stopRelease } : {},
        ...cleanupFailure.stopHelperRetired === true ? { stopHelperRetired: true } : {} });
  };
  return Object.freeze({ check, stop, interrupt, settled,
    setStopHandler(handler) { onStop = handler; },
    async begin(window, cancel) {
      check();
      if (!operations.size) { cleanup = undefined; cleanupFailure = undefined; }
      let live = true, end;
      const operation = { cancel() {
        try { cancel(); } catch (error) { cleanupFailure = error; }
      } };
      operations.add(operation);
      const finish = async () => {
        if (!live) return;
        live = false;
        try { await settled(); }
        finally {
          operations.delete(operation); end?.();
          if (interrupted && !operations.size) reset();
        }
      };
      try {
        end = await control.beginGlideStop(window, () => {
          if (!live || stopped) return;
          // The relay owns Stop. Its interruptTurn synchronously sets this
          // latch before it drains or collects the engine.
          if (onStop) onStop();
          else stop();
        });
        Object.defineProperty(finish, 'controlUnavailable', { get: () => end?.controlUnavailable === true });
        finish.failure = end?.failure;
        return finish;
      } catch (error) { await finish(); throw error; }
    },
    userPrompt: reset,
  });
}
