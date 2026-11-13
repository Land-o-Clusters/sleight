import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createGlideGeometryWire } from './geometry.mjs';
import { DRIVER_ACTION_METHODS } from './protocol.mjs';

export const RUNTIME_ACTION_PROTOCOL = 'sleight.runtime-action/1';
const actions = new Set([...DRIVER_ACTION_METHODS, 'stuckMenuEscape']);
const kinds = new Set(['click', 'double', 'right', 'key', 'type', 'drag', 'scroll', 'select']);
const phases = new Set(['act', 'done', 'failed']);
const deliveries = new Set(['not-sent', 'sent-unverified', 'sent-verified', 'unknown']);
const bases = new Set(['digest', 'notification', 'notification-none', 'captures']);
const opaque = () => randomBytes(16).toString('hex');
const tuple = (value, size) => Array.isArray(value) && value.length === size &&
  value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000)
  ? value.map(n => Math.round(n * 100) / 100) : undefined;
const positive = n => Number.isSafeInteger(n) && n > 0;
const kindOf = (method, args) => method === 'click' ? args?.[1]?.mouseButton === 'right' ? 'right' : args?.[1]?.clickCount > 1 ? 'double' : 'click'
  : ({ doubleClick: 'double', rightClick: 'right', drag: 'drag', scroll: 'scroll', selectText: 'select', performSecondaryAction: 'click' })[method] ?? 'key';

// A projection of known geometry only. No labels, roles, app names, values or error messages.
export function runtimeActionGeometry(input = {}) {
  const out = {};
  for (const [key, size] of [['point', 2], ['rect', 4]]) {
    const value = tuple(input[key], size); if (value) out[key] = value;
  }
  if (Array.isArray(input.path) && input.path.length > 0 && input.path.length <= 64) {
    const path = input.path.map(p => tuple(p, 2)); if (path.every(Boolean)) out.path = path;
  }
  if (input.window && positive(input.window.id) && positive(input.window.pid)) {
    out.window = { id: input.window.id, pid: input.window.pid };
    const rect = tuple(input.window.rect, 4); if (rect) out.window.rect = rect;
  }
  return out;
}
function outcome(result, error) {
  const value = error ?? result ?? {};
  return { delivery: deliveries.has(value.delivery) ? value.delivery : 'unknown',
    settled: value.settled === true, basis: bases.has(value.basis ?? value.quietBasis) ? value.basis ?? value.quietBasis : 'none',
    ...value.code === 'USER_STOPPED' || value.userStopped === true ? { userStopped: true } : {},
    ...value.clipboardChanged === true ? { clipboardChanged: true } : {} };
}

