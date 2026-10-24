import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { screenshot, jpegSize, validImages, IMAGE_BYTES } from '../plugins/sleight/lib/direct-browser/screenshot.mjs';
import { browserTools, createToolDispatcher, validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';

// SOF/EOI fixture for the dimension/budget parser, never passed to an image decoder.
const jpeg = (width = 640, height = 480) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8,
  height >> 8, height & 255, width >> 8, width & 255, 0, 0xff, 0xd9]).toString('base64');
const image = (width, height) => ({ type: 'image', mimeType: 'image/jpeg', data: jpeg(width, height) });
const native = type => ({ strings: ['INPUT', 'type', type], documents: [{ nodes: {
  nodeName: [0], nodeValue: [-1], parentIndex: [-1], attributes: [[1, 2]],
} }] });

function fixture({ type = 'text', fail, after, extraFrames = 0, send, attach } = {}) {
  const calls = [], page = new EventEmitter(), frames = Array.from({ length: extraFrames + 1 }, () => ({}));
  frames[0]._connection = { toImpl: () => ({ utilityContext: async () => ({ world: 'utility', evaluateExpression: async () => {} }) }) };
  const state = { snapshotNo: 0 }, entry = { page, state };
  Object.assign(page, { url: () => 'https://fixture.invalid/', frames: () => frames, mainFrame: () => frames[0], isClosed: () => false,
    context: () => ({ async newCDPSession(frame) {
      const cdp = new EventEmitter();
      cdp.send = async (method, params) => {
        calls.push({ method, params, frame });
        const override = await send?.(method, params, cdp);
        if (override !== undefined) return override;
        if (fail === method) throw Error('private fixture detail must not escape');
        if (method === 'Runtime.evaluate') cdp.emit('Debugger.paused');
        if (method === 'Debugger.disable') cdp.emit('Debugger.resumed');
        if (method === 'DOMSnapshot.captureSnapshot') return native(type);
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 640, clientHeight: 480, scale: 1, pageX: 0, pageY: 0 } };
        if (method === 'Page.captureScreenshot') { after?.(page); return { data: jpeg() }; }
        return {};
      };
      cdp.detach = async () => { calls.push({ method: 'detach', frame }); };
      await attach?.(cdp);
      return cdp;
    } }),
  });
  return { entry, page, calls, frames };
}

test('FD1 screenshot options are bounded per-call data, without new tools or authority fields', () => {
  assert.equal(browserTools().length, 5);
  for (const screenshot of [true, false]) assert.doesNotThrow(() => validateToolCall({ name: 'browser_read', arguments: { tab: 't1', screenshot } }));
  assert.doesNotThrow(() => validateToolCall({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'hover', ref: 'e1' }], observe: 'screenshot' } }));
  for (const extra of [{ screenshot: 'true' }, { screenshot: {} }, { full_page: true }, { screenshot: true, max_side: 10000 }])
    assert.throws(() => validateToolCall({ name: 'browser_read', arguments: { tab: 't1', ...extra } }));
});

test('FD1 encoded image validation enforces MIME, count, pixel and byte budgets', () => {
  assert.deepEqual(jpegSize(jpeg(1, 2)), { width: 1, height: 2 });
  assert.equal(validImages([image(1000, 625)]), true);
  for (const images of [[], [image(), image()], [image(1001, 1)], [{ ...image(), mimeType: 'image/png' }],
    [{ ...image(), extra: 'not allowed' }], [{ ...image(), data: 'A'.repeat(IMAGE_BYTES * 2) }],
    [{ ...image(), data: 'not base64' }], [{ ...image(), data: '/9j/2Q==' }]]) assert.equal(validImages(images), false);
});

test('FD1 capture uses only owned renderer sessions and resumes/detaches each', async () => {
  const f = fixture({ extraFrames: 1 });
  const result = await screenshot(f.entry);
  assert.equal(result.images.length, 1); assert.match(result.note, /640x480.*untrusted/);
  assert.equal(f.calls.filter(c => c.method === 'Debugger.pause').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'detach').length, 2);
  assert.ok(f.calls.every(call => f.frames.includes(call.frame)));
  assert.equal(f.calls.find(c => c.method === 'Page.captureScreenshot').frame, f.frames[0]);
  assert.deepEqual(f.calls.filter(c => c.method === 'Runtime.evaluate').map(c => c.params),
    Array.from({ length: 2 }, () => ({ expression: 'void 0', silent: true, returnByValue: true, userGesture: false })));
  assert.deepEqual(f.calls.filter(c => c.method === 'Debugger.enable').map(c => c.params),
    [{ maxScriptsCacheSize: 0 }, { maxScriptsCacheSize: 0 }]);
  for (const event of ['framenavigated', 'frameattached', 'framedetached', 'dialog', 'close']) assert.equal(f.page.listenerCount(event), 0);
});

