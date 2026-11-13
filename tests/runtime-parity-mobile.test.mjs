import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { REPL_NODE_UNSUPPORTED } from '../plugins/sleight/lib/repl/client.mjs';

const worker = { skip: !process.allowedNodeEnvironmentFlags.has('--allow-net') && REPL_NODE_UNSUPPORTED, timeout: 15000 };
const mobile = { ...worker, skip: process.platform !== 'darwin' || worker.skip };
const textOf = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
function png(tag) {
  // Encoded-size fixture only. No decoder, screen capture or image tool runs.
  const bytes = Buffer.alloc(40);
  bytes.writeUInt32BE(0x89504e47, 0); bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(400, 16); bytes.writeUInt32BE(1000, 20); bytes.write(tag, 24);
  return bytes.toString('base64');
}

function fixture(t, appName, { fakeInput = false, contentTree = false, moving = false } = {}) {
  const bundleId = { 'iPhone Mirroring': 'com.apple.ScreenContinuity', Simulator: 'com.apple.iphonesimulator' }[appName] ?? 'test.canvas';
  const window = { windowId: '77', pid: 42, processStart: '1.2', bundleId, app: appName,
    title: 'Phone', identityVerified: true, onScreen: true, bounds: { x: 50, y: 80, width: 400, height: 1000 } };
  const tree = `Window: "Phone", App: ${appName}.\n0 standard window Phone\n1 menu bar\n\t2 File` +
    (contentTree ? '\n3 button Content' : '');
  let readId = 0, sequence = 0, buffer = '', closed = false;
  const requests = [], attempted = [], sent = [], traces = [], frames = [], captures = [], pending = new Map();
  const driver = { async request(method, params) {
    requests.push({ method, params: structuredClone(params) });
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: appName, pid: 42, processStart: '1.2' }, windows: [window] };
    if (method === 'verifyWindowIdentity') return { window };
    if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
    if (method === 'getAXState') return { window, text: tree, readId: ++readId, truncated: false };
    if (method === 'getScreenshot' || method === 'getAXStateAndScreenshot') {
      const data = frames.shift() ?? png(moving ? String(captures.length) : 'before'); captures.push(data);
      return { window, ...(method === 'getAXStateAndScreenshot' ? { text: tree, readId: ++readId, truncated: false } : {}),
        capture: { note: 'Screenshot frame: 400x1000 pixels; window bounds (50, 80, 400, 1000) points; scale 1x1 pixels per point; origin top-left; window-only, overlays excluded.' },
        screenshot: { data, mimeType: 'image/png' } };
    }
    if (fakeInput && ['drag', 'scroll', 'click', 'typeText'].includes(method))
      return { window, delivery: 'sent-unverified', retry: 'read-first' };
    assert.fail('unexpected fake driver operation: ' + method);
  }, async close() {}, async restart() {} };
  const permissions = { app() {}, page() {}, sitesLimited: () => false };
  const runtime = createOwnRuntime({ driver, lease: { acquire: () => 'fixture', grant: () => ({ token: 'fixture-token' }),
    renewGrant() {}, renew() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), permissions,
    targetParents: () => [1], ancestry: () => [{ pid: 900, path: '/fixture/Host' }], replOptions: { environment: () => ({}) } });
  const request = runtime.safety.request;
  runtime.safety.request = (method, params, context) => {
    attempted.push(method);
    // This seam permits input ONLY to the fake driver, to test the shared relay
    // adaptations independently of the preview's deliberate input refusal.
    if (fakeInput && ['drag', 'scroll', 'click', 'typeText'].includes(method)) {
      context.beforeRequest?.();
      return driver.request(method, params);
    }
    return request(method, params, context);
  };
  const input = new PassThrough(), output = new PassThrough();
  let time = 0;
  const transport = runtime.createTransport(output);
  const relay = createRelay({ clientIn: input, clientOut: transport.clientOut, serverIn: runtime.serverIn, serverOut: runtime.serverOut,
    nativeMac: true, nativeSession: transport.nativeSession, documentationTrust: runtime.documentationTrust,
    permissions, ownHostPid: () => false, changeReview: false, warmRepl: false, warmEngine: false,
    simFocusNote: false, idleTurnEndMs: 0, now: () => time, chromeSettleSleep: async ms => { time += ms; },
    trace: (direction, message) => traces.push([direction, message]) });
  runtime.serverIn.on('data', bytes => {
    for (const line of String(bytes).split('\n').filter(Boolean)) sent.push(JSON.parse(line));
  });
  output.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      const waiting = pending.get(message.id);
      if (waiting) { clearTimeout(waiting.timer); pending.delete(message.id); waiting.resolve(message.result); }
    }
  });
  t.after(async () => {
    closed = true;
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(Error('fixture closed')); }
    await relay.close(); await runtime.close(); transport.close(); input.destroy(); output.destroy();
  });
  const js = code => new Promise((resolve, reject) => {
    assert.equal(closed, false);
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('offline runtime call timed out: ' + code)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  });
  return { js, requests, attempted, sent, traces, frames, captures, tree, window };
}

