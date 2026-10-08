import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupChessTrial } from '../bench/reliability-cleanup.mjs';

function setup(overrides = {}) {
  const calls = [], journal = [];
  let processReads = 0;
  const api = { title: 'Owned new game', initialTitles: ['Owned initial game'], pid: 123, journal,
    cancelDialog: async () => { calls.push('cancel'); return { cancelled: false }; },
    close: async () => { calls.push('close'); return { closed: true }; },
    snapshot: async () => ({ running: true, pid: 123, windows: [{ title: 'Owned initial game', bounds: { Width: 1000 } }] }),
    quit: async () => { calls.push('quit'); }, process: async () => ({ running: processReads++ === 0, pid: 123 }), wait: async () => { calls.push('wait'); }, ...overrides };
  return { api, calls, journal };
}
test('failed dialog cancellation and unconfirmed closure prevent app-wide quit', async () => {
  for (const overrides of [{ cancelDialog: async () => { throw new Error('cancel failed'); } }, { close: async () => ({ closed: false }) }]) {
    const h = setup(overrides);
    await assert.rejects(cleanupChessTrial(h.api), /cancel failed|closure unconfirmed/);
    assert.ok(!h.calls.includes('quit'));
    assert.ok(h.journal.some(x => x.error));
  }
});
test('one unexpected game or a replaced process prevents app-wide quit', async () => {
  for (const value of [{ running: true, pid: 123, windows: [{ title: 'Someone else', bounds: { Width: 1000 } }] },
    { running: true, pid: 456, windows: [] }]) {
    const h = setup({ snapshot: async () => value });
    await assert.rejects(cleanupChessTrial(h.api), /Unexpected game|process replaced/);
    assert.ok(!h.calls.includes('quit'));
  }
});
test('replacement PID is rejected before cancelling or closing anything', async () => {
  const h = setup({ process: async () => ({ running: true, pid: 456 }) });
  await assert.rejects(cleanupChessTrial(h.api), /process replaced/);
  assert.deepEqual(h.calls, []);
});
test('quit rejection is recorded and process absence is required', async () => {
  const rejected = setup({ quit: async () => { throw new Error('quit rejected'); } });
  await assert.rejects(cleanupChessTrial(rejected.api), /quit rejected/);
  assert.ok(rejected.journal.some(x => x.error === 'quit rejected'));
  const stuck = setup({ process: async () => ({ running: true, pid: 123 }) });
  await assert.rejects(cleanupChessTrial(stuck.api), /did not exit/);
});
test('delayed exit is collected before cleanup returns', async () => {
  let reads = 0;
  const h = setup({ process: async () => ({ running: ++reads < 4, pid: 123 }) });
  const result = await cleanupChessTrial(h.api);
  assert.equal(result.running, false);
  assert.equal(reads, 4);
  assert.deepEqual(h.calls, ['cancel', 'close', 'quit', 'wait', 'wait']);
});
