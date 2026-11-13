import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sourceURL, replaceSite } from './fixtures/browser-geometry.mjs';
const observation = await import(process.env.GP3B_VARIANT === 'projection-without-watcher' ? sourceURL('direct-browser/geometry-observation.mjs', source => {
  source = replaceSite(source, 'const state = pages.get(page);\n  if (!state?.listeners.size) return;', 'const state = stateOf(page);');
  source = replaceSite(source, 'if (!batch || !batch.state.listeners.size) return;', 'if (!batch) return;');
  return replaceSite(source, 'if (!batch.state.listeners.size || !current(batch)', 'if (!current(batch)');
}) : new URL('../plugins/sleight/lib/direct-browser/geometry-observation.mjs', import.meta.url).href);

function pageFixture({ watch = true } = {}) {
  const page = new EventEmitter(), frame = {}, connection = { toImpl: item => item === page ? target : item === frame ? frameImpl : null };
  const target = { delegate: { _targetId: 'target' } }, frameImpl = { _id: 'frame', _page: target };
  frame._connection = connection; frame.isDetached = () => false;
  if (watch) observation.watchBrowserLayout(page, () => {});
  page._connection = connection; page.mainFrame = () => frame; page.frames = () => [frame]; page.isClosed = () => false;
  return { page, frame, connection, target, frameImpl };
}
function nativeCapture({ id = 11, text = 'Save', x = 10.25, y = 20.5 } = {}) {
  return { strings: ['frame', '#document', 'HTML', 'BUTTON', '#text', '', text], documents: [{ frameId: 0,
    scrollOffsetX: 0, scrollOffsetY: 0,
    nodes: { nodeType: [9, 1, 1, 3], nodeName: [1, 2, 3, 4], nodeValue: [5, 5, 5, 6],
      backendNodeId: [1, 2, id, id + 1], parentIndex: [-1, 0, 1, 2], attributes: [[], [], [], []] },
    layout: { nodeIndex: [1, 2, 3], bounds: [[0, 0, 800, 1200], [x, y, 90.5, 30.25], [x + 3, y + 2, 50, 20]], styles: [[], [], []] },
  }] };
}
function acquired(f, capture = nativeCapture()) {
  const batch = observation.beginBrowserLayout(f.page);
  const start = performance.now();
  observation.recordBrowserLayout(batch, f.frame, capture, start, performance.now());
  return observation.finishBrowserLayout(batch);
}
function evidence(f, capture) {
  return { capture, connection: f.connection, target: f.target, frameId: 'frame', document: 1,
    pid: 42, windowId: 7, processStart: 'process-1', bounds: [100, 100, 900, 800],
    viewport: [0, 0, 800, 700], origin: [100, 200], pageZoom: 1, visualZoom: 1, deviceScale: 2,
    scale: 1, continuous: true };
}
function reference(f, capture) {
  return observation.retainLayoutNode(capture, { connection: f.connection, target: f.target, frame: f.frameImpl,
    frameId: 'frame', document: 1, backendNodeId: 11 });
}

test('native layout maps a held node outward and never accepts a predictive locator box', () => {
  const f = pageFixture(), capture = acquired(f), held = reference(f, capture);
  assert.ok(held);
  const map = observation.mapBrowserLayout(capture, [{ seq: 9, held }], evidence(f, capture));
  assert.deepEqual(map.references, [{ seq: 9, rects: [[110, 220, 91, 31]], departed: false }]);
  assert.equal(observation.mapBrowserLayout(capture, [{ seq: 9, held: { box: [1, 2, 3, 4] } }], evidence(f, capture)), undefined);
});

test('Chromium empty string sentinels preserve the native document identity', () => {
  const f = pageFixture(), raw = nativeCapture(); raw.documents[0].nodes.nodeValue = [-1, -1, -1, 6];
  const capture = acquired(f, raw); assert.ok(capture); assert.ok(reference(f, capture));
});

test('same-label replacement and recycled node contents refuse the whole map', () => {
  const f = pageFixture(), first = acquired(f), held = reference(f, first);
  for (const capture of [acquired(f, nativeCapture({ id: 21 })), acquired(f, nativeCapture({ text: 'Delete' }))])
    assert.equal(observation.mapBrowserLayout(capture, [{ seq: 9, held }], evidence(f, capture)), undefined);
});

test('a missing transform, mixed generation and wrong native window refuse', () => {
  const f = pageFixture(), capture = acquired(f), held = reference(f, capture), proof = evidence(f, capture);
  assert.equal(observation.mapBrowserLayout(capture, [{ seq: 9, held }], null), undefined);
  assert.equal(observation.mapBrowserLayout(capture, [{ seq: 9, held }], { ...proof, capture: acquired(f) }), undefined);
  assert.equal(observation.mapBrowserLayout(capture, [{ seq: 9, held }], { ...proof, bounds: [9000, 9000, 900, 800] }), undefined);
});

test('scrolling uses native document coordinates and clips partial targets outward', () => {
  const f = pageFixture(), first = acquired(f), held = reference(f, first), raw = nativeCapture({ y: 55.5 });
  raw.documents[0].scrollOffsetY = 80;
  const capture = acquired(f, raw), proof = evidence(f, capture); proof.viewport = [0, 80, 800, 700];
  assert.deepEqual(observation.mapBrowserLayout(capture, [{ seq: 9, held }], proof).references,
    [{ seq: 9, rects: [[110, 200, 91, 6]], departed: false }]);
});

test('absence is unknown while a retained node wholly outside its viewport is departed', () => {
  const f = pageFixture(), first = acquired(f), held = reference(f, first), capture = acquired(f, nativeCapture({ y: 900 }));
  assert.deepEqual(observation.mapBrowserLayout(capture, [{ seq: 9, held }], evidence(f, capture)).references,
    [{ seq: 9, rects: [], departed: true }]);
});

