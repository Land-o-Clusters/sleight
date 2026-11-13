import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handHarness, browserHandModule, sourceURL, replaceSite } from './fixtures/browser-geometry.mjs';
import { createCursorEvents } from '../plugins/sleight/lib/hand/events.mjs';
import { beginBrowserLayout, recordBrowserLayout, finishBrowserLayout } from '../plugins/sleight/lib/direct-browser/geometry-observation.mjs';
const { createBrowserGeometryProducer, createBrowserHand } = await browserHandModule();

function fixture(layout = { beginBrowserLayout, recordBrowserLayout, finishBrowserLayout }, workerOffset = 0) {
  const page = new EventEmitter(), frame = {}, target = { delegate: { _targetId: 'target' } }, frameImpl = { _id: 'frame', _page: target };
  const connection = { toImpl: value => value === page ? target : value === frame ? frameImpl : null };
  page._connection = connection; frame._connection = connection;
  page.frames = () => [frame]; page.mainFrame = () => frame;
  const source = capture => ({ capture, connection, target, frameId: 'frame', document: 1, pid: 42, windowId: 7,
    processStart: 'process-1', bounds: [100, 100, 900, 900], viewport: [0, 0, 800, 700], origin: [100, 200],
    scale: 1, pageZoom: 1, visualZoom: 1, deviceScale: 2, continuous: true });
  let raw;
  const acquire = (reuse = false, batch = layout.beginBrowserLayout(page)) => {
    const start = performance.now() + workerOffset;
    const capture = reuse ? raw : (raw = { strings: ['frame', '#document'], documents: [{ frameId: 0, scrollOffsetX: 0, scrollOffsetY: 0,
      nodes: { nodeType: [9], parentIndex: [-1], backendNodeId: [1], nodeName: [1], nodeValue: [-1], attributes: [[]] },
      layout: { nodeIndex: [0], bounds: [[0, 0, 800, 700]] } }] });
    layout.recordBrowserLayout(batch, frame, capture, start, performance.now() + workerOffset);
    return layout.finishBrowserLayout(batch);
  };
  return { page, source, acquire, begin: () => layout.beginBrowserLayout(page), complete: batch => acquire(false, batch) };
}

test('browser producer consumes an existing capture through the real GP1 channel without public frames', async t => {
  const h = await handHarness(t), f = fixture(), producer = await createBrowserGeometryProducer({ client: h.client, windowEvidence: f.source });
  t.after(() => producer.close());
  assert.ok(producer.beginTurn('c'.repeat(32))); h.ack();
  assert.ok(producer.watch(f.page)); await producer.acquire(f.page, f.acquire);
  const certificate = h.frames().find(row => row.op === 'certificate');
  assert.equal(certificate.geometry.mode, 'baseline'); assert.deepEqual(certificate.geometry.references, []);
  assert.deepEqual(certificate.acquired.length, 2); h.ack();
  await producer.acquire(f.page, f.acquire); h.ack();
  assert.equal(h.frames().filter(row => row.op === 'certificate').at(-1).geometry.contentGeneration, 0,
    'an unchanged native semantic capture does not advance content generation');
  assert.ok(producer.endTurn()); h.ack(); assert.equal(producer.state.references, 0);
});

test('missing transform, async evidence, and late work after end produce no certificates', async t => {
  for (const source of [() => undefined, async () => ({})]) {
    const h = await handHarness(t), f = fixture(), producer = await createBrowserGeometryProducer({ client: h.client, windowEvidence: source });
    t.after(() => producer.close());
    producer.beginTurn('c'.repeat(32)); h.ack(); producer.watch(f.page); await producer.acquire(f.page, f.acquire);
    assert.equal(h.frames().filter(row => row.op === 'certificate').length, 0);
    assert.ok(producer.endTurn()); h.ack(); await producer.acquire(f.page, f.acquire);
    assert.equal(h.frames().filter(row => row.op === 'certificate').length, 0);
  }
});

test('an unresolved admitted reference never disappears to make a map complete', async t => {
  const h = await handHarness(t), f = fixture(), producer = await createBrowserGeometryProducer({ client: h.client, windowEvidence: f.source });
  t.after(() => producer.close());
  producer.beginTurn('c'.repeat(32)); h.ack(); producer.watch(f.page); await producer.acquire(f.page, f.acquire); h.ack();
  const seq = producer.admit({ kind: 'click', pid: 42, windowId: 7, at: [150, 250] },
    { call: 'd'.repeat(32), action: 1, attempt: 1, ordinal: 1 }, { page: f.page }); h.ack();
  producer.inputFinished(seq); await producer.acquire(f.page, f.acquire);
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1);
  assert.equal(producer.state.references, 1); assert.equal(h.channel.state.admitted.length, 1);
});

