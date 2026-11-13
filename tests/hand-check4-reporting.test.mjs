import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelTaskResult } from '../bench/hand/check4-model.mjs';
import { summarizeSamples } from '../bench/hand/check4-measurement.mjs';
import { check4Markdown } from '../bench/hand/check4-live.mjs';

const load = (n, task) => JSON.parse(readFileSync(new URL(`./fixtures/check4-chv2/full-${n}-${task}.json`, import.meta.url)));
function input(saved) {
  const rows = saved.samples.map(([t, epochMs, valid, shown, size, rendererPath, onScreen]) => ({ t, epochMs, valid,
    status: { shown, size, rendererPath, protectedRects: [[0, 0, 1, 1]], wideWindows: [{ pid: 1, id: 1 }], maxWindowBoundsDifferencePt: 0 },
    panel: { onScreen }, intersections: [] }));
  return { ...saved, rows, task: { id: saved.row.task, ...(saved.row.task === 'preview-early-scroll' ? { earlyScroll: true } : {}) },
    audit: { complete: true, intersections: 0 }, cleanupConfirmed: true };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.001, `${actual} != ${expected}`);

test('internal terminal sends govern both verdict and supplemental driving intervals', () => {
  const data = input(load(1, 'preview-early-scroll'));
  const received = modelTaskResult(data);
  const trace = data.trace.map(e => e.msg?.params?.name === 'turn_ended' ?
    { ...e, direction: 'to-server', msg: { ...e.msg, method: 'tools/call' } } : e);
  const internal = modelTaskResult({ ...data, trace });
  assert.equal(internal.driving.endEpochMs, received.driving.endEpochMs);
  assert.equal(internal.turnEndedDriving.end, internal.driving.end);
  assert.equal(internal.visibleShare, received.visibleShare);
  assert.equal(internal.exitDriving.visibleShare, received.exitDriving.visibleShare);
  assert.equal(internal.driving.endSource, 'relay turn_ended to-server');
  assert.equal(internal.driving.processExitDurationMs, internal.exitDriving.durationMs);
  assert.equal(internal.micUnknownShownSamples, 0);
});

// Independent span calculation on retained columns, including hidden endpoints and gaps.
function share(saved, endEpochMs) {
  const startEpochMs = Date.parse(saved.trace.find(e => e.direction === 'call-received').t);
  let shown = 0;
  for (let i = 1; i < saved.samples.length; i++) {
    const a = saved.samples[i - 1], b = saved.samples[i];
    if (b[0] - a[0] <= 100 && a[2] && b[2] && a[3] && b[3] && a[4] === b[4] && ['stage', 'three-quarter'].includes(a[4]) &&
        a[5] === 'stage' && b[5] === 'stage' && a[6] && b[6])
      shown += Math.max(0, Math.min(endEpochMs, b[1]) - Math.max(startEpochMs, a[1]));
  }
  return shown / (endEpochMs - startEpochMs);
}

for (const n of [1, 2]) for (const task of ['preview-read', 'preview-early-scroll']) test(`saved full-${n} ${task}: recompute both shares, frame times and scroll ordinal`, () => {
  const saved = load(n, task), result = modelTaskResult(input(saved));
  const end = saved.trace.filter(e => e.direction === 'call-received' && e.msg.params.name === 'turn_ended').map(e => Date.parse(e.t))[0] ?? saved.row.stamps.exitAt;
  near(result.turnEndedDriving.visibleShare, share(saved, end));
  near(result.turnEndedDriving.endEpochMs, end);
  near(result.exitDriving.fullStageShare, saved.expected.fullStageShare);
  near(result.exitDriving.durationMs, saved.expected.durationMs);
  assert.ok(Math.abs(result.durationMs - (end - result.driving.startEpochMs)) < 1);
  near(result.fullStageShare, share(saved, end));
  near(result.timeToFirstFrameMs, saved.expected.timeToFirstFrameMs);
  const first = saved.samples.find(r => r[1] >= result.driving.startEpochMs && r[2] && r[3] && r[5] === 'stage' && ['stage', 'three-quarter'].includes(r[4]) && r[6]);
  near(result.timeToFirstStageFamilyFrameMs, first[0] - result.driving.start);
  if (task === 'preview-early-scroll') {
    assert.equal(result.earlyScrollWitness.ordinal, n);
    assert.equal(result.earlyScrollWitness.withinFirstTwoActions, true);
    near(result.firstScrollFractionOfDrivingTime, saved.expected.firstScrollFractionOfDrivingTime);
    assert.equal(result.verdict, 'pass');
  } else {
    assert.equal(result.earlyScrollWitness.ordinal, null);
    assert.equal(result.verdict, saved.expected.verdict);
  }
});