/** Private parent-owned feed. Each consumer has a bounded queue and at most one write in flight. */
export function createRuntimeActionEvents({ defer = setImmediate, limit = 256 } = {}) {
  const context = new AsyncLocalStorage(), cells = new Map(), consumers = new Set(), wires = new Set();
  const geometryConsumers = new Set();
  let closed = false, dropped = 0;
  const detach = (peer, droppedWrite = true) => {
    if (!consumers.delete(peer)) return;
    if (droppedWrite) dropped++;
    peer.queue.length = 0;
    const active = [...peer.active.values()]; peer.active.clear();
    // Cleanup bypasses the abandoned queue. It is best effort, never awaited,
    // and local to this consumer: other consumers still get the real result.
    for (const record of active) {
      try {
        const reply = peer.write(structuredClone({ ...record, phase: 'skipped',
          outcome: { delivery: 'unknown', settled: false, basis: 'none', eventRecord: 'consumer-detached' } }));
        Promise.resolve(reply).catch(() => {});
      } catch {}
    }
  };
  const publish = record => {
    if (closed) return;
    for (const peer of consumers) {
      if (peer.busy || peer.queue.length >= limit) { detach(peer); continue; }
      peer.queue.push(record);
      pump(peer);
    }
  };
  function pump(peer) {
    if (!consumers.has(peer) || !peer.queue.length || peer.scheduled) return;
    // One record per turn prevents a burst from monopolizing the action loop.
    peer.scheduled = true;
    defer(() => {
      peer.scheduled = false;
      if (!consumers.has(peer) || closed) return;
      const record = peer.queue.shift();
      const key = record.type === 'action' ? `${record.call}:${record.index}` : undefined;
      const terminal = key && record.phase !== 'act' ? peer.active.get(key) : undefined;
      const failedWrite = () => {
        if (terminal && consumers.has(peer)) peer.active.set(key, terminal);
        detach(peer);
      };
      try {
        if (key) {
          if (record.phase === 'act') peer.active.set(key, record);
          else peer.active.delete(key);
        }
        const reply = peer.write(structuredClone(record));
        if (reply === false) return failedWrite();
        if (reply && typeof reply.then === 'function') {
          peer.busy = true;
          Promise.resolve(reply).then(() => { peer.busy = false; pump(peer); }, failedWrite);
        } else pump(peer);
      } catch { failedWrite(); }
    });
  }
  function token(method, args, cell) {
    let call = cells.get(cell);
    if (cell === undefined || !call) {
      call = { call: opaque(), index: 0 };
      if (cell !== undefined) {
        if (cells.size >= 64) cells.delete(cells.keys().next().value);
        cells.set(cell, call);
      }
    }
    return { call: call.call, index: call.index++, kind: kindOf(method, args), geometry: {}, acted: false, ended: false };
  }
  function emit(t, phase, receipt) {
    if (t.ended) return;
    if (phase === 'act') { if (t.acted) return; t.acted = true; }
    else {
      t.ended = true;
      for (const release of t.pending ?? []) release();
      t.pending?.clear();
    }
    publish({ type: 'action', call: t.call, index: t.index, source: 'native', timing: 'confirmed',
      kind: t.kind, ...t.geometry, ...t.geometryTurn ? { geometryTurn: t.geometryTurn } : {}, phase, ...receipt ? { outcome: receipt } : {} });
  }
  const api = {
    get enabled() { return !closed && consumers.size > 0; },
    get droppedConsumers() { return dropped; },
    connect(write) {
      if (closed || typeof write !== 'function') return () => {};
      const peer = { write, queue: [], active: new Map(), scheduled: false, busy: false }; consumers.add(peer);
      return () => detach(peer, false);
    },
    run(method, params, callContext, fn) {
      const action = actions.has(method);
      // Acquisition needs approval context too, but successful reads stay silent.
      if ((!action && method !== 'getApp') || !api.enabled) return fn();
      // The client also wraps direct local-service requests. A dispatch-owned
      // token already covers those nested requests and their safety checks.
      if (context.getStore()) return fn();
      const t = token(method, params?.args, callContext?.cell);
      return context.run(t, async () => {
        let result, error;
        try { return result = await fn(); }
        catch (caught) { error = caught; throw caught; }
        finally {
          if (action || error?.code === 'APP_DECLINED') {
            const finish = () => {
              const phase = error?.code === 'APP_DECLINED' ? 'declined'
                : error || t.wire && result == null ? 'failed' : 'done';
              emit(t, phase, { ...outcome(result, error), ...t.wire ? { eventRecord: 'missing' } : {} });
            };
            // fd 3 and stdout are independent pipes. Give an in-flight helper
            // terminal one turn to win without delaying the action reply.
            if (t.wire && !t.ended) setImmediate(finish);
            else finish();
          }
        }
      });
    },
    async approval(fn) {
      const t = context.getStore();
      if (t && !t.ended) publish({ type: 'status', state: 'waiting', detail: 'approval', call: t.call });
      try { return await fn(); }
      finally { if (t && !t.ended) publish({ type: 'status', state: 'thinking', call: t.call }); }
    },
    connectGeometry(write) { geometryConsumers.add(write); return () => geometryConsumers.delete(write); },
    get geometryEnabled() { return !closed && geometryConsumers.size > 0; },
    geometryWire(options) {
      return createGlideGeometryWire({ ...options, publish: receipt => {
        for (const write of geometryConsumers) { try { write(receipt); } catch {} }
      } });
    },
    wire({ nonce, stream }) {
      const pending = new Map(); let buffer = '', alive = true;
      const wire = {
        identity(id) { const t = pending.get(id); return t && { call: t.call, index: t.index }; },
        bindTurn(id, turn) { const t = pending.get(id); if (t) t.geometryTurn = turn; },
        begin(id, method, params) {
          if (!actions.has(method) || !api.enabled) return;
          const t = context.getStore() ?? token(method, params?.args);
          t.wire = true;
          if (!alive) return;
          if (pending.size >= 32) { wire.close(); return; }
          pending.set(id, t);
          (t.pending ??= new Set()).add(() => pending.delete(id));
        },
        close() { alive = false; pending.clear(); buffer = ''; wires.delete(wire); },
      };
      wires.add(wire);
      stream?.on('data', chunk => {
        if (!alive) return;
        // All producer fields are ASCII enums and numbers. Refuse oversized chunks
        // before allocating a combined string, independently of the reply parser.
        if (chunk.length > 65536 || buffer.length + chunk.length > 65536) { wire.close(); return; }
        buffer += chunk.toString('utf8');
        let lf;
        while (alive && (lf = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, lf); buffer = buffer.slice(lf + 1);
          if (line.length > 8192) { wire.close(); return; }
          let value;
          try { value = JSON.parse(line); } catch { wire.close(); return; }
          const t = pending.get(value?.id);
          if (value?.protocol === RUNTIME_ACTION_PROTOCOL && value.nonce === nonce && t &&
              value.phase === 'waiting' && value.detail === 'person' && kinds.has(value.kind)) {
            publish({ type: 'status', state: 'waiting', detail: 'person', call: t.call });
            continue;
          }
          if (value?.protocol !== RUNTIME_ACTION_PROTOCOL || value.nonce !== nonce || !t ||
              !phases.has(value.phase) || !kinds.has(value.kind)) continue;
          t.kind = value.kind; t.geometry = runtimeActionGeometry(value);
          emit(t, value.phase, value.phase === 'act' ? undefined : outcome(value.outcome));
          if (value.phase !== 'act') pending.delete(value.id);
        }
        if (buffer.length > 8192) wire.close();
      });
      stream?.on('error', () => wire.close());
      stream?.on('end', () => wire.close());
      stream?.on('close', () => wire.close());
      return wire;
    },
    reset() { cells.clear(); },
    close() { closed = true; geometryConsumers.clear(); cells.clear(); for (const wire of wires) wire.close(); for (const peer of consumers) detach(peer, false); },
  };
  return api;
}
