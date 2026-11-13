import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { launchTestChromium, testChromiumExecutable } from './fixtures/chromium-isolated.mjs';
import { geometryModule, handHarness, trustedModule, trustedSourceURL, sourceURL, browserHandModule } from './fixtures/browser-geometry.mjs';
import { snapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import * as trusted from '../plugins/sleight/lib/direct-browser/trusted-dom.mjs';
import * as hand from '../plugins/sleight/lib/hand/browser-hand.mjs';

const geometry = await geometryModule();
const retention = await trustedModule();
const adapter = await browserHandModule({ trustedURL: trustedSourceURL() });
let browser;
describe('real browser geometry qualification', { skip: process.env.SLEIGHT_LIVE_DOM_TEST !== '1' &&
  'real-page qualification belongs to sleight-arch host runner' }, () => {
before(async () => {
  assert.equal(process.env.SLEIGHT_LIVE_DOM_TEST, '1', 'real-page geometry validation must run, never skip');
  browser = await launchTestChromium(chromium, { executablePath: testChromiumExecutable(), headless: true, args: ['--site-per-process'] });
});
after(async () => browser?.close());
async function fixture(t, html, { deviceScaleFactor = 1 } = {}) {
  const context = await browser.newContext({ viewport: { width: 800, height: 700 }, deviceScaleFactor });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<style>body{margin:0}button{position:absolute;left:10.25px;top:20.5px;width:90.5px;height:30.25px;padding:0;border:0}</style>' + html);
  const frame = page._connection.toImpl(page.mainFrame()), target = page._connection.toImpl(page);
  // The native Mac window and presentation witness are fixture inputs. The DOM,
  // utility realm, native IDs and all layout boxes come from actual Chromium.
  const source = capture => ({ capture, connection: page._connection, target, frameId: frame._id, document: identity?.document,
    pid: 42, windowId: 7, processStart: 'headless-window-fixture', bounds: [100, 100, 900, 1000], viewport: [0, scrollY, 800, 700],
    origin: [100, 200], pageZoom: 1, visualZoom: 1, deviceScale: deviceScaleFactor, scale: 1, continuous: true });
  let identity, held, scrollY = 0, stop;
  const stopWatch = () => { stop?.(); stop = undefined; };
  t.after(stopWatch);
  const read = async () => {
    stop ??= geometry.watchBrowserLayout(page, () => {});
    // The tap is exercised independently when testing source mutations, too.
    const batch = geometry.beginBrowserLayout(page), cdp = await context.newCDPSession(page), start = performance.now();
    try {
      const capture = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
      if (process.env.GP3_DIAGNOSTIC === '1') t.diagnostic(JSON.stringify({ capture, target: target.delegate._targetId, frame: frame._id }));
      geometry.recordBrowserLayout(batch, page.mainFrame(), capture, start, performance.now());
      return geometry.finishBrowserLayout(batch);
    } finally { await cdp.detach(); }
  };
  const retain = async selector => {
    const handle = await page.locator(selector).elementHandle();
    t.after(() => handle.dispose().catch(() => {}));
    identity = await trusted.retainTrustedNode(handle); t.after(() => identity?.release());
    const first = await read();
    if (process.env.GP3_DIAGNOSTIC === '1') t.diagnostic(JSON.stringify({ observed: Boolean(first), identity: { frameId: identity.frameId,
      backendNodeId: identity.backendNodeId, document: identity.document }, frameMatch: identity.frame === frame, targetMatch: identity.target === target }));
    held = geometry.retainLayoutNode(first, identity); assert.ok(held, 'real native node is retained');
    return first;
  };
  const map = capture => geometry.mapBrowserLayout(capture, [{ seq: 9, held }], source(capture));
  return { page, frame, target, context, read, retain, map, source, stopWatch,
    setScroll: value => { scrollY = value; }, identity: () => identity, held: () => held };
}

test('real complete observation reaches GP1 capture and certify with native outward geometry', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'), h = await handHarness(t);
  assert.equal(typeof hand.createBrowserGeometryProducer, 'function');
  const producer = await hand.createBrowserGeometryProducer({ client: h.client, windowEvidence: f.source });
  t.after(() => producer.close());
  assert.ok(producer.beginTurn('a'.repeat(32))); h.ack();
  await f.retain('#target');
  f.stopWatch(); assert.ok(producer.watch(f.page));
  await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1, 'complete baseline is collected');
  const handle = await f.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  const held = await producer.hold(f.page, handle); assert.ok(held);
  const seq = producer.admit({ kind: 'click', pid: 42, windowId: 7, at: [150, 235], windowRect: [100, 100, 900, 1000] },
    { call: 'b'.repeat(32), action: 1, attempt: 1, ordinal: 1 }, { page: f.page, held });
  assert.ok(seq); h.ack();
  await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1, 'pending input must refuse a certificate');
  assert.ok(producer.inputFinished(seq));
  await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  const collected = h.frames().filter(row => row.op === 'certificate');
  assert.equal(collected.length, 2);
  assert.deepEqual(collected[1].geometry.references, [{ seq, rects: [[110, 220, 91, 31]], departed: false }]);
  assert.equal(producer.state.references, 1);
  assert.ok(producer.endTurn()); h.ack();
});

