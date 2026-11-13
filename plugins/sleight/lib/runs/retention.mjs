import { watch } from 'node:fs';
import { dirname, basename } from 'node:path';
import { handConfigPath } from '../hand/settings.mjs';
import { pruneRuns, runRoot } from './store.mjs';

// The relay sweeps on start and on hand.json changes, including recording being switched off while idle.
export function startRunRetention({ root = runRoot(), config = handConfigPath(), now = Date.now,
  onSkip = () => {}, onError = () => {} } = {}) {
  let tail = Promise.resolve(), watcher, closed = false;
  const sweep = () => tail = tail.then(() => pruneRuns({ root, now: now(), onSkip })).catch(onError);
  const ready = sweep();
  try {
    watcher = watch(dirname(config), { persistent: false }, (_, name) => {
      if (!closed && (!name || String(name) === basename(config))) sweep();
    });
    watcher.on('error', onError);
  } catch (error) { if (error.code !== 'ENOENT') onError(error); }
  return { ready, flush: () => tail, close() { closed = true; watcher?.close(); return tail; } };
}
