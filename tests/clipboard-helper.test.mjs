import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createNativeClipboardIO, createClipboardSession, createClipboardPasteSession } from '../plugins/sleight/lib/clipboard.mjs';

function fixture(options = {}) {
  const children = [], requests = [], wire = [];
  const io = createNativeClipboardIO('unused.js', { ...options, spawnHelper: () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); };
    child.stdin.on('data', bytes => { wire.push(bytes.toString()); const request = JSON.parse(bytes.toString()); requests.push(request); options.onRequest?.(request, child); });
    child.stdin.on('finish', () => { if (!options.holdClose) queueMicrotask(() => child.emit('close', 0)); });
    child.reply = reply => child.stdout.write(JSON.stringify(reply) + '\n');
    children.push(child); return child;
  } });
  return { io, children, requests, wire };
}

test('clipboard IO starts lazily and reuses one process across reads and writes', async () => {
  const f = fixture();
  assert.equal(f.children.length, 0);
  for (const op of ['read', 'write', 'read']) {
    const pending = f.io({ op, expectedCount: 4, items: [] });
    assert.equal(f.children.length, 1);
    f.children[0].reply({ id: f.requests.at(-1).id, ok: true, count: 4, items: [] });
    assert.equal((await pending).count, 4);
  }
  await f.io.close();
  await assert.rejects(f.io({ op: 'read' }), /closed/);
});

test('paste restoration retries on a fresh helper only after timeout collection, without replaying input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 10, items = [[{ type: 'public.rtf', data: 'e1xydGYxfQ==' }]], writes = 0, sends = 0, collected = false;
  const f = fixture({ timeoutMs: 10, onRequest(request, child) {
    if (request.op === 'read') return child.reply({ id: request.id, ok: true, count, items });
    assert.equal(request.op, 'write'); assert.equal(request.expectedCount, count);
    if (++writes === 2) { count++; items = []; child.once('close', () => { collected = true; }); return; }
    if (writes === 3) assert.equal(collected, true);
    items = request.items;
    child.reply({ id: request.id, ok: true, count: ++count });
  } });
  const io = request => ['acquire', 'release'].includes(request.op) ? undefined : f.io(request);
  io.close = f.io.close;
  const session = createClipboardPasteSession(io), active = session.paste('private', async () => { sends++; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 2); assert.equal(f.children.length, 1);
  t.mock.timers.tick(10);
  assert.equal(await active, 'clipboard restored');
  assert.equal(f.children.length, 2); assert.equal(writes, 3); assert.equal(sends, 1);
  assert.deepEqual(f.requests.filter(request => request.op === 'write').at(-1).items[0].map(rep => rep.type), ['public.rtf', 'org.nspasteboard.TransientType']);
  await session.close();
});
test('every failed restore retires its helper before another write, through the fifth attempt', async () => {
  let count = 10, items = [[{ type: 'public.rtf', data: 'e1xydGYxfQ==' }]], writes = 0, sends = 0;
  const f = fixture({ onRequest(request, child) {
    if (request.op === 'read') return child.reply({ id: request.id, ok: true, count, items });
    assert.equal(request.op, 'write'); assert.equal(request.expectedCount, count);
    ++writes; ++count;
    if (writes > 1 && writes < 6) {
      items = []; return child.reply({ id: request.id, ok: false, error: 'restore failed after clear', mutated: true, count });
    }
    items = request.items; child.reply({ id: request.id, ok: true, count });
  } });
  const io = request => ['acquire', 'release'].includes(request.op) ? undefined : f.io(request);
  io.close = f.io.close; io.restart = f.io.restart;
  const session = createClipboardPasteSession(io);
  assert.equal(await session.paste('private', async () => { sends++; }), 'clipboard restored');
  assert.equal(writes, 6); assert.equal(sends, 1); assert.equal(f.children.length, 5);
  assert.equal(f.children.slice(0, -1).every(child => child.killed), true);
  assert.deepEqual(items, [[{ type: 'public.rtf', data: 'e1xydGYxfQ==' }, { type: 'org.nspasteboard.TransientType', data: '' }]]);
  await session.close();
});

test('clipboard replies correlate out of order and preserve mutation recovery metadata', async () => {
  const f = fixture();
  const a = f.io({ op: 'read' }), b = f.io({ op: 'write' });
  const failure = assert.rejects(b, e => e.clipboardCount === 9 && e.clipboardMutation === true);
  f.children[0].reply({ id: f.requests[1].id, ok: false, error: 'verification failed', count: 9, mutated: true });
  f.children[0].reply({ id: f.requests[0].id, ok: true, count: 8, items: [] });
  assert.equal((await a).count, 8); await failure;
  await f.io.close();
});

