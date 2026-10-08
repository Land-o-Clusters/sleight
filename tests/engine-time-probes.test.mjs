import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatorValue } from '../bench/calculator-value.mjs';

test('Calculator probes distinguish the current value from a matching history entry', () => {
  const current = '\t7 text Description: Edit field, Value: 0';
  const history = '\t5 text Description: Last Expression, Value: 12,345,678';
  assert.equal(calculatorValue(current + '\n' + history), '0');
  assert.equal(calculatorValue('\t7 text Description: Edit field, Value: 12,345,678'), '12345678');
  assert.throws(() => calculatorValue(history), /missing or ambiguous/);
  assert.throws(() => calculatorValue(current + '\n' + current), /missing or ambiguous/);
});
