import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const traceURL = new URL('../bench/hand/stage-trace.mjs', import.meta.url);
let traceSource = readFileSync(traceURL, 'utf8');
if (process.env.CHRET4_TRACE_VARIANT === 'retain-receipt-nonce') {
  const changed = traceSource.replace('frame: withoutSessionNonce(frame), trace: withoutSessionNonce(trace), actions: withoutSessionNonce(actions)', 'frame, trace, actions');
  assert.notEqual(changed, traceSource, 'nonce mutation site'); traceSource = changed;
}
const { stageReplayReceipt, stageReplayLines, compareStageReplay, stageTraceFigures, TRACE_LIMIT } = await import(
  process.env.CHRET4_TRACE_VARIANT === 'retain-receipt-nonce' ? 'data:text/javascript;base64,' + Buffer.from(traceSource).toString('base64') : traceURL.href);
const liveURL = new URL('../bench/hand/stage-live.mjs', import.meta.url);
let liveSource = readFileSync(liveURL, 'utf8');
if (process.env.CHRET4_TRACE_VARIANT === 'skip-exact-replay') {
  const changed = liveSource.replace('await replayStageTrace(binary, receipt, options)', '({ reproduced: true, transactions: 0, mismatches: [] })');
  assert.notEqual(changed, liveSource, 'replay mutation site');
  liveSource = changed.replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, specifier) => 'from ' + quote + new URL(specifier, liveURL).href + quote);
}
if (process.env.CHRET4_TRACE_VARIANT === 'drop-replay-error-receipt') {
  const changed = liveSource.replace('return { ...receipt, exactReplay: { reproduced: false, transactions: 0, mismatches: [] }',
    'return { exactReplay: { reproduced: false, transactions: 0, mismatches: [] }');
  assert.notEqual(changed, liveSource, 'error receipt mutation site');
  liveSource = changed.replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, specifier) => 'from ' + quote + new URL(specifier, liveURL).href + quote);
}
const live = await import(['skip-exact-replay', 'drop-replay-error-receipt'].includes(process.env.CHRET4_TRACE_VARIANT) ? 'data:text/javascript;base64,' + Buffer.from(liveSource).toString('base64') : liveURL.href);
import { liveFixtureWorld, savedSampleCounts } from '../bench/hand/legacy-stage-world-check.mjs';
import { autoSequence, stressSequence, cursorWire, playSequence } from '../bench/hand/cursor-sequence.mjs';
import { auditStageTrace } from './fixtures/stage-stateful-fuzz.mjs';
import { stageTraceLines, collectStageTrace } from './fixtures/stage-trace-chunks.mjs';

const frame = { hand: 'character' };
const output = (shown, count, rung = 'small') => ({ shown, turnTargets: count, contributors: count, hiddenReason: shown ? null : 'no-seat', draw: shown ? { rung } : null });
const fixture = () => ({ schema: 'sleight.stage-trace/1', complete: true, records: [
  { order: 0, input: { op: 'observe', now: 0 }, output: output(true, 1, 'stage') },
  { order: 1, input: { op: 'observe', now: 2 }, output: output(false, 3) },
  { order: 2, input: { op: 'receive', now: 3 }, output: output(true, 4) },
  { order: 3, input: { op: 'complete', now: 5 }, output: output(true, 0) },
] });
const receipt = trace => stageReplayReceipt({ frame, trace, scenario: 'small-target-turn-lifecycle' });

test('captured order, unknown consumption and separate lifecycle/stress arms survive receipt conversion', () => {
  const trace = fixture(), r = receipt(trace), lines = stageReplayLines(r);
  assert.equal(r.witnesses.consumption, 'unknown');
  assert.equal(r.witnesses.dependencyRelease, 'unknown');
  assert.deepEqual(lines.slice(2, -1).map(l => l.dumpTransaction), trace.records.map(r => r.input));
  assert.equal(stageReplayReceipt({ frame, trace, scenario: 'full-window-scroll-stress' }).scenario, 'full-window-scroll-stress');
  assert.throws(() => stageReplayReceipt({ frame, trace, scenario: 'combined' }), /unknown trace arm/);
});

test('truncation, capacity, missing records, reordered transactions refuse replay; backwards clocks keep ordered inputs', () => {
  for (const mutate of [t => { t.complete = false; }, t => { t.records.splice(1, 1); }, t => { t.records.reverse(); },
    t => { delete t.records[1].output; }]) {
    const t = fixture(); mutate(t); assert.throws(() => receipt(t), /incomplete|ordering|clock/);
  }
  const backwards = fixture(); backwards.records[2].input.now = -1;
  assert.equal(receipt(backwards).clockDiscontinuities, 1);
  assert.equal(stageTraceFigures(backwards).measured, false);
  assert.throws(() => stageReplayReceipt({ frame, trace: fixture(), scenario: 'small-target-turn-lifecycle', actions: ['x'.repeat(TRACE_LIMIT)] }), /exceeds bound/);
});

