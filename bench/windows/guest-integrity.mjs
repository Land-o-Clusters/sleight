// Data checks shared by the Mac exporter and guest preflight. No process starts on import.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import kitProbe from './kit-probe.cjs';

export const MANIFEST_NAME = 'guest-manifest.json';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const requirements = Object.freeze({ platform: 'win32', architecture: 'arm64', node: '25.0.0', minimumBuild: 22000 });
export function safePath(path) {
  if (typeof path !== 'string' || !/^[a-zA-Z0-9_./@+-]+$/.test(path) || path.startsWith('/') ||
      path.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.') ||
        /^(?:\.git|node_modules)$/i.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('Unsafe kit path');
  return path;
}
export function kitFiles(root, { results = false } = {}) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw Error('Kit root must be an ordinary directory');
  const files = [];
  const walk = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix + name;
      safePath(path);
      const full = join(directory, name), stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw Error('Kit symlink refused');
      // Only measurement outputs may be added after the initial preflight.
      if (results && path === 'vm-results' && stat.isDirectory()) continue;
      if (stat.isDirectory()) walk(full, path + '/');
      else if (stat.isFile() && stat.nlink === 1) files.push(path);
      else throw Error('Kit contains a non-regular file');
    }
  };
  walk(root);
  return files;
}
export function checkPortable(path, bytes) {
  // Scan gzip JSON fixtures as well as source bytes. Never echo matched content.
  const data = path.endsWith('.gz') ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }) : bytes;
  const text = data.toString('utf8');
  if (/\/Users\/[\w .~-]+\//.test(text) || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text) ||
      /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{30,})/.test(text)) {
    throw Error('Nonportable home path or credential pattern in kit file: ' + path);
  }
  if (/(^|\/)(?:\.env(?:\..*)?|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519)$/i.test(path)) throw Error('Credential filename refused');
}
export function createManifest(root, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Expected a full commit SHA');
  const files = kitFiles(root).map(path => {
    const bytes = readFileSync(join(root, path)); checkPortable(path, bytes);
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  if (files.some(f => f.path === MANIFEST_NAME)) throw Error('Manifest already exists');
  return { schema: 'sleight.windows-guest-kit/1', commit, requirements, files };
}
export function verifyKit(root, { expectedCommit, expectedManifestSha256 } = {}) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '') || !/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? '')) throw Error('Pin the full commit and manifest SHA-256 from the Mac export receipt');
  const paths = kitFiles(root, { results: true });
  const bytes = readFileSync(join(root, MANIFEST_NAME));
  if (sha256(bytes) !== expectedManifestSha256) throw Error('Kit manifest hash mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== 'sleight.windows-guest-kit/1' || manifest.commit !== expectedCommit ||
      JSON.stringify(manifest.requirements) !== JSON.stringify(requirements) || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Kit manifest contract mismatch');
  const expected = new Set([MANIFEST_NAME]), folded = new Set([MANIFEST_NAME]), hashes = [];
  for (const file of manifest.files) {
    safePath(file.path);
    const key = file.path.toLowerCase();
    if (folded.has(key) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw Error('Invalid or duplicate kit file');
    expected.add(file.path); folded.add(key);
    const full = join(root, file.path);
    if (!realpathSync(full).startsWith(realpathSync(root) + (process.platform === 'win32' ? '\\' : '/'))) throw Error('Kit file escaped its root');
    let actual;
    try { actual = kitProbe.hashFile(full, file.bytes); }
    catch (error) {
      if (error.message === 'KIT_FILE_CHANGED') throw Error('Kit file hash mismatch: ' + file.path);
      throw error;
    }
    if (actual !== file.sha256) throw Error('Kit file hash mismatch: ' + file.path);
    hashes.push({ path: file.path, bytes: file.bytes, sha256: actual });
  }
  if (paths.length !== expected.size || paths.some(p => !expected.has(p))) throw Error('Unexpected kit files');
  return { commit: manifest.commit, manifestSha256: expectedManifestSha256, files: hashes, requirements: manifest.requirements };
}
