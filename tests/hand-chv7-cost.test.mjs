import test from 'node:test';
import assert from 'node:assert/strict';
import { stageVerdict, reportMarkdown, STAGE_BUDGET } from '../bench/hand/stage-cost.mjs';

test('CHV7 cost report preserves per-decode parts and the unchanged total/limit', () => {
  const span = { queuedMs: 10, startedMs: 11, publishedMs: 40, queueMs: 1, decodeMs: 29,
    validationMs: 1, spawnMs: 2, transferMs: 20, reapMs: 0.1, scanMs: 4, imageMs: 0.9, otherMs: 1 };
  const bank = { runs: [{ round: 1, sizes: { medium: { dump: { decodeMs: [29], decodeSpans: [span] } } } }] };
  const result = stageVerdict(bank), size = result.runs[0].sizes.medium;
  assert.deepEqual(size.observations.decodeSpans, [span]);
  const report = reportMarkdown(result);
  assert.match(report, /medium decode components, ms/);
  for (const [key, value] of Object.entries(span)) assert.ok(report.includes('"' + key + '":' + value));
  assert.equal(size.checks.find(c => c.name === 'decode').value, 29); assert.equal(STAGE_BUDGET.decodeMs, 40);
  const old = stageVerdict({ runs: [{ round: 1, sizes: { medium: { dump: { decodeMs: [29] } } } }] });
  assert.match(reportMarkdown(old), /medium decode components: not measured/);
  assert.deepEqual(old.runs[0].sizes.medium.observations.decodeSpans, []);
});
