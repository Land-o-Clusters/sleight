// Offline classification cost only. No engine, browser, model or app runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textKinds } from '../plugins/sleight/lib/turn-stats.mjs';

test('large UI tree classification has an independently known size and reports per-reply cost', t => {
  // A 33-byte header and 10,000 identical 18-byte ASCII rows.
  const tree = 'Window: "Fixture", App: Example.\n' + '\t1 button Example\n'.repeat(10000);
  assert.equal(Buffer.byteLength(tree), 180033);
  for (let i = 0; i < 30; i++) textKinds(tree);
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    const result = textKinds(tree);
    samples.push(performance.now() - start);
    assert.deepEqual(result, { docs: 0, tree: 180033, other: 0 });
  }
  samples.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ rows: 10000, bytes: 180033, warmup: 30, replies: 200,
    medianMs: samples[99], p90Ms: samples[179], maxMs: samples[199] }));
});