test('real MAIN-world getter attack cannot conceal recycled contents from native capture', async t => {
  const f = await fixture(t, '<button id="target">Save</button>');
  await f.retain('#target');
  await f.page.evaluate(() => {
    document.querySelector('button').firstChild.data = 'Delete account';
    Object.defineProperty(Node.prototype, 'textContent', { get: () => 'Save' });
    Element.prototype.getBoundingClientRect = () => ({ x: 10.25, y: 20.5, width: 90.5, height: 30.25 });
    Object.defineProperty(Window.prototype, 'screenX', { get: () => 99999 });
  });
  assert.equal(f.map(await f.read()), undefined, 'MAIN getters must not certify recycled content');
});

test('real same-label replacement never inherits a held node', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'); await f.retain('#target');
  await f.page.evaluate(() => { const el = document.querySelector('button'); el.replaceWith(el.cloneNode(true)); });
  assert.equal(f.map(await f.read()), undefined, 'same-label replacement must not certify');
});

test('real recycled node contents are a semantic veto', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'); await f.retain('#target');
  await f.page.evaluate(() => { document.querySelector('button').firstChild.data = 'Delete'; });
  assert.equal(f.map(await f.read()), undefined, 'recycled contents must not certify');
});

test('real CSSOM change maps the current capture instead of a retained box', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'); await f.retain('#target');
  await f.page.evaluate(() => { document.styleSheets[0].insertRule('button{left:180.5px;top:100.25px}', document.styleSheets[0].cssRules.length); });
  assert.deepEqual(f.map(await f.read()).references, [{ seq: 9, rects: [[280, 300, 91, 31]], departed: false }], 'CSSOM requires current layout');
});

test('real sticky scroll uses native sticky layout rather than a scroll delta', async t => {
  const f = await fixture(t, '<style>button{position:sticky;top:20px;left:10px}body{height:2400px}</style><button id="target">Save</button>');
  await f.retain('#target');
  await f.page.evaluate(() => scrollTo(0, 500)); f.setScroll(500);
  const mapped = f.map(await f.read());
  assert.equal(mapped.references[0].departed, false);
  assert.equal(mapped.references[0].rects[0][1], 220, 'sticky target remains at its native viewport position');
});

test('real nested scrolling maps the actual node and preserves conservative fragments', async t => {
  const f = await fixture(t, '<style>#scroller{position:absolute;top:150px;left:100px;width:200px;height:200px;overflow:auto}#inside{position:relative;height:1200px}button{top:180px;left:10px}</style><div id="scroller"><div id="inside"><button id="target">Save</button></div></div>');
  await f.retain('#target');
  await f.page.evaluate(() => { document.querySelector('#scroller').scrollTop = 100; });
  assert.equal(f.map(await f.read()).references[0].rects[0][1], 430, 'nested scrolling must use current native layout');
});

test('real partial clipping keeps an object whose centre is outside the viewport', async t => {
  const f = await fixture(t, '<style>button{top:-25px;left:10px}</style><button id="target">Save</button>');
  await f.retain('#target');
  const mapped = f.map(await f.read());
  assert.equal(mapped.references[0].departed, false, 'partly visible target must not certify departure');
  assert.equal(mapped.references[0].rects[0][1], 200);
  assert.ok(mapped.references[0].rects[0][3] >= 6);
});

