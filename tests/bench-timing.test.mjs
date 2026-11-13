import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intervalUnion, runSplit, runTiming, traceTiming, withStamps } from '../bench/timing.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const at = ms => new Date(Date.UTC(2026, 9, 7) + ms).toISOString();
const line = (ms, direction, msg) => JSON.stringify({ t: at(ms), direction, msg });
const call = (id, name) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

test('read-only and refused Glide cells report zero actions, distinct from no receipts', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-glide-zero-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'trace-1.jsonl'), [
    line(0, 'call-received', call(1, 'js')),
    line(1, 'to-client', { id: 1, result: { timing: { actions: [], cellMs: 1 } } }),
    line(2, 'call-received', call(2, 'js')),
    line(3, 'to-client', { id: 2, result: { isError: true, timing: { actions: [], cellMs: 2 } } }),
  ].join('\n'));
  const timing = traceTiming(dir);
  assert.equal(timing.glideCells, 2); assert.equal(timing.glideActions, 0);
  assert.equal(timing.glideCellMs, 3); assert.equal(timing.glideActionFailures, 0);
  assert.equal(timing.glideActionPhases.totalMs, 0);
  writeFileSync(join(dir, 'trace-1.jsonl'), [line(0, 'call-received', call(1, 'js')),
    line(1, 'to-client', { id: 1, result: {} })].join('\n'));
  const absent = traceTiming(dir);
  assert.equal(absent.glideCells, undefined); assert.equal(absent.glideActions, undefined);
});

test('Glide phases reach benchmark result timing without summing startup compilation per cell', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-glide-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const action = { method: 'click', admissionMs: 1, admissionReadMs: 2, personMs: 3, policyMs: 4,
    sendMs: 5, settleMs: 6, postReadMs: 7, driverMs: 19, observeMs: 8, totalMs: 37,
    nativeTimingAvailable: true, failed: false, title: 'PRIVATE' };
  const preparation = { status: 'ready', elapsedMs: 47000, compileMs: 46000, waitMs: 1 };
  writeFileSync(join(dir, 'trace-1.jsonl'), [
    line(0, 'call-received', call(1, 'js')),
    line(1, 'to-client', { id: 1, result: { timing: { preparation: { ...preparation, status: 'preparing', compileMs: 30000, elapsedMs: 31000, waitMs: 40 } } } }),
    line(10, 'call-received', call(2, 'js')),
    line(11, 'from-server', { id: 2, result: { timing: { actions: [action] } } }),
    line(12, 'to-client', { id: 2, result: { timing: { actions: [action, { ...action, sendMs: -1 }], preparation, cellMs: 50 } } }),
    // A duplicate trace response replaces its receipt rather than counting it twice.
    line(12, 'to-client', { id: 2, result: { timing: { actions: [action], preparation, cellMs: 50 } } }),
    line(20, 'call-received', call(3, 'js')),
    line(21, 'to-client', { id: 3, result: { timing: { actions: [{ ...action, nativeTimingAvailable: false, failed: true,
      sendMs: 0, settleMs: 0, postReadMs: 0 }], preparation, cellMs: 30 } } }),
    line(30, 'call-received', call(4, 'js')),
    line(31, 'to-client', { id: 4, result: { content: [{ type: 'text', text: JSON.stringify({ timing: { actions: [action] } }) }] } }),
  ].join('\n'));
  writeFileSync(join(dir, 'trace-2.jsonl'), [
    line(40, 'call-received', call(1, 'js')),
    line(41, 'to-client', { id: 1, result: { timing: { preparation: { status: 'ready', elapsedMs: 300, compileMs: 200, waitMs: 2 } } } }),
  ].join('\n'));
  const timing = runTiming({ duration_ms: 100, duration_api_ms: 5 }, traceTiming(dir));
  assert.equal(timing.glideCells, 2);
  assert.equal(timing.glideActions, 2);
  assert.equal(timing.glideActionFailures, 1);
  assert.equal(timing.glideNativeTimingMissingActions, 1);
  for (const [key, expected] of Object.entries({ admissionMs: 2, admissionReadMs: 4, personMs: 6, policyMs: 8,
    sendMs: 5, settleMs: 6, postReadMs: 7, driverMs: 38, observeMs: 16, totalMs: 74 }))
    assert.equal(timing.glideActionPhases[key], expected, key);
  assert.equal(timing.glideCellMs, 80);
  assert.deepEqual(timing.glidePreparation, { compileMs: 46200, elapsedMs: 47300, waitMs: 44, preparingCalls: 1 });
  assert.doesNotMatch(JSON.stringify(timing), /PRIVATE/);
});