test('FD1B cumulative capture work shares one absolute deadline and still releases every session', async () => {
  let clock = 0;
  const f = fixture({ extraFrames: 3, send: async method => {
    if (method !== 'Debugger.disable') clock += 250;
  } });
  const result = await screenshot(f.entry, { now: () => clock });
  assert.equal(result.images, undefined);
  assert.match(result.note, /Screenshot skipped/);
  assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 0);
  const enabled = f.calls.filter(c => c.method === 'Debugger.enable').length;
  assert.equal(f.calls.filter(c => c.method === 'Debugger.disable').length, enabled);
  assert.equal(f.calls.filter(c => c.method === 'detach').length, enabled);
});

test('FD1B pages beyond four frames are refused before any renderer pauses', async () => {
  const f = fixture({ extraFrames: 4 });
  const result = await screenshot(f.entry);
  assert.equal(result.images, undefined);
  assert.equal(f.calls.length, 0);
});

test('FD1B a stalled capture returns in about three seconds and resumes the renderer', { timeout: 10000 }, async () => {
  const f = fixture({ send: async method => {
    if (['Debugger.enable', 'Debugger.pause'].includes(method)) await new Promise(resolve => setTimeout(resolve, 1100));
    if (method === 'DOMSnapshot.captureSnapshot') return new Promise(() => {});
  } });
  const started = performance.now(), result = await screenshot(f.entry);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 2800 && elapsed < 3600, `elapsed ${elapsed} ms`);
  assert.equal(result.images, undefined);
  assert.ok(f.calls.some(c => c.method === 'Debugger.disable'));
  assert.ok(f.calls.some(c => c.method === 'detach'));
});

test('FD1B a hung debugger cleanup cannot delay detaching other paused sessions', { timeout: 10000 }, async () => {
  const f = fixture({ extraFrames: 3, send: method => method === 'Debugger.disable' ? new Promise(() => {}) : undefined });
  const started = performance.now(), result = await screenshot(f.entry);
  assert.ok(performance.now() - started < 3600);
  assert.equal(result.images, undefined);
  assert.match(result.note, /cleanup unconfirmed/);
  assert.equal(f.calls.filter(c => c.method === 'detach').length, 4);
});

test('FD1B a late attachment is detached without enabling or pausing its renderer', { timeout: 10000 }, async () => {
  let release;
  const f = fixture({ attach: () => new Promise(resolve => { release = resolve; }) });
  const result = await screenshot(f.entry);
  assert.equal(result.images, undefined);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(c => c.method), ['detach']);
});

test('FD1B an attachment resolving at the deadline is detached even before the timeout continuation', async () => {
  let clock = 0;
  const f = fixture({ attach: async () => { await Promise.resolve(); clock = 3000; } });
  const result = await screenshot(f.entry, { now: () => clock });
  assert.equal(result.images, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(c => c.method), ['detach']);
});

test('FD1B native pixel dimensions correct DPR/zoom scaling without exceeding the delivered byte cap', async () => {
  let clock = 0;
  const f = fixture({ send: (method, params) => {
    if (method === 'Page.captureScreenshot') {
      clock += 50;
      return { data: jpeg(Math.round(1600 * params.clip.scale), Math.round(1200 * params.clip.scale)) };
    }
  } });
  const result = await screenshot(f.entry, { maxSide: 480, now: () => clock });
  assert.ok(result.images, result.note);
  assert.deepEqual(jpegSize(result.images[0].data), { width: 480, height: 360 });
  assert.equal(validImages(result.images, { maxSide: 480 }), true);
  assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 2);
  assert.match(result.note, /downscaled/);
  assert.equal(result.capturedAt, 50, 'the delivered image uses its own capture request time');
});

test('FD1B a large intermediate JPEG is downscaled without delivering its over-budget bytes', async () => {
  let count = 0;
  const large = Buffer.concat([Buffer.from(jpeg(2000, 1500), 'base64').subarray(0, -2), Buffer.alloc(IMAGE_BYTES), Buffer.from([0xff, 0xd9])]).toString('base64');
  const f = fixture({ send: method => method === 'Page.captureScreenshot' ? { data: ++count === 1 ? large : jpeg(480, 360) } : undefined });
  const result = await screenshot(f.entry, { maxSide: 480 });
  assert.equal(count, 2);
  assert.equal(validImages(result.images, { maxSide: 480 }), true);
  assert.ok(Buffer.from(result.images[0].data, 'base64').length < IMAGE_BYTES);
});

test('FD1B a page change between native captures withholds pixels and prevents the retry', async () => {
  const f = fixture({ send: method => {
    if (method === 'Page.captureScreenshot') { f.page.emit('framenavigated'); return { data: jpeg(2000, 1500) }; }
  } });
  const result = await screenshot(f.entry);
  assert.equal(result.images, undefined);
  assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 1);
  assert.equal(f.calls.at(-1).method, 'detach');
});

