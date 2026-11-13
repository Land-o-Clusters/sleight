import * as fs from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The caller owns the private directory. Keep partial bytes under a unique name until synced.
// Refuse an existing destination, including links, before publishing.
export function writePrivateFileAtomic(path, bytes) {
  const absent = () => {
    if (fs.lstatSync(path, { throwIfNoEntry: false })) throw Object.assign(Error('File already exists'), { code: 'EEXIST' });
  };
  absent();
  const temp = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    absent();
    fs.renameSync(temp, path);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