test('a preparing receipt with no executed cell still reports zero cells and zero actions', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-glide-preparing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'trace-1.jsonl'), [line(0, 'call-received', call(1, 'js')),
    line(1, 'to-client', { id: 1, result: { timing: {
      preparation: { status: 'preparing', compileMs: 10, elapsedMs: 20, waitMs: 5 },
    } } })].join('\n'));
  const timing = traceTiming(dir);
  assert.equal(timing.glideCells, 0); assert.equal(timing.glideActions, 0);
  assert.equal(timing.glidePreparation.preparingCalls, 1);
});

test('malformed Glide timing and model text cannot create a phase receipt', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-glide-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invalid = { admissionMs: 1, admissionReadMs: 2, personMs: 3, policyMs: 4,
    sendMs: -1, settleMs: 6, postReadMs: 7, driverMs: 19, observeMs: 8, totalMs: 37 };
  writeFileSync(join(dir, 'trace-1.jsonl'), [
    line(0, 'call-received', call(1, 'js')),
    line(1, 'to-client', { id: 1, result: { timing: { cellMs: -1, actions: [invalid, { ...invalid, sendMs: '100' }, { ...invalid, sendMs: 5, personMs: null }],
      preparation: { status: 'ready', elapsedMs: null, compileMs: 100, waitMs: 0 } } } }),
  ].join('\n'));
  const timing = traceTiming(dir);
  assert.equal(timing.glideActions, undefined);
  assert.equal(timing.glidePreparation, undefined);
  assert.equal(timing.glideCellMs, undefined);
});

test('tail stamps are ms from the run start and leave the other figures alone', () => {
  const timing = { totalMs: 4000, elapsedMs: 4600, harnessMs: 600 };
  const stamps = { spawnAt: 1005, stdoutAt: 5000, exitAt: 5100, closeAt: 5120, groupGoneAt: 5200 };
  assert.deepEqual(withStamps(timing, stamps, 1000).tailStamps, { stdoutMs: 4000, exitMs: 4100, closeMs: 4120, groupGoneMs: 4200 });
  assert.equal(timing.harnessMs, 600);
  assert.equal(withStamps(undefined, stamps, 1000), undefined);
  const bare = { totalMs: 1 };
  assert.equal(withStamps(bare, undefined, 1000), bare); assert.equal(bare.tailStamps, undefined);
});

test('splits tool time into engine, relay and local tools; a refusal is relay time only', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'trace-1.jsonl'), [
    line(0, 'call-received', call(1, 'js')), line(5, 'to-server', call(1, 'js')),
    // The relay's own guard read during call 1 doesn't start a call of its own.
    line(300, 'from-server', { id: 1 }), line(305, 'to-server', call('guard', 'js')), line(400, 'from-server', { id: 'guard' }),
    line(412, 'to-client', { jsonrpc: '2.0', id: 1, result: {} }),
    line(1000, 'call-received', call(2, 'js')), line(1001, 'from-client', call(2, 'js')), line(1003, 'to-client', { jsonrpc: '2.0', id: 2, result: { isError: true } }),
    line(1500, 'call-received', call(4, 'drag')), line(3500, 'to-client', { jsonrpc: '2.0', id: 4, result: {} }),
    line(2000, 'call-received', { jsonrpc: '2.0', id: 3, method: 'tools/list' }), line(2001, 'to-client', { jsonrpc: '2.0', id: 3, result: {} }),
  ].join('\n') + '\n');
  assert.deepEqual(traceTiming(dir), { calls: 3, refused: 1, toolMs: 2415, toolWallMs: 2415, engineMs: 295, relayMs: 120, localMs: 2000 });
  assert.deepEqual(runTiming({ duration_ms: 10000, duration_api_ms: 7000 }, traceTiming(dir), 10600),
    { totalMs: 10000, modelMs: 7000, calls: 3, refused: 1, toolMs: 2415, toolWallMs: 2415, engineMs: 295, relayMs: 120, localMs: 2000,
      outsideToolsMs: 7585, elapsedMs: 10600, harnessMs: 600 });
});

