#!/usr/bin/env node
// Explicit opt-in, fake methods only. Root owns live qualification; this does not start the hand renderer.
import { constants, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openClient } from '../compat/client.mjs';
import { acquireLiveLock } from '../live-lock.mjs';
import { bounded, closeOwnedClient, runProbe } from './event-channel.mjs';
import { inspectLiveLock } from './event-channel-recovery.mjs';
import { shellExecWrapper } from '../../plugins/sleight/lib/engine-launch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function fileHash(path) {
  const canonical = realpathSync(path);
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw Error('identity file is not regular');
    const digest = sha256(readFileSync(fd)), after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        realpathSync(path) !== canonical) throw Error('identity file changed while hashing');
    return digest;
  } finally { closeSync(fd); }
}
/** Hash argument bytes and entrypoint bytes without recording unknown argument strings or environment values. */
export function captureIdentity(server) {
  try {
    // ChatGPT 26.1117's `/bin/sh -c 'export …; exec "$@"'` wrapper names its entrypoint (node_repl) at args[3].
    const wrapped = Boolean(shellExecWrapper(server.command, server.args));
    if (typeof server.command !== 'string' || !server.command.startsWith('/') || !Array.isArray(server.args) ||
        !server.args.every(arg => typeof arg === 'string') || !wrapped && server.args.length && !server.args[0].startsWith('/'))
      throw Error('engine command or entrypoint shape is unsupported');
    const entrypointArgIndex = wrapped ? 3 : server.args.length ? 0 : null;
    const hashes = paths => Object.freeze(Object.fromEntries(paths.map(path => [path, fileHash(resolve(ROOT, path))])));
    const probes = hashes(['bench/hand/event-channel.mjs', 'bench/hand/event-channel-live.mjs', 'tests/hand-event-channel.test.mjs',
      'bench/hand/event-channel-recovery.mjs', 'tests/hand-event-channel-recovery.test.mjs']);
    const dependencies = hashes(['plugins/sleight/lib/document-scope.mjs', 'plugins/sleight/lib/launch.mjs',
      'plugins/sleight/lib/owned-group.mjs', 'bench/compat/client.mjs', 'bench/live-lock.mjs']);
    const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 1000 }).trim();
    if (!/^[a-f0-9]{40}$/.test(head)) throw Error('invalid source HEAD');
    return Object.freeze({ source: Object.freeze({ head, probes, dependencies }), engine: Object.freeze({
      commandSha256: fileHash(server.command), commandSelectorSha256: sha256(server.command),
      entrypointSha256: fileHash(entrypointArgIndex === null ? server.command : server.args[entrypointArgIndex]), entrypointArgIndex,
      argsSha256: sha256(JSON.stringify(server.args)), argCount: server.args.length,
    }) });
  } catch { throw Error('candidate or engine identity could not be captured safely'); }
}

