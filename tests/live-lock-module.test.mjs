import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir, rm, stat, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLiveLock } from '../bench/live-lock.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

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

test('a waiting live run takes the lock only after the holder releases it', async t => {
  const bank = await mkdtemp(join(tmpdir(), 'sleight-live-lock-test-'));
  t.after(() => rm(bank, { recursive: true, force: true }));
  const path = join(bank, 'lock');
  const release = await acquireLiveLock(path);
  let acquired = false;
  const next = acquireLiveLock(path, { wait: true, interval: 5 }).then(releaseNext => { acquired = true; return releaseNext; });
  await sleep(20);
  assert.equal(acquired, false);
  await release();
  const releaseNext = await next;
  assert.equal(acquired, true);
  await releaseNext();
});

test('interrupting a lock wait leaves the other holder intact', async t => {
  const bank = await mkdtemp(join(tmpdir(), 'sleight-live-lock-test-'));
  t.after(() => rm(bank, { recursive: true, force: true }));
  const path = join(bank, 'lock');
  const release = await acquireLiveLock(path);
  const controller = new AbortController();
  const next = acquireLiveLock(path, { wait: true, signal: controller.signal });
  const rejection = assert.rejects(next, { name: 'AbortError' });
  controller.abort(); await rejection;
  assert.ok((await stat(path)).isDirectory());
  await release();
});
