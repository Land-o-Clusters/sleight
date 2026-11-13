import { mkdir, stat, rmdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

// Use the cooperative mkdir/rmdir protocol of the other live scripts. Only
// the holder removes its directory; manual stale cleanup must wait for it to
// exit. The identity check catches prior replacement, not hostile races.
export async function acquireLiveLock(path = '/tmp/sleight-live.lock', { wait = false, signal, interval = 15000 } = {}) {
  for (;;) {
    signal?.throwIfAborted();
    try { await mkdir(path); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!wait) throw new Error(`Another live run holds ${path}. Wait for it to finish.`);
      await sleep(interval, undefined, { signal });
    }
  }
  const owned = await stat(path);
  return async () => {
    // On 2026-10-17 something else removed the lock during a claim run, and the release crashed on a bare ENOENT.
    const current = await stat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      throw Object.assign(new Error(`${path} was removed by another process during this run, so other live runs weren't kept out.`),
        { code: 'LIVE_LOCK_REMOVED' });
    });
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino) {
      throw new Error('Live lock ownership changed; refusing to remove it.');
    }
    await rmdir(path);
  };
}
