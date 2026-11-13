import test from 'node:test';
import assert from 'node:assert/strict';
import * as measurement from '../bench/hand/check4-measurement.mjs';
import * as check4 from '../bench/hand/check4.mjs';

const host = (t, extra = {}) => ({ pid: 40, panelID: 7, hostTimeMs: t, shown: true, rendererPath: 'stage', size: 'stage',
  wideWindows: [], protectedRects: [[0, 0, 20, 20]], maxWindowBoundsDifferencePt: 0, ...extra });
const windows = [{ pid: 40, id: 7, frame: [500, 500, 20, 20], alpha: 1 }];
const row = (t, extra = {}) => measurement.sampleWindows({ t, status: host(t, extra), windows });
const result = (rows, extra = {}) => measurement.taskResult({ taskId: 'textedit-drag',
  replay: { verdict: 'pass', cleanupConfirmed: true, lifecycle: { passed: true } },
  rows, start: 1000, end: 1100, audit: { complete: true, intersections: 0 }, reseated: true, ...extra });

test('CH-3 three-quarter time qualifies stage family and reports full stage beside it', () => {
  const measured = result([1000, 1050, 1100].map(t => row(t, { size: 'three-quarter' })));
  assert.equal(measured.timeByRungMs['three-quarter'], 100);
  assert.equal(measured.timeByRungMs.unknown, 0);
  assert.equal(measured.visibleShare, 1);
  assert.equal(measured.fullStageShare, 0);
  assert.equal(measured.verdict, 'pass');
});

test('CA7 area-only reads qualify geometry with independent window observations and retain a null engine comparison', () => {
  const statuses = [1000, 1050, 1100].map(t => row(t, { maxWindowBoundsDifferencePt: null, areaProtection: true,
    wideWindows: [{ pid: 42, id: 9 }] }));
  for (const r of statuses) r.windows = [{ pid: 42, id: 9, frame: [100, 100, 200, 200], alpha: 1 }];
  const measured = result(statuses);
  assert.equal(measured.verdict, 'pass');
  assert.equal(measured.maxWindowBoundsDifferencePt, null);
  assert.equal(measured.geometryBasis, 'window-area');
  for (const r of statuses) r.windows = [];
  assert.equal(result(statuses).measured, false, 'a claimed wide set alone cannot replace an observed OS window');
});

test('SF1: empty protection during driving is unmeasured even if protection appears afterward', () => {
  const measured = result([row(1000, { protectedRects: [] }), row(1050, { protectedRects: [] }),
    row(1100, { protectedRects: [] }), row(1150)]);
  assert.equal(measured.verdict, 'unmeasured');
  assert.equal(measured.visibleShare, null);
  assert.match(measured.reason, /protection/i);
  assert.equal(result([row(1000), row(1050), row(1100)]).verdict, 'pass');
  assert.equal(result([1000, 1050, 1100].map(t => row(t, { protectedRects: [], wideWindows: [{ pid: 42, id: 9 }] }))).verdict, 'pass');
});

test('SF1: Finder must observe a wide set during driving', () => {
  const rows = [row(1000), row(1050), row(1100)];
  assert.equal(result(rows, { taskId: 'finder-move' }).verdict, 'unmeasured');
  rows[1] = row(1050, { wideWindows: [{ pid: 42, id: 9 }] });
  assert.equal(result(rows, { taskId: 'finder-move' }).verdict, 'pass');
});

test('SF2: legacy and smaller rungs never earn requested stage visibility', () => {
  for (const extra of [{ rendererPath: 'legacy-perch', size: 'small' }, { size: 'small' }, { size: 'medium' },
    { rendererPath: undefined }, { size: undefined }]) {
    const measured = result([row(1000, extra), row(1050, extra), row(1100, extra)]);
    assert.equal(measured.visibleMs, 0);
    assert.equal(measured.visibleShare, 0);
    assert.equal(measured.verdict, 'fail');
    if (extra.rendererPath === 'legacy-perch') {
      assert.equal(measured.timeByRungMs.small, 100);
      assert.equal(measured.timeByRendererMs['legacy-perch'], 100);
    }
  }
});

test('SF2: rung time uses clipped intervals, with stale status and gaps recorded as unknown', () => {
  const rows = [row(950), row(1000), row(1050, { size: 'small' }), row(1100, { size: 'small' }),
    row(1300), row(1350, { hostTimeMs: 1000 }), row(1400)];
  const summary = measurement.summarizeSamples(rows, { start: 975, end: 1425 });
  assert.equal(summary.visibleMs, 25);
  assert.deepEqual(summary.timeByRungMs, { stage: 25, 'three-quarter': 0, small: 50, medium: 0, unknown: 375 });
  assert.equal(Object.values(summary.timeByRungMs).reduce((a, b) => a + b, 0), summary.durationMs);
});

test('SF3: stale and missing statuses keep last valid keys and protected sets with current independent geometry', () => {
  const sample = measurement.createWindowSampler?.() ?? measurement.sampleWindows;
  const status = host(1000, { wideWindows: [{ pid: 42, id: 9 }], protectedRects: [[100, 100, 20, 20]] });
  sample({ t: 1000, status, windows });
  for (const stale of [host(800, { pid: 99, panelID: 99, protectedRects: [] }), null]) {
    const actual = sample({ t: 1200, status: stale, windows: [
      { ...windows[0], frame: [100, 100, 20, 20] },
      { pid: 42, id: 9, frame: [168, 100, 20, 20], alpha: 1 }] });
    assert.equal(actual.valid, false);
    assert.equal(actual.intersections.length, 2);
    assert.deepEqual(actual.intersections.map(h => h.kind), ['wide-window', 'protected-rectangle']);
  }
  // A fresh empty set replaces cached protection, it does not keep obsolete rectangles forever.
  const actual = sample({ t: 1250, status: host(1250, { protectedRects: [] }), windows: [{ ...windows[0], frame: [100, 100, 20, 20] }] });
  assert.equal(actual.intersections.length, 0);
});

