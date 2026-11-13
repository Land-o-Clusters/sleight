import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileScroll, replacedMobileImage } from '../plugins/sleight/lib/mac-driver/mobile.mjs';

const window = { windowId: '77', pid: 42, processStart: '1.2', bundleId: 'com.apple.iphonesimulator',
  app: 'Simulator', title: 'Phone', identityVerified: true, bounds: { x: 50, y: 80, width: 400, height: 1000 } };
const tree = 'Window: "Phone", App: Simulator.\n0 standard window Phone\n1 menu bar\n\t2 File';
const params = { windowId: '77', processStart: '1.2', readId: 1, args: [[200, 500], 'down', 0.5] };
function shot() {
  const bytes = Buffer.alloc(40);
  bytes.writeUInt32BE(0x89504e47, 0); bytes.writeUInt32BE(400, 16); bytes.writeUInt32BE(1000, 20);
  return { window: structuredClone(window), text: tree,
    capture: { note: 'Screenshot frame: 400x1000 pixels; window bounds (50, 80, 400, 1000) points; scale 1x1 pixels per point; origin top-left; window-only, overlays excluded.' },
    screenshot: { data: bytes.toString('base64'), mimeType: 'image/png' } };
}

test('a capture refusal clears previous mobile dimensions before another scroll', () => {
  const mobile = createMobileScroll(); mobile.observe(shot());
  mobile.observe({ window, capture: { note: 'Screen recording unavailable' } });
  assert.equal(mobile.request('scroll', params, window, tree).method, 'scroll');
});

for (const [name, change] of [
  ['window number', w => { w.windowId = '78'; }], ['process start', w => { w.processStart = '2.3'; }],
  ['pid', w => { w.pid = 43; }], ['bundle', w => { w.bundleId = 'test.canvas'; }],
  ['title', w => { w.title = 'Other phone'; }], ['bounds', w => { w.bounds.width = 500; }],
]) test(`mobile dimensions never cross a changed ${name}`, () => {
  const mobile = createMobileScroll(); mobile.observe(shot());
  const changed = structuredClone(window); change(changed);
  const binding = { ...params, windowId: changed.windowId, processStart: changed.processStart };
  assert.equal(mobile.request('scroll', binding, changed, tree).method, 'scroll');
});

for (const distance of [0, -1, 101, Infinity, { pixels: 0 }, { pixels: 100001 }]) {
  test(`mobile lowering does not hide invalid scroll distance ${JSON.stringify(distance)}`, () => {
    const mobile = createMobileScroll(); mobile.observe(shot());
    const invalid = { ...params, args: [[200, 500], 'down', distance] };
    assert.deepEqual(mobile.request('scroll', invalid, window, tree), { method: 'scroll', params: invalid });
  });
}

for (const clear of ['clear', 'invalidate']) test(`${clear} removes mobile screenshot eligibility`, () => {
  const mobile = createMobileScroll(); mobile.observe(shot()); mobile[clear](params);
  assert.equal(mobile.request('scroll', params, window, tree).method, 'scroll');
});

test('an invalid frame note cannot leave an earlier valid size eligible', () => {
  const mobile = createMobileScroll(); mobile.observe(shot());
  mobile.observe({ ...shot(), capture: { note: 'bad frame' } });
  assert.equal(mobile.request('scroll', params, window, tree).method, 'scroll');
});

test('Retina swipe coordinates use encoded pixels rather than window points', () => {
  const mobile = createMobileScroll(), capture = shot();
  const bytes = Buffer.from(capture.screenshot.data, 'base64');
  bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(2000, 20);
  capture.screenshot.data = bytes.toString('base64');
  capture.capture.note = 'Screenshot frame: 800x2000 pixels; window bounds (50, 80, 400, 1000) points; scale 2x2 pixels per point; origin top-left; window-only, overlays excluded.';
  mobile.observe(capture);
  const request = mobile.request('scroll', params, window, tree);
  assert.equal(request.method, 'drag');
  assert.deepEqual(request.params.args, [[400, 1375], [400, 725]]);
  assert.deepEqual([request.params.windowId, request.params.processStart, request.params.readId], ['77', '1.2', 1]);
});

test('settled replacement suppression applies only to a parent mobile screenshot', () => {
  const image = { type: 'image', data: 'old', mimeType: 'image/png' };
  const result = { content: [{ ...image, data: 'settled' }] };
  const view = { trusted: { content: [image] }, observations: [{ window, text: tree, screenshot: image }] };
  assert.equal(replacedMobileImage(view, result), image);
  assert.equal(replacedMobileImage({ ...view, observations: [{ window: { ...window, bundleId: 'test.canvas' }, text: tree, screenshot: image }] }, result), undefined);
  assert.equal(replacedMobileImage({ ...view, observations: [{ window, text: tree, screenshot: { ...image, data: 'unobserved' } }] }, result), undefined);
  assert.equal(replacedMobileImage(view, { content: [image] }), undefined);
  assert.equal(replacedMobileImage(view, { content: [] }), undefined);
});
