// Affected tasks only. No generated load. Every attempt, including refusals, is published.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { loadavg, userInfo, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { createAppHealthHelper } from '../plugins/sleight/lib/read-failure.mjs';
import { reliabilityEvidence } from './reliability-evidence.mjs';
import { startFootprint } from './footprint.mjs';
import { chessMovePoints } from './chess-move-points.mjs';

const execute = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2], titles = new Set();
const report = { started: new Date().toISOString(), mode, ownerAway: process.argv.includes('--owner-away'), load: loadavg(), attempts: [] };
const loadClass = process.argv.includes('--idle') ? 'idle' : process.argv.includes('--loaded') ? 'loaded' : undefined;
if (loadClass) report.loadClass = loadClass;
const output = mode === 'worker' ? process.argv[4] : join(root, `docs/benchmarks/2026-10-10-waits-targeting-${mode}-${Date.now()}.json`);
const bank = mkdtempSync('/private/tmp/sleight-waits-targeting-');
let unlock, client, helper, warmFootprint, cancelled = false, cleanup = true;
const cancel = () => { cancelled = true; void client?.close(); void helper?.close(); };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
function ready() {
  if (existsSync('/tmp/sleight-hold')) throw new Error('sleight-hold exists; live work stopped');
  if (cancelled) throw new Error('Interrupted');
}
function qualifiedLoad(load) { return loadClass === 'idle' ? load[0] < 3 : loadClass === 'loaded' ? load[0] >= 10 : true; }
function redactPanels(value) {
  if (typeof value === 'string' && /ID: (?:save|open)-panel/.test(value)) return value.split('\n')
    .filter(line => /^Window: |^0 (?:sheet|standard window)|ID: (?:saveAsNameTextField|OKButton|CancelButton|NSNavNewDocButton)/.test(line))
    .join('\n') + '\n[unrelated folder listing omitted]';
  if (Array.isArray(value)) return value.map(redactPanels);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactPanels(child)]));
  return value;
}
const publish = () => {
  const text = reliabilityEvidence(redactPanels(report), titles).replaceAll(userInfo().username, '[user]');
  writeFileSync(output, text + '\n');
};
const text = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const command = async (cmd, args) => (await execute(cmd, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const fixture = async args => JSON.parse(await command('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/waits-targeting-fixture.js'), JSON.stringify(args)]));
async function connect(arm = 'native') {
  ready(); let identities = 0;
  helper = createAppHealthHelper();
  const server = resolveServer({ ...process.env, SLEIGHT_SURFACES: 'computer' });
  assert.ok(!server.error, server.error); report.engineVersion = server.version;
  client = await probeClient(server, { relay: arm !== 'direct', timeoutMs: 60000,
    relayOptions: { changeReview: false, spaceProbe: helper.probe, ...(arm === 'native' ? { windowIdentity: window => { identities++; return helper.windowIdentity(window); } } : {}) },
    record: event => {
      if (event.event === 'engine-close') report.engineExit = { code: event.code, signal: event.signal };
      else if (event.direction && event.msg?.params?.name !== 'js') (report.protocol ??= []).push({ direction: event.direction,
        id: event.msg?.id, method: event.msg?.method, tool: event.msg?.params?.name });
    } });
  return () => identities;
}
async function js(code, label, strict = true) {
  ready(); const start = performance.now(), cpu = process.cpuUsage();
  const result = await client.call('js', { code, timeout_ms: 60000 });
  const used = process.cpuUsage(cpu);
  // Save panels list unrelated folders. Retain the actual sheet header and controls used here.
  const evidence = structuredClone(result);
  for (const block of evidence.content ?? []) {
    if (block.type === 'text') {
      for (const match of block.text.matchAll(/^Window: "([^"]*)", App: Chess\.?$/gm)) titles.add(match[1]);
    }
    if (block.type === 'text' && /0 sheet.*ID: save-panel/.test(block.text)) block.text = block.text.split('\n')
      .filter(line => /^Window: |^0 sheet|ID: (?:saveAsNameTextField|OKButton|CancelButton)/.test(line)).join('\n') + '\n[unrelated folder listing omitted]';
  }
  report.attempts.push({ label, code, ms: performance.now() - start, nodeCpuMs: (used.user + used.system) / 1000, load: loadavg(), result: evidence });
  publish(); if (strict) assert.ok(!result.isError, text(result)); return result;
}
async function closeClient() {
  await client?.close(); client = undefined; await helper?.close(); helper = undefined;
}
async function quitOwned(appId) {
  await fixture({ op: 'quit', appId });
  for (let i = 0; i < 30; i++) {
    if (!(await fixture({ op: 'running', appId })).running) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Owned app quit unconfirmed: ' + appId);
}
try {
  ready();
  if (mode !== 'worker') unlock = await acquireLiveLock();
  ready();
  if (mode === 'measure') {
    assert.ok(qualifiedLoad(report.load), `Natural load does not qualify for ${loadClass}: ${report.load[0]}`);
    // /usr/bin/time collects CPU of each owned worker and its engine/helper descendants.
    // Startup is included in this total; the warm phase is also sampled separately below.
    const wasRunning = (await fixture({ op: 'running', appId: 'com.apple.calculator' })).running;
    try {
      await command('/usr/bin/open', ['-g', '-a', 'Calculator']);
      const calculator = await fixture({ op: 'running', appId: 'com.apple.calculator' });
      assert.equal(calculator.pids.length, 1, 'Measurement requires one Calculator process');
      report.calculatorWindows = JSON.parse(await command(join(homedir(), '.codex/bin/codex-macos-inspect'),
        ['windows-for-pid', String(calculator.pids[0]), '--scope', 'all']))
        .filter(window => window.layer === 0 && window.alpha > 0 && window.bounds.width >= 100 && window.bounds.height >= 100);
      assert.equal(report.calculatorWindows.length, 1, 'Measurement requires exactly one Calculator window across Spaces');
      for (let repetition = 0; repetition < 2; repetition++) {
        for (const arm of loadClass ? (repetition ? ['native', 'off'] : ['off', 'native']) : (repetition ? ['native', 'off', 'direct'] : ['direct', 'off', 'native'])) {
          ready(); const target = join(bank, `${arm}-${repetition}.json`), cancelFile = join(bank, 'cancel');
          const child = spawn('/usr/bin/time', ['-p', process.execPath, fileURLToPath(import.meta.url), 'worker', arm, target, cancelFile, ...(loadClass ? ['--' + loadClass] : [])],
            { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = ''; child.stderr.on('data', data => { stderr += data; });
          const timer = setInterval(() => { if (cancelled || existsSync('/tmp/sleight-hold')) writeFileSync(cancelFile, 'cancel'); }, 100);
          let exit;
          try { exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
          catch (error) { cleanup = false; throw error; }
          finally { clearInterval(timer); }
          const cpu = /user\s+([\d.]+)\s+sys\s+([\d.]+)/.exec(stderr);
          let childReport;
          try { childReport = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : { error: 'No worker report' }; }
          catch (error) { cleanup = false; throw error; }
          report.attempts.push({ arm, repetition, exit, totalCpuMs: cpu ? (Number(cpu[1]) + Number(cpu[2])) * 1000 : null, stderr, ...childReport });
          if (childReport.childrenCollected !== true) {
            cleanup = false; throw new Error('Worker engine collection unconfirmed');
          }
          publish(); assert.equal(exit.code, 0, childReport.error); assert.ok(!exit.signal);
          if (loadClass) assert.ok(childReport.attempts.filter(a => a.label === 'action').every(a => qualifiedLoad(a.load)), 'Natural load left the requested class; retain this attempt without qualification');
        }
      }
    } finally {
      if (!wasRunning) try { await quitOwned('com.apple.calculator'); }
      catch (error) { cleanup = false; report.cleanupError = error.message; throw error; }
    }
  } else if (mode === 'worker') {
    const poll = setInterval(() => { if (existsSync(process.argv[5])) cancel(); }, 100); poll.unref();
    const identities = await connect(process.argv[3]);
    await js('var app = await cua.getApp("com.apple.calculator")', 'acquisition');
    await js('await app.pressKey("Escape")', 'warmup');
    // The worker's parent is time, the leader of this owned process group.
    warmFootprint = startFootprint({ pgid: process.ppid, apps: ['Calculator'], baselineGroup: true });
    await warmFootprint.ready;
    for (let i = 0; i < 8; i++) await js('await app.pressKey("1")', 'action');
    report.warmFootprint = await warmFootprint(); warmFootprint = undefined;
    assert.ok(Object.hasOwn(report.warmFootprint.group, 'node'), 'Warm CPU sampler did not observe the worker');
    assert.ok(Object.hasOwn(report.warmFootprint.outside, 'Calculator'), 'Warm CPU sampler did not observe Calculator');
    report.warmCpuMsPerAction = report.warmFootprint.cpuSeconds * 1000 / 8;
    report.nativeIdentityCalls = identities(); clearInterval(poll);
    report.loadQualified = report.attempts.filter(a => a.label === 'action').every(a => qualifiedLoad(a.load));
  } else if (mode === 'live') {
    assert.ok(report.ownerAway, 'Chess requires --owner-away confirmation');
    const only = process.argv.includes('--chess-only') ? 'com.apple.Chess' : process.argv.includes('--textedit-only') ? 'com.apple.TextEdit' : undefined;
    for (const appId of ['com.apple.calculator', 'com.apple.Chess', 'com.apple.TextEdit'].filter(id => !only || id === only)) {
      const trial = { appId, attemptsStart: report.attempts.length }; (report.trials ??= []).push(trial);
      let wasRunning = true, docId;
      try {
        ready(); wasRunning = (await fixture({ op: 'running', appId })).running;
        // For this launch only: no restored windows, and TextEdit opens an untitled document instead of
        // its iCloud Open panel, which neither Escape nor Cancel closed in the background (2026-10-10).
        await command('/usr/bin/open', ['-g', '-b', appId, ...(['com.apple.Chess', 'com.apple.TextEdit'].includes(appId) && !wasRunning
          ? ['--args', '-ApplePersistenceIgnoreState', 'YES', ...(appId === 'com.apple.TextEdit' ? ['-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO'] : [])] : [])]);
        const identities = await connect();
        if (appId === 'com.apple.calculator') {
          await js('var app = await cua.getApp("com.apple.calculator")', 'Calculator acquisition');
          const r = await js('await app.pressKey("Escape"); await app.pressKey("7"); await app.click({ id: "Multiply" }); await app.pressKey("8"); await app.pressKey("Return")', 'Calculator 7*8');
          assert.match(text(r), /56/);
        } else if (appId === 'com.apple.TextEdit') {
          const initial = await js('var app = await cua.getApp("com.apple.TextEdit")', 'TextEdit acquisition');
          if (/ID: open-panel/.test(text(initial))) {
            assert.ok(!wasRunning, 'Existing TextEdit Open panel left alone');
            // Escape sent to TextEdit in the background left its launch Open panel up, and Cmd+N then made
            // no document (2026-10-10, 2 runs). Its Cancel button closes it.
            const dismissed = await js('await app.click({ label: "Cancel" }); await app.getAXState()', 'Dismiss owned launch Open panel');
            assert.doesNotMatch(text(dismissed), /ID: open-panel/, 'Launch Open panel still open after Cancel');
          }
          const before = await fixture({ op: 'documents' });
          await js('await app.pressKey("super+n")', 'TextEdit new document');
          const created = (await fixture({ op: 'documents' })).filter(id => !before.includes(id));
          assert.equal(created.length, 1); docId = created[0]; trial.documentId = docId;
          await js('await app.pressKey("super+shift+t"); await app.typeText("Sleight wait save proof."); await app.pressKey("super+s"); nodeRepl.write(await app.waitFor({ id: "save-panel" }))', 'TextEdit late Save sheet');
          const destination = join(bank, 'wait-save.txt');
          const saved = await js(`await app.pressKey("super+shift+g"); await app.typeText(${JSON.stringify(bank)}); await app.pressKey("Return"); await app.waitFor({ id: "saveAsNameTextField" }); await app.setValue({ id: "saveAsNameTextField" }, "wait-save.txt"); await app.pressKey("Return")`, 'TextEdit save');
          assert.match(text(saved), /wait-save\.txt/); trial.savedBytes = readFileSync(destination, 'utf8');
          assert.match(trial.savedBytes, /Sleight wait save proof\./);
          docId = 'wait-save.txt'; // The fixture finds documents by name, and the save renamed it.
        } else {
          // Existing games are left alone. A launched Chess starts with its own new game.
          if (wasRunning) throw new Error('Chess already running; no existing game modified');
          const board = await js('var app = await cua.getApp("com.apple.Chess")', 'Chess acquisition');
          assert.match(text(board), /white pawn, e2/); assert.doesNotMatch(text(board), /white pawn, e4/);
          for (const m of text(board).matchAll(/^Window: "([^"]*)", App: Chess\.?$/gm)) titles.add(m[1]);
          const recorded = JSON.parse(readFileSync(join(root, 'bench/reliability-chess-points.json'), 'utf8'));
          const snapshot = JSON.parse(await command('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/reliability-chess.js'), JSON.stringify({ op: 'snapshot' })]));
          const games = snapshot.windows.filter(w => w.bounds.Width > 400);
          games.forEach(w => titles.add(w.title)); assert.equal(games.length, 1);
          const windows = JSON.parse(await command('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/drag-chess-fixture.js'), JSON.stringify({ op: 'windows' })]));
          assert.equal(windows.length, 1);
          const geometry = JSON.parse(await command('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/drag-chess-fixture.js'), JSON.stringify({ op: 'geometry', windowId: windows[0].id })]));
          const points = chessMovePoints({ bounds: games[0].bounds, squares: geometry.squares, recorded });
          trial.movePoints = points;
          const moved = await js(`await app.drag(${JSON.stringify(points.from)}, ${JSON.stringify(points.to)}); await app.getAXState({disableDiffing:true})`, 'Chess one e2-e4 move');
          assert.match(text(moved), /white pawn, e4/); assert.doesNotMatch(text(moved), /white pawn, e2/);
        }
        trial.nativeIdentityCalls = identities(); trial.passed = true;
      } catch (error) { trial.error = error.message; }
      finally {
        try { await closeClient(); if (docId) await fixture({ op: 'close', id: docId }); if (!wasRunning) await quitOwned(appId); trial.cleanup = true; }
        catch (error) { cleanup = false; trial.cleanupError = error.message; }
        publish();
      }
      if (!cleanup) break;
    }
    assert.ok(report.trials.every(t => t.passed), 'Some affected tasks failed; see trials');
  } else throw new Error('Expected measure, worker or live');
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (warmFootprint) {
    try { report.partialWarmFootprint = await warmFootprint(); }
    catch (error) { report.cpuError = error.message; }
    warmFootprint = undefined;
  }
  try { await closeClient(); report.childrenCollected = cleanup; }
  catch (error) { cleanup = false; report.childrenCollected = false; report.cleanupError = error.message; }
  if (unlock && cleanup) { await unlock(); report.lockReleased = true; }
  else if (unlock) report.lockRetained = true;
  report.finished = new Date().toISOString(); publish();
  if (cleanup) rmSync(bank, { recursive: true, force: true });
  if (mode !== 'worker') console.log(JSON.stringify({ output: output.replaceAll(homedir(), '~'), error: report.error, load: report.load, trials: report.trials?.map(t => ({ appId: t.appId, passed: t.passed, error: t.error, cleanup: t.cleanup })) }));
}
