import { mkdir, stat, rmdir } from 'node:fs/promises';

// Use the cooperative mkdir/rmdir protocol of the other live scripts. Only
// the holder removes its directory; manual stale cleanup must wait for it to
// exit. The identity check catches prior replacement, not hostile races.
export async function acquireLiveLock(path = '/tmp/sleight-live.lock') {
  try { await mkdir(path); }
  catch (err) {
    if (err.code === 'EEXIST') throw new Error(`Another live run holds ${path}. Wait for it to finish.`);
    throw err;
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