test('adapter state and subscriptions reset between clean logical turns and poison is turn-local', async () => {
  const channel = { state: { pending: 0, admitted: [], after: -1 },
    beginTurn(turn) { this.state.turn = turn; this.state.poisoned = false; return 1; },
    endTurn() { this.state.turn = undefined; this.state.poisoned = false; return 2; } };
  const producer = await createBrowserGeometryProducer({ channel }), f = fixture();
  assert.ok(producer.beginTurn('c'.repeat(32))); assert.ok(producer.watch(f.page));
  channel.state.poisoned = true; assert.equal(producer.watch(f.page), false);
  assert.ok(producer.endTurn());
  assert.equal(producer.state.turn, undefined);
  assert.ok(producer.beginTurn('d'.repeat(32))); assert.ok(producer.watch(f.page));
  producer.close(); assert.equal(producer.watch(f.page), false);
});

test('a second adapter cannot replace the current page observer', async t => {
  const h = await handHarness(t), f = fixture();
  const first = await createBrowserGeometryProducer({ client: h.client }), second = await createBrowserGeometryProducer({ client: h.client });
  t.after(() => { first.close(); second.close(); });
  first.beginTurn('c'.repeat(32)); h.ack(); assert.ok(first.watch(f.page));
  // The same parent turn can only have one owner; do not create a second begin.
  assert.equal(second.watch(f.page), false);
  assert.equal(await first.hold(f.page, {}), undefined, 'an unavailable native handle confers no authority');
});

test('input already started before deferred admission blocks collection and cannot create a late baseline', async t => {
  const h = await handHarness(t), f = fixture(), producer = await createBrowserGeometryProducer({ client: h.client, windowEvidence: f.source });
  t.after(() => producer.close());
  producer.beginTurn('c'.repeat(32)); h.ack(); producer.watch(f.page); await producer.acquire(f.page, f.acquire); h.ack();
  assert.equal(typeof producer.inputStarted, 'function');
  const input = producer.inputStarted(); assert.ok(input);
  await producer.acquire(f.page, f.acquire); assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1, 'pending dispatch refuses capture even before admit');
  assert.ok(producer.inputFinished(input)); await producer.acquire(f.page, f.acquire); h.ack();
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 2);
  const second = await handHarness(t), g = fixture(), late = await createBrowserGeometryProducer({ client: second.client, windowEvidence: g.source });
  t.after(() => late.close());
  late.beginTurn('d'.repeat(32)); second.ack(); late.watch(g.page);
  const pending = late.inputStarted(); late.inputFinished(pending); await late.acquire(g.page, g.acquire);
  assert.equal(second.frames().filter(row => row.op === 'certificate').length, 0, 'first protected input forbids a late baseline');
});

test('browser hand routes target frames through private admission during a producer turn', async () => {
  const deferred = [], admitted = [], finished = [], publicFrames = [], held = {}, prefix = { call: 'a'.repeat(32), action: 1, attempt: 1, ordinal: 1 };
  const geometryProducer = { state: { turn: 'b'.repeat(32) }, admit(...args) { admitted.push(args); return 7; }, inputFinished(seq) { finished.push(seq); } };
  const bounds = { X: 100, Y: 100, Width: 800, Height: 800 }, page = {};
  const hand = createBrowserHand({ client: { enabled: true, send: frame => publicFrames.push(frame) },
    env: {}, setting: () => ({ enabled: true }), defer: fn => deferred.push(fn),
    readMetrics: async () => ({ screenX: 100, screenY: 100, outerWidth: 800, outerHeight: 800, innerWidth: 800, innerHeight: 700, dpr: 1, visible: true }),
    locate: async () => ({ ok: true, window: { pid: 42, windowId: 7, bounds }, windows: [{ pid: 42, id: 7, bounds, layer: 0 }],
      displays: [{ X: 0, Y: 0, Width: 2000, Height: 2000 }] }),
    geometryProducer, geometryContext: () => ({ prefix, held }) });
  const token = hand.step({ op: 'click', page, locator: { boundingBox: async () => ({ x: 10, y: 20, width: 90, height: 30 }) } });
  assert.equal(admitted.length, 0, 'private admission adds no await on the input path');
  hand.finish(token); await deferred[0]();
  assert.equal(admitted.length, 1, 'target geometry must use admit');
  assert.equal(publicFrames.length, 0, 'no target frame through public send');
  assert.deepEqual(admitted[0].slice(1), [prefix, { page, held }]);
  assert.deepEqual(finished, [7], 'a completion before the deferred frame remains correlated');
  hand.step({ op: 'click', page, locator: { boundingBox: async () => ({ x: 10, y: 20, width: 90, height: 30 }) } });
  geometryProducer.state.turn = 'c'.repeat(32);
  await deferred[1]();
  assert.equal(admitted.length, 1, 'late work from an ended turn must not admit into a new turn');
  assert.equal(publicFrames.length, 0);
  hand.close();
});

