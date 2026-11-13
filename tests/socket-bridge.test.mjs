import { macCommandSkip } from './requirements.mjs';
import { tmpdir } from 'node:os';
import { idleClock } from './fixtures/socket-clock.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, mkdirSync, openSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as tick } from 'node:timers/promises';
import { createConnection, createServer, Server } from 'node:net';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { callSocket, ensureSocketSession, createShellRelay, preparePeerCheck, printSocketResult, socketCommand, startSocketSession } from '../plugins/sleight/lib/socket-bridge.mjs';

// Keep Unix socket paths below the macOS sockaddr_un limit.
function fixture(t) {
  const root = trackTemp(mkdtempSync(join(realpathSync(process.platform === 'darwin' ? '/tmp' : tmpdir()), 'sleight-socket-test-')));
  const cleanup = [];
  t.after(async () => {
    const results = await Promise.allSettled(cleanup.map(collect => collect()));
    removeTemp(root);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const calls = [], signals = new EventEmitter();
  let collected = 0;
  return { root, cleanup, directory: join(root, 'session'), calls, signals, idleClock: idleClock(), accessibility: () => false, get collected() { return collected; },
    startRelay: async () => ({ call: async (tool, args) => { calls.push({ tool, args }); return { content: [{ type: 'text', text: 'answer' }] }; },
      close: async () => { collected++; } }), peerUid: async () => process.getuid() };
}

test('socket and folder are private and one relay serves consecutive calls', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  t.after(() => session.close());
  assert.equal(lstatSync(f.directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(session.socketPath).mode & 0o777, 0o600);
  for (const code of ['nodeRepl.write(1)', 'nodeRepl.write(2)']) {
    assert.equal((await callSocket({ tool: 'js', args: { code } }, f)).content[0].text, 'answer');
  }
  assert.equal(f.calls.length, 2);
  await session.close();
  assert.equal(f.collected, 1);
  assert.equal(existsSync(session.socketPath), false);
});

test('socket progress frames can be split and coalesced with the final reply', async t => {
  const f = fixture(t), statuses = [];
  mkdirSync(f.directory, { mode: 0o700 });
  const path = join(f.directory, 'session.sock');
  const server = createServer(socket => {
    socket.once('data', () => {
      const waiting = JSON.stringify({ approval: { state: 'waiting', app: 'TextEdit', deadline: Date.now() + 120000 } }) + '\n';
      socket.write(waiting.slice(0, 10));
      setImmediate(() => socket.end(waiting.slice(10) + JSON.stringify({ approval: { state: 'answered' } }) + '\n' +
        JSON.stringify({ result: { content: [{ type: 'text', text: 'done' }] } }) + '\n'));
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  chmodSync(path, 0o600);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await callSocket({ tool: 'js', args: { code: '1' } }, { ...f, onApproval: s => statuses.push(s) });
  assert.deepEqual(statuses.map(s => s.state), ['waiting', 'answered']);
  assert.equal(result.content[0].text, 'done');
});

test('another uid and unavailable peer credentials are refused before dispatch', async t => {
  for (const peerUid of [async () => process.getuid() + 1, async () => { throw new Error('unavailable'); }]) {
    const f = fixture(t), session = await startSocketSession({ ...f, peerUid });
    t.after(() => session.close());
    await assert.rejects(callSocket({ tool: 'js', args: { code: '1' } }, f), /peer|closed/i);
    assert.equal(f.calls.length, 0);
  }
});

test('the native peer check authenticates an actual Unix connection', { skip: macCommandSkip('clang') }, async t => {
  const f = fixture(t);
  delete f.peerUid;
  const session = await startSocketSession(f);
  t.after(() => session.close());
  assert.equal((await callSocket({ tool: 'js_reset', args: {} }, f)).content[0].text, 'answer');
});

test('missing Apple tools fail before a compiler can open an installation dialog', async () => {
  await assert.rejects(preparePeerCheck({ tools: async () => false }), /needs Xcode Command Line Tools/);
});

test('folder ownership is checked against the operating system uid', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  await session.close();
  const uid = process.getuid();
  t.mock.method(process, 'getuid', () => uid + 1);
  await assert.rejects(startSocketSession(f), /owned/);
});

test('unsafe folders and occupied socket paths are refused without removal', async t => {
  const f = fixture(t);
  symlinkSync(f.root, f.directory);
  await assert.rejects(startSocketSession(f), /owned|private/);
  rmSync(f.directory);
  const session = await startSocketSession(f);
  t.after(() => session.close());
  await assert.rejects(startSocketSession(f), /exists|occupied/);
  await session.close();
  chmodSync(f.directory, 0o777);
  await assert.rejects(startSocketSession(f), /private/);
  chmodSync(f.directory, 0o700);
  writeFileSync(session.socketPath, 'do not delete');
  await assert.rejects(startSocketSession(f), /owned|socket|occupied/);
  assert.equal(readFileSync(session.socketPath, 'utf8'), 'do not delete');
});

test('idle exit collects the engine and removes only the owned socket', async t => {
  const f = fixture(t), session = await startSocketSession({ ...f, idleMs: 600000 });
  f.idleClock.advance(600000);
  await session.closed;
  assert.equal(f.collected, 1);
  assert.equal(existsSync(session.socketPath), false);
});

test('SIGTERM waits for engine collection and is idempotent', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  f.signals.emit('SIGTERM');
  await session.closed;
  await session.close();
  assert.equal(f.collected, 1);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('SIGTERM during relay startup still collects the relay before returning', async t => {
  const f = fixture(t);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const starting = startSocketSession({ ...f, startRelay: async () => { started(); await gate; return f.startRelay(); } });
  await ready;
  f.signals.emit('SIGTERM'); release();
  await assert.rejects(starting, /stopped during startup/);
  assert.equal(f.collected, 1);
});

test('SIGTERM while binding the socket closes it without starting an engine', async t => {
  const f = fixture(t);
  let starts = 0;
  const starting = startSocketSession({ ...f, startRelay: async () => { starts++; return f.startRelay(); } });
  f.signals.emit('SIGTERM');
  await assert.rejects(starting, /stopped during startup/);
  assert.equal(starts, 0);
  assert.equal(existsSync(join(f.directory, 'session.sock')), false);
});

test('an active call does not expire as idle', async t => {
  const f = fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const relay = await f.startRelay();
  const session = await startSocketSession({ ...f, idleMs: 600000, startRelay: async () => ({ ...relay, call: async () => { entered(); return gate; } }) });
  t.after(() => session.close());
  const result = callSocket({ tool: 'js', args: { code: '1' } }, f);
  await started;
  f.idleClock.advance(1200000);
  assert.equal(f.collected, 0);
  release({ content: [{ type: 'text', text: 'done' }] });
  assert.equal((await result).content[0].text, 'done');
  f.idleClock.advance(600000);
  await session.closed;
  assert.equal(f.collected, 1);
});

test('shell calls cannot inject turn binding, approvals or arbitrary RPC', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  t.after(() => session.close());
  for (const request of [
    { tool: 'turn_ended', args: { sleight_turbo: {} } },
    { tool: 'js', args: { code: '1' }, _meta: { userPrompt: 'pay' } },
    { id: 'card', result: { action: 'accept' } },
  ]) await assert.rejects(callSocket(request, f), /request|tool/);
  assert.equal(f.calls.length, 0);
});

test('raw socket requests are validated even when the shell client is bypassed', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  t.after(() => session.close());
  for (const request of ['{"tool":"turn_ended","args":{}}\n', '{"id":"card","result":{"action":"accept"}}\n',
    '{"tool":"js","args":{"code":"1"},"_meta":{"prompt":"pay"}}\n']) {
    const reply = await new Promise((resolve, reject) => {
      const socket = createConnection(session.socketPath);
      let output = '';
      socket.once('connect', () => socket.write(request));
      socket.on('data', data => { output += data; });
      socket.once('end', () => resolve(JSON.parse(output)));
      socket.once('error', reject);
    });
    assert.match(reply.error, /request|tool/);
  }
  assert.equal(f.calls.length, 0);
});

test('local subcommand help exposes the MCP argument schemas without a session', async () => {
  for (const tool of ['open_file', 'select_window', 'drag']) {
    let output = '';
    assert.equal(await socketCommand([tool, '--help'], { out: text => { output += text; } }), 0);
    const definition = JSON.parse(output);
    assert.equal(definition.name, tool);
    assert.equal(definition.inputSchema.type, 'object');
  }
});

test('images become private cache files and error results return failure status', async t => {
  const f = fixture(t);
  let output = '';
  const code = await printSocketResult({ isError: true, content: [
    { type: 'text', text: 'stopped' }, { type: 'image', mimeType: 'image/png', data: Buffer.from('image').toString('base64') },
  ] }, { directory: f.root, out: text => { output += text; } });
  const path = output.trim().split('\n')[1];
  assert.equal(code, 1);
  assert.equal(output.split('\n')[0], 'stopped');
  assert.equal(readFileSync(path, 'utf8'), 'image');
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.doesNotMatch(output, /aW1hZ2U=/);
});

function rawRequest(path, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = '';
    socket.on('error', err => { if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') reject(err); });
    socket.on('data', data => { output += data; });
    socket.once('connect', () => socket.end(request));
    socket.once('close', () => resolve(output));
  });
}

test('the native peer helper refuses a regular file at fd 3 without output', { skip: macCommandSkip('clang') }, async t => {
  const f = fixture(t), binary = join(f.root, 'peer');
  const built = spawnSync('/usr/bin/clang', ['-Wall', '-Werror',
    fileURLToPath(new URL('../plugins/sleight/lib/socket-peer.c', import.meta.url)), '-o', binary],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
  assert.equal(built.status, 0, built.stderr);
  const path = join(f.root, 'not-a-socket');
  writeFileSync(path, '');
  const fd = openSync(path, 'r');
  t.after(() => closeSync(fd));
  const result = spawnSync(binary, [], { encoding: 'utf8', env: {}, stdio: ['ignore', 'pipe', 'pipe', fd] });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
});

test('peer compilation ignores inherited compiler search paths', { skip: macCommandSkip('clang') }, async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'sys'));
  writeFileSync(join(f.root, 'sys/socket.h'), '#error inherited CPATH reached the compiler\n');
  const previous = process.env.CPATH;
  process.env.CPATH = f.root;
  t.after(() => { if (previous === undefined) delete process.env.CPATH; else process.env.CPATH = previous; });
  const peer = await preparePeerCheck();
  peer.close();
});

test('the ninth live peer is refused before peer authentication', async t => {
  const f = fixture(t), sockets = [];
  let checks = 0;
  const session = await startSocketSession({ ...f, peerUid: async () => { checks++; return process.getuid(); } });
  t.after(async () => { sockets.forEach(socket => socket.destroy()); await session.close(); });
  for (let i = 0; i < 8; i++) {
    const socket = createConnection(session.socketPath); sockets.push(socket);
    await new Promise(resolve => socket.once('connect', resolve));
  }
  await tick(20);
  assert.equal(checks, 8);
  assert.equal(await rawRequest(session.socketPath, '{'), '');
  assert.equal(checks, 8);
});

test('an absolute request deadline closes a peer that keeps dripping partial JSON', async t => {
  const f = fixture(t), session = await startSocketSession({ ...f, requestTimeoutMs: 60 });
  t.after(() => session.close());
  const socket = createConnection(session.socketPath);
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  const interval = setInterval(() => socket.write(' '), 10);
  const closed = new Promise(resolve => socket.once('close', resolve));
  try { await Promise.race([closed, tick(400).then(() => { throw new Error('dripping peer outlived deadline'); })]); }
  finally { clearInterval(interval); socket.destroy(); }
  assert.equal(f.calls.length, 0);
});

test('oversize frames and a trailing second request never dispatch', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  t.after(() => session.close());
  assert.equal(await rawRequest(session.socketPath, 'x'.repeat(1024 * 1024 + 1)), '');
  const reply = await rawRequest(session.socketPath, '{"tool":"js_reset","args":{}}\n{"tool":"js_reset","args":{}}\n');
  assert.match(JSON.parse(reply).error, /One shell request/);
  assert.equal(f.calls.length, 0);
});

test('a concurrent call is refused until the active engine reply', async t => {
  const f = fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const session = await startSocketSession({ ...f, startRelay: async () => ({
    call: () => { entered(); return gate; }, close: async () => {},
  }) });
  t.after(() => session.close());
  const first = callSocket({ tool: 'js', args: { code: '1' } }, f);
  await started;
  await assert.rejects(callSocket({ tool: 'js_reset', args: {} }, f), /busy/);
  release({ content: [] }); await first;
});

test('identical js retries join a waiting approval without dispatching input again', async t => {
  const f = fixture(t), notices = [[], [], []];
  let approve, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const session = await startSocketSession({ ...f, startRelay: async () => ({
    call: (tool, args, { onApproval }) => { calls++; approve = onApproval; entered(); return gate; },
    close: async () => {},
  }) });
  t.after(() => session.close());
  const request = { tool: 'js', args: { code: 'await app.click(1)' } };
  const first = callSocket(request, { ...f, onApproval: s => notices[0].push(s) });
  await started;
  approve({ id: 'approval-1', state: 'waiting', app: 'Calculator', deadline: Date.now() + 120000 });
  const second = callSocket(request, { ...f, onApproval: s => notices[1].push(s) });
  const third = callSocket({ args: { code: request.args.code }, tool: 'js' }, { ...f, onApproval: s => notices[2].push(s) });
  // Attach rejection observers before checking the pending state on the baseline.
  const all = Promise.allSettled([first, second, third]);
  await tick(20);
  assert.equal(calls, 1);
  assert.deepEqual(notices.map(items => items.map(s => s.state)), [['waiting'], ['waiting'], ['waiting']]);
  await assert.rejects(callSocket({ tool: 'js', args: { code: 'await app.click(2)' } }, f), /busy/);
  approve({ id: 'approval-1', state: 'answered', app: 'Calculator', deadline: Date.now() + 120000 });
  await assert.rejects(callSocket(request, f), /busy/, 'an answered approval no longer admits a retry');
  release({ content: [{ type: 'text', text: 'one execution' }] });
  const results = await all;
  assert.ok(results.every(r => r.status === 'fulfilled' && r.value.content[0].text === 'one execution'));
  assert.deepEqual(notices.map(items => items.map(s => s.state)),
    [['waiting', 'answered'], ['waiting', 'answered'], ['waiting', 'answered']]);
});

test('a disconnected caller leaves one pending approval for an identical retry', async t => {
  const f = fixture(t);
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const session = await startSocketSession({ ...f, startRelay: async () => ({
    call: (_tool, _args, { onApproval }) => {
      calls++;
      onApproval({ id: 'approval', state: 'waiting', app: 'Calculator', deadline: Date.now() + 120000 });
      return gate;
    }, close: async () => {},
  }) });
  t.after(() => session.close());
  const request = { tool: 'js', args: { code: '1' } };
  const socket = createConnection(session.socketPath);
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  socket.write(JSON.stringify(request) + '\n');
  await new Promise(resolve => socket.once('data', resolve));
  const gone = new Promise(resolve => socket.once('close', resolve));
  socket.destroy(); await gone;
  let noticed;
  const waiting = new Promise(resolve => { noticed = resolve; });
  const retry = callSocket(request, { ...f, onApproval: noticed });
  assert.equal((await waiting).id, 'approval');
  assert.equal(calls, 1);
  release({ content: [{ type: 'text', text: 'one execution' }] });
  assert.equal((await retry).content[0].text, 'one execution');
});

test('shell stdout names the immediate card and its glove fallback while waiting', async t => {
  const f = fixture(t);
  let output = '', announce, release, approve;
  const noticed = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const session = await startSocketSession({ ...f, startRelay: async () => ({
    call: (_tool, _args, { onApproval }) => {
      approve = onApproval;
      approve({ id: 'approval', state: 'waiting', app: 'TextEdit', deadline: Date.now() + 120000 });
      return gate;
    }, close: async () => {},
  }) });
  t.after(() => session.close());
  const result = socketCommand(['js', '1'], { ...f, notice() {}, out: text => { output += text; announce(); } });
  await noticed;
  assert.match(output, /waiting for your approval in the sleight card on the Mac \(also menu bar glove > Review sleight request\) for TextEdit; the call continues when you answer, or cancels after \d+ s/);
  approve({ id: 'approval', state: 'answered', app: 'TextEdit', deadline: Date.now() + 120000 });
  release({ content: [] });
  assert.equal(await result, 0);
});

test('an image conversion failure replies once and releases the session for the next call', async t => {
  const f = fixture(t);
  let calls = 0;
  const session = await startSocketSession({ ...f, startRelay: async () => ({
    call: async () => ++calls === 1 ? { content: [{ type: 'image', mimeType: 'image/png', data: null }] } : { content: [] },
    close: async () => {},
  }) });
  t.after(() => session.close());
  await assert.rejects(callSocket({ tool: 'js', args: { code: '1' } }, f), /first argument/);
  assert.deepEqual(await callSocket({ tool: 'js', args: { code: '2' } }, f), { content: [] });
});

test('a timed-out relay call stays busy until its late engine reply', async t => {
  const f = fixture(t), requestClock = idleClock(), release = join(f.root, 'release');
  let active, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const session = await startSocketSession({ ...f, startRelay: async options => {
    const relay = await createShellRelay({ ...options, requestClock,
      args: [fileURLToPath(new URL('fixtures/socket-stall.mjs', import.meta.url))] });
    return { ...relay, call(...args) { active = relay.call(...args); entered(); return active; } };
  } });
  t.after(() => session.close());
  const first = assert.rejects(callSocket({ tool: 'js', args: { code: '1', release } }, f), /timed out/);
  await started;
  requestClock.advance(300000);
  await first;
  f.idleClock.advance(1200000);
  await assert.rejects(callSocket({ tool: 'js_reset', args: {} }, f), /busy/);
  assert.equal(existsSync(session.socketPath), true);
  writeFileSync(release, 'reply');
  await active.completed;
  requestClock.advance(30000);
  assert.equal((await callSocket({ tool: 'js_reset', args: {} }, f)).content[0].text, 'done');
});

test('shutdown escalates a relay that ignores EOF and SIGTERM', async () => {
  const relay = await createShellRelay({ args: [fileURLToPath(new URL('fixtures/socket-stall.mjs', import.meta.url)), 'stubborn'],
    termMs: 30, killMs: 30 });
  assert.equal((await relay.close()).signal, 'SIGKILL');
});

for (const ending of ['reply', 'error', 'call deadline']) test(`an outstanding approval is named when the engine ends by ${ending}`, async t => {
  const f = fixture(t), clock = idleClock();
  const relay = await createShellRelay({ requestClock: clock, timeoutMs: 300000,
    args: [fileURLToPath(new URL('fixtures/socket-stall.mjs', import.meta.url))], termMs: 50, killMs: 50 });
  t.after(() => relay.close());
  let noticed;
  const notice = new Promise(resolve => { noticed = resolve; });
  const call = relay.call('js', { code: '1', approval: true, error: ending === 'error', delay: ending === 'call deadline' ? 600000 : 50 },
    { onApproval: noticed });
  const rejected = assert.rejects(call, /approval not answered for TextEdit.*deadline/);
  await notice;
  if (ending === 'call deadline') clock.advance(300000);
  await rejected;
  await relay.closed;
  await call.completed;
});

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (err) { if (err.code === 'ESRCH') return false; throw err; }
};
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= end) assert.fail('offline fixture did not settle'); await tick(10); }
}