test('real closed shadow root retains native identity and vetoes hidden content recycling', async t => {
  const f = await fixture(t, '<div id="host"></div>');
  const handle = await f.page.evaluateHandle(() => {
    const root = document.querySelector('#host').attachShadow({ mode: 'closed' });
    root.innerHTML = '<button>Save</button>'; window.fixtureButton = root.firstChild; return root.firstChild;
  });
  t.after(() => handle.dispose());
  const identity = await trusted.retainTrustedNode(handle); t.after(() => identity.release());
  const first = await f.read(), held = geometry.retainLayoutNode(first, identity); assert.ok(held);
  const source = capture => ({ ...f.source(capture), document: identity.document });
  assert.ok(geometry.mapBrowserLayout(first, [{ seq: 9, held }], source(first)));
  await f.page.evaluate(() => { window.fixtureButton.firstChild.data = 'Delete'; });
  const next = await f.read();
  assert.equal(geometry.mapBrowserLayout(next, [{ seq: 9, held }], source(next)), undefined, 'closed-root recycled contents must not certify');
});

test('real out-of-process iframe chain without a coherent transform refuses certification', async t => {
  const f = await fixture(t, '<button id="target">Save</button><iframe></iframe>');
  const html = await f.page.content();
  await f.page.route('http://127.0.0.1/geometry-main', route => route.fulfill({ contentType: 'text/html', body: html }));
  await f.page.goto('http://127.0.0.1/geometry-main');
  await f.page.route('http://127.0.0.2/geometry-child*', route => route.fulfill({ contentType: 'text/html', body: '<button>Child</button>' }));
  const navigated = f.page.waitForEvent('framenavigated', frame => frame.url().includes('geometry-child'));
  await f.page.evaluate(() => { document.querySelector('iframe').src = 'http://127.0.0.2/geometry-child?ready'; });
  await (await navigated).waitForLoadState();
  await f.retain('#target');
  const child = f.page.frames()[1], mainSession = f.target.delegate._sessionForFrame(f.frame);
  assert.notEqual(f.target.delegate._sessionForFrame(f.page._connection.toImpl(child)), mainSession, 'fixture must actually be OOPIF');
  assert.equal(f.map(await f.read()), undefined, 'unproved OOPIF frame chain must not certify');
});

test('real zoom projects native CSS bounds with the capture-bound scale', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'); await f.retain('#target');
  const cdp = await f.context.newCDPSession(f.page); t.after(() => cdp.detach().catch(() => {}));
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 });
  const metrics = await cdp.send('Page.getLayoutMetrics'); assert.equal(metrics.cssVisualViewport.scale, 1.25);
  const capture = await f.read(), proof = { ...f.source(capture), scale: 1.25, visualZoom: 1.25,
    viewport: [0, 0, metrics.cssVisualViewport.clientWidth, metrics.cssVisualViewport.clientHeight] };
  const mapped = geometry.mapBrowserLayout(capture, [{ seq: 9, held: f.held() }], proof);
  assert.deepEqual(mapped.references[0].rects, [[112, 225, 114, 39]], 'zoom must not certify an unscaled box');
});

test('real navigation never continues the old document even at identical labels and bounds', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'); await f.retain('#target');
  await f.page.goto('data:text/html,<style>body{margin:0}button{position:absolute;left:10.25px;top:20.5px;width:90.5px;height:30.25px;padding:0;border:0}</style><button id="target">Save</button>');
  const handle = await f.page.locator('button').elementHandle(); t.after(() => handle.dispose());
  const current = await trusted.retainTrustedNode(handle); t.after(() => current.release());
  const capture = await f.read();
  assert.equal(geometry.mapBrowserLayout(capture, [{ seq: 9, held: f.held() }], { ...f.source(capture), document: current.document }),
    undefined, 'a replaced document must not certify continuation');
});

test('real wrong native window and mixed capture generations refuse', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'); await f.retain('#target');
  const capture = await f.read(), proof = f.source(capture);
  assert.equal(geometry.mapBrowserLayout(capture, [{ seq: 9, held: f.held() }], { ...proof, bounds: [9000, 9000, 900, 1000] }),
    undefined, 'wrong native window must not certify');
  assert.equal(geometry.mapBrowserLayout(capture, [{ seq: 9, held: f.held() }], { ...proof, capture: await f.read() }),
    undefined, 'mixed capture generations must not certify');
});

