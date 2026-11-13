import { randomBytes } from 'node:crypto';
import { immutableJSON } from './ipc.mjs';

// Pure private channel parser. read/write are inherited pipes of the selected
// child, never a local socket, page bridge or model endpoint. Tests inject streams
// solely to test framing/replay logic, not to claim native-user authentication.
export function createUiChannel({ read, write, onLoss = () => {}, discardOldNonce = false }) {
  const nonce = randomBytes(32).toString('hex'), pending = new Map(), retired = new Map(), events = new WeakSet();
  const retire = (id, record) => { retired.set(id, record); if (retired.size > 256) retired.delete(retired.keys().next().value); };
  let buffer = '', closed = false;
  const lose = () => { if (closed) return; closed = true; pending.clear(); onLoss(); };
  read.on('data', chunk => {
    try {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 131072) throw Error();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const raw = immutableJSON(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
        // A successor worker inherits the same session pipe. Only a reply to its fresh nonce can authenticate.
        if (discardOldNonce && raw?.nonce !== nonce && /^[0-9a-f]{64}$/.test(raw?.nonce ?? '')) continue;
        const old = retired.get(raw.id);
        if (old?.dismissed && raw.nonce === nonce && Object.keys(raw).length === 3 && old.choices.includes(raw.choice)) continue;
        const record = pending.get(raw.id);
        if (!record || raw.nonce !== nonce || Object.keys(raw).length !== 3 ||
            !record.choices.includes(raw.choice) || Date.now() >= record.deadline) throw Error();
        pending.delete(raw.id); retire(raw.id, record);
        const event = Object.freeze({ id: raw.id, choice: raw.choice, action: raw.choice,
          selection: record.selection });
        events.add(event); Promise.resolve(record.deliver(event)).catch(lose);
      }
    } catch { lose(); }
  });
  read.on('end', lose); read.on('error', lose); write.on('error', lose);
  const channel = Object.freeze({
    present(id, data, choices, deliver, { selection, deadline = Date.now() + 30000 } = {}) {
      for (const [key, record] of pending) if (Date.now() >= record.deadline || data?.status && record.status) pending.delete(key);
      if (closed || pending.has(id) || pending.size >= 32 || typeof id !== 'string' ||
          !Array.isArray(choices) || !choices.length || typeof deliver !== 'function' ||
          !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 300000) throw Error('TRUSTED_UI_UNAVAILABLE');
      const frame = immutableJSON({ id, nonce, data, choices, deadline });
      if (Buffer.byteLength(JSON.stringify(frame)) > 65536) throw Error('TRUSTED_UI_UNAVAILABLE');
      pending.set(id, { choices: [...choices], deliver, status: data?.status,
        selection: selection && immutableJSON(selection), deadline });
      write.write(JSON.stringify(frame) + '\n');
    },
    authenticate(event) { if (!event || !events.has(event)) return false; events.delete(event); return !closed; },
    dismiss(id) {
      if (closed) return;
      const record = pending.get(id) ?? retired.get(id);
      if (!record || record.dismissed) return;
      pending.delete(id); retire(id, { ...record, dismissed: true });
      write.write(JSON.stringify({ id, nonce, dismiss: true }) + '\n');
    },
    revoke() { pending.clear(); },
    close() { lose(); write.end(); },
  });
  return channel;
}
