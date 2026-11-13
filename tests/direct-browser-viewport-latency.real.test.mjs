import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { setViewport } from '../plugins/sleight/lib/direct-browser/viewport.mjs';

test('G10D ten headless resets measure result latency', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<!doctype html><meta name="viewport" content="width=device-width"><p>Owned layout fixture</p>',
    {}, { nativeViewport: true }), page = f.entry.page;
  const samples = [], results = [];
  for (let i = 0; i < 10; i++) {
    await setViewport(page, { width: 390, height: 844 });
    assert.equal(await page.evaluate(() => innerWidth), 390);
    const start = performance.now();
    results.push(await setViewport(page, {}));
    samples.push(performance.now() - start);
    await page.waitForFunction(() => innerWidth === 1280, undefined, { polling: 20, timeout: 2000 });
    const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const result = results.at(-1), reported = result.match(/^viewport restored(?: to (\d+)x(\d+)|; layout had not settled)$/);
    assert.ok(reported, result);
    if (reported[1]) assert.deepEqual({ width: +reported[1], height: +reported[2] }, { width, height }, result);
  }
  assert.ok(results.filter(result => /^viewport restored to \d+x\d+/.test(result)).length >= 8,
    'at least 8 of 10 resets must report measured dimensions');
  const sorted = [...samples].sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ samplesMs: samples, medianMs: (sorted[4] + sorted[5]) / 2,
    rangeMs: [sorted[0], sorted.at(-1)], results }));
});
