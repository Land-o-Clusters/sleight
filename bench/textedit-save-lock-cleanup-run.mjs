import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, stat, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLiveLock } from './live-lock.mjs';

export async function cleanupFailedTextEditLaunch({ report, trial, bank }, cleanup = runTextEditCleanup) {
  if (!trial || trial.edit || !Number.isInteger(trial.failedOperation?.pid)) return false;
  const result = {};
  report.failedLaunchCleanup = result;
  try {
    return await cleanup({ prior: { ...report, failedOperation: trial.failedOperation, trials: [trial], bank,
      finished: new Date().toISOString(), lockRetained: true }, report: result });
  } catch (error) { result.error = error.message; return false; }
}

// Shared by the CLI and offline tests. A hold blocks inspection as well as cleanup.
export async function runTextEditCleanup({ prior, report, inspectOnly = false, signal }, io = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const checkHold = io.checkHold ?? (async () => {
    signal?.throwIfAborted();
    try { await access('/tmp/sleight-hold'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    report.holdPresent = true;
    throw new Error('Live hold exists; cleanup stopped');
  });
  await checkHold();
  const start = Date.parse(prior.started), finish = Date.parse(prior.finished), pid = prior.failedOperation?.pid;
  if (!prior.lockRetained || !Number.isInteger(pid) || pid < 1 || !Number.isFinite(start) || !Number.isFinite(finish) ||
      finish < start || !Array.isArray(prior.trials) || prior.trials.some(t => t.edit) ||
      !/^\/private\/tmp\/sleight-save-lock-[A-Za-z0-9]+$/.test(prior.bank ?? '')) throw new Error('Report does not prove an unedited owned launch');
  const statLock = io.statLock ?? (() => stat('/tmp/sleight-live.lock'));
  let lock, release, invoked = false;
  try { lock = await statLock(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await checkHold();
    release = await (io.acquireLock ?? (() => acquireLiveLock()))();
    report.lockReacquired = true;
  }
  if (lock) {
    if (!lock.isDirectory() || lock.birthtimeMs < start - 1000 || lock.birthtimeMs > finish + 1000) throw new Error('Retained live-lock identity does not match this run');
    release = io.releaseRetained ?? (async () => {
      const current = await statLock();
      if (!current.isDirectory() || current.ino !== lock.ino || current.dev !== lock.dev) throw new Error('Live-lock ownership changed');
      await rmdir('/tmp/sleight-live.lock');
    });
  }
  report.lockHeld = true;
  try {
    await checkHold();
    const execute = io.execute ?? (async () => {
      const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/textedit-save-lock-cleanup.js'),
        join(prior.bank, 'trial.txt'), String(pid), String(start), String(finish), ...(inspectOnly ? ['inspect-only'] : [])], { timeout: 15000, signal });
      return JSON.parse(stdout);
    });
    invoked = true;
    report.result = await execute(); report.pid = pid;
    if (report.result.processQuit === true || report.result.processAbsent === true) {
      await release(); report.lockReleased = true; report.lockHeld = false;
      return true;
    }
    report.lockRetained = 'Owned TextEdit launch remains; cleanup is incomplete';
    return false;
  } catch (error) {
    // No app work happened, so a newly acquired lock can be safely returned.
    if (!invoked && report.lockReacquired) { await release(); report.lockReleased = true; report.lockHeld = false; }
    throw error;
  }
}
