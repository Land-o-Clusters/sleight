import { lstatSync, promises as fs } from 'node:fs';

// ctime is part of the key because a permission edit need not change mtime or size.
// Windows must confirm NTFS security-descriptor invalidation before enabling its validator.
export const fileIdentity = stat => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const denied = reason => Object.freeze({ ok: false, reason });
const verdict = result => result?.ok === true ? Object.freeze({ ok: true, reason: undefined }) : denied(result?.reason ?? 'unproved permissions');

/** Inspect a path, with optional already-read stat evidence on POSIX. Native validators must open their own handles.
 * Async results are published only if identity still matches after inspection. Each cache holds at most 256 results. */
export function createFilePermissions({ inspect, inspectAsync = async (...args) => inspect(...args),
  stat = lstatSync, statAsync = path => fs.lstat(path) } = {}) {
  const cache = new Map();
  const keyFor = (path, opts, before) => JSON.stringify([path, opts.kind, opts.uid, fileIdentity(before)]);
  const remember = (key, result) => {
    // A synchronous Windows cache miss must not suppress the later native async check.
    if (!result.ok) return result;
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(key, result); return result;
  };
  function privateFile(path, { kind = 'file', uid = process.getuid?.(), ...options } = {}) {
    try {
      const opts = { ...options, kind, uid }, before = options.stat ?? stat(path), key = keyFor(path, opts, before);
      return cache.get(key) ?? remember(key, verdict(inspect(path, { ...opts, stat: before })));
    } catch (error) { return denied(error?.code ?? 'permission check failed'); }
  }
  async function privateFileAsync(path, { kind = 'file', uid = process.getuid?.(), ...options } = {}) {
    try {
      const opts = { ...options, kind, uid }, before = await statAsync(path), key = keyFor(path, opts, before);
      if (cache.has(key)) return cache.get(key);
      const result = verdict(await inspectAsync(path, { ...opts, stat: before }));
      if (fileIdentity(await statAsync(path)) !== fileIdentity(before)) return denied('file changed');
      return remember(key, result);
    } catch (error) { return denied(error?.code ?? 'permission check failed'); }
  }
  return Object.freeze({ privateFile, privateFileAsync,
    privateDirectory: (path, opts) => privateFile(path, { ...opts, kind: 'directory' }),
    privateDirectoryAsync: (path, opts) => privateFileAsync(path, { ...opts, kind: 'directory' }) });
}

export const darwinFilePermissions = createFilePermissions({ inspect: (_path, { kind, uid, stat }) => {
  if (stat.isSymbolicLink()) return denied('symlink');
  if (!(kind === 'file' ? stat.isFile() : kind === 'directory' && stat.isDirectory())) return denied('wrong type');
  if (stat.uid !== uid) return denied('another owner');
  if ((stat.mode & 0o777) !== (kind === 'file' ? 0o600 : 0o700)) return denied('wrong mode');
  return { ok: true };
} });
