import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const receipt = JSON.parse(readFileSync(new URL('./fixtures/int23o-audit-receipts.json', import.meta.url)));
const historical = JSON.parse(readFileSync(new URL('./fixtures/int23h-audit-receipts.json', import.meta.url)));
// Closure ordinals are compiler names, so compare their stable caller and operation names.
const stable = line => line.replace(/<>c__DisplayClass\d+/g, '<>c__DisplayClass#').replace(/<Post>b__[0-9a-f]+/g, '<Post>b__#');
function added(current, old) {
  const left = old.map(stable), result = [];
  for (const line of current) {
    const i = left.indexOf(stable(line));
    if (i < 0) result.push(line); else left.splice(i, 1);
  }
  assert.deepEqual(left, [], 'no historical write edge disappears');
  return result;
}
test('merged guest audit preserves the baseline and names all three added write edges', () => {
  assert.equal(receipt.guestJobs, 60);
  assert.equal(receipt.receipts.baseline.checks.passed, 101);
  assert.equal(receipt.receipts.baseline.checks.failed, 0);
  assert.equal(receipt.receipts.baseline.checks.auditWrites, 0);
  assert.deepEqual(receipt.receipts.baseline.checks.auditWriteLines, []);
  for (const name of ['INT23D-topology-write', 'INT23D-helper-write']) {
    const row = receipt.receipts[name], old = historical[name];
    assert.equal(row.buildExit, 0); assert.equal(row.runExit, 1); assert.equal(row.expectedExit, 1);
    assert.equal(row.checks.auditWrites, 42); assert.equal(row.checks.auditWriteLines.length, 42);
    assert.equal(old.auditWrites, 39); assert.equal(row.checks.auditNamespace, 'Sleight.Driver');
    assert.deepEqual(added(row.checks.auditWriteLines, old.auditWriteLines), receipt.addedWriteLines);
  }
});
test('saved merged guest transcript binds all sixty job results and audit receipts', () => {
  const bytes = gunzipSync(readFileSync(new URL('./fixtures/int23o-guest-transcript.jsonl.gz', import.meta.url)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.transcriptSha256);
  const jobs = bytes.toString().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(jobs.length, 60);
  assert.ok(jobs.every(j => j.build === 0 && j.run === j.expect));
  for (const [name, row] of Object.entries(receipt.receipts)) {
    const job = jobs.find(j => j.name === 'confinement-' + name);
    assert.deepEqual(JSON.parse(typeof job.stdout === 'string' ? job.stdout : job.stdout.value), row.checks);
  }
});