test('SF3: a wide window can move into a stationary panel while host status is stalled', () => {
  const sample = measurement.createWindowSampler?.() ?? measurement.sampleWindows;
  const status = host(1000, { protectedRects: [], wideWindows: [{ pid: 42, id: 9, frame: [0, 0, 1, 1] }] });
  const panel = { ...windows[0], frame: [100, 100, 20, 20] };
  assert.equal(sample({ t: 1000, status, windows: [panel, { pid: 42, id: 9, frame: [500, 500, 20, 20], alpha: 1 }] }).intersections.length, 0);
  const stale = sample({ t: 1200, status, windows: [panel, { pid: 42, id: 9, frame: [168, 100, 20, 20], alpha: 1 }] });
  assert.equal(stale.valid, false);
  assert.equal(stale.intersections.length, 1);
  assert.deepEqual(stale.intersections[0].frame, [120, 52, 116, 116]);
});

test('SF4: final verdict needs every expected task complete, measured and passing, plus complete passing costs', () => {
  const state = { tasks: Object.fromEntries(check4.TASKS.map(id => [id, { complete: true, measured: true, verdict: 'pass' }])),
    costs: { complete: true, result: { verdict: 'pass' } } };
  assert.equal(check4.check4RunVerdict(state), 'pass');
  for (const mutation of [s => { delete s.tasks['finder-move']; }, s => { s.tasks['finder-move'].verdict = 'unmeasured'; },
    s => { s.tasks['finder-move'].verdict = 'fail'; }, s => { s.tasks['finder-move'].complete = false; },
    s => { s.tasks['finder-move'].measured = false; }, s => { delete s.costs; }, s => { delete s.costs.result; },
    s => { s.costs.complete = false; }, s => { s.costs.result.verdict = 'fail'; }, s => { s.costs.result.verdict = 'not-measured'; }]) {
    const copy = structuredClone(state); mutation(copy);
    assert.equal(check4.check4RunVerdict(copy), 'fail');
  }
});

test('model runs judge driving plus the re-seat grace; later cleanup samples are reported apart', () => {
  const hit = { protectedRects: [[500, 500, 20, 20]] };
  const cleanupAt = 1100 + measurement.RESEAT_GRACE_MS + 500;
  const after = result([row(1000), row(1050), row(1100), row(cleanupAt, { ...hit, maxWindowBoundsDifferencePt: 300,
    hideReasonCounts: { cleanup: 9 } })]);
  assert.equal(after.samplerIntersections, 1);
  assert.equal(after.judgedSamplerIntersections, 0);
  assert.equal(after.verdict, 'pass');
  assert.equal(after.maxWindowBoundsDifferencePt, 0);
  assert.equal(after.hideReasonCounts.cleanup, undefined);
  const reseat = result([row(1000), row(1050), row(1100), row(1100 + measurement.RESEAT_GRACE_MS - 500, hit)]);
  assert.equal(reseat.judgedSamplerIntersections, 1);
  assert.equal(reseat.verdict, 'fail');
  const during = result([row(1000), row(1050, hit), row(1100)]);
  assert.equal(during.drivingSamplerIntersections, 1);
  assert.equal(during.verdict, 'fail');
});

test('the default benchmark path calls claude --version without the check 4 timeout', async () => {
  const { readFileSync } = await import('node:fs');
  const run = readFileSync(new URL('../bench/run.mjs', import.meta.url), 'utf8');
  assert.match(run, /assertWorldCLI\(claudeBin, check4 \? \(command, args, options\) => execFileSync\([\s\S]*?\) : execFileSync\);/);
});

test('reseating remains a reported observation, outside the visibility and intersection bars', () => {
  const measured = result([row(1000), row(1050), row(1100)], { reseated: false });
  assert.equal(measured.turnEndedReseated, false);
  assert.equal(measured.verdict, 'pass');
});

test('a never shown character fails with its dominant driving hide reason even without protection', () => {
  const rows = [1000, 1050, 1100].map(t => row(t, { shown: false, size: null, protectedRects: [],
    maxWindowBoundsDifferencePt: null, hideReason: t === 1050 ? 'call' : 'hide' }));
  // Transition totals and cleanup do not decide the dominant driving reason.
  rows[0].status.hideReasonCounts = { call: 100 };
  rows.push(row(1150, { shown: true, hideReason: 'cleanup' }));
  const actual = result(rows);
  assert.equal(actual.verdict, 'fail');
  assert.equal(actual.measured, false);
  assert.equal(actual.characterNeverShown, true);
  assert.equal(actual.dominantHideReason, 'hide');
  assert.match(actual.reason, /character never shown.*hide/);
  assert.equal(actual.visibleShare, null, 'missing protection still cannot qualify the figures');
});

test('missing host samples remain unmeasured and one valid shown sample avoids the never-shown diagnosis', () => {
  assert.equal(result([]).verdict, 'unmeasured');
  const rows = [row(1000, { shown: false }), row(1050), row(1100, { shown: false })];
  assert.notEqual(result(rows).characterNeverShown, true);
});
