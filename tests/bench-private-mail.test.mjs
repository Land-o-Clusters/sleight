import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateMailResult, publicPrivateMailRow, publicPrivateMailRows, publishPrivateMailResults } from '../bench/private-mail.mjs';

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

test('chat read results hash the author the same way as private mail and drop the name', () => {
  const task = { id: 'slack-read', privateExpected: () => 'Invented Author' };
  const result = { passed: true, seconds: 2, out: { result: '{"answer":"Invented Author"}', num_turns: 4 } };
  const row = privateMailResult(task, {}, result, { arm: 'sleight', run: 1 });
  assert.equal(row.passed, true);
  assert.match(row.expectedHash, /^[a-f0-9]{64}$/);
  assert.equal(row.expectedHash, row.actualHash);
  assert.equal(JSON.stringify(row).includes('Invented'), false);
  assert.throws(() => privateMailResult({ ...task, id: 'slack-write' }, {}, result, { arm: 'sleight', run: 1 }),
    /PRIVATE_MAIL_RESULT_INVALID/);
});

test('private pass save keeps setup-stop rows as a bare failed phase and still refuses unknown tasks and raw hashes', () => {
  const hashed = privateMailResult({ id: 'slack-read', privateExpected: () => 'Invented Author' }, {},
    { passed: false, seconds: 0, reason: 'CHAT_NOT_RUNNING' }, { arm: 'sleight', run: 1 });
  assert.deepEqual(publicPrivateMailRows([
    { phase: 'preflight', passed: false, reason: 'sleight arm also loads lcu' },
    { arm: 'sleight', phase: 'configuration', passed: false, reason: 'CHAT_OWNER_AWAY_UNPROVED' },
    hashed,
  ]), [{ phase: 'preflight', passed: false }, { arm: 'sleight', phase: 'configuration', passed: false }, hashed]);
  assert.deepEqual(publicPrivateMailRows([{ arm: 'Invented Author', phase: 'Invented Author', passed: true }]), [{ phase: 'stop', passed: false }]);
  assert.equal(JSON.stringify(publicPrivateMailRows([{ phase: 'preflight', passed: false, reason: 'Invented Author' }]))
    .includes('Invented'), false);
  assert.throws(() => publicPrivateMailRows([{ arm: 'sleight', task: 'safari-shop', run: 1, passed: false }]),
    /PRIVATE_MAIL_RESULT_INVALID/);
  assert.throws(() => publicPrivateMailRows([{ arm: 'sleight', task: 'slack-read', run: 1, passed: false,
    expectedHash: 'Invented Author' }]), /PRIVATE_MAIL_RESULT_INVALID/);
  assert.throws(() => publicPrivateMailRows([{ expectedHash: 'Invented Author' }]), /PRIVATE_MAIL_RESULT_INVALID/);
  assert.throws(() => publicPrivateMailRows([{ passed: false, answer: 'Invented Author' }]),
    /PRIVATE_MAIL_RESULT_INVALID/);
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
