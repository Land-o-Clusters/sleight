// Focused background TextEdit investigation. Every attempt, including a lock refusal, is published.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { acquireLiveLock } from './live-lock.mjs';
import { runRichTextMove, recoverPendingRichTextMove } from '../plugins/sleight/lib/rich-text-drag.mjs';
import { createNativeClipboardIO } from '../plugins/sleight/lib/clipboard.mjs';
import { probeAppHealth } from '../plugins/sleight/lib/read-failure.mjs';
import { textEditFormatPreserved } from './textedit-fixes-check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bank = await mkdtemp('/private/tmp/sleight-textedit-fixes-');
const plain = process.argv.includes('--plain'), legacy = process.argv.includes('--legacy'), move = process.argv.includes('--move');
const orphan = process.argv.includes('--orphan');
const path = join(bank, plain ? 'fixture.txt' : 'fixture.rtf');
const report = { started: new Date().toISOString(), bank, plain, legacy, move, orphan, trials: [] };
report.source = Object.fromEntries(await Promise.all(['bench/textedit-fixes.mjs', 'bench/textedit-fixes-fixture.js', 'bench/textedit-fixes-drag.js', 'bench/textedit-fixes-check.mjs', 'plugins/sleight/lib/drag.js', 'plugins/sleight/lib/rich-text-drag.mjs', 'plugins/sleight/lib/clipboard.mjs', 'plugins/sleight/lib/clipboard.js', 'plugins/sleight/lib/app-health.js'].map(async name =>
  [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])));