test('missing turn_ended uses exitAt; traced turn end governs driving and retains the exit figures', () => {
  const data = input(load(1, 'preview-early-scroll')), original = modelTaskResult(data);
  assert.ok(original.driving.end < original.exitDriving.end);
  assert.equal(original.turnEndedDriving.end, original.driving.end);
  const absent = modelTaskResult({ ...data, trace: data.trace.filter(e => e.msg?.params?.name !== 'turn_ended') });
  assert.equal(absent.turnEndedDriving.end, absent.driving.end);
  assert.match(absent.turnEndedDriving.endSource, /no traced turn_ended/);
  near(absent.visibleShare, original.exitDriving.visibleShare);
  assert.equal(absent.verdict, original.verdict);
  const invalid = modelTaskResult({ ...data, trace: data.trace.map(e => e.msg?.params?.name === 'turn_ended' ? { ...e, t: new Date(data.row.stamps.exitAt + 1000).toISOString() } : e) });
  assert.equal(invalid.turnEndedDriving.end, invalid.driving.end);
  assert.equal(invalid.driving.end, invalid.exitDriving.end);
});

test('first stage-family time refuses medium fallback, hidden panels, invalid samples and other renderers', () => {
  const data = input(load(2, 'preview-read')), original = modelTaskResult(data);
  assert.ok(original.timeToFirstStageFamilyFrameMs > original.timeToFirstFrameMs);
  for (const edit of [r => { r.panel.onScreen = false; }, r => { r.status.shown = false; },
    r => { r.valid = false; }, r => { r.status.rendererPath = 'legacy-perch'; }]) {
    const broken = structuredClone(data);
    for (const r of broken.rows) if (r.t - original.driving.start <= original.timeToFirstStageFamilyFrameMs + 1) edit(r);
    assert.ok(modelTaskResult(broken).timeToFirstStageFamilyFrameMs > original.timeToFirstStageFamilyFrameMs);
  }
  const threeQuarter = summarizeSamples(data.rows.map(r => ({ ...r, status: { ...r.status, size: 'three-quarter' } })), original.driving);
  assert.equal(threeQuarter.timeToFirstStageFamilyFrameMs, threeQuarter.timeToFirstFrameMs);
});

test('broken ordinal input stays unknown, and failed action calls still count before the witnessed scroll', () => {
  const data = input(load(2, 'preview-early-scroll'));
  assert.equal(modelTaskResult(data).earlyScrollWitness.ordinal, 2);
  assert.equal(modelTaskResult({ ...data, recordedCalls: undefined }).earlyScrollWitness.ordinal, null);
  assert.equal(modelTaskResult({ ...data, recordedCalls: undefined }).verdict, 'unmeasured');
  const shifted = structuredClone(data); shifted.recordedCalls.shift();
  assert.equal(modelTaskResult(shifted).earlyScrollWitness.ordinal, null);
  const read = structuredClone(data); read.recordedCalls[1].arguments.code = 'nodeRepl.write(await app.getAXState());';
  assert.equal(modelTaskResult(read).earlyScrollWitness.ordinal, 1);
  const quoted = structuredClone(data); quoted.recordedCalls[1].arguments.code = 'nodeRepl.write("app.scroll(1)");';
  assert.equal(modelTaskResult(quoted).earlyScrollWitness.ordinal, 1);
  const noFrame = structuredClone(data); noFrame.hostTrace.records = noFrame.hostTrace.records.filter(r => r.input.event.state !== 'scroll' && r.input.event.wideReason !== 'scroll');
  assert.equal(modelTaskResult(noFrame).earlyScrollWitness.ordinal, null);
});

