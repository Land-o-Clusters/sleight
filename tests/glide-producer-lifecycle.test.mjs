import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileSwiftHelper } from '../bench/swift-cache.mjs';
import { MOD_META } from './fixtures/mod-attribution.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const variant = process.env.GP2_VARIANT;
const runtimeURL = new URL('../plugins/sleight/lib/runtime-select.mjs', import.meta.url).href;
const clientURL = new URL('../plugins/sleight/lib/hand/client.mjs', import.meta.url).href;
const driverURL = new URL('../plugins/sleight/lib/driver-client.mjs', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  let source = loaded.source?.toString();
  if (source === undefined) return loaded;
  if (url === runtimeURL && variant === 'producer-default-on') {
    assert.ok(source.includes('privateGeometryProducer = false'));
    source = source.replace('privateGeometryProducer = false', 'privateGeometryProducer = true');
  }
  if (url === runtimeURL && variant === 'restart-keeps-old-turn') {
    assert.equal(source.split('runtimeHand.endTurn();').length, 2);
    source = source.replace('runtimeHand.endTurn();', '');
  }
  if (url === new URL('../plugins/sleight/lib/relay.mjs', import.meta.url).href && variant === 'stop-entry-drops-revoke') {
    const site = 'revokeStageProducer(); // person-stop-entry';
    assert.equal(source.split(site).length, 2, 'one person-stop entry mutation site');
    source = source.replace(site, '/* person-stop-entry omitted */');
  }
  if (url === new URL('../plugins/sleight/lib/relay.mjs', import.meta.url).href && variant === 'stop-reentry-drops-revoke') {
    const site = 'revokeStageProducer(); // person-stop-reentry';
    assert.equal(source.split(site).length, 2, 'one closing re-entry mutation site');
    source = source.replace(site, '/* person-stop-reentry omitted */');
  }
  if (url === new URL('../plugins/sleight/lib/relay.mjs', import.meta.url).href && variant === 'glide-reentry-drops-revoke') {
    const site = 'revokeStageProducer(); // person-stop-glide-reentry';
    assert.equal(source.split(site).length, 2, 'one Glide re-entry mutation site');
    source = source.replace(site, '/* person-stop-glide-reentry omitted */');
  }
  if (url === new URL('../plugins/sleight/lib/relay.mjs', import.meta.url).href && variant === 'revoke-throw-untraced') {
    const site = "catch (error) { trace('stage-revoke-error', { error: error?.message }); }";
    assert.equal(source.split(site).length, 2, 'one revoke trace mutation site');
    source = source.replace(site, 'catch {}');
  }
  if (url === new URL('../plugins/sleight/lib/relay.mjs', import.meta.url).href && variant === 'unattributed-handoff-terminal') {
    const site = "if (stageProducerEnabled && state === 'handback') return;";
    assert.equal(source.split(site).length, 2);
    source = source.replace(site, '');
  }
  if (url === new URL('../plugins/sleight/lib/relay.mjs', import.meta.url).href && variant === 'person-stop-releases-producer') {
    const site = 'if (stageProducerEnabled && !attributed) { retainedCursorTurn = true; return; }';
    assert.ok(source.includes(site)); source = source.replace(site, '');
  }
  if (url === clientURL && variant === 'end-window-wedges') {
    assert.ok(source.includes("geometry.active && (!geometry.ending || geometry.poisoned && wire.hand === 'status')"));
    source = source.replace("geometry.active && (!geometry.ending || geometry.poisoned && wire.hand === 'status')", 'geometry.active');
  }
  if (url === new URL('../plugins/sleight/lib/mac-driver/action-events.mjs', import.meta.url).href) {
    const site = '      const wire = {\n        identity(id)';
    assert.equal(source.split(site).length, 2, 'one action-wire counter instrumentation site');
    source = source.replace(site, '      const wire = {\n        get pendingCount() { return pending.size; },\n        identity(id)');
  }
  if (url === driverURL && variant === 'register-before-checks') {
    const from = '    try { if (!operation?.cleanup) g.actionWire?.begin(id, method, params); } catch {}';
    assert.ok(source.includes(from)); source = source.replace(from, '');
    source = source.replace('    let line;\n    try { line = JSON.stringify({ protocol,', from +
      "\n    if (method === 'click') g.geometryWire?.begin(id);\n    let line;\n    try { line = JSON.stringify({ protocol,");
  }
  return source === loaded.source ? loaded : { ...loaded, source };
} });
const { createRelay } = await import('../plugins/sleight/lib/relay.mjs');
const { createMacDriverClient } = await import('../plugins/sleight/lib/mac-driver/client.mjs');
const { createRuntimeActionEvents } = await import('../plugins/sleight/lib/mac-driver/action-events.mjs');
const { createGlideGeometryWire, privateGlideObservation } = await import('../plugins/sleight/lib/mac-driver/geometry.mjs');
const { createRuntimeHand } = await import('../plugins/sleight/lib/hand/runtime-hand.mjs');
const { privateHandGeometry } = await import('../plugins/sleight/lib/hand/client.mjs');
const { DRIVER_CORE_METHODS } = await import('../plugins/sleight/lib/mac-driver/protocol.mjs');
const { InputLease } = await import('../plugins/sleight/lib/input-lease.mjs');
const { harness, base, row, call, bounds, settle } = await import('./fixtures/glide-hand.mjs');
const { runOwnRuntime } = await import('../plugins/sleight/lib/runtime-select.mjs');
const { createHandClient, shareConsent } = await import(clientURL);
const { createMacDriverClient: checkedDriver } = await import(new URL('../plugins/sleight/lib/mac-driver/client.mjs', import.meta.url).href);
hooks.deregister();