for (const mode of ['stubborn', 'exit']) test(`shutdown collects an engine descendant when its relay is ${mode}`, async t => {
  const f = fixture(t);
  let relay, pid;
  f.cleanup.push(async () => {
    writeFileSync(join(f.root, 'release'), 'stop');
    if (pid) await until(() => !alive(pid));
    await relay?.close();
  });
  relay = await createShellRelay({ args: [fileURLToPath(new URL('fixtures/socket-group.mjs', import.meta.url)), mode, f.root],
    termMs: 50, killMs: 50 });
  pid = Number(readFileSync(join(f.root, 'engine.pid'), 'utf8'));
  assert.equal(alive(pid), true);
  await relay.close();
  assert.equal(alive(pid), false, 'engine descendant outlived relay collection');
});

test('a second deadline closes a wedged session and collects its engine group', async t => {
  const f = fixture(t), clock = idleClock();
  let pid, active, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let session;
  f.cleanup.push(async () => {
    writeFileSync(join(f.root, 'release'), 'stop');
    if (pid) await until(() => !alive(pid));
    await session?.close();
  });
  session = await startSocketSession({ ...f, startRelay: async options => {
    const relay = await createShellRelay({ ...options, requestClock: clock, timeoutMs: 100, recoveryMs: 200, termMs: 50, killMs: 50,
      args: [fileURLToPath(new URL('fixtures/socket-group.mjs', import.meta.url)), 'stubborn', f.root] });
    return { ...relay, call(...args) { active = relay.call(...args); entered(); return active; } };
  } });
  pid = Number(readFileSync(join(f.root, 'engine.pid'), 'utf8'));
  const first = assert.rejects(callSocket({ tool: 'js', args: { code: 'wedge' } }, f), /timed out/);
  await started; clock.advance(100); await first;
  await assert.rejects(callSocket({ tool: 'js_reset', args: {} }, f), /busy/);
  clock.advance(199);
  assert.equal(existsSync(session.socketPath), true);
  clock.advance(1);
  // If recovery is absent, release the fixture before failing so the test cannot leak it.
  const closed = await Promise.race([session.closed.then(() => true), tick(1000).then(() => false)]);
  if (!closed) writeFileSync(join(f.root, 'release'), 'stop');
  assert.equal(closed, true, 'wedged session outlived the recovery deadline');
  await active.completed;
  assert.equal(alive(pid), false);
  assert.equal(existsSync(session.socketPath), false);
});