test('an acquisition sent ahead of its actions counts as engine time, not relay time', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'trace-1.jsonl'), [
    line(0, 'call-received', call(1, 'js')),
    line(2, 'acquisition-split', { id: 1, acquisition: 'sleight-acquire-1' }),
    line(3, 'to-server', call('sleight-acquire-1', 'js')), line(953, 'from-server', { id: 'sleight-acquire-1' }),
    line(958, 'to-server', call(1, 'js')), line(1258, 'from-server', { id: 1 }),
    line(1262, 'to-client', { jsonrpc: '2.0', id: 1, result: {} }),
  ].join('\n') + '\n');
  const timing = traceTiming(dir);
  assert.equal(timing.engineMs, 950 + 300);
  assert.equal(timing.relayMs, 1262 - 950 - 300);
});

for (const linked of [true, false]) test(`open_file counts as a call: its open is local time and its window read engine time, linked=${linked}`, t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'trace-1.jsonl'), [
    line(0, 'call-received', call(2, 'open_file')), line(1, 'from-client', call(2, 'open_file')),
    // Traces from before the relay logged the link still pair the read with the waiting open_file.
    ...(linked ? [line(440, 'acquisition-split', { id: 2, acquisition: 'sleight-open-file-7' })] : []),
    line(442, 'to-server', call('sleight-open-file-7', 'js')), line(652, 'from-server', { id: 'sleight-open-file-7' }),
    line(658, 'to-client', { jsonrpc: '2.0', id: 2, result: {} }),
  ].join('\n') + '\n');
  assert.deepEqual(traceTiming(dir), { calls: 1, refused: 0, toolMs: 658, toolWallMs: 658, engineMs: 210, relayMs: 6, localMs: 442 });
});

test('no trace leaves only the model split', () => {
  assert.equal(traceTiming('/no/such/dir'), undefined);
  assert.deepEqual(runTiming({ duration_ms: 5000, duration_api_ms: 4000 }), { totalMs: 5000, modelMs: 4000 });
});

test('guard reads are counted as a subset of engine time, including failed reads', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-guard-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'trace-2.jsonl'), [
    line(0, 'call-received', call(1, 'js')), line(2, 'to-server', call(1, 'js')),
    line(102, 'from-server', { id: 1 }),
    line(103, 'guard-read', { id: 1, phase: 'before-action', ms: 30.5, chars: 100, failed: false }),
    line(103, 'guard-read', { id: 1, phase: 'after-call', ms: 40.5, chars: 0, failed: true }),
    line(104, 'to-client', { id: 1, result: {} }),
  ].join('\n'));
  assert.deepEqual(traceTiming(dir), { calls: 1, refused: 0, toolMs: 104, toolWallMs: 104, engineMs: 100, relayMs: 4,
    localMs: 0, guardReads: 2, guardReadMs: 71, guardReadFailures: 1 });
});

const additive = t => [t.toolWallMs, t.outsideToolsMs, t.harnessMs];

test('native identity read and admission costs reach saved benchmark timing, including split reads and refusals', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-native-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'trace-1.jsonl'), [
    line(0, 'call-received', call(1, 'js')),
    line(1, 'acquisition-split', { id: 1, acquisition: 'child' }),
    line(2, 'to-server', call('child', 'js')), line(12, 'from-server', { id: 'child' }),
    line(15, 'native-window-read-identity', { id: 'child', ms: 3.25, confirmed: true, reused: false }),
    line(16, 'native-window-admission', { id: 1, ms: 1.5, confirmed: true }),
    line(17, 'to-server', call(1, 'js')), line(20, 'from-server', { id: 1 }), line(21, 'to-client', { id: 1 }),
    line(30, 'call-received', call(2, 'js')),
    line(31, 'native-window-read-identity', { id: 2, ms: 0, confirmed: true, reused: true }),
    line(32, 'native-window-admission', { id: 2, ms: 0.75, failed: true, confirmed: false }),
    line(33, 'to-client', { id: 2, result: { isError: true } }),
    line(40, 'call-received', call(3, 'js')),
    line(41, 'native-window-read-identity', { id: 3, ms: 0.5, failed: true, reused: false }),
    ...[-1, '2', null].map(ms => line(41, 'native-window-admission', { id: 3, ms })),
    line(42, 'to-client', { id: 3 }),
  ].join('\n'));
  const timing = runTiming({ duration_ms: 50 }, traceTiming(dir));
  assert.equal(timing.nativeWindowAdmissions, 2);
  assert.equal(timing.nativeWindowAdmissionMs, 2.25);
  assert.equal(timing.nativeWindowAdmissionFailures, 1);
  assert.equal(timing.nativeWindowReadIdentities, 3);
  assert.equal(timing.nativeWindowReadIdentityMs, 3.75);
  assert.equal(timing.nativeWindowReadIdentityReused, 1);
  assert.equal(timing.nativeWindowReadIdentityFailures, 1);
});

