import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { discoverExtensions } from './browser-discovery.mjs';

const owned = stat => (!process.getuid || Number(stat.uid) === process.getuid()) && (Number(stat.mode) & 0o022) === 0;
function ownedDirectory(file) {
  const stat = lstatSync(dirname(file));
  if (!stat.isDirectory() || !owned(stat)) throw new Error('unsafe cache directory');
}
function readCache(file) {
  ownedDirectory(file);
  // Nonblocking open also covers replacement with a FIFO between inspection and open.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !owned(stat) || stat.size > 1024) throw new Error('unsafe cache file');
    const bytes = Buffer.alloc(1025);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 1024) throw new Error('oversized cache');
    return JSON.parse(bytes.toString('utf8', 0, length));
  } finally { closeSync(fd); }
}

// Observe the initialize reply without owning, pausing or consuming the relay's stdout stream.
export function refreshAfterInitialize(output, cache) {
  if (!cache) return () => {};
  let buffer = '';
  const dispose = () => { output.off('data', observe); output.off('close', dispose); };
  const observe = data => {
    buffer += data;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (!message.result?.protocolVersion) continue;
      dispose(); void cache.refresh(); return;
    }
    if (buffer.length > 1048576) dispose();
  };
  output.on('data', observe); output.once('close', dispose);
  return dispose;
}

// Cache only the inventory outcome, never browser profiles, tabs or approvals. Refresh every
// automatic session, but keep its initial description fixed until the next session.
export function createSurfaceCache(server, { file = join(homedir(), 'Library/Caches/sleight/extensions.json'),
  now = Date.now, discover = discoverExtensions } = {}) {
  const engine = createHash('sha256').update(JSON.stringify([server.version, server.command, server.args])).digest('hex');
  let cached;
  try {
    const value = readCache(file);
    const age = now() - value?.checkedAt;
    if (value?.schema === 1 && value.engine === engine && typeof value.connected === 'boolean' &&
      Number.isFinite(value.checkedAt) && age >= 0 && age < (value.connected ? 6 : 24) * 60 * 60 * 1000) cached = value;
  } catch { /* No usable cache: computer-only. */ }
  const controller = new AbortController();
  let pending;
  return {
    connected: cached?.connected === true,
    refresh() {
      if (controller.signal.aborted) return Promise.resolve();
      return pending ??= (async () => {
        const checkedAt = now();
        let browsers;
        try { browsers = await discover(server, { signal: controller.signal, strict: true }); }
        catch { return; } // Failure must neither extend a positive nor manufacture a day-long negative.
        if (controller.signal.aborted || !Array.isArray(browsers)) return;
        const connected = browsers.some(b => b?.type === 'extension' && b.metadata?.extensionInstanceId);
        const temporary = `${file}.${randomUUID()}.tmp`;
        const lock = `${file}.publish.sqlite`;
        let publisher;
        try {
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          ownedDirectory(file);
          // Only publication is serialized. SQLite releases its lock even on process death.
          try { writeFileSync(lock, '', { mode: 0o600, flag: 'wx' }); }
          catch (err) { if (err.code !== 'EEXIST') throw err; }
          const before = lstatSync(lock, { bigint: true });
          if (!before.isFile() || !owned(before)) throw new Error('unsafe cache coordinator');
          publisher = new DatabaseSync(lock);
          publisher.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
          const after = lstatSync(lock, { bigint: true });
          if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('cache coordinator changed');
          let latest; try { latest = readCache(file); } catch { /* First or invalid entry. */ }
          if (latest?.schema === 1 && latest.engine === engine && Number.isFinite(latest.checkedAt) &&
            latest.checkedAt > checkedAt && latest.checkedAt <= now()) return;
          writeFileSync(temporary, JSON.stringify({ schema: 1, engine, checkedAt, connected }), { mode: 0o600, flag: 'wx' });
          renameSync(temporary, file);
        } catch { /* Cache failures must not fail a session. */ }
        finally {
          try { publisher?.close(); } catch { /* Failed publication must not fail a session. */ }
          try { rmSync(temporary, { force: true }); } catch { /* Unwritable cache directory. */ }
        }
      })();
    },
    close() { controller.abort(); return pending; },
  };
}
