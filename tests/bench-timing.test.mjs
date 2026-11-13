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