const flush = async () => { for (let i = 0; i < 12; i++) await settle(); };
const writeObservation = (stream, turn, request, patch = {}) => stream.write(JSON.stringify({
  ...base(), ...patch, protocol: 'sleight.glide-geometry/1', nonce: 'f'.repeat(64), turn, request,
}) + '\n');

function relayFixture(t, { attributedHost = true, engineResult = () => ({ content: [] }), ...options } = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  serverIn.on('data', bytes => {
    for (const q of bytes.toString().trim().split('\n').map(JSON.parse)) if (q.id !== undefined)
      setImmediate(() => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: engineResult(q) }) + '\n'));
  });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, modHost: () => attributedHost,
    changeReview: false, idleTurnEndMs: 0, ...options });
  t.after(() => relay.dispose());
  let id = 0;
  const end = (meta, args = { hook_event_name: 'Stop' }) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: ++id,
    method: 'tools/call', params: { name: 'turn_ended', arguments: args, ...meta ? { _meta: meta } : {} } }) + '\n');
  return { relay, end, input: clientIn };
}

test('only a mod-attributed end or person prompt closes the producer turn', async t => {
  for (const attributedHost of [false, true]) {
    const h = await harness(t); h.act();
    let ends = 0;
    const r = relayFixture(t, { attributedHost, stageProducerEnabled: true,
      onStageTurnEnd() { ends++; h.wire.end(); h.hand.endTurn(); },
      cursor: { enabled: true, call: () => call, close() {}, status(state, detail) { if (state === 'done') h.client.send({ hand: 'status', state, pid: 42, windowId: 7, ok: !!detail?.call }); } },
    });
    r.end(); await flush();
    assert.equal(ends, 0); assert.equal(privateHandGeometry(h.client).state.active, true);
    if (privateHandGeometry(h.client).state.pending) h.ack();
    await r.relay.endOpenTurn(); assert.equal(ends, 0);
    r.end(MOD_META); await flush();
    assert.equal(ends, attributedHost ? 1 : 0);
    if (attributedHost) {
      const next = h.wire.begin(4); h.ack();
      writeObservation(h.stream, next, 4, { read: 2 }); h.ack();
      r.end(MOD_META, { sleight_person_prompt: 'composer' }); await flush();
      assert.equal(ends, 2); assert.equal(h.frames().filter(f => f.op === 'end').length, 2, JSON.stringify({ state: privateHandGeometry(h.client).state, frames: h.frames() }));
    } else assert.equal(h.frames().filter(f => f.op === 'end').length, 0, 'bare host retains protection');
  }
});

test('a bare handoff status cannot become a producer terminal', async t => {
  const h = await harness(t); h.act();
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-producer-handoff-')));
  const inputLease = new InputLease({ directory, holder: 'producer fixture' });
  let cards = 0;
  const r = relayFixture(t, { attributedHost: false, stageProducerEnabled: true, inputLease,
    engineResult: () => ({ content: [{ type: 'text', text: 'Window: "Login", App: Reader\n0 standard window Login' }],
      _meta: { 'codex/toolSurface': { app: { appId: 'com.example.Reader' } } } }),
    remoteApprovals: { presence: async () => ({ locked: true, idleSeconds: 0 }) },
    handoffUi: async () => ({ authenticate: () => false, dismiss() {}, close() {}, present() { cards++; } }),
    cursor: { enabled: true, call: () => call, close() {}, status(state, detail) {
      if (['done', 'handback'].includes(state)) h.client.send({ hand: 'status', state, pid: 42, windowId: 7, ok: !!detail?.call });
    } },
  });
  t.after(() => { inputLease.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = r.input;
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js',
    arguments: { code: 'var app = await cua.getApp("com.example.Reader")' } } }) + '\n');
  await flush();
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'app_handoff', arguments: {} } }) + '\n');
  await flush();
  assert.equal(cards, 1, 'the synthetic native handoff route ran');
  assert.equal(h.frames().some(f => f.op === 'public' && f.frame.state === 'handback'), false);
});

for (const reason of ['earlier-turn-reuse', 'read-cap', 'unknown-request', 'late-ended-line', 'lost-original']) {
  test(`benign ${reason} refuses one observation and keeps the next complete map eligible`, async t => {
    const h = await harness(t);
    h.wire.begin(3);
    if (reason === 'read-cap') {
      for (let i = 2; i <= 129; i++) {
        const before = h.frames().length;
        h.send(3, { read: i }); if (h.frames().length > before) h.ack();
      }
      assert.equal(h.wire.state.reads, 128);
      assert.equal(privateHandGeometry(h.client).state.poisoned, false);
      h.wire.end(); h.ack(); h.wire.begin(3); h.ack();
    } else if (reason === 'late-ended-line' || reason === 'earlier-turn-reuse') {
      const old = h.wire.end(); h.ack(); const next = h.wire.begin(5); h.ack();
      if (reason === 'late-ended-line') writeObservation(h.stream, old, 3, { read: 99 });
      else writeObservation(h.stream, next, 5, { reused: true });
    } else if (reason === 'unknown-request') h.send(999, { read: 99 });
    else h.send(3, { read: 99, reused: true });
    assert.equal(h.wire.state.poisoned, false);
    const turn = h.wire.state.turn;
    const count = h.certificates().length;
    // At capacity an original interval is still reusable. Other cases accept
    // a fresh map, including a new turn after an earlier-turn read reuse.
    const request = ['earlier-turn-reuse', 'late-ended-line'].includes(reason) ? 5 : 3;
    writeObservation(h.stream, turn, request, { read: 130, acquired: [30, 31] });
    assert.equal(h.certificates().length, count + 1);
  });
}

