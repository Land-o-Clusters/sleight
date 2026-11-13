import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';

const replaceSite = (source, from, to) => {
  assert.ok(source.includes(from), 'named mutation site ' + from);
  return source.replace(from, to);
};

const variant = process.env.GP4_VARIANT;
const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-gp4-'))));
after(() => rmSync(root, { recursive: true, force: true }));
const clientURL = new URL('../plugins/sleight/lib/hand/client.mjs', import.meta.url).href;
const handURL = new URL('../plugins/sleight/lib/hand/runtime-hand.mjs', import.meta.url).href;
const driverURL = new URL('../plugins/sleight/lib/driver-client.mjs', import.meta.url).href;
const overlapURL = new URL('./fixtures/presentation-overlap.mjs', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  let source = loaded.source?.toString();
  if (url === clientURL && variant === 'observation-after-invalidation') source = replaceSite(source,
    'observation.epoch !== epoch || ', '');
  if (url === clientURL && variant === 'dropped-invalidation') source = replaceSite(source,
    "return send('invalidate', { epoch: ++epoch, after, prefix, reason });", 'return false;');
  if (url === clientURL && variant === 'restore-reuses-certificate') source = replaceSite(source,
    'captures.delete(ticket);', '/* old capture remains reusable */');
  if (url === handURL && variant === 'stop-retires-targets') source = replaceSite(source,
    "return geometry.invalidate('ambient');\n  };", 'return endTurn();\n  };');
  if (url === overlapURL && variant === 'self-box-oracle') source = replaceSite(source,
    'for (const target of targets) {', 'for (const target of [plan.box]) {');
  if (url === driverURL && variant === 'added-input-await') {
    source = replaceSite(source, 'function send(g, method, params, budget, context, beforeInput, operation) {',
      'async function send(g, method, params, budget, context, beforeInput, operation) {');
    source = replaceSite(source, "line = line.slice(0, -1) + ',\"geometryTurn\":\"' + geometryTurn + '\"}';\n    }",
      "line = line.slice(0, -1) + ',\"geometryTurn\":\"' + geometryTurn + '\"}';\n    }\n    if (observeGeometry) await Promise.resolve();");
  }
  return source === undefined ? loaded : { ...loaded, source };
} });
const { harness, row, call } = await import('./fixtures/glide-hand.mjs');
const { privateHandGeometry } = await import(clientURL);
const { createMacDriverClient } = await import(driverURL);
const { createRuntimeActionEvents } = await import('../plugins/sleight/lib/mac-driver/action-events.mjs');
const { DRIVER_CORE_METHODS } = await import('../plugins/sleight/lib/mac-driver/protocol.mjs');
const { countOverlaps } = await import(overlapURL);
hooks.deregister();

const capture = channel => { const stamp = performance.now(); return channel.capture({ start: stamp, end: stamp }); };
const geometry = (h, mode = 'layout') => ({ pid: 42, windowId: 7, incarnation: 'd'.repeat(32), contentGeneration: 1,
  mode, bounds: [0, 0, 900, 600], references: privateHandGeometry(h.client).state.admitted.map(r => ({ seq: r.seq, departed: false, rects: [[10, 20, 30, 40]] })) });

test('an observation cannot apply after a later invalidation, even after its receipt', async t => {
  const h = await harness(t); h.act();
  const channel = privateHandGeometry(h.client), ticket = capture(channel);
  channel.invalidate('layout'); h.ack();
  assert.equal(channel.certify(ticket, geometry(h)), false, 'the later epoch revokes the earlier observation');
  assert.equal(channel.state.admitted.length, 1);
});

test('a dropped invalidation revokes captures and keeps the admitted inventory', async t => {
  const h = await harness(t); h.act();
  const channel = privateHandGeometry(h.client), ticket = capture(channel);
  h.child.stdin.writableLength = 65537;
  channel.invalidate('ambient');
  assert.equal(channel.state.poisoned, true, 'a refused invalidation must poison recovery');
  assert.equal(channel.certify(ticket, geometry(h)), false);
  assert.equal(channel.state.admitted.length, 1);
  assert.equal(h.frames().at(-1).op, 'fault');
});

