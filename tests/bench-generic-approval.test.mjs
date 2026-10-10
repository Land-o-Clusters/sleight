import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardGenericOperation } from '../bench/generic-approval.mjs';

test('hold, unsupported elicitation and permission observer errors prevent a driver launch', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'generic-approval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stopFile = join(dir, 'stop'); writeFileSync(stopFile, 'unsupported approval: unknown schema');
  for (const options of [{ held: () => true }, { held: () => false, stopFile },
    { held: () => false, permissionCheck: () => { throw new Error('observer timed out'); } }]) {
    const result = await guardGenericOperation(() => assert.fail('driver must not start'), options);
    assert.equal(result.groupClean, true); assert.equal(result.code, 1);
    assert.match(result.approvalStop, /hold|schema|observer timed out/);
  }
});

test('an elicitation refusal during a driver aborts and waits for its collection', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'generic-approval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stopFile = join(dir, 'stop'); let collected = false;
  const result = await guardGenericOperation(async signal => {
    writeFileSync(stopFile, 'unsupported approval: non-benchmark app');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    collected = true;
    return { code: 143, groupClean: true };
  }, { held: () => false, stopFile, interval: 5 });
  assert.equal(collected, true); assert.equal(result.code, 143); assert.match(result.approvalStop, /non-benchmark app/);
});
