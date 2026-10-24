import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { receiveDownload } from '../plugins/sleight/lib/direct-browser/download-response.mjs';

function fixture(options = {}) {
  const cdp = new EventEmitter(), calls = [], closed = [], received = [];
  const emit = (extra = {}) => cdp.emit('Fetch.requestPaused', { requestId: 'request', request: { method: 'GET', url: 'https://fixture.invalid/file' },
    resourceType: 'Document', responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/csv' }], ...extra });
  cdp.send = async (method, params) => {
    calls.push({ method, params });
    if (options.send) { const value = await options.send(method, params, emit); if (value !== undefined) return value; }
    if (method === 'Page.navigate') { if (!options.silent) queueMicrotask(() => emit()); return {}; }
    if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'response' };
    if (method === 'IO.read') return { data: Buffer.from('a,b\n1,2').toString('base64'), base64Encoded: true, eof: true };
    return {};
  };
  const run = extra => receiveDownload({ createTarget: async () => ({ targetId: 'owned', cdp }), closeTarget: async target => { closed.push(target); },
    url: 'https://fixture.invalid/file', current: () => true, allowed: () => true, timeoutMs: 100,
    receive: async (headers, chunks) => { const parts = []; for await (const chunk of chunks) parts.push(chunk); received.push({ headers, bytes: Buffer.concat(parts) }); }, ...extra });
  return { cdp, run, calls, closed, received };
}
test('download streams close and their navigation aborts before their target is collected', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.received[0].bytes.toString(), 'a,b\n1,2');
  assert.deepEqual(f.calls.slice(-2).map(c => c.method), ['IO.close', 'Fetch.failRequest']);
  assert.deepEqual(f.closed, ['owned']); assert.equal(f.cdp.listenerCount('Fetch.requestPaused'), 0);
  assert.deepEqual(f.calls.find(c => c.method === 'Emulation.setScriptExecutionDisabled').params, { value: true });
});
test('a timed-out download collects the target and listeners without claiming a file', async () => {
  const f = fixture({ silent: true });
  await assert.rejects(f.run({ timeoutMs: 10 }), /timed out/);
  assert.deepEqual(f.closed, ['owned']); assert.deepEqual(f.received, []); assert.equal(f.cdp.listenerCount('Fetch.requestPaused'), 0);
});
test('revocation during setup prevents the HTTP request', async () => {
  let active = true;
  const f = fixture({ send: method => { if (method === 'Fetch.enable') active = false; } });
  await assert.rejects(f.run({ current: () => active }), /authority expired/);
  assert.equal(f.calls.some(c => c.method === 'Page.navigate'), false); assert.deepEqual(f.closed, ['owned']);
});
test('revocation before a stream reply prevents delivery', async () => {
  let active = true;
  const f = fixture({ send: method => { if (method === 'IO.read') active = false; } });
  await assert.rejects(f.run({ current: () => active }), /authority expired/);
  assert.deepEqual(f.received, []); assert.deepEqual(f.closed, ['owned']);
});
test('refuses a redirect destination before allowing Chromium to request it', async () => {
  const f = fixture({ silent: true, send(method, params, emit) { if (method === 'Page.navigate') queueMicrotask(() => emit({ responseStatusCode: 302,
    responseHeaders: [{ name: 'location', value: 'https://blocked.invalid/file' }] })); } });
  await assert.rejects(f.run({ allowed: url => !url.includes('blocked.invalid') }), /URL refused/);
  assert.equal(f.calls.some(c => c.method === 'Fetch.continueRequest'), false); assert.deepEqual(f.closed, ['owned']);
});
test('a failed target close refuses successful completion', async () => {
  const f = fixture();
  await assert.rejects(f.run({ closeTarget: async () => { throw Error('cleanup unconfirmed'); } }), /cleanup unconfirmed/);
});
