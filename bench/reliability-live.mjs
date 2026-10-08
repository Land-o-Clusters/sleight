import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rmdir, writeFile, readFile, mkdtemp, unlink, access } from 'node:fs/promises';
import { reliabilityEvidence } from './reliability-evidence.mjs';
import { reliabilityClient } from './reliability-client.mjs';
import { callLocalTool } from '../plugins/sleight/lib/launch.mjs';
import { diagnoseReadFailure } from '../plugins/sleight/lib/read-failure.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { restartChess } from './chess-launch.mjs';
import { cleanupChessTrial } from './reliability-cleanup.mjs';

const execute = promisify(execFile);
const inspector = join(homedir(), '.codex/bin/codex-macos-inspect');
let cancelled = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cancelled = true; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const receipt = { started: new Date().toISOString(), mode: process.argv[2], attempts: [] };
const titles = new Set();
const publish = value => reliabilityEvidence(value, titles);
const runId = receipt.started.replace(/[^0-9]/g, '');
const save = () => writeFile(`docs/benchmarks/2026-10-08-reliability-${process.argv[2]}-${runId}.json`, publish(receipt) + '\n');
const text = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const command = async (cmd, args) => (await execute(cmd, args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const chess = async request => {
  const result = JSON.parse(await command('/usr/bin/osascript', ['-l', 'JavaScript', 'bench/reliability-chess.js', JSON.stringify(request)]));
  for (const win of result.windows ?? []) if (win.title) titles.add(win.title);
  if (result.title) titles.add(result.title);
  return result;
};
let client, fixtureChild, fixtureClosed, control;
const until = async fn => {
  const deadline = Date.now() + 10000;
  while (!await fn()) { if (cancelled || Date.now() > deadline) throw new Error('Fixture state deadline'); await wait(100); }
};
const exists = async path => { try { await access(path); return true; } catch { return false; } };
let held = false, cleanupUnconfirmed = false;
try {
  receipt.lockRequested = new Date().toISOString();
  let nextLockNotice = 0;
  while (!held && !cancelled) {
    try { await mkdir('/tmp/sleight-live.lock'); held = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= nextLockNotice) {
        console.log('Waiting for /tmp/sleight-live.lock; no app input posted.');
        nextLockNotice = Date.now() + 30000;
      }
      await wait(1000);
    }
  }
  if (cancelled) throw new Error('Interrupted before live work');
  receipt.lockAcquired = new Date().toISOString();
  console.log('Acquired /tmp/sleight-live.lock for ' + receipt.mode);
  if (process.argv[2] === 'ax') {
    await command('/usr/bin/open', ['-g', '-a', 'Calculator']);
    receipt.attempts.push(await execute('/usr/bin/osascript', ['-l', 'JavaScript', 'bench/reliability-ax.js', 'com.apple.calculator'], { timeout: 3000 }));
  } else if (process.argv[2] === 'chess-observe') {
    const snapshot = await chess({ op: 'snapshot' }); receipt.existing = snapshot;
    const games = snapshot.windows.filter(w => w.title && w.bounds.Width > 400);
    if (!snapshot.running || games.length !== 1) throw new Error('Observation needs one existing Chess game');
    receipt.cg = JSON.parse(await command(inspector, ['windows-for-pid', String(snapshot.pid), '--scope', 'all']));
    const b = games[0].bounds;
    const match = receipt.cg.filter(w => w.layer === 0 && Math.abs(w.bounds.x - b.X) < 1 && Math.abs(w.bounds.y - b.Y) < 1 && Math.abs(w.bounds.width - b.Width) < 1 && Math.abs(w.bounds.height - b.Height) < 1);
    if (match.length !== 1) throw new Error('CG/AX observation mapping not unique');
    receipt.geometry = await chess({ op: 'geometry', title: games[0].title });
    receipt.bank = await mkdtemp('/private/tmp/sleight-reliability-observe-');
    receipt.image = join(receipt.bank, 'board.png');
    await command('/usr/sbin/screencapture', ['-x', '-l', String(match[0].windowNumber), receipt.image]);
  } else if (/^chess-(?:before|after|inspect|recovery)$/.test(process.argv[2])) {
    let existing = await chess({ op: 'snapshot' }); receipt.existing = existing;
    if (existing.windows.some(w => w.title && w.bounds.Width > 400) && !process.argv.includes('--close-existing')) {
      throw new Error('Chess has an existing game; closing it requires explicit operator approval');
    }
    if (existing.running) {
      receipt.initialCleanup = [];
      const owned = op => chess({ ...op, expectedPid: existing.pid });
      try {
        await cleanupChessTrial({ pid: existing.pid, titles: existing.windows.filter(w => w.title && w.bounds.Width > 400).map(w => w.title), initialTitles: [], journal: receipt.initialCleanup,
          cancelDialog: () => owned({ op: 'cancel-new-game' }), close: title => owned({ op: 'close', title, allowTurnChange: true }), snapshot: () => owned({ op: 'snapshot' }),
          quit: () => owned({ op: 'quit' }), process: () => owned({ op: 'process' }), wait });
      } catch (error) { cleanupUnconfirmed = true; throw error; }
    }
    const bank = await mkdtemp('/private/tmp/sleight-reliability-'); receipt.bank = bank;
    receipt.trace = [];
    const newClient = () => reliabilityClient(value => {
      // Screenshots stay in the private bank; receipts retain tool text and metadata.
      const copy = JSON.parse(JSON.stringify(value, (key, item) => item?.type === 'image' ? { type: 'image', omitted: true } : item));
      receipt.trace.push(copy);
    }, { changeReview: true, localTools: { tools: [{ name: 'drag' }], call: callLocalTool } });
    const recovery = process.argv[2] === 'chess-recovery';
    const count = process.argv[2].endsWith('inspect') || recovery ? 1 : 20;
    for (let n = 0; n < count && !cancelled; n++) {
      const trial = { n: n + 1, path: recovery || n % 2 ? 'local' : 'engine' }; receipt.attempts.push(trial);
      let title;
      try {
        client = await newClient(); receipt.engine = client.version;
        await client.js('await cua.rewriteDocumentation()');
        // Immediate launch deliberately reproduces the benchmark's quit/open sequence.
        trial.launchStarted = new Date().toISOString();
        if (process.argv[2] === 'chess-after' || recovery) restartChess({ quit: () => {}, run: (cmd, args, options) => {
          const attempt = { cmd, args }; (trial.launchChecks ??= []).push(attempt);
          try { const result = execFileSync(cmd, args, options); attempt.status = 0; return result; }
          catch (error) { attempt.status = error.status; attempt.error = String(error.stderr ?? error.message); throw error; }
        } });
        else trial.launch = await command('/usr/bin/open', ['-g', '-a', 'Chess', '--args', '-ApplePersistenceIgnoreState', 'YES']);
        trial.launchFinished = new Date().toISOString();
        await wait(3000);
        if (cancelled) throw new Error('Interrupted during launch; no game setup posted');
        const before = await chess({ op: 'snapshot' }); trial.initialAX = before;
        trial.initialCG = JSON.parse(await command(inspector, ['windows-for-pid', String(before.pid), '--scope', 'all']));
        const acquired = await client.js('var chess = await cua.getApp("com.apple.Chess")');
        trial.acquired = acquired;
        if (acquired.isError) throw new Error(text(acquired));
        if (cancelled) throw new Error('Interrupted before new game shortcut');
        trial.newGameShortcut = await client.js('await chess.pressKey("super+n")');
        await wait(300);
        if (cancelled) throw new Error('Interrupted before new game dialog read');
        const dialog = await client.js('await chess.getAXState({disableDiffing:true})');
        trial.dialog = dialog;
        const dialogText = text(dialog).includes('sleight: no change') ? text(trial.newGameShortcut) : text(dialog);
        const start = /(?:^|\n)\s*(\d+) button (?:Play|Start|New Game)\b/.exec(dialogText);
        if (!start) throw new Error('No recognized new game button: ' + text(dialog));
        if (cancelled) throw new Error('Interrupted before new game Start');
        const started = await client.js(`await chess.click(${Number(start[1])}); await chess.getAXState({disableDiffing:true})`);
        trial.started = text(started);
        const after = await chess({ op: 'snapshot' }); trial.newAX = after;
        const created = after.windows.filter(w => w.title && w.bounds.Width > 400 && !before.windows.some(old => old.title === w.title));
        if (created.length !== 1) throw new Error('Cannot identify one new owned game');
        title = created[0].title;
        const visible = await client.js('await chess.getAXState({disableDiffing:true})');
        trial.beforeDragRead = text(visible);
        if (visible.isError || !trial.beforeDragRead.includes(`Window: "${title}", App: Chess.`)) throw new Error('Engine read does not identify the owned new game');
        const cg = JSON.parse(await command(inspector, ['windows-for-pid', String(after.pid), '--scope', 'all']));
        trial.newCG = cg;
        const b = created[0].bounds;
        const match = cg.filter(w => !trial.initialCG.some(old => old.windowNumber === w.windowNumber) && w.layer === 0 && Math.abs(w.bounds.x - b.X) < 1 && Math.abs(w.bounds.y - b.Y) < 1 && Math.abs(w.bounds.width - b.Width) < 1 && Math.abs(w.bounds.height - b.Height) < 1);
        if (match.length !== 1) throw new Error('CG/AX game mapping not unique');
        trial.windowId = match[0].windowNumber;
        trial.geometry = await chess({ op: 'geometry', title });
        const image = join(bank, `board-${n + 1}.png`);
        if (n === 0) {
          await command('/usr/sbin/screencapture', ['-x', '-l', String(trial.windowId), image]);
          trial.image = image;
          if (process.argv.includes('--inspect-first')) {
            receipt.inspectionGate = join(bank, 'continue');
            await save(); console.log(publish({ image, inspectionGate: receipt.inspectionGate }));
            const deadline = Date.now() + 120000;
            while (!await exists(receipt.inspectionGate)) {
              if (cancelled || Date.now() > deadline) throw new Error('Screenshot inspection deadline; no drag posted');
              await wait(250);
            }
            const fresh = await chess({ op: 'geometry', title });
            if (JSON.stringify(fresh.bounds) !== JSON.stringify(b) ||
                JSON.stringify(fresh.squares) !== JSON.stringify(trial.geometry.squares)) throw new Error('Board changed during screenshot inspection; no drag posted');
            const read = await client.js('var chess = await cua.getApp("com.apple.Chess"); await chess.getAXState({disableDiffing:true})');
            if (read.isError || !text(read).includes(`Window: "${title}", App: Chess.`)) throw new Error('Board read changed during screenshot inspection; no drag posted');
          }
        }
        if (process.argv[2].endsWith('inspect')) break;
        const measured = JSON.parse(await readFile('bench/reliability-chess-points.json', 'utf8'));
        if (JSON.stringify(measured.bounds) !== JSON.stringify(b)) throw new Error('Screenshot geometry changed; no drag posted');
        if (cancelled) throw new Error('Interrupted before drag');
        if (recovery) {
          const result = trial.recovery = {};
          result.minimized = await chess({ op: 'minimize', title, expectedPid: after.pid });
          result.offscreenCG = JSON.parse(await command(inspector, ['windows-for-pid', String(after.pid), '--scope', 'all']));
          result.refusal = await client.tool('drag', { app: 'Chess', windowId: trial.windowId, from: measured.from, to: measured.to });
          result.afterRefusal = await chess({ op: 'geometry', title });
          if (!result.minimized.minimized || !result.refusal.isError || !/off screen/.test(text(result.refusal)) ||
              JSON.stringify(result.afterRefusal.squares.map(s => s.name)) !== JSON.stringify(trial.geometry.squares.map(s => s.name))) throw new Error('Minimized refusal did not verify; no recovery drag posted');
          result.restored = await chess({ op: 'restore', title, expectedPid: after.pid });
          result.reacquired = await client.js('var chess = await cua.getApp("com.apple.Chess"); await chess.getAXState({disableDiffing:true})');
          if (result.reacquired.isError || !text(result.reacquired).includes(`Window: "${title}", App: Chess.`)) throw new Error('Recovered engine read does not identify the same game');
          result.freshAX = await chess({ op: 'geometry', title });
          if (JSON.stringify(result.freshAX.bounds) !== JSON.stringify(measured.bounds)) throw new Error('Recovered screenshot geometry changed; no drag posted');
          result.freshCG = JSON.parse(await command(inspector, ['windows-for-pid', String(after.pid), '--scope', 'all']));
          const fresh = result.freshCG.filter(w => w.windowNumber === trial.windowId && w.layer === 0 && w.onScreen &&
            Math.abs(w.bounds.x - b.X) < 1 && Math.abs(w.bounds.y - b.Y) < 1 &&
            Math.abs(w.bounds.width - b.Width) < 1 && Math.abs(w.bounds.height - b.Height) < 1);
          if (fresh.length !== 1 || result.restored.minimized) throw new Error('Recovered game is not uniquely on screen');
          trial.windowId = fresh[0].windowNumber;
          result.image = join(bank, 'recovered-board.png');
          await command('/usr/sbin/screencapture', ['-x', '-l', String(trial.windowId), result.image]);
          if (cancelled) throw new Error('Interrupted before recovered drag');
        }
        const dragStarted = Date.now();
        trial.dragPosted = true;
        trial.reply = trial.path === 'engine'
          ? await client.js(`await chess.drag(${JSON.stringify(measured.from)}, ${JSON.stringify(measured.to)}); await chess.getAXState({disableDiffing:true})`)
          : await client.tool('drag', { app: 'Chess', windowId: trial.windowId, from: measured.from, to: measured.to });
        trial.dragElapsedMs = Date.now() - dragStarted;
        trial.after = await chess({ op: 'geometry', title, allowTurnChange: true });
        if (recovery) {
          trial.afterLabels = await chess({ op: 'labels', title, allowTurnChange: true, expectedPid: after.pid });
          await wait(1000);
          trial.afterSettled = await chess({ op: 'geometry', title, allowTurnChange: true, expectedPid: after.pid });
          trial.afterRead = await client.js('await chess.getAXState({disableDiffing:true})');
        }
        trial.afterCG = JSON.parse(await command(inspector, ['windows-for-pid', String(after.pid), '--scope', 'all']));
        const verified = trial.afterSettled ?? trial.after;
        trial.passed = !trial.reply.isError && verified.squares.some(s => /white pawn, e4/.test(s.name)) && !verified.squares.some(s => /white pawn, e2/.test(s.name));
      } catch (error) {
        trial.error = { message: error.message, stdout: error.stdout, stderr: error.stderr };
        trial.failureAX = await chess({ op: 'snapshot' });
        if (trial.failureAX.running) trial.failureCG = JSON.parse(await command(inspector, ['windows-for-pid', String(trial.failureAX.pid), '--scope', 'all']));
      }
      finally {
        trial.cleanup = [];
        try {
          const owned = op => chess({ ...op, expectedPid: trial.initialAX?.pid });
          await cleanupChessTrial({ title, pid: trial.initialAX?.pid, initialTitles: (trial.initialAX?.windows ?? []).filter(w => w.title && w.bounds.Width > 400).map(w => w.title), journal: trial.cleanup,
            cancelDialog: () => owned({ op: 'cancel-new-game' }), close: title => owned({ op: 'close', title, allowTurnChange: true }), snapshot: () => owned({ op: 'snapshot' }),
            quit: () => owned({ op: 'quit' }), process: () => owned({ op: 'process' }), wait });
          if (client) { await client.close(); client = undefined; }
        } catch (error) { cleanupUnconfirmed = true; trial.cleanupError = error.message; throw error; }
        await save(); console.log(publish({ n: trial.n, path: trial.path, passed: trial.passed, error: trial.error, windowId: trial.windowId }));
        if (trial.error && !trial.dragPosted) throw new Error('Setup failed before drag; series stopped');
      }
    }
  } else if (/^fixture-(?:before|after)$/.test(process.argv[2])) {
    control = await mkdtemp('/private/tmp/sleight-reliability-fixture-'); receipt.bank = control;
    const app = join(control, 'Sleight Reliability Fixture.app'), contents = join(app, 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await writeFile(join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.sleight.reliability-fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>Sleight Reliability Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    await execute('/usr/bin/swiftc', ['-module-cache-path', join(control, 'cache'), '-o', join(contents, 'MacOS', 'fixture'), 'bench/reliability-fixture.swift'], { timeout: 60000 });
    fixtureChild = spawn(join(contents, 'MacOS', 'fixture'), [control], { stdio: ['ignore', 'ignore', 'pipe'] });
    fixtureClosed = new Promise(resolve => fixtureChild.once('close', (code, signal) => resolve({ code, signal })));
    fixtureChild.stderr.on('data', value => (receipt.fixtureStderr ??= []).push(String(value)));
    await until(() => exists(join(control, 'ready')));
    receipt.trace = [];
    client = await reliabilityClient(value => receipt.trace.push(value), {
      diagnoseRead: process.argv[2].endsWith('after') ? (app, other, readControl) => diagnoseReadFailure(app, other, { readControl }) : undefined,
    }); receipt.engine = client.version;
    await client.js('await cua.rewriteDocumentation()');
    await command('/usr/bin/open', ['-g', '-a', 'Calculator']);
    receipt.controlBefore = text(await client.js('var calc = await cua.getApp("com.apple.calculator")'));
    receipt.fixtureBefore = text(await client.js('var fixture = await cua.getApp("org.sleight.reliability-fixture")'));
    await writeFile(join(control, 'hang'), ''); await until(() => exists(join(control, 'hung')));
    receipt.directAX = await execute('/usr/bin/osascript', ['-l', 'JavaScript', 'plugins/sleight/lib/app-health.js', JSON.stringify('org.sleight.reliability-fixture')], { timeout: 3000 });
    await save(); console.log(publish({ directAX: receipt.directAX }));
    for (let n = 0; n < 2; n++) {
      const started = Date.now();
      const reply = await client.js('await fixture.getAXState({disableDiffing:true})');
      receipt.attempts.push({ n: n + 1, elapsedMs: Date.now() - started, reply }); await save();
    }
    receipt.controlDuring = await client.js('await calc.getAXState({disableDiffing:true})');
    await unlink(join(control, 'hang')); await until(() => exists(join(control, 'resumed')));
    receipt.directAXAfter = await execute('/usr/bin/osascript', ['-l', 'JavaScript', 'plugins/sleight/lib/app-health.js', JSON.stringify('org.sleight.reliability-fixture')], { timeout: 3000 });
    if (process.argv[2].endsWith('after')) {
      if (receipt.controlDuring.isError || !/\n\s*\d+ button/.test(text(receipt.controlDuring))) throw new Error('Visible control refresh was not full');
      await wait(21000);
      receipt.fixtureAfter = await client.js('await fixture.getAXState({disableDiffing:true})');
      if (receipt.fixtureAfter.isError || !/Owned responsiveness fixture/.test(text(receipt.fixtureAfter))) throw new Error('Fixture recovery did not return its full visible state');
    }
  } else throw new Error('Unknown mode');
} catch (error) {
  receipt.error = { message: error.message, stdout: error.stdout, stderr: error.stderr }; process.exitCode = 1;
} finally {
  receipt.finished = new Date().toISOString();
  try {
    if (control && fixtureChild) {
      await writeFile(join(control, 'stop'), '');
      await unlink(join(control, 'hang')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      receipt.fixtureCollected = await fixtureClosed;
    }
    if (client) { try { await client.close(); } catch (error) { cleanupUnconfirmed = true; throw error; } }
    await save();
  } finally { if (held && !cleanupUnconfirmed) await rmdir('/tmp/sleight-live.lock'); }
  console.log(publish({ mode: receipt.mode, image: receipt.image, attempts: receipt.attempts.map(({ n, elapsedMs, passed, error, reply }) => ({ n, elapsedMs, passed, error, reply: reply && text(reply) })), error: receipt.error, fixtureCollected: receipt.fixtureCollected, directAXAfter: receipt.directAXAfter }));
}
