import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectEngine } from '../bench/window-targeting-cleanup.mjs';

test('benchmark collects an engine before releasing leases even when relay shutdown hangs', async () => {
  const events = [];
  let collect;
  const stopped = new Promise(resolve => { collect = resolve; });
  const child = { stdin: { end: () => events.push('EOF') }, kill: signal => {
    events.push(signal); collect({ code: null, signal });
  } };
  const relay = { shutdown: () => new Promise(() => {}), close: () => events.push('leases released') };
  const result = await collectEngine({ child, stopped, relay, graceMs: 10, forceMs: 10 });
  assert.equal(result.collected, true);
  assert.deepEqual(result.signals, ['SIGTERM']);
  assert.deepEqual(events, ['EOF', 'SIGTERM', 'leases released']);
});

test('a graceful engine exit needs no signals and is collected before final disposal', async () => {
  const events = [];
  let collect;
  const child = { stdin: { end: () => { events.push('EOF'); collect({ code: 0, signal: null }); } },
    kill: () => assert.fail('Graceful exit must not be signaled') };
  const stopped = new Promise(resolve => { collect = resolve; });
  const result = await collectEngine({ child, stopped,
    relay: { shutdown: async () => {}, close: () => events.push('leases released') }, graceMs: 10, forceMs: 10 });
  assert.deepEqual(result, { code: 0, signal: null, collected: true, signals: [] });
  assert.deepEqual(events, ['EOF', 'leases released']);
});

test('unconfirmed engine exit has a bounded failure and does not release active leases', async () => {
  const signals = [];
  await assert.rejects(collectEngine({ child: { stdin: { end() {} }, kill: signal => signals.push(signal) },
    stopped: new Promise(() => {}), relay: { shutdown: () => new Promise(() => {}),
      close: () => assert.fail('Do not release leases without collection') }, graceMs: 10, forceMs: 10 }), /exit unconfirmed/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
