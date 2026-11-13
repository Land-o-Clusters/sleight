// Bootstrap-safe guest inventory and verification. Only Node built-ins are used
// so the same source can run before the new kit has been installed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const CHUNK_BYTES = 64 * 1024, MANIFEST_LIMIT = 4 * 1024 * 1024;
function hashFile(file, expectedBytes) {
  const initial = fs.lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw Error('KIT_FILE_UNSAFE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size !== expectedBytes) throw Error('KIT_FILE_CHANGED');
    const hash = crypto.createHash('sha256'), chunk = Buffer.alloc(CHUNK_BYTES);
    let size = 0, n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      size += n;
      if (size > expectedBytes) throw Error('KIT_FILE_CHANGED');
      hash.update(chunk.subarray(0, n));
    }
    const after = fs.fstatSync(fd);
    if (size !== expectedBytes || after.size !== size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw Error('KIT_FILE_CHANGED');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function probe(root, commit, manifestHash) {
  const ordinary = directory => {
    const s = fs.lstatSync(directory);
    if (!s.isDirectory() || s.isSymbolicLink()) throw Error('KIT_DIRECTORY_UNSAFE');
  };
  ordinary(root);
  const file = path.join(root, 'guest-manifest.json'), stat = fs.lstatSync(file);
  if (stat.size > MANIFEST_LIMIT) throw Error('KIT_MANIFEST_TOO_LARGE');
  const actualHash = hashFile(file, stat.size);
  if (manifestHash && actualHash !== manifestHash) throw Error('MANIFEST_CHANGED');
  // The manifest has a fixed cap. Kit payloads are never read into strings.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let manifest;
  try {
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0, n;
    while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
    if (size !== stat.size || crypto.createHash('sha256').update(buffer.subarray(0, size)).digest('hex') !== actualHash) throw Error('MANIFEST_CHANGED');
    manifest = JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { fs.closeSync(fd); }
  if (manifest.schema !== 'sleight.windows-guest-kit/1' || !/^[a-f0-9]{40}$/.test(manifest.commit) ||
      commit && manifest.commit !== commit || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('KIT_COMMIT_CHANGED');
  // Inventory and deployment both verify every payload against the manifest.
  {
    const expected = new Set(['guest-manifest.json']);
    for (const entry of manifest.files) {
      if (typeof entry.path !== 'string' || !/^[a-zA-Z0-9_./@+-]+$/.test(entry.path) || entry.path.startsWith('/') ||
          entry.path.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) ||
          expected.has(entry.path.toLowerCase()) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('KIT_PATH_UNSAFE');
      expected.add(entry.path.toLowerCase());
      let parent = root;
      for (const part of entry.path.split('/').slice(0, -1)) { parent = path.join(parent, part); ordinary(parent); }
      if (hashFile(path.join(root, entry.path), entry.bytes) !== entry.sha256) throw Error('KIT_FILE_CHANGED');
    }
    let count = 0;
    function walk(directory, prefix = '') {
      ordinary(directory);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) walk(path.join(directory, entry.name), relative + '/');
        else if (entry.isFile() && expected.has(relative.toLowerCase())) count++;
        else throw Error('KIT_EXTRA_FILES');
      }
    }
    walk(root);
    if (count !== expected.size) throw Error('KIT_EXTRA_FILES');
  }
  return { commit: manifest.commit, files: manifest.files.length, manifestSha256: actualHash, hashChunkBytes: CHUNK_BYTES,
    manifestLimitBytes: MANIFEST_LIMIT, peakRSSBytes: process.resourceUsage().maxRSS * 1024 };
}
module.exports = { probe, hashFile, CHUNK_BYTES, MANIFEST_LIMIT };
