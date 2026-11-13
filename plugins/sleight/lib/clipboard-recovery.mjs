import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, readSync, writeSync, writeFileSync, fsyncSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const clipboardSnapshotLimit = 32 * 1024 * 1024;
export const clipboardSnapshotLifetimeMs = 10 * 60 * 1000;
const transient = 'org.nspasteboard.TransientType';
// NSPasteboard.org's universal and legacy confidential/transient identifiers,
// plus the MIME and Qt forms used by password managers such as KeePassXC.
const memoryOnlyTypes = new Set([transient, 'org.nspasteboard.ConcealedType', 'com.agilebits.onepassword',
  'de.petermaurer.TransientPasteboardType', 'com.typeit4me.clipping', 'Pasteboard generator type',
  'application/x-nspasteboard-concealed-type', 'com.trolltech.anymime.application--x-nspasteboard-concealed-type']);
export const memoryOnlyClipboard = items => items.some(reps => reps.some(rep => memoryOnlyTypes.has(rep.type)));
export function readClipboardBootSession(run = execFileSync) {
  const value = run('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 });
  const match = /^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/.exec(value);
  if (!match) throw snapshotError();
  return match[1] + ':' + match[2];
}
export function excludeClipboardSnapshotsFromBackup(directory, run = execFileSync) {
  // Binary plist string "com.apple.backupd", the metadata xattr's value.
  const value = '62706c69737430305f1011636f6d2e6170706c652e6261636b75706408000000000000010100000000000000010000000000000000000000000000001c';
  run('/usr/bin/xattr', ['-wx', 'com.apple.metadata:com_apple_backup_excludeItem', value, directory],
    { timeout: 1000, stdio: 'ignore' });
}
const snapshotName = name => /^snapshot-[0-9a-f-]{36}\.bin$/.test(name);
const snapshotError = () => Error('Clipboard snapshot is unsafe, invalid or exceeds 32 MiB; nothing was staged.');
const empty = items => !items.length || items.every(reps => !reps.length);
export const restoredClipboardItems = original => empty(original) ? [] : original.map(reps => reps.some(rep => rep.type === transient)
  ? reps : [...reps, { type: transient, data: '' }]);
// AppKit can add translated formats. Required bytes still have to match, and
// item order and count stay fixed so an extra item cannot pass as our write.
export const clipboardContains = (actual, expected) => actual.length === expected.length && expected.every((reps, i) =>
  reps.every(rep => actual[i].some(other => other.type === rep.type && Buffer.from(other.data, 'base64').equals(Buffer.from(rep.data, 'base64')))));
export function clipboardSnapshotState(current, { original, staged }) {
  if (empty(current.items)) return 'empty';
  if (clipboardContains(current.items, staged)) return 'staged';
  if (clipboardContains(current.items, original) || clipboardContains(current.items, restoredClipboardItems(original))) return 'restored';
  return 'changed';
}
function validate(record) {
  if (!record || !Array.isArray(record.original) || !Array.isArray(record.staged) || record.staged.length !== 1 ||
      !record.staged[0].some(rep => rep.type === transient && rep.data === '') ||
      !record.staged[0].some(rep => rep.type === 'public.utf8-plain-text')) throw snapshotError();
  let bytes = 0, reps = 0;
  for (const items of [record.original, record.staged]) {
    if (items.length > 4096) throw snapshotError();
    for (const item of items) {
      if (!Array.isArray(item)) throw snapshotError();
      const types = new Set();
      for (const rep of item) {
        if (++reps > 8192 || typeof rep?.type !== 'string' || !rep.type.length || rep.type.length > 1024 || types.has(rep.type) ||
            typeof rep.data !== 'string' || rep.data.length > Math.ceil(clipboardSnapshotLimit / 3) * 4 ||
            Buffer.from(rep.data, 'base64').toString('base64') !== rep.data) throw snapshotError();
        types.add(rep.type); bytes += Buffer.byteLength(rep.data, 'base64');
        if (bytes > clipboardSnapshotLimit) throw snapshotError();
      }
    }
  }
}
// Raw bytes on disk avoid base64's size expansion. The cap includes metadata.
function encode(record) {
  validate(record);
  const chunks = [];
  const metadata = Object.fromEntries(['original', 'staged'].map(key => [key, record[key].map(reps => reps.map(rep => {
    const data = Buffer.from(rep.data, 'base64'); chunks.push(data); return { type: rep.type, size: data.length };
  }))]));
  const header = Buffer.from(JSON.stringify({ version: 2, createdAt: record.createdAt, bootSession: record.bootSession, ...metadata }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
  const size = 4 + header.length + chunks.reduce((n, data) => n + data.length, 0);
  if (size > clipboardSnapshotLimit) throw snapshotError();
  return Buffer.concat([prefix, header, ...chunks], size);
}
function decode(bytes) {
  if (bytes.length < 4) throw snapshotError();
  const size = bytes.readUInt32BE(); if (size > bytes.length - 4) throw snapshotError();
  const header = JSON.parse(bytes.subarray(4, 4 + size).toString('utf8'));
  if (header.version !== 2 || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0 ||
      typeof header.bootSession !== 'string' || !header.bootSession.length || header.bootSession.length > 128) throw snapshotError();
  let offset = 4 + size;
  const record = Object.fromEntries(['original', 'staged'].map(key => [key, header[key].map(reps => reps.map(rep => {
    if (!Number.isSafeInteger(rep.size) || rep.size < 0 || offset + rep.size > bytes.length) throw snapshotError();
    const data = bytes.subarray(offset, offset += rep.size).toString('base64'); return { type: rep.type, data };
  }))]));
  if (offset !== bytes.length) throw snapshotError(); validate(record);
  return { ...record, createdAt: header.createdAt, bootSession: header.bootSession };
}
export function createClipboardSnapshotStore({ directory = join(homedir(), 'Library', 'Application Support', 'sleight', 'clipboard'),
  now = Date.now, bootSession = readClipboardBootSession, excludeFromBackup = excludeClipboardSnapshotsFromBackup } = {}) {
  directory = resolve(directory);
  const uid = process.getuid();
  let boot;
  const currentBoot = () => {
    const value = boot ??= bootSession();
    if (typeof value !== 'string' || !value.length || value.length > 128) throw snapshotError();
    return value;
  };
  const checkDirectory = (create = false) => {
    // Check each component before descending, including an existing symlink.
    const inspect = path => {
      let stat;
      try { stat = lstatSync(path); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return false;
        if (!inspect(dirname(path))) return false;
        mkdirSync(path, { mode: 0o700 }); stat = lstatSync(path);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw snapshotError();
      if (path !== dirname(path) && !inspect(dirname(path))) return false;
      if (path === resolve(directory) && (stat.uid !== uid || (stat.mode & 0o077))) throw snapshotError();
      return true;
    };
    return inspect(resolve(directory));
  };
  const syncDirectory = () => { const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } };
  const safeFile = stat => stat.isFile() && stat.uid === uid && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1 && stat.size <= clipboardSnapshotLimit;
  const protectDirectory = () => {
    excludeFromBackup(directory);
    const marker = join(directory, '.metadata_never_index');
    const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try { if (!safeFile(fstatSync(fd))) throw snapshotError(); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory();
  };
  const remove = token => {
    if (!snapshotName(token?.name)) throw snapshotError();
    checkDirectory();
    const path = join(directory, token.name);
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!safeFile(stat) || stat.dev !== token.dev || stat.ino !== token.ino) throw snapshotError();
      // Best effort at the filesystem level. APFS snapshots and SSD wear leveling
      // can retain older blocks; this is not a secure-erasure guarantee.
      const zeros = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      for (let offset = 0; offset < stat.size;) {
        const count = writeSync(fd, zeros, 0, Math.min(zeros.length, stat.size - offset), offset);
        if (!count) throw snapshotError(); offset += count;
      }
      fsyncSync(fd);
      const latest = lstatSync(path);
      if (!safeFile(latest) || latest.dev !== stat.dev || latest.ino !== stat.ino || latest.size !== stat.size) throw snapshotError();
      unlinkSync(path); syncDirectory();
    } finally { closeSync(fd); }
  };
  return Object.freeze({
    directory,
    hasSnapshots() { return checkDirectory() && readdirSync(directory).some(snapshotName); },
    protect() { if (checkDirectory()) protectDirectory(); },
    save(record) {
      if (memoryOnlyClipboard(record.original)) return;
      const createdAt = now(); if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw snapshotError();
      const bytes = encode({ ...record, createdAt, bootSession: currentBoot() }); checkDirectory(true); protectDirectory();
      const name = 'snapshot-' + randomUUID() + '.bin', path = join(directory, name);
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let token;
      try {
        const stat = fstatSync(fd); if (!safeFile(stat)) throw snapshotError();
        token = { name, dev: stat.dev, ino: stat.ino };
        writeFileSync(fd, bytes); fsyncSync(fd); syncDirectory();
      } catch (error) { try { if (token) remove(token); } catch {} throw error; }
      finally { closeSync(fd); }
      return token;
    },
    list() {
      if (!checkDirectory()) return [];
      return readdirSync(directory).filter(snapshotName).map(name => {
        let fd;
        try {
          fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = fstatSync(fd); if (!safeFile(stat)) throw snapshotError();
          const token = { name, dev: stat.dev, ino: stat.ino };
          // A crash during persistence precedes staging. Discard that invalid
          // record at recovery without reading any clipboard bytes.
          const bytes = Buffer.alloc(stat.size + 1); let count = 0, read;
          while (count < bytes.length && (read = readSync(fd, bytes, count, bytes.length - count, null))) count += read;
          if (count !== stat.size || fstatSync(fd).size !== stat.size) throw snapshotError();
          let record; try { record = decode(bytes.subarray(0, count)); } catch { return { token, path: join(directory, name) }; }
          return { token, record, path: join(directory, name) };
        } catch { return { path: join(directory, name), code: 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE' }; }
        finally { if (fd !== undefined) closeSync(fd); }
      });
    },
    discardReason(record) {
      if (memoryOnlyClipboard(record.original)) return 'CLIPBOARD_SNAPSHOT_DISCARDED_CONCEALED';
      if (record.bootSession !== currentBoot()) return 'CLIPBOARD_SNAPSHOT_DISCARDED_BOOT';
      const age = now() - record.createdAt;
      if (!Number.isFinite(age) || age < 0 || age > clipboardSnapshotLifetimeMs) return 'CLIPBOARD_SNAPSHOT_DISCARDED_EXPIRED';
    },
    remove,
  });
}

// The first live restore uses the short staged deadline. Each subsequent attempt
// collects the prior helper, observes current bytes and writes its generation.
// A failure to read is retried too. It cannot establish a third-party change.
export async function restoreClipboardSnapshot(io, record, { written, initialTimeoutMs, clearStaged = false, now = () => performance.now() } = {}) {
  const start = now(); let current, state;
  const remaining = () => Math.max(0, Math.floor(30000 - (now() - start)));
  const observe = async () => {
    if (!remaining()) return false;
    current = await io({ op: 'read', maxBytes: clipboardSnapshotLimit, timeoutMs: remaining() });
    state = clipboardSnapshotState(current, record); return true;
  };
  for (let attempt = 0; attempt < 5 && remaining(); attempt++) {
    try {
      if (attempt || !written) {
        await io.restart?.({ timeoutMs: remaining() });
        if (!await observe()) break;
        if (state === 'restored' || state === 'changed') return { state };
      } else current = written;
      if (!remaining()) break;
      await io({ op: 'write', expectedCount: current.count, items: restoredClipboardItems(record.original), localOnly: true,
        timeoutMs: Math.max(1, Math.min(remaining(), attempt === 0 && initialTimeoutMs !== undefined ? initialTimeoutMs : 30000)) });
      return { state: 'restored' };
    } catch {
      current = undefined;
    }
  }
  // A lost last acknowledgment can still mean the restore completed. This read
  // shares the 30 s deadline. Keep the disk snapshot if it cannot be confirmed.
  try { if (await observe() && (state === 'restored' || state === 'changed')) return { state }; } catch { state = undefined; }
  // Cleanup shares this deadline. Never start an extra read or clear after it.
  if (clearStaged && state === 'staged' && remaining()) {
    try {
      await io({ op: 'write', expectedCount: current.count, items: [], localOnly: true, timeoutMs: remaining() });
      return { state: 'exhausted', cleared: true };
    } catch {
      try {
        if (await observe()) {
          if (state === 'restored' || state === 'changed') return { state };
          if (state === 'empty') return { state: 'exhausted', cleared: true };
        }
      } catch { state = undefined; }
    }
  }
  return { state: 'exhausted', empty: state === 'empty' };
}
export async function recoverClipboardSnapshots(io, { notice = () => {}, now, acquired = false } = {}) {
  if (!io.snapshotStore) return;
  const store = io.snapshotStore;
  const log = (code, path = store.directory) => { try { notice(code, path); } catch {} };
  let held = acquired;
  try {
    if (!acquired && !store.hasSnapshots()) return;
    if (!held) { try { await io({ op: 'acquire' }); held = true; } catch { log('CLIPBOARD_SNAPSHOT_SKIPPED_BUSY'); return; } }
    try { store.protect?.(); } catch { log('CLIPBOARD_SNAPSHOT_PROTECTION_FAILED'); }
    for (const { token, record, path, code } of store.list()) {
      if (code) { log(code, path); continue; }
      try {
        const discard = record ? store.discardReason(record) : 'CLIPBOARD_SNAPSHOT_DISCARDED_INVALID';
        if (discard) { store.remove(token); log(discard, path); continue; }
        const { state } = await restoreClipboardSnapshot(io, record, { now });
        if (state !== 'exhausted') store.remove(token);
        log(state === 'restored' ? 'CLIPBOARD_SNAPSHOT_RESTORED' : state === 'changed'
          ? 'CLIPBOARD_SNAPSHOT_DISCARDED_CHANGED' : 'CLIPBOARD_SNAPSHOT_RETAINED', path);
      } catch { log('CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE', path); }
    }
  } catch { log('CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE'); }
  finally { if (held && !acquired) try { await io({ op: 'release' }); } catch { log('CLIPBOARD_SNAPSHOT_RELEASE_FAILED'); } }
}
