// Public narration needs a fresh secure-input answer from the nonce-bound native host. No host,
// timeout or malformed answer means no say. Keep stream order without delaying a tool or its result.
export function createNarrationSink({ write, check, waitMs = 100, limit = 256 }) {
  const queue = [];
  let pending, closed = false;
  const bare = event => { const { say: _say, ...record } = event; return record; };
  const deliver = event => { try { write(event); } catch {} };
  function pump() {
    if (pending || closed) return;
    while (queue.length) {
      const event = queue[0];
      if (!event.say) { queue.shift(); deliver(event); continue; }
      const slot = {}; pending = slot;
      const finish = allowed => {
        if (pending !== slot) return;
        pending = undefined; clearTimeout(slot.timer); slot.cancel?.();
        queue.shift(); deliver(allowed === true ? event : bare(event)); pump();
      };
      slot.timer = setTimeout(() => finish(false), waitMs); slot.timer.unref?.();
      try { const cancel = check(finish); slot.cancel = typeof cancel === 'function' ? cancel : undefined; } catch { finish(false); }
      if (pending !== slot) slot.cancel?.();
      return;
    }
  }
  function flush() {
    const slot = pending; pending = undefined;
    if (slot) { clearTimeout(slot.timer); slot.cancel?.(); }
    for (const event of queue.splice(0)) deliver(bare(event));
  }
  return {
    write(event) {
      if (closed) return;
      if (queue.length >= limit) flush();
      queue.push(event); pump();
    },
    close() { if (closed) return; closed = true; flush(); },
  };
}
