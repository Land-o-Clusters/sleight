import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as flow from '../plugins/sleight/lib/flow-rules.mjs';
import { codeInspectionRefusal } from '../plugins/sleight/lib/call-inspection.mjs';

test('the shipped flow module exposes parser consumers without the legacy tokenizer', () => {
  assert.equal(Object.hasOwn(flow, 'tokens'), false);
  assert.equal(Object.hasOwn(flow, 'invalidTokens'), false);
  assert.equal(typeof flow.calls, 'function');
  assert.equal(typeof flow.FlowRules, 'function');
  assert.equal(flow.codeInspectionRefusal, codeInspectionRefusal);
});

test('legacy comparisons use the frozen c9fb85bb scanner and its own line helpers', () => {
  const source = readFileSync(new URL('./fixtures/cell-tokenizer-legacy.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),
    '90a1445999392b1cb8f16dc1cbee0d2fdcc9a869c8ed650e1d7ac5c6a0cb8650');
});
