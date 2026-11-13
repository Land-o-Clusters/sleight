import test from 'node:test';
import assert from 'node:assert/strict';
import { createMacReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { createWindowsReplClient } from '../plugins/sleight/lib/windows-repl/client.mjs';
import { waitForReadiness } from './fixtures/wait-for-readiness.mjs';

for (const [name, create, options, refusal] of [
  ['Mac', createMacReplClient, { platform: 'darwin', selectNode: () => undefined }, 'REPL_NODE_UNSUPPORTED'],
  ['Windows', createWindowsReplClient, { platform: 'linux' }, 'PLATFORM'],
]) test(`${name} early real-client refusal ends readiness with the result text`, async t => {
  const client = create({ ...options, spawn() { assert.fail('unavailable worker must not spawn'); },
    driver: { async request() { assert.fail('no driver access'); }, async restart() {}, async close() {} } });
  t.after(() => client.close());
  await assert.rejects(waitForReadiness(new Promise(() => {}), client.execute({ code: '1' })),
    new RegExp(`call completed before readiness: ${refusal}`));
});

test('readiness returns its value and has a bounded missing-event failure', async () => {
  const pending = new Promise(() => {});
  assert.equal(await waitForReadiness(Promise.resolve('ready'), pending), 'ready');
  await assert.rejects(waitForReadiness(pending, pending, { label: 'fixture event', timeoutMs: 10 }),
    /fixture event timed out/);
});