test('a protocol fault poisons only its current turn', async t => {
  const h = await harness(t); h.act();
  h.stream.write('{invalid}\n'); assert.equal(h.wire.state.poisoned, true);
  const before = h.certificates().length;
  h.send(2, { read: 2, references: [row()] }); assert.equal(h.certificates().length, before);
  h.wire.end(); h.hand.endTurn(); h.ack();
  const turn = h.wire.begin(4); h.ack();
  writeObservation(h.stream, turn, 4, { read: 3 });
  assert.equal(h.certificates().length, before + 1); assert.equal(h.wire.state.poisoned, false);
});

test('a driver restart retains the old hand until the next attributed boundary, then baselines afresh', async t => {
  const h = await harness(t); h.act(); h.wire.close();
  const stream = new PassThrough(), wire = createGlideGeometryWire({ nonce: 'f'.repeat(64), stream, publish: h.hand.geometry });
  const refused = wire.begin(4);
  assert.equal(h.frames().filter(f => f.op === 'begin').length, 1, 'replacement cannot supersede protected turn');
  const r = relayFixture(t, { stageProducerEnabled: true, onStageTurnEnd() { wire.end(); h.hand.endTurn(); } });
  r.end(MOD_META); await flush(); h.ack();
  const turn = wire.begin(5); assert.notEqual(turn, refused); h.ack();
  writeObservation(stream, turn, 5, { read: 2 });
  assert.equal(h.frames().filter(f => f.op === 'begin').length, 2);
  assert.equal(h.certificates().at(-1).geometry.mode, 'baseline'); h.ack();
  h.hand({ type: 'action', phase: 'act', geometryTurn: h.turn, call, index: 0, kind: 'click', point: [25, 40], window: { pid: 42, id: 7 } });
  assert.equal(privateHandGeometry(h.client).state.poisoned, true, 'late targets poison collection and remain protected');
  assert.equal(h.child.lines.at(-1).hand, 'act'); assert.deepEqual(h.child.lines.at(-1).at, [25, 40]);
});

async function fakeClient(t) {
  const child = new EventEmitter(); child.pid = 12345; child.lines = [];
  child.stdin = new EventEmitter(); child.stdin.writableLength = 0;
  child.stdin.write = line => { child.lines.push(...line.trim().split('\n').map(JSON.parse)); return true; };
  child.stdin.end = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  child.stdout = new EventEmitter(); child.stdio = [child.stdin, child.stdout, null, new PassThrough(), new PassThrough()];
  const client = createHandClient({ setting: () => ({ enabled: true, style: 'ring' }), watch: () => {}, permissions: null, usage: null,
    built: () => true, prepare: async () => ({ status: 'ready', spawn: () => child }) });
  t.after(() => client.close()); await shareConsent(); await settle();
  return { client, child };
}

async function inertRuntime(t, client, options = {}) {
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const owner = await runOwnRuntime({ input, output, signals: new EventEmitter(),
    driver: { async close() {} }, lease: { close() {}, release() {} },
    policy: () => ({ allow: true }), permissions: { app() {}, page() {}, sitesLimited: () => false },
    allowForbidden: () => false, ownHostPid: () => false,
    approvalStorage: { load: () => ({}), live: () => ({ list: () => [], allows: () => false }) }, grantAudit() {},
    ...options, relayOptions: { idleTurnEndMs: 0, runtimeHandClient: client },
  });
  t.after(() => owner.close());
  return { owner, input };
}

test('an explicit private producer option attaches collection and no other value enables it', async t => {
  for (const privateGeometryProducer of [false, 'true', true]) {
    const h = await fakeClient(t), { owner } = await inertRuntime(t, h.client, { privateGeometryProducer });
    assert.equal(owner.runtime.actionEvents.geometryEnabled, privateGeometryProducer === true);
    if (privateGeometryProducer === true) {
      owner.runtime.actionEvents.geometryWire({ nonce: 'f'.repeat(64), stream: new PassThrough() }).begin(1);
      assert.equal(h.child.lines.at(-1).op, 'begin');
    }
  }
});

test('default Glide turn sends exactly the recorded pre-producer base frames', async t => {
  const h = await fakeClient(t), { owner, input } = await inertRuntime(t, h.client);
  const events = owner.runtime.actionEvents, stream = new PassThrough();
  if (events.geometryEnabled) events.geometryWire({ nonce: 'f'.repeat(64), stream: new PassThrough() }).begin(1);
  const wire = events.wire({ nonce: 'f'.repeat(64), stream });
  const start = h.child.lines.length;
  await events.run('click', { args: [1] }, { cell: 1 }, async () => {
    wire.begin(2, 'click', { args: [1] });
    for (const phase of ['act', 'failed']) stream.write(JSON.stringify({ protocol: 'sleight.runtime-action/1', nonce: 'f'.repeat(64), id: 2,
      phase, kind: 'click', point: [25, 40], rect: [10, 20, 30, 40], window: { pid: 42, id: 7, rect: bounds } }) + '\n');
    return {};
  });
  await flush();
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Stop' } } }) + '\n');
  await flush();
  const frames = h.child.lines.slice(start).map(({ nonce, ...frame }) => frame);
  if (process.env.GP2_RECORD_FRAMES) writeFileSync(process.env.GP2_RECORD_FRAMES, JSON.stringify(frames, null, 2) + '\n');
  else assert.deepEqual(frames, JSON.parse(readFileSync(new URL('./fixtures/glide-default-frames.json', import.meta.url))), 'ordinary host frames match base');
  assert.ok(frames.length > 0, 'recorded turn includes real hand traffic');
  assert.equal(events.geometryEnabled ?? false, false, 'only explicit parent option may attach the producer');
});

