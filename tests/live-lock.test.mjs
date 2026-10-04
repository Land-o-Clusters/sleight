import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir, rm, stat, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLiveLock } from '../bench/live-lock.mjs';

test('live runs admit one holder and release the lock after cleanup', async t => {
  const bank = await mkdtemp(join(tmpdir(), 'sleight-live-lock-test-'));
  t.after(() => rm(bank, { recursive: true, force: true }));
  const path = join(bank, 'lock');
  const results = await Promise.allSettled([acquireLiveLock(path), acquireLiveLock(path)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /Another live run/);
  await results.find(r => r.status === 'fulfilled').value();
  await assert.rejects(stat(path), { code: 'ENOENT' });
  const release = await acquireLiveLock(path);
  await release();
});

test('a live run cannot remove another holder or an existing lock file', async t => {
  const bank = await mkdtemp(join(tmpdir(), 'sleight-live-lock-test-'));
  t.after(() => rm(bank, { recursive: true, force: true }));
  const path = join(bank, 'lock');
  const release = await acquireLiveLock(path);
  await rmdir(path);
  await writeFile(path, 'another holder');
  await assert.rejects(release(), /ownership changed/);
  await assert.rejects(acquireLiveLock(path), /Another live run/);
  await unlink(path);
});
