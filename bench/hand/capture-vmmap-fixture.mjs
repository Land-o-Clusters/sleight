// Capture only this process. No apps, windows, input, live locks or installed data.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';

const summary = execFileSync('/usr/bin/vmmap', ['--summary', String(process.pid)], {
  encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 << 20,
});
writeFileSync(new URL('../../tests/fixtures/vmmap-summary-macos.txt', import.meta.url),
  summary.replaceAll(homedir(), '~').replaceAll(userInfo().username, 'user').replaceAll('/Users/USER', '~')
    .split('\n').map(line => line.trimEnd()).join('\n').trimEnd() + '\n',
  { flag: 'wx' });
