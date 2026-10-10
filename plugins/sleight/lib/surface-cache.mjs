import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { discoverExtensions } from './browser-discovery.mjs';

const owned = stat => (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
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

// Cache only the inventory outcome, never browser profiles, tabs or approvals. A short TTL bounds
// disconnect staleness; missing/expired entries keep this session's description computer-only.
export function createSurfaceCache(server, { file = join(homedir(), 'Library/Caches/sleight/extensions.json'),
  now = Date.now, discover = discoverExtensions } = {}) {
  const engine = createHash('sha256').update(JSON.stringify([server.version, server.command, server.args])).digest('hex');
  let cached;
  try {
    const value = readCache(file);
    const age = now() - value?.checkedAt;
    if (value?.schema === 1 && value.engine === engine && typeof value.connected === 'boolean' &&
      Number.isFinite(value.checkedAt) && age >= 0 && age < 60000) cached = value;
  } catch { /* No usable cache: computer-only. */ }
  const controller = new AbortController();
  let pending;
  return {
    connected: cached?.connected === true,
    refresh() {
      if (cached || controller.signal.aborted) return Promise.resolve();
      return pending ??= (async () => {
        const checkedAt = now();
        let browsers = [];
        try { browsers = await discover(server, { signal: controller.signal }); } catch { /* Negative result. */ }
        if (controller.signal.aborted) return;
        const connected = Array.isArray(browsers) && browsers.some(b => b?.type === 'extension' && b.metadata?.extensionInstanceId);
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          ownedDirectory(file);
          writeFileSync(temporary, JSON.stringify({ schema: 1, engine, checkedAt, connected }), { mode: 0o600, flag: 'wx' });
          renameSync(temporary, file);
        } catch { /* Cache failures must not fail a session. */ }
        finally { try { rmSync(temporary, { force: true }); } catch { /* Unwritable cache directory. */ } }
      })();
    },
    close() { controller.abort(); return pending; },
  };
}
