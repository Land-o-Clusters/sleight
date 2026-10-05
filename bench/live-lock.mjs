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
    const current = await stat(path);
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino) {
      throw new Error('Live lock ownership changed; refusing to remove it.');
    }
    await rmdir(path);
  };
}
