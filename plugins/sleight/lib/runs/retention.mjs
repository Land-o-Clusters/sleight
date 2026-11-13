import { watch, watchFile, unwatchFile } from 'node:fs';
import { dirname, basename } from 'node:path';
import { handConfigPath } from '../hand/settings.mjs';
import { pruneRuns, runRoot } from './store.mjs';

// The relay sweeps on start and on hand.json changes, including recording being switched off while idle.
export function startRunRetention({ root = runRoot(), config = handConfigPath(), now = Date.now,
  onSkip = () => {}, onError = () => {} } = {}) {
  let tail = Promise.resolve(), watcher, closed = false;
  const sweep = () => tail = tail.then(() => pruneRuns({ root, now: now(), onSkip })).catch(onError);
  const changed = () => { if (!closed) sweep(); };
  const ready = sweep();
  // Directory notifications can be lost. Poll settings metadata too, so an idle
  // recording opt-out still prunes without another tool call or relay restart.
  watchFile(config, { persistent: false, interval: 1000 }, changed);
  try {
    watcher = watch(dirname(config), { persistent: false }, (_, name) => {
      if (!name || String(name) === basename(config)) changed();
    });
    watcher.on('error', onError);
  } catch (error) { if (error.code !== 'ENOENT') onError(error); }
  return { ready, flush: () => tail, close() { closed = true; watcher?.close(); unwatchFile(config, changed); return tail; } };
}
