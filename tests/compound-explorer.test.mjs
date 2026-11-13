import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreCompound } from './fixtures/compound-explorer.mjs';

for (const operation of ['menu', 'choose']) test(`production ${operation} explorer rejects dispatch after a latch or revoked authority`, async t => {
  const result = await exploreCompound({ operation, depth: 192 });
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.invariantFailures, 0, JSON.stringify(result.counterexamples));
  assert.ok(result.states > 100); assert.ok(result.transitions > result.states);
  assert.ok(result.schedules > 100); assert.ok(result.eventsFired > 100);
  assert.ok(result.depth <= result.bound);
  assert.deepEqual(result.kinds, operation === 'menu' ? ['menu.command', 'menu.expand', 'menu.open'] : ['choose.open', 'choose.select']);
});
