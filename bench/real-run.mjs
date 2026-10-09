import { mkdirSync, rmSync } from 'node:fs';
import { acquireLiveLock } from './live-lock.mjs';

// Only the real suite uses this lifecycle, preserving older benchmark passes.
// A cleanup failure preserves its fixture and stops the pass. The cooperative
// lock is released on exit, as the task brief requires.
export async function executeRealTask(task, ctx, { drive, dryRun = false, signal, permissionCheck, stop, lockHeld = false } = {}) {
  let release, cleanupConfirmed = false, driverStarted = false;
  let monitor, observation;
  const cleanupController = new AbortController();
  const result = {};
  ctx.signal = signal;
  ctx.cleanupSignal = cleanupController.signal;
  const observe = async () => {
    try {
      const permission = await permissionCheck();
      if (permission) {
        result.permissionPrompt = true;
        if (typeof permission === 'object') result.permissionWindow = permission;
        stop?.(); cleanupController.abort();
      }
    } catch (error) { result.observerError = error.message; stop?.(); cleanupController.abort(); throw error; }
  };
  if (!dryRun && permissionCheck) ctx.beforeFixtureCleanup = async () => { await observation; await observe(); };
  try {
    if (!dryRun && !lockHeld) release = await acquireLiveLock(ctx.lockPath ?? '/tmp/sleight-live.lock', { wait: true, signal, interval: 2000 });
    signal?.throwIfAborted();
    if (!dryRun && permissionCheck) {
      await observe();
      signal?.throwIfAborted();
      if (result.permissionPrompt) throw new Error('macOS permission prompt: stopped');
      monitor = setInterval(() => {
        if (observation) return;
        observation = observe().catch(() => {}).finally(() => { observation = undefined; });
      }, 3000);
    }
    mkdirSync(ctx.dir, { recursive: true });
    await (dryRun ? task.prepare?.(ctx) : task.setup?.(ctx));
    signal?.throwIfAborted();
    const prompt = task.prompt(ctx);
    if (dryRun) {
      Object.assign(result, { dryRun: true, prompt, check: String(await task.check({ ...ctx, answer: '' })) });
    } else {
      const started = Date.now();
      driverStarted = true;
      const response = await drive(prompt, ctx, { onPermissionRefusal: () => {
        result.permissionRefusal = true;
        // The request was dismissed or denied, so only retained-fixture cleanup
        // remains allowed. A visible system prompt still aborts all AX activity.
        stop?.();
      } });
      Object.assign(result, response);
      const verdict = await task.check({ ...ctx, answer: response.out?.result ?? '' });
      result.passed = response.code === 0 && verdict === true && !signal?.aborted && !result.permissionPrompt && !result.permissionRefusal && !result.observerError;
      result.reason = result.permissionPrompt ? 'macOS permission prompt: stopped' : result.permissionRefusal ? 'browser-access permission refused: stopped' : signal?.aborted ? 'run interrupted' :
        verdict !== true ? verdict : response.code !== 0 ? `driver exited ${response.code}` : undefined;
      result.seconds = Math.round((Date.now() - started) / 100) / 10;
    }
  } catch (error) {
    result.passed = false;
    if (driverStarted && result.groupClean !== true) result.groupClean = false;
    result.reason = result.permissionPrompt ? 'macOS permission prompt: stopped' : result.permissionRefusal ? 'browser-access permission refused: stopped' : error.message;
  } finally {
    try {
      if (result.groupClean === false) throw new Error('Owned driver process group cleanup unconfirmed');
      // A prompt may appear just as collection finishes, before the next poll.
      // Refresh before any app cleanup, including after a short setup failure.
      if (monitor) { await observation; await observe().catch(() => {}); }
      if (cleanupController.signal.aborted) {
        if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; }
        throw new Error('Fixture cleanup stopped by permission observation');
      }
      await task.cleanup?.(ctx);
      if (ctx.pendingAcquisitions?.size) throw new Error(`Fixture acquisition unconfirmed: ${[...ctx.pendingAcquisitions].join(', ')}`);
      cleanupConfirmed = true;
    }
    catch (error) { result.passed = false; result.cleanupError = error.message; }
    for (const helper of ctx.windowLeases ?? []) {
      try {
        if (!await helper.dispose()) throw new Error('Fixture helper process group cleanup unconfirmed');
      } catch (error) { result.passed = false; result.cleanupError = error.message; cleanupConfirmed = false; }
    }
    clearInterval(monitor);
    await observation;
    if (ctx.fixtureDiagnostics) result.fixtureDiagnostics = ctx.fixtureDiagnostics;
    if (result.passed === false && (driverStarted || ctx.fixtureDiagnostics?.some(item => item.actionTaken))) result.stopAfterAction = true;
    if (result.permissionPrompt) { result.passed = false; result.reason = 'macOS permission prompt: stopped'; }
    if (result.observerError) { result.passed = false; result.reason = `macOS permission observer failed: ${result.observerError}`; }
    if (cleanupConfirmed) {
      rmSync(ctx.dir, { recursive: true, force: true });
    } else result.fixtureDir = ctx.dir;
    await release?.();
  }
  return result;
}

export async function acquireFixture(ctx, key, operation) {
  ctx.pendingAcquisitions ??= new Set();
  ctx.pendingAcquisitions.add(key);
  try { ctx[key] = await operation(); }
  catch (error) { if (error.noMutation === true) ctx.pendingAcquisitions.delete(key); throw error; }
  ctx.pendingAcquisitions.delete(key);
  return ctx[key];
}
