import { tmpdir } from 'node:os';
import { idleClock } from './fixtures/socket-clock.mjs';
import { test } from 'node:test';
import { demandWait, spawnDemand } from './fixtures/socket-demand-owner.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callSocket, ensureSocketSession, socketCommand, spawnDetachedSession, startSocketSession } from '../plugins/sleight/lib/socket-bridge.mjs';

// Keep Unix socket paths below the macOS sockaddr_un limit.
function fixture(t) {
  const root = trackTemp(mkdtempSync(join(realpathSync(process.platform === 'darwin' ? '/tmp' : tmpdir()), 'sleight-demand-')));
  const cleanup = [];
  t.after(async () => {
    const results = await Promise.allSettled(cleanup.map(collect => collect()));
    removeTemp(root);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  return { cleanup, directory: join(root, 'shell'), signals: new EventEmitter(), idleClock: idleClock(), accessibility: () => false, peerUid: async () => process.getuid(),
    startRelay: async () => ({ call: async () => ({ content: [{ type: 'text', text: 'ok' }] }), close: async () => {} }) };
}

test('js starts a missing session once, reuses it, and reports a restart after idle exit', async t => {
  const f = fixture(t), sessions = [], notices = [];
  t.after(async () => { for (const s of sessions) await s.close(); });
  let starts = 0;
  const options = { directory: f.directory, notice: line => notices.push(line),
    spawnSession: async () => { starts++; sessions.push(await startSocketSession({ ...f, idleMs: 600000 })); } };
  assert.equal(await socketCommand(['js', '1'], { ...options, out: () => {} }), 0);
  assert.equal(await socketCommand(['js', '2'], { ...options, out: () => {} }), 0);
  assert.equal(starts, 1);
  assert.match(notices.join('\n'), /shell session/);
  f.idleClock.advance(600000);
  await sessions[0].closed;
  await socketCommand(['js', '3'], { ...options, out: () => {} });
  assert.equal(starts, 2);
  assert.notEqual(notices[0], notices.at(-1));
  assert.match(notices.at(-1), /JavaScript.*reset/i);
});

test('a failed dispatched call is never replayed or used to start another session', async t => {
  const f = fixture(t);
  let calls = 0;
  const session = await startSocketSession({ ...f, startRelay: async () => ({
    call: async () => { calls++; throw new Error('uncertain effect'); }, close: async () => {},
  }) });
  t.after(() => session.close());
  await assert.rejects(socketCommand(['js', 'input()'], { directory: f.directory, out: () => {},
    notice: () => {}, spawnSession: () => assert.fail('must not restart') }), /uncertain effect/);
  assert.equal(calls, 1);
});

test('session owns image files in the cache directory and prunes them at idle exit', async t => {
  const f = fixture(t);
  const session = await startSocketSession({ ...f, idleMs: 600000, startRelay: async () => ({
    call: async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') }] }),
    close: async () => {},
  }) });
  t.after(() => session.close());
  let output = '';
  await socketCommand(['js', 'screenshot()'], { directory: f.directory, notice: () => {}, out: s => { output += s; } });
  const path = output.trim();
  assert.ok(path.startsWith(f.directory + '/images-'));
  assert.equal(readFileSync(path, 'utf8'), 'png');
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  f.idleClock.advance(600000);
  await session.closed;
  assert.equal(existsSync(path), false);
});

test('on-demand child has its own process group and exits after collecting its offline relay', { timeout: 15000 }, async t => {
  const f = fixture(t);
  let child, closed;
  await ensureSocketSession({ directory: f.directory, notice: () => {}, spawnSession: async () => {
    child = await spawnDemand(f, { observe: options => {
      assert.equal(options.detached, true);
      assert.equal(options.stdio[0], 'ignore');
      assert.equal(options.stdio[1], 'ignore');
      assert.equal(typeof options.stdio[2], 'number');
      assert.equal(options.cwd, f.directory);
    } });
    const errors = () => readFileSync(join(f.directory, 'session.log'), 'utf8');
    closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(errors())));
    });
  } });
  const result = await callSocket({ tool: 'js', args: { code: '1' } }, f);
  assert.equal(JSON.parse(result.content[0].text).pid, child.pid);
  assert.doesNotThrow(() => process.kill(-child.pid, 0));
  await callSocket({ tool: 'js', args: { code: 'stop' } }, f);
  await closed;
  assert.equal(existsSync(join(f.directory, 'session.sock')), false);
  assert.equal(readFileSync(join(f.directory, 'collected'), 'utf8'), 'yes');
});