test('real normal snapshot has no projection without a watcher and its full CDP list matches the base', async t => {
  assert.notEqual(process.env.SLEIGHT_POINT_INPUT, '1', 'this census measures normal snapshots');
  const f = await fixture(t, '<button id="target">Save</button>');
  await snapshot(f.page);
  const connection = browser._connection.toImpl(browser)._connection, rawSend = connection._rawSend;
  const methods = [];
  connection._rawSend = function(session, method, params) { methods.push(method); return rawSend.call(this, session, method, params); };
  t.after(() => { connection._rawSend = rawSend; });
  const result = await snapshot(f.page);
  assert.equal(geometry.latestBrowserLayout(f.page), undefined, 'ordinary snapshots retain no node map');
  assert.ok(result.text.includes('Save'));
  assert.equal(methods.filter(method => method === 'DOMSnapshot.captureSnapshot').length, 1);
  assert.equal(methods.filter(method => method === 'Page.getLayoutMetrics').length, 1);
  const ordinary = methods.splice(0);
  const stop = geometry.watchBrowserLayout(f.page, () => {}); t.after(stop);
  await snapshot(f.page); assert.ok(geometry.latestBrowserLayout(f.page));
  const watched = methods.splice(0);
  assert.deepEqual(watched.slice().sort(), ordinary.slice().sort(), 'watching changes no CDP method or count');
  // Pinned vendor census includes utility calls and attach/detach. The ordinary
  // snapshot and watched snapshot must keep the same complete method multiset.
  const base = ['Runtime.callFunctionOn', 'Runtime.callFunctionOn', 'Runtime.callFunctionOn', 'Runtime.callFunctionOn',
    'Target.attachToTarget', 'DOMSnapshot.captureSnapshot', 'Runtime.releaseObject', 'Page.getLayoutMetrics',
    'Runtime.runIfWaitingForDebugger', 'Target.detachFromTarget'];

  assert.deepEqual(ordinary.slice().sort(), base.slice().sort(), 'full normal snapshot method multiset matches GP1');
  t.diagnostic('snapshot full CDP method lists ' + JSON.stringify({ ordinary, watched, base }));
});

test('real missing native transform and same-bounds window substitution collect zero target certificates', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'), h = await handHarness(t);
  let enabled = false, windowId = 7;
  const producer = await hand.createBrowserGeometryProducer({ client: h.client,
    windowEvidence: capture => enabled ? { ...f.source(capture), windowId } : undefined });
  t.after(() => producer.close());
  assert.ok(producer.beginTurn('a'.repeat(32))); h.ack();
  await f.retain('#target'); f.stopWatch(); producer.watch(f.page);
  await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 0, 'missing transform produces no certificate');
  enabled = true; await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1);
  const handle = await f.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  const held = await producer.hold(f.page, handle); assert.ok(held);
  const seq = producer.admit({ kind: 'click', pid: 42, windowId: 7, at: [150, 235] },
    { call: 'b'.repeat(32), action: 1, attempt: 1, ordinal: 1 }, { page: f.page, held }); h.ack();
  producer.inputFinished(seq); windowId = 8;
  await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1, 'same-bounds wrong native window must not certify');
  assert.equal(h.channel.state.poisoned, false, 'an incomplete observation declines before transport');
});

test('real held drag endpoints cannot certify an unknown carried envelope', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'), h = await handHarness(t);
  const producer = await hand.createBrowserGeometryProducer({ client: h.client, windowEvidence: f.source });
  t.after(() => producer.close());
  producer.beginTurn('a'.repeat(32)); h.ack(); await f.retain('#target'); f.stopWatch(); producer.watch(f.page);
  await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  const handle = await f.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  const held = await producer.hold(f.page, handle); assert.ok(held);
  const seq = producer.admit({ kind: 'drag', pid: 42, windowId: 7, at: [150, 235], path: [[150, 235], [500, 600]] },
    { call: 'b'.repeat(32), action: 1, attempt: 1, ordinal: 1 }, { page: f.page, held }); h.ack();
  producer.inputFinished(seq); await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  assert.equal(h.frames().filter(row => row.op === 'certificate').length, 1, 'a held endpoint never certifies the drag envelope');
  assert.equal(producer.state.references, 1, 'the drag obligation remains outstanding');
});

