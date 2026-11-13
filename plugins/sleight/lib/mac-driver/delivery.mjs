import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';

// Parent results contain JSON data. Snapshot their containers while retaining
// immutable strings, including screenshot data, without another encoded copy.
// Match JSON's omission of undefined object fields and its null array entries.
function snapshotJSON(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return Array.from(value, item => snapshotJSON(item) ?? null);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, snapshotJSON(item)]));
  if (typeof value === 'number') return Number.isFinite(value) ? value || 0 : null;
  return value;
}

// The own facade owns this transport. Keep the exact parent result until the
// final destination acknowledges the bytes, including on the shell route.
// No change to the engine relay's output path is required.
export function createMacDeliveryTransport({ output, session, transform = message => message } = {}) {
  const pending = new Map();
  let closed = false;
  const clientOut = new EventEmitter();
  const nativeSession = Object.create(session);
  nativeSession.displayResult = (id, result) => {
    const displayed = session.displayResult(id, result);
    if (!closed) pending.set(id, { result: displayed, snapshot: snapshotJSON(displayed) });
    return displayed;
  };
  Object.defineProperties(clientOut, {
    destroyed: { get: () => output.destroyed },
    writableEnded: { get: () => output.writableEnded },
  });
  const onError = error => clientOut.emit('error', error);
  output.on('error', onError);
  clientOut.write = (bytes, callback) => {
    let delivery, wire = bytes;
    try {
      const message = JSON.parse(bytes);
      const candidate = message.method === undefined ? pending.get(message.id) : undefined;
      pending.delete(message.id);
      const transformed = transform(message);
      // A transport transform may remove its private envelope, never alter the
      // displayed evidence used for number admission.
      if (candidate && isDeepStrictEqual(transformed.result, candidate.snapshot)) delivery = candidate.result;
      wire = JSON.stringify(transformed) + '\n';
    } catch (error) {
      callback?.(error); return false;
    }
    let completed = false;
    const complete = error => {
      if (completed) return;
      completed = true;
      try { callback?.(error); }
      finally { if (delivery && !closed) session.recordDelivery(delivery, error); }
    };
    try { return output.write(wire, complete); }
    catch (error) { complete(error); return false; }
  };
  return { clientOut, nativeSession,
    close() { closed = true; pending.clear(); output.off('error', onError); },
  };
}
