import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTiming, traceTiming } from '../bench/timing.mjs';

const at = ms => new Date(Date.UTC(2026, 9, 7) + ms).toISOString();
const line = (ms, direction, msg) => JSON.stringify({ t: at(ms), direction, msg });
const call = (id, name) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

test('splits tool time into engine, relay and local tools; a refusal is relay time only', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-timing-'));
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
  assert.deepEqual(traceTiming(dir), { calls: 3, refused: 1, toolMs: 2415, engineMs: 295, relayMs: 120, localMs: 2000 });
  assert.deepEqual(runTiming({ duration_ms: 10000, duration_api_ms: 7000 }, traceTiming(dir)),
    { totalMs: 10000, modelMs: 7000, calls: 3, refused: 1, toolMs: 2415, engineMs: 295, relayMs: 120, localMs: 2000, otherMs: 585 });
});

test('no trace leaves only the model split', () => {
  assert.equal(traceTiming('/no/such/dir'), undefined);
  assert.deepEqual(runTiming({ duration_ms: 5000, duration_api_ms: 4000 }), { totalMs: 5000, modelMs: 4000 });
});

test('guard reads are counted as a subset of engine time, including failed reads', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-guard-timing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'trace-2.jsonl'), [
    line(0, 'call-received', call(1, 'js')), line(2, 'to-server', call(1, 'js')),
    line(102, 'from-server', { id: 1 }),
    line(103, 'guard-read', { id: 1, phase: 'before-action', ms: 30.5, chars: 100, failed: false }),
    line(103, 'guard-read', { id: 1, phase: 'after-call', ms: 40.5, chars: 0, failed: true }),
    line(104, 'to-client', { id: 1, result: {} }),
  ].join('\n'));
  assert.deepEqual(traceTiming(dir), { calls: 1, refused: 0, toolMs: 104, engineMs: 100, relayMs: 4,
    localMs: 0, guardReads: 2, guardReadMs: 71, guardReadFailures: 1 });
});