async function acquire(f, name) {
  let result = await f.js(`let app = await cua.getApp(${JSON.stringify(name)});`);
  assert.equal(result.isError, false, textOf(result));
  result = await f.js('await app.getAXStateAndScreenshot();');
  assert.equal(result.isError, false, textOf(result));
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
}

for (const name of ['iPhone Mirroring', 'Simulator']) {
  test(`row 34: ${name} production preview refuses scrolling before the helper`, worker, async t => {
    const f = fixture(t, name); await acquire(f, name);
    const result = await f.js('await app.scroll([200, 500], "down", 0.5);');
    assert.equal(result.isError, true); assert.match(textOf(result), /METHOD_NOT_FOUND/);
    assert.ok(['scroll', 'drag'].includes(f.attempted.at(-1)));
    assert.equal(f.requests.some(request => ['scroll', 'drag'].includes(request.method)), false);
    assert.equal(f.traces.some(([direction]) => direction === 'chrome-settle'), false);
  });
  test(`row 34: ${name} runtime converts a scroll to a swipe`,
    mobile, async t => {
    const f = fixture(t, name, { fakeInput: true }); await acquire(f, name);
    f.frames.push(png('moving'), png('still'), png('still'));
    const result = await f.js('await app.scroll([200, 500], "down", 0.5); await app.getAXStateAndScreenshot();');
    assert.equal(result.isError, false, textOf(result));
    const actions = f.requests.filter(request => ['scroll', 'drag'].includes(request.method));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].params.windowId, '77'); assert.equal(actions[0].params.processStart, '1.2');
    assert.ok(Number.isSafeInteger(actions[0].params.readId));
    assert.deepEqual(actions.map(request => [request.method, request.params.args]), [['drag', [[200, 687.5], [200, 362.5]]]]);
  });
  test(`row 34: ${name} runtime reaches relay settle and requires two matching screenshots`, worker, async t => {
    const f = fixture(t, name, { fakeInput: true }); await acquire(f, name);
    f.frames.push(png('moving'), png('still'), png('still'));
    const result = await f.js('await app.click([200, 500]); await app.getAXStateAndScreenshot();');
    assert.equal(result.isError, false, textOf(result));
    assert.ok(result.content.some(item => item.type === 'image' && item.data === png('still')));
    const settle = f.traces.filter(([direction]) => direction === 'chrome-settle');
    assert.equal(settle.length, 1); assert.equal(settle[0][1].matched, true); assert.equal(settle[0][1].shots, 3);
    assert.deepEqual(f.captures.slice(-3), [png('moving'), png('still'), png('still')]);
    assert.equal(f.sent.filter(message => String(message.id).startsWith('sleight-chrome-settle-')).length, 2);
  });
  test(`row 34: ${name} runtime delivers only the settled frame`,
    mobile, async t => {
      const f = fixture(t, name, { fakeInput: true }); await acquire(f, name);
      f.frames.push(png('moving'), png('still'), png('still'));
      const result = await f.js('await app.click([200, 500]); await app.getAXStateAndScreenshot();');
      assert.equal(result.isError, false, textOf(result));
      const settle = f.traces.filter(([direction]) => direction === 'chrome-settle');
      assert.equal(settle.length, 1); assert.equal(settle[0][1].matched, true); assert.equal(settle[0][1].shots, 3);
      assert.deepEqual(f.captures.slice(-3), [png('moving'), png('still'), png('still')]);
      const images = result.content.filter(item => item.type === 'image').map(item => item.data);
      assert.deepEqual(images, [png('still')]);
    });
}

