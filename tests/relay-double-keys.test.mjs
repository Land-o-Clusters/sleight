import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

// Characterize the two places sleight could multiply a native typing request:
// newline framing and the injected app proxy. No native helper runs here.
test('fragmented typing requests and repeated approval prompts forward one action', async t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const forwarded = [];
  serverIn.on('data', chunk => forwarded.push(JSON.parse(chunk.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut,
    changeReview: false, ask: async () => 'accept' });
  t.after(() => relay.close());
  const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'js', arguments: { code: 'await app.typeText("A1|")' } } }) + '\n';
  for (const byte of Buffer.from(call)) clientIn.write(Buffer.from([byte]));
  for (const id of ['approval-1', 'approval-2']) {
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'elicitation/create',
      params: { message: 'Allow Computer Use to use "TextEdit"?', _meta: {
        connector_id: 'computer-use', tool_params: { app: 'com.apple.TextEdit' }, persist: ['session'],
      } } }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
  }
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true,
    content: [{ type: 'text', text: 'helper failed after input' }] } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forwarded.filter(msg => msg.params?.name === 'js').length, 1);
  assert.equal(forwarded.filter(msg => msg.result?.action === 'accept').length, 2);
});

test('repeated app reads and guards invoke native typing once per submitted call', async t => {
  const bank = mkdtempSync(join(tmpdir(), 'sleight-double-keys-unit-'));
  const path = join(bank, 'fixture.txt');
  writeFileSync(path, '');
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const forwarded = [];
  serverIn.on('data', chunk => forwarded.push(JSON.parse(chunk.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: true });
  t.after(() => { relay.close(); rmSync(bank, { recursive: true, force: true }); });
  const writes = [];
  const state = `Window: "fixture.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}\n1 text entry area`;
  const raw = { getAXState: async () => state, typeText: async text => { writes.push(text); } };
  const realm = { cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const submit = async (id, code) => {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'js', arguments: { code } } }) + '\n');
    await runInNewContext(`(async () => { ${forwarded.at(-1).params.arguments.code} })()`, realm);
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: state }] } }) + '\n');
  };
  await submit(1, 'app = await cua.getApp("TextEdit")');
  await submit(2, 'await app.typeText("A1|")');
  await submit(3, 'app = await cua.getApp("TextEdit")');
  await submit(4, 'await app.typeText("A2|")');
  assert.deepEqual(writes, ['A1|', 'A2|']);
});
