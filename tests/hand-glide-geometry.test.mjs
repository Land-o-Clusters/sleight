import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createRuntimeActionEvents } from '../plugins/sleight/lib/mac-driver/action-events.mjs';
import { createGlideGeometryWire as ordinaryWire, GLIDE_GEOMETRY_LIMIT } from '../plugins/sleight/lib/mac-driver/geometry.mjs';
import { harness as ordinaryHarness, base, row, call, settle } from './fixtures/glide-hand.mjs';
import { createRuntimeHand as ordinaryHand } from '../plugins/sleight/lib/hand/runtime-hand.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const variant = process.env.GP2_VARIANT;
const failures = [
  ['drops-stale-turn-target', "if (action.phase === 'act' && action.point && action.window?.id && action.window?.pid)", 'if (false)'],
  ['public-json', 'privateGlideObservation(receipt)', 'privateGlideObservation(receipt) ?? receipt'],
  ['window-replacement', 'if (!o.continuous) return refuse();', ''],
  ['pid-reuse', 'if (old && old.start !== o.processStart) return refuse();', ''],
  ['root-replacement', null, null], // Its distinct mutation runs in the compiled native fixture.
  ['visibility-gap', 'if (!o.transform || !rectangle(o.bounds)) return refuse();', 'if (!rectangle(o.bounds)) return refuse();'],
  ['unsettled', 'if (!o.settled) return refuse();', ''],
  ['stale-watermark', 'geometry.capture({ start: o.acquired[0], end: o.acquired[1] })', 'geometry.capture({ start: performance.now(), end: performance.now() })'],
  ['racing-revision', 'if (!Number.isSafeInteger(o.before) || o.before !== o.after) return refuse();', ''],
  ['queued-input', 'if (o.queuedInput) return refuse();', ''],
  ['unknown-drag', 'if (o.drag) return refuse();', ''],
  ['truncated-tree', 'if (!o.complete) return refuse();', ''],
  ['missing-reference', 'if (references.length !== admitted.length || new Set(references.map(r => r.seq)).size !== references.length || !admitted.every(r => references.some(ref => ref.seq === r.seq))) return refuse();',
    'if (!references.length && admitted.length) references.push({ seq: admitted[0].seq, departed: false, rects: [[10, 20, 30, 40]] });'],
  ['same-label-replacement', null, null], // Its distinct mutation runs in the compiled native fixture.
  ['recycled-content', 'if (!row.semantic) return refuse();', ''],
  ['unknown-clipping', 'if (!row.clipping) return refuse();', ''],
  ['absence-as-departure', null, null], // Its distinct mutation runs in the compiled native fixture.
  ['missing-notifications', 'if (!o.notifications) return refuse();', ''],
  ['map-eviction', null, null], // Its distinct mutation runs in the compiled native fixture.
  ['unresolved-action', '} else if (geometry) refuse();', '}'],
  ['unadmitted-reference', 'if (seq === undefined) return refuse();', 'if (seq === undefined) continue;'],
];
async function mutated(url, from, to) {
  let source = readFileSync(url, 'utf8'); assert.equal(source.split(from).length, 2, 'one production mutation site');
  source = source.replace(from, to).replace(/from '(\.[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
let createRuntimeHand = ordinaryHand, createWire = ordinaryWire;
const mutation = failures.find(([name]) => name === variant);
if (mutation?.[1]) ({ createRuntimeHand } = await mutated(new URL('../plugins/sleight/lib/hand/runtime-hand.mjs', import.meta.url), mutation[1], mutation[2]));
if (variant === 'reuse-without-interval') {
  const url = new URL('../plugins/sleight/lib/mac-driver/geometry.mjs', import.meta.url);
  // Keep the production capability registry. Only the read-reuse decision is
  // changed; the resulting records still enter the ordinary adapter.
  const module = await mutated(url,
    'if (!original || JSON.stringify(original.native) !== JSON.stringify(value.acquired)) continue;\n        acquired = original.parent;',
    'acquired = original?.parent ?? [clock(), clock()];');
  createWire = module.createGlideGeometryWire;
  ({ createRuntimeHand } = await mutated(new URL('../plugins/sleight/lib/hand/runtime-hand.mjs', import.meta.url),
    "from '../mac-driver/geometry.mjs'", `from '${'data:text/javascript;base64,' + Buffer.from(readFileSync(url, 'utf8').replace(
      'if (!original || JSON.stringify(original.native) !== JSON.stringify(value.acquired)) continue;\n        acquired = original.parent;',
      'acquired = original?.parent ?? [clock(), clock()];')).toString('base64')}'`));
}
const harness = t => ordinaryHarness(t, { createRuntimeHand, createWire });

test('complete positive map uses real GP1 capture, exact admitted sequence and conservative rounding', async t => {
  const h = await harness(t); h.act(); h.wire.begin(3); h.send(3, { read: 2, acquired: [20, 21], references: [row()] });
  assert.equal(h.certificates().length, 2);
  const geometry = h.certificates().at(-1).geometry;
  assert.deepEqual(geometry.references, [{ seq: h.frames().find(f => f.op === 'admit').seq, departed: false, rects: [[10, 20, 30, 40]] }]);
  assert.equal(geometry.mode, 'layout');
  assert.equal(h.frames().filter(f => f.op === 'admit').length, 1);
});

test('offline parent processing reports CPU and elapsed cost separately', async t => {
  for (const count of [1, 64]) {
    const h = await harness(t); h.act();
    for (let index = 1; index < count; index++) {
      h.wire.begin(index + 2, { call, index });
      h.hand({ type: 'action', phase: 'act', call, index, kind: 'click', point: [25, 40], rect: [10, 20, 30, 40],
        window: { id: 7, pid: 42, rect: [0, 0, 900, 600] } });
      h.ack(); h.wire.finish(index + 2);
    }
    const references = Array.from({ length: count }, (_, i) => ({ ...row(), action: i + 2 }));
    const startCPU = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < 100; i++) {
      const id = i + count + 2; h.wire.begin(id);
      h.send(id, { read: i + 2, acquired: [i + 20, i + 21], references });
      h.ack(); h.wire.finish(id);
    }
    const elapsedMs = performance.now() - start, cpu = process.cpuUsage(startCPU);
    assert.equal(h.certificates().length, 101);
    t.diagnostic(JSON.stringify({ observations: 100, references: count, cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs,
      addedAX: 0, captures: 0, inputWaits: 0, transport: 'fake-hand-ack' }));
  }
});

for (const name of [...failures.map(([name]) => name).filter(name => name !== 'drops-stale-turn-target'), 'reuse-without-interval']) test(`refuses ${name}`, async t => {
  const h = await harness(t);
  if (name === 'stale-watermark') h.wire.begin(3);
  if (['unresolved-action', 'unadmitted-reference'].includes(name)) {
    h.wire.begin(2, { call, index: 0 });
    if (name === 'unresolved-action') h.hand({ type: 'action', phase: 'act', call, index: 0, kind: 'key' });
    h.wire.finish(2);
  } else h.act();
  if (name !== 'stale-watermark') h.wire.begin(3);
  const patch = { read: 2, acquired: [20, 21], references: [row()] };
  if (['window-replacement', 'map-eviction'].includes(name)) patch.continuous = false;
  if (name === 'pid-reuse') patch.processStart = 'reused-pid';
  if (['root-replacement', 'same-label-replacement', 'absence-as-departure'].includes(name)) patch.references[0].joined = false;
  if (name === 'visibility-gap') patch.transform = false;
  if (name === 'unsettled') patch.settled = false;
  if (name === 'racing-revision') patch.after = 1;
  if (name === 'queued-input') h.wire.begin(4, { call, index: 1 });
  if (name === 'unknown-drag') patch.drag = true;
  if (name === 'truncated-tree') patch.complete = false;
  if (name === 'missing-reference') patch.references = [];
  if (name === 'unresolved-action') patch.references = [];
  if (name === 'recycled-content') patch.references[0].semantic = false;
  if (name === 'unknown-clipping') patch.references[0].clipping = false;
  if (name === 'absence-as-departure') { patch.references[0].departed = true; patch.references[0].rects = []; }
  if (name === 'missing-notifications') patch.notifications = false;
  if (name === 'reuse-without-interval') { patch.reused = true; patch.read = 99; }
  if (name === 'public-json') h.hand.geometry({ ...base(), ...patch, turn: h.turn, acquired: [performance.now(), performance.now()],
    references: [{ ...row(), action: { call, index: 0 } }] });
  else h.send(3, patch);
  assert.equal(h.certificates().length, 1, `${name} must not certify`);
});

test('a full 512-reference inventory travels separately from the 8192-byte action channel', async t => {
  const h = await harness(t); h.wire.begin(3);
  const references = Array.from({ length: 512 }, (_, i) => ({ ...row(), action: 1000 + i }));
  const encoded = JSON.stringify({ ...base(), references });
  assert.ok(Buffer.byteLength(encoded) > 8192); assert.ok(Buffer.byteLength(encoded) < GLIDE_GEOMETRY_LIMIT);
  h.send(3, { read: 2, references });
  assert.equal(h.certificates().length, 1, 'unbound inventory refuses instead of splitting');
  t.diagnostic(`fullMapBytes=${Buffer.byteLength(encoded)} privateLimit=${GLIDE_GEOMETRY_LIMIT} actionLimit=8192`);
});

test('runtime action feed keeps private observations out of cursor action records', async t => {
  const feed = createRuntimeActionEvents(), stream = new PassThrough(), observations = [], actions = [];
  t.after(() => feed.close()); feed.connect(r => actions.push(r)); feed.connectGeometry(r => observations.push(r));
  const wire = feed.geometryWire({ nonce: 'f'.repeat(64), stream });
  assert.equal(feed.geometryEnabled, true); wire.begin(1); await settle();
  assert.equal(observations.length, 1); assert.equal(actions.length, 0);
});

test('relay uses the existing target-release boundary and skips the callback on idle rotation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  let ended = 0;
  serverIn.on('data', bytes => {
    for (const q of bytes.toString().trim().split('\n').map(JSON.parse)) if (q.id !== undefined)
      setImmediate(() => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { content: [] } }) + '\n'));
  });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, modHost: () => false, changeReview: false,
    idleTurnEndMs: 30000, onStageTurnEnd: () => { ended++; } });
  t.after(() => relay.dispose());
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }) + '\n');
  for (let i = 0; i < 12; i++) await settle();
  t.mock.timers.tick(30000);
  for (let i = 0; i < 12; i++) await settle();
  assert.equal(ended, 0, 'idle rotation retains native obligations');
  await relay.endOpenTurn(); assert.equal(ended, 0, 'unattributed cleanup retains the producer');
});


test('stale Glide turn targets reach plain host protection while their cursor events stay dropped', async t => {
  const h = await harness(t), cursorRows = [];
  const consume = createRuntimeHand({ client: h.client, producer: true, events: { action: row => cursorRows.push(row) } });
  consume({ type: 'action', phase: 'act', geometryTurn: 'e'.repeat(32), call, index: 0, kind: 'click',
    point: [25, 40], rect: [10, 20, 30, 40], window: { id: 7, pid: 42, rect: [0, 0, 900, 600] } });
  const frame = h.child.lines.at(-1);
  assert.equal(frame.hand, 'act', 'stale record target must reach ordinary admission');
  assert.deepEqual(frame.at, [25, 40]); assert.deepEqual(frame.rect, [10, 20, 30, 40]);
  assert.deepEqual(frame.windowRect, [0, 0, 900, 600]);
  assert.equal(frame.turn, undefined, 'private attribution never enters the public frame');
  assert.equal(cursorRows.length, 0); assert.equal(h.frames().filter(row => row.op === 'admit').length, 0);
  assert.equal(h.frames().at(-1).op, 'fault'); assert.equal(h.frames()[0].turn, h.turn);
});
