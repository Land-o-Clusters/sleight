// Up to three TextEdit edits after AXRaise/AXMain. Stop if the engine ignores it.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { callLocalTool, resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { collectEngine } from './window-targeting-cleanup.mjs';
import { SELECT_WINDOW_TOOL } from '../plugins/sleight/lib/select-window.mjs';

const output = process.argv[2];
const probe = process.argv[3];
assert.match(output ?? '', /^docs\/benchmarks\/[a-z0-9-]+\.json$/);
assert.match(probe ?? '', /^\/private\/tmp\/sleight-window-targeting-ax\.[a-zA-Z0-9]+\/probe$/);
assert.ok(!existsSync(output), 'Every attempt needs a new results file');
const bank = await mkdtemp('/private/tmp/sleight-window-target-');
const paths = [join(bank, 'sleight-window-left.txt'), join(bank, 'sleight-window-right.txt')];
const execute = promisify(execFile);
const text = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const records = [], trials = [], opened = [];
const pending = new Map();
let child, stopped, relay, counter = 0;
let engineCollected = true;
let interrupted = false;
process.once('SIGINT', () => {
  interrupted = true;
  for (const request of pending.values()) request.reject(new Error('Interrupted'));
});
const fixture = (op, path) => execute('osascript', ['-l', 'JavaScript',
  fileURLToPath(new URL('./input-lease-fixture.js', import.meta.url)), op, path]);
const ax = async (op, kind, wanted) => JSON.parse((await execute(
  probe, [op, kind, wanted], { timeout: 10000 })).stdout);
const runScript = async (script, args) => JSON.parse((await execute('osascript', ['-l', 'JavaScript',
  fileURLToPath(new URL('../plugins/sleight/lib/' + script, import.meta.url)), JSON.stringify(args)])).stdout);
const send = (stream, msg) => stream.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const clientIn = new PassThrough(), clientOut = new PassThrough();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Request timed out')); }, 45000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
    reject: error => { clearTimeout(timer); pending.delete(id); reject(error); } });
  send(clientIn, { id, method, params });
});
const call = (name, args = {}) => request('tools/call', { name, arguments: args });
function record(direction, msg) {
  // An ignored raise can return another session's document. Keep only the
  // fact that it missed our fixtures, never that document's title or contents.
  const window = windowFromText(text(msg.result));
  if (window && !paths.some(path => pathToFileURL(path).href === window.url)) {
    records.push({ direction, msg: { id: msg.id, unrelatedWindowRedacted: true, isError: msg.result?.isError } });
  } else records.push({ direction, msg });
}