test('an exited helper rejects pending writes without replay and starts fresh only for a new request', async () => {
  const f = fixture();
  const failed = assert.rejects(f.io({ op: 'write' }), /helper.*closed/);
  f.children[0].emit('close', 1);
  await failed;
  assert.equal(f.requests.length, 1);
  const next = f.io({ op: 'read' });
  assert.equal(f.children.length, 2);
  f.children[1].reply({ id: f.requests.at(-1).id, ok: true, count: 10 });
  await next; await f.io.close();
});

test('a timed out helper refuses new work until its process is collected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ timeoutMs: 10, holdClose: true });
  const first = f.io({ op: 'write' });
  let settled = false;
  first.then(() => { settled = true; }, () => { settled = true; });
  f.children[0].kill = () => { f.children[0].killed = true; };
  const failure = assert.rejects(first, /timed out/);
  t.mock.timers.tick(10); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the failed write must retain its reservation until collection');
  await assert.rejects(f.io({ op: 'read' }), /stopping/);
  assert.equal(f.children.length, 1); assert.equal(f.requests.length, 1);
  const closing = f.io.close();
  f.children[0].emit('close', null, 'SIGTERM'); await closing; await failure;
});
test('a paste request deadline replaces the default helper wait and stays off the native wire', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ timeoutMs: 10000 }), pending = f.io({ op: 'read', timeoutMs: 40 });
  const failure = assert.rejects(pending, error => error.clipboardTimeout === true);
  assert.equal(Object.hasOwn(f.requests[0], 'timeoutMs'), false);
  t.mock.timers.tick(39); assert.notEqual(f.children[0].killed, true);
  t.mock.timers.tick(1); await failure;
  assert.equal(f.children[0].killed, true); await f.io.close();
});
test('shutdown can bound clipboard helper collection and force only that owned child', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ holdClose: true }), pending = f.io({ op: 'read' });
  f.children[0].reply({ id: f.requests[0].id, ok: true, count: 4 }); await pending;
  const signals = [];
  f.children[0].kill = signal => { signals.push(signal ?? 'SIGTERM'); if (signal === 'SIGKILL') f.children[0].emit('close', null, signal); };
  const closing = f.io.close({ timeoutMs: 20 });
  try {
    t.mock.timers.tick(20); assert.deepEqual(signals, ['SIGTERM']);
    t.mock.timers.tick(500); await closing;
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  } finally { f.children[0].emit('close', null, 'SIGTERM'); await closing; }
});

test('a failed clipboard transaction releases only after the helper process closes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ timeoutMs: 10, holdClose: true }), calls = [];
  const io = request => {
    if (['acquire', 'release'].includes(request.op)) { calls.push(request.op); return; }
    return f.io(request);
  };
  io.close = f.io.close;
  const session = createClipboardSession(io);
  const active = session.run('c', () => { calls.push('input'); return 'native fallback'; });
  await new Promise(resolve => setImmediate(resolve));
  f.children[0].kill = () => {};
  t.mock.timers.tick(10);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['acquire']);
  f.children[0].emit('close', null, 'SIGTERM');
  await active;
  assert.deepEqual(calls, ['acquire', 'input', 'release']);
  await session.close();
});

test('invalid helper JSON fails pending work instead of waiting or exposing clipboard bytes', async () => {
  const f = fixture();
  const failure = assert.rejects(f.io({ op: 'read' }), /invalid reply/);
  f.children[0].stdout.write('private bytes\n');
  await failure; await f.io.close();
});

