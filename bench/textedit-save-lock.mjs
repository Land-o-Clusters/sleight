// Compare harmless PID-local events after AXValue edits, without using the engine.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLiveLock } from './live-lock.mjs';
import { cleanupFailedTextEditLaunch } from './textedit-save-lock-cleanup-run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bank = await mkdtemp('/private/tmp/sleight-save-lock-'), path = join(bank, 'trial.txt');
const report = { started: new Date().toISOString(), trials: [], opening: 'open -n -g (owned isolated instance)', engineUsed: false, pointerUsed: false };
const execute = promisify(execFile), repetitions = process.argv.includes('--quick') ? 1 : 3;
let release, opened = false, child, closed, input, request, currentTrial, launched = false, quit = false, cancelled = false, ended = false, channelUncertain = false;
process.once('SIGINT', () => { cancelled = true; });
const free = async () => {
  if (cancelled) throw new Error('Cancelled');
  try { await access('/tmp/sleight-hold'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  throw new Error('Live hold exists; no app action sent');
};
try {
  await free(); release = await acquireLiveLock(); await free();
  child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/textedit-save-lock.js'), path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0, stderr = ''; const pending = new Map();
  child.stderr.on('data', b => { stderr += b; });
  closed = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true; report.helperExit = { code, signal };
    for (const p of pending.values()) p.reject(new Error(stderr || 'Fixture helper closed')); pending.clear(); resolve();
  }));
  input = createInterface({ input: child.stdout });
  input.on('line', line => {
    let r; try { r = JSON.parse(line); } catch { return; }
    const p = pending.get(r.id); if (!p) return; pending.delete(r.id);
    if (r.ok) p.resolve(r);
    else { report.failedOperation = r; if (currentTrial) currentTrial.failedOperation = r; p.reject(new Error(r.error)); }
  });
  request = async payload => {
    if (channelUncertain) throw new Error('Fixture channel uncertain; no further app operation sent');
    await free();
    return new Promise((resolve, reject) => {
      const key = id++, timer = setTimeout(() => { channelUncertain = true; pending.delete(key); reject(new Error('Fixture operation timed out')); }, 6000);
      pending.set(key, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ id: key, ...payload }) + '\n');
    });
  };
  report.preflight = await request({ op: 'preflight' });
  // A separate process keeps any save-lock reproduction away from the owner's buffers.
  for (const method of ['key']) for (const variant of ['shift', 'none', 'flags-zero', 'shift-release', 'escape']) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const trial = { method, variant, repetition }; report.trials.push(trial);
    currentTrial = trial;
    if (report.trials.length > 1) trial.preflight = await request({ op: 'preflight' });
    await free(); await writeFile(path, 'seed\n');
    opened = true; launched = true; quit = false; trial.launchAttempted = true;
    await execute('/usr/bin/open', ['-n', '-g', '-b', 'com.apple.TextEdit', path]); trial.openLauncherExit = 0;
    trial.attachAttempts = [];
    const attachDeadline = performance.now() + 5000;
    for (;;) {
      try { await request({ op: 'attach' }); break; }
      catch (error) {
        trial.attachAttempts.push(error.message);
        if (channelUncertain || performance.now() > attachDeadline || !/AXWindows failed: -25204|Owned AX window unavailable|New TextEdit process not registered yet/.test(error.message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    const expected = `probe-${report.trials.length}\n`;
    trial.edit = await request({ op: 'edit', text: expected }); assert.equal(trial.edit.edited, true);
    trial.afterEdit = await request({ op: 'read' });
    trial.event = await request({ op: 'event', variant });
    // Match the historical delayed saves; ordinary idle time alone failed there.
    await new Promise(resolve => setTimeout(resolve, 10000));
    trial.beforeSaveDisk = await readFile(path, 'utf8'); trial.beforeSave = await request({ op: 'read' });
    trial.saveNeeded = trial.beforeSaveDisk !== expected && trial.beforeSave.edited !== false;
    const start = performance.now(); trial.save = await request({ op: 'save', method });
    const deadline = performance.now() + 5000;
    do {
      trial.onDisk = await readFile(path, 'utf8'); if (trial.onDisk === expected) break;
      await new Promise(resolve => setTimeout(resolve, 100)); await free();
    } while (performance.now() < deadline);
    trial.saveMs = performance.now() - start;
    trial.after = await request({ op: 'read' });
    trial.exact = trial.onDisk === expected && trial.after.text === expected;
    assert.ok(trial.exact, 'Saved bytes differ from the owned buffer');
    trial.cleanup = await request({ op: 'close' }); opened = false;
    trial.launchCleanup = await request({ op: 'quit-owned' }); quit = true; launched = false;
    console.log(JSON.stringify(trial));
  }
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (opened && currentTrial?.exact === true && request && !cancelled && !channelUncertain) {
    try { report.cleanup = await request({ op: 'close' }); opened = false; }
    catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  }
  if (launched && !opened && request && !cancelled && !channelUncertain) {
    try { report.ownedLaunchCleanup = await request({ op: 'quit-owned' }); quit = true; }
    catch (error) { report.launchCleanupError = error.message; process.exitCode = 1; }
  }
  if (child) {
    child.stdin.end();
    const timer = setTimeout(() => { if (!ended) child.kill('SIGTERM'); }, 3000);
    await closed; clearTimeout(timer); input.close();
  }
  // A failed attach can still leave our unedited launch behind. Collect the command helper first,
  // then use the recorded PID, launch time and seed checks; preserve any restored owner windows.
  if (release && launched && opened && !cancelled && !channelUncertain) {
    if (await cleanupFailedTextEditLaunch({ report, trial: currentTrial, bank })) {
      opened = false; launched = false; quit = true; release = undefined; report.lockReleased = true;
    }
  }
  if (release && !opened && (!launched || quit) && (!child || ended)) { await release(); report.lockReleased = true; }
  else if (release) report.lockRetained = 'Owned temporary document cleanup unconfirmed; operator inspection required';
  report.documentMayRemain = opened; report.bank = bank; report.finished = new Date().toISOString();
  report.completed = report.trials.filter(t => t.exact === true).length;
  report.saveTests = report.trials.filter(t => t.exact === true && t.saveNeeded).length;
  const published = JSON.stringify(report, null, 2).replaceAll(homedir(), '~').replaceAll(userInfo().username, '[owner]');
  const output = join(root, 'docs/benchmarks', `${report.started.slice(0, 10)}-save-lock-${Date.now()}.json`);
  await writeFile(join(bank, 'results.json'), published + '\n'); await writeFile(output, published + '\n');
  console.log(`Published ${output.replaceAll(homedir(), '~')}`);
}