test('failed sends leave zero entries in both wires and metadata does not open a geometry turn', async t => {
  const feed = createRuntimeActionEvents(), geometries = [], actionWires = []; feed.connect(() => {}); feed.connectGeometry(() => {});
  const actionWire = feed.wire.bind(feed), geometryWire = feed.geometryWire.bind(feed);
  feed.wire = options => { const wire = actionWire(options); actionWires.push(wire); return wire; };
  feed.geometryWire = options => { const wire = geometryWire(options); geometries.push(wire); return wire; };
  let child;
  const driver = checkedDriver({ platform: 'darwin', actionEvents: feed, lineLimit: 1024, prepare: async () => ({ status: 'ready', spawn() {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const q = JSON.parse(bytes); done(); if (q.control) return;
      queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce: q.nonce, id: q.id, ok: true,
        result: q.method === 'ping' ? { protocol: 'sleight.driver/1', apiVersion: 2, build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, 'click'] } : {} }) + '\n'));
    } });
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
    child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true; }; return child;
  } }) });
  t.after(async () => { await driver.close(); feed.close(); });
  await driver.ping(); assert.equal(geometries[0].state.requests, 0);
  for (const [params, code] of [[{ args: [{ toJSON() { throw Error('fixture serialization'); } }] }, 'INVALID_PARAMS'],
    [{ args: ['x'.repeat(2000)] }, 'DRIVER_LINE_LIMIT']]) {
    await assert.rejects(driver.request('click', params), { code });
    assert.equal(actionWires[0].pendingCount, 0); assert.equal(geometries[0].state.requests, 0);
  }
  Object.defineProperty(child.stdin, 'writableLength', { configurable: true, value: 1025 });
  await assert.rejects(driver.request('click', {}), { code: 'DRIVER_BUSY' });
  assert.equal(actionWires[0].pendingCount, 0); assert.equal(geometries[0].state.requests, 0);
  Object.defineProperty(child.stdin, 'writableLength', { configurable: true, value: 0 });
  driver.endGeometryTurn(); await driver.ping(); assert.equal(geometries[0].state.turn, undefined);
});

test('the real driver client restarts mid-turn and the runtime boundary closes its stranded hand', async t => {
  const h = await fakeClient(t), feed = createRuntimeActionEvents(), children = [];
  const hand = createRuntimeHand({ client: h.client, producer: true });
  feed.connect(hand); feed.connectGeometry(hand.geometry);
  let read = 0;
  const driver = createMacDriverClient({ platform: 'darwin', actionEvents: feed, prepare: async () => ({ status: 'ready', spawn() {
    const child = new EventEmitter(); children.push(child);
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const q = JSON.parse(bytes); done(); if (q.control) return;
      queueMicrotask(() => {
        if (q.method === 'getAXState') child.stdio[4].write(JSON.stringify({ ...base(), read: ++read,
          protocol: 'sleight.glide-geometry/1', nonce: q.nonce, turn: q.geometryTurn, request: q.id }) + '\n');
        child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce: q.nonce, id: q.id, ok: true,
          result: q.method === 'ping' ? { protocol: 'sleight.driver/1', apiVersion: 2, build: 'b'.repeat(64), methods: DRIVER_CORE_METHODS } : {} }) + '\n');
      });
    } });
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
    child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true; }; return child;
  } }) });
  const frames = () => h.child.lines.filter(f => f.hand === 'stage-producer');
  const ack = () => { const f = frames().at(-1); h.child.stdout.emit('data', JSON.stringify({ hand: 'stage-producer-ack',
    nonce: f.nonce, session: f.session, turn: f.turn, seq: f.seq, op: f.op, accepted: true }) + '\n'); };
  t.after(async () => { await driver.close(); feed.close(); });
  // Begin is synchronous before the child sees the request. A real host would
  // ack it independently; the fake child deliberately loses that first map.
  await driver.request('getAXState', {}); ack();
  await driver.request('getAXState', {}); ack();
  assert.equal(frames().filter(f => f.op === 'certificate').length, 1);
  hand({ type: 'action', phase: 'act', geometryTurn: frames()[0].turn, call, index: 0, kind: 'click',
    point: [25, 40], rect: [10, 20, 30, 40], window: { pid: 42, id: 7, rect: bounds } }); ack();
  assert.equal(privateHandGeometry(h.client).state.admitted.length, 1);
  await driver.restart(); ack();
  await driver.request('getAXState', {});
  assert.equal(children.length, 2); assert.equal(frames().filter(f => f.op === 'begin').length, 1);
  const r = relayFixture(t, { stageProducerEnabled: true, onStageTurnEnd() { driver.endGeometryTurn(); hand.endTurn(); } });
  r.end(MOD_META); await flush(); ack();
  await driver.request('getAXState', {}); ack();
  await driver.request('getAXState', {}); ack();
  assert.equal(frames().filter(f => f.op === 'begin').length, 2);
  assert.equal(frames().filter(f => f.op === 'certificate').length, 2);
  assert.equal(frames().filter(f => f.op === 'certificate').at(-1).geometry.mode, 'baseline');
});

