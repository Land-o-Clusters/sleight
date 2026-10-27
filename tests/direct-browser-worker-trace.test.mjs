import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as worker from '../plugins/sleight/lib/direct-browser/worker.mjs';

test('phase records join the relay file and contain only fixed phases and numeric ordinals', t => {
  assert.equal(typeof worker.createWorkerTrace, 'function');
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-phase-test-')));
  const trace = worker.createWorkerTrace({ setting: join(dir, 'logs'), relayPid: 42, now: () => 1000 });
  t.after(() => trace.close());
  trace('call-result', 1, 2);
  trace('private page text', 1, 2);
  trace('call-result', 'private turn', { text: 'private input' });
  assert.equal(existsSync(join(dir, 'logs', 'trace-42.jsonl')), true, 'startup phases must survive before launch.mjs creates the trace directory');
  const rows = readFileSync(join(dir, 'logs', 'trace-42.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [{ t: '1970-01-01T00:00:01.000Z', direction: 'turbo-phase', msg: { phase: 'call-result', turn: 1, call: 2 } }]);
  trace.close(); trace.close(); trace('call-result', 1, 3);
  assert.equal(readFileSync(join(dir, 'logs', 'trace-42.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('disabled or unwritable phase tracing cannot throw or create a file', () => {
  assert.equal(typeof worker.createWorkerTrace, 'function');
  const off = worker.createWorkerTrace({ setting: '', relayPid: 42, now: () => assert.fail('clock read while disabled') });
  assert.doesNotThrow(() => off('call-result', 1, 2));
  const unavailable = worker.createWorkerTrace({ setting: import.meta.url.slice(7) + '/unwritable', relayPid: 42 });
  assert.doesNotThrow(() => unavailable('call-result', 1, 2));
});

test('open timings reach the metrics file without a relay trace and discard unknown phases and text', t => {
  const dir = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-open-metrics-')))), metrics = join(dir, 'turbo-metrics.jsonl');
  const trace = worker.createWorkerTrace({ setting: '', metrics, relayPid: 42, now: () => 1234 });
  trace('browser-open-create-start', 1, 2);
  trace('browser-open-navigated', 1, 2);
  trace('browser-open-goto-end', 1, 2);
  trace('call-result', 1, 2);
  trace('browser-open-private page', 1, 2);
  trace('browser-open-end', 'private text', 2);
  trace.close();
  const rows = readFileSync(metrics, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [
    { version: 3, t: '1970-01-01T00:00:01.234Z', phase: 'browser-open-create-start', turn: 1, call: 2 },
    { version: 3, t: '1970-01-01T00:00:01.234Z', phase: 'browser-open-navigated', turn: 1, call: 2 },
    { version: 3, t: '1970-01-01T00:00:01.234Z', phase: 'browser-open-goto-end', turn: 1, call: 2 },
  ]);
});
