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
  assert.equal(expected.length, 24);
  assert.ok(expected.some(e => e.window?.exposure === 'exposed' && e.display?.scale === 2 && e.label === 'button'));
  assert.ok(expected.some(e => e.phase === 'declined'));
  assert.ok(expected.some(e => e.type === 'status' && e.state === 'idle'));
  assert.deepEqual(expected.map(e => e.seq), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(expected.find(e => e.kind === 'drag').path.length, 12);
  assert.equal(expected.find(e => e.kind === 'type').count, 8);
  await replayFile({ file: sample, dir, speed: 10000 });
  await until(() => received.every(events => events.length === expected.length));
  assert.deepEqual(received, [expected, expected]);
  assert.equal(a.sessions.size, 0);
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
  const sockets = [net.createConnection(listener.path), net.createConnection(listener.path)];
  t.after(() => sockets.forEach(s => s.destroy()));
  await Promise.all(sockets.map(s => once(s, 'connect')));
  sockets[0].write(JSON.stringify(a) + '\n'); sockets[1].write(JSON.stringify(b) + '\n');
  await until(() => listener.sessions.size === 2);
  sockets[0].write(JSON.stringify({ v: a.v, session: a.session, seq: 2, ts: a.ts + 1, type: 'status', state: 'waiting' }) + '\n');
  await until(() => listener.sessions.get(a.session)?.status === 'waiting');
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
  for (const mode of [0o700, 0o1600]) {
    await chmod(b.path, mode);
    assert.deepEqual(await discoverSockets(dir), [a.path]);
  }
  await replayFile({ file: sample, dir, speed: 10000 });
  assert.deepEqual(received.map(events => events.length), [24, 0]);
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

test('CLI removes its socket on SIGTERM, SIGINT and SIGHUP through a symlink entry', async t => {
  const dir = await fixture(t);
  const entry = join(dir, 'listen-link.mjs');
  await symlink(fileURLToPath(new URL('listen.mjs', kit)), entry);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const child = spawn(process.execPath, [entry, '--name', signal], {
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

test('Swift overlay typechecks without launching a window', { timeout: 180000 }, async t => {
  if (process.platform !== 'darwin' || spawnSync('xcode-select', ['-p']).status !== 0) return t.skip('macOS developer tools unavailable');
  const dir = await fixture(t);
  const child = spawn('nice', ['-n', '20', 'swiftc', '-module-cache-path', join(dir, 'cache'),
    '-typecheck', fileURLToPath(new URL('RingOverlay.swift', kit))]);
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
});

test('Swift overlay keeps the passive panel safety properties', async () => {
  const source = await readFile(new URL('RingOverlay.swift', kit), 'utf8');
  for (const property of ['canBecomeKey: Bool { false }', 'canBecomeMain: Bool { false }',
    '.nonactivatingPanel', 'ignoresMouseEvents = true', 'sharingType = .none', '.canJoinAllSpaces',
    'setActivationPolicy(.accessory)']) assert.ok(source.includes(property), property);
  assert.doesNotMatch(source, /makeKey|\bactivate\s*\(|orderFrontRegardless/);
});

test('listener bounds sessions, hides drags across a call and prunes terminal states', async t => {
  const { createCursorListener } = await modules();
  const views = [], removed = [];
  const listener = await createCursorListener({ dir: await fixture(t), name: 'lifetime',
    onEvent: (e, v) => views.push({ seq: e.seq, visible: v.visible }), onRemove: s => removed.push(s) });
  t.after(() => listener.close());
  const socket = net.createConnection(listener.path);
  t.after(() => socket.destroy()); await once(socket, 'connect');
  let seq = 0;
  const emit = async patch => {
    socket.write(JSON.stringify({ ...event(++seq), ...patch }) + '\n');
    await until(() => views.at(-1)?.seq === seq);
    return views.at(-1).visible;
  };
  assert.equal(await emit({}), true);
  assert.equal(await emit({ kind: 'drag', call: 'drag-1' }), false);
  assert.equal(await emit({ call: 'other', point: [500, 300] }), false);
  assert.equal(await emit({ kind: 'drag', call: 'drag-1', phase: 'act' }), false);
  assert.equal(await emit({ kind: 'drag', call: 'drag-1', phase: 'done' }), false);
  assert.equal(await emit({}), true);
  assert.equal(await emit({ kind: 'drag', call: 'drag-2', phase: 'act' }), false);
  assert.equal(await emit({ kind: 'drag', call: 'drag-2', phase: 'failed' }), false);
  assert.equal(await emit({}), true);
  assert.equal(await emit({ kind: 'drag', call: 'drag-3' }), false);
  assert.equal(await emit({ kind: 'drag', call: 'drag-3', phase: 'declined' }), false);
  assert.equal(await emit({}), true);
  for (const state of ['done', 'handback', 'idle', 'error']) {
    await emit({ type: 'status', state });
    assert.equal(listener.sessions.size, 0);
    await emit({});
  }
  await emit({ type: 'session', state: 'end' });
  assert.equal(listener.sessions.size, 0);
  for (let i = 1; i <= 5; i++) await emit({ session: i.toString(16).padStart(32, '0') });
  assert.equal(listener.sessions.size, 4);
  assert.equal(listener.sessions.has('1'.padStart(32, '0')), false);
  assert.ok(removed.includes('1'.padStart(32, '0')));
  socket.end(); await once(socket, 'close');
  await until(() => listener.sessions.size === 0);
});

test('listener expires silent sessions after three seconds using receipt time', { timeout: 7000 }, async t => {
  const { createCursorListener } = await modules();
  const listener = await createCursorListener({ dir: await fixture(t), name: 'ttl' });
  t.after(() => listener.close());
  const socket = net.createConnection(listener.path);
  t.after(() => socket.destroy()); await once(socket, 'connect');
  socket.write(JSON.stringify({ ...event(), ts: 1e15 }) + '\n');
  await until(() => listener.sessions.size === 1);
  await delay(3200);
  assert.equal(listener.sessions.size, 0);
});

test('throwing renderer callbacks warn and allow later events and cleanup', async t => {
  const { createCursorListener } = await modules();
  const seen = [], warnings = [];
  const listener = await createCursorListener({ dir: await fixture(t), name: 'throw',
    onEvent(e) { seen.push(e.seq); if (e.seq === 1) throw new Error('draw failed'); }, onWarning: m => warnings.push(m) });
  t.after(() => listener.close());
  await send(listener.path, [event(), event(2)].map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(seen, [1, 2]);
  assert.equal(warnings.length, 1);
  await listener.close();
  await assert.rejects(lstat(listener.path), { code: 'ENOENT' });
});

test('discovery rejects a symlink directory and foreign socket owners', async t => {
  const { createCursorListener, discoverSockets } = await modules();
  const dir = await fixture(t), alias = dir + '-link';
  await symlink(dir, alias); t.after(() => rm(alias));
  const listener = await createCursorListener({ dir, name: 'owned' }); t.after(() => listener.close());
  assert.deepEqual(await discoverSockets(alias), []);
  const getuid = process.getuid;
  // The directory passes its uid check, then the socket has a different owner.
  let calls = 0;
  t.mock.method(process, 'getuid', () => getuid() + (calls++ === 0 ? 0 : 1));
  assert.deepEqual(await discoverSockets(dir), []);
  t.mock.restoreAll();
});

test('listener recovers a refused stale socket but refuses a foreign-mode one', async t => {
  const { createCursorListener } = await modules();
  const dir = await fixture(t), path = join(dir, 'stale.sock');
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import net from "node:net"; import { chmodSync } from "node:fs"; net.createServer().listen(process.argv[1], () => { chmodSync(process.argv[1], 0o600); process.exit(0); });', path]);
  assert.equal((await once(child, 'exit'))[0], 0);
  await chmod(path, 0o700);
  await assert.rejects(createCursorListener({ dir, name: 'stale' }), /0600/);
  await chmod(path, 0o600);
  const listener = await createCursorListener({ dir, name: 'stale' });
  await listener.close();
});

test('replay times out a write to a renderer that never reads', { timeout: 10000 }, async t => {
  const { replayFile } = await modules();
  const dir = await fixture(t), path = join(dir, 'stalled.sock'), file = join(dir, 'large.jsonl');
  const clients = [];
  const server = net.createServer(s => { clients.push(s); s.pause(); });
  server.listen(path); await once(server, 'listening'); await chmod(path, 0o600);
  t.after(async () => { clients.forEach(s => s.destroy()); await new Promise(r => server.close(r)); });
  await writeFile(file, JSON.stringify({ ...event(), future: 'x'.repeat(4 * 1024 * 1024) }) + '\n');
  const start = performance.now();
  const result = await replayFile({ file, dir });
  const elapsed = performance.now() - start;
  assert.equal(result.renderers, 1);
  assert.ok(elapsed >= 900 && elapsed < 8000, `write deadline: ${elapsed} ms`);
});

test('reader rejects invalid UTF-8 and accepts exactly 65536 bytes before a newline', async t => {
  const { createCursorListener } = await modules();
  const seen = [];
  const listener = await createCursorListener({ dir: await fixture(t), name: 'bytes', onEvent: e => seen.push(e.seq) });
  t.after(() => listener.close());
  const base = JSON.stringify({ ...event(), label: '' });
  const exact = JSON.stringify({ ...event(), label: 'x'.repeat(65536 - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(exact), 65536);
  const bad = Buffer.concat([Buffer.from(base.slice(0, -2)), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const socket = net.createConnection(listener.path); await once(socket, 'connect');
  socket.end(Buffer.concat([bad, Buffer.from(exact + '\n' + exact.replace('"seq":1', '"seq":2') + ' \n' + JSON.stringify(event(3)) + '\n')]));
  await once(socket, 'close');
  assert.deepEqual(seen, [1, 3]);
});

test('replay strips unknown fields while preserving validated window, display and rect data', async t => {
  const { createCursorListener, replayFile, parseEvent } = await modules();
  const dir = await fixture(t), file = join(dir, 'extensions.jsonl'), received = [];
  const input = { ...event(), rect: [1, 2, 30, 40], future: true,
    window: { id: 1, pid: 2, app: 'Example', bundle: 'org.example.synthetic', rect: [0, 0, 800, 600], exposure: 'exposed', title: 'ignored' },
    display: { id: 3, scale: 2, future: true } };
  const listener = await createCursorListener({ dir, name: 'fields', onEvent: e => received.push(e) });
  t.after(() => listener.close());
  await writeFile(file, JSON.stringify(input) + '\n');
  await replayFile({ file, dir });
  assert.equal(received.length, 1);
  const expected = { ...input }; delete expected.future;
  expected.window = { ...input.window }; delete expected.window.title;
  expected.display = { id: 3, scale: 2 };
  assert.deepEqual(received[0], expected);
  assert.deepEqual(parseEvent(JSON.stringify({ ...event(), point: [0, 0] })).point, [0, 0]);
  for (const patch of [
    { seq: true }, { seq: 1.5 }, { seq: 9007199254740992 }, { seq: 0 }, { ts: true },
    { session: 'ABCDEF0123456789ABCDEF0123456789' }, { type: 'session', state: 'future' },
    { type: 'status', state: 'future' }, { kind: false }, { phase: 'future' }, { call: 1 },
    { point: [true, 0] }, { point: [1] }, { path: Array(65).fill([1, 2]) }, { path: [[1, false]] },
    { rect: [1, 2, -1, 4] }, { rect: 'bad' }, { window: [] }, { window: { pid: true } },
    { window: { app: 1 } }, { window: { rect: [0, 0, 3] } }, { window: { exposure: 'future' } },
    { display: null }, { display: { id: 1.5 } }, { display: { scale: 0 } }, { display: { scale: true } },
    { label: false }, { count: -1 }, { index: 0.5 },
  ]) assert.equal(parseEvent(JSON.stringify({ ...event(), ...patch })), undefined, JSON.stringify(patch));
});

test('closing one shared-session connection retains the other view until it disconnects', async t => {
  const { createCursorListener } = await modules();
  const removed = [], seen = [];
  const listener = await createCursorListener({ dir: await fixture(t), name: 'shared', onEvent: e => seen.push(e.seq), onRemove: s => removed.push(s) });
  t.after(() => listener.close());
  const a = net.createConnection(listener.path), b = net.createConnection(listener.path);
  t.after(() => { a.destroy(); b.destroy(); });
  await Promise.all([once(a, 'connect'), once(b, 'connect')]);
  a.write(JSON.stringify(event()) + '\n'); b.write(JSON.stringify(event(2)) + '\n');
  await until(() => seen.length === 2);
  a.end(); await once(a, 'close');
  assert.equal(listener.sessions.size, 1); assert.equal(removed.length, 0);
  b.end(); await once(b, 'close'); await until(() => listener.sessions.size === 0);
  assert.deepEqual(removed, [event().session]);
});

test('listener caps connections at sixteen without blocking admitted clients', async t => {
  const { createCursorListener } = await modules();
  const listener = await createCursorListener({ dir: await fixture(t), name: 'connections' });
  t.after(() => listener.close());
  const clients = [];
  t.after(() => clients.forEach(s => s.destroy()));
  for (let i = 0; i < 16; i++) {
    const s = net.createConnection(listener.path); clients.push(s); await once(s, 'connect');
  }
  const extra = net.createConnection(listener.path); clients.push(extra);
  extra.on('error', () => {});
  await once(extra, 'close');
  clients[0].write(JSON.stringify(event()) + '\n');
  await until(() => listener.sessions.size === 1);
});

test('Swift source bounds readers, queued lines and sessions with local TTLs', async () => {
  const source = await readFile(new URL('RingOverlay.swift', kit), 'utf8');
  for (const property of ['DispatchQueue(label: "cursor.serial-reader"', 'O_NONBLOCK', 'connectionCount < 16',
    'lines.count == 128', 'lines.removeFirst()', 'sessions.count == 4', 'remove(order[0])',
    'DispatchSource.makeTimerSource(queue: .main)', '.now() + 3', 'SIGINT, SIGTERM, SIGHUP',
    'errno == EADDRINUSE', 'errno == ECONNREFUSED', '0o7777 == 0o600',
    'CFGetTypeID(number) != CFBooleanGetTypeID()', 'number.rounded() == number',
    'location.y <= $0.frame.maxY', '"done", "handback", "idle", "error"',
    '"done", "failed", "declined"', '"aim", "act"', 'view.panel?.orderOut(nil)',
    'view.owners.isEmpty', 'safeInteger(e["seq"])', 'e["kind"] is String',
    'coordinates(r, count: 4)', 'array.count <= 64', 'window["exposure"]', 'display["scale"]']) {
    assert.ok(source.includes(property), property);
  }
  assert.doesNotMatch(source, /DispatchQueue\.global|asyncAfter/);
});

test('terminal events for unknown sessions preserve four active sessions', async t => {
  const { createCursorListener } = await modules();
  const seen = [], listener = await createCursorListener({ dir: await fixture(t), name: 'unknown-end', onEvent: e => seen.push(e.seq) });
  t.after(() => listener.close());
  const socket = net.createConnection(listener.path); t.after(() => socket.destroy()); await once(socket, 'connect');
  const active = Array.from({ length: 4 }, (_, i) => event(i + 1, i.toString(16).padStart(32, '0')));
  socket.write([...active, { ...event(5), type: 'status', state: 'done' }].map(JSON.stringify).join('\n') + '\n');
  await until(() => seen.length === 5);
  assert.deepEqual([...listener.sessions.keys()], active.map(e => e.session));
});

test('hidden rings stay hidden across pointless events and status updates', async t => {
  const { createCursorListener } = await modules();
  const seen = [], listener = await createCursorListener({ dir: await fixture(t), name: 'hidden', onEvent: (e, v) => seen.push(v.visible) });
  t.after(() => listener.close());
  await send(listener.path, [event(), { ...event(2), phase: 'skipped', point: undefined },
    { ...event(3), type: 'status', state: 'thinking', point: undefined },
    { ...event(4), point: undefined }, event(5)].map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(seen, [true, false, false, false, true]);
});

test('replay CLI runs through a realpath symlink entry', async t => {
  const dir = await fixture(t), entry = join(dir, 'replay-link.mjs');
  await symlink(fileURLToPath(new URL('replay.mjs', kit)), entry);
  const child = spawn(process.execPath, [entry, fileURLToPath(sample), '--speed', '10000'], {
    env: { ...process.env, SLEIGHT_CURSOR_STREAM_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  assert.equal((await once(child, 'exit'))[0], 0);
  assert.match(stderr, /Replayed 24 events to 0 renderers/);
});

test('CLI cleans its socket after an uncaught error and exits unsuccessfully', async t => {
  const dir = await fixture(t), preload = join(dir, 'crash.mjs');
  await writeFile(preload, `const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (...args) => {
  const result = write(...args);
  if (String(args[0]).startsWith('Listening:')) setImmediate(() => { throw new Error('fixture crash'); });
  return result;
};\n`);
  const child = spawn(process.execPath, ['--import', preload, fileURLToPath(new URL('listen.mjs', kit)), '--name', 'crash'], {
    env: { ...process.env, SLEIGHT_CURSOR_STREAM_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  assert.equal((await once(child, 'exit'))[0], 1);
  assert.match(stderr, /fixture crash/);
  await assert.rejects(lstat(join(dir, 'crash.sock')), { code: 'ENOENT' });
});