test('runOwnRuntime wires the attributed boundary to the hand left by an older driver generation', async t => {
  const h = await fakeClient(t); let wire;
  const { owner, input } = await inertRuntime(t, h.client, { privateGeometryProducer: true,
    driver: { async close() {}, endGeometryTurn() { wire.end(); } } });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { clientInfo: { name: 'claude-code', version: '1' }, capabilities: {} } }) + '\n');
  await flush();
  const frames = () => h.child.lines.filter(f => f.hand === 'stage-producer');
  const ack = () => { const f = frames().at(-1); h.child.stdout.emit('data', JSON.stringify({ hand: 'stage-producer-ack',
    nonce: f.nonce, session: f.session, turn: f.turn, seq: f.seq, op: f.op, accepted: true }) + '\n'); };
  const stream = new PassThrough();
  const old = owner.runtime.actionEvents.geometryWire({ nonce: 'f'.repeat(64), stream });
  const oldTurn = old.begin(1); ack(); writeObservation(stream, oldTurn, 1); ack();
  old.close(); ack();
  const replacement = new PassThrough();
  wire = owner.runtime.actionEvents.geometryWire({ nonce: 'f'.repeat(64), stream: replacement });
  wire.begin(2);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'turn_ended',
    arguments: { hook_event_name: 'Stop' }, _meta: MOD_META } }) + '\n');
  await flush(); ack();
  const next = wire.begin(3); ack(); writeObservation(replacement, next, 3, { read: 2 }); ack();
  assert.equal(frames().filter(f => f.op === 'begin').length, 2);
  assert.equal(frames().filter(f => f.op === 'certificate').length, 2);
  assert.equal(frames().filter(f => f.op === 'certificate').at(-1).geometry.mode, 'baseline');
});

let nativeHost;
async function reader(t) {
  if (nativeHost) return nativeHost;
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-glide-reader-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'host.swift');
  let source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  if (variant === 'end-window-wedges') {
    const site = 'if producer.endedIdentities.contains(';
    assert.equal(source.split(site).length, 2, 'one ended-session adoption mutation site');
    source = source.replace(site, 'if false && producer.endedIdentities.contains(');
  }
  writeFileSync(input, source);
  nativeHost = await compileSwiftHelper(input, { timeoutMs: 900000 }); return nativeHost;
}

test('relay end then handback/done/idle before ack permits the next begin on the real stdin host',
  { skip: process.platform !== 'darwin' }, async t => {
    const binary = await reader(t);
    const fixtureRoot = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-glide-character-')));
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
    const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false,
      hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
    const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait',
      'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
    const character = join(fixtureRoot, 'character.json');
    writeFileSync(character, JSON.stringify({ hand: 'character', nonce: 'a'.repeat(64), seq: 1, id: 'fixture',
      sheet: join(fixtureRoot, 'sheet.png'), extra: null, cell: [192, 208],
      table: { idle: { ...entry, frames: 2 } }, perch: { anchor: [96, 150], table: Object.fromEntries(states.map(state => [state, entry])) }, size: 'stage' }));
    for (const failed of [false, true]) {
      const h = await harness(t, { native: true }); h.act(); if (failed) h.stream.write('{invalid}\n');
      const r = relayFixture(t, { stageProducerEnabled: true, onStageTurnEnd() { h.wire.end(); h.hand.endTurn(); },
        cursor: { enabled: true, call: () => call, close() {}, status(state, detail) {
          // idle has no host status representation in the existing client.
          if (state === 'done') h.client.send({ hand: 'status', state, pid: 42, windowId: 7, ok: !!detail?.call });
        } },
      });
      r.end(MOD_META); await flush();
      assert.equal(h.frames().some(f => f.op === 'public' && f.frame.state === 'handback'), failed, 'failed end uses the public terminal fallback');
      const oldEnd = h.frames().at(-1);
      h.wire.begin(8); // Deliberately no terminal ack before the next begin.
      assert.equal(h.frames().at(-1).op, 'begin');
      const frames = h.child.lines.filter(f => ['stage-producer', 'status', 'aim', 'act', 'hide'].includes(f.hand));
      const run = spawnSync(binary, ['--stage-producer-reader-dump', character], { input: frames.map(JSON.stringify).join('\n') + '\n',
        encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 1048576 });
      assert.equal(run.status, 0, run.stderr);
      const rows = run.stdout.trim().split('\n').map(JSON.parse);
      assert.ok(rows.filter(row => row.op !== 'fault').every(row => row.accepted), JSON.stringify(rows));
      assert.equal(rows.filter(row => row.op === 'fault' && !row.accepted).length, failed ? 1 : 0);
      assert.ok(rows.every(row => row.windows === 0 && row.layers === 0));
      assert.equal(rows.at(-1).op, 'begin');
      h.ack();
      h.child.stdout.emit('data', JSON.stringify({ ...oldEnd, hand: 'stage-producer-ack', accepted: true }) + '\n');
      t.diagnostic(`failedEnd=${failed} frames=${frames.length} hostRows=${rows.length} hostAccepted=${rows.filter(row => row.accepted).length}`);
    }
  });


