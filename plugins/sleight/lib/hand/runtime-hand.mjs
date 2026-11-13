import { randomBytes } from 'node:crypto';
import { privateHandGeometry } from './client.mjs';
import { privateGlideObservation } from '../mac-driver/geometry.mjs';

const rectangle = r => Array.isArray(r) && r.length === 4 && r.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000) && r[2] > 0 && r[3] > 0;
const outward = r => [Math.floor(r[0]), Math.floor(r[1]), Math.ceil(r[0] + r[2]) - Math.floor(r[0]), Math.ceil(r[1] + r[3]) - Math.floor(r[1])];

// Runtime geometry replaces predictive planning. Nothing here locates or approves a target.
export function createRuntimeHand({ events, client, producer = false, onReceipt = () => {} } = {}) {
  const geometry = producer === true ? privateHandGeometry(client) : undefined, bindings = new Map(), windows = new Map();
  let turn, ordinal = 0, failed = false, stopped = false, lastWindow;
  const refuse = () => { failed = true; return false; };
  // Called only by the parent's attributed boundary, including after a driver
  // replacement whose new wire cannot name the old hand turn.
  const endTurn = () => {
    if (!geometry || !turn) return false;
    const result = geometry.endTurn();
    if (result === false && lastWindow) client?.send({ hand: 'status', state: 'handback', ...lastWindow, turn });
    turn = undefined; bindings.clear(); windows.clear(); return result;
  };
  const consume = record => {
    if (record.type === 'status') { events?.status(record.state, { call: record.call, detail: record.detail }); return; }
    const { outcome, geometryTurn, ...action } = record;
    if (geometry && geometryTurn !== undefined && geometryTurn !== turn) {
      // Attribution can refuse the cursor event, but the target must still reach ordinary protection.
      if (action.phase === 'act' && action.point && action.window?.id && action.window?.pid)
        client?.send({ kind: action.kind === 'select' ? 'click' : action.kind, pid: action.window.pid, windowId: action.window.id,
          at: action.point, path: action.path ?? [action.point], rect: action.rect, windowRect: action.window.rect,
          delayMs: 0, beats: 1, turn: geometryTurn });
      return;
    }
    if (action.phase === 'act') {
      events?.action({ ...action, phase: 'aim' });
      events?.action(action);
      if (action.point && action.window?.id && action.window?.pid) {
        lastWindow = { pid: action.window.pid, windowId: action.window.id };
        const frame = { kind: action.kind === 'select' ? 'click' : action.kind,
          pid: action.window.pid, windowId: action.window.id, at: action.point,
          path: action.path ?? [action.point], rect: action.rect, windowRect: action.window?.rect, delayMs: 0, beats: 1 };
        if (!geometry) client?.send(frame);
        else if (turn && (geometryTurn === undefined || geometryTurn === turn)) {
          const seq = geometry.admit(frame, { call: action.call, action: action.index + 1, attempt: 1, ordinal: ++ordinal });
          if (seq !== false && seq !== undefined) bindings.set(`${action.call}:${action.index}`, seq);
          else refuse();
        } else refuse();
      } else if (geometry) refuse();
    } else {
      events?.action(action);
      events?.status(action.phase === 'done' ? 'done' : action.phase === 'skipped' ? 'idle' : 'error', { call: action.call });
      if (action.phase !== 'done' || outcome?.eventRecord === 'missing') client?.hide();
      // The cursor/1 schema has no settle field. Keep this fixed-enum receipt
      // on the internal consumer seam, separate from the public record.
      onReceipt({ call: action.call, index: action.index, ...outcome });
    }
  };
  // The receipt is a WeakMap capability minted by the inherited Glide pipe.
  // No cursor record, model JSON or public hand frame can supply it.
  consume.geometry = receipt => {
    const observation = privateGlideObservation(receipt);
    if (!geometry || !observation) return false;
    if (observation.type === 'begin') {
      if (turn) return refuse();
      turn = observation.turn; ordinal = 0; failed = stopped = false; lastWindow = undefined; bindings.clear(); windows.clear();
      return geometry.beginTurn(turn);
    }
    if (observation.turn !== turn) return false;
    if (observation.type === 'end') {
      return endTurn();
    }
    if (observation.type === 'fault') { geometry.invalidate('ambient'); return refuse(); }
    if (failed || observation.type !== 'observation') return false;
    const o = observation;
    if (!o.continuous) return refuse();
    if (o.queuedInput) return refuse();
    if (o.drag) return refuse();
    if (!o.complete) return refuse();
    if (!o.notifications) return refuse();
    if (!o.settled) return refuse();
    if (!Number.isSafeInteger(o.before) || o.before !== o.after) return refuse();
    if (typeof o.initial !== 'string' || !/^[a-f0-9]{64}$/.test(o.initial) || o.initial !== o.rendered || o.initial !== o.final) return refuse();
    if (!o.transform || !rectangle(o.bounds)) return refuse();
    if (!Number.isSafeInteger(o.pid) || o.pid < 1 || !/^[1-9][0-9]{0,9}$/.test(o.window) || typeof o.processStart !== 'string' || !o.processStart) return refuse();
    lastWindow = { pid: o.pid, windowId: Number(o.window) };
    const key = `${o.pid}:${o.window}`, old = windows.get(key);
    if (old && old.start !== o.processStart) return refuse();
    const admitted = geometry.state.admitted.filter(r => r.pid === o.pid && r.windowId === Number(o.window));
    const references = [];
    for (const row of o.references) {
      if (!row.action || !row.joined) return refuse();
      if (!row.semantic) return refuse();
      if (!row.clipping) return refuse();
      const seq = bindings.get(`${row.action.call}:${row.action.index}`);
      // An unbound native entry could be an action whose event was lost before
      // host admission. Keep it unresolved, including prepared-only entries.
      if (seq === undefined) return refuse();
      if (row.departed !== true && row.departed !== false || !Array.isArray(row.rects) ||
          (row.departed ? row.rects.length !== 0 : row.rects.length < 1 || row.rects.length > 4) || !row.rects.every(rectangle)) return refuse();
      references.push({ seq, departed: row.departed, rects: row.rects.map(outward) });
    }
    if (references.length !== admitted.length || new Set(references.map(r => r.seq)).size !== references.length || !admitted.every(r => references.some(ref => ref.seq === r.seq))) return refuse();
    if (!old && (ordinal !== 0 || geometry.state.admitted.length !== 0 || windows.size >= 128)) return refuse();
    // Checking pending first avoids turning an ordinary late acknowledgement
    // into a fabricated acquisition. capture enforces the admission watermark.
    if (geometry.state.pending) return false;
    const ticket = geometry.capture({ start: o.acquired[0], end: o.acquired[1] });
    if (!ticket) return false;
    const incarnation = old?.incarnation ?? randomBytes(16).toString('hex');
    const result = geometry.certify(ticket, { pid: o.pid, windowId: Number(o.window), incarnation,
      contentGeneration: 0, mode: old ? 'layout' : 'baseline', bounds: outward(o.bounds), references });
    if (result !== false) windows.set(key, { start: o.processStart, incarnation });
    return result;
  };
  consume.endTurn = endTurn;
  // Stop revokes observations, not the logical visual turn. In-flight targets
  // still admit; only the next attributed boundary can release their protection.
  consume.stopTurn = () => {
    if (!geometry || !turn || stopped) return false;
    failed = stopped = true;
    return geometry.invalidate('ambient');
  };
  return consume;
}