test('FD1B refuses an over-budget final JPEG after native downscaling', async () => {
  const bytes = Buffer.concat([Buffer.from(jpeg(480, 360), 'base64').subarray(0, -2), Buffer.alloc(IMAGE_BYTES), Buffer.from([0xff, 0xd9])]);
  const f = fixture({ send: method => method === 'Page.captureScreenshot' ? { data: bytes.toString('base64') } : undefined });
  const result = await screenshot(f.entry, { maxSide: 480 });
  assert.equal(result.images, undefined);
  assert.match(result.note, /Screenshot skipped/);
  assert.equal(f.calls.at(-1).method, 'detach');
});

test('FD1 protected fields suppress capture before pixels are acquired', async () => {
  const f = fixture({ type: 'password' }), result = await screenshot(f.entry);
  assert.equal(result.images, undefined); assert.match(result.note, /protected fields/);
  assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 0);
  assert.equal(f.calls.at(-1).method, 'detach');
});

for (const fail of ['Debugger.enable', 'Debugger.pause', 'DOMSnapshot.captureSnapshot', 'Accessibility.getFullAXTree', 'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Debugger.disable'])
  test('FD1 failed ' + fail + ' discards pixels, scrubs errors and collects its session', async () => {
    const f = fixture({ fail }), result = await screenshot(f.entry);
    assert.equal(result.images, undefined); assert.match(result.note, /Screenshot skipped/);
    assert.doesNotMatch(result.note, /private fixture/); assert.equal(f.calls.at(-1).method, 'detach');
    if (fail === 'Debugger.disable') assert.match(result.note, /cleanup unconfirmed/);
  });

for (const event of ['framenavigated', 'frameattached', 'framedetached', 'dialog', 'close'])
  test('FD1 ' + event + ' during capture discards the result', async () => {
    const f = fixture({ after: page => page.emit(event) }), result = await screenshot(f.entry);
    assert.equal(result.images, undefined); assert.match(result.note, /skipped/);
    assert.equal(f.calls.at(-1).method, 'detach');
  });

test('FD1 pending input, dialogs, app windows, closed or blocked tabs never acquire pixels', async () => {
  for (const change of [entry => { entry.state.actionPending = true; }, entry => { entry.state.dialog = {}; },
    entry => { entry.window = { id: 1 }; }, entry => { entry.closed = true; }, entry => { entry.blocked = true; }]) {
    const f = fixture(); change(f.entry);
    assert.equal((await screenshot(f.entry)).images, undefined);
    assert.equal(f.calls.length, 0);
  }
});

test('FD1 revocation or a site block arriving with the pixels suppresses them', async () => {
  for (const key of ['current', 'allowed']) {
    let valid = true;
    const f = fixture({ after: () => { valid = false; } });
    assert.equal((await screenshot(f.entry, { [key]: () => valid })).images, undefined);
    assert.equal(f.calls.at(-1).method, 'detach');
  }
});

test('FD1 screenshot failure preserves sent action outcomes and leaves the next read text-only', async () => {
  const f = fixture(); let attempts = 0;
  const dispatcher = createToolDispatcher({ pages: { enqueue: async (_id, run) => run(f.entry) },
    snapshot: async () => ({ text: 'page', number: 2 }), runSteps: async () => ({ lines: ['1 hover e1: input sent'], observe: { text: 'diff', number: 1 } }),
    fillFields: async () => ({}), captureImage: async () => { attempts++; throw Error('private capture detail'); } });
  const result = await dispatcher.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'hover', ref: 'e1' }], observe: 'screenshot' } });
  assert.equal(result.isError, false); assert.match(result.text, /input sent.*diff.*Screenshot skipped/s);
  assert.doesNotMatch(result.text, /private capture/);
  const next = await dispatcher.call({ name: 'browser_read', arguments: { tab: 't1' } });
  assert.equal(next.images, undefined); assert.equal(attempts, 1);
});

test('FD1 read images do not grant refs until the exact text and image payload are delivered', async () => {
  const f = fixture();
  const dispatcher = createToolDispatcher({ pages: { enqueue: async (_id, run) => run(f.entry) },
    snapshot: async () => ({ text: 'page', number: 2 }), runSteps: async () => ({}), fillFields: async () => ({}),
    captureImage: async () => ({ note: 'Screenshot 1x1 px (untrusted page image).', images: [image(1, 1)] }) });
  const call = () => dispatcher.call({ name: 'browser_read', arguments: { tab: 't1', screenshot: true } });
  const modified = await call(); modified.images[0].data = jpeg(2, 2);
  assert.equal(dispatcher.delivered(modified), false); assert.equal(f.entry.state.snapshotNo, 0);
  const exact = await call(); assert.equal(dispatcher.delivered(exact), true); assert.equal(f.entry.state.snapshotNo, 2);
});