test('person Stop invalidates the producer turn synchronously and retains it until an attributed boundary', async t => {
  const h = await harness(t); h.act();
  let personStop, boundaries = 0, stops = 0; const terminals = [];
  const channel = privateHandGeometry(h.client), protectedBefore = channel.state.admitted;
  const stamp = performance.now(), ticket = channel.capture({ start: stamp, end: stamp });
  assert.ok(ticket);
  const r = relayFixture(t, { nativeMac: true, stageProducerEnabled: true,
    nativeSession: { setStopHandler(handler) { personStop = handler; }, stop() {}, cancelPending() {}, endTurn() {}, setPolicy() {} },
    onStageTurnStop() { stops++; return h.hand.stopTurn(); },
    stopEngine: async () => ({ collected: true }), onStageTurnEnd() { boundaries++; h.hand.endTurn(); },
    cursor: { enabled: true, call: () => call, close() {}, status(state) { if (['done', 'idle'].includes(state)) terminals.push(state); } },
  });
  assert.equal(typeof personStop, 'function');
  const before = r.relay.turnId; personStop();
  assert.equal(stops, 1, 'the host Stop revokes observations before asynchronous collection');
  assert.equal(h.frames().at(-1).op, 'invalidate');
  assert.equal(h.frames().at(-1).reason, 'ambient');
  assert.deepEqual(channel.state.admitted, protectedBefore);
  await flush();
  assert.notEqual(r.relay.turnId, before, 'person Stop still rotates normal relay state');
  assert.equal(boundaries, 0, 'collection is not an attributed visual turn boundary');
  assert.deepEqual(terminals, [], 'producer-only Stop retains targets');
  assert.equal(privateHandGeometry(h.client).state.active, true);
  assert.equal(h.frames().filter(row => row.op === 'end').length, 0);
  h.ack();
  const invalidates = () => h.frames().filter(frame => frame.op === 'invalidate').length;
  assert.equal(invalidates(), 1);
  personStop();
  assert.equal(invalidates(), 1, 'a second Glide Stop is idempotent and adds no terminal');
  assert.equal(h.frames().filter(frame => frame.op === 'end').length, 0);
  assert.deepEqual(channel.state.admitted, protectedBefore);
  const count = h.certificates().length;
  h.wire.begin(3); h.send(3, { read: 2, references: [row()] });
  assert.equal(h.certificates().length, count, 'late complete reads cannot recover a stopped turn');
  assert.equal(channel.certify(ticket, { pid: 42, windowId: 7, incarnation: 'd'.repeat(32),
    contentGeneration: 0, mode: 'layout', bounds, references: protectedBefore.map(r => ({ seq: r.seq, departed: false, rects: [[10, 20, 30, 40]] })) }), false);
  assert.deepEqual(channel.state.admitted, protectedBefore);
  r.end(MOD_META, { sleight_person_prompt: 'composer' }); await flush();
  assert.equal(boundaries, 1, 'the next attributed boundary closes the retained producer');
  h.ack();
  assert.equal(channel.state.active, false);
  h.wire.end();
  const nextTurn = h.wire.begin(4); h.ack();
  assert.notEqual(nextTurn, h.turn);
  writeObservation(h.stream, nextTurn, 4, { read: 3 });
  assert.equal(h.certificates().length, count + 1, 'a new attributed turn can collect a fresh baseline');
});

async function retainedStop(t, { attributedHost = true, holdStop = false } = {}) {
  const h = await harness(t); h.act();
  const channel = privateHandGeometry(h.client);
  const protectedBefore = channel.state.admitted.map(row => ({ ...row }));
  let stops = 0, boundaries = 0, turnBefore = '', releaseStop = () => {};
  const held = new Promise(resolve => { releaseStop = resolve; });
  const terminals = [];
  const seen = [];
  let glideStop = () => {};
  const r = relayFixture(t, { nativeMac: true, attributedHost, stageProducerEnabled: true,
    nativeSession: { setStopHandler(handler) { glideStop = handler; }, stop() {}, cancelPending() {}, endTurn() {}, setPolicy() {} },
    onStageTurnStop() {
      stops++;
      const result = h.hand.stopTurn();
      assert.equal(typeof result?.then, 'undefined', 'Stop adds no input await');
      return result;
    },
    stopEngine: async () => {
      seen.push(h.frames().at(-1)?.op === 'invalidate' && r.relay.turnId === turnBefore);
      if (holdStop) await held;
      return { collected: true };
    },
    onStageTurnEnd() { boundaries++; h.hand.endTurn(); },
    cursor: { enabled: true, call: () => call, close() {}, status(state) { if (['done', 'idle'].includes(state)) terminals.push(state); } },
  });
  const send = args => { turnBefore = r.relay.turnId; r.end(MOD_META, args); };
  return { h, r, channel, protectedBefore, send, terminals, seen, releaseStop, glideStop: () => glideStop(),
    stops: () => stops, boundaries: () => boundaries };
}

async function assertRetainedStop(entry, second, label) {
  const { h, r, channel, protectedBefore, send, terminals, seen } = entry;
  const invalidates = () => h.frames().filter(frame => frame.op === 'invalidate').length;
  send(second);
  await flush();
  assert.equal(entry.stops(), 1, label);
  assert.equal(h.frames().at(-1).op, 'invalidate', label);
  assert.equal(invalidates(), 1);
  assert.deepEqual(channel.state.admitted, protectedBefore);
  assert.deepEqual(seen, [true], 'the revoke finishes before engine collection and turn rotation');
  assert.equal(entry.boundaries(), 0, 'Stop is not the releasing boundary');
  assert.deepEqual(terminals, [], 'Stop sends no terminal');
  assert.equal(channel.state.active, true);
  assert.equal(h.frames().filter(frame => frame.op === 'end').length, 0);
  assert.deepEqual(channel.state.admitted, protectedBefore, 'the target bank stays');
  send(second);
  await flush();
  assert.equal(entry.stops(), 2, 'a second Stop still revokes');
  assert.equal(invalidates(), 1, 'a second Stop is idempotent');
  assert.equal(h.frames().filter(frame => frame.op === 'end').length, 0);
  assert.equal(entry.boundaries(), 0);
  r.end(MOD_META, { sleight_person_prompt: 'composer' }); await flush();
  assert.equal(entry.boundaries(), 1, 'the next attributed prompt releases the retained producer');
}