test('exact replay check detects count, contributor, hide and visibility variants', () => {
  const a = fixture(); assert.equal(compareStageReplay(a, fixture()).reproduced, true);
  for (const [field, value] of [['turnTargets', 0], ['contributors', 0], ['hiddenReason', 'gone'], ['shown', false]]) {
    const b = fixture(); b.records[0].output[field] = value;
    assert.equal(compareStageReplay(a, b).reproduced, false, field);
  }
  const art = fixture(); art.records[0].output.draw.rung = 'small';
  assert.equal(compareStageReplay(a, art).reproduced, false);
  const shifted = fixture(); shifted.records[0].input.now = 0.1;
  assert.equal(compareStageReplay(a, shifted).reproduced, false);
  const truncated = fixture(); truncated.records.pop();
  assert.equal(compareStageReplay(a, truncated).reproduced, false);
});

test('stage-visible seconds and shares use ordered state intervals, including hidden tails', () => {
  const figures = stageTraceFigures(fixture(), { start: 0, end: 6, sampleTimes: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(figures.seconds, { stage: 2, 'three-quarter': 0, medium: 0, small: 3, hidden: 1 });
  assert.equal(figures.shares.hidden, 1 / 6);
  assert.deepEqual(figures.samples, { stage: 2, 'three-quarter': 0, medium: 0, small: 4, hidden: 1 });
  assert.equal(figures.sampleShares.hidden, 1 / 7);
  assert.equal(stageTraceFigures(fixture(), { start: 2, end: 2 }).measured, false);
});

test('visibility integrates the installed opacity keys and clips each plan at the next transaction', async () => {
  const { stageTraceVisibility } = await import('../bench/hand/stage-trace.mjs');
  assert.equal(typeof stageTraceVisibility, 'function');
  const draw = (began, ramp) => ({ shown: true, planBegan: began, draw: { opacity: [[0, 0], [ramp, 1]] } });
  const trace = { complete: true, records: [
    { input: { now: 0 }, output: draw(0, 0.2) },
    { input: { now: 1 }, output: draw(0, 0.2) },
    { input: { now: 2 }, output: { shown: false, draw: null } },
    { input: { now: 3 }, output: draw(3, 0.4) },
  ] };
  const value = stageTraceVisibility(trace, { start: 0, end: 4 });
  assert.equal(value.measured, true); assert.equal(value.shownSeconds, 3);
  assert.ok(Math.abs(value.opacitySeconds - 2.7) < 1e-9);
  assert.ok(Math.abs(value.opacityShare - 0.675) < 1e-9);
  assert.equal(stageTraceVisibility({ ...trace, complete: false }, { start: 0, end: 4 }).measured, false);
});

test('a drag widens the carried audit world on its admission record without a one-record lag', () => {
  const world = { window: [100, 600, 500, 250], windows: [
    { id: 7, pid: 42, frame: [100, 600, 500, 250] }, { id: 9, pid: 43, frame: [900, 600, 500, 250] },
  ], person: [1650, 1050, 100, 100], pointer: [1790, 1190], above: [], cards: [] };
  const trace = { records: [
    { input: { op: 'observe', now: 0, world }, output: { shown: false } },
    { input: { op: 'receive', now: 1, seq: 2, event: { state: 'drag', pid: 42, window: 7, at: [1100, 800], end: [350, 800] } },
      output: { shown: true, planBegan: 1, draw: { box: [900, 600, 20, 20], panel: [900, 600, 20, 20], seat: { window: 7 }, positions: [[0, 900, 600]], opacity: [[0, 1]] } } },
  ] };
  const audit = auditStageTrace(trace);
  assert.ok(audit.intersections > 0, 'the destination frame is protected on the drag record itself');
});

test('wire trace distinguishes scheduled completion from delivery and records actual dispatch order', async () => {
  const options = { pid: 42, windowId: 7, rect: { x: 100, y: 600, width: 500, height: 250 }, count: 7 };
  const normal = autoSequence(options), stress = stressSequence(options);
  assert.notEqual(normal.scenario, stress.scenario);
  assert.deepEqual(normal.scrollRectPt, [60, 30]); assert.deepEqual(stress.scrollRectPt, [500, 250]);
  let clock = 100;
  const actions = [], written = [];
  await playSequence(normal, { wire: cursorWire('b'.repeat(64)), write: line => written.push(line), now: () => clock,
    sleep: async delay => { clock += delay + 1; }, record: row => actions.push(row) });
  assert.equal(actions.length, normal.steps.length);
  assert.deepEqual(actions.map(r => r.frame), written.map(JSON.parse));
  assert.ok(actions.every((r, i) => r.order === i && r.dispatchedMs >= r.scheduledMs && r.admissionAcknowledged === false));
  assert.equal(actions.filter(r => r.provenance.witness === 'scheduled-completion').length, 7);
  assert.equal(actions.at(-1).provenance.witness, 'turn-end');
});


test('legacy diagnostic changes only the private dump above list and detects an absent seam', () => {
  const seam = 'above: windows[..<i].filter { $0.visible }.map { $0.rect }';
  assert.equal(liveFixtureWorld('before ' + seam + ' after'), 'before above: [] after');
  assert.throws(() => liveFixtureWorld('no stage world'), /expected one/);
  assert.throws(() => liveFixtureWorld(seam + seam), /expected one/);
});

test('legacy sample accounting reports hidden samples instead of inferring them from plans', () => {
  const rows = [{ effect: 'stage', time: 0, rung: 'small' }, { effect: 'stage-stats', time: 0, shown: true },
    { effect: 'stage-stats', time: 1, shown: false }, { effect: 'stage', time: 2, rung: 'medium' },
    { effect: 'stage-stats', time: 2, shown: true }];
  assert.deepEqual(savedSampleCounts(rows, [0, 1, 2]), { small: 1, hidden: 1, medium: 1 });
});

test('receipts discard the bench nonce and replay binds a fresh local nonce without changing the receipt', () => {
  const nonce = 'd'.repeat(64), trace = fixture();
  const r = stageReplayReceipt({ frame: { ...frame, nonce }, trace, scenario: 'small-target-turn-lifecycle',
    actions: [{ frame: { hand: 'aim', nonce, seq: 1 } }] });
  assert.equal(JSON.stringify(r).includes(nonce), false, 'bench session nonce leaked into receipt');
  assert.equal('nonce' in r.frame, false); assert.equal('nonce' in r.actions[0].frame, false);
  const before = JSON.stringify(r), replay = stageReplayLines(r);
  assert.match(replay[0].nonce, /^[0-9a-f]{64}$/); assert.notEqual(replay[0].nonce, nonce);
  assert.equal(JSON.stringify(r), before);
});

test('bench receipt verification executes the exact headless replay and reports a mismatch', async () => {
  assert.equal(typeof live.verifyStageReceipt, 'function', 'bench replay path must verify receipts');
  for (const corrupt of [false, true]) {
    let launches = 0, received = '';
    const captured = fixture(), replayed = fixture();
    if (corrupt) replayed.records[1].output.turnTargets++;
    const spawnChild = (binary, args) => {
      launches++; assert.equal(binary, 'offline-host'); assert.deepEqual(args, ['--stage-dump']);
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on('data', b => { received += b; });
      child.stdin.on('finish', () => queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ effect: 'stage-trace', ...replayed }) + '\n');
        child.stdout.write(JSON.stringify({ effect: 'end' }) + '\n'); child.emit('close', 0, null);
      }));
      return child;
    };
    const r = await live.verifyStageReceipt('offline-host', receipt(captured), { spawnChild });
    assert.equal(launches, 1, 'bench verification must invoke production headless replay');
    assert.ok(received.includes('dumpTransaction'));
    assert.equal(r.exactReplay.reproduced, !corrupt);
    assert.equal(r.trace.complete, true, 'a replay mismatch keeps the captured evidence');
  }
});


