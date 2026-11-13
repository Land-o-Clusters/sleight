// .sleightchar v1 is a flat, uncompressed POSIX ustar archive. No external extractor runs.
import * as fs from 'node:fs';
import { CHARACTER_LIMITS } from './character.mjs';

export const ARCHIVE_LIMITS = Object.freeze({ entries: 8, name: 80, total: CHARACTER_LIMITS.total,
  bytes: CHARACTER_LIMITS.total + 8 * 1024 + 1024, ratio: 1 });
const refuse = reason => { throw Error(`Character archive: ${reason}`); };
const zero = bytes => bytes.every(b => b === 0);
function fileCap(name) {
  if (name === 'character.json') return CHARACTER_LIMITS.json - 1;
  if (name === 'LICENSE.txt') return CHARACTER_LIMITS.license;
  if (name === 'preview.png') return CHARACTER_LIMITS.preview;
  if (/^(sheet|extra|perch)\.(png|webp)$/.test(name)) return CHARACTER_LIMITS.sheet;
  refuse('entry name is not a v1 pack file');
}
function entriesCheck(files) {
  if (!(files instanceof Map) || files.size < 2 || files.size > ARCHIVE_LIMITS.entries || !files.has('character.json')) refuse('invalid entry count or missing manifest');
  let total = 0;
  for (const [name, bytes] of files) {
    if (typeof name !== 'string' || name.length > ARCHIVE_LIMITS.name || !Buffer.isBuffer(bytes) || bytes.length > fileCap(name)) refuse('entry size or name cap exceeded');
    total += bytes.length;
  }
  if (total > ARCHIVE_LIMITS.total) refuse('total size cap exceeded');
}
function octal(header, start, length) {
  const value = header.toString('ascii', start, start + length);
  if (!/^[0-7]+[\0 ]*$/.test(value)) refuse('invalid octal header number');
  const n = parseInt(value, 8); if (!Number.isSafeInteger(n)) refuse('header number overflow'); return n;
}
const checksum = header => header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
const putOctal = (header, start, size, value) => header.write(value.toString(8).padStart(size - 1, '0') + '\0', start, size, 'ascii');
export function encodeCharacterArchive(files) {
  entriesCheck(files);
  const chunks = [];
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const header = Buffer.alloc(512); header.write(name, 0, 100, 'ascii');
    putOctal(header, 100, 8, 0o600); putOctal(header, 108, 8, 0); putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, bytes.length); putOctal(header, 136, 12, 0);
    header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(checksum(header).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
export function decodeCharacterArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2048 || bytes.length > ARCHIVE_LIMITS.bytes || bytes.length % 512) refuse('invalid archive size');
  const files = new Map(); let at = 0, total = 0;
  while (at + 512 <= bytes.length && !zero(bytes.subarray(at, at + 512))) {
    const header = bytes.subarray(at, at + 512); at += 512;
    if (octal(header, 148, 8) !== checksum(header)) refuse('header checksum mismatch');
    const end = header.indexOf(0, 0);
    if (end < 1 || end > ARCHIVE_LIMITS.name || !zero(header.subarray(end, 100))) refuse('invalid entry name');
    const name = header.toString('utf8', 0, end), cap = fileCap(name);
    if (files.has(name)) refuse('duplicate archive entry');
    if (files.size === ARCHIVE_LIMITS.entries) refuse('entry count cap exceeded');
    if (header.toString('ascii', 257, 263) !== 'ustar\0' || header.toString('ascii', 263, 265) !== '00' ||
        ![0, 48].includes(header[156]) || !zero(header.subarray(157, 257)) || !zero(header.subarray(345))) refuse('links, paths and extended archive entries are refused');
    // Ownership and timestamps do not grant permissions, but still must use the bounded numeric form.
    const mode = octal(header, 100, 8); octal(header, 108, 8); octal(header, 116, 8); octal(header, 136, 12);
    if (mode & 0o7111) refuse('executable archive entries are refused');
    const size = octal(header, 124, 12); total += size;
    if (size > cap || total > ARCHIVE_LIMITS.total) refuse('archive size cap exceeded');
    const padded = Math.ceil(size / 512) * 512;
    if (at + padded + 1024 > bytes.length) refuse('truncated archive entry');
    if (!zero(bytes.subarray(at + size, at + padded))) refuse('nonzero archive padding');
    files.set(name, Buffer.from(bytes.subarray(at, at + size))); at += padded;
  }
  if (bytes.length - at < 1024 || !zero(bytes.subarray(at))) refuse('missing archive terminator or trailing data');
  entriesCheck(files); return files;
}

// Bounded read through one descriptor, with no symlink, hardlink, FIFO or growth during the read.
export function readCharacterArchive(file, { uid = process.getuid() } = {}) {
  const before = fs.lstatSync(file);
  const check = st => {
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== uid || st.mode & 0o7022 || st.size > ARCHIVE_LIMITS.bytes) refuse('unsafe archive file or size');
  };
  check(before); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd); check(opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino) refuse('archive changed while opening');
    const bytes = Buffer.alloc(opened.size + 1); let n = 0, count;
    do { count = fs.readSync(fd, bytes, n, bytes.length - n, n); n += count; } while (count && n < bytes.length);
    const after = fs.fstatSync(fd);
    if (n !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) refuse('archive changed while reading');
    return decodeCharacterArchive(bytes.subarray(0, n));
  } finally { fs.closeSync(fd); }
}