test('an output stream failure retains pending work until helper collection', async () => {
  const f = fixture({ holdClose: true }), pending = f.io({ op: 'write' });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const failure = assert.rejects(pending, /helper output failed/);
  f.children[0].kill = () => {};
  try {
    assert.doesNotThrow(() => f.children[0].stdout.emit('error', new Error('private stream details')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(f.io({ op: 'read' }), /stopping/);
  } finally { f.children[0].emit('close', 1); await f.io.close(); await failure; }
});

test('clipboard requests use ASCII framing without changing Unicode type names', async () => {
  const f = fixture(), items = [[{ type: 'org.example.한글.é.😀', data: 'AA==' }]];
  const pending = f.io({ op: 'write', expectedCount: 3, items });
  assert.match(f.wire[0], /^[\x00-\x7f]+$/);
  assert.deepEqual(f.requests[0].items, items);
  f.children[0].reply({ id: f.requests[0].id, ok: true, count: 4 });
  await pending; await f.io.close();
});

test('fragmented and coalesced helper replies retain complete JSON frames', async () => {
  const f = fixture(), a = f.io({ op: 'read' }), b = f.io({ op: 'read' });
  const first = JSON.stringify({ id: f.requests[0].id, ok: true, count: 3, items: [] });
  const second = JSON.stringify({ id: f.requests[1].id, ok: true, count: 4, items: [] });
  f.children[0].stdout.write(first.slice(0, 8));
  f.children[0].stdout.write(first.slice(8) + '\n' + second + '\n');
  assert.deepEqual((await Promise.all([a, b])).map(r => r.count), [3, 4]);
  await f.io.close();
});

test('a 40 MiB clipboard reply in 64 KiB chunks stays near one-shot collection time', async t => {
  const payloadBytes = 40 * 1024 * 1024;
  const data = Buffer.alloc(payloadBytes, 0xa5).toString('base64');
  const text = JSON.stringify({ id: 0, ok: true, count: 3, items: [[{ type: 'public.png', data }]] }) + '\n';
  const chunks = [];
  for (let at = 0; at < text.length; at += 64 * 1024) chunks.push(text.slice(at, at + 64 * 1024));
  // execFile collected chunks and parsed once at EOF before the persistent helper.
  const startOnce = performance.now();
  let bytes = 0;
  const collected = [];
  for (const chunk of chunks) { bytes += Buffer.byteLength(chunk); collected.push(chunk); }
  assert.ok(bytes < 96 * 1024 * 1024);
  assert.equal(JSON.parse(collected.join('')).items[0][0].data, data);
  const oneShotMs = performance.now() - startOnce;
  const f = fixture(), pending = f.io({ op: 'read' });
  let streamedMs;
  try {
    const start = performance.now();
    for (const chunk of chunks) f.children[0].stdout.write(chunk);
    assert.equal((await pending).items[0][0].data, data);
    streamedMs = performance.now() - start;
  } finally { await f.io.close(); }
  t.diagnostic(JSON.stringify({ payloadBytes, wireBytes: bytes, chunkBytes: 65536, oneShotMs, streamedMs }));
  assert.ok(streamedMs < 10000, 'reply assembly must fit the helper deadline');
  assert.ok(streamedMs < Math.max(1000, oneShotMs * 6), `streamed ${streamedMs} ms vs one-shot ${oneShotMs} ms`);
});

test('an unterminated reply still refuses above the 96 MiB transport limit', async () => {
  const f = fixture(), failure = assert.rejects(f.io({ op: 'read' }), /reply too large/);
  const chunk = 'A'.repeat(3 * 1024 * 1024);
  for (let i = 0; i < 33; i++) f.children[0].stdout.write(chunk);
  await failure; await f.io.close();
});

function paddedReply(id, bytes) {
  const head = `{"id":${id},"ok":true,"count":3,"padding":"`;
  return head + 'A'.repeat(bytes - head.length - 3) + '"}\n';
}

test('reply size includes the delimiter and accepts exactly 96 MiB', async () => {
  for (const extra of [0, 1]) {
    const f = fixture(), pending = f.io({ op: 'read' });
    const result = extra ? assert.rejects(pending, /reply too large/) : pending.then(reply => assert.equal(reply.count, 3));
    f.children[0].stdout.emit('data', paddedReply(0, 96 * 1024 * 1024 + extra));
    await result; await f.io.close();
  }
});

test('coalesced replies reset the bound for each frame even when the chunk exceeds it', async () => {
  const f = fixture(), pending = Promise.all([f.io({ op: 'read' }), f.io({ op: 'read' })]);
  try {
    f.children[0].stdout.emit('data', paddedReply(0, 49 * 1024 * 1024) + paddedReply(1, 49 * 1024 * 1024));
    assert.deepEqual((await pending).map(reply => reply.count), [3, 3]);
  } finally { await f.io.close(); }
});

test('a complete reply resolves before an oversized partial frame stops the helper', async () => {
  const f = fixture(), first = f.io({ op: 'read' });
  const failure = assert.rejects(f.io({ op: 'read' }), /reply too large/);
  try {
    f.children[0].stdout.emit('data', paddedReply(0, 80) + 'A'.repeat(96 * 1024 * 1024 + 1));
    assert.equal((await first).count, 3); await failure;
  } finally { await f.io.close(); }
});

for (const reply of [{ id: 99, ok: true }, { id: 0, ok: 'yes' }]) {
  test(`invalid helper envelope ${JSON.stringify(reply)} fences pending work`, async () => {
    const f = fixture(), failure = assert.rejects(f.io({ op: 'write' }), /invalid reply/);
    f.children[0].reply(reply);
    await failure;
    assert.equal(f.requests.length, 1, 'a rejected write must not be replayed');
    await f.io.close();
  });
}

test('closing a clipboard session collects its IO after the active transaction releases', async () => {
  const calls = [];
  let finish;
  const io = async request => { calls.push(request.op); };
  io.close = async () => calls.push('close');
  const session = createClipboardSession(io);
  const active = session.run('paste', () => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const closing = session.close();
  assert.deepEqual(calls, ['acquire']);
  finish('done'); await active; await closing;
  assert.deepEqual(calls, ['acquire', 'release', 'close']);
});