function drawnHand(h, producer, deferred, observed = []) {
  const setting = () => ({ enabled: true, style: 'ring' });
  const events = createCursorEvents({ env: {}, setting, onEvent: row => observed.push(row) });
  events.connectHost(h.client);
  const bounds = { X: 100, Y: 100, Width: 800, Height: 800 };
  const hand = createBrowserHand({ client: h.client, env: {}, setting, events,
    defer: fn => deferred.push(fn), geometryProducer: producer,
    geometryContext: () => ({ prefix: { call: 'a'.repeat(32), action: 1, attempt: 1, ordinal: 1 } }),
    readMetrics: async () => ({ screenX: 100, screenY: 100, outerWidth: 800, outerHeight: 800, innerWidth: 800, innerHeight: 700, dpr: 1, visible: true }),
    locate: async () => ({ ok: true, window: { pid: 42, windowId: 7, bounds }, windows: [{ pid: 42, id: 7, bounds, layer: 0 }],
      displays: [{ X: 0, Y: 0, Width: 2000, Height: 2000 }] }) });
  return { hand, events, input: { op: 'click', page: {}, locator: { boundingBox: async () => ({ x: 10, y: 20, width: 90, height: 30 }) } } };
}

test('real cursor events and GP1 client admit exactly one target with zero public aim and zero poison', async t => {
  const h = await handHarness(t), producer = await createBrowserGeometryProducer({ client: h.client }), deferred = [], rows = [];
  const { hand, events, input } = drawnHand(h, producer, deferred, rows);
  t.after(() => { producer.close(); events.close(); hand.close(); });
  assert.ok(producer.beginTurn('b'.repeat(32))); h.ack();
  const token = hand.step(input); await deferred[0]();
  assert.equal(h.channel.state.poisoned, false, 'a public aim would poison the real GP1 channel');
  assert.equal(h.frames().filter(row => row.op === 'admit').length, 1);
  assert.equal(rows.filter(row => row.type === 'action' && row.phase === 'aim').length, 0);
  assert.equal(rows.filter(row => row.type === 'action' && row.phase === 'act').length, 1);
  h.ack(); hand.finish(token); assert.ok(producer.endTurn()); h.ack();
});

test('adapter end is idempotent while ending and refuses a pending admission ack without calling channel end', async t => {
  const h = await handHarness(t), producer = await createBrowserGeometryProducer({ client: h.client });
  t.after(() => producer.close());
  producer.beginTurn('b'.repeat(32)); h.ack();
  const seq = producer.admit({ kind: 'click', pid: 42, windowId: 7, at: [150, 235] },
    { call: 'a'.repeat(32), action: 1, attempt: 1, ordinal: 1 });
  assert.ok(seq);
  assert.equal(producer.endTurn(), false, 'pending ack must not call the poisoning GP1 end method');
  assert.equal(h.channel.state.poisoned, false);
  assert.equal(h.frames().filter(row => row.op === 'end').length, 0);
  h.ack(); assert.ok(producer.endTurn());
  assert.equal(producer.endTurn(), false, 'ending is a local no-op');
  assert.equal(h.channel.state.poisoned, false);
  assert.equal(h.frames().filter(row => row.op === 'end').length, 1);
  h.ack(); assert.equal(producer.state.turn, undefined);
});

