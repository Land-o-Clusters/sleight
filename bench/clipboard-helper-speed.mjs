// Three native byte operations, matching private Paste's read/write/restore IO.
// This measures helper IO, not engine or full-paste latency. No app or pointer input.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeClipboardIO } from '../plugins/sleight/lib/clipboard.mjs';
import { acquireLiveLock } from './live-lock.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), execute = promisify(execFile);
const helper = join(root, 'plugins/sleight/lib/clipboard.js');
const bank = process.argv[2];
if (!/^\/private\/tmp\/sleight-clipboard-[A-Za-z0-9]+$/.test(bank ?? '')) throw new Error('Pass a private bank built with bench/clipboard-build.sh');
const report = { started: new Date().toISOString(), bank, scope: 'Native helper read/write/restore; no app input or full paste timing', trials: [] };
report.source = Object.fromEntries(await Promise.all(['plugins/sleight/lib/clipboard.js', 'plugins/sleight/lib/clipboard.mjs', 'bench/clipboard-fixture.swift', 'bench/clipboard-helper-speed.mjs'].map(async path =>
  [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
report.nodeVersion = process.version;
const resultPath = join(root, 'docs/benchmarks', `${report.started.slice(0, 10)}-clipboard-helper-${Date.now()}.json`);
const ensureFree = async () => { try { await access('/tmp/sleight-hold'); } catch (e) { if (e.code === 'ENOENT') return; throw e; } throw new Error('Live hold exists; no clipboard operation attempted'); };
const equal = (a, b) => JSON.stringify(a.map(reps => [...reps].sort((x, y) => x.type.localeCompare(y.type)))) === JSON.stringify(b.map(reps => [...reps].sort((x, y) => x.type.localeCompare(y.type))));
const native = async (...args) => JSON.parse((await execute(join(bank, 'clipboard-fixture'), args, { timeout: 10000 })).stdout);
let oneShotSpawns = 0, persistentSpawns = 0;
const persistent = createNativeClipboardIO(helper, { spawnHelper: () => {
  persistentSpawns++;
  return spawn('/usr/bin/osascript', ['-l', 'JavaScript', helper, '--serve'], { stdio: ['pipe', 'pipe', 'ignore'] });
} });
const oneShot = request => new Promise((resolve, reject) => {
  oneShotSpawns++;
  const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', helper], { timeout: 10000, maxBuffer: 96 * 1024 * 1024 }, (error, stdout) => {
    if (error) return reject(error);
    try {
      const result = JSON.parse(stdout);
      if (!result.ok) throw Object.assign(new Error(result.error), { clipboardCount: result.count, clipboardMutation: result.mutated });
      resolve(result);
    } catch (e) { reject(e); }
  });
  child.stdin.end(JSON.stringify(request));
});
let release, original, ownedCount, cancelled = false, reserved = false;
process.once('SIGINT', () => { cancelled = true; });
const checked = async (io, request) => {
  if (cancelled) throw new Error('Cancelled');
  await ensureFree();
  try {
    const result = await io(request);
    if (request.op === 'read' && result.count !== ownedCount) throw new Error('Clipboard ownership changed; leaving current contents');
    if (request.op === 'write') ownedCount = result.count;
    return result;
  } catch (error) {
    if (error.clipboardMutation && error.clipboardCount === ownedCount + 1) ownedCount = error.clipboardCount;
    throw error;
  }
};
try {
  await ensureFree(); release = await acquireLiveLock(); await ensureFree();
  try { await access(join(bank, 'original-helper.json')); throw new Error('Private recovery snapshot already exists; inspect the prior run before retrying'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await persistent({ op: 'acquire' }); reserved = true;
  const coldStart = performance.now(); original = await persistent({ op: 'read' });
  report.coldReadMs = performance.now() - coldStart; ownedCount = original.count;
  await writeFile(join(bank, 'original-helper.json'), JSON.stringify(original), { mode: 0o600, flag: 'wx' });
  for (const [mode, io] of [['one-shot', oneShot], ['persistent', persistent]]) {
    for (const kind of ['text', 'image', 'files', 'rich']) {
      await ensureFree();
      const before = await native('seed', kind, join(bank, 'one.txt'), join(bank, 'two.txt'), String(ownedCount));
      ownedCount = before.count;
      for (let repetition = 1; repetition <= 3; repetition++) {
        const entry = { mode, kind, repetition }; report.trials.push(entry);
        const start = performance.now();
        const snapshot = await checked(io, { op: 'read' });
        await checked(io, { op: 'write', expectedCount: ownedCount, items: [[{ type: 'public.utf8-plain-text', data: Buffer.from('SLEIGHT TEMPORARY COPY').toString('base64') }]] });
        await checked(io, { op: 'write', expectedCount: ownedCount, items: snapshot.items });
        entry.ioMs = performance.now() - start;
        const after = await native('inspect');
        entry.before = before; entry.after = after;
        entry.restoredBytes = after.count === ownedCount && equal(before.items, after.items);
        console.log(JSON.stringify({ mode, kind, repetition, ioMs: entry.ioMs, restoredBytes: entry.restoredBytes }));
        if (!entry.restoredBytes) throw new Error('Byte restoration or generation verification failed');
      }
    }
  }
  const beforeConflict = await native('inspect');
  try { await checked(persistent, { op: 'write', expectedCount: ownedCount - 1, items: [] }); }
  catch (error) { report.staleGenerationRefused = /ownership changed/.test(error.message); }
  const afterConflict = await native('inspect');
  report.conflictLeftBytesUntouched = beforeConflict.count === afterConflict.count && equal(beforeConflict.items, afterConflict.items);
  if (!report.staleGenerationRefused || !report.conflictLeftBytesUntouched) throw new Error('Stale-generation refusal failed');
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (original) {
    try {
      await ensureFree();
      await persistent({ op: 'write', expectedCount: ownedCount, items: original.items });
      const after = await persistent({ op: 'read' });
      report.originalRestored = equal(after.items, original.items);
      if (!report.originalRestored) throw new Error('Original clipboard verification failed');
      await rm(join(bank, 'original-helper.json'));
    } catch (error) { report.originalRestored = false; report.restoreError = error.message; report.privateRecovery = join(bank, 'original-helper.json'); process.exitCode = 1; }
  }
  try { await persistent.close(); report.helperCollected = true; report.reservationCollected = reserved; }
  catch (error) { report.helperCleanupError = error.message; process.exitCode = 1; }
  if (release && report.helperCollected) {
    try { await release(); report.lockReleased = true; }
    catch (error) { report.lockCleanupError = error.message; process.exitCode = 1; }
  } else if (release) report.lockRetained = 'Helper cleanup is unconfirmed';
  report.oneShotSpawns = oneShotSpawns; report.persistentSpawns = persistentSpawns;
  report.finished = new Date().toISOString();
  const published = JSON.stringify(report, null, 2).replaceAll(homedir(), '~').replaceAll(userInfo().username, '[owner]');
  const privateResult = join(bank, basename(resultPath));
  await writeFile(privateResult, published + '\n');
  console.log(`Private evidence: ${privateResult}`);
  await writeFile(resultPath, published + '\n');
  console.log(`Published ${resultPath.replaceAll(homedir(), '~')}`);
}
