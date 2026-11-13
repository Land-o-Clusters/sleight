import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';

const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-producer-'))));
after(() => rmSync(root, { recursive: true, force: true }));
const variant = process.env.GP1_VARIANT;
function change(source, from, to) {
  assert.ok(source.includes(from), 'named mutation site: ' + from);
  return source.replace(from, to);
}
const clientURL = new URL('../plugins/sleight/lib/hand/client.mjs', import.meta.url);
let clientSource = readFileSync(clientURL, 'utf8');
if (variant === 'socket-write-as-admission') clientSource = change(clientSource,
  'return seq; // Queued only.', "if (op === 'admit') admitted.set(seq, Object.freeze({ ...body.prefix, pid: body.frame.pid, windowId: body.frame.windowId })); return seq; // Queued only.");
if (variant === 'client-keeps-ended-session') clientSource = change(clientSource,
  "geometry.active && (!geometry.ending || geometry.poisoned && wire.hand === 'status')", 'geometry.active');
if (variant === 'poisoned-ending-stays-plain') clientSource = change(clientSource,
  "geometry.active && (!geometry.ending || geometry.poisoned && wire.hand === 'status')", 'geometry.active && !geometry.ending');
if (variant === 'drops-poisoned-closing-target') clientSource = change(clientSource,
  "geometry.active && (!geometry.ending || geometry.poisoned && wire.hand === 'status')", 'geometry.active && (!geometry.ending || geometry.poisoned)')
  .replace('if (geometry.publicFrame(wire) !== false) return;', 'geometry.publicFrame(wire); return;');
if (variant === 'terminal-refused-at-cap') clientSource = change(clientSource,
  'pending.size >= 512 && !closingStatus', 'pending.size >= 512');
if (variant === 'drops-refused-public-target') clientSource = change(clientSource,
  'if (geometry.publicFrame(wire) !== false) return;', 'geometry.publicFrame(wire); return;');
if (variant === 'drops-refused-private-target') clientSource = change(clientSource,
  "if (running() && wire && typeof wire !== 'string' && wire.hand !== 'status')", "if (false && running() && wire && typeof wire !== 'string' && wire.hand !== 'status')");
if (variant === 'drops-stale-action-target') clientSource = change(clientSource,
  "if (stale && frame?.hand === 'status') return;", 'if (stale) return;');
if (variant === 'drops-paused-action-target') clientSource = change(clientSource,
  "if (menuOnly || !hand || host === 'dead') return;", "if (menuOnly || !hand || host === 'dead' || paused) return;");
if (variant === 'drops-backpressured-action-target') clientSource = change(clientSource,
  'urgent: wire.at !== undefined || wire.windowRect !== undefined', 'urgent: false');
if (variant === 'closing-status-keeps-target') clientSource = change(clientSource,
  "if (geometry.ending && wire.hand === 'status')", "if (false && geometry.ending && wire.hand === 'status')");
if (variant === 'late-ack-refuses-next-begin') clientSource = change(clientSource,
  'if (ending) idle();', 'if (false && ending) idle();');
if (variant === 'splits-oversize-certificate') {
  clientSource = change(clientSource, 'if (!line || Buffer.byteLength(line) > 65536)', 'if (!line)');
  clientSource = change(clientSource,
  'const references = frame.geometry.references.map(ref => {',
  "return [frame.geometry.references.slice(0, 256), frame.geometry.references.slice(256)].map(references => JSON.stringify({ ...frame, geometry: { ...frame.geometry, references } }) + '\\n').join('');\n  const references = frame.geometry.references.map(ref => {");
}
// Load the actual client with only the selected broken line changed. Relative module dependencies stay production ones.
clientSource = clientSource.replace(/from '(\.[^']+)'/g, (_, path) => `from '${new URL(path, clientURL).href}'`);
const moduleURL = ['socket-write-as-admission', 'splits-oversize-certificate', 'client-keeps-ended-session', 'late-ack-refuses-next-begin', 'poisoned-ending-stays-plain', 'closing-status-keeps-target', 'drops-poisoned-closing-target', 'terminal-refused-at-cap', 'drops-refused-public-target', 'drops-refused-private-target', 'drops-stale-action-target', 'drops-paused-action-target', 'drops-backpressured-action-target'].includes(variant)
  ? 'data:text/javascript;base64,' + Buffer.from(clientSource).toString('base64') : clientURL.href;
const { createHandClient, privateHandGeometry, shareConsent, handWireFrame } = await import(moduleURL);
const capture = channel => { const stamp = performance.now(); return channel.capture({ start: stamp, end: stamp }); };
const settle = () => new Promise(resolve => setImmediate(resolve));
const bounds = [200, 500, 900, 350], call = 'c'.repeat(32), turn = 'b'.repeat(32);
const target = { kind: 'click', pid: 42, windowId: 7, at: [650, 700], windowRect: bounds };
const action = ordinal => ({ call, action: ordinal, attempt: 1, ordinal });
const geometry = (more = {}) => ({ pid: 42, windowId: 7, incarnation: 'd'.repeat(32), contentGeneration: 0,
  mode: 'baseline', bounds, references: [], ...more });
const reference = (seq, more = {}) => ({ seq, rects: [[640, 680, 20, 20]], departed: false, ...more });
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false,
  hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait',
  'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const fixture = join(root, 'character.json');
writeFileSync(fixture, JSON.stringify({ hand: 'character', nonce: 'a'.repeat(64), seq: 1, id: 'fixture', sheet: join(root, 'sheet.png'), extra: null,
  cell: [192, 208], table: { idle: { ...entry, frames: 2 } },
  perch: { anchor: [96, 150], table: Object.fromEntries(states.map(state => [state, entry])) }, size: 'stage' }));
