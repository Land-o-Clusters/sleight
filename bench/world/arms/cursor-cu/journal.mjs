// A leftover, including a partial record, blocks admission before any host access.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ordinaryPath } from './contract.mjs';

export class SelectionJournal {
  constructor(paths) { this.root = ordinaryPath(paths.root); this.file = join(this.root, 'owner-selection-journal.json'); }
  assertAbsent() {
    ordinaryPath(this.file);
    if (existsSync(this.file)) throw Error('Cursor selection journal exists; recover the recorded owner selection and accessibility state before another start');
  }
  syncDirectory() { const fd = openSync(this.root, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  load() {
    ordinaryPath(this.file);
    const root = lstatSync(this.root), file = lstatSync(this.file);
    if (!root.isDirectory() || root.uid !== process.getuid() || (root.mode & 0o077) ||
      !file.isFile() || file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600 || file.size > 8192)
      throw Error('Cursor recovery journal ownership or mode refused');
    return JSON.parse(readFileSync(this.file, 'utf8'));
  }
  begin(record) {
    this.assertAbsent();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.root);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Cursor journal state folder must be private and owner-held');
    const fd = openSync(this.file, 'wx', 0o600);
    this.active = true;
    try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    this.syncDirectory();
  }
  update(record) {
    if (!this.active) throw Error('Cursor selection journal is not owned by this run');
    ordinaryPath(this.file);
    const temp = join(this.root, 'owner-selection-journal.next');
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.file); this.syncDirectory();
  }
  clear() {
    if (!this.active) throw Error('Cursor selection journal is not owned by this run');
    unlinkSync(ordinaryPath(this.file)); this.syncDirectory(); this.active = false;
  }
}