test('adapter ending guard survives a cleared ack queue and calls the real channel end only once', async t => {
  const h = await handHarness(t); let calls = 0;
  const producer = await createBrowserGeometryProducer({ channel: {
    get state() { return h.channel.state; },
    beginTurn: turn => h.channel.beginTurn(turn),
    endTurn() { calls++; return h.channel.endTurn(); },
  } });
  t.after(() => producer.close()); producer.beginTurn('b'.repeat(32)); h.ack();
  assert.ok(producer.endTurn()); assert.equal(calls, 1);
  // An invalidation after end poisons GP1 and clears pending acks while retaining its closing receipt.
  assert.equal(h.channel.invalidate('layout'), false);
  assert.equal(h.channel.state.poisoned, true);
  assert.equal(h.channel.state.pending, 0); assert.equal(producer.state.ending, true);
  assert.equal(producer.endTurn(), false); assert.equal(calls, 1, 'ending must never call channel.endTurn twice');
});

for (const workerOffset of [-1000000, 1000000]) test(`parent acquisition brackets ignore worker clock offset ${workerOffset}`, async () => {
  const geometryURL = sourceURL('direct-browser/geometry-observation.mjs', source =>
    source.replaceAll('performance.now()', `(performance.now() + ${2000000 + workerOffset})`));
  const layout = await import(geometryURL), f = fixture(layout, 2000000 + workerOffset);
  let now = 2000000, certificateCount = 0;
  const intervals = [], channel = { state: { pending: 0, admitted: [], after: -1 },
    beginTurn(turn) { this.state.turn = turn; return 1; },
    capture(interval) { intervals.push(interval); return {}; }, certify() { certificateCount++; return 2; } };
  // Only the parent clock is controlled here. The native bank validates and
  // preserves its own worker-local clock, including either origin offset.
  const parentURL = sourceURL('hand/browser-hand.mjs', source => {
    source = source.replaceAll("'../direct-browser/geometry-observation.mjs'", JSON.stringify(geometryURL));
    source = source.replaceAll('performance.now()', 'globalThis.__gp3bParentClock()');
    if (process.env.GP3B_VARIANT === 'worker-clock') {
      source = replaceSite(source, 'latestBrowserLayout, watchBrowserLayout', 'latestBrowserLayout, browserLayoutInterval, watchBrowserLayout');
      source = replaceSite(source, 'function collect(page, observation, interval) {',
        'function collect(page, observation, interval) { interval = browserLayoutInterval(observation);');
    }
    return source;
  });
  globalThis.__gp3bParentClock = () => now;
  const parent = await import(parentURL), producer = await parent.createBrowserGeometryProducer({ channel, windowEvidence: f.source });
  try {
    producer.beginTurn('a'.repeat(32)); producer.watch(f.page);
    await producer.acquire(f.page, async () => { f.acquire(); now = 2000020; });
    assert.equal(certificateCount, 1);
    assert.deepEqual(intervals, [{ start: 2000000, end: 2000020 }], 'only parent request and receipt times reach capture');
    assert.ok((layout.browserLayoutInterval(layout.latestBrowserLayout(f.page)).end - 2000000) * Math.sign(workerOffset) > 1000,
      'worker interval really has the requested offset');
    // A read begun before input cannot be made fresh by a worker clock ahead.
    now = 2000100;
    await producer.acquire(f.page, async () => { const input = producer.inputStarted(); f.acquire(); now = 2000110; producer.inputFinished(input); now = 2000120; });
    assert.equal(certificateCount, 1, 'parent request before completion is stale in either clock direction');
  } finally { producer.close(); delete globalThis.__gp3bParentClock; }
});

test('unsolicited, reused, failed and overlapping requests cannot acquire fresh parent intervals', async t => {
  const h = await handHarness(t), f = fixture(), producer = await createBrowserGeometryProducer({ client: h.client, windowEvidence: f.source });
  t.after(() => producer.close()); producer.beginTurn('a'.repeat(32)); h.ack(); producer.watch(f.page);
  f.acquire(); assert.equal(h.frames().filter(row => row.op === 'certificate').length, 0);
  await assert.rejects(producer.acquire(f.page, async () => { f.acquire(); throw Error('read failed'); }), /read failed/);
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 0);
  await producer.acquire(f.page, () => producer.acquire(f.page, f.acquire));
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 0);
  await producer.acquire(f.page, f.acquire); h.ack();
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1);
  await producer.acquire(f.page, () => f.acquire(true));
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1, 'a reused native read receives no new parent interval');
});

