import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateMailResult, publicPrivateMailRow, publishPrivateMailResults } from '../bench/private-mail.mjs';

test('private mail results expose only verdict, timing, turns and salted answer hashes', () => {
  const task = { id: 'mimestream-label', privateExpected: () => 'private answer' };
  const result = { passed: true, seconds: 1.2, reason: 'secret label', prompt: 'secret subject',
    out: { result: '{"answer":"private answer"}', num_turns: 3 }, stderr: 'private@example.test',
    appDialogs: ['private sender'], timing: { engineMs: 1 } };
  const a = privateMailResult(task, {}, result, { arm: 'sleight', run: 1 });
  const b = privateMailResult(task, {}, result, { arm: 'sleight', run: 1 });
  assert.deepEqual(Object.keys(a), ['arm', 'task', 'run', 'passed', 'seconds', 'turns', 'expectedHash', 'actualHash']);
  assert.equal(a.expectedHash, a.actualHash);
  assert.notEqual(a.expectedHash, b.expectedHash);
  assert.match(a.expectedHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(a).includes('private'), false);
  a.cleanupError = 'secret label';
  assert.equal('cleanupError' in publicPrivateMailRow(a), false);
});

test('failed or missing private answers remain failures with no fabricated answer hash', () => {
  const task = { id: 'mimestream-message', privateExpected: () => null };
  const row = privateMailResult(task, {}, { passed: false, seconds: NaN }, { arm: 'sleight', run: 1 });
  assert.equal(row.passed, false);
  assert.equal(row.expectedHash, null);
  assert.equal(row.actualHash, null);
  assert.equal(row.seconds, 0);
  assert.equal(row.turns, null);
  assert.throws(() => privateMailResult({ ...task, id: 'private label' }, {}, {}, { arm: 'sleight', run: 1 }), /PRIVATE_MAIL_RESULT_INVALID/);
  assert.throws(() => privateMailResult(task, {}, {}, { arm: 'lcu', run: 1 }), /PRIVATE_MAIL_RESULT_INVALID/);
});

test('literal quiet grep refuses owner names, addresses and every observed label before publication', t => {
  const dir = mkdtempSync(join(tmpdir(), 'private-mail-results-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'results.json');
  for (const secret of ['private@example.test', 'Owner Example', 'Label [a.*]', 'Second line']) {
    writeFileSync(file, 'previous audited result');
    assert.throws(() => publishPrivateMailResults(file, JSON.stringify({ result: secret }), {
      ownerName: 'Owner Example', terms: ['Label [a.*]', 'First line\nSecond line'],
    }), /PRIVATE_MAIL_PUBLICATION_REFUSED/);
    assert.equal(readFileSync(file, 'utf8'), 'previous audited result');
  }
  publishPrivateMailResults(file, '{"results":[]}', { ownerName: 'Owner Example', terms: ['Label [a.*]'] });
  assert.equal(readFileSync(file, 'utf8'), '{"results":[]}\n');
});
