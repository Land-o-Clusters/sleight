// Existing Unix-socket cursor delivery, with unchanged validation and queue limits.
import { lstat, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { createConnection } from 'node:net';
import { darwinPaths } from './paths.mjs';

const withoutSay = event => { const { say: _say, ...record } = event; return record; };

/** No I/O is awaited by write(). Discovery and connection run beside the action, at most once per 2 seconds. */
export function createUnixRendererSink({ dir = process.env.SLEIGHT_CURSOR_STREAM_DIR ?? darwinPaths().cursorRenderers,
  uid = process.getuid(), now = Date.now, connect = path => createConnection(path), defer = setImmediate, inspect = lstat } = {}) {
  const peers = new Map(); let closed = false, scanning = false, checked = -Infinity, dropped = 0, sessionStart, currentStatus;
  const directoryOK = async () => {
    try { const s = await inspect(dir); return isAbsolute(dir) && normalize(dir) === dir && s.isDirectory() && !s.isSymbolicLink() && s.uid === uid && (s.mode & 0o7777) === 0o700 && await realpath(dir) === dir; } catch { return false; }
  };
  const remove = peer => { if (peers.get(peer.path) === peer) peers.delete(peer.path); dropped += peer.queue.length + peer.inFlight; peer.queue.length = 0; peer.inFlight = 0; peer.socket.destroy(); };
  const pump = peer => {
    if (!peer.ready || peer.blocked || closed || peers.get(peer.path) !== peer) return;
    while (peer.queue.length && peer.inFlight < 256) {
      const line = peer.queue.shift();
      peer.inFlight++;
      try {
        if (!peer.socket.write(line, error => {
          peer.inFlight = Math.max(0, peer.inFlight - 1);
          if (error) remove(peer); else pump(peer);
        })) { peer.blocked = true; return; }
      } catch { remove(peer); return; }
    }
  };
  async function discover() {
    try {
      if (!await directoryOK()) { for (const p of peers.values()) remove(p); return; }
      const valid = new Set();
      for (const name of await readdir(dir)) {
        if (closed) return;
        if (!name.endsWith('.sock')) continue;
        const path = join(dir, name); let stat;
        try { stat = await inspect(path); if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || await realpath(path) !== path) continue; } catch { continue; }
        valid.add(path);
        const previous = peers.get(path);
        if (previous && previous.ino === stat.ino && previous.dev === stat.dev) continue;
        if (previous) remove(previous);
        if (!await directoryOK() || closed) return;
        const socket = connect(path), peer = { path, ino: stat.ino, dev: stat.dev, socket, ready: false, blocked: false, inFlight: 0, queue: [] };
        peers.set(path, peer); socket.unref?.();
        socket.on('error', () => remove(peer)); socket.on('close', () => { if (peers.get(path) === peer) remove(peer); });
        socket.on('drain', () => { peer.blocked = false; pump(peer); });
        // No command channel. Discard all incoming bytes without interpreting them.
        socket.resume();
        socket.on('connect', async () => {
          try {
            const current = await inspect(path);
            if (closed || peers.get(path) !== peer || current.ino !== peer.ino || current.dev !== peer.dev || current.uid !== uid || !current.isSocket() || current.isSymbolicLink() || (current.mode & 0o7777) !== 0o600 || await realpath(path) !== path || !await directoryOK()) return remove(peer);
            const replay = [...new Set([sessionStart, currentStatus, ...peer.queue].filter(Boolean).map(item => JSON.stringify(withoutSay(typeof item === 'string' ? JSON.parse(item) : item)) + '\n'))];
            replay.sort((a, b) => (JSON.parse(a).seq ?? 0) - (JSON.parse(b).seq ?? 0));
            if (replay.length > 256) { dropped += replay.length - 256; replay.splice(2, replay.length - 256); }
            peer.queue = replay;
            peer.ready = true; pump(peer);
          } catch { remove(peer); }
        });
      }
      for (const p of peers.values()) if (!valid.has(p.path)) remove(p);
    } catch { /* No renderer can fail a tool call. */ } finally { scanning = false; }
  }
  function refresh(force = true) {
    if (closed || scanning || !force && now() - checked < 2000) return;
    checked = now(); scanning = true; defer(() => { discover().catch(() => { scanning = false; }); });
  }
  return { refresh,
    write(event) {
      if (closed) return;
      refresh(false);
      if (event?.type === 'session' && event.state === 'start') sessionStart = event;
      if (event?.type === 'status') currentStatus = withoutSay(event);
      if (!peers.size) return;
      let line; try { line = JSON.stringify(event) + '\n'; } catch { return; }
      for (const p of peers.values()) {
        if (p.queue.length + p.inFlight >= 256) { dropped++; continue; }
        p.queue.push(event.say && (!p.ready || p.blocked) ? JSON.stringify(withoutSay(event)) + '\n' : line); pump(p);
      }
    },
    stats: () => ({ connected: [...peers.values()].filter(p => p.ready).length, queued: [...peers.values()].reduce((n, p) => n + p.queue.length + p.inFlight, 0), dropped }),
    close() {
      if (closed) return;
      closed = true;
      for (const p of peers.values()) {
        if (p.ready && !p.blocked && !p.queue.length && typeof p.socket.end === 'function') {
          peers.delete(p.path); p.socket.end();
          const timer = setTimeout(() => p.socket.destroy(), 250); timer.unref?.();
        } else remove(p);
      }
    },
  };
}
