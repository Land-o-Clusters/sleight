// Session-only counts. No labels, titles, key strings or clipboard data enter a chip.
export function createEdgeChips({ send, now = Date.now, limit = 32 } = {}) {
  let run, ended = false, recording = false, paused = false;
  const publish = chip => send({ op: 'put', pid: chip.pid, windowId: chip.windowId, count: chip.count, first: chip.recordedFirst ?? chip.first, time: chip.time, run: recording && chip.recordedFirst && run ? run : null });
  const windows = new Map(), firstEvents = new Map();
  return {
    recording(enabled) {
      if (recording === enabled) return; recording = enabled;
      for (const chip of windows.values()) publish(chip);
    },
    receive(event, enabled = false) {
      this.recording(enabled);
      if (event.type === 'session' && event.state === 'start') {
        windows.clear(); firstEvents.clear(); ended = false;
        run = /^[a-f0-9]{32}$/.test(event.session) && Number.isFinite(event.ts) ? new Date(event.ts).toISOString().slice(0, 10) + '-' + event.session : undefined;
        send({ op: 'clear' }); return;
      }
      if (event.type === 'session' && event.state === 'end') { windows.clear(); firstEvents.clear(); send({ op: 'clear' }); return; }
      if (event.type === 'status' && event.state === 'paused') { paused = true; return; }
      if (event.type === 'status' && event.state === 'idle' && paused) { paused = false; return; }
      if (event.type === 'status' && event.state === 'idle' && !event.call) { ended = true; send({ op: 'end' }); return; }
      if (event.type !== 'action' || ['move', 'scroll'].includes(event.kind)) return;
      const { id, pid } = event.window ?? {};
      if (!Number.isSafeInteger(id) || id < 1 || id > 4294967295 || !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647 || !Number.isSafeInteger(event.seq) || event.seq < 1) return;
      if (ended) { windows.clear(); firstEvents.clear(); send({ op: 'clear' }); ended = false; }
      const action = `${event.call}:${event.index}`, key = `${pid}:${id}`, pending = `${key}:${action}`;
      if (['failed', 'declined', 'skipped'].includes(event.phase)) { firstEvents.delete(pending); return; }
      if (!firstEvents.has(pending)) firstEvents.set(pending, { seq: event.seq, recording });
      if (firstEvents.size > 1024) firstEvents.delete(firstEvents.keys().next().value);
      if (event.phase !== 'done') return;
      if (!windows.has(key) && windows.size >= limit) return;
      const chip = windows.get(key) ?? { pid, windowId: id, count: 0, first: firstEvents.get(pending)?.seq ?? event.seq, time: now(), seen: new Set() };
      if (chip.seen.has(action) || chip.count >= 999) return;
      if (recording && !chip.recordedFirst) chip.recordedFirst = firstEvents.get(pending)?.recording ? firstEvents.get(pending).seq : event.seq;
      firstEvents.delete(pending); chip.seen.add(action); chip.count++; windows.set(key, chip);
      publish(chip);
    },
    consume(runId, first) {
      for (const [key, chip] of windows) if (runId === run && chip.recordedFirst === first) { windows.delete(key); return true; }
      return false;
    },
    permits(runId, first) { return [...windows.values()].some(c => runId === run && c.recordedFirst === first); },
  };
}