test('collection failure preserves the snapshot result and releases acquisition ownership', async () => {
  let attempts = 0;
  const f = fixture(), result = {}, channel = { state: { pending: 0, admitted: [], after: -1 },
    beginTurn(turn) { this.state.turn = turn; return 1; }, capture() { attempts++; throw Error('observer unavailable'); } };
  const producer = await createBrowserGeometryProducer({ channel, windowEvidence: f.source });
  producer.beginTurn('a'.repeat(32)); producer.watch(f.page);
  try {
    for (let i = 0; i < 2; i++) assert.equal(await producer.acquire(f.page, () => { f.acquire(); return result; }), result);
    assert.equal(attempts, 2, 'both reads must reach capture after the first collection throws');
  } finally { producer.close(); }
});

test('real merged client end then finish and deferred show keep terminal records public before the ack', async t => {
  const api = process.env.GP3B_VARIANT === 'old-session' ? await import(sourceURL('hand/client.mjs', source => replaceSite(source,
    "geometry.active && (!geometry.ending || geometry.poisoned && wire.hand === 'status')", 'geometry.active'))) : undefined;
  const h = await handHarness(t, api), producer = await createBrowserGeometryProducer({ channel: h.channel });
  const deferred = [], rows = [], { hand, events, input } = drawnHand(h, producer, deferred, rows);
  t.after(() => { producer.close(); events.close(); hand.close(); });
  producer.beginTurn('a'.repeat(32)); h.ack();
  const token = hand.step(input); await deferred[0](); h.ack();
  const oldSession = h.channel.state.session;
  assert.ok(producer.endTurn()); hand.finish(token);
  events.status('done'); events.status('handback');
  assert.equal(h.channel.state.poisoned, false);
  assert.equal(h.frames().filter(row => row.op === 'public').length, 0, 'no frame attributed to the ended producer session');
  const terminals = h.lines.filter(row => row.hand === 'status' && ['done', 'handback'].includes(row.state));
  assert.equal(terminals.length, 2);
  assert.ok(terminals.every(row => row.session === undefined && row.turn === undefined));
  assert.equal(rows.filter(row => row.type === 'action' && row.phase === 'done').length, 1);
  h.ack(); assert.equal(producer.state.turn, undefined);
  assert.ok(producer.beginTurn('b'.repeat(32))); h.ack();
  assert.notEqual(h.channel.state.session, oldSession);
  const late = hand.step(input); assert.ok(producer.endTurn()); hand.finish(late, true); await deferred[1]();
  assert.equal(h.channel.state.poisoned, false, 'deferred show after end must not send target geometry');
  assert.equal(h.frames().filter(row => row.op === 'admit').length, 1);
  assert.equal(rows.filter(row => row.type === 'action' && row.phase === 'failed').length, 1);
  assert.equal(h.frames().filter(row => row.op === 'public').length, 0);
  h.ack();
});


test('a replayed native observation inside one acquisition is counted only once', async () => {
  const geometryURL = sourceURL('direct-browser/geometry-observation.mjs', source => replaceSite(source,
    'try { listener(observation); }', 'try { listener(observation); listener(observation); }'));
  const layout = await import(geometryURL), module = await browserHandModule({ geometryURL }), f = fixture(layout);
  let certificates = 0;
  const channel = { state: { pending: 0, admitted: [], after: -1 },
    beginTurn(turn) { this.state.turn = turn; return 1; }, capture() { return {}; }, certify() { certificates++; return 2; } };
  const producer = await module.createBrowserGeometryProducer({ channel, windowEvidence: f.source });
  try {
    producer.beginTurn('a'.repeat(32)); assert.ok(producer.watch(f.page));
    await producer.acquire(f.page, f.acquire);
    assert.equal(certificates, 1, 'duplicate delivery must not invalidate a complete acquisition');
  } finally { producer.close(); }
});


test('an acquisition accepts only the native batch created by its own request', async t => {
  const h = await handHarness(t), f = fixture(), producer = await createBrowserGeometryProducer({ client: h.client, windowEvidence: f.source });
  t.after(() => producer.close()); producer.beginTurn('a'.repeat(32)); h.ack(); producer.watch(f.page);
  const earlier = f.begin();
  await producer.acquire(f.page, () => f.complete(earlier));
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 0, 'a pre-existing native read cannot borrow this request interval');
  let release;
  const pending = producer.acquire(f.page, () => new Promise(resolve => { release = resolve; }));
  f.acquire(); release(); await pending;
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 0, 'an unrelated concurrent read cannot donate its observation');
  await producer.acquire(f.page, f.acquire);
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1, 'a request-owned native read certifies');
});
