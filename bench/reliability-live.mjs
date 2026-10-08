import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rmdir, writeFile, readFile, mkdtemp, unlink, access } from 'node:fs/promises';
import { reliabilityEvidence } from './reliability-evidence.mjs';
import { reliabilityClient } from './reliability-client.mjs';
import { callLocalTool } from '../plugins/sleight/lib/launch.mjs';
import { diagnoseReadFailure } from '../plugins/sleight/lib/read-failure.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { restartChess } from './chess-launch.mjs';

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
let held = false;
try {
  while (!held && !cancelled) {
    try { await mkdir('/tmp/sleight-live.lock'); held = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await wait(1000); }
  }
  if (cancelled) throw new Error('Interrupted before live work');
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
  } else if (/^chess-(?:before|after|inspect)$/.test(process.argv[2])) {
    const existing = await chess({ op: 'snapshot' }); receipt.existing = existing;
    if (existing.windows.some(w => w.title && w.bounds.Width > 400) && !process.argv.includes('--close-existing')) {
      throw new Error('Chess has an existing game; closing it requires explicit operator approval');
    }
    // The named benchmark investigation owns Chess while this lock is held.
    for (const win of existing.windows.filter(w => w.title && w.bounds.Width > 400)) {
      const closed = await chess({ op: 'close', title: win.title });
      if (!closed.closed) throw new Error('Existing benchmark Chess game did not close');
    }
    if (existing.running) await command('/usr/bin/osascript', ['-e', 'tell application "Chess" to quit']);
    const bank = await mkdtemp('/private/tmp/sleight-reliability-'); receipt.bank = bank;
    receipt.trace = [];
    client = await reliabilityClient(value => {
      // Screenshots stay in the private bank; receipts retain tool text and metadata.
      const copy = JSON.parse(JSON.stringify(value, (key, item) => item?.type === 'image' ? { type: 'image', omitted: true } : item));
      receipt.trace.push(copy);
    }, { localTools: { tools: [{ name: 'drag' }], call: callLocalTool } });
    receipt.engine = client.version;
    await client.js('await cua.rewriteDocumentation()');
    const count = process.argv[2].endsWith('inspect') ? 1 : 20;
    for (let n = 0; n < count && !cancelled; n++) {
      const trial = { n: n + 1, path: n % 2 ? 'local' : 'engine' }; receipt.attempts.push(trial);
      let title;
      try {
        // Immediate launch deliberately reproduces the benchmark's quit/open sequence.
        if (process.argv[2] === 'chess-after') restartChess({ quit: () => {} });
        else trial.launch = await command('/usr/bin/open', ['-g', '-a', 'Chess', '--args', '-ApplePersistenceIgnoreState', 'YES']);
        await wait(3000);
        const before = await chess({ op: 'snapshot' }); trial.initialAX = before;
        trial.initialCG = JSON.parse(await command(inspector, ['windows-for-pid', String(before.pid), '--scope', 'all']));
        const acquired = await client.js('var chess = await cua.getApp("com.apple.Chess")');
        if (acquired.isError) throw new Error(text(acquired));
        const dialog = await client.js('await chess.pressKey("super+n"); await chess.getAXState({disableDiffing:true})');
        const start = /(?:^|\n)\s*(\d+) button (?:Play|Start|New Game)\b/.exec(text(dialog));
        if (!start) throw new Error('No recognized new game button: ' + text(dialog));
        const started = await client.js(`await chess.click(${Number(start[1])}); await chess.getAXState({disableDiffing:true})`);
        trial.started = text(started);
        const after = await chess({ op: 'snapshot' }); trial.newAX = after;
        const created = after.windows.filter(w => w.title && w.bounds.Width > 400 && !before.windows.some(old => old.title === w.title));
        if (created.length !== 1) throw new Error('Cannot identify one new owned game');
        title = created[0].title;
        const cg = JSON.parse(await command(inspector, ['windows-for-pid', String(after.pid), '--scope', 'all']));
        trial.newCG = cg;
        const b = created[0].bounds;
        const match = cg.filter(w => w.layer === 0 && Math.abs(w.bounds.x - b.X) < 1 && Math.abs(w.bounds.y - b.Y) < 1 && Math.abs(w.bounds.width - b.Width) < 1 && Math.abs(w.bounds.height - b.Height) < 1);
        if (match.length !== 1) throw new Error('CG/AX game mapping not unique');
        trial.windowId = match[0].windowNumber;
        trial.geometry = await chess({ op: 'geometry', title });
        const image = join(bank, `board-${n + 1}.png`);
        if (n === 0) {
          await command('/usr/sbin/screencapture', ['-x', '-l', String(trial.windowId), image]);
          trial.image = image;
        }
        if (process.argv[2].endsWith('inspect')) break;
        const measured = JSON.parse(await readFile('bench/reliability-chess-points.json', 'utf8'));
        if (JSON.stringify(measured.bounds) !== JSON.stringify(b)) throw new Error('Screenshot geometry changed; no drag posted');
        trial.reply = trial.path === 'engine'
          ? await client.js(`await chess.drag(${JSON.stringify(measured.from)}, ${JSON.stringify(measured.to)}); await chess.getAXState({disableDiffing:true})`)
          : await client.tool('drag', { app: 'Chess', windowId: trial.windowId, from: measured.from, to: measured.to });
        trial.after = await chess({ op: 'geometry', title });
        trial.passed = !trial.reply.isError && trial.after.squares.some(s => /white pawn, e4/.test(s.name)) && !trial.after.squares.some(s => /white pawn, e2/.test(s.name));
      } catch (error) { trial.error = { message: error.message, stdout: error.stdout, stderr: error.stderr }; }
      finally {
        if (title) trial.closed = await chess({ op: 'close', title });
        const remaining = await chess({ op: 'snapshot' });
        // This runner started Chess when absent. Stop if a concurrent game appeared.
        const games = remaining.windows.filter(w => w.title && w.bounds.Width > 400);
        if (games.length > 1 || (title && games.some(w => w.title === title))) throw new Error('Chess fixture cleanup unconfirmed');
        if (remaining.running) await command('/usr/bin/osascript', ['-e', 'tell application "Chess" to quit']);
        await save(); console.log(publish({ n: trial.n, path: trial.path, passed: trial.passed, error: trial.error, windowId: trial.windowId }));
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
    if (client) await client.close();
    await save();
  } finally { if (held) await rmdir('/tmp/sleight-live.lock'); }
  console.log(publish({ mode: receipt.mode, image: receipt.image, attempts: receipt.attempts.map(({ n, elapsedMs, passed, error, reply }) => ({ n, elapsedMs, passed, error, reply: reply && text(reply) })), error: receipt.error, fixtureCollected: receipt.fixtureCollected, directAXAfter: receipt.directAXAfter }));
}
