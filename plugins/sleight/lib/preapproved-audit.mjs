// Only grants belong here. Ordinary relay traffic requires explicit tracing.
import { closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const LIMIT = 64 * 1024;
export function createGrantAudit(directory) {
  const user = userInfo();
  const file = join(directory ?? join(user.homedir, 'Library/Logs/sleight'), `preapproved-${process.pid}.jsonl`);
  return ({ app, riskLevel, tool, source }) => {
    const line = Buffer.from(JSON.stringify({ t: new Date().toISOString(), pid: process.pid, direction: 'preapproved-app',
      grant: { app, riskLevel, tool, source } }) + '\n');
    if (line.length > LIMIT) throw new Error('preapproval audit record too large');
    mkdirSync(directory ?? join(user.homedir, 'Library/Logs/sleight'), { recursive: true, mode: 0o700 });
    let fd;
    const open = () => {
      fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== user.uid || (stat.mode & 0o077)) throw new Error('preapproval audit must be a private user file');
      return stat;
    };
    try {
      if (open().size + line.length > LIMIT) {
        closeSync(fd); fd = undefined;
        renameSync(file, file + '.1');
        open();
      }
      if (writeSync(fd, line) !== line.length) throw new Error('incomplete preapproval audit write');
    } finally { if (fd !== undefined) closeSync(fd); }
  };
}