test('a write deadline frees all eight slots held by clients that never read replies', async t => {
  const f = fixture(t), clock = idleClock(), sockets = [];
  let writes = 0;
  const writeClock = { clearTimeout: clock.clearTimeout, setTimeout(fn, ms) { writes++; return clock.setTimeout(fn, ms); } };
  const session = await startSocketSession({ ...f, writeTimeoutMs: 100, writeClock,
    startRelay: async () => ({ call: async () => ({ content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024) }] }), close: async () => {} }) });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await session.close(); });
  for (let n = 0; n < 8; n++) {
    const socket = createConnection(session.socketPath); sockets.push(socket);
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write('{"tool":"js_reset","args":{}}\n');
    // The client's read side stays paused, so end() cannot flush the large reply.
    await tick(10);
  }
  assert.equal(await rawRequest(session.socketPath, '{"op":"status"}\n'), '');
  assert.equal(writes, 8, 'every reply needs its own write deadline');
  clock.advance(100);
  await tick(20);
  assert.equal((await callSocket({ op: 'status' }, f)).ready, true);
});

test('a signal cancels initialization and stays handled through relay collection', async t => {
  const f = fixture(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const starting = startSocketSession({ ...f, startRelay: options => {
    entered();
    return createShellRelay({ ...options, args: [fileURLToPath(new URL('fixtures/socket-stall.mjs', import.meta.url)), 'no-init'], timeoutMs: 5000 });
  } });
  await started;
  const stoppedAt = Date.now();
  f.signals.emit('SIGTERM');
  assert.equal(f.signals.listenerCount('SIGTERM'), 1);
  f.signals.emit('SIGTERM');
  await assert.rejects(starting, /closed|exited|stopped|abort/i);
  assert.ok(Date.now() - stoppedAt < 1000, 'shutdown waited for the initialization timeout');
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('image output refuses a directory with broader permissions', async t => {
  const f = fixture(t);
  chmodSync(f.root, 0o755);
  await assert.rejects(printSocketResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'aQ==' }] },
    { directory: f.root, out() {} }), /private/);
});

