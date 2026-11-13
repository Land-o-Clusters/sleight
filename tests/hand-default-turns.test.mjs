import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordDefaultTurn } from './fixtures/default-hand-turns.mjs';
const baseline = JSON.parse(readFileSync(new URL('./fixtures/int23d-default-turns.json', import.meta.url)));
const sourceHashKeys = ['hand/browser-hand.mjs', 'hand/client.mjs', 'hand/events.mjs', 'hand/runtime-hand.mjs', 'relay.mjs'];
function assertSourceHashes(hashes) {
  assert.equal(Object.keys(hashes).length, sourceHashKeys.length);
  assert.deepEqual(Object.keys(hashes).sort(), [...sourceHashKeys].sort());
}
for (const route of ['Glide', 'turbo']) test(`default ${route} turn matches the recorded CHRET4 wire frames`, async t => {
  const actual = await recordDefaultTurn(route);
  assert.equal(baseline.base, '73bc6b73786a9ac5b70e25aa405c6992024a8b0b');
  assertSourceHashes(baseline.sourceHashes);
  assert.deepEqual(actual, baseline.turns[route]);
  assert.ok(actual.some(row => row.hand === 'act'));
  assert.ok(actual.some(row => row.hand === 'status' && row.state === 'done' && row.ok !== true));
  assert.equal(actual.filter(row => row.hand === 'stage-producer').length, 0);
  t.diagnostic(`${route}: ${actual.length} identical frames; nonce omitted; 0 producer frames`);
});

test('default turn source hashes reject a missing or extra key', () => {
  const missing = { ...baseline.sourceHashes };
  delete missing['relay.mjs'];
  assert.throws(() => assertSourceHashes(missing), assert.AssertionError);
  assert.throws(() => assertSourceHashes({ ...baseline.sourceHashes, 'hand/other.mjs': 'abc' }), assert.AssertionError);
});
