// Windows named-pipe delivery. Security loads only when this sink discovers peers.
import { createConnection } from 'node:net';
const withoutSay = event => { const { say: _say, ...record } = event; return record; };

/** No I/O is awaited by write(). Discovery and connection run beside the action, at most once per 2 seconds. */
export function createWindowsRendererSink({ windows, now = Date.now, connect = path => createConnection(path), defer = setImmediate } = {}) {
  const peers = new Map(); let closed = false, scanning = false, checked = -Infinity, dropped = 0, sessionStart, currentStatus;
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
      windows ??= (await import('../hand/windows-transport.mjs')).createWindowsTransport();
      const valid = new Set();
      const entries = await windows.discover({ connected: [...peers.values()].filter(p => p.ready) });
      for (const entry of entries) {
        if (closed) return;
        const path = entry.path, stat = { ino: entry.token, dev: entry.pid };
        valid.add(path);
        const previous = peers.get(path);
        if (previous && previous.ino === stat.ino && previous.dev === stat.dev) continue;
        if (previous) remove(previous);
        if (closed) return;
        let socket;
        try { socket = connect(path); } catch { windows.invalidate?.(entry); continue; }
        const peer = { path, ino: stat.ino, dev: stat.dev, socket, ready: false, blocked: false, inFlight: 0, queue: [] };
        peers.set(path, peer); socket.unref?.();
        socket.on('error', () => { windows.invalidate?.(entry); remove(peer); });
        socket.on('close', () => { if (peers.get(path) === peer) { windows.invalidate?.(entry); remove(peer); } });
        socket.on('drain', () => { peer.blocked = false; pump(peer); });
        // No command channel. Discard all incoming bytes without interpreting them.
        socket.resume();
        socket.on('connect', async () => {
          try {
            const safe = await windows.validate(entry);
            if (closed || peers.get(path) !== peer || !safe) return remove(peer);
            const replay = [...new Set([sessionStart, currentStatus, ...peer.queue].filter(Boolean).map(item => JSON.stringify(withoutSay(typeof item === 'string' ? JSON.parse(item) : item)) + '\n'))];
            replay.sort((a, b) => (JSON.parse(a).seq ?? 0) - (JSON.parse(b).seq ?? 0));
            if (replay.length > 256) { dropped += replay.length - 256; replay.splice(2, replay.length - 256); }
            peer.queue = replay;
            peer.ready = true; pump(peer);
          } catch { remove(peer); }
        });
      }
      for (const p of peers.values()) if (!valid.has(p.path)) remove(p);
    } catch { /* A failed or incomplete scan says nothing about connected peers. */ } finally { scanning = false; }
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