test('install-agent only prints an escaped plist and an explicit owner command', async t => {
  const f = fixture(t);
  const before = readdirSync(f.directory.replace(/\/shell$/, ''));
  let output = '', errors = '';
  assert.equal(await socketCommand(['session', '--install-agent'], { out: s => { output += s; },
    directory: f.directory, err: s => { errors += s; }, executable: '/a & b/sleight-mcp', spawnSession: () => assert.fail('no install or start') }), 0);
  assert.match(output, /<string>\/a &amp; b\/sleight-mcp<\/string>/);
  assert.ok(output.startsWith('<?xml'));
  assert.ok(output.trimEnd().endsWith('</plist>'));
  assert.doesNotMatch(output, /KeepAlive|launchctl|Owner/);
  assert.match(errors, /launchctl bootstrap/);
  assert.match(errors, /Owner/);
  assert.deepEqual(readdirSync(f.directory.replace(/\/shell$/, '')), before);
});


test('concurrent session starters create just one relay', async t => {
  const f = fixture(t);
  let starts = 0;
  const options = { ...f, startRelay: async () => { starts++; return f.startRelay(); } };
  const results = await Promise.allSettled([startSocketSession(options), startSocketSession(options)]);
  const session = results.find(result => result.status === 'fulfilled').value;
  t.after(() => session.close());
  assert.equal(starts, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('a refused stale socket and old private images are reclaimed before dispatch', async t => {
  const f = fixture(t);
  mkdirSync(f.directory, { mode: 0o700 });
  const oldImages = mkdtempSync(join(f.directory, 'images-'));
  writeFileSync(join(oldImages, 'old.png'), 'old', { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('fixtures/socket-demand.mjs', import.meta.url)),
    f.directory, '--stale'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('stale fixture failed')));
  });
  assert.equal(existsSync(join(f.directory, 'session.sock')), true);
  const session = await startSocketSession(f);
  t.after(() => session.close());
  assert.equal(existsSync(oldImages), false);
  assert.equal((await callSocket({ tool: 'js', args: { code: '1' } }, f)).content[0].text, 'ok');
});

test('unready startup is bounded and never dispatches a call', async t => {
  const f = fixture(t);
  let starts = 0;
  let now = 0;
  await assert.rejects(ensureSocketSession({ directory: f.directory, startupMs: 90000, now: () => now, pause: async ms => { now += ms; },
    spawnSession: async () => { starts++; }, notice: () => {} }), /did not become ready/);
  assert.equal(starts, 1);
});

test('dead starter ownership and an old unpublished lock are reclaimed', async t => {
  for (const published of [true, false]) {
    const f = fixture(t);
    mkdirSync(f.directory, { mode: 0o700 });
    const lock = join(f.directory, 'starting');
    mkdirSync(lock, { mode: 0o700 });
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise(resolve => child.once('close', resolve));
    if (published) writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: child.pid, time: Date.now() }), { mode: 0o600 });
    else utimesSync(lock, new Date(0), new Date(0));
    const session = await startSocketSession(f);
    assert.equal(JSON.parse(readFileSync(join(lock, 'owner'))).pid, process.pid);
    await session.close();
    assert.equal(existsSync(lock), false);
  }
});

test('a live owner is preserved even when its timestamp is old', async t => {
  const f = fixture(t);
  mkdirSync(join(f.directory, 'starting'), { recursive: true, mode: 0o700 });
  const owner = join(f.directory, 'starting/owner');
  writeFileSync(owner, JSON.stringify({ pid: process.pid, time: 0 }), { mode: 0o600 });
  await assert.rejects(startSocketSession(f), /occupied/);
  assert.equal(JSON.parse(readFileSync(owner)).pid, process.pid);
});

test('a failed detached starter reports its exit code and private stderr log without a readiness wait', async t => {
  const f = fixture(t);
  let polls = 0;
  await assert.rejects(ensureSocketSession({ directory: f.directory, notice() {},
    probe: (...args) => { assert.ok(++polls <= 2); return callSocket(...args); },
    spawnSession: async () => {
      const child = await spawnDetachedSession({ directory: f.directory,
        args: [fileURLToPath(new URL('fixtures/socket-demand.mjs', import.meta.url)), f.directory, '--fail'] });
      await child.sessionExit;
      return child;
    },
  }), /starter exited \(23\).*session.log/);
  assert.equal(readFileSync(join(f.directory, 'session.log'), 'utf8'), 'offline startup failure\n');
  assert.equal(lstatSync(join(f.directory, 'session.log')).mode & 0o777, 0o600);
});

