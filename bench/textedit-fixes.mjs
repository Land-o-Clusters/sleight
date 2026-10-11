// Focused background TextEdit investigation. Every attempt, including a lock refusal, is published.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { acquireLiveLock } from './live-lock.mjs';
import { createNativeClipboardIO } from '../plugins/sleight/lib/clipboard.mjs';
import { probeAppHealth } from '../plugins/sleight/lib/read-failure.mjs';
import { textEditFormatPreserved } from './textedit-fixes-check.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bank = trackTemp(await mkdtemp('/private/tmp/sleight-textedit-fixes-'));
const plain = process.argv.includes('--plain'), legacy = process.argv.includes('--legacy'), move = process.argv.includes('--move');
const orphan = process.argv.includes('--orphan');
const misspelled = process.argv.includes('--misspelled'), openBackground = process.argv.includes('--open-background');
const path = join(bank, plain ? 'fixture.txt' : 'fixture.rtf');
const word = misspelled ? 'zzzxq' : 'alpha';
const report = { started: new Date().toISOString(), bank, plain, legacy, move, orphan, misspelled, openBackground,
  load: loadavg(), trials: [] };
report.source = Object.fromEntries(await Promise.all(['bench/textedit-fixes.mjs', 'bench/textedit-fixes-fixture.js', 'bench/textedit-fixes-drag.js', 'bench/textedit-fixes-check.mjs', 'plugins/sleight/lib/drag.js', 'plugins/sleight/lib/clipboard.mjs', 'plugins/sleight/lib/clipboard.js', 'plugins/sleight/lib/app-health.js'].map(async name =>
  [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])));
let release, child, collected, helperStopped = false, helperCollected = false, preflight, opened = false, closed = false, cancelled = false;
process.once('SIGINT', () => { cancelled = true; });
const ensureFree = async () => {
  if (cancelled) throw new Error('Cancelled');
  try { await access('/tmp/sleight-hold'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Live hold exists; no app operation attempted');
};
try {
  await ensureFree(); release = await acquireLiveLock(); await ensureFree();
  await writeFile(path, plain ? `${word} beta gamma\n` : '{\\rtf1\\ansi{\\fonttbl{\\f0 Helvetica;}}{\\colortbl;\\red220\\green0\\blue0;}\\f0\\fs28\\b\\cf1 alpha\\b0\\cf0  beta gamma\\par}');
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
    if ((!preflight.running && !openBackground) || preflight.foregroundTextEdit) throw new Error('Requires background TextEdit');
    opened = true;
    if (openBackground) {
      await ensureFree();
      // Per-launch only (they apply when this starts TextEdit): no restored windows and no iCloud
      // autosave. A plain open restored an empty iCloud "Untitled 11" beside the fixture (2026-10-11).
      await promisify(execFile)('/usr/bin/open', ['-g', '-a', 'TextEdit', path, '--args', '-ApplePersistenceIgnoreState', 'YES', '-NSDocumentSaveNewDocumentsToCloud', 'NO'], { timeout: 10000 });
      report.backgroundOpen = true;
    }
    const initial = await request('open', { frontPid: preflight.frontPid, backgroundOpen: openBackground, initiallyEmpty: preflight.documents === 0 || !preflight.running });
    if (orphan) {
      if (preflight.running && preflight.documents !== 0) throw new Error('Orphan reproduction needs initially empty TextEdit');
      await request('save-as');
      report.beforeClose = await request('panel-state');
      closed = (await request('close')).closed;
      report.documentClosed = closed;
      report.afterClose = await request('panel-state');
      report.orphanHealth = await probeAppHealth('TextEdit');
      report.orphanReproduced = closed && report.afterClose.axWindows === 0 && report.afterClose.cgWindows.some(w => w.panel);
      if (report.afterClose.cgWindows.some(w => w.panel)) report.emptyAppRecovery = await request('quit-empty');
      if (!report.orphanReproduced) throw new Error('No orphan Save panel reproduced');
    } else if (move) {
      if (!plain && !legacy && preflight.running && preflight.documents !== 0) throw new Error('Rich-paste probe requires initially empty TextEdit for safe recovery');
      const args = await request('prepare');
      const source = legacy ? execFileSync('/usr/bin/git', ['show', '6e21846e65cd0ed02131d6d0dc849307e6a9c881:plugins/sleight/lib/drag.js'], { cwd: root, encoding: 'utf8' }) : await readFile(join(root, 'plugins/sleight/lib/drag.js'), 'utf8');
      const io = createNativeClipboardIO(join(root, 'plugins/sleight/lib/clipboard.js'));
      try {
        const before = await io({ op: 'read' });
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const run = async (_script, prepared) => {
          await ensureFree();
          const trial = { op: 'drag', load: loadavg() }; report.trials.push(trial);
          const script = join(root, 'bench/textedit-fixes-drag.js');
          const payload = { source, args: { ...prepared, deadline: Date.now() + 30000 }, frontPid: preflight.frontPid };
          try {
            const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify(payload)], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
            trial.result = JSON.parse(stdout); return trial.result;
          } catch (error) {
            trial.error = error.killed ? 'Drag child timed out and was collected' : error.message;
            return { ok: false, path: 'accessibility', error: trial.error };
          }
        };
        const result = await run('drag.js', args);
        report.moveResult = result;
        const after = await io({ op: 'read' });
        report.clipboardBytesPreserved = same(before.items, after.items);
        const final = await request('read'); report.exactText = final.text === `beta gamma ${word}\n`;
        const saved = await request('save');
        // Recorded, not required: drag's Accessibility move writes plain text (known problems).
        report.formatPreserved = plain || textEditFormatPreserved(initial, final, saved);
        if (!result.ok || !report.exactText || !report.clipboardBytesPreserved) throw new Error('Move, text or clipboard verification failed');
      } finally { await io.close(); }
    } else await request('rtf-read');
    }
  } finally {
    if (opened && !closed) { try { closed = (await request('close')).closed; report.documentClosed = closed; } catch (error) { report.documentCleanupError = error.message; } }
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
  if (release && (!opened || closed) && (!child || helperCollected)) { await release(); report.lockReleased = true; }
  else if (release) report.lockRetained = 'Fixture cleanup unconfirmed; operator inspection required';
  report.finished = new Date().toISOString();
  report.loadAfter = loadavg();
  const published = JSON.stringify(report, null, 2).replaceAll(homedir(), '~').replaceAll(userInfo().username, '[owner]');
  const output = join(root, 'docs/benchmarks', `${report.started.slice(0, 10)}-textedit-fixes-${Date.now()}.json`);
  await writeFile(join(bank, 'results.json'), published + '\n');
  await writeFile(output, published + '\n');
  console.log(`Published ${output.replaceAll(homedir(), '~')}`);
}
