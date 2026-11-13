import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

const appId = 'com.apple.Safari', title = 'Settings fixture';
const header = { type: 'text', text: `Window: "${title}", App: Safari.\n0 standard window ${title}\n\t31 slider (settable, float) Alert volume, Value: 36` };
const png = (width = 2560, height = 1800) => {
  const bytes = Buffer.alloc(25);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') };
};
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(t, simFocusNote = true) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const directory = mkdtempSync(join(tmpdir(), 'sleight-drag-frame-'));
  const calls = [], replies = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, simFocusNote,
    inputLease: new InputLease({ directory, holder: 'drag frame test' }),
    localTools: { tools: [{ name: 'drag' }], target: async () => ({ app: 'Safari', appId, title: null }),
      call: async (_name, args) => { calls.push(args); return { content: [] }; } } });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); removeTemp(directory); });
  const call = (id, name, args) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  const exchange = async (id, code, content, resultAppId = appId, isError = false) => {
    call(id, 'js', { code }); await settle();
    serverOut.write(JSON.stringify({ id, result: { content, isError,
      _meta: { 'codex/toolSurface': { app: { appId: resultAppId } } } } }) + '\n');
    await settle();
  };
  return { calls, replies, call, exchange };
}

for (const simFocusNote of [true, false]) test(`B r3 standalone screenshots register drag pixels, advice=${simFocusNote}`, async t => {
  const f = fixture(t, simFocusNote);
  await f.exchange(1, 'let app = await cua.getApp("Safari"); app', [header]);
  await f.exchange('string-value', 'await app.setValue(31, "37")', [header]);
  await f.exchange('numeric-value', 'await app.setValue(31, 37)', [{ type: 'text', text: 'Invalid params' }], appId, true);
  await f.exchange('read-value', 'await app.getAXState()', [header]);
  await f.exchange(2, 'await app.getScreenshot()', [png()]);
  await f.exchange(3, 'await app.getScreenshot()', [png()]);
  const drag = async (id, args) => { f.call(id, 'drag', { app: 'Safari', to: [1083, 989], steps: 30, ...args }); await settle(); };
  await drag(4, { from: 31 });
  await drag(5, { from: [1065, 989] });
  await drag(6, { windowId: 334515, from: [1065, 989] });
  assert.equal(f.calls.length, 3);
  for (const args of f.calls) {
    assert.deepEqual(args.screenshot, [2560, 1800]);
    assert.deepEqual(args.screenshots, { [title]: [2560, 1800] });
  }
  // Run the actual helper's element refusal, window selection and frame conversion with no AX or CG calls.
  const helper = { ObjC: { import() {} }, request: f.calls[1], bounds: { X: 0, Y: 33, Width: 1280, Height: 900 }, title };
  runInNewContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), helper);
  assert.throws(() => helper.elementIdentity(f.calls[0].elementLines[31]), /element has no supported AX name or ID/);
  assert.equal(runInNewContext('resolveWindow([{id:334515, bounds, title}], request).id', helper), 334515);
  assert.equal(JSON.stringify(runInNewContext('toPoints(request.from, screenshotScale(request, bounds, title))', helper)), '[532.5,494.5]');
});

test('duplicate emitImage output still registers one screenshot', async t => {
  const f = fixture(t);
  await f.exchange(1, 'let app = await cua.getApp("Safari")', [header]);
  await f.exchange(2, 'nodeRepl.emitImage(await app.getScreenshot())', [png(), png()]);
  f.call(3, 'drag', { app: appId, from: [1065, 989], to: [1083, 989] }); await settle();
  assert.deepEqual(f.calls[0].screenshot, [2560, 1800]);
});

for (const variant of ['unknown', 'reassigned', 'multiple handles', 'wrong app', 'wrong header', 'malformed header', 'distinct images', 'failed', 'quoted call']) {
  test(`a headerless screenshot cannot acquire a frame through ${variant}`, async t => {
    const f = fixture(t);
    await f.exchange(1, 'let app = await cua.getApp("Safari")', [header]);
    const code = variant === 'unknown' ? 'await unknown.getScreenshot()'
      : variant === 'reassigned' ? 'app = await cua.getApp("Safari"); await app.getScreenshot()'
      : variant === 'multiple handles' ? 'await app.getScreenshot(); await other.getScreenshot()'
      : variant === 'quoted call' ? 'nodeRepl.write("app.getScreenshot()"); await cua.getState()'
      : 'await app.getScreenshot()';
    const content = variant === 'wrong header' ? [{ type: 'text', text: 'Window: "Other", App: Safari.' }, png()]
      : variant === 'malformed header' ? [{ type: 'text', text: 'Window: "bad\\q", App: Safari.' }, png()]
      : variant === 'distinct images' ? [png(), png(2000, 1400)] : [png()];
    await f.exchange(2, code, content, variant === 'wrong app' ? 'fixture.other' : appId, variant === 'failed');
    f.call(3, 'drag', { app: 'Safari', from: [1065, 989], to: [1083, 989] }); await settle();
    assert.equal(f.calls[0].screenshots?.[title], undefined);
    if (!['wrong header', 'malformed header'].includes(variant)) assert.equal(f.calls[0].screenshot, undefined);
  });
}

test('a standalone combined read registers its image using its own handle after another app was read', async t => {
  const f = fixture(t);
  await f.exchange(1, 'let app = await cua.getApp("Safari")', [header]);
  await f.exchange(2, 'let other = await cua.getApp("fixture.other")', [
    { type: 'text', text: 'Window: "Other", App: Other.\n0 standard window Other' },
  ], 'fixture.other');
  await f.exchange(3, 'await app.getAXStateAndScreenshot()', [png()]);
  f.call(4, 'drag', { app: 'Safari', from: [1065, 989], to: [1083, 989] }); await settle();
  assert.deepEqual(f.calls[0].screenshots, { [title]: [2560, 1800] });
});