async function harness(t) {
  const child = new EventEmitter(); child.pid = 12345; child.lines = [];
  child.stdin = new EventEmitter(); child.stdin.writableLength = 0;
  child.stdin.write = line => { child.lines.push(...line.trim().split('\n').map(JSON.parse)); return true; };
  child.stdin.end = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  child.stdout = new EventEmitter(); child.stdio = [child.stdin, child.stdout, null, new EventEmitter(), new EventEmitter()];
  for (const stream of child.stdio.slice(3)) { stream.write = () => true; stream.destroy = () => {}; }
  const traces = [];
  const client = createHandClient({ setting: () => ({ enabled: true, style: 'ring', narration: 'bubbles' }), watch: () => {}, permissions: null, usage: null,
    trace: (event, detail) => traces.push({ event, detail }),
    built: () => true, prepare: async () => ({ status: 'ready', spawn: () => child }) });
  t.after(() => client.close());
  await shareConsent(); await settle();
  const channel = privateHandGeometry(client);
  const frames = () => child.lines.filter(f => f.hand === 'stage-producer');
  const ack = (frame = frames().at(-1), accepted = true) => child.stdout.emit('data', JSON.stringify({ hand: 'stage-producer-ack',
    nonce: frame.nonce, session: frame.session, turn: frame.turn, seq: frame.seq, op: frame.op, accepted }) + '\n');
  let delivered = 0;
  const deliver = () => {
    const rows = dump(frames(), 0, { loaded: true });
    for (const row of rows.slice(delivered)) ack(row, row.accepted);
    delivered = rows.length; return rows.at(-1);
  };
  return { child, client, channel, frames, ack, deliver, traces };
}
let binary;
function host() {
  if (binary) return binary;
  const url = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
  let source = readFileSync(url, 'utf8');
  if (variant === 'accepts-partial-inventory') source = change(source,
    'Set(proof.references.map { $0.seq }) == expected, expected == retained,',
    'Set(proof.references.map { $0.seq }).isSubset(of: expected), expected == retained,');
  if (variant === 'rebaselines-with-obligations') source = change(source,
    'guard producer.after == -1, producer.references.isEmpty, perch.stage.turnTargets.isEmpty,\n                producer.baselines[proof.key] == nil, producer.baselines.count < 128, proof.references.isEmpty else { return }',
    'guard proof.references.isEmpty else { return }');
  if (variant === 'accepts-old-sequence-observation') source = change(source,
    'f.observation > producer.observation, f.acquired[0] >= producer.acquiredEnd, f.acquired[0] >= producer.barrier,', 'true,');
  if (variant === 'ignores-same-bounds-invalidation') source = change(source, 'producer.epoch = f.epoch', '/* dropped epoch */');
  if (variant === 'invalidation-skips-hide') source = change(source,
    'for key in Set(producer.references.values) { perch.stage.invalidateGeometry(key) }', '/* epoch advances without invalidating geometry */');
  if (variant === 'producer-collection-disabled') source = change(source,
    'perch.stage.producerCollectionOnly = true', 'perch.stage.producerCollectionOnly = false');
  if (variant === 'unguarded-delayed-terminal') source = change(source,
    'if terminal && (producer != nil || producerOwner != nil)', 'if false && terminal && (producer != nil || producerOwner != nil)');
  if (variant === 'host-adopts-ended-session') source = change(source,
    'if producer.endedIdentities.contains(', 'if false && producer.endedIdentities.contains(');
  if (variant === 'wrong-session-terminal') source = change(source,
    'if terminal && (producer != nil || producerOwner != nil)', 'if terminal && producerOwner?.turn != producer?.turn');
  if (variant === 'wrong-turn-terminal') source = change(source,
    'if terminal && (producer != nil || producerOwner != nil)', 'if terminal && producerOwner?.session != producer?.session');
  if (variant === 'status-admits-reference') source = change(source,
    'if protectsTarget && (producerOwner == nil || handKinds.contains(ev.state) || ev.state == "aim") {', 'if protectsTarget {');
  if (variant === 'ordinary-status-skips-target') {
    source = change(source, 'producerOwner == nil || handKinds.contains(ev.state)', 'handKinds.contains(ev.state)');
    source = change(source, 'ordinary || !producer.active || handKinds.contains(incoming.state)', 'ordinary || handKinds.contains(incoming.state)');
  }
  if (variant === 'ended-terminal-completes-new-turn') source = change(source,
    'if terminal, let identity = event.producer, identity != producer.identity {',
    'if terminal, let identity = event.producer, identity != producer.identity { perch.stage.completeTurn(state: event.state, ok: event.ok, now: perch.now)');
  if (variant === 'ended-status-skips-target') source = change(source,
    'if producer.active, !terminal, event.at != nil, !handKinds.contains(event.state), event.state != "aim" {',
    'if false && producer.active, !terminal, event.at != nil, !handKinds.contains(event.state), event.state != "aim" {');
  if (variant === 'ring-overwrites-rejected-terminal') source = change(source,
    'stage.event = previous\n            performStage(stage.receive', '/* lost event restore */\n            performStage(stage.receive');
  if (variant === 'producer-terminal-becomes-handback') source = change(source,
    'finishProducer(terminal: event)', 'finishProducer()');
  if (variant === 'production-drops-attribution') source = change(source,
    'event.producer = producer.identity', 'event.producer = nil');
  if (variant === 'shifts-status-target-box') source = change(source,
    'var targets = [stagePointRect(ev.at, 48)]', 'var targets = [stagePointRect(CGPoint(x: ev.at.x + 12, y: ev.at.y), 48)]');
  const input = join(root, 'host.swift'); writeFileSync(input, source); binary = join(root, 'host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), input, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr); return binary;
}
function dump(frames, code = 0, { reader = false, loaded = false, raw } = {}) {
  const result = spawnSync(host(), [reader ? '--stage-producer-reader-dump' : '--stage-producer-dump', ...loaded ? [fixture] : []], { input: raw ?? frames.map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  assertChildStatus(result, code, result.stderr);
  return result.stdout.trim() ? result.stdout.trim().split('\n').map(JSON.parse) : [];
}
async function begun(t, native = false) {
  const h = await harness(t); assert.ok(h.channel.beginTurn(turn)); native ? h.deliver() : h.ack();
  return h;
}
async function based(t, native = false) {
  const h = await begun(t, native);
  assert.ok(h.channel.certify(capture(h.channel), geometry())); native ? h.deliver() : h.ack();
  return h;
}
const options = { skip: macCommandSkip('xcrun') };

test('a successful socket write is not host admission; only an exact ordered acknowledgement enters the ledger', async t => {
  const h = await based(t); const seq = h.channel.admit(target, action(1));
  assert.ok(seq); assert.equal(h.channel.state.admitted.length, 0, 'socket write must not count as admission');
  assert.equal(capture(h.channel), undefined, 'pending admission cannot be observed');
  h.ack(); assert.deepEqual(h.channel.state.admitted.map(r => r.seq), [seq]);
});

test('private frames and acquisition tickets cannot enter through public frames or cursor records', async t => {
  const h = await harness(t);
  for (const hand of ['stage-producer', 'stage-geometry', 'stage-invalidate']) {
    assert.equal(handWireFrame({ ...target, hand, geometry: {} }), 'kind'); h.client.send({ ...target, hand, geometry: {} });
    h.client.cursor({ type: hand, ...target, geometry: {} });
  }
  assert.equal(h.frames().length, 0); assert.equal(Object.keys(h.client).includes('geometry'), false);
  h.channel.beginTurn(turn); h.ack();
  assert.equal(h.channel.certify({ epoch: 0, after: -1 }, geometry()), false);
  assert.equal(h.channel.state.poisoned, true);
});

for (const boundary of ['begin', 'admit', 'invalidate', 'certificate', 'end']) {
  test(`drop under backpressure at ${boundary} poisons the turn and sends an urgent persistent hide`, async t => {
    const h = await harness(t);
    if (boundary !== 'begin') { h.channel.beginTurn(turn); h.ack(); }
    h.child.stdin.writableLength = 65537;
    const result = boundary === 'begin' ? h.channel.beginTurn(turn) : boundary === 'admit' ? h.channel.admit(target, action(1)) :
      boundary === 'invalidate' ? h.channel.invalidate('ambient') : boundary === 'certificate' ? h.channel.certify(capture(h.channel), geometry()) : h.channel.endTurn();
    assert.equal(result, false); assert.equal(h.channel.state.poisoned, true);
    assert.equal(h.frames().at(-1).op, 'fault');
    if (boundary === 'admit') assert.equal(h.child.lines.at(-1).hand, 'act', 'a refused private target must reach ordinary admission');
    assert.equal(h.channel.state.admitted.length, 0); assert.equal(capture(h.channel), undefined);
  });
  test(`reconnect or missing ack at ${boundary} cannot invent admission or a new baseline`, async t => {
    const h = await harness(t); if (boundary !== 'begin') { h.channel.beginTurn(turn); h.ack(); }
    if (boundary === 'begin') h.channel.beginTurn(turn);
    if (boundary === 'admit') h.channel.admit(target, action(1));
    if (boundary === 'invalidate') h.channel.invalidate('layout');
    if (boundary === 'certificate') h.channel.certify(capture(h.channel), geometry());
    if (boundary === 'end') h.channel.endTurn();
    h.child.stdout.emit('end');
    assert.equal(h.channel.state.poisoned, true); assert.equal(capture(h.channel), undefined);
    assert.equal(h.channel.beginTurn('f'.repeat(32)), false);
  });
}

test('lost, reordered and duplicate host acknowledgements never erase the retained inventory', async t => {
  for (const kind of ['reordered', 'duplicate', 'lost']) {
    const h = await based(t); const first = h.channel.admit(target, action(1));
    if (kind === 'duplicate') { h.ack(); h.ack(); }
    else if (kind === 'reordered') { h.channel.admit(target, action(2)); h.ack(); }
    else { await new Promise(resolve => setTimeout(resolve, 1100)); }
    assert.equal(h.channel.state.poisoned, true, kind);
    assert.deepEqual(h.channel.state.admitted.map(r => r.seq), kind === 'duplicate' ? [first] : []);
  }
});

test('acquisition tickets retain their original prefix and epoch when serialized after a later action or invalidation', async t => {
  for (const kind of ['action', 'invalidation']) {
    const h = await based(t), old = capture(h.channel);
    if (kind === 'action') h.channel.admit(target, action(1)); else h.channel.invalidate('typing'); h.ack();
    assert.equal(h.channel.certify(old, geometry()), false); assert.equal(h.channel.state.poisoned, true);
  }
});

test('512 references with four boxes are packed atomically below the actual UTF-8 byte cap or refused', async t => {
  const h = await based(t); const refs = [];
  for (let ordinal = 1; ordinal <= 512; ordinal++) {
    const seq = h.channel.admit(target, action(ordinal)); assert.ok(seq); h.ack();
    refs.push(reference(seq, { rects: Array.from({ length: 4 }, (_, i) => [640.123456789 + i / 10, 680.123456789, 20.123456789, 20.123456789]) }));
  }
  const ticket = capture(h.channel);
  const before = h.frames().length;
  const seq = h.channel.certify(ticket, geometry({ mode: 'layout', references: refs }));
  const emitted = h.frames().slice(before).filter(f => f.op === 'certificate');
  assert.ok(seq, 'bounded union fits this constructed case'); assert.equal(emitted.length, 1, 'certificate must never split');
  const line = JSON.stringify(emitted[0]) + '\n'; assert.ok(Buffer.byteLength(line) <= 65536);
  assert.equal(emitted[0].geometry.references.length, 512);
  for (const ref of emitted[0].geometry.references) {
    assert.equal(ref.rects.length, 1); const [x, y, w, ht] = ref.rects[0];
    for (const r of refs.find(r => r.seq === ref.seq).rects) assert.ok(x <= r[0] && y <= r[1] && x + w >= r[0] + r[2] && y + ht >= r[1] + r[3]);
  }
  t.diagnostic(`packed=${Buffer.byteLength(line)} bytes references=512 sourceBoxes=2048`);
});

test('production parser and HandHost entry acknowledge a complete inventory without drawing', options, async t => {
  const h = await based(t, true); const a = h.channel.admit(target, action(1)); let row = h.deliver();
  assert.equal(row.accepted, true); assert.deepEqual(row.retained, [a]);
  h.channel.invalidate('ambient'); row = h.deliver(); assert.equal(row.epoch, 1);
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(a)] })); row = h.deliver();
  assert.equal(row.accepted, true); assert.deepEqual(row.references, [a]);
  assert.equal(row.shown, false); assert.equal(row.windows, 0); assert.equal(row.layers, 0);
});

