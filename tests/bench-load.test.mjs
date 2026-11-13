import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReceipt, loadWarnings } from '../bench/load.mjs';
import { runDriver } from '../bench/driver.mjs';

test('load warning uses only the 1-minute samples and the recorded core count', () => {
  for (const [loadStart, loadEnd, overloaded] of [
    [[11, 0, 0], [1, 0, 0], true], [[1, 0, 0], [11, 0, 0], true],
    [[10, 99, 99], [10, 99, 99], false],
  ]) {
    const row = { arm: 'sleight', task: 'calculator-click', run: 2, ...loadReceipt({ loadStart, loadEnd, loadCores: 10 }) };
    assert.equal(row.loadExceededCores, overloaded);
    assert.equal(loadWarnings([row]).length, Number(overloaded));
    if (overloaded) assert.match(loadWarnings([row])[0], /sleight\/calculator-click #2.*11.*10 cores/);
  }
  assert.deepEqual(loadReceipt(undefined), {});
  assert.deepEqual(loadReceipt({ loadStart: [NaN, 1, 2], loadEnd: [0, 0, 0], loadCores: 10 }), {});
});
test('the real driver client preserves spawn/exit samples from an offline Node child', async () => {
  const response = await runDriver(process.execPath, ['-e', 'console.log(JSON.stringify({result:"offline"}))']);
  assert.equal(response.code, 0); assert.equal(response.out.result, 'offline'); assert.equal(response.groupClean, true);
  const row = loadReceipt(response.stamps);
  assert.equal(row.loadStart.length, 3); assert.equal(row.loadEnd.length, 3);
  assert.ok(row.loadCores > 0); assert.equal(typeof row.loadExceededCores, 'boolean');
});
