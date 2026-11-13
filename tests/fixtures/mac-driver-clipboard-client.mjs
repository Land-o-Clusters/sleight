import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createMacDriverClient, DRIVER_PROTOCOL } from '../../plugins/sleight/lib/mac-driver/client.mjs';
import { DRIVER_ACTION_METHODS } from '../../plugins/sleight/lib/mac-driver/protocol.mjs';
import { normalizeMacDriverError } from '../../plugins/sleight/lib/mac-driver/errors.mjs';

// A fake transport for real native reply envelopes. No helper is prepared,
// launched or signalled, and the production parser and result mapping run.
export async function clipboardClientReply(native, { method = 'click', context } = {}) {
  const prepare = async () => ({ status: 'ready', build: 'b'.repeat(64), spawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const request = JSON.parse(bytes); done();
      queueMicrotask(() => {
        const reply = request.method === 'ping'
          ? { ok: true, result: { protocol: DRIVER_PROTOCOL, apiVersion: 2, build: 'b'.repeat(64), methods: [...DRIVER_ACTION_METHODS, method] } }
          : { ok: native.ok, ...native.ok ? { result: native.result } : { error: native.error, ...context ? { context } : {} } };
        child.stdout.write(JSON.stringify({ protocol: DRIVER_PROTOCOL, platform: 'darwin', nonce: request.nonce, id: request.id, ...reply }) + '\n');
      });
    } });
    return child;
  } });
  const client = createMacDriverClient({ platform: 'darwin', prepare, requiredMethods: [method] });
  try { return { ok: true, result: await client.request(method, { args: [] }, { context }) }; }
  catch (error) { return { ok: false, error: { ...error, ...normalizeMacDriverError(error, { action: true }) } }; }
  finally { await client.close(); }
}