test('mod-attributed sleight_stop revokes the producer and keeps every target', async t => {
  await assertRetainedStop(await retainedStop(t), { hook_event_name: 'Interrupt', sleight_stop: true },
    'mod-attributed sleight_stop must invalidate the producer');
});

test('mod-attributed Interrupt revokes the producer and keeps every target', async t => {
  await assertRetainedStop(await retainedStop(t), { hook_event_name: 'Interrupt' },
    'mod-attributed Interrupt must invalidate the producer');
});

test('a native non-mod Interrupt revokes through stopEngine', async t => {
  // The leased Codex drain below is defensive. This runtime sets stopEngine, so Interrupt enters interruptTurn.
  const entry = await retainedStop(t, { attributedHost: false });
  entry.send({ hook_event_name: 'Interrupt' });
  await flush();
  assert.equal(entry.stops(), 1, 'native Interrupt uses interruptTurn, not the leased drain');
  assert.equal(entry.h.frames().at(-1).op, 'invalidate');
  assert.equal(entry.h.frames().at(-1).reason, 'ambient');
  assert.deepEqual(entry.channel.state.admitted, entry.protectedBefore);
  assert.equal(entry.channel.state.active, true);
  assert.equal(entry.boundaries(), 0);
  assert.equal(entry.h.frames().filter(frame => frame.op === 'end').length, 0);
  entry.send({ hook_event_name: 'Interrupt' });
  await flush();
  assert.equal(entry.stops(), 2, 'a second native Interrupt still revokes');
  assert.equal(entry.h.frames().filter(frame => frame.op === 'invalidate').length, 1);
});

test('a second Stop while closing revokes again', async t => {
  let release = () => {};
  t.after(() => release());
  const entry = await retainedStop(t, { holdStop: true });
  release = entry.releaseStop;
  entry.send({ hook_event_name: 'Interrupt', sleight_stop: true });
  await flush();
  assert.equal(entry.stops(), 1);
  entry.send({ hook_event_name: 'Interrupt', sleight_stop: true });
  await flush();
  assert.equal(entry.stops(), 2, 'closing re-entry revokes');
  entry.releaseStop();
  await flush();
});

test('a Glide Stop while closing revokes again', async t => {
  let release = () => {};
  t.after(() => release());
  const entry = await retainedStop(t, { holdStop: true });
  release = entry.releaseStop;
  entry.glideStop();
  await flush();
  assert.equal(entry.stops(), 1);
  entry.glideStop();
  await flush();
  assert.equal(entry.stops(), 2, 'Glide re-entry revokes');
  entry.releaseStop();
  await flush();
});

test('a throwing revoke callback is traced and the Stop continues', async t => {
  const h = await harness(t); h.act();
  const traced = [];
  const r = relayFixture(t, { nativeMac: true, stageProducerEnabled: true,
    nativeSession: { setStopHandler() {}, stop() {}, cancelPending() {}, endTurn() {}, setPolicy() {} },
    onStageTurnStop() { throw new Error('revoke blew up'); },
    stopEngine: async () => ({ collected: true }),
    trace(direction, msg) { traced.push([direction, msg]); },
    cursor: { enabled: true, call: () => call, close() {}, status() {} },
  });
  const before = r.relay.turnId;
  r.end(MOD_META, { hook_event_name: 'Interrupt', sleight_stop: true });
  await flush();
  const rows = traced.filter(([direction]) => direction === 'stage-revoke-error');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1].error, 'revoke blew up');
  assert.notEqual(r.relay.turnId, before, 'the Stop continues after the revoke throw');
});

test('a Codex Interrupt during a leased call revokes the producer and keeps every target', async t => {
  const h = await harness(t); h.act();
  const channel = privateHandGeometry(h.client);
  const protectedBefore = channel.state.admitted.map(row => ({ ...row }));
  let stops = 0, boundaries = 0;
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-stop-drain-')));
  const inputLease = new InputLease({ directory, holder: 'stop drain fixture' });
  t.after(() => { inputLease.close(); rmSync(directory, { recursive: true, force: true }); });
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const forwarded = [];
  serverIn.on('data', bytes => forwarded.push(bytes.toString()));
  clientOut.resume(); serverOut.resume();
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, modHost: () => false, changeReview: false,
    idleTurnEndMs: 0, stopGraceMs: 20, inputLease, stageProducerEnabled: true,
    onStageTurnStop() {
      stops++;
      const result = h.hand.stopTurn();
      assert.equal(typeof result?.then, 'undefined', 'Stop adds no input await');
      return result;
    },
    onStageTurnEnd() { boundaries++; h.hand.endTurn(); },
    cursor: { enabled: true, call: () => call, close() {}, status() {} },
  });
  t.after(() => relay.dispose());
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js',
    arguments: { code: 'var app = await cua.getApp("com.example.Reader")' } } }) + '\n');
  await flush();
  assert.ok(forwarded.length > 0, 'the leased call is still in flight');
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'turn_ended',
    arguments: { hook_event_name: 'Interrupt' } } }) + '\n');
  await flush();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(stops, 1, 'the drain Interrupt entry revokes the producer');
  assert.equal(h.frames().at(-1).op, 'invalidate');
  assert.deepEqual(channel.state.admitted, protectedBefore);
  assert.equal(channel.state.active, true);
  assert.equal(boundaries, 0);
  assert.equal(h.frames().filter(frame => frame.op === 'end').length, 0);
});