test('hostile caller settings never reach the detached session or its relay and cwd is the cache', async t => {
  const f = fixture(t);
  const hostile = { SLEIGHT_CK1: '0', SLEIGHT_CK2: '0', NODE_OPTIONS: '--require /not/caller-code.cjs',
    SLEIGHT_FLOW_RULES: 'caller-rules.json', DYLD_INSERT_LIBRARIES: '/not/caller.dylib', SLEIGHT_GUARD: '0',
    SLEIGHT_CLIPBOARD: '0', SLEIGHT_ACTION_LOG: '/not/log', SLEIGHT_SURFACES: 'browser', SLEIGHT_OFFSCREEN_CLICK: '1' };
  const previous = Object.fromEntries(Object.keys(hostile).map(key => [key, process.env[key]]));
  Object.assign(process.env, hostile);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let child;
  await ensureSocketSession({ directory: f.directory, notice() {}, spawnSession: async () => child = await spawnDemand(f) });
  const { content } = await callSocket({ tool: 'js', args: { code: 'env' } }, f);
  const result = JSON.parse(content[0].text);
  assert.equal(result.cwd, f.directory);
  assert.equal(result.relay.cwd, f.directory);
  for (const key of Object.keys(hostile)) {
    assert.equal(result.env[key], undefined, key);
    assert.equal(result.relay.env[key], undefined, key);
  }
  assert.deepEqual(Object.keys(result.relay.env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR', 'USER']);
});

test('a foreground session passes the same fixed environment and cache cwd to its relay', async t => {
  const f = fixture(t);
  const old = process.env.SLEIGHT_CK1;
  process.env.SLEIGHT_CK1 = '0';
  t.after(() => { if (old === undefined) delete process.env.SLEIGHT_CK1; else process.env.SLEIGHT_CK1 = old; });
  const session = await startSocketSession({ ...f, startRelay: options => {
    assert.equal(options.env.SLEIGHT_CK1, undefined);
    assert.equal(options.cwd, f.directory);
    return f.startRelay();
  } });
  await session.close();
});

test('odd image entries are preserved while private image and marker leftovers are pruned', async t => {
  const f = fixture(t);
  mkdirSync(f.directory, { mode: 0o700 });
  writeFileSync(join(f.directory, 'images-file'), 'keep');
  symlinkSync(f.directory, join(f.directory, 'images-link'));
  mkdirSync(join(f.directory, 'images-public'), { mode: 0o755 });
  mkdirSync(join(f.directory, 'marker-old'), { mode: 0o700 });
  const session = await startSocketSession(f);
  t.after(() => session.close());
  assert.equal(readFileSync(join(f.directory, 'images-file'), 'utf8'), 'keep');
  assert.equal(lstatSync(join(f.directory, 'images-link')).isSymbolicLink(), true);
  assert.equal(existsSync(join(f.directory, 'images-public')), true);
  assert.equal(existsSync(join(f.directory, 'marker-old')), false);
});

test('closing retains ownership until the old relay has finished collection', async t => {
  const f = fixture(t);
  let finish, entered;
  const collecting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const session = await startSocketSession({ ...f, startRelay: async () => ({ close: async () => { entered(); await gate; } }) });
  const closing = session.close();
  await collecting;
  await assert.rejects(startSocketSession(f), /occupied/);
  finish(); await closing;
  const replacement = await startSocketSession(f);
  await replacement.close();
});

test('separate starter processes create one session and one live process group', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const children = await Promise.all([spawnDemand(f), spawnDemand(f)]);
  const admissions = await demandWait(Promise.all(children.map(child => child.admission)), 'both starter admission outcomes');
  assert.equal(admissions.filter(result => result.ready).length, 1);
  assert.equal(admissions.filter(result => result.code === 1 && !result.signal).length, 1);
  assert.match(readFileSync(join(f.directory, 'session.log'), 'utf8'), /occupied by a starting or closing session/);
  await demandWait(ensureSocketSession({ directory: f.directory, startupMs: 5000, notice() {}, spawnSession: async () => {} }), 'session readiness');
  const result = JSON.parse((await demandWait(callSocket({ tool: 'js', args: { code: 'pid' } }, { ...f, timeoutMs: 5000 }), 'session pid reply')).content[0].text);
  assert.ok(children.some(child => child.pid === result.pid));
  assert.doesNotThrow(() => process.kill(-result.pid, 0));
  await demandWait(callSocket({ tool: 'js', args: { code: 'stop' } }, { ...f, timeoutMs: 5000 }), 'session stop reply');
  const exits = await demandWait(Promise.all(children.map(child => child.sessionExit)), 'both starter exits after stop');
  assert.deepEqual(exits.map(exit => exit.code).sort(), [0, 1]);
});

test('a late second starter exposes shutdown before both admission attempts', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const first = await spawnDemand(f);
  await ensureSocketSession({ directory: f.directory, startupMs: 5000, notice() {}, spawnSession: async () => {} });
  await callSocket({ tool: 'js', args: { code: 'stop' } }, { ...f, timeoutMs: 5000 });
  await demandWait(first.sessionExit, 'first starter shutdown before late admission');
  // Model a second process that was not scheduled until after the first stopped.
  const second = await spawnDemand(f);
  await ensureSocketSession({ directory: f.directory, startupMs: 5000, notice() {}, spawnSession: async () => {} });
  const pid = JSON.parse((await callSocket({ tool: 'js', args: { code: 'pid' } }, { ...f, timeoutMs: 5000 })).content[0].text).pid;
  assert.equal(pid, second.pid);
  assert.notEqual(pid, first.pid);
  // The old concurrent test assumes this child lost admission and waits forever for its exit.
  await assert.rejects(demandWait(second.sessionExit, 'late second starter exit after first shutdown', 100),
    /waiting for late second starter exit after first shutdown/);
  await callSocket({ tool: 'js', args: { code: 'stop' } }, { ...f, timeoutMs: 5000 });
  assert.equal((await demandWait(second.sessionExit, 'late second starter shutdown')).code, 0);
});