try {
  for (const path of paths) {
    await writeFile(path, 'seed|');
    // Record before open, so cleanup also attempts a partially opened fixture.
    opened.push(path); await fixture('open', path);
  }
  const server = resolveServer(); assert.ok(!server.error, server.error);
  trials.push({ phase: 'runtime', version: server.version, node: process.version });
  child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  engineCollected = false;
  stopped = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stderr.setEncoding('utf8').on('data', data => records.push({ engineStderr: data }));
  child.once('error', error => { for (const p of pending.values()) p.reject(error); });
  relay = createRelay({ clientIn, clientOut, serverIn: child.stdin, serverOut: child.stdout,
    sessionId: 'window-targeting-bench', inputLease: new InputLease({ directory: join(bank, 'leases') }),
    localTools: { tools: [SELECT_WINDOW_TOOL], call: (name, args, approve, _, target) => callLocalTool(name, args, approve, runScript, target),
      target: async args => { const result = await runScript('lease-target.js', args);
        assert.ok(result.ok, result.error); return result.target; } },
    ask: async message => {
      const approval = spawnSync(process.execPath, [fileURLToPath(new URL('./approve.mjs', import.meta.url))], {
        input: JSON.stringify({ message, mcp_server_name: 'plugin:sleight:computer' }), encoding: 'utf8' });
      const decision = approval.stdout.trim() ? JSON.parse(approval.stdout).hookSpecificOutput.action : 'decline';
      records.push({ approval: { message, decision, hookExit: approval.status } });
      return decision;
    }, trace: record });
  let buffer = '';
  clientOut.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const waiting = pending.get(msg.id);
      if (waiting) { pending.delete(msg.id); msg.error ? waiting.reject(new Error(msg.error.message)) : waiting.resolve(msg.result); }
    }
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } },
    clientInfo: { name: 'sleight-window-targeting-bench', version: '1' } });
  send(clientIn, { method: 'notifications/initialized' });
  const expected = ['seed|', 'seed|'];
  for (let i = 0; i < 3; i++) {
    if (interrupted) throw new Error('Interrupted');
    const target = i % 2, kind = i === 1 ? 'title' : 'url';
    const wanted = kind === 'title' ? paths[target].split('/').pop() : pathToFileURL(paths[target]).href;
    const trial = { phase: 'edit', trial: i + 1, target: paths[target], kind };
    trials.push(trial);
    try {
      trial.before = await ax('observe', kind, wanted);
      assert.ok(trial.before.ok, 'AX could not find exactly one fixture window');
      assert.equal(trial.before.after.active, false, 'TextEdit must start in the background');
      trial.selectionReply = await call('select_window', { app: 'TextEdit', [kind === 'title' ? 'title' : 'url']: wanted });
      assert.ok(!trial.selectionReply.isError, text(trial.selectionReply));
      trial.raise = JSON.parse(text(trial.selectionReply));
      assert.ok(trial.raise.ok, 'AX could not find exactly one fixture window');
      const read = await call('js', { code: `${i ? 'app =' : 'let app ='} await cua.getApp("com.apple.TextEdit")` });
      const observed = windowFromText(text(read));
      trial.read = observed && paths.some(path => pathToFileURL(path).href === observed.url)
        ? read : { isError: read.isError, unrelatedOrMissingWindowRedacted: true };
      trial.afterRead = await ax('observe', kind, wanted);
      assert.ok(!read.isError, 'Engine acquisition failed');
      assert.ok(observed?.url === pathToFileURL(paths[target]).href, 'Engine ignored raised window');
      assert.ok(observed?.title === paths[target].split('/').pop(), 'Engine header title differs');
      assert.equal(trial.afterRead.after.active, false, 'TextEdit became foreground');
      assert.equal(trial.afterRead.after.frontmostPID, trial.before.after.frontmostPID, 'Foreground app changed');
      const marker = `AXWINDOW${i + 1}|`;
      trial.action = await call('js', { code: `await app.pressKey("super+a"); await app.typeText(${JSON.stringify(marker)}); await app.pressKey("super+s")` });
      assert.ok(!trial.action.isError, text(trial.action));
      expected[target] = marker;
      trial.buffers = await Promise.all(paths.map(async path => JSON.parse((await fixture('read', path)).stdout).text));
      trial.files = await Promise.all(paths.map(path => readFile(path, 'utf8')));
      assert.deepEqual(trial.buffers, expected); assert.deepEqual(trial.files, expected);
      trial.afterAction = await ax('observe', kind, wanted);
      assert.equal(windowFromText(text(trial.action))?.url, pathToFileURL(paths[target]).href);
      assert.equal(trial.afterAction.after.active, false, 'TextEdit became foreground during action');
      assert.equal(trial.afterAction.after.frontmostPID, trial.before.after.frontmostPID, 'Foreground app changed during action');
      assert.ok(!text(trial.action).includes('Sleight: outcome unconfirmed'));
      trial.passed = true;
    } catch (error) {
      // No further raises or edits after an ignored selection.
      trial.error = error.message; trial.passed = false; process.exitCode = 1;
      trial.buffers = await Promise.all(paths.map(async path => JSON.parse((await fixture('read', path)).stdout).text));
      trial.files = await Promise.all(paths.map(path => readFile(path, 'utf8')));
      break;
    }
  }
  if (!process.exitCode) {
    const trial = { phase: 'close-recovery', target: paths[1] }; trials.push(trial);
    trial.selection = await call('select_window', { app: 'TextEdit', url: pathToFileURL(paths[1]).href });
    assert.ok(!trial.selection.isError, text(trial.selection));
    trial.read = await call('js', { code: 'app = await cua.getApp("com.apple.TextEdit")' });
    assert.ok(windowFromText(text(trial.read))?.url === pathToFileURL(paths[1]).href, 'Close target was not confirmed');
    trial.close = await call('js', { code: 'await app.pressKey("super+w")' });
    trial.closedWindow = await ax('observe', 'url', pathToFileURL(paths[1]).href);
    assert.equal(trial.closedWindow.matches, 0, 'Selected fixture did not close');
    opened.splice(opened.indexOf(paths[1]), 1);
    trial.recovery = await call('js', { code: 'app = await cua.getApp("com.apple.TextEdit")' });
    assert.ok(windowFromText(text(trial.recovery))?.url === pathToFileURL(paths[0]).href, 'Remaining fixture was not confirmed');
    trial.action = await call('js', { code: 'await app.pressKey("super+a"); await app.typeText("CLOSE-RECOVERY|"); await app.pressKey("super+s")' });
    assert.ok(!trial.action.isError, text(trial.action));
    assert.ok(!text(trial.action).includes('outcome unconfirmed'));
    trial.buffer = JSON.parse((await fixture('read', paths[0])).stdout).text;
    trial.file = await readFile(paths[0], 'utf8');
    assert.equal(trial.buffer, 'CLOSE-RECOVERY|'); assert.equal(trial.file, 'CLOSE-RECOVERY|');
    trial.foreground = await ax('observe', 'url', pathToFileURL(paths[0]).href);
    assert.equal(trial.foreground.after.active, false, 'TextEdit became foreground');
    trial.passed = true;
  }
} catch (error) { trials.push({ phase: 'failure', error: error.message }); process.exitCode = 1; }
finally {
  if (relay) {
    try { const exit = await collectEngine({ child, stopped, relay });
      engineCollected = true;
      trials.push({ phase: 'engine-cleanup', ...exit });
      if (exit.code !== 0 || exit.signals.length || exit.shutdownError) process.exitCode = 1; }
    catch (error) { trials.push({ phase: 'engine-cleanup', error: error.message }); process.exitCode = 1; }
  }
  for (const path of opened) {
    if (!engineCollected) { trials.push({ phase: 'fixture-cleanup', path, skipped: 'Engine exit unconfirmed' }); continue; }
    try { await fixture('close', path); trials.push({ phase: 'fixture-cleanup', path, closed: true }); }
    catch (error) { trials.push({ phase: 'fixture-cleanup', path, error: error.message }); process.exitCode = 1; }
  }
  const results = JSON.stringify({ date: new Date().toISOString(), bank, trials, records, exitCode: process.exitCode ?? 0 }, null, 2)
    .replaceAll(homedir(), '~');
  await writeFile(output, results + '\n', { flag: 'wx' });
  console.log(`Evidence: ${output}; exit ${process.exitCode ?? 0}`);
}
