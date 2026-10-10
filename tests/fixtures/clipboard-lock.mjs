import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createClipboardCoordinator } from '../../plugins/sleight/lib/clipboard.mjs';
const lock = createClipboardCoordinator(DatabaseSync, process.argv[2]);
lock.acquire();
setImmediate(() => { globalThis.gc(); console.log('ready'); });
process.stdin.resume();
// Retain the coordinator until exit; otherwise GC can close its SQLite handle.
process.stdin.on('end', () => {
  assert.throws(() => lock.acquire(), /Clipboard busy/);
  process.exit(7); // Deliberately exit without release.
});