test('navigation, frame-chain gaps and a different connection do not continue a held node', () => {
  const f = pageFixture(), first = acquired(f), held = reference(f, first);
  f.page.emit('framenavigated', f.frame);
  const capture = acquired(f);
  assert.equal(observation.mapBrowserLayout(capture, [{ seq: 9, held }], evidence(f, capture)), undefined);
  const other = pageFixture(), second = acquired(other);
  assert.equal(observation.mapBrowserLayout(second, [{ seq: 9, held }], evidence(other, second)), undefined);
  const child = {}; f.page.frames = () => [f.frame, child];
  const multiple = acquired(f);
  assert.equal(observation.mapBrowserLayout(multiple, [], evidence(f, multiple)), undefined);
});

test('a navigation or mixed batch during capture never replaces the last complete observation', () => {
  const f = pageFixture(), first = acquired(f), batch = observation.beginBrowserLayout(f.page), start = performance.now();
  observation.recordBrowserLayout(batch, f.frame, nativeCapture(), start, performance.now());
  f.page.emit('framenavigated', f.frame);
  assert.equal(observation.finishBrowserLayout(batch), undefined);
  assert.notEqual(observation.latestBrowserLayout(f.page), first);
});

test('native metadata is copied privately with original acquisition time and bounded inventories', () => {
  const f = pageFixture(), raw = nativeCapture(), capture = acquired(f, raw), held = reference(f, capture);
  const interval = observation.browserLayoutInterval(capture);
  raw.strings[6] = 'Delete'; raw.documents[0].layout.bounds[1][0] = 999;
  assert.deepEqual(observation.mapBrowserLayout(capture, [{ seq: 9, held }], evidence(f, capture)).references[0].rects, [[110, 220, 91, 31]]);
  assert.deepEqual(observation.browserLayoutInterval(capture), interval, 'delivery does not refresh acquisition');
  assert.equal(observation.mapBrowserLayout(capture, Array.from({ length: 513 }, (_, seq) => ({ seq, held })), evidence(f, capture)), undefined);
  const huge = nativeCapture(); huge.documents[0].nodes.nodeType = Array(50001).fill(1);
  assert.equal(acquired(f, huge), undefined, 'node budget cannot produce a partial observation');
  const strings = nativeCapture(); strings.strings.push('x'.repeat(4 * 1024 * 1024));
  assert.equal(acquired(f, strings), undefined, 'string budget cannot produce a partial observation');
});

test('an external semantic dependency change vetoes continuity even when the held subtree is unchanged', () => {
  const f = pageFixture(), first = acquired(f), held = reference(f, first), next = nativeCapture();
  next.strings.push('aria-label', 'New document meaning'); next.documents[0].nodes.attributes[1] = [7, 8];
  const capture = acquired(f, next);
  assert.equal(observation.mapBrowserLayout(capture, [{ seq: 9, held }], evidence(f, capture)), undefined);
});

test('uncertain zoom and viewport offsets never manufacture a transform', () => {
  const f = pageFixture(), capture = acquired(f), held = reference(f, capture), proof = evidence(f, capture);
  for (const change of [{ scale: 1.25 }, { viewport: [0, 1, 800, 700] }, { deviceScale: undefined }, { continuous: false }])
    assert.equal(observation.mapBrowserLayout(capture, [{ seq: 9, held }], { ...proof, ...change }), undefined);
});

test('the native attribute budget is aggregate rather than multiplied by the node budget', () => {
  const f = pageFixture(), raw = nativeCapture(), n = raw.documents[0].nodes;
  const attrs = [];
  for (let i = 0; i < 1500; i++) { attrs.push(raw.strings.length, 6); raw.strings.push('data-' + i); }
  for (let i = 0; i < 100; i++) {
    n.nodeType.push(1); n.nodeName.push(3); n.nodeValue.push(-1); n.parentIndex.push(1);
    n.backendNodeId.push(2000 + i); n.attributes.push(attrs);
  }
  assert.equal(acquired(f, raw), undefined, 'aggregate attribute overflow must not retain a partial map');
});

test('reusing the same native read preserves its opaque identity and original interval', () => {
  const f = pageFixture(), raw = nativeCapture(), first = acquired(f, raw), before = observation.browserLayoutInterval(first);
  const second = acquired(f, raw);
  assert.equal(second, first, 'a reused native read must not mint a new observation identity');
  assert.deepEqual(observation.browserLayoutInterval(second), before);
});

test('no watcher does zero projection work and stopping the watcher drops its node map', () => {
  const f = pageFixture({ watch: false });
  const raw = new Proxy({}, { get() { throw Error('projection must not read any field'); } });
  assert.equal(observation.beginBrowserLayout(f.page), undefined);
  assert.doesNotThrow(() => observation.recordBrowserLayout(undefined, f.frame, raw, 0, 0));
  assert.equal(observation.latestBrowserLayout(f.page), undefined);
  const stop = observation.watchBrowserLayout(f.page, () => {});
  const capture = acquired(f); assert.ok(capture); assert.equal(observation.latestBrowserLayout(f.page), capture);
  const ticket = observation.beginBrowserLayout(f.page); assert.ok(ticket); stop();
  assert.doesNotThrow(() => observation.recordBrowserLayout(ticket, f.frame, raw, 0, 0));
  assert.equal(observation.finishBrowserLayout(ticket), undefined);
  assert.equal(observation.latestBrowserLayout(f.page), undefined);
  assert.equal(observation.beginBrowserLayout(f.page), undefined);
});
