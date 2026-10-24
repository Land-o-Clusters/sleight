import { writeFileSync } from 'node:fs';
import { createClipboardPasteSession } from '../../plugins/sleight/lib/clipboard.mjs';
import { createClipboardSnapshotStore } from '../../plugins/sleight/lib/clipboard-recovery.mjs';
const [directory, boardPath] = process.argv.slice(2);
let board = { count: 7, items: [[{ type: 'public.rtf', data: 'AAEC' }, { type: 'public.png', data: 'AwQF' }]] };
if (process.argv[4]) board.items[0].push({ type: process.argv[4], data: '' });
const io = async request => {
  if (['acquire', 'release'].includes(request.op)) return;
  if (request.op === 'read') return structuredClone(board);
  board = { count: board.count + 1, items: request.items };
  writeFileSync(boardPath, JSON.stringify(board), { mode: 0o600 });
  process.kill(process.pid, 'SIGKILL');
};
io.snapshotStore = createClipboardSnapshotStore({ directory, bootSession: () => 'fixture-boot', excludeFromBackup: () => {} });
await createClipboardPasteSession(io).paste('private', () => {});
