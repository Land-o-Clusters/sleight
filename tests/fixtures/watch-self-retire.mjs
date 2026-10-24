// A launchctl stand-in kills its calling watch process, just as self-bootout can.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WatchStore } from '../../plugins/sleight/lib/watches.mjs';

if (process.argv[2] === 'bootout-stub') process.kill(process.ppid, 'SIGKILL');
else {
  const store = new WatchStore({ home: process.argv[2], now: () => Date.parse('2026-11-01T12:00:00.000Z'),
    boot: () => 'boot1', notify: async () => {}, launchctl: () => promisify(execFile)(process.execPath,
      [new URL(import.meta.url).pathname, 'bootout-stub']) });
  await store.run(process.argv[3], { scheduled: true });
  throw Error('self-bootout did not terminate the watch');
}