test('a loaded stage can draw before begin but an accepted producer certificate never restores it', options, async t => {
  const initial = dump([{ dumpStats: true }], 0, { loaded: true })[0];
  assert.equal(initial.loaded, true); assert.equal(initial.shown, true, 'fixture must be capable of drawing');
  const h = await based(t); const seq = h.channel.admit(target, action(1)); h.ack();
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(seq)] }));
  const row = dump(h.frames(), 0, { loaded: true }).at(-1);
  assert.equal(row.accepted, true); assert.equal(row.loaded, true);
  assert.equal(row.shown, false, 'accepted certificate must keep loaded character hidden');
  assert.equal(row.windows, 0); assert.equal(row.layers, 0);
});

test('production entry rejects partial inventories and preserves every admitted reference', options, async t => {
  const h = await based(t, true); const a = h.channel.admit(target, action(1)); h.deliver();
  const b = h.channel.admit(target, action(2)); h.deliver();
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(a), reference(b)] }));
  const lines = structuredClone(h.frames()); lines.at(-1).geometry.references.pop();
  const row = dump(lines).at(-1); assert.equal(row.accepted, false, 'partial inventory accepted'); assert.deepEqual(row.retained, [a, b]);
});

test('production entry rejects baseline resets while obligations remain', options, async t => {
  const h = await based(t, true); const seq = h.channel.admit(target, action(1)); h.deliver();
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(seq)] }));
  const lines = structuredClone(h.frames()); lines.at(-1).geometry = geometry();
  const row = dump(lines).at(-1); assert.equal(row.accepted, false, 'rebaseline with obligations accepted'); assert.deepEqual(row.retained, [seq]);
});

test('an old acquisition under a new transport sequence is refused by the production entry', options, async t => {
  const h = await based(t, true); const a = h.channel.admit(target, action(1)); h.deliver();
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(a)] })); h.deliver();
  const lines = structuredClone(h.frames()), old = structuredClone(lines.at(-1)); old.seq += 1; lines.push(old);
  const row = dump(lines).at(-1); assert.equal(row.accepted, false, 'old observation laundered under new sequence'); assert.deepEqual(row.retained, [a]);
});

test('same-bounds invalidation rejects an observation from the prior epoch immediately', options, async t => {
  const h = await based(t, true); const seq = h.channel.admit(target, action(1)); h.deliver();
  h.channel.invalidate('layout'); const invalidated = h.deliver();
  assert.equal(invalidated.shown, false);
  assert.equal(invalidated.epoch, 1);
  assert.deepEqual(invalidated.unmappedWindows, [[42, 7]], 'same-bounds invalidation must latch geometry hiding');
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(seq)] }));
  const lines = structuredClone(h.frames()); lines.at(-1).epoch = 0;
  const row = dump(lines).at(-1); assert.equal(row.accepted, false, 'same-bounds invalidation ignored'); assert.deepEqual(row.retained, [seq]);
});

test('lost baseline, host restart and reordered frames hide through the turn without resetting obligations', options, async t => {
  const h = await based(t, true); const a = h.channel.admit(target, action(1)); h.deliver();
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(a)] }));
  const lines = h.frames();
  const lost = dump(lines.filter(f => !(f.op === 'certificate' && f.geometry.mode === 'baseline'))).at(-1);
  assert.equal(lost.accepted, false); assert.equal(lost.baselineLost, true); assert.deepEqual(lost.retained, [a]);
  assert.equal(dump([lines.at(-1)]).at(-1).accepted, false, 'restart cannot recover without protected inventory');
  const swapped = [...lines]; [swapped[1], swapped[2]] = [swapped[2], swapped[1]]; dump(swapped, 65);
  const begin = { ...lines[0], seq: lines.at(-1).seq + 1 }; const row = dump([...lines, begin]).at(-1);
  assert.equal(row.accepted, false); assert.deepEqual(row.retained, [a]);
});

test('drags, window gaps, incarnation replacement and stale action prefixes retain refusal', options, async t => {
  for (const kind of ['drag', 'gap', 'replacement', 'prefix', 'session', 'turn']) {
    const h = await based(t, true); const a = h.channel.admit({ ...target, kind: kind === 'drag' ? 'drag' : 'click' }, action(1)); h.deliver();
    h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(a)] }));
    const lines = structuredClone(h.frames());
    if (kind === 'gap') lines.splice(-1, 0, { dumpVisible: false }, { dumpVisible: true });
    if (kind === 'replacement') lines.at(-1).geometry.incarnation = 'e'.repeat(32);
    if (kind === 'prefix') lines.at(-1).prefix.attempt += 1;
    if (kind === 'session') lines.at(-1).session = 'e'.repeat(32);
    if (kind === 'turn') lines.at(-1).turn = 'e'.repeat(32);
    const row = dump(lines).at(-1); assert.equal(row.accepted, false, kind); assert.equal(row.shown, false); assert.deepEqual(row.retained, [a]);
  }
});

test('an acquisition interval from before the input barrier cannot be recaptured as fresh', options, async t => {
  const h = await based(t, true); const a = h.channel.admit(target, action(1)); h.deliver();
  assert.equal(h.channel.capture({ start: 0, end: 0 }), undefined);
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(a)] }));
  const lines = structuredClone(h.frames()); lines.at(-1).acquired = [0, 0];
  assert.equal(dump(lines).at(-1).accepted, false);
});

test('the packed 512-reference inventory passes the real parser and production admission entry atomically', options, async t => {
  const h = await based(t), refs = [];
  for (let ordinal = 1; ordinal <= 512; ordinal++) {
    const seq = h.channel.admit(target, action(ordinal)); h.ack();
    refs.push(reference(seq, { rects: Array.from({ length: 4 }, (_, i) => [640.123456789 + i / 10, 680.123456789, 20.123456789, 20.123456789]) }));
  }
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: refs }));
  const frames = h.frames(), last = frames.at(-1);
  t.diagnostic(`unpacked=${Buffer.byteLength(JSON.stringify({ ...last, geometry: { ...last.geometry, references: refs } }) + '\n')} packed=${Buffer.byteLength(JSON.stringify(last) + '\n')}`);
  const row = dump(frames).at(-1);
  assert.equal(row.accepted, true); assert.equal(row.references.length, 512); assert.equal(row.retained.length, 512);
  assert.equal(row.shown, false); assert.equal(row.windows, 0); assert.equal(row.layers, 0);
  const partial = structuredClone(frames); partial.at(-1).geometry.references = partial.at(-1).geometry.references.slice(0, 256);
  assert.equal(dump(partial).at(-1).accepted, false);
  const overflow = { hand: last.hand, nonce: last.nonce, seq: last.seq + 1, session: last.session, turn: last.turn,
    op: 'admit', prefix: action(513), frame: handWireFrame(target), barrier: performance.now() };
  const refused = dump([...frames, overflow]).at(-1);
  assert.equal(refused.accepted, false); assert.equal(refused.references.length, 512);
  // The stage aggregates its geometry at capacity; the producer's sealed reference inventory remains intact.
  assert.equal(refused.targetMemories, 0); assert.deepEqual(refused.unmappedWindows, [[42, 7]]);
  assert.equal(refused.shown, false);
  h.ack(); assert.equal(h.channel.admit(target, action(513)), false);
  assert.equal(h.channel.state.admitted.length, 512); assert.equal(h.channel.state.poisoned, true);
});