test('a headless replay host error keeps the captured receipt and its trace', async () => {
  const captured = receipt(fixture());
  const result = await live.verifyStageReceipt('offline-host', captured, { spawnChild() { throw Error('offline replay unavailable'); } });
  assert.deepEqual(result.trace, captured.trace, 'host failure must keep the captured trace');
  assert.deepEqual(result.frame, captured.frame);
  assert.equal(result.exactReplay.reproduced, false); assert.match(result.refusal, /offline replay unavailable/);
});

test('bounded trace chunks retain every transaction and reject any partial journal', () => {
  assert.deepEqual(stageTraceLines([{ a: 1 }, { a: 2 }, { a: 3 }], 2), [
    { dumpTrace: true }, { a: 1 }, { a: 2 }, { dumpTraceRead: true }, { dumpTrace: true }, { a: 3 }, { dumpTraceRead: true },
  ]);
  const rows = [0, 1].map(i => ({ effect: 'stage-trace', complete: true, bytes: 100, records: [{ order: 0, input: { now: i } }] }));
  assert.deepEqual(collectStageTrace(rows).records.map(r => [r.order, r.input.now]), [[0, 0], [1, 1]]);
  assert.equal(collectStageTrace(rows).bytes, 200);
  rows[1].complete = false;
  assert.throws(() => collectStageTrace(rows), /every bounded trace chunk must be complete/);
});