test('a scroll frame outside a reply interval cannot borrow the preceding call', () => {
  const data = input(load(1, 'preview-early-scroll'));
  data.trace = data.trace.filter(e => e.direction !== 'to-client');
  assert.equal(modelTaskResult(data).earlyScrollWitness.ordinal, null);
});

test('a third action before the scroll is reported late even when the time fraction is unchanged', () => {
  const data = input(load(2, 'preview-early-scroll')), first = data.trace.find(e => e.direction === 'call-received');
  const t = new Date(Date.parse(first.t) + 1000).toISOString();
  data.trace.push({ t, direction: 'call-received', msg: { id: 'inserted-action', params: { name: 'js' } } },
    { t: new Date(Date.parse(t) + 100).toISOString(), direction: 'to-client', msg: { id: 'inserted-action', result: {} } });
  data.recordedCalls.splice(1, 0, { name: 'js', arguments: { code: 'await app.pressKey("Down");' } });
  const result = modelTaskResult(data);
  assert.equal(result.earlyScrollWitness.ordinal, 3);
  assert.equal(result.earlyScrollWitness.withinFirstTwoActions, false);
  near(result.firstScrollFractionOfDrivingTime, data.expected.firstScrollFractionOfDrivingTime);
  assert.equal(result.verdict, 'unmeasured');
  assert.match(result.reason, /first two action-bearing calls/);
});

test('broken visibility evidence reduces the supplemental share instead of counting a hidden stage', () => {
  const data = input(load(1, 'preview-read')), original = modelTaskResult(data);
  const broken = modelTaskResult({ ...data, rows: data.rows.map(r => ({ ...r, panel: { onScreen: false } })) });
  assert.ok(original.turnEndedDriving.visibleShare > 0);
  assert.equal(broken.turnEndedDriving.visibleShare, 0);
  assert.equal(broken.timeToFirstStageFamilyFrameMs, null);
});

test('markdown prints verdict figures beside the retained exit figures without changing state', () => {
  const result = modelTaskResult(input(load(1, 'preview-early-scroll')));
  const state = { verdict: 'fail', tasks: { 'preview-early-scroll': result } };
  const before = structuredClone(state), markdown = check4Markdown(state);
  for (const text of ['Stage family to benchmark exit', 'First stage-family frame ms', 'Early-scroll action ordinal', 'First-scroll time fraction',
    'relay turn_ended call-received', '1 (within first two)', 'Verdict: fail.', 'Benchmark-exit driving:']) assert.ok(markdown.includes(text), text);
  assert.deepEqual(state, before);
});

test('the saved visibility tail changes the 80 percent verdict only when a real turn end is traced', () => {
  const data = input(load(1, 'preview-read'));
  const end = data.row.stamps.exitAt - 210;
  data.trace.push({ t: new Date(end).toISOString(), direction: 'call-received', msg: { id: 'terminal', params: { name: 'turn_ended' } } });
  const result = modelTaskResult(data);
  near(result.visibleShare, share(data, end));
  assert.ok(result.visibleShare > 0.8);
  assert.ok(result.exitDriving.visibleShare < 0.8);
  assert.equal(result.verdict, 'pass');
  const broken = modelTaskResult({ ...data, trace: data.trace.filter(e => e.msg?.id !== 'terminal') });
  assert.equal(broken.verdict, 'fail');
  near(broken.visibleShare, share(data, data.row.stamps.exitAt));
});

test('a scroll after turn end keeps its old time fraction but cannot satisfy the ordinal witness', () => {
  const data = input(load(1, 'preview-early-scroll'));
  const first = data.trace.find(e => e.direction === 'call-received');
  data.trace = data.trace.map(e => e.msg?.params?.name === 'turn_ended' ? { ...e, t: new Date(Date.parse(first.t) + 1000).toISOString() } : e);
  const result = modelTaskResult(data);
  near(result.firstScrollFractionOfDrivingTime, data.expected.firstScrollFractionOfDrivingTime);
  assert.equal(result.earlyScrollWitness.ordinal, null);
  assert.equal(result.verdict, 'unmeasured');
});