for (const boundary of ['begin', 'admit', 'invalidate', 'certificate', 'end']) {
  test(`production transport refuses reordering and restart at the ${boundary} boundary`, options, async t => {
    const h = await based(t); const a = h.channel.admit(target, action(1)); h.ack();
    h.channel.invalidate('navigation'); h.ack();
    h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(a)] })); h.ack();
    h.channel.endTurn();
    const frames = h.frames();
    const at = boundary === 'certificate' ? frames.findLastIndex(f => f.op === boundary) : frames.findIndex(f => f.op === boundary);
    const other = at === frames.length - 1 ? at - 1 : at + 1;
    const reordered = structuredClone(frames); [reordered[at], reordered[other]] = [reordered[other], reordered[at]];
    const beforeFault = dump(reordered, 65);
    assert.ok(beforeFault.every(r => !r.shown && r.windows === 0 && r.layers === 0));
    if (boundary !== 'begin') assert.equal(dump(frames.slice(at)).at(-1).accepted, false);
    else assert.equal(dump([frames[1]]).at(-1).accepted, false, 'baseline cannot replace a lost turn binding');
  });
}

test('invalidations have independent epochs for layout, resize, typing, navigation, ambient changes and scroll', options, async t => {
  const h = await based(t, true); const a = h.channel.admit(target, action(1)); h.deliver();
  let epoch = 0;
  for (const reason of ['layout', 'resize', 'typing', 'navigation', 'ambient', 'scroll']) {
    h.channel.invalidate(reason); const row = h.deliver(); assert.equal(row.accepted, true); assert.equal(row.epoch, ++epoch);
    assert.deepEqual(row.retained, [a]); assert.equal(row.shown, false);
  }
});


test('sprite reloads and uncorrelated public terminal frames cannot clear protected obligations', options, async t => {
  for (const kind of ['reload', 'terminal']) {
    const h = await based(t, true); const a = h.channel.admit(target, action(1)); h.deliver();
    h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(a)] }));
    const frames = structuredClone(h.frames());
    frames.splice(-1, 0, kind === 'reload' ? { dumpReload: true } : { dumpPublic: {
      hand: 'status', nonce: frames[0].nonce, seq: a + 1, state: 'handback', pid: 42, windowId: 7, at: [650, 700] } });
    const row = dump(frames).at(-1); assert.equal(row.accepted, false); assert.deepEqual(row.retained, [a]); assert.equal(row.shown, false);
  }
});

test('client queue drops at every private boundary reach the production host as a persistent hide', options, async t => {
  for (const boundary of ['begin', 'admit', 'invalidate', 'certificate', 'end']) {
    const h = boundary === 'begin' ? await harness(t) : await based(t, true);
    let retained = [];
    if (boundary !== 'begin') { retained = [h.channel.admit(target, action(1))]; h.deliver(); }
    h.child.stdin.writableLength = 65537;
    if (boundary === 'begin') h.channel.beginTurn(turn);
    if (boundary === 'admit') h.channel.admit(target, action(2));
    if (boundary === 'invalidate') h.channel.invalidate('resize');
    if (boundary === 'certificate') h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: retained.map(seq => reference(seq)) }));
    if (boundary === 'end') h.channel.endTurn();
    const row = dump(h.frames()).at(-1);
    assert.equal(row.accepted, false, boundary); assert.equal(row.shown, false); assert.deepEqual(row.retained, retained);
    assert.equal(row.windows, 0); assert.equal(row.layers, 0); assert.equal(h.channel.state.poisoned, true);
  }
});

test('a lost admission acknowledgement retains the host inventory while the real client refuses capture', options, async t => {
  const h = await based(t, true), seq = h.channel.admit(target, action(1));
  const admitted = dump(h.frames()).at(-1); assert.equal(admitted.accepted, true); assert.deepEqual(admitted.retained, [seq]);
  assert.equal(h.channel.state.admitted.length, 0);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const hidden = dump(h.frames()).at(-1); assert.equal(hidden.accepted, false); assert.deepEqual(hidden.retained, [seq]);
  assert.equal(hidden.shown, false); assert.equal(capture(h.channel), undefined); assert.equal(h.channel.state.poisoned, true);
});

for (const count of [2, 50]) {
  test(`${count} consecutive clean turns return client and one host to idle with fresh sessions`, options, async t => {
    const h = await harness(t), sessions = new Set();
    for (let index = 1; index <= count; index++) {
      assert.ok(h.channel.beginTurn(index.toString(16).padStart(32, '0'))); h.ack();
      sessions.add(h.channel.state.session);
      h.channel.certify(capture(h.channel), geometry()); h.ack();
      const seq = h.channel.admit(target, action(1)); h.ack();
      assert.ok(h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(seq)] }))); h.ack();
      assert.ok(h.channel.endTurn()); h.ack();
      assert.equal(h.channel.state.session, undefined); assert.equal(h.channel.state.turn, undefined);
      assert.equal(h.channel.state.active, false); assert.equal(h.channel.state.poisoned, false);
      h.client.send({ hand: 'status', state: 'handback', ...target });
    }
    assert.equal(sessions.size, count);
    const frames = h.child.lines.filter(f => ['stage-producer', 'status'].includes(f.hand));
    const rows = dump(frames, 0, { reader: true, loaded: true });
    assert.equal(rows.length, count * 5); assert.ok(rows.every(r => r.accepted));
    const ends = rows.filter(r => r.op === 'end'); assert.equal(ends.length, count);
    for (const row of ends) {
      assert.equal(row.active, false); assert.equal(row.failed, false); assert.equal(row.sessionState, null);
      assert.equal(row.collectionOnly, false);
      assert.equal(row.turnState, null); assert.deepEqual(row.retained, []);
    }
  });
}

test('public status, narration and pause use the shared allocator without admitting targets during an open turn', options, async t => {
  const h = await based(t), seq = h.channel.admit(target, action(1)); h.ack();
  for (const state of ['waiting', 'thinking', 'paused', 'done']) {
    h.client.send({ hand: 'status', state, ok: true, ...target, say: 'Checking the result.' }); h.ack();
    assert.equal(h.channel.state.poisoned, false);
  }
  const frames = h.frames();
  assert.equal(frames.filter(f => f.op === 'public').length, 4);
  assert.ok(frames.every((f, i) => !i || f.seq > frames[i - 1].seq));
  assert.equal(frames.find(f => f.op === 'public').frame.say, 'Checking the result.');
  const row = dump(frames).at(-1);
  assert.equal(row.accepted, true); assert.equal(row.failed, false); assert.deepEqual(row.retained, [seq]);
  assert.equal(h.channel.state.active, true);
});

test('cursor statuses retain the private admission anchor during healthy and poisoned turns', options, async t => {
  const h = await based(t), seq = h.channel.admit(target, action(1)); h.ack();
  h.client.cursor({ type: 'status', state: 'waiting', say: 'Checking the result.' }); h.ack();
  assert.equal(h.frames().at(-1).op, 'public'); assert.equal(h.frames().at(-1).frame.state, 'waiting');
  assert.deepEqual(h.frames().at(-1).frame.at, target.at);
  h.client.send(target);
  h.client.cursor({ type: 'status', state: 'thinking' }); h.ack();
  const row = dump(h.frames()).at(-1);
  assert.equal(row.accepted, true); assert.equal(row.failed, true); assert.deepEqual(row.retained, [seq]);
});

test('point-free status and narration retain the ring anchor within healthy and poisoned turns', options, async t => {
  const h = await based(t), seq = h.channel.admit(target, action(1)); h.ack();
  for (const poisoned of [false, true]) {
    if (poisoned) h.client.send(target);
    h.client.send({ hand: 'status', state: 'thinking', ...target }); h.ack();
    h.client.send({ hand: 'status', state: 'waiting', pid: target.pid, windowId: target.windowId, say: 'Checking the result.' }); h.ack();
  }
  const row = dump(h.frames(), 0, { loaded: true }).at(-1);
  assert.equal(row.ringPlans, 4, 'point-free statuses must still plan ring and narration art');
  assert.deepEqual(row.retained, [seq]); assert.equal(row.shown, false); assert.equal(row.windows, 0); assert.equal(row.layers, 0);
});

