import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { MAX_IMAGE_EDGE, createRelay, imageSize, shrinkImages } from '../plugins/sleight/lib/relay.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';

// A PNG header is all imageSize reads.
const png = (width, height) => {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b.toString('base64');
};
const fitResize = async data => { const { width, height } = imageSize(data); const f = MAX_IMAGE_EDGE / Math.max(width, height); return png(Math.round(width * f), Math.round(height * f)); };

test('only screenshots past the size Claude Code would shrink are resized, and the factor maps back', async () => {
  const small = { type: 'image', data: png(1100, 800), mimeType: 'image/png' };
  assert.deepEqual(await shrinkImages([{ type: 'text', text: 'x' }, small], fitResize), { content: [{ type: 'text', text: 'x' }, small], factor: 1 });
  const { content, factor } = await shrinkImages([{ type: 'image', data: png(2446, 1898), mimeType: 'image/png' }], fitResize);
  assert.deepEqual(imageSize(content[0].data), { width: 1568, height: 1217 });
  assert.ok(Math.abs(factor - 2446 / 1568) < 1e-9);
  // A resize that fails leaves the image as it was, and no factor.
  const kept = await shrinkImages([{ type: 'image', data: png(2446, 1898) }], async () => undefined);
  assert.equal(kept.factor, 1); assert.deepEqual(imageSize(kept.content[0].data), { width: 2446, height: 1898 });
});

test('the guard scales coordinates back to engine pixels, by window title first, and leaves element numbers alone', async () => {
  const calls = [];
  const app = { getAXState: async () => 'Window: "Game 2", App: Chess.\n0 standard window Game 2',
    click: async (...a) => calls.push(['click', ...a]), drag: async (...a) => calls.push(['drag', ...a]), scroll: async (...a) => calls.push(['scroll', ...a]) };
  const run = (code, scales) => runInNewContext(`(async () => { ${guardedCode(code, { title: 'Game 2', app: 'Chess', url: null }, 'stop', undefined, { adoptUrl: true, scales })} })()`,
    { app, cua: { getApp: async () => app }, nodeRepl: { write() {} } });
  await run('await app.click([100, 200]); await app.drag([10, 20], [30, 41]); await app.scroll([5, 5], "down", 1); await app.click(7, { clickCount: 2 });', { latest: 1.5, byTitle: {} });
  const plain = () => JSON.parse(JSON.stringify(calls)); // the guard runs in another realm
  assert.deepEqual(plain(), [['click', [150, 300]], ['drag', [15, 30], [45, 62]], ['scroll', [8, 8], 'down', 1], ['click', 7, { clickCount: 2 }]]);
  calls.length = 0;
  await run('await app.click([100, 200]);', { latest: 1.5, byTitle: { 'Game 2': 2 } });
  assert.deepEqual(plain(), [['click', [200, 400]]]);
  calls.length = 0;
  await run('await app.click([100, 200]);', undefined);
  assert.deepEqual(plain(), [['click', [100, 200]]]);
});

test('the relay shrinks a large screenshot it forwards, and the next call carries the factor to the guard', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { InputLease } = await import('../plugins/sleight/lib/input-lease.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'sleight-shots-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const [clientIn, clientOut, serverIn, serverOut] = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  const toServer = [], toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's', changeReview: false, resizeImage: fitResize, inputLease: new InputLease({ directory, holder: 'A' }) });
  t.after(() => relay.close());
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
  const js = (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const header = 'Window: "Game 2", App: Chess.\n0 standard window Game 2';
  const reply = (id, content) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content, _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.Chess' } } } } }) + '\n');
  js(0, 'let app = await cua.getApp("com.apple.Chess")'); await settle(); reply(0, [{ type: 'text', text: header }]); await settle();
  js(1, 'await app.getScreenshot();'); await settle();
  reply(1, [{ type: 'text', text: header }, { type: 'image', data: png(2446, 1898), mimeType: 'image/png' }]);
  await settle(); await new Promise(r => setTimeout(r, 20)); await settle();
  const image = toClient.find(m => m.id === 1).result.content.find(c => c.type === 'image');
  assert.deepEqual(imageSize(image.data), { width: 1568, height: 1217 });
  js(2, 'await app.click([651, 587]);'); await settle();
  const code = toServer.find(m => m.id === 2).params.arguments.code;
  assert.match(code, /state\.scales = \{"latest":1\.5599/);
});