test('real forged MAIN getters installed before retention and hold never supply native identity', async t => {
  const f = await fixture(t, '<button id="target">Save</button>'), h = await handHarness(t);
  await f.page.evaluate(() => {
    const target = document.querySelector('#target'), fake = document.implementation.createHTMLDocument('forged');
    window.forgedReads = { owner: 0, text: 0, target: 0 };
    Object.defineProperty(Node.prototype, 'ownerDocument', { get() { window.forgedReads.owner++; return fake; } });
    Object.defineProperty(Node.prototype, 'textContent', { get() { window.forgedReads.text++; return 'Forged'; } });
    Object.defineProperty(target, 'ownerDocument', { get() { window.forgedReads.target++; return fake; } });
  });
  const handle = await f.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  await f.page.evaluate(() => { window.forgedReads = { owner: 0, text: 0, target: 0 }; });
  const identity = await retention.retainTrustedNode(handle); t.after(() => identity.release());
  assert.equal(await f.page.evaluate(() => window.forgedReads.owner + window.forgedReads.target), 0, 'retention reads no MAIN identity getter');
  const first = await f.retain('#target');
  assert.equal(identity.document, f.identity().document, 'native owner document ignores all forged MAIN getters');
  assert.ok(geometry.retainLayoutNode(first, identity));
  const producer = await adapter.createBrowserGeometryProducer({ client: h.client, windowEvidence: f.source });
  t.after(() => producer.close()); producer.beginTurn('a'.repeat(32)); h.ack(); f.stopWatch(); producer.watch(f.page);
  await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  await f.page.evaluate(() => { window.forgedReads = { owner: 0, text: 0, target: 0 }; });
  const held = await producer.hold(f.page, handle); assert.ok(held, 'pre-retention forgery cannot suppress the held row');
  assert.equal(await f.page.evaluate(() => window.forgedReads.owner + window.forgedReads.target), 0, 'hold reads no MAIN identity getter');
  const seq = producer.admit({ kind: 'click', pid: 42, windowId: 7, at: [150, 235] },
    { call: 'b'.repeat(32), action: 1, attempt: 1, ordinal: 1 }, { page: f.page, held });
  h.ack(); producer.inputFinished(seq);
  await producer.acquire(f.page, () => snapshot(f.page)); h.ack();
  assert.deepEqual(h.frames().filter(row => row.op === 'certificate').at(-1).geometry.references,
    [{ seq, rects: [[110, 220, 91, 31]], departed: false }], 'the real row is collected');
  const reads = await f.page.evaluate(() => window.forgedReads);
  assert.equal(reads.owner + reads.target, 0, 'snapshot cannot replace the native document identity');
});

test('real DPR 2 native layout bounds are CSS pixels and map to the same screen rectangle', async t => {
  const f = await fixture(t, '<button id="target">Save</button>', { deviceScaleFactor: 2 });
  assert.equal(await f.page.evaluate(() => devicePixelRatio), 2);
  const first = await f.retain('#target');
  assert.deepEqual(f.map(first).references, [{ seq: 9, rects: [[110, 220, 91, 31]], departed: false }]);
  const cdp = await f.context.newCDPSession(f.page); t.after(() => cdp.detach().catch(() => {}));
  const raw = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
  const doc = raw.documents[0], index = doc.nodes.backendNodeId.indexOf(f.identity().backendNodeId);
  assert.deepEqual(doc.layout.bounds[doc.layout.nodeIndex.indexOf(index)], [10.25, 20.5, 90.5, 30.25],
    'CDP layout bounds stay in CSS pixels at DPR 2');
});

test('a concurrent real snapshot refuses state.busy and the first read releases it', async t => {
  const f = await fixture(t, '<button id="target">Save</button>');
  const concurrent = await import(sourceURL('direct-browser/snapshot.mjs', source => {
    if (process.env.GP3B_VARIANT === 'concurrent-read-without-busy') {
      source = source.replace('state?.busy || state?.keyboardTasks.size', 'state?.keyboardTasks.size');
      source = source.replace("if (state.busy) throw Error('Snapshot read in progress; try browser_read again.');", '');
    }
    return source + '\nexport const testBusyState = page => stateOf(page);\n';
  }));
  const original = f.page.ariaSnapshotJSON.bind(f.page);
  let entered, release, second, failure;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.page.ariaSnapshotJSON = async (...args) => { entered(); await gate; return original(...args); };
  const first = concurrent.snapshot(f.page);
  try {
    await ready;
    const state = concurrent.testBusyState(f.page);
    for (let i = 0; i < 1000 && state.keyboardTasks.size; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.keyboardTasks.size, 0); assert.equal(state.busy, true, 'only busy still owns this read');
    second = concurrent.snapshot(f.page); second.catch(error => { failure = error; });
    for (let i = 0; i < 100 && !failure; i++) await new Promise(resolve => setImmediate(resolve));
    assert.match(failure?.message ?? '', /Snapshot acquisition is still pending/, 'busy must refuse the concurrent read before the first is released');
  } finally { release(); await Promise.allSettled([first, second]); f.page.ariaSnapshotJSON = original; }
  assert.ok((await concurrent.snapshot(f.page)).text.includes('Save'), 'the failed concurrent read cannot retain busy ownership');
});

});