test('public target geometry poisons only its turn while status flows and the attributed terminal releases it', options, async t => {
  const h = await based(t, true), seq = h.channel.admit(target, action(1)); h.deliver();
  h.client.send({ ...target, hand: 'aim' });
  assert.equal(h.channel.state.poisoned, true); assert.equal(h.channel.endTurn(), false);
  assert.equal(capture(h.channel), undefined);
  assert.equal(h.channel.certify({}, geometry()), false);
  for (const state of ['waiting', 'thinking', 'paused']) {
    h.client.send({ hand: 'status', state, ...target, say: 'Checking the result.' });
    const row = h.deliver(); assert.equal(row.accepted, true); assert.equal(row.failed, true);
    assert.deepEqual(row.retained, [seq]); assert.equal(row.shown, false);
  }
  h.client.send({ hand: 'status', state: 'handback', ...target });
  const ended = h.deliver();
  assert.equal(ended.active, false); assert.equal(ended.failed, false); assert.deepEqual(ended.retained, []);
  assert.equal(h.channel.state.active, false); assert.equal(h.channel.state.poisoned, false);
  assert.ok(h.channel.beginTurn('f'.repeat(32))); const next = h.deliver();
  assert.equal(next.accepted, true); assert.notEqual(next.session, ended.session);
  assert.ok(h.channel.certify(capture(h.channel), geometry())); h.deliver();
  assert.ok(h.channel.admit(target, action(1))); assert.equal(h.deliver().baselineLost, false);
});

test('a slow admission ack poisons its turn, preserves targets and ignores that ended session in the next turn', options, async t => {
  const h = await based(t), seq = h.channel.admit(target, action(1)), delayed = h.frames().at(-1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(h.channel.state.poisoned, true); assert.equal(h.channel.endTurn(), false);
  h.client.send({ hand: 'status', state: 'thinking', ...target }); h.ack();
  h.client.send({ hand: 'status', state: 'handback', ...target }); h.ack();
  assert.equal(h.channel.state.active, false);
  assert.ok(h.channel.beginTurn('f'.repeat(32))); h.ack();
  h.ack(delayed); assert.equal(h.channel.state.poisoned, false, 'late old ack cannot poison new turn');
  h.channel.certify(capture(h.channel), geometry()); h.ack();
  const frames = h.frames(), rows = dump(frames, 0, { loaded: true });
  const fault = rows.find(r => r.op === 'fault');
  assert.equal(fault.failed, true); assert.deepEqual(fault.retained, [seq]);
  assert.equal(rows.at(-1).accepted, true); assert.equal(rows.at(-1).failed, false);
});

test('after poison ends the next turn cannot admit a certificate without a fresh baseline', options, async t => {
  const h = await based(t); h.client.send(target);
  h.client.send({ hand: 'status', state: 'handback', ...target }); h.ack();
  assert.ok(h.channel.beginTurn('f'.repeat(32))); h.ack();
  const seq = h.channel.admit(target, action(1)); h.ack();
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(seq)] }));
  const row = dump(h.frames()).at(-1);
  assert.equal(row.accepted, false); assert.equal(row.baselineLost, true); assert.deepEqual(row.retained, [seq]);
});

test('the host retains only the last 512 ended tokens and keeps accepting turns after 512', options, () => {
  const nonce = 'a'.repeat(64), frames = [], token = n => n.toString(16).padStart(32, '0');
  let seq = 0;
  const frame = (op, n) => ({ hand: 'stage-producer', nonce, seq: ++seq, session: token(n + 1000), turn: token(n), op,
    ...op === 'begin' ? { barrier: n } : {} });
  for (let index = 1; index <= 515; index++) frames.push(frame('begin', index), frame('end', index));
  const rows = dump(frames), last = rows.at(-1);
  assert.ok(rows.every(r => r.accepted)); assert.equal(last.recentEnded, 512); assert.equal(last.oldestEnded, token(4));
  assert.equal(dump([...frames, frame('begin', 515)]).at(-1).accepted, false, 'recent token reuse refused');
  assert.equal(dump([...frames, frame('begin', 1)]).at(-1).accepted, true, 'evicted token no longer blocks long sessions');
});

test('a terminal queued before begin cannot clear newer obligations when its stage drawing arrives', options, async t => {
  const h = await based(t), seq = h.channel.admit(target, action(1)); h.ack();
  const terminal = { hand: 'status', nonce: h.frames()[0].nonce, seq: 0, state: 'handback', pid: 42, windowId: 7, at: [650, 700] };
  for (const identity of [{}, { session: 'e'.repeat(32), turn }, { session: h.channel.state.session, turn: 'e'.repeat(32) }]) {
    const row = dump([{ dumpQueueTerminal: terminal, ...identity }, ...h.frames(), { dumpDrawQueued: true }], 0, { loaded: true }).at(-1);
    assert.deepEqual(row.retained, [seq], 'delayed terminal must retain newer turn obligations');
    assert.equal(row.active, true); assert.equal(row.shown, false);
  }
});

test('rejected attempt ordinals retain their target until the attributed public terminal', options, async t => {
  const h = await based(t), seq = h.channel.admit(target, action(1)); h.ack();
  const frames = structuredClone(h.frames()); frames.at(-1).prefix.ordinal = 2;
  const row = dump(frames).at(-1);
  assert.equal(row.accepted, false); assert.deepEqual(row.retained, [seq]);
});

