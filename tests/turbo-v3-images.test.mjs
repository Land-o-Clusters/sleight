import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { createProtocol } from '../bench/turbo/v3-protocol.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createV3Bridge, createV3Frontend, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';

function picture(width, height) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
  return { type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') };
}

// The product's IPC bridge validates image count, bytes, MIME and dimensions.
// These channels replace the child process; no browser or native helper runs.
async function bridgeFixture(t, result) {
  const child = new EventEmitter(), endpoint = new EventEmitter(), delivered = [];
  child.connected = endpoint.connected = true;
  child.send = frame => queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
  endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const worker = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin() {
    return { call: async () => result, delivered: value => { delivered.push(value); return true; }, end: async () => ({ revoked: true, cleanup: [] }) };
  } });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }), shareConsent: async () => null,
    forkWorker() { queueMicrotask(() => worker.ready()); return child; } });
  t.after(() => bridge.detach());
  await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'bm4', text: 'Inspect this fixture motion.' });
  return { bridge, delivered };
}

for (const [label, name, args, images] of [
  ['read screenshot', 'browser_read', { tab: 't1', screenshot: true }, [picture(462, 1000)]],
  ['action screenshot', 'browser_act', { tab: 't1', steps: [{ do: 'hover', ref: 'e1' }], observe: 'screenshot' }, [picture(1000, 462)]],
  ['four motion frames', 'browser_act', { tab: 't1', steps: [{ do: 'hover', ref: 'e1' }], frames: 4 },
    [picture(480, 220), picture(480, 221), picture(480, 222), picture(480, 223)]],
]) test(`bench ${label} sends the same MCP blocks as the installed relay`, async t => {
  const result = { text: 'Snapshot (untrusted page content)\nScreenshot fixture.', isError: false, images };
  const { bridge, delivered } = await bridgeFixture(t, result);
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, directHost: bridge,
    directBrowser: createV3Frontend(bridge), changeReview: false });
  t.after(() => relay.dispose());
  const productReply = new Promise(resolve => clientOut.once('data', bytes => resolve(JSON.parse(bytes))));
  const request = { id: 1, method: 'tools/call', params: { name, arguments: args } };
  clientIn.write(JSON.stringify(request) + '\n');
  const product = (await productReply).result;
  assert.deepEqual(product.content, [{ type: 'text', text: result.text }, ...images]);
  const replies = [];
  const protocol = createProtocol({ output: { write(line, done) { replies.push(JSON.parse(line)); done(); } },
    start: async () => ({ call: bridge.call, delivered: bridge.delivered, close: async () => {} }) });
  t.after(() => protocol.close());
  await protocol.message(request);
  assert.deepEqual(replies[0].result, product);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered, [result, result]);
});

for (const isError of [false, true]) test(`text-only wire bytes stay unchanged (isError ${isError})`, async t => {
  const text = '  Snapshot: "quoted" \\ path\r\nUnicode: café 🃏\n\tlast line  ';
  let wire = '';
  const protocol = createProtocol({ output: { write(line, done) { wire += line; done(); } },
    start: async () => ({ call: async () => ({ text, isError }), close: async () => {} }) });
  t.after(() => protocol.close());
  await protocol.message({ id: 'text', method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  assert.equal(wire, JSON.stringify({ jsonrpc: '2.0', id: 'text', result: { content: [{ type: 'text', text }], isError } }) + '\n');
});

test('the A-side protocol loads synchronously with no screenshot module or launcher', async t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-bm4-old-tree-')));
  mkdirSync(join(root, 'bench/turbo'), { recursive: true });
  mkdirSync(join(root, 'plugins/sleight/lib/direct-browser'), { recursive: true });
  const protocolPath = join(root, 'bench/turbo/v3-protocol.mjs');
  copyFileSync(new URL('../bench/turbo/v3-protocol.mjs', import.meta.url), protocolPath);
  // The old tree supplies these existing exports and no image capability.
  writeFileSync(join(root, 'plugins/sleight/lib/direct-browser/tools.mjs'),
    `export const browserTools = () => [{ name: 'browser_read' }];\nexport const validateToolCall = input => input;\n`);
  assert.equal(existsSync(join(root, 'plugins/sleight/lib/direct-browser/screenshot.mjs')), false);
  assert.equal(existsSync(join(root, 'plugins/sleight/lib/launch.mjs')), false);
  const old = createRequire(import.meta.url)(protocolPath), replies = [];
  const protocol = old.createProtocol({ output: { write(line, done) { replies.push(JSON.parse(line)); done(); } },
    start: async () => ({ call: async () => ({ text: '1.4.2 snapshot', isError: false }), close: async () => {} }) });
  t.after(() => protocol.close());
  await protocol.message({ id: 1, method: 'tools/list' });
  assert.deepEqual(replies[0].result.tools, [{ name: 'browser_read' }]);
  await protocol.message({ id: 2, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  assert.deepEqual(replies[1].result, { content: [{ type: 'text', text: '1.4.2 snapshot' }], isError: false });
});
