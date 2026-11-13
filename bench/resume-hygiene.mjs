// Continue only deferred pass hygiene, never task execution or scoring.
import { lstatSync, readFileSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForBenchmark, benchmarkHeld, benchmarkStopCode } from './hold.mjs';
import { beginWindowControl, finishWindows, quitLaunched } from './pass-hygiene.mjs';
import { observePermission } from './real-permission.mjs';

export async function resumeCleanup(receipt, { ownerAway = false, signal } = {}, {
  lockPath = '/tmp/sleight-live.lock', held = benchmarkHeld, wait = waitForBenchmark,
  control = beginWindowControl, permission = observePermission, log = console.log,
} = {}) {
  if (!ownerAway) throw Error('Deferred cleanup requires --owner-away');
  const file = lstatSync(receipt);
  if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077)) throw Error('Cleanup receipt must be a private owned regular file');
  const data = JSON.parse(readFileSync(receipt, 'utf8'));
  if (data.version !== 1 || !data.lock || !data.hygiene || !Array.isArray(data.hygiene.launched)) throw Error('Invalid cleanup receipt');
  if (data.complete) return { complete: true };
  const checkLock = () => {
    const lock = lstatSync(lockPath);
    if (!lock.isDirectory() || lock.dev !== data.lock.dev || lock.ino !== data.lock.ino) throw Error('Live lock ownership changed; refusing cleanup');
  };
  checkLock();
  const owner = receipt + '.resuming';
  mkdirSync(owner);
  try {
    await wait({ signal, held });
    signal?.throwIfAborted(); checkLock();
    if (held()) throw Object.assign(Error('Benchmark hold returned before cleanup'), { code: 'BENCH_HOLD_LIMIT' });
    const io = await control({ signal });
    const { before, touchedProcesses = [], ...options } = data.hygiene;
    const beforeAction = async () => {
      signal?.throwIfAborted(); checkLock();
      if (await permission()) throw Error('macOS permission prompt: cleanup stopped');
    };
    // Check permission and interruption for quits too, including receipts-only cleanup.
    const act = async item => {
      await beforeAction();
      signal?.throwIfAborted(); checkLock();
      if (held()) return { deferred: true };
      return io.act(item);
    };
    const result = before ? await finishWindows(before, { ...options, ...io, act, log,
      touchedProcesses: new Map(touchedProcesses), deferVisible: held, beforeAction })
      : await quitLaunched({ ...options, ...io, act, log, deferVisible: held });
    const complete = !held() && !result.deferred && !result.errors.length && !result.leftWindows.length && !data.fixtureCleanupUnconfirmed;
    writeFileSync(receipt, JSON.stringify({ ...data, leftWindows: result.leftWindows, lastCleanup: result, complete: false }, null, 2) + '\n', { mode: 0o600 });
    if (complete) {
      checkLock(); rmdirSync(lockPath);
      writeFileSync(receipt, JSON.stringify({ ...data, leftWindows: [], lastCleanup: result, complete: true }, null, 2) + '\n', { mode: 0o600 });
    }
    return { ...result, complete };
  } finally { rmdirSync(owner); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), abort = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, abort);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== '--owner-away' || args[1] !== '--receipt') throw Error('Use --owner-away --receipt FILE');
    const result = await resumeCleanup(resolve(args[2]), { ownerAway: true, signal: controller.signal });
    process.exitCode = result.complete ? 0 : benchmarkHeld() ? 75 : 1;
    console.log(`Deferred cleanup ${result.complete ? 'complete' : 'unconfirmed; live lock kept'}`);
  } catch (error) { console.error(error.message); process.exitCode = benchmarkStopCode(error, controller.signal) ?? 1; }
  finally { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, abort); }
}