test('real stdin reader refuses an oversize line and reordered private frames without drawing', options, async t => {
  const h = await based(t); h.channel.admit(target, action(1));
  const frames = h.frames(), swapped = [...frames]; [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  for (const raw of [JSON.stringify(frames[0]) + '\n' + ' '.repeat(65536) + '\n',
    swapped.map(JSON.stringify).join('\n') + '\n', ' '.repeat(131073)]) {
    const rows = dump([], 65, { reader: true, loaded: true, raw });
    assert.equal(rows.at(-1).readerFault, true); assert.equal(rows.at(-1).shown, false);
  }
});

test('a throwing transport during disconnect cleans up once without reentering die', async t => {
  const h = await based(t);
  h.child.stdin.write = () => { throw Object.assign(Error('closed'), { code: 'EPIPE' }); };
  h.child.stdout.emit('end');
  assert.equal(h.traces.filter(r => r.event === 'hand-off').length, 1);
  assert.equal(h.channel.state.poisoned, true);
});

for (const ordering of ['end-terminal', 'terminal-end', 'end-ring', 'terminal-status']) {
  test(`end-to-ack window ${ordering} accepts the next begin through the real reader`, options, async t => {
    const h = await based(t), seq = h.channel.admit(target, action(1)); h.ack();
    const terminal = { hand: 'status', state: 'handback', ...target };
    if (ordering.startsWith('terminal')) h.client.send(terminal); else assert.ok(h.channel.endTurn());
    const delayed = h.frames().at(-1);
    if (ordering === 'terminal-end') assert.equal(h.channel.endTurn(), false);
    h.client.send(ordering.endsWith('terminal') || ordering === 'terminal-end' ? terminal :
      { hand: 'status', state: 'thinking', ...target, say: 'Checking the result.' });
    assert.notEqual(h.child.lines.at(-1).hand, 'stage-producer', 'terminal written means later frames use the public wire');
    assert.ok(h.channel.beginTurn('f'.repeat(32))); const next = h.frames().at(-1);
    h.ack(delayed); assert.equal(h.channel.state.poisoned, false); h.ack(next);
    h.channel.certify(capture(h.channel), geometry()); h.ack();
    const frames = h.child.lines.filter(f => ['stage-producer', 'status', 'act'].includes(f.hand));
    const rows = dump(frames, 0, { reader: true, loaded: true });
    const begin = rows.find(r => r.seq === next.seq);
    assert.equal(begin.accepted, true); assert.equal(begin.failed, false); assert.equal(rows.at(-1).accepted, true);
    assert.ok(seq > 0);
  });
}

test('50 consecutive turns with frames before each ack accept every next begin', options, async t => {
  const h = await harness(t);
  let old;
  for (let i = 1; i <= 51; i++) {
    assert.ok(h.channel.beginTurn(i.toString(16).padStart(32, '0')));
    const begin = h.frames().at(-1);
    if (old) h.ack(old);
    h.ack(begin);
    h.channel.certify(capture(h.channel), geometry()); h.ack();
    h.channel.admit(target, action(1)); h.ack();
    if (i % 2) h.channel.endTurn(); else h.client.send({ hand: 'status', state: 'handback', ...target });
    old = h.frames().at(-1);
    h.client.send({ hand: 'status', state: 'handback', ...target });
    h.client.send({ hand: 'status', state: 'thinking', ...target });
  }
  const frames = h.child.lines.filter(f => ['stage-producer', 'status'].includes(f.hand));
  const rows = dump(frames, 0, { reader: true, loaded: true });
  assert.equal(rows.filter(r => r.op === 'begin' && r.accepted).length, 51);
  assert.ok(rows.every(r => r.accepted && !r.failed));
});

test('the host treats a just-ended session as public and never adopts it as failed', options, async t => {
  const h = await based(t); h.channel.admit(target, action(1)); h.ack();
  h.channel.endTurn(); const end = h.frames().at(-1);
  const late = { ...end, seq: end.seq + 1, op: 'public', frame: handWireFrame({ hand: 'status', state: 'handback', ...target }) };
  const next = { ...end, seq: end.seq + 2, op: 'begin', session: 'e'.repeat(32), turn: 'f'.repeat(32), barrier: performance.now() };
  const rows = dump([...h.frames(), late, next], 0, { reader: true, loaded: true });
  assert.equal(rows.at(-2).failed, false, 'ended identity must never poison host ownership');
  assert.equal(rows.at(-2).ringSession, null, 'an ended session uses the same idle ring path as a plain public frame');
  assert.equal(rows.at(-2).active, false); assert.equal(rows.at(-1).accepted, true);
  const unknown = { ...late, session: '9'.repeat(32), turn: '8'.repeat(32) };
  assert.equal(dump([...h.frames(), unknown]).at(-1).failed, true, 'unknown session still fails closed');
});

for (const terminal of ['end', 'public']) {
  test(`a withheld ${terminal} ack past one second cannot refuse the next turn`, options, async t => {
    const h = await based(t); h.channel.admit(target, action(1)); h.ack();
    if (terminal === 'end') h.channel.endTurn(); else h.client.send({ hand: 'status', state: 'handback', ...target });
    const old = h.frames().at(-1);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(h.channel.state.poisoned, true);
    assert.ok(h.channel.beginTurn('f'.repeat(32)), 'late terminal ack must not block next begin');
    const begin = h.frames().at(-1); h.ack(old); h.ack(begin);
    assert.equal(h.channel.state.poisoned, false);
    h.channel.certify(capture(h.channel), geometry()); h.ack();
    h.channel.admit(target, action(1)); h.ack();
    const rows = dump(h.frames(), 0, { reader: true, loaded: true });
    assert.equal(rows.find(r => r.seq === begin.seq).accepted, true);
    assert.equal(rows.at(-1).baselineLost, false); assert.equal(rows.at(-1).accepted, true);
  });
}

test('a late terminal ack closes its own poisoned turn before the next begin', async t => {
  const h = await based(t); h.channel.endTurn(); const old = h.frames().at(-1);
  await new Promise(resolve => setTimeout(resolve, 1100)); h.ack(old);
  assert.equal(h.channel.state.active, false); assert.ok(h.channel.beginTurn('f'.repeat(32)));
});

test('status drawing through ringDrew adds no required reference and preserves the next certificate', options, async t => {
  const h = await based(t), seq = h.channel.admit(target, action(1)); h.ack();
  for (const state of ['thinking', 'waiting', 'error', 'done']) {
    h.client.send({ hand: 'status', state, ok: true, ...target, say: 'Checking the result.' }); h.ack();
  }
  h.channel.certify(capture(h.channel), geometry({ mode: 'layout', references: [reference(seq)] }));
  const row = dump(h.frames(), 0, { loaded: true }).at(-1);
  assert.equal(row.ringPlans, 4); assert.deepEqual(row.retained, [seq]); assert.equal(row.accepted, true);
  assert.equal(row.ringSession, h.channel.state.session, 'production public frames must carry their session into ringDrew');
  assert.equal(row.ringTurn, turn, 'production public frames must carry their logical turn into ringDrew');
});

test('an attributed public terminal held at ring delivery cannot clear the next production turn', options, async t => {
  const h = await based(t); h.channel.admit(target, action(1)); h.ack();
  h.client.send({ hand: 'status', state: 'handback', ...target });
  const terminal = h.frames().at(-1), before = h.frames().slice(0, -1);
  assert.ok(h.channel.beginTurn('f'.repeat(32))); h.ack();
  h.channel.certify(capture(h.channel), geometry()); h.ack();
  const seq = h.channel.admit(target, action(1)); h.ack();
  const next = h.frames().slice(before.length + 1);
  const rows = dump([...before, { dumpHoldRing: true }, terminal, ...next, { dumpDrawQueued: true }], 0, { loaded: true });
  const ended = rows.find(r => r.seq === terminal.seq);
  assert.equal(ended.ringSession, terminal.session); assert.equal(ended.ringTurn, terminal.turn);
  assert.deepEqual(rows.at(-1).retained, [seq]); assert.equal(rows.at(-1).active, true);
  assert.equal(rows.at(-1).failed, false); assert.equal(rows.at(-1).shown, false);
  assert.equal(rows.at(-1).stageEvent, 'thinking', 'a stale ring plan must not overwrite the newer event');
});

test('ringDrew cannot complete a producer turn even with a matching injected identity', options, async t => {
  const h = await based(t), seq = h.channel.admit(target, action(1)); h.ack();
  const terminal = { hand: 'status', nonce: h.frames()[0].nonce, seq: 100, state: 'handback', pid: 42, windowId: 7, at: [650, 700] };
  const identity = { session: h.channel.state.session, turn };
  for (const [field, value] of [['session', 'e'.repeat(32)], ['turn', 'e'.repeat(32)], ['match', null]]) {
    const attributed = field === 'match' ? identity : { ...identity, [field]: value };
    const row = dump([...h.frames(), { dumpQueueTerminal: terminal, ...attributed }, { dumpDrawQueued: true }], 0, { loaded: true }).at(-1);
    assert.deepEqual(row.retained, [seq], field + ' cannot release at drawing time');
    assert.equal(row.windows, 0); assert.equal(row.layers, 0);
  }
});

test('logical turn tokens reject old statuses but preserve old action targets and a dead-host terminal closes the client turn', async t => {
  const h = await based(t); h.channel.endTurn(); h.ack();
  h.channel.beginTurn('f'.repeat(32)); h.ack();
  const before = h.child.lines.length;
  h.client.send({ hand: 'status', state: 'handback', ...target, turn });
  h.client.cursor({ type: 'status', state: 'handback', turn });
  assert.equal(h.child.lines.length, before);
  h.client.send({ ...target, turn });
  assert.equal(h.child.lines.at(-1).hand, 'act'); assert.equal(h.channel.state.poisoned, true);
  assert.equal(h.channel.state.active, true);
  h.child.stdout.emit('end');
  h.client.send({ hand: 'status', state: 'handback', ...target, turn: 'f'.repeat(32) });
  assert.equal(h.channel.state.active, false); assert.equal(h.channel.state.turn, undefined);
});

test('a cursor terminal lost on a dead host closes only its attributed logical turn', async t => {
  const h = await based(t); h.channel.admit(target, action(1)); h.ack();
  h.child.stdout.emit('end');
  h.client.cursor({ type: 'status', state: 'done', call });
  assert.equal(h.channel.state.active, true, 'call completion is not a turn end');
  h.client.cursor({ type: 'status', state: 'handback', turn: 'f'.repeat(32) });
  assert.equal(h.channel.state.active, true, 'wrong turn cannot close client state');
  h.client.cursor({ type: 'status', state: 'handback', turn });
  assert.equal(h.channel.state.active, false);
});

test('ordinary target geometry in the end-to-ack window retains base protection', options, async t => {
  const h = await based(t); h.channel.endTurn();
  h.client.send(target);
  const frame = h.child.lines.at(-1);
  assert.equal(frame.hand, 'act');
  const rows = dump([...h.frames(), frame, { dumpStats: true }], 0, { loaded: true });
  assert.deepEqual(rows.at(-1).retained, [frame.seq]); assert.equal(rows.at(-1).failed, false);
  const end = h.frames().at(-1), admit = { ...end, seq: frame.seq + 1, op: 'admit', prefix: action(1),
    barrier: performance.now(), frame: handWireFrame(target) };
  const legacy = dump([...h.frames(), admit], 0, { loaded: true }).at(-1);
  assert.deepEqual(legacy.retained, [admit.seq]); assert.equal(legacy.active, false); assert.equal(legacy.failed, false);
});

test('ordinary status targets compare all six chret4 states, including paused and changed bounds', options, () => {
  const nonce = 'a'.repeat(64);
  // 73bc6b73 StageRuntime.receive admitted every target: watermark, contributor, memory, and bounds veto.
  for (const paused of [false, true]) {
    for (const state of ['thinking', 'waiting', 'error', 'done', 'paused', 'handback']) {
      for (const moved of [false, true]) {
        const first = { ...handWireFrame({ hand: 'status', state: 'thinking', ...target }), nonce, seq: 1 };
        const next = { ...handWireFrame({ hand: 'status', state, ok: true, ...target, say: 'Checking the result.',
          windowRect: moved ? [201, 500, 900, 350] : bounds }), nonce, seq: 2 };
        const row = dump([{ dumpPaused: paused }, first, next, { dumpStats: true }], 0, { loaded: true }).at(-1);
        const terminal = state === 'handback', ignored = state === 'paused' && !paused;
        assert.deepEqual(row.retained, terminal ? [] : ignored ? [1] : [1, 2], `${state} paused=${paused} moved=${moved}: base contributors`);
        assert.equal(row.watermark, terminal ? null : ignored ? 1 : 2, 'base watermark');
        assert.equal(row.targetMemories, terminal ? 0 : 1, 'exact base memory count');
        assert.deepEqual(row.targetBoxes, terminal ? [] : [[602, 652, 96, 96]], 'exact protected boxes');
        assert.deepEqual(row.unmappedWindows, moved && !terminal && !ignored ? [[42, 7]] : [], 'base bounds mismatch must invalidate');
        assert.equal(row.active, false); assert.equal(row.failed, false);
        assert.equal(row.windows, 0); assert.equal(row.layers, 0);
      }
    }
  }
});

test('closing statuses shed inherited targets while ordinary statuses and point-free narration keep their meanings', options, async t => {
  const h = await based(t); h.channel.admit(target, action(1)); h.ack();
  h.channel.endTurn(); const end = h.frames().at(-1);
  h.client.send({ hand: 'status', state: 'thinking', ...target, say: 'Checking the result.' });
  const status = h.child.lines.at(-1);
  assert.equal(status.hand, 'status'); assert.equal(status.at, undefined); assert.equal(status.windowRect, undefined);
  h.channel.beginTurn('f'.repeat(32)); const begin = h.frames().at(-1);
  const rows = dump([...h.frames().filter(f => f.seq <= end.seq), status, begin], 0, { reader: true, loaded: true });
  assert.equal(rows.at(-1).accepted, true, 'an inherited status anchor cannot block the next begin');
  const ordinary = { ...handWireFrame({ hand: 'status', state: 'thinking', ...target }), nonce: end.nonce, seq: 100 };
  const narration = { ...ordinary, seq: 101, state: 'waiting', say: 'Checking the result.' };
  delete narration.at; delete narration.windowRect;
  const row = dump([ordinary, narration, { dumpStats: true }], 0, { loaded: true }).at(-1);
  assert.equal(row.ringPlans, 2); assert.deepEqual(row.retained, [100], 'point-free narration must not invent a target');
});

test('ended-session frames during a newer open turn cannot end, clean, release or draw it', options, async t => {
  const h = await based(t); h.channel.admit(target, action(1)); h.ack(); h.channel.endTurn();
  const ended = h.frames().at(-1);
  h.channel.beginTurn('f'.repeat(32)); h.ack(); h.channel.certify(capture(h.channel), geometry()); h.ack();
  const seq = h.channel.admit(target, action(1)); h.ack();
  const current = h.frames().at(-1), start = current.seq + 1;
  const terminal = state => ({ hand: 'status', state, ...target });
  const variants = [
    { op: 'admit', prefix: action(2), barrier: performance.now(), frame: handWireFrame({ ...target, hand: 'aim' }), protects: true },
    { op: 'admit', prefix: action(2), barrier: performance.now(), frame: handWireFrame(target), protects: true },
    ...['thinking', 'waiting', 'error', 'done'].map(state => ({ op: 'public', frame: handWireFrame({ ...terminal(state), ok: true }), protects: true })),
    ...['handback', 'done'].map(state => ({ op: 'public', frame: handWireFrame(terminal(state)), protects: false })),
    { op: 'end' }, { op: 'fault' }, { op: 'begin', barrier: performance.now() },
    { op: 'invalidate', epoch: 1, after: -1, prefix: null, reason: 'ambient', barrier: performance.now() },
    { ...h.frames().find(f => f.op === 'certificate'), op: 'certificate' },
  ];
  for (const poisoned of [false, true]) {
    for (const candidate of variants) {
      const { protects = false, ...body } = candidate;
      const priorFault = { ...current, op: 'fault', seq: start };
      delete priorFault.frame; delete priorFault.prefix; delete priorFault.barrier;
      const late = { ...body, hand: ended.hand, nonce: ended.nonce, session: ended.session, turn: ended.turn, seq: start + 1 };
      const rows = dump([...h.frames(), ...poisoned ? [priorFault] : [], late], 0, { reader: true, loaded: true });
      const row = rows.at(-1);
      assert.equal(row.active, true, body.op + ' must not end the newer turn');
      assert.equal(row.sessionState, current.session); assert.equal(row.turnState, current.turn);
      assert.equal(row.failed, poisoned || protects, body.op + ' cannot clean the newer turn');
      assert.deepEqual(row.references, [seq]);
      assert.deepEqual(row.retained, protects ? [seq, late.seq] : [seq], body.op + ' must preserve all target protection');
      assert.equal(row.collectionOnly, true); assert.equal(row.shown, false);
      assert.equal(row.windows, 0); assert.equal(row.layers, 0);
    }
  }
});

test('a rejected end ack keeps protection until a poisoned public terminal closes that session', options, async t => {
  const h = await based(t); const seq = h.channel.admit(target, action(1)); h.ack();
  h.channel.endTurn(); const end = h.frames().at(-1);
  // Host rejects this ordinal while the client is still healthy with no ack pending before end.
  const hostFrames = () => h.frames().map(f => f.seq === seq ? { ...f, prefix: action(2) } : f);
  const rejected = dump(hostFrames(), 0, { reader: true, loaded: true }).at(-1);
  assert.equal(rejected.accepted, false); assert.equal(rejected.active, true);
  assert.equal(rejected.failed, true); assert.deepEqual(rejected.retained, [seq]);
  h.ack(end, false); assert.equal(h.channel.state.poisoned, true);
  const later = [];
  for (const hand of ['act', 'aim']) {
    h.client.send({ ...target, hand, at: [300, 600], turn });
    const frame = h.child.lines.at(-1); later.push(frame);
    assert.equal(frame.hand, hand, 'a genuinely rejected host end must not drop targets');
  }
  const allHostFrames = () => h.child.lines.filter(f => ['stage-producer', 'act', 'aim'].includes(f.hand))
    .map(f => f.seq === seq ? { ...f, prefix: action(2) } : f);
  const protectedRow = dump([...allHostFrames(), { ...end, op: 'fault', seq: later.at(-1).seq + 1 }], 0, { reader: true, loaded: true }).at(-1);
  assert.deepEqual(protectedRow.retained, [seq, ...later.map(f => f.seq)]);
  assert.equal(protectedRow.shown, false); assert.equal(protectedRow.active, true);
  h.client.send({ hand: 'status', state: 'handback', ...target, turn });
  const terminal = h.child.lines.at(-1);
  assert.equal(terminal.hand, 'stage-producer', 'poison must override ending when delivering the terminal');
  assert.equal(terminal.op, 'public'); assert.equal(terminal.session, end.session); assert.equal(terminal.turn, turn);
  const closed = dump(allHostFrames(), 0, { reader: true, loaded: true }).at(-1);
  assert.equal(closed.accepted, true); assert.equal(closed.active, false); assert.equal(closed.failed, false);
  assert.deepEqual(closed.retained, []); h.ack(terminal);
  assert.equal(h.channel.state.active, false);
  assert.ok(h.channel.beginTurn('f'.repeat(32))); h.ack();
  assert.ok(h.channel.certify(capture(h.channel), geometry())); h.ack();
  const next = dump(hostFrames(), 0, { reader: true, loaded: true }).at(-1);
  assert.equal(next.accepted, true); assert.equal(next.failed, false); assert.equal(next.baselineLost, false);
});

test('clean producer terminal state is applied before finish clears ownership in production order', options, async t => {
  for (const state of ['done', 'handback']) {
    const h = await based(t); h.channel.admit(target, action(1)); h.ack();
    h.client.send({ hand: 'status', state, ...target, turn });
    for (const hold of [false, true]) {
      const frames = h.frames(), row = dump([...frames.slice(0, -1), { dumpHoldRing: hold }, frames.at(-1)], 0, { loaded: true }).at(-1);
      assert.equal(row.accepted, true); assert.equal(row.active, false); assert.equal(row.sessionState, null);
      assert.deepEqual(row.retained, []);
      assert.equal(row.eventAtAck, state, 'completion must use the actual terminal before ring delivery');
      assert.equal(row.reactionAtAck, state, 'terminal reaction must match the terminal');
      assert.equal(row.windows, 0); assert.equal(row.layers, 0);
    }
  }
});

test('successive producer terminals update state without the dump visibility probe or another admission', options, async t => {
  const h = await based(t); h.channel.admit(target, action(1)); h.ack();
  const expected = [];
  for (const [index, state] of ['handback', 'done', 'handback', 'done'].entries()) {
    if (index) {
      h.channel.beginTurn((index + 1).toString(16).padStart(32, '0')); h.ack();
      h.channel.certify(capture(h.channel), geometry()); h.ack();
    }
    h.client.send({ hand: 'status', state, ...target, turn: h.channel.state.turn });
    expected.push({ seq: h.frames().at(-1).seq, state }); h.ack();
  }
  const rows = dump([{ dumpProbe: false }, ...h.frames()], 0, { loaded: true });
  for (const terminal of expected) {
    const row = rows.find(r => r.seq === terminal.seq);
    assert.equal(row.accepted, true); assert.equal(row.active, false); assert.deepEqual(row.retained, []);
    assert.equal(row.eventAtAck, terminal.state, 'an old terminal is not the new turn terminal');
    assert.equal(row.reactionAtAck, terminal.state);
    assert.equal(row.windows, 0); assert.equal(row.layers, 0);
  }
});

for (const acknowledgement of ['late', 'accepted:false']) {
  test(`poisoned closing ${acknowledgement} sends acts and aims plain and the reader admits every target after end`, options, async t => {
    const h = await based(t); h.channel.admit(target, action(1)); h.ack();
    h.channel.endTurn(); const end = h.frames().at(-1);
    if (acknowledgement === 'late') await new Promise(resolve => setTimeout(resolve, 1100));
    else h.ack(end, false);
    assert.equal(h.channel.state.poisoned, true);
    const sent = [];
    for (const hand of ['act', 'aim']) {
      h.client.send({ ...target, hand, at: hand === 'act' ? [300, 600] : [950, 750], turn });
      const frame = h.child.lines.at(-1); sent.push(frame);
      assert.equal(frame.hand, hand, 'a target must reach the plain public wire');
    }
    const frames = h.child.lines.filter(f => ['stage-producer', 'act', 'aim'].includes(f.hand));
    // The host processes the end before these later frames, whatever happens to its ack in transport.
    const row = dump([...frames, { ...end, seq: sent.at(-1).seq + 1, op: 'fault' }], 0, { reader: true, loaded: true }).at(-1);
    assert.equal(row.active, false); assert.equal(row.collectionOnly, false);
    assert.deepEqual(row.retained, sent.map(f => f.seq), 'closing the old turn cannot lose later target admissions');
    assert.deepEqual(row.targetBoxes, [[252, 552, 96, 96], [902, 702, 96, 96]]);
    assert.equal(row.protectedIntersections, 0, 'hidden stage installs no drawing; retained target boxes are checked above');
    assert.equal(row.windows, 0); assert.equal(row.layers, 0);
    if (acknowledgement === 'late') h.ack(end);
  });
}

test('an open producer public target falls back plain when private routing refuses it', options, async t => {
  const h = await based(t), seq = h.channel.admit(target, action(1)); h.ack();
  h.client.send({ ...target, hand: 'aim', at: [300, 600] });
  const frame = h.child.lines.at(-1);
  assert.equal(frame.hand, 'aim'); assert.equal(h.channel.state.poisoned, true);
  const row = dump([...h.child.lines.filter(f => ['stage-producer', 'aim'].includes(f.hand)),
    { ...h.frames().at(-1), seq: frame.seq + 1, op: 'fault' }], 0, { reader: true, loaded: true }).at(-1);
  assert.deepEqual(row.retained, [seq, frame.seq]); assert.equal(row.shown, false);
});

test('a poisoned closing terminal bypasses 512 pending receipts without growing the queue', options, async t => {
  const h = await based(t); h.channel.endTurn(); h.ack(h.frames().at(-1), false);
  for (let i = 0; i < 512; i++) h.client.send({ hand: 'status', state: 'thinking', ...target });
  assert.equal(h.channel.state.pending, 512);
  h.child.stdin.writableLength = 65537;
  h.client.send({ hand: 'status', state: 'handback', ...target, turn });
  const terminal = h.child.lines.at(-1);
  assert.equal(terminal.op, 'public'); assert.equal(terminal.frame.state, 'handback', 'terminal cannot be refused at capacity');
  assert.equal(h.channel.state.pending, 512, 'closing receipt is outside the bounded pending queue');
  const row = dump(h.frames(), 0, { reader: true, loaded: true }).at(-1);
  assert.equal(row.active, false); assert.equal(row.failed, false);
  h.ack(terminal); assert.equal(h.channel.state.active, false); assert.equal(h.channel.state.pending, 0);
  assert.ok(h.channel.beginTurn('f'.repeat(32)) === false, 'a congested pipe still refuses an ordinary private begin');
});

test('stale send and cursor action targets reach the reader and poison without ending its current turn', options, async t => {
  const h = await based(t); h.channel.admit(target, action(1)); h.ack();
  h.client.send({ ...target, turn: 'e'.repeat(32), at: [300, 600] });
  const act = h.child.lines.at(-1); assert.equal(act.hand, 'act');
  h.client.cursor({ type: 'action', phase: 'aim', kind: 'click', turn: 'e'.repeat(32),
    point: [950, 750], window: { pid: 42, id: 7, rect: bounds } });
  const aim = h.child.lines.at(-1); assert.equal(aim.hand, 'aim');
  const row = dump([...h.child.lines.filter(f => ['stage-producer', 'act', 'aim'].includes(f.hand)),
    { ...h.frames().at(-1), seq: aim.seq + 1, op: 'fault' }], 0, { reader: true, loaded: true }).at(-1);
  assert.equal(row.active, true); assert.equal(row.turnState, turn); assert.equal(row.failed, true);
  assert.deepEqual(row.retained, [h.frames().find(f => f.op === 'admit').seq, act.seq, aim.seq]);
  assert.equal(row.shown, false); assert.equal(row.protectedIntersections, 0);
});

test('target writes under backpressure and during pause still reach ordinary host admission', options, async t => {
  const h = await harness(t);
  const nonce = h.child.lines.find(f => f.hand === 'menu').nonce, token = '1'.repeat(32);
  for (const phase of ['request', 'commit', 'confirm']) h.child.stdout.emit('data', JSON.stringify({ hand: 'pause', nonce, phase, token, paused: true }) + '\n');
  h.child.stdin.writableLength = 65537;
  h.client.send(target); const frame = h.child.lines.at(-1);
  assert.equal(frame.hand, 'act');
  const row = dump([{ dumpProbe: false }, { dumpPaused: true }, frame, { dumpStats: true }], 0, { loaded: true }).at(-1);
  assert.deepEqual(row.retained, [frame.seq]); assert.equal(row.targetMemories, 1); assert.equal(row.shown, false);
});

test('refused private admits preserve their valid target on the plain wire', options, async t => {
  for (const reason of ['begin-pending', 'ending', 'bad-prefix', 'poisoned', 'backpressure']) {
    const h = await harness(t); h.channel.beginTurn(turn);
    if (reason !== 'begin-pending') h.ack();
    if (reason === 'ending') h.channel.endTurn();
    if (reason === 'poisoned') h.ack(h.frames().at(-1), false);
    if (reason === 'backpressure') h.child.stdin.writableLength = 65537;
    assert.equal(h.channel.admit(target, action(reason === 'bad-prefix' ? 2 : 1)), false, reason);
    const frame = h.child.lines.at(-1);
    assert.equal(frame.hand, 'act', reason + ' must preserve its target');
    const row = dump([...h.child.lines.filter(f => ['stage-producer', 'act'].includes(f.hand)),
      { ...h.frames().at(-1), op: 'fault', seq: frame.seq + 1 }], 0, { reader: true, loaded: true }).at(-1);
    assert.deepEqual(row.retained, [frame.seq], reason);
    assert.equal(row.protectedIntersections, 0); assert.equal(h.channel.state.poisoned, true);
    assert.equal(h.channel.state.admitted.length, 0, 'ordinary protection is not a private admission ack');
  }
});
