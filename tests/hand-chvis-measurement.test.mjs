import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleWindows, summarizeSamples, taskResult } from '../bench/hand/check4-measurement.mjs';
import { modelTaskResult } from '../bench/hand/check4-model.mjs';
const row = (t, size = 'stage', shown = true) => ({ ...sampleWindows({ t, appPids: [42], status: {
  pid: 40, panelID: 7, hostTimeMs: t, shown, rendererPath: 'stage', size,
  protectedRects: [[0, 0, 20, 20]], wideWindows: [], usableFrame: [0, 33, 1512, 949], maxWindowBoundsDifferencePt: 0 },
  windows: [{ pid: 40, id: 7, frame: [1100, 40, 200, 300], alpha: shown ? 1 : 0 },
    { pid: 42, id: 9, frame: [4, 37, 960, 720], alpha: 1, layer: 0 }] }), epochMs: 100000 + t });
const rows = [1000, 1050, 1100].map(t => row(t));
const replay = { verdict: 'pass', lifecycle: { passed: true }, cleanupConfirmed: true };
const audit = { complete: true, intersections: 0 };
test('CH-3 three-quarter counts as stage family with full-stage and any-rung shares beside it', () => {
  const summary = summarizeSamples(rows.map(r => ({ ...r, status: { ...r.status, size: 'three-quarter' } })), { start: 1000, end: 1100 });
  assert.equal(summary.visibleShare, 1); assert.equal(summary.fullStageShare, 0); assert.equal(summary.visibleAnyRung, 1);
  assert.equal(summary.timeByRungMs['three-quarter'], 100);
  const medium = taskResult({ taskId: 'x', rows: rows.map(r => ({ ...r, status: { ...r.status, size: 'medium' } })), start: 1000, end: 1100, replay, audit });
  assert.equal(medium.visibleShare, 0); assert.equal(medium.visibleAnyRung, 1); assert.equal(medium.verdict, 'fail');
});
test('CH-5 model Finder copy-paste needs protection but no fabricated drag or wide witness', () => {
  const input = { task: { id: 'finder-move' }, row: { arm: 'sleight', task: 'finder-move', run: 1, passed: true,
    groupClean: true, stamps: { exitAt: 101100 } }, rows: [row(950), ...rows, row(1150)], audit, cleanupConfirmed: true,
    trace: [{ t: new Date(101000).toISOString(), direction: 'call-received', msg: { params: { name: 'js' } } }], hostTrace: { records: [] } };
  assert.equal(modelTaskResult(input).verdict, 'pass');
  const hostTrace = { records: [{ input: { now: 1.05, event: { state: 'drag' } } }] };
  assert.equal(modelTaskResult({ ...input, hostTrace }).verdict, 'unmeasured');
});
test('CH-5 an early wide scroll counts only with the host scroll reason and in the driving interval', () => {
  const input = { task: { id: 'preview-early-scroll', earlyScroll: true }, row: { arm: 'sleight', task: 'preview-early-scroll', run: 1,
    passed: true, groupClean: true, stamps: { exitAt: 101100 } },
    rows: [row(950), ...rows, row(1150)].map(r => ({ ...r, status: { ...r.status, wideWindows: [{ pid: 42, id: 9 }] } })), audit, cleanupConfirmed: true,
    trace: [{ t: new Date(101000).toISOString(), direction: 'call-received', msg: { id: 1, params: { name: 'open_file' } } },
      { t: new Date(101005).toISOString(), direction: 'to-client', msg: { id: 1, result: {} } },
      { t: new Date(101006).toISOString(), direction: 'call-received', msg: { id: 2, params: { name: 'js' } } },
      { t: new Date(101020).toISOString(), direction: 'to-client', msg: { id: 2, result: {} } }],
    recordedCalls: [{ name: 'open_file', arguments: {} }, { name: 'js', arguments: { code: 'await app.scroll({direction:"down",pixels:20});' } }],
    hostTrace: { records: [{ input: { op: 'receive', now: 1.01, event: { state: 'thinking', area: 'window', wideReason: 'scroll' } } }] } };
  assert.equal(modelTaskResult(input).verdict, 'pass');
  input.hostTrace.records[0].input.event.wideReason = 'read';
  assert.equal(modelTaskResult(input).verdict, 'unmeasured');
});
test('CHVIS1 measures first shown frame, fixture frames and independent art contacts', () => {
  const input = [row(950, 'stage', false), row(1000, 'stage', false), row(1050), row(1100)];
  const summary = summarizeSamples(input, { start: 1000, end: 1100 });
  assert.equal(summary.timeToFirstFrameMs, 50);
  assert.deepEqual(summary.fixtureFrames.map(w => w.frame), [[4, 37, 960, 720]]);
  assert.deepEqual(summary.fixtureFrames[0].freeSpacePt, { left: 0, right: 500, above: 0, below: 177 });
  assert.equal(summary.independentArtIntersections, 0);
  const touched = sampleWindows({ t: 1, status: { ...rows[0].status, hostTimeMs: 1, protectedRects: [[1100, 40, 10, 10]] },
    windows: [{ pid: 40, id: 7, frame: [1100, 40, 200, 300], alpha: 1 }] });
  assert.equal(touched.artIntersections.length, 1);
});