test('change and restore without notifications cannot reuse a consumed certificate', async t => {
  const h = await harness(t); h.act();
  const channel = privateHandGeometry(h.client), ticket = capture(channel), proof = geometry(h);
  assert.ok(channel.certify(ticket, proof)); h.ack();
  // The environment changes and restores between observations. Equal geometry
  // and silence confer no new acquisition capability or presentation guarantee.
  assert.equal(channel.certify(ticket, proof), false, 'old evidence is single use even when bounds match again');
  assert.equal(channel.state.admitted.length, 1);
});

test('Stop is a retaining invalidation, including late actions and observations', async t => {
  const h = await harness(t); h.act();
  const channel = privateHandGeometry(h.client), before = channel.state.admitted;
  const result = h.hand.stopTurn();
  assert.equal(typeof result?.then, 'undefined', 'Stop adds no input await');
  assert.equal(h.frames().at(-1).op, 'invalidate', 'Stop must invalidate rather than retire targets');
  assert.equal(channel.state.active, true);
  assert.deepEqual(channel.state.admitted, before);
  h.ack();
  const count = h.certificates().length;
  h.wire.begin(3); h.send(3, { read: 2, references: [row()] });
  assert.equal(h.certificates().length, count);
  const late = h.hand({ type: 'action', phase: 'act', call, index: 1, kind: 'type', point: [70, 80],
    window: { id: 7, pid: 42, rect: [0, 0, 900, 600] } });
  assert.equal(late, undefined); h.ack();
  assert.equal(channel.state.admitted.length, 2, 'a stopped input producer cannot lose an already queued target');
  h.hand.stopTurn(); assert.equal(h.frames().filter(f => f.op === 'end').length, 0);
});

test('Stop still revokes observations after an earlier geometry refusal', async t => {
  const h = await harness(t); h.act();
  h.wire.begin(3); h.send(3, { read: 2, complete: false, references: [row()] });
  const before = h.frames().length;
  h.hand.stopTurn();
  assert.equal(h.frames().length, before + 1);
  assert.equal(h.frames().at(-1).op, 'invalidate');
});

test('native action admission returns synchronously with zero added input awaits', async t => {
  const h = await harness(t);
  const result = h.hand({ type: 'action', phase: 'act', call, index: 0, kind: 'click', point: [25, 40],
    window: { id: 7, pid: 42, rect: [0, 0, 900, 600] } });
  assert.equal(result, undefined, 'the consumer must not return an awaited action continuation');
  assert.equal(h.frames().at(-1).op, 'admit', 'protection queues before the consumer returns');
});

test('native dispatch adds zero input awaits after geometry admission', async t => {
  const events = createRuntimeActionEvents(), sent = new Set(), dispatchChecks = [];
  events.connect(() => {}); events.connectGeometry(() => {});
  const geometryWire = events.geometryWire.bind(events);
  events.geometryWire = options => {
    const wire = geometryWire(options);
    return { ...wire, begin(id, action) {
      const turn = wire.begin(id, action);
      queueMicrotask(() => dispatchChecks.push(sent.has(id)));
      return turn;
    } };
  };
  const driver = createMacDriverClient({ platform: 'darwin', actionEvents: events,
    prepare: async () => ({ status: 'ready', spawn() {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(bytes, encoding, done) {
        const q = JSON.parse(bytes); done(); if (q.control) return;
        sent.add(q.id);
        queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
          nonce: q.nonce, id: q.id, ok: true, result: q.method === 'ping' ? { protocol: 'sleight.driver/1', apiVersion: 2,
            build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, 'click'] } : {} }) + '\n'));
      } });
      child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
      child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true; };
      return child;
    } }) });
  t.after(async () => { await driver.close(); events.close(); });
  await driver.ping();
  await driver.request('click', {});
  assert.deepEqual(dispatchChecks, [true], 'input dispatch adds zero microtask awaits after admission');
});

const bounds = [200, 500, 900, 350], nonce = 'a'.repeat(64), session = 'b'.repeat(32), turn = 'c'.repeat(32);
const prefix = { call: 'd'.repeat(32), action: 1, attempt: 1, ordinal: 1 };
const frame = (seq, op, more = {}) => ({ hand: 'stage-producer', nonce, seq, session, turn, op, ...more });
const baseline = frame(2, 'certificate', { epoch: 0, after: -1, prefix: null, observation: 1, acquired: [1, 2], geometry: {
  pid: 42, windowId: 7, incarnation: 'e'.repeat(32), contentGeneration: 0, mode: 'baseline', bounds, references: [] } });
