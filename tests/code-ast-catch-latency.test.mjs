import test from 'node:test';
import assert from 'node:assert/strict';
import * as flow from '../plugins/sleight/lib/flow-rules.mjs';
import { clearCellCache, parseCell } from '../plugins/sleight/lib/code-ast.mjs';
import { FLOW_BASE, revisionFlow, statementCell, measureCalls, median } from './fixtures/revision-flow.mjs';

test('calls on 2,000 statements takes at most 1.5 times the same-run base', async t => {
  const base = await revisionFlow(FLOW_BASE);
  t.after(base.cleanup);
  const current = { ...flow, clearCellCache };
  const code = statementCell(2000);
  assert.equal(parseCell(code).ast.body.length, 2000);
  // Warm both implementations equally, then alternate order and use medians.
  for (const arm of [base, current]) measureCalls(arm, statementCell(200));
  const samples = { base: [], current: [] };
  for (let round = 0; round < 7; round++) {
    for (const name of round % 2 ? ['current', 'base'] : ['base', 'current'])
      samples[name].push(measureCalls(name === 'base' ? base : current, code));
  }
  const baseMs = median(samples.base), currentMs = median(samples.current);
  const result = { statements: 2000, bytes: Buffer.byteLength(code), samples, baseMs, currentMs, ratio: currentMs / baseMs };
  t.diagnostic(JSON.stringify(result));
  assert.ok(currentMs <= 1.5 * baseMs, JSON.stringify(result));
});