for (const [mode, waiting] of [['', 'session shutdown'], ['--stall-startup', 'socket publication']]) {
  test(`fixture watchdog bounds ${waiting}`, { timeout: 15000 }, async t => {
    const f = fixture(t);
    const child = await spawnDemand(f, { fixtureArgs: [mode, '--deadline-ms', '1000'] });
    const exit = await demandWait(child.sessionExit, `watchdog exit during ${waiting}`);
    assert.equal(exit.code, 1);
    assert.equal(exit.signal, null);
    assert.match(readFileSync(join(f.directory, 'session.log'), 'utf8'), new RegExp(`timed out waiting for ${waiting}`));
  });
}

test('cleanup kills and collects a fixture that ignores its stop message', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const child = await spawnDemand(f, { fixtureArgs: ['--ignore-stop'], cleanupMs: 100 });
  assert.deepEqual(await demandWait(child.admission, 'fixture readiness before stuck cleanup'), { ready: true });
  await assert.rejects(f.cleanup[0](), /waiting for fixture \d+ graceful shutdown/);
  assert.deepEqual(await demandWait(child.sessionExit, 'ignored-stop fixture collection'), { code: null, signal: 'SIGKILL' });
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('each independent caller sees the session identity on stdout before tool output', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  t.after(() => session.close());
  const outputs = [];
  for (let i = 0; i < 2; i++) {
    let text = '';
    await socketCommand(['js', '1'], { directory: f.directory, out: chunk => { text += chunk; } });
    outputs.push(text);
    assert.match(text, /^sleight: shell session [a-f0-9-]+;.*reset.*\nok\n$/);
  }
  assert.equal(outputs[0], outputs[1]);
});


test('the foreground executable clears loader and guard variables before Node starts', t => {
  const f = fixture(t), fakeApp = join(f.directory, 'fake.app'), node = join(fakeApp, 'Contents/Resources/cua_node/bin/node');
  mkdirSync(node.slice(0, node.lastIndexOf('/')), { recursive: true, mode: 0o700 });
  writeFileSync(node, '#!/bin/sh\nexec /usr/bin/env\n', { mode: 0o700 });
  const text = execFileSync(fileURLToPath(new URL('../plugins/sleight/bin/sleight-mcp', import.meta.url)), ['session'], {
    encoding: 'utf8', env: { ...process.env, SLEIGHT_CHATGPT_APP: fakeApp, NODE_OPTIONS: '--require /not/caller.cjs',
      DYLD_INJECT_TEST: 'hostile', SLEIGHT_CK1: '0', SLEIGHT_FLOW_RULES: 'caller.json' },
  });
  assert.doesNotMatch(text, /NODE_OPTIONS|SLEIGHT_CK1|SLEIGHT_FLOW_RULES|DYLD_INJECT_TEST/);
  assert.match(text, /PATH=\/usr\/bin:\/bin/);
});

for (const phase of ['spawned', 'ready']) test(`after hooks collect detached fixtures when an assertion fails (${phase})`, { timeout: 15000 }, async t => {
  const f = fixture(t), root = f.directory.replace(/\/shell$/, '');
  const child = spawn(process.execPath, [fileURLToPath(new URL('fixtures/socket-demand-failure.mjs', import.meta.url)), root, phase],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 1, output);
  assert.match(output, /intentional failure after fixture spawn/);
  const exits = JSON.parse(readFileSync(join(root, 'exits.json')));
  assert.equal(exits.length, phase === 'ready' ? 2 : 1);
  assert.ok(exits.every(exit => [0, 1].includes(exit.code) && !exit.signal));
  for (const pid of JSON.parse(readFileSync(join(root, 'pids.json')))) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  assert.equal(existsSync(join(f.directory, 'session.sock')), false);
  if (phase === 'ready') assert.equal(readFileSync(join(f.directory, 'collected'), 'utf8'), 'yes');
});