test('overlapping calls count once in tool wall time, and the parts add up to elapsed', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Two calls in one trace overlap from 400 to 1000 ms; a third in another trace is inside the second.
  writeFileSync(join(dir, 'trace-1.jsonl'), [
    line(0, 'call-received', call(1, 'js')), line(400, 'call-received', call(2, 'js')),
    line(1000, 'to-client', { jsonrpc: '2.0', id: 1, result: {} }), line(1500, 'to-client', { jsonrpc: '2.0', id: 2, result: {} }),
    line(3000, 'call-received', call(3, 'js')), line(3200, 'to-client', { jsonrpc: '2.0', id: 3, result: {} }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'trace-2.jsonl'), [
    line(600, 'call-received', call(1, 'drag')), line(900, 'to-client', { jsonrpc: '2.0', id: 1, result: {} }),
  ].join('\n') + '\n');
  const trace = traceTiming(dir);
  assert.equal(trace.toolMs, 1000 + 1100 + 200 + 300);
  assert.equal(trace.toolWallMs, 1500 + 200);
  const timing = runTiming({ duration_ms: 4000, duration_api_ms: 1800 }, trace, 4700);
  assert.deepEqual(additive(timing), [1700, 2300, 700]);
  assert.equal(additive(timing).reduce((a, b) => a + b), timing.elapsedMs);
});

test('API time larger than the time outside tools stays a separate figure and leaves every part non-negative', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'trace-1.jsonl'), [
    line(0, 'call-received', call(1, 'js')), line(1047, 'to-client', { jsonrpc: '2.0', id: 1, result: {} }),
  ].join('\n') + '\n');
  // calculator-click run 1 of 2026-10-17: the old split put other at 8167 - 7680 - 1047 = -560 ms.
  const timing = runTiming({ duration_ms: 8167, duration_api_ms: 7680 }, traceTiming(dir), 8900);
  assert.equal(timing.otherMs, undefined);
  assert.equal(timing.modelMs, 7680);
  assert.ok(timing.modelMs > timing.outsideToolsMs);
  assert.deepEqual(additive(timing), [1047, 7120, 733]);
  assert.ok(additive(timing).every(x => x >= 0));
  assert.equal(additive(timing).reduce((a, b) => a + b), 8900);
});

test('intervalUnion merges touching and nested intervals and skips broken ones', () => {
  assert.equal(intervalUnion([]), 0);
  assert.equal(intervalUnion([[5, 10], [0, 5], [6, 7], [20, 25], [30, NaN], [40, 39]]), 15);
});

test('runSplit reads new rows, old rows and old rows with a fresh trace', () => {
  const fresh = { seconds: 8.9, timing: { totalMs: 8167, modelMs: 7680, calls: 2, toolMs: 1200, toolWallMs: 1047, elapsedMs: 8912 } };
  assert.deepEqual(runSplit(fresh), { elapsedMs: 8912, toolMs: 1047, outsideToolsMs: 7120, harnessMs: 745, apiMs: 7680, calls: 2, overlapUnknown: false });
  // A row saved before toolWallMs: its toolMs adds calls, and its seconds are rounded.
  const old = { seconds: 8.9, timing: { totalMs: 8167, modelMs: 7680, calls: 2, toolMs: 1047, otherMs: -560 } };
  assert.deepEqual(runSplit(old), { elapsedMs: 8900, toolMs: 1047, outsideToolsMs: 7120, harnessMs: 733, apiMs: 7680, calls: 2, overlapUnknown: true });
  assert.deepEqual(runSplit(old, { calls: 3, toolWallMs: 1500 }), { elapsedMs: 8900, toolMs: 1500, outsideToolsMs: 6667, harnessMs: 733,
    apiMs: 7680, calls: 3, overlapUnknown: false });
  // Rounding never puts elapsed under Claude Code's own duration.
  assert.equal(runSplit({ seconds: 8.1, timing: { totalMs: 8167, toolMs: 0 } }).harnessMs, 0);
  assert.equal(runSplit({ seconds: 3, timing: undefined }), undefined);
});