let release, child, collected, helperStopped = false, helperCollected = false, clipboardPending = false, preflight, opened = false, closed = false, cancelled = false;
process.once('SIGINT', () => { cancelled = true; });
const ensureFree = async () => {
  if (cancelled) throw new Error('Cancelled');
  try { await access('/tmp/sleight-hold'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Live hold exists; no app operation attempted');
};
try {
  await ensureFree(); release = await acquireLiveLock(); await ensureFree();
  await writeFile(path, plain ? 'alpha beta gamma\n' : '{\\rtf1\\ansi{\\fonttbl{\\f0 Helvetica;}}{\\colortbl;\\red220\\green0\\blue0;}\\f0\\fs28\\b\\cf1 alpha\\b0\\cf0  beta gamma\\par}');
  child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/textedit-fixes-fixture.js'), path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0, pending, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  collected = new Promise(resolve => child.once('close', (code, signal) => { helperCollected = true; report.fixtureExit = { code, signal }; pending?.reject(new Error(stderr || 'Fixture helper closed')); resolve(); }));
  child.once('error', error => pending?.reject(error));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let result; try { result = JSON.parse(line); } catch { return; }
    if (result.id !== pending?.id) return;
    const item = pending; pending = undefined;
    result.ok ? item.resolve(result) : item.reject(Object.assign(new Error(result.error), { result }));
  });
  const request = async (op, args = {}) => {
    await ensureFree();
    if (helperStopped || helperCollected) throw new Error('Fixture helper stopped; cleanup is unconfirmed');
    const trial = { op }; report.trials.push(trial);
    try {
      trial.result = await new Promise((resolve, reject) => {
        const timer = setTimeout(async () => {
          pending = undefined; helperStopped = true;
          child.stdin.end(); child.kill();
          const force = setTimeout(() => { if (!helperCollected) child.kill('SIGKILL'); }, 2000);
          const bound = setTimeout(() => reject(new Error('Fixture request timeout; helper collection unconfirmed')), 5000);
          await collected; clearTimeout(force); clearTimeout(bound);
          reject(new Error('Fixture request timeout; helper collected, document cleanup unconfirmed'));
        }, 30000);
        pending = { id: id++, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        child.stdin.write(JSON.stringify({ id: pending.id, op, ...args }) + '\n');
      });
      return trial.result;
    } catch (error) { trial.error = error.message; if (error.result) trial.result = error.result; throw error; }
  };
  try {
    preflight = await request('preflight');
    report.health = await probeAppHealth('TextEdit');
    if (process.argv.includes('--inspect')) {
      report.inspected = true;
    } else {
    if (!preflight.running || preflight.foregroundTextEdit) throw new Error('Requires already-running background TextEdit');
    opened = true;
    const initial = await request('open');
    if (orphan) {
      if (preflight.documents !== 0) throw new Error('Orphan reproduction needs initially empty TextEdit');
      await request('save-as');
      report.beforeClose = await request('panel-state');
      closed = (await request('close')).closed;
      report.documentClosed = closed;
      report.afterClose = await request('panel-state');
      report.orphanReproduced = closed && report.afterClose.axWindows === 0 && report.afterClose.cgWindows.some(w => w.panel);
      if (report.afterClose.cgWindows.some(w => w.panel)) report.emptyAppRecovery = await request('quit-empty');
      if (!report.orphanReproduced) throw new Error('No orphan Save panel reproduced');
    } else if (move) {
      if (!plain && !legacy && preflight.documents !== 0) throw new Error('Rich-paste probe requires initially empty TextEdit for safe recovery');
      const args = await request('prepare');
      const source = legacy ? execFileSync('/usr/bin/git', ['show', '6e21846e65cd0ed02131d6d0dc849307e6a9c881:plugins/sleight/lib/drag.js'], { cwd: root, encoding: 'utf8' }) : await readFile(join(root, 'plugins/sleight/lib/drag.js'), 'utf8');
      const io = createNativeClipboardIO(join(root, 'plugins/sleight/lib/clipboard.js'));
      try {
        const before = await io({ op: 'read' });
        const digest = items => createHash('sha256').update(JSON.stringify(items)).digest('hex');
        report.clipboardBefore = { count: before.count, digest: digest(before.items) };
        const run = async (_script, prepared) => {
          if (prepared.op !== 'rich-paste-status') await ensureFree(); // read-only recovery remains possible after cancellation
          const trial = { op: prepared.op ?? 'drag' }; report.trials.push(trial);
          const script = prepared.op === 'rich-paste-status' ? join(root, 'plugins/sleight/lib/drag.js') : join(root, 'bench/textedit-fixes-drag.js');
          const payload = prepared.op === 'rich-paste-status' ? prepared : { source, args: prepared, frontPid: preflight.frontPid };
          try {
            const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify(payload)], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
            trial.result = JSON.parse(stdout); return trial.result;
          } catch (error) { trial.error = error.killed ? 'Drag child timed out and was collected' : error.message; throw new Error(trial.error); }
        };
        let result = await run('drag.js', args);
        if (result.richTextMove) result = await runRichTextMove(args, result.richTextMove, run);
        report.moveResult = result;
        clipboardPending = result.clipboardRecoveryRequired === true;
        if (clipboardPending) throw new Error('Rich paste unconfirmed; fixture cleanup and empty-app recovery required before clipboard restoration');
        const after = await io({ op: 'read' });
        report.clipboardAfter = { count: after.count, digest: digest(after.items) };
        report.clipboardBytesPreserved = digest(before.items) === digest(after.items);
        const final = await request('read'); report.exactText = final.text === 'beta gamma alpha\n';
        const saved = await request('save');
        report.formatPreserved = plain || textEditFormatPreserved(initial, final, saved);
        if (!result.ok || !report.exactText || !report.clipboardBytesPreserved || !report.formatPreserved) throw new Error('Move, formatting or clipboard verification failed');
      } finally { await io.close(); }
    } else await request('rtf-read');
    }
  } finally {
    if (opened && !closed) { try { closed = (await request('close')).closed; report.documentClosed = closed; } catch (error) { report.documentCleanupError = error.message; } }
    if (clipboardPending && closed && preflight.documents === 0) {
      try { report.emptyAppRecovery = await request('quit-empty'); report.clipboardRecovered = await recoverPendingRichTextMove(); clipboardPending = !report.clipboardRecovered; }
      catch (error) { report.clipboardRecoveryError = error.message; }
    }
    lines.close();
  }
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (child) {
    child.stdin.end();
    const stop = setTimeout(() => { if (!helperCollected) { helperStopped = true; child.kill(); } }, 2000);
    const force = setTimeout(() => { if (!helperCollected) child.kill('SIGKILL'); }, 4000);
    let bound;
    await Promise.race([collected, new Promise(resolve => { bound = setTimeout(resolve, 6000); })]);
    clearTimeout(stop); clearTimeout(force); clearTimeout(bound);
    report.fixtureCollected = helperCollected;
    if (!helperCollected) { child.unref(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
  }
  if (release && (!opened || closed) && !clipboardPending && (!child || helperCollected)) { await release(); report.lockReleased = true; }
  else if (release) report.lockRetained = 'Fixture cleanup unconfirmed; operator inspection required';
  report.finished = new Date().toISOString();
  const published = JSON.stringify(report, null, 2).replaceAll(homedir(), '~').replaceAll(userInfo().username, '[owner]');
  const output = join(root, 'docs/benchmarks', `${report.started.slice(0, 10)}-textedit-fixes-${Date.now()}.json`);
  await writeFile(join(bank, 'results.json'), published + '\n');
  await writeFile(output, published + '\n');
  console.log(`Published ${output.replaceAll(homedir(), '~')}`);
  if (clipboardPending) {
    console.error('Clipboard recovery is pending. Save other work and quit TextEdit before ending this probe. The original bytes remain in this process only.');
    while (!(await recoverPendingRichTextMove())) await new Promise(resolve => setTimeout(resolve, 5000));
    report.clipboardRecovered = true;
    if (release && closed && helperCollected) { await release(); report.lockReleased = true; delete report.lockRetained; }
    const recovered = JSON.stringify(report, null, 2).replaceAll(homedir(), '~').replaceAll(userInfo().username, '[owner]');
    await writeFile(join(bank, 'results.json'), recovered + '\n');
    await writeFile(output, recovered + '\n');
  }
}
