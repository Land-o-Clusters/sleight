// Recover only a finished reliability run's retained lock and fresh Chess PID.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat, rmdir } from 'node:fs/promises';
import { reliabilityEvidence } from './reliability-evidence.mjs';
const path = process.argv[2];
if (!/^docs\/benchmarks\/2026-10-08-reliability-chess-after-\d+\.json$/.test(path)) throw new Error('Expected one repository reliability receipt');
const receipt = JSON.parse(await readFile(path, 'utf8'));
if (!receipt.finished || !receipt.trace.some(x => x.engineCollected && x.exit.code === 0)) throw new Error('Owned engine collection is unconfirmed');
const lock = await stat('/tmp/sleight-live.lock');
if (Math.abs(lock.birthtimeMs - Date.parse(receipt.lockAcquired)) > 2000) throw new Error('Retained lock identity changed');
const pid = receipt.attempts.at(-1).initialAX.pid;
const run = promisify(execFile), titles = new Set();
const command = async (cmd, args) => (await run(cmd, args, { timeout: 10000 })).stdout;
const chess = async request => {
  const value = JSON.parse(await command('/usr/bin/osascript', ['-l', 'JavaScript', 'bench/reliability-chess.js', JSON.stringify({ ...request, expectedPid: pid })]));
  for (const win of value.windows ?? []) if (win.title) titles.add(win.title);
  return value;
};
const recovery = receipt.cleanupRecovery = { started: new Date().toISOString(), pid, lockInode: lock.ino, steps: [] };
try {
  const before = await chess({ op: 'snapshot' }); recovery.before = before;
  if (before.running && before.pid !== pid) throw new Error('Chess process replaced');
  const games = before.windows.filter(w => w.title && w.bounds.Width > 400);
  if (games.length > 2 || games.some(w => !/^Game [12] \|/.test(w.title))) throw new Error('Unexpected Chess game; cleanup stopped');
  for (const game of games) {
    const result = await chess({ op: 'close', title: game.title, allowTurnChange: true });
    recovery.steps.push(result);
    if (!result.closed) throw new Error('Owned game closure unconfirmed');
  }
  const after = await chess({ op: 'snapshot' }); recovery.after = after;
  if (after.windows.some(w => w.title && w.bounds.Width > 400)) throw new Error('Game remains');
  if (after.running) await chess({ op: 'quit' });
  for (let n = 0; n < 40; n++) {
    recovery.process = await chess({ op: 'process' });
    if (!recovery.process.running) break;
    if (recovery.process.pid !== pid) throw new Error('Chess process replaced');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (recovery.process.running) throw new Error('Chess exit unconfirmed');
  const current = await stat('/tmp/sleight-live.lock');
  if (current.dev !== lock.dev || current.ino !== lock.ino) throw new Error('Lock ownership changed');
  await rmdir('/tmp/sleight-live.lock'); recovery.lockReleased = true;
} catch (error) { recovery.error = error.message; process.exitCode = 1; }
finally {
  recovery.finished = new Date().toISOString();
  await writeFile(path, reliabilityEvidence(receipt, titles) + '\n');
  console.log(reliabilityEvidence(recovery, titles));
}
