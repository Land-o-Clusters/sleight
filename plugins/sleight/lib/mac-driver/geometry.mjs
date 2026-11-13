import { randomBytes } from 'node:crypto';

export const GLIDE_GEOMETRY_LIMIT = 262144;
const observations = new WeakMap();
export const privateGlideObservation = token => observations.get(token);
const token = () => randomBytes(16).toString('hex');
const positive = n => Number.isSafeInteger(n) && n > 0;
const interval = a => Array.isArray(a) && a.length === 2 && a.every(n => Number.isFinite(n) && n >= 0) && a[0] <= a[1];

// Only the parent's inherited descriptor can mint a receipt. Ordinary objects,
// including copies of valid receipt fields, carry no observation capability.
export function createGlideGeometryWire({ nonce, stream, publish, clock = () => performance.now() }) {
  const requests = new Map(), reads = new Map(), actions = new Map();
  let turn, buffer = Buffer.alloc(0), alive = true, poisoned = false;
  const endedTurns = new Set();
  const emit = value => {
    const receipt = Object.freeze({}); observations.set(receipt, Object.freeze(value)); publish(receipt);
  };
  const fault = () => {
    buffer = Buffer.alloc(0);
    if (turn && !poisoned) { poisoned = true; emit({ type: 'fault', turn }); }
  };
  const wire = {
    begin(id, action) {
      if (!alive || poisoned) return undefined;
      if (!turn) { turn = token(); emit({ type: 'begin', turn }); }
      for (const [key, entry] of requests) if (requests.size >= 32 && entry.finished) requests.delete(key);
      if (requests.size >= 32 || actions.size >= 512 && action) { fault(); return undefined; }
      requests.set(id, { start: clock(), finished: false, action: !!action,
        queued: [...requests.values()].some(r => r.action && !r.finished) || !!action });
      if (action) actions.set(id, { call: action.call, index: action.index });
      return turn;
    },
    finish(id) { const entry = requests.get(id); if (entry) entry.finished = true; },
    end() {
      if (!turn) return undefined;
      const ended = turn;
      emit({ type: 'end', turn }); turn = undefined;
      requests.clear(); reads.clear(); actions.clear(); poisoned = false;
      endedTurns.add(ended);
      if (endedTurns.size > 512) endedTurns.delete(endedTurns.values().next().value);
      return ended;
    },
    close() { fault(); alive = false; },
    get state() { return { requests: requests.size, reads: reads.size, actions: actions.size, alive, poisoned, turn }; },
  };
  stream?.on('data', chunk => {
    if (!alive || poisoned) return;
    if (chunk.length > GLIDE_GEOMETRY_LIMIT || buffer.length + chunk.length > GLIDE_GEOMETRY_LIMIT) { fault(); return; }
    buffer = Buffer.concat([buffer, chunk]);
    let lf;
    while (alive && !poisoned && (lf = buffer.indexOf(10)) >= 0) {
      let value;
      try { value = JSON.parse(buffer.subarray(0, lf)); } catch { fault(); return; }
      buffer = buffer.subarray(lf + 1);
      if (value?.protocol !== 'sleight.glide-geometry/1' || value.nonce !== nonce ||
          value.type !== 'observation' || !positive(value.request) || !positive(value.read) ||
          !interval(value.acquired) || !Array.isArray(value.references) || value.references.length > 512) { fault(); return; }
      if (endedTurns.has(value.turn)) continue;
      if (value.turn !== turn) { fault(); return; }
      if (!requests.has(value.request)) continue;
      let acquired;
      if (value.reused === true) {
        const original = reads.get(value.read);
        if (!original || JSON.stringify(original.native) !== JSON.stringify(value.acquired)) continue;
        acquired = original.parent;
      } else {
        if (value.reused !== false) { fault(); return; }
        if (reads.has(value.read) || reads.size >= 128) continue;
        // This enclosing parent interval needs no cross-process clock estimate.
        // It includes queueing; a late delivery can never move its start forward.
        acquired = [requests.get(value.request).start, clock()];
        reads.set(value.read, { native: value.acquired, parent: acquired });
      }
      const references = value.references.map(row => ({ ...row, action: actions.get(row.action) }));
      emit({ ...value, acquired, references, queuedInput: requests.get(value.request).queued || [...requests.values()].some(r => r.action && !r.finished) });
    }
  });
  stream?.on('error', wire.close); stream?.on('end', wire.close); stream?.on('close', wire.close);
  return wire;
}