const admit = frame(3, 'admit', { barrier: 3, prefix, frame: { kind: 'click', pid: 42, windowId: 7,
  at: [650, 700], windowRect: bounds, path: [[650, 700]], delayMs: 0, beats: 1 } });
const invalidate = frame(4, 'invalidate', { epoch: 1, after: 3, prefix, barrier: 4, reason: 'ambient' });
const observed = frame(5, 'certificate', { epoch: 1, after: 3, prefix, observation: 2, acquired: [5, 6], geometry: {
  ...baseline.geometry, contentGeneration: 1, mode: 'layout', references: [{ seq: 3, departed: false, rects: [[640, 680, 20, 20]] }] } });

const fixture = join(root, 'character.json');
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false,
  hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait',
  'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
writeFileSync(fixture, JSON.stringify({ hand: 'character', nonce, seq: 1, id: 'fixture', sheet: join(root, 'sheet.png'), extra: null,
  cell: [192, 208], table: { idle: { ...entry, frames: 2 } }, size: 'stage',
  perch: { anchor: [96, 150], table: Object.fromEntries(states.map(state => [state, entry])) } }));
let binary;
function host() {
  if (binary) return binary;
  let source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  if (variant === 'status-anchor-target') source = replaceSite(source,
    'guard ordinary || !producer.active || handKinds.contains(incoming.state) || incoming.state == "aim" else { return }', '/* status anchors become targets */');
  if (variant === 'delayed-plan-applies') source = replaceSite(source,
    'if stage.producerOwner != nil || stage.producerCollectionOnly {', 'if false {');
  // Instrument the existing no-window reader. Only test-owned Swift gains these
  // scheduler controls. Application still goes through production performStage.
  const start = source.indexOf('func stageProducerDump('), end = source.indexOf('\nlet arguments =', start);
  let dump = source.slice(start, end);
  dump = replaceSite(dump, 'host.perch.stageEffects = { _ in }', `
    var queuedStage: StageDraw?, installedStage: StageDraw?, applications = 0, nonzeroHides = 0
    host.perch.stageEffects = { effects in
        for effect in effects {
            switch effect {
            case let .draw(draw): installedStage = draw; applications += 1
            case let .reseat(delta):
                if var draw = installedStage {
                    draw.pose.positions = draw.pose.positions.map { ($0.0, CGPoint(x: $0.1.x + delta.x, y: $0.1.y + delta.y)) }
                    draw.seat.box = draw.seat.box.offsetBy(dx: delta.x, dy: delta.y)
                    installedStage = draw; applications += 1
                }
            case let .hide(_, duration):
                if duration > 0 && (host.perch.stage.producerOwner != nil || host.perch.stage.producerCollectionOnly) { nonzeroHides += 1 }
                installedStage = nil
            case .park: break
            }
        }
    }`);
  dump = replaceSite(dump, '_ = host.perch.stage.observe(1, world: host.admissionWorld?(ev), reduced: true)',
    'host.perch.performStage(host.perch.stage.observe(1, world: host.admissionWorld?(ev), reduced: true))');
  dump = replaceSite(dump, 'row["references"] =', `row["applications"] = applications
        row["nonzeroHides"] = nonzeroHides
        row["presentation"] = installedStage.map { $0.json(host.perch.stage.base.frame?.cell ?? .zero, time: 1) } as Any? ?? NSNull()
        row["references"] =`);
  dump = replaceSite(dump, 'if data["dumpStats"] as? Bool == true', `if data["queueStage"] as? Bool == true { probe(); queuedStage = host.perch.stage.draw; continue }
        if data["applyStage"] as? Bool == true, let draw = queuedStage { host.perch.performStage([.draw(draw)]); emit(["effect": "application"]); continue }
        if let hold = data["hold"] as? String {
            if hold == "capture" { host.captureHolds["fixture"] = Date().addingTimeInterval(30) }
            else if hold == "drag" {
                let stamp = ProcessInfo.processInfo.systemUptime
                host.ownPause.now = { stamp }; host.ownPause.nonce = { String(repeating: "a", count: 64) }
                host.ownPause.send = { _ in true }; host.ownPause.schedule = { _, _ in }
                host.badgeDrag.schedule = { _, _ in {} }
                let cg = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState)!, virtualKey: 0, keyDown: true)!
                cg.type = .leftMouseDown; cg.timestamp = UInt64(stamp * 1e9)
                cg.setIntegerValueField(.eventSourceUnixProcessID, value: 0); cg.setIntegerValueField(.eventSourceUserData, value: 0)
                guard host.badgeDrag.begin(NSEvent(cgEvent: cg), windowMatches: true) else { exit(65) }
            } else { exit(65) }; continue
        }
        if let raw = data["mainQueueProducer"] as? [String: Any], let f = StageProducerFrame.parse(raw, bytes: 1024) { host.receiveProducer(f); continue }
        if let raw = data["ringStatus"] as? [String: Any], case let .status(_, event)? = handFrame(raw) { host.ringFrame(event, delay: 0); continue }
        if data["dumpStats"] as? Bool == true`);
  source = source.slice(0, start) + dump + source.slice(end);
  const path = join(root, 'host.swift'); writeFileSync(path, source); binary = join(root, 'host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), path, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assert.equal(built.status, 0, built.stderr); return binary;
}
function replay(frames) {
  const result = spawnSync(host(), ['--stage-producer-dump', fixture], { input: frames.map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}
const native = { skip: macCommandSkip('xcrun') };

test('a previously planned drawing cannot apply while producer presentation is withheld', native, () => {
  const rows = replay([{ queueStage: true }, frame(1, 'begin', { barrier: 0 }), { applyStage: true }]);
  assert.equal(rows[0].applications, 1, 'the delayed plan is a real nonempty positive drawing');
  assert.equal(rows.at(-1).applications, 1, 'no drawing application after producer ownership');
  assert.equal(rows.at(-1).presentation, null);
});

test('ring status anchors under drag and capture hold neither admit nor release producer targets', native, () => {
  for (const hold of ['drag', 'capture']) for (const route of ['dumpPublic', 'ringStatus']) for (const state of ['thinking', 'done', 'handback', 'paused', 'error']) {
    const status = { hand: 'status', nonce, seq: 6, state, pid: 42, windowId: 7, at: [850, 730], windowRect: bounds,
      ...state === 'done' ? { ok: true } : {} };
    const rows = replay([frame(1, 'begin', { barrier: 0 }), baseline, admit, { hold }, { [route]: status }, { dumpStats: true }]);
    assert.deepEqual(rows.at(-1).retained, [3], `${hold}/${route}/${state} keeps exactly the action reference`);
    assert.deepEqual(rows.at(-1).references, [3]);
    assert.equal(rows.at(-1).active, true);
    assert.equal(rows.at(-1).presentation, null);
  }
});

test('the host refuses a late observation and keeps its protected prefix', native, () => {
  const rows = replay([frame(1, 'begin', { barrier: 0 }), baseline, admit, invalidate,
    { mainQueueProducer: { ...observed, epoch: 0 } }, { dumpStats: true }]);
  assert.equal(rows[1].accepted, true, 'the baseline is a real collected certificate');
  assert.equal(rows.at(-2).accepted, false, 'a later invalidation revokes the observation at host application');
  assert.deepEqual(rows.at(-1).retained, [3]);
  assert.equal(rows.at(-1).presentation, null);
});

function visibleSweeps(plan) {
  if (!plan || !plan.opacity.some(([, opacity]) => opacity > 0)) return [];
  const [width, height] = plan.metricSize;
  return plan.positions.map(([, x, y], i) => {
    const [, nextX, nextY] = plan.positions[i + 1] ?? plan.positions[i];
    return [Math.min(x, nextX), Math.min(y, nextY), Math.abs(nextX - x) + width, Math.abs(nextY - y) + height];
  });
}
const intersects = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];

const shiftPlan = (plan, by) => ({ ...plan, positions: plan.positions.map(([time, x, y]) => [time, x + by, y + by]),
  box: [plan.box[0] + by, plan.box[1] + by, plan.box[2], plan.box[3]] });
const coveredBy = (plan, target) => visibleSweeps(plan).filter(box => intersects(box, target)).length;

test('the overlap oracle reports a protected target the drawing covers, and none after the drawing moves clear', native, () => {
  const control = replay([{ dumpStats: true }])[0].presentation;
  const sweeps = visibleSweeps(control);
  assert.ok(sweeps.length > 0, 'the offline drawing control has nonzero opacity');
  const protectedTarget = sweeps[0];
  const moved = shiftPlan(control, 50000);
  assert.ok(coveredBy(control, protectedTarget) > 0, 'the protected target sits under the drawing');
  assert.equal(coveredBy(moved, protectedTarget), 0, 'the moved drawing is clear of the protected target');
  const clear = countOverlaps(moved, [protectedTarget], visibleSweeps, intersects);
  assert.equal(clear.overlaps, 0, 'a drawing moved clear of the protected target reports no overlap');
  assert.equal(clear.pairs, visibleSweeps(moved).length, 'the clear drawing is still checked against that target');
  const covered = countOverlaps(control, [protectedTarget], visibleSweeps, intersects);
  assert.equal(covered.overlaps, coveredBy(control, protectedTarget), 'the oracle reports exactly the covered-target overlap');
  assert.equal(covered.pairs, sweeps.length, 'each visible sweep is checked against the protected target');
});

// This loop replays host Swift with literal client frames. It does not call
// plugins/sleight/lib/hand/client.mjs. The 810 rows change delay, drop, bounds
// and a reason string. The following test feeds one of these schedules through
// that client. No sleeping, ledger reads, app queries, or input posts.
function schedules() {
  const result = [];
  for (const scope of ['move', 'resize', 'layout', 'scroll', 'typing', 'navigation', 'ambient', 'drag', 'gap', 'restore'])
    for (const invalidationDelay of [0, 3, 9]) for (const observationDelay of [0, 4, 10]) for (const applicationDelay of [0, 5, 11])
      for (const drop of ['none', 'invalidation', 'observation']) result.push({ scope, invalidationDelay, observationDelay, applicationDelay, drop });
  return result;
}
test('controlled native scheduler keeps every unsupported scope hidden across delayed and lost work', native, t => {
  let checkpoints = 0, applications = 0, overlaps = 0, segments = 0, pairs = 0, acceptedMaps = 0;
  for (const s of schedules()) {
    const action = { ...admit, frame: { ...admit.frame,
      kind: s.scope === 'drag' ? 'drag' : s.scope === 'scroll' ? 'scroll' : s.scope === 'typing' ? 'type' : 'click' } };
    const input = [{ queueStage: true }, frame(1, 'begin', { barrier: 0 }), baseline, action];
    const changed = s.scope === 'resize' ? [200, 500, 1000, 400] : [280, 500, 900, 350];
    const tasks = [
      { at: 1, rows: s.scope === 'gap' ? [{ dumpVisible: false }] : [{ dumpBounds: changed }] },
      { at: 2 + s.invalidationDelay, rows: s.drop === 'invalidation' ? [] : [{ ...invalidate,
        reason: ['layout', 'scroll', 'resize', 'typing', 'navigation'].includes(s.scope) ? s.scope : 'ambient' }] },
      { at: 3 + s.observationDelay, rows: s.drop === 'observation' ? [] : [observed] },
      { at: 4 + s.applicationDelay, rows: [{ applyStage: true }] },
      { at: 8, rows: [{ dumpBounds: bounds }, { dumpVisible: true }] },
    ].sort((a, b) => a.at - b.at);
    // Invoke the actual main-queue receiver even for an obsolete application.
    // The normal stdin reader rejects such wire reorderings even earlier.
    for (const task of tasks) {
      for (const item of task.rows) {
        input.push(item.hand === 'stage-producer' ? { mainQueueProducer: item } : item);
      }
      input.push({ dumpStats: true });
    }
    const rows = replay(input);
    for (const r of rows) {
      checkpoints++;
      assert.deepEqual(r.retained, r.op === 'begin' || r.seq === 2 ? [] : [3]);
      assert.equal(r.collectionOnly, true);
      assert.equal(r.nonzeroHides, 0, 'uncertain geometry removes presentation at zero duration');
      // The oracle starts from admitted input geometry and a conservative
      // unknown-motion envelope, never from the host's retained target boxes.
      const protectedBoxes = [[602, 652, 96, 96], [0, 30, 1800, 1140]];
      const hit = countOverlaps(r.presentation, protectedBoxes, visibleSweeps, intersects);
      segments += hit.segments; pairs += hit.pairs; overlaps += hit.overlaps;
      if (r.presentation) applications++;
      assert.equal(overlaps, 0, JSON.stringify(s));
      assert.equal(r.presentation, null, JSON.stringify(s));
      if (r.op === 'certificate' && r.accepted) acceptedMaps++;
      assert.equal(r.windows, 0); assert.equal(r.layers, 0);
    }
  }
  assert.equal(applications, 0); assert.equal(overlaps, 0);
  assert.ok(acceptedMaps >= schedules().length, 'the scheduler exercises accepted baseline observations');
  t.diagnostic(`schedules=${schedules().length} checkpoints=${checkpoints} acceptedMaps=${acceptedMaps} presentationApplications=${applications} visibleSegments=${segments} rectanglePairs=${pairs} nonzeroOpacityOverlaps=${overlaps} enabledRecoveryScopes=0 clientFrames=literal`);
});

test('one scheduler is fed through the real hand client and the host keeps that drawing hidden', native, async t => {
  // Same order as one controlled row: queue a drawing, then begin, baseline,
  // admit, invalidate and a later observation. The frames come from the client.
  const h = await harness(t, { native: true });
  h.act();
  const channel = privateHandGeometry(h.client);
  assert.notEqual(channel.invalidate('scroll'), false);
  h.ack();
  const stamp = performance.now();
  const ticket = channel.capture({ start: stamp, end: stamp });
  assert.ok(ticket, 'the client minted the observation ticket');
  const proof = { pid: 42, windowId: 7, incarnation: 'd'.repeat(32), contentGeneration: 1, mode: 'layout',
    bounds: [200, 500, 900, 350], references: channel.state.admitted.map(row => ({ seq: row.seq, departed: false, rects: [[640, 680, 20, 20]] })) };
  assert.notEqual(channel.certify(ticket, proof), false);
  h.ack();
  const produced = h.frames();
  assert.deepEqual(produced.map(frame => frame.op), ['begin', 'certificate', 'admit', 'invalidate', 'certificate']);
  assert.notEqual(produced[0].nonce, nonce, 'these frames are the client nonce, not the literal scheduler constants');
  assert.equal(produced[3].reason, 'scroll');
  const admit = produced.find(frame => frame.op === 'admit');
  const input = [{ queueStage: true }, ...produced.slice(0, 3)];
  for (const frame of produced.slice(3)) input.push({ mainQueueProducer: frame }, { dumpStats: true });
  input.push({ applyStage: true }, { dumpStats: true });
  const rows = replay(input);
  assert.equal(rows.at(-1).presentation, null, 'the client schedule stays hidden on the host');
  assert.deepEqual(rows.at(-1).retained, [admit.seq]);
  assert.equal(rows.at(-1).collectionOnly, true);
  t.diagnostic(`realClientFrames=${produced.length} hostRows=${rows.length} literalSchedulerLoop=false`);
});

if (!variant) test('required broken variants fail behavioral assertions', { timeout: 900000 }, t => {
  for (const [broken, pattern, assertion] of [ ['observation-after-invalidation', '^an observation', /later epoch revokes/],
    ['dropped-invalidation', '^a dropped', /refused invalidation must poison/],
    ['restore-reuses-certificate', '^change and restore', /old evidence is single use/],
    ['stop-retires-targets', '^Stop is', /Stop must invalidate rather than retire/],
    ['status-anchor-target', '^ring status', /keeps exactly the action reference/],
    ['added-input-await', '^native dispatch', /input dispatch adds zero microtask awaits/],
    ['delayed-plan-applies', '^a previously', /no drawing application after producer ownership/],
    ['self-box-oracle', '^the overlap oracle', /moved clear of the protected target reports no overlap/] ]) {
    const nativeSkip = ['status-anchor-target', 'delayed-plan-applies', 'self-box-oracle'].includes(broken) && macCommandSkip('xcrun');
    if (nativeSkip) { t.diagnostic(`variant=${broken} skipped: ${nativeSkip}`); continue; }
    const env = { ...process.env, GP4_VARIANT: broken, CLAUDE_CONFIG_DIR: mkdtempSync(join(root, 'lane-claude-')) };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=900000', '--test-name-pattern=' + pattern, new URL(import.meta.url).pathname], {
      env,
      encoding: 'utf8', timeout: 900000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(join(root, `variant-${broken}.log`), result.stdout + result.stderr);
    assert.equal(result.status, 1, broken + result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /AssertionError|ERR_ASSERTION/, broken);
    assert.match(result.stdout + result.stderr, assertion, broken + ' must fail its expected behavioral assertion');
    t.diagnostic(`variant=${broken} exit=${result.status}`);
  }
});