export async function runLive({ live = false, out, timeoutMs = 10000, signal, exists = existsSync,
  lock = acquireLiveLock, resolve: resolveServer, open = openClient, env = process.env, collect,
  identify = captureIdentity, write = writeSync, inspectLock = inspectLiveLock } = {}) {
  const refused = reason => ({ version: 1, status: 'refused', reason, retainLiveLock: false });
  if (!live) return refused('requires explicit --live');
  if (exists('/tmp/sleight-hold')) return refused('/tmp/sleight-hold exists');
  if (exists('/tmp/sleight-live.lock')) return refused('/tmp/sleight-live.lock exists');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) return refused('timeout must be 50 to 30000 ms');
  if (!out || !out.startsWith('/private/tmp/') || resolve(out) !== out || existsSync(out)) return refused('--out must be an absent normalized directory under /private/tmp');
  const parent = lstatSync(dirname(out));
  if (!parent.isDirectory() || realpathSync(dirname(out)) !== dirname(out)) return refused('output parent must be an ordinary directory without symlink ancestors');
  let unlock, holdTimer, openUncertain = false;
  const holdController = new AbortController();
  signal = signal ? AbortSignal.any([signal, holdController.signal]) : holdController.signal;
  const report = { version: 1, status: 'fail', cases: [], retainLiveLock: false, startedAt: Date.now(),
    scope: 'fake guard methods and read-FIFO transport only; no native dispatch or hand pacing claim' };
  let created = false, outIdentity, receiptIdentity;
  report.receiptPath = resolve(out, 'receipt.json');
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
  const persist = () => {
    const current = lstatSync(out);
    if (!same(current, outIdentity) || !current.isDirectory() || realpathSync(out) !== out) throw Error('output directory identity changed');
    let fd;
    try {
      fd = openSync(report.receiptPath, constants.O_WRONLY | constants.O_NOFOLLOW |
        (receiptIdentity ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
      const stat = fstatSync(fd), path = lstatSync(report.receiptPath);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 ||
          receiptIdentity && !same(stat, receiptIdentity) || !same(stat, path)) throw Error('receipt file identity changed');
      receiptIdentity = stat;
      ftruncateSync(fd, 0);
      const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
      for (let offset = 0; offset < bytes.length;) {
        const size = write(fd, bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(size) || size <= 0 || size > bytes.length - offset) throw Error('receipt write did not advance');
        offset += size;
      }
      fsyncSync(fd);
    } finally { if (fd !== undefined) closeSync(fd); }
  };
  const save = () => {
    if (!created) return true;
    try { persist(); return true; }
    catch (error) {
      report.status = 'fail'; report.retainLiveLock = true;
      if (report.finishedAt && report.lockRelease?.state !== 'release-unconfirmed')
        report.lockRelease = { state: 'retained', confirmed: false };
      report.receiptFailure = String(error.message).slice(0, 500);
      // A replaced path is left alone. Only a fresh, exclusive diagnostic in the same verified directory may be written.
      report.receiptPath = resolve(out, `diagnostic-${randomUUID()}.json`); receiptIdentity = undefined;
      try { persist(); } catch (diagnosticError) { report.diagnosticFailure = String(diagnosticError.message).slice(0, 500); }
      return false;
    }
  };
  try {
    unlock = await lock('/tmp/sleight-live.lock', { wait: false, signal });
    try { report.liveLock = Object.freeze(inspectLock('/tmp/sleight-live.lock')); }
    catch (error) { report.retainLiveLock = true; throw error; }
    if (exists('/tmp/sleight-hold')) throw Error('/tmp/sleight-hold appeared before engine start');
    mkdirSync(out, { mode: 0o700 }); created = true; outIdentity = lstatSync(out);
    if (!save()) throw Error('initial receipt could not be saved');
    holdTimer = setInterval(() => {
      if (exists('/tmp/sleight-hold')) holdController.abort(Error('/tmp/sleight-hold appeared during probe'));
    }, 20);
    resolveServer ??= (await import('../../plugins/sleight/lib/launch.mjs')).resolveServer;
    const resolved = resolveServer(env);
    if (resolved.error) throw Error(resolved.error);
    const server = Object.freeze({ ...resolved, args: Object.freeze([...(resolved.args ?? [])]) });
    report.identity = identify(server);
    if (!save()) throw Error('candidate identity receipt could not be saved');
    const verifyIdentity = () => {
      if (JSON.stringify(identify(server)) !== JSON.stringify(report.identity)) throw Error('candidate or engine identity changed during run');
    };
    for (const approval of [false, true]) for (const delivery of ['during', 'after-result']) {
      signal?.throwIfAborted();
      if (exists('/tmp/sleight-hold')) throw Error('/tmp/sleight-hold appeared between cases');
      verifyIdentity();
      // Use the raw engine configuration selected by Sleight, with no relay instrumentation or vendor edits.
      openUncertain = true;
      let opening, engine;
      try {
        engine = await bounded(() => (opening = Promise.resolve(open({ command: server.command, args: server.args,
          env: { ...env, ...server.env }, turnMeta: true, name: 'sleight-hand-channel-probe', timeoutMs,
          startupTimeoutMs: 10000, approve: () => ({ action: 'decline' }) }))), 22000, signal);
      } catch (error) {
        // Cancellation can win before initialize returns. Collect the same owned client if it arrives later.
        opening?.then(async client => {
          try { report.lateCleanup = await closeOwnedClient(client, { collect }); }
          catch (closeError) { report.lateClientFailure = String(closeError.message).slice(0, 500); }
          save();
        }).catch(() => {});
        throw error;
      }
      openUncertain = false;
      report.activeClientPid = Number.isSafeInteger(engine.pid) ? engine.pid : null;
      const receipt = await runProbe({ engine, root: out, approval, delivery, timeoutMs, signal, collect,
        onCreated: manifest => { report.activeManifest = manifest; if (!save()) throw Error('manifest receipt could not be saved'); } });
      report.cases.push(receipt); delete report.activeManifest; delete report.activeClientPid;
      report.retainLiveLock ||= receipt.retainLiveLock;
      if (!save()) throw Error('receipt identity changed');
      if (receipt.status !== 'pass') throw Error(receipt.failure?.message ?? 'probe failed');
    }
    verifyIdentity();
    report.status = 'pass';
  } catch (error) {
    report.status = 'fail'; report.failure = { message: String(error.message).slice(0, 500), code: error.code ?? null };
    report.retainLiveLock ||= openUncertain;
  } finally {
    clearInterval(holdTimer);
    report.finishedAt = Date.now();
    // The terminal file must be complete and synced while this run still holds the lock.
    // Its release field deliberately does not claim an outcome that would require a post-unlock write.
    report.lockRelease = { state: report.retainLiveLock ? 'retained' : 'eligible-after-terminal-save', confirmed: false };
    const terminalSaved = save();
    if (terminalSaved && unlock && !report.retainLiveLock) try {
      await unlock(); report.lockReleased = true;
    } catch (error) {
      report.status = 'fail'; report.retainLiveLock = true; report.lockFailure = String(error.message);
      report.lockRelease = { state: 'release-unconfirmed', confirmed: false }; save();
    }
  }
  return report;
}

export async function main(args) {
  let live = false, out, timeoutMs = 10000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') live = true;
    else if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--timeout-ms') timeoutMs = Number(args[++i]);
    else { console.error('Usage: node bench/hand/event-channel-live.mjs --live --out /private/tmp/ABSENT --timeout-ms 10000'); return 2; }
  }
  const controller = new AbortController();
  const interrupt = signal => controller.abort(Error(`cancelled by ${signal}`));
  const int = () => interrupt('SIGINT'), term = () => interrupt('SIGTERM');
  process.once('SIGINT', int); process.once('SIGTERM', term);
  try {
    const report = await runLive({ live, out, timeoutMs, signal: controller.signal });
    console.log(JSON.stringify({ status: report.status, receipt: report.receiptPath,
      retainLiveLock: report.retainLiveLock, lockReleased: report.lockReleased === true,
      failure: report.failure ?? report.receiptFailure ?? report.reason }));
    return report.status === 'pass' ? 0 : report.status === 'refused' ? 2 : 1;
  } finally { process.removeListener('SIGINT', int); process.removeListener('SIGTERM', term); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