for (const [direction, distance, from, to] of [
    ['up', '1', [200, 200], [200, 850]],
    ['left', '0.5', [135, 525], [265, 525]],
    ['right', '{ pixels: 100 }', [250, 525], [150, 525]],
    ['down', '100', [200, 850], [200, 200]],
    ['left', '{ pixels: 100000 }', [70, 525], [330, 525]],
]) test(`row 34: runtime ${direction} swipe retains the relay geometry for ${distance}`,
  mobile, async t => {
    const f = fixture(t, 'Simulator', { fakeInput: true }); await acquire(f, 'Simulator');
    const result = await f.js(`await app.scroll([200, 500], ${JSON.stringify(direction)}, ${distance}); void 0;`);
    assert.equal(result.isError, false, textOf(result));
    const actions = f.requests.filter(request => ['drag', 'scroll'].includes(request.method));
    assert.equal(actions.length, 1);
    const action = actions[0];
    assert.equal(action.params.windowId, '77'); assert.equal(action.params.processStart, '1.2');
    assert.ok(Number.isSafeInteger(action.params.readId));
    assert.equal(action.method, 'drag'); assert.deepEqual(action.params.args, [from, to]);
    assert.equal(f.requests.some(request => request.method === 'scroll'), false);
});

test('row 34: a Simulator tree with real content keeps native scrolling', worker, async t => {
  const f = fixture(t, 'Simulator', { fakeInput: true, contentTree: true }); await acquire(f, 'Simulator');
  const result = await f.js('await app.scroll([200, 500], "down", 0.5); void 0;');
  assert.equal(result.isError, false, textOf(result));
  assert.deepEqual(f.requests.filter(request => ['drag', 'scroll'].includes(request.method)).map(request =>
    [request.method, request.params.args]), [['scroll', [[200, 500], 'down', 0.5]]]);
});

test('row 34: a non-mobile chrome-only app keeps native scrolling', worker, async t => {
  const f = fixture(t, 'Canvas phone', { fakeInput: true }); await acquire(f, 'Canvas phone');
  const result = await f.js('await app.scroll([200, 500], "down", 0.5); void 0;');
  assert.equal(result.isError, false, textOf(result));
  assert.deepEqual(f.requests.filter(request => ['scroll', 'drag'].includes(request.method)).map(request =>
    [request.method, request.params.args]), [['scroll', [[200, 500], 'down', 0.5]]]);
});

for (const name of ['iPhone Mirroring', 'Simulator']) {
  test(`row 34: ${name} stops at the first stable pair after 100 ms`, mobile, async t => {
    const f = fixture(t, name, { fakeInput: true }); await acquire(f, name);
    f.frames.push(png('still'), png('still'), png('unused'));
    const result = await f.js('await app.click([200, 500]); await app.getAXStateAndScreenshot();');
    assert.equal(result.isError, false, textOf(result));
    const settle = f.traces.filter(([direction]) => direction === 'chrome-settle');
    assert.equal(settle.length, 1);
    assert.deepEqual([settle[0][1].matched, settle[0][1].shots, settle[0][1].waitedMs], [true, 2, 100]);
    assert.deepEqual(result.content.filter(item => item.type === 'image').map(item => item.data), [png('still')]);
    assert.deepEqual(f.frames, [png('unused')]);
  });

  test(`row 34: ${name} moving frames stop at the relay's 1500 ms limit`, mobile, async t => {
    const f = fixture(t, name, { fakeInput: true, moving: true }); await acquire(f, name);
    const result = await f.js('await app.click([200, 500]); await app.getAXStateAndScreenshot();');
    assert.equal(result.isError, false, textOf(result));
    const settle = f.traces.filter(([direction]) => direction === 'chrome-settle');
    assert.equal(settle.length, 1);
    assert.deepEqual([settle[0][1].matched, settle[0][1].shots, settle[0][1].waitedMs], [false, 15, 1500]);
    assert.deepEqual(result.content.filter(item => item.type === 'image').map(item => item.data), [f.captures.at(-1)]);
  });
}

test('row 34: numeric scroll targets still pass through the retained-number guard', mobile, async t => {
  const f = fixture(t, 'Simulator', { fakeInput: true }); await acquire(f, 'Simulator');
  const result = await f.js('await app.scroll(999, "down", 0.5); void 0;');
  assert.equal(result.isError, true); assert.match(textOf(result), /STALE_READ/);
  assert.equal(f.requests.some(request => ['scroll', 'drag'].includes(request.method)), false);
});

test('row 34: without a parent screenshot mobile scrolling stays on the normal path', mobile, async t => {
  const f = fixture(t, 'Simulator', { fakeInput: true });
  assert.equal((await f.js('let app = await cua.getApp("Simulator");')).isError, false);
  const result = await f.js('await app.scroll([200, 500], "down", 0.5); void 0;');
  assert.equal(result.isError, false, textOf(result));
  assert.deepEqual(f.requests.filter(request => ['scroll', 'drag'].includes(request.method)).map(request => request.method), ['scroll']);
});