test('runtime-select Stop path revokes the producer through its own callback', async t => {
  const h = await fakeClient(t);
  const { owner, input } = await inertRuntime(t, h.client, { privateGeometryProducer: true,
    driver: { async close() {}, async restart() {}, async stopHeld() {}, userPrompt() { return false; } } });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { clientInfo: { name: 'claude-code', version: '1' }, capabilities: {} } }) + '\n');
  await flush();
  const frames = () => h.child.lines.filter(frame => frame.hand === 'stage-producer');
  const ack = () => {
    const frame = frames().at(-1);
    h.child.stdout.emit('data', JSON.stringify({ hand: 'stage-producer-ack', nonce: frame.nonce, session: frame.session,
      turn: frame.turn, seq: frame.seq, op: frame.op, accepted: true }) + '\n');
  };
  owner.runtime.actionEvents.geometryWire({ nonce: 'f'.repeat(64), stream: new PassThrough() }).begin(1);
  ack();
  const channel = privateHandGeometry(h.client);
  const admitted = channel.admit({ kind: 'click', pid: 42, windowId: 7, at: [25, 40], path: [[25, 40]],
    delayMs: 0, beats: 1, windowRect: bounds }, { call, action: 1, attempt: 1, ordinal: 1 });
  assert.notEqual(admitted, false, 'the runtime turn can protect a target');
  ack();
  const protectedBefore = channel.state.admitted.map(row => ({ ...row }));
  assert.equal(protectedBefore.length, 1);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'turn_ended',
    arguments: { hook_event_name: 'Interrupt', sleight_stop: true }, _meta: MOD_META } }) + '\n');
  await flush();
  assert.equal(frames().at(-1).op, 'invalidate', 'runtime-select Stop revokes the producer');
  assert.equal(frames().at(-1).reason, 'ambient');
  assert.deepEqual(channel.state.admitted, protectedBefore);
  assert.equal(channel.state.active, true);
  assert.equal(frames().filter(frame => frame.op === 'end').length, 0);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'turn_ended',
    arguments: { hook_event_name: 'Interrupt', sleight_stop: true }, _meta: MOD_META } }) + '\n');
  await flush();
  assert.equal(frames().filter(frame => frame.op === 'invalidate').length, 1, 'a second runtime Stop is idempotent');
  assert.equal(frames().filter(frame => frame.op === 'end').length, 0);
  assert.deepEqual(channel.state.admitted, protectedBefore);
});

if (!variant) test('dropping the interrupt Stop revoke fails the mod-attributed sleight_stop wiring', { timeout: 900000 }, t => {
  const env = { ...process.env, GP2_VARIANT: 'stop-entry-drops-revoke' };
  delete env.NODE_TEST_CONTEXT;
  env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lane-claude-'));
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=900000', '--test-name-pattern=^mod-attributed sleight_stop',
    new URL(import.meta.url).pathname], {
    env, encoding: 'utf8', timeout: 900000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /AssertionError|ERR_ASSERTION/);
  assert.match(result.stdout + result.stderr, /must invalidate the producer/, result.stdout + result.stderr);
  t.diagnostic(`variant=stop-entry-drops-revoke exit=${result.status}`);
});

if (!variant) test('dropping the closing re-entry revoke fails the held Stop', { timeout: 900000 }, t => {
  const env = { ...process.env, GP2_VARIANT: 'stop-reentry-drops-revoke' };
  delete env.NODE_TEST_CONTEXT;
  env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lane-claude-'));
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=900000', '--test-name-pattern=^a second Stop while closing',
    new URL(import.meta.url).pathname], {
    env, encoding: 'utf8', timeout: 900000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /AssertionError|ERR_ASSERTION/);
  assert.match(result.stdout + result.stderr, /closing re-entry revokes/, result.stdout + result.stderr);
  t.diagnostic(`variant=stop-reentry-drops-revoke exit=${result.status}`);
});

if (!variant) test('dropping the Glide re-entry revoke fails the held Glide Stop', { timeout: 900000 }, t => {
  const env = { ...process.env, GP2_VARIANT: 'glide-reentry-drops-revoke' };
  delete env.NODE_TEST_CONTEXT;
  env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lane-claude-'));
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=900000', '--test-name-pattern=^a Glide Stop while closing',
    new URL(import.meta.url).pathname], {
    env, encoding: 'utf8', timeout: 900000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /AssertionError|ERR_ASSERTION/);
  assert.match(result.stdout + result.stderr, /Glide re-entry revokes/, result.stdout + result.stderr);
  t.diagnostic(`variant=glide-reentry-drops-revoke exit=${result.status}`);
});

if (!variant) test('dropping the revoke trace hides a thrown callback', { timeout: 900000 }, t => {
  const env = { ...process.env, GP2_VARIANT: 'revoke-throw-untraced' };
  delete env.NODE_TEST_CONTEXT;
  env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lane-claude-'));
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=900000', '--test-name-pattern=^a throwing revoke callback',
    new URL(import.meta.url).pathname], {
    env, encoding: 'utf8', timeout: 900000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /AssertionError|ERR_ASSERTION/);
  t.diagnostic(`variant=revoke-throw-untraced exit=${result.status}`);
});
