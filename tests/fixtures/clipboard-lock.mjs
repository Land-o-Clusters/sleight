import { DatabaseSync } from 'node:sqlite';
import { createClipboardCoordinator } from '../../plugins/sleight/lib/clipboard.mjs';
const lock = createClipboardCoordinator(DatabaseSync, process.argv[2]);
lock.acquire();
console.log('ready');
process.stdin.resume();
process.stdin.on('end', () => process.exit(7)); // Deliberately exit without release.