test('a missing session names the session command', async t => {
  const f = fixture(t);
  await assert.rejects(callSocket({ tool: 'js_reset', args: {} }, f), err => err.code === 'ENOENT' && /sleight-mcp session/.test(err.message));
});

test('long socket paths fail with the macOS limit before binding', async t => {
  const f = fixture(t);
  await assert.rejects(startSocketSession({ ...f, directory: join(f.root, 'x'.repeat(104)) }), /104.*bytes|103.*bytes/);
  assert.equal(f.collected, 0);
});

test('post-listen ownership failure removes the socket bound by this startup', async t => {
  const f = fixture(t), listen = Server.prototype.listen, uid = process.getuid();
  t.mock.method(Server.prototype, 'listen', function(path, callback) {
    return listen.call(this, path, () => {
      t.mock.method(process, 'getuid', () => uid + 1);
      callback();
    });
  });
  await assert.rejects(startSocketSession(f), /owned/);
  assert.equal(existsSync(join(f.directory, 'session.sock')), false);
});


test('readiness retries the owned socket publication interval without spawning', async t => {
  const f = fixture(t);
  let unlock, observed;
  const gate = new Promise(resolve => { unlock = resolve; });
  const published = new Promise(resolve => { observed = resolve; });
  const starting = startSocketSession({ ...f, publishSocket: async path => { chmodSync(path, 0o755); observed(); await gate; } });
  await published;
  let retries = 0;
  await ensureSocketSession({ directory: f.directory, notice() {}, spawnSession: () => assert.fail('not missing'),
    probe: async (...args) => {
      try { return await callSocket(...args); }
      catch (err) { if (err.code === 'ESOCKETPRIVATE') { retries++; unlock(); } throw err; }
    },
  });
  assert.equal(retries, 1);
  await (await starting).close();
});

test('session image output keeps at most fifty private images', async t => {
  const f = fixture(t), image = { content: [{ type: 'image', mimeType: 'image/png', data: 'aQ==' }] };
  for (let i = 0; i < 55; i++) await printSocketResult(image, { directory: f.root, out() {} });
  assert.equal(readdirSync(f.root).length, 50);
  for (const name of readdirSync(f.root)) assert.equal(lstatSync(join(f.root, name)).mode & 0o777, 0o600);
});


test('status measures native trust inside the live session for every probe', async t => {
  const f = fixture(t);
  let trusted = false, checks = 0;
  const session = await startSocketSession({ ...f, accessibility: () => { checks++; return trusted; } });
  t.after(() => session.close());
  assert.equal((await callSocket({ op: 'status' }, f)).nativeAccessibility, false);
  trusted = true;
  assert.equal((await callSocket({ op: 'status' }, f)).nativeAccessibility, true);
  assert.equal(checks, 2);
});
