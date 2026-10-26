import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, lstat, chmod, symlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const kit = new URL('../examples/cursor-renderer/', import.meta.url);
const sample = new URL('sample-session.jsonl', kit);
const event = (seq = 1, session = '0123456789abcdef0123456789abcdef') => ({
  v: 'sleight.cursor/1', seq, ts: 1793016000000 + seq, session,
  type: 'action', call: 'example-call', index: 0, phase: 'aim', kind: 'click',
  source: 'turbo', timing: 'confirmed', point: [420, 260],
});
async function fixture(t) {
  // Short paths fit Darwin's sockaddr_un even when the host TMPDIR is long.
  const dir = await mkdtemp('/tmp/vc6-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function modules() {
  return { ...await import(new URL('listen.mjs', kit)), ...await import(new URL('replay.mjs', kit)) };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('event deadline exceeded');
}
async function send(path, text) {
  const socket = net.createConnection(path);
  await once(socket, 'connect');
  socket.end(text);
  await once(socket, 'close');
}

test('sample replays in order into two independent listeners with private modes', async t => {
  const { createCursorListener, replayFile } = await modules();
  const dir = await fixture(t);
  const received = [[], []];
  const a = await createCursorListener({ dir, name: 'a', onEvent: e => received[0].push(e) });
  const b = await createCursorListener({ dir, name: 'b', onEvent: e => received[1].push(e) });
  t.after(() => Promise.all([a.close(), b.close()]));
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  assert.equal((await lstat(a.path)).mode & 0o777, 0o600);
  const expected = (await readFile(sample, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(expected.length, 21);
  assert.equal(expected.find(e => e.kind === 'drag').path.length, 12);
  assert.equal(expected.find(e => e.kind === 'type').count, 8);
  await replayFile({ file: sample, dir, speed: 10000 });
  await until(() => received.every(events => events.length === expected.length));
  assert.deepEqual(received, [expected, expected]);
  assert.equal(a.sessions.get(expected[0].session).state, 'end');
});

test('reader splits UTF-8 chunks, ignores extensions and warns once for other versions', async t => {
  const { createCursorListener } = await modules();
  const dir = await fixture(t), received = [], warnings = [];
  const listener = await createCursorListener({ dir, name: 'chunks', onEvent: e => received.push(e), onWarning: m => warnings.push(m) });
  t.after(() => listener.close());
  const socket = net.createConnection(listener.path);
  await once(socket, 'connect');
  const first = JSON.stringify({ ...event(), future: 'ignored', label: 'bouton é' });
  const data = Buffer.from(first + '\n' + JSON.stringify({ ...event(2), type: 'future' }) + '\n' +
    JSON.stringify({ ...event(3), v: 'sleight.cursor/2' }) + '\n' +
    JSON.stringify({ ...event(4), v: 'sleight.cursor/3' }) + '\n' + JSON.stringify(event(5)) + '\n');
  const split = data.indexOf(Buffer.from('é')) + 1;
  socket.write(data.subarray(0, split));
  await delay(10);
  socket.end(data.subarray(split));
  await once(socket, 'close');
  assert.deepEqual(received.map(e => e.seq), [1, 5]);
  assert.equal(received[0].label, 'bouton é');
  assert.equal('future' in received[0], false);
  assert.equal(warnings.length, 1);
});

test('concurrent sessions keep separate last point, phase and status', async t => {
  const { createCursorListener } = await modules();
  const listener = await createCursorListener({ dir: await fixture(t), name: 'sessions', onEvent() {} });
  t.after(() => listener.close());
  const a = event(), b = { ...event(1, 'fedcba9876543210fedcba9876543210'), point: [700, 400], phase: 'act' };
  await Promise.all([send(listener.path, JSON.stringify(a) + '\n'), send(listener.path, JSON.stringify(b) + '\n')]);
  await send(listener.path, JSON.stringify({ v: a.v, session: a.session, seq: 2, ts: a.ts + 1, type: 'status', state: 'waiting' }) + '\n');
  assert.deepEqual(listener.sessions.get(a.session).point, a.point);
  assert.equal(listener.sessions.get(a.session).phase, 'aim');
  assert.equal(listener.sessions.get(a.session).status, 'waiting');
  assert.deepEqual(listener.sessions.get(b.session).point, b.point);
  assert.equal(listener.sessions.get(b.session).phase, 'act');
});

test('malformed and oversized lines do not prevent the next valid event', async t => {
  const { createCursorListener } = await modules();
  const received = [];
  const listener = await createCursorListener({ dir: await fixture(t), name: 'bad', onEvent: e => received.push(e) });
  t.after(() => listener.close());
  await send(listener.path, 'bad json\n' + 'x'.repeat(70000) + '\n' + JSON.stringify({ ...event(), seq: -1 }) + '\n' + JSON.stringify(event(2)) + '\n');
  assert.deepEqual(received.map(e => e.seq), [2]);
});

test('discovery skips symlinks, permissive sockets and ordinary files', async t => {
  const { createCursorListener, discoverSockets, replayFile } = await modules();
  const dir = await fixture(t);
  const received = [[], []];
  const a = await createCursorListener({ dir, name: 'safe', onEvent: e => received[0].push(e) });
  const b = await createCursorListener({ dir, name: 'unsafe', onEvent: e => received[1].push(e) });
  t.after(() => Promise.all([a.close(), b.close()]));
  await chmod(b.path, 0o666);
  await symlink(a.path, join(dir, 'link.sock'));
  await writeFile(join(dir, 'file.sock'), '');
  assert.deepEqual(await discoverSockets(dir), [a.path]);
  await replayFile({ file: sample, dir, speed: 10000 });
  assert.deepEqual(received.map(events => events.length), [21, 0]);
  await chmod(dir, 0o755);
  assert.deepEqual(await discoverSockets(dir), []);
});

test('listener refuses unsafe directories, symlink directories, names and existing sockets', async t => {
  const { createCursorListener } = await modules();
  const root = await fixture(t), dir = join(root, 'unsafe');
  await mkdir(dir, { mode: 0o755 });
  await chmod(dir, 0o755);
  await assert.rejects(createCursorListener({ dir, name: 'a', onEvent() {} }), /0700/);
  await symlink(root, join(root, 'alias'));
  await assert.rejects(createCursorListener({ dir: join(root, 'alias'), name: 'a', onEvent() {} }), /directory/);
  await assert.rejects(createCursorListener({ dir: root, name: '../escape', onEvent() {} }), /name/);
  const first = await createCursorListener({ dir: root, name: 'same', onEvent() {} });
  t.after(() => first.close());
  await assert.rejects(createCursorListener({ dir: root, name: 'same', onEvent() {} }), /exist|use/i);
});

test('replay preserves timestamp gaps and scales them by speed', async t => {
  const { replayFile } = await modules();
  const dir = await fixture(t), file = join(dir, 'timed.jsonl');
  await writeFile(file, [0, 80, 200].map((ts, i) => JSON.stringify({ ...event(i + 1), ts })).join('\n') + '\n');
  const gaps = [];
  await replayFile({ file, dir, speed: 4, sleep: async ms => gaps.push(ms) });
  assert.deepEqual(gaps, [20, 30]);
  await assert.rejects(replayFile({ file, dir, speed: 0 }), /speed/);
});

test('replay preserves raw JSON spacing and tolerates dead sockets', async t => {
  const { replayFile } = await modules();
  const dir = await fixture(t), path = join(dir, 'raw.sock'), file = join(dir, 'raw.jsonl');
  let raw = '';
  const server = net.createServer(s => s.on('data', b => { raw += b; }));
  server.listen(path); await once(server, 'listening'); await chmod(path, 0o600);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const line = JSON.stringify(event(), null, 0).replaceAll(':', ': ');
  await writeFile(file, line + '\n');
  const dead = join(dir, 'dead.sock');
  const creator = spawn(process.execPath, ['--input-type=module', '-e',
    'import net from "node:net"; import { chmodSync } from "node:fs"; const p=process.argv[1]; net.createServer().listen(p, () => { chmodSync(p, 0o600); process.exit(0); });', dead]);
  assert.equal((await once(creator, 'exit'))[0], 0);
  assert.ok((await lstat(dead)).isSocket());
  await replayFile({ file, dir });
  await until(() => raw.endsWith('\n'));
  assert.equal(raw, line + '\n');
});

test('CLI removes its socket on SIGTERM and SIGINT', async t => {
  const dir = await fixture(t);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('listen.mjs', kit)), '--name', signal], {
      env: { ...process.env, SLEIGHT_CURSOR_STREAM_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let out = ''; child.stderr.on('data', b => { out += b; });
    await until(() => out.includes('Listening'));
    const client = net.createConnection(join(dir, signal + '.sock'));
    client.on('error', () => {});
    await once(client, 'connect');
    t.after(() => client.destroy());
    const disconnected = once(client, 'close');
    // This child belongs to this fixture and is controlled through ChildProcess.
    child.kill(signal);
    const [code] = await exited;
    assert.equal(code, 0);
    await disconnected;
    await assert.rejects(lstat(join(dir, signal + '.sock')), { code: 'ENOENT' });
  }
});

test('Swift overlay compiles without launching a window', { timeout: 180000 }, async t => {
  if (process.platform !== 'darwin' || spawnSync('which', ['swiftc']).status !== 0) return t.skip('macOS swiftc unavailable');
  const dir = await fixture(t);
  const child = spawn('nice', ['-n', '20', 'swiftc', '-module-cache-path', join(dir, 'cache'),
    fileURLToPath(new URL('RingOverlay.swift', kit)), '-o', join(dir, 'ring-overlay')]);
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.ok((await lstat(join(dir, 'ring-overlay'))).size > 0);
});
