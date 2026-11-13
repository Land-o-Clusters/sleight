import { EventEmitter } from 'node:events';

// Frozen RTW1 transport from 92d7e698b for the offline delivery cost comparison.
// This module is test-only and never imports or starts a driver.

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
    if (!closed) pending.set(id, { result: displayed, wire: JSON.stringify(displayed) });
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
      if (candidate && candidate.wire === JSON.stringify(message.result)) delivery = candidate.result;
      const transformed = transform(message);
      // A transport transform may remove its private envelope, never alter the
      // displayed evidence used for number admission.
      if (delivery && JSON.stringify(transformed.result) !== candidate.wire) delivery = undefined;
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
