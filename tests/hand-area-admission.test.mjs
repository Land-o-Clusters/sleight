import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayHand } from '../plugins/sleight/lib/hand/relay-hand.mjs';
import { handWireFrame } from '../plugins/sleight/lib/hand/client.mjs';
import { callLocalTool } from './fixtures/local-tools.mjs';
import { dragScriptFixture } from './fixtures/drag-script.mjs';
import { crossWindowDragFixture } from './fixtures/drag-cross-window.mjs';

const bounds = { X: 100, Y: 500, Width: 500, Height: 300 };
const window = { pid: 42, windowId: 7, bounds };
const target = { app: 'Fixture', appId: 'com.example.fixture', title: 'Fixture' };
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(t, geometry = { ok: true, pid: 42, window, elements: {}, windows: [], displays: [] }) {
  const sent = [], requests = [], hides = [];
  const client = { enabled: true, send: f => sent.push(f), hide: reason => hides.push(reason), close() {} };
  const hand = createRelayHand({ client, env: {}, setting: () => ({ enabled: true, style: 'sprite', size: 'stage' }),
    locate: async request => { requests.push(request); return geometry; } });
  t.after(() => hand.close());
  return { hand, sent, requests, hides };
}

test('CA7 declining a known app action widens its area without hiding the character', async t => {
  const { hand, sent, hides } = fixture(t);
  hand.admit(44, { code: 'await app.click(1)', target, lines: { 1: 'button ID: missing' } });
  hand.approval(45, { tool_name: 'click', tool_params: { app: 'Fixture' } });
  hand.answered(45, 'decline');
  await settle();
  assert.equal(hides.length, 0);
  assert.ok(sent.some(f => f.hand === 'wide' && f.app === 'Fixture'));
});

test('CA7 failure after scheduled frames widens the known window instead of hiding', async t => {
  const { hand, sent, hides } = fixture(t, { ok: true, pid: 42, window, elements: {},
    windows: [{ id: 7, pid: 42, layer: 0, bounds }], displays: [{ X: 0, Y: 0, Width: 1800, Height: 1200 }] });
  hand.admit(46, { code: 'await app.click([100, 100]); await app.click([200, 200])', target, screenshotSize: [500, 300] });
  await settle();
  assert.ok(sent.some(f => f.kind === 'click' && f.delayMs > 0), 'exercise a future frame');
  hand.result(46, true);
  await settle();
  assert.equal(hides.length, 0);
  assert.ok(sent.some(f => f.hand === 'wide' && f.app === 'Fixture'));
});

for (const [name, code, lines] of [
  ['element-not-found', 'await app.click(1)', { 1: 'button ID: missing' }],
  ['no-identity', 'await app.click(1)', {}],
  ['no-focus', 'await app.pressKey("ESC")', {}],
  ['unresolved', 'await app.click(value)', {}],
  ['loop', 'for (const x of [1, 2]) await app.click(x)', {}],
  ['read', 'await app.getAXState()', {}],
]) test(`CA7 ${name} protects a window without inventing an action point`, async t => {
  const { hand, sent } = fixture(t);
  hand.admit(1, { code, target, lines });
  await settle();
  const area = sent.find(f => f.hand === 'status' && f.area);
  const wide = sent.find(f => f.hand === 'wide');
  assert.ok(area || wide, 'a skipped or read-only action needs area protection');
  if (area) {
    assert.equal(area.area, 'window');
    assert.deepEqual([area.pid, area.windowId, area.windowRect], [42, 7, [100, 500, 500, 300]]);
    assert.equal(area.at, undefined);
  } else {
    assert.equal(wide.app, 'Fixture');
    assert.equal(wide.at, undefined, 'there is no known action point');
  }
});

test('CA7 an app-only lookup widens the app and a later result cannot cancel its protection', async t => {
  const { hand, sent } = fixture(t, { ok: true, pid: 42 });
  hand.admit(2, { code: 'await app.getScreenshot()', target, lines: {} });
  hand.result(2, false);
  await settle();
  assert.ok(sent.some(f => f.hand === 'wide' && f.app === 'Fixture'));
});

test('CA7 no-geometry still protects a known native identity without another lookup', async t => {
  const { hand, sent } = fixture(t, { ok: false });
  hand.admit(3, { code: 'await app.click(1)', target: { ...target, nativeIdentity: { pid: 42, windowNumber: 7 } }, lines: {} });
  await settle();
  assert.ok(sent.some(f => f.area === 'window' && f.pid === 42 && f.windowId === 7));
});

test('CH-1 a failed AX lookup widens by app name without another helper read', async t => {
  const sent = [], requests = [];
  const hand = createRelayHand({ client: { enabled: true, send: frame => sent.push(frame), hide() {}, close() {} }, env: {},
    setting: () => ({ enabled: true, style: 'sprite', size: 'stage' }), locate: async request => {
      requests.push(request); return request.area ? { ok: true, pid: 42 } : { ok: false };
    } });
  t.after(() => hand.close());
  hand.admit(1, { code: 'await app.click(1)', lines: { 1: 'button ID: target' }, target });
  await settle();
  assert.ok(sent.some(f => f.hand === 'wide' && f.app === 'Fixture'));
  assert.equal(requests.length, 1);
});

test('CA7 area status accepts app identity but rejects a point, malformed area and a zero window on ordinary status', () => {
  const frame = { hand: 'status', state: 'thinking', area: 'app', pid: 42, windowId: 0 };
  assert.deepEqual(handWireFrame(frame), frame);
  assert.equal(typeof handWireFrame({ ...frame, area: 'window' }), 'string');
  assert.equal(typeof handWireFrame({ ...frame, area: undefined }), 'string');
  assert.equal(typeof handWireFrame({ ...frame, area: 'app', at: [1, 1] }), 'string');
});

test('CA7 local pointer admission keeps the stage seated and delivers the real resolved drag frame', async t => {
  const { hand, sent } = fixture(t);
  hand.localDrag?.({ kind: 'drag', pid: 42, windowId: 7, at: [1100, 700], path: [[350, 700], [1100, 700]],
    windowRect: [100, 500, 500, 300], delayMs: 0, beats: 1 });
  await settle();
  assert.ok(sent.some(f => f.kind === 'drag' && f.path.length === 2));
});

test('CA7 a late local drag cannot repopulate protection after the terminal boundary', t => {
  const { hand, sent } = fixture(t), epoch = hand.turnEpoch;
  const frame = { kind: 'drag', pid: 42, windowId: 7, at: [350, 700], path: [[350, 700], [1100, 700]], delayMs: 0, beats: 1 };
  hand.endTurn?.(); hand.localDrag?.(frame, epoch);
  assert.deepEqual(sent, []);
  hand.localDrag?.(frame, hand.turnEpoch);
  assert.equal(sent.length, 1, 'the next turn can admit its own real drag');
});

test('CA7 the real drag helper reports its resolved global endpoints through the private projection', () => {
  const h = dragScriptFixture({ ax: { nativeSettle: true } });
  const result = h.run({ windowId: 11, dp2: true, from: 'the current text selection', to: 'end of line 1' });
  assert.equal(result.ok, true, result.error);
  const frame = result._sleightHand;
  assert.equal(frame.kind, 'drag');
  assert.deepEqual(frame.windowRect, [100, 100, 600, 400]);
  assert.equal(frame.pid, 7); assert.equal(frame.windowId, 11);
  assert.equal(frame.path.length, 2); assert.deepEqual(frame.path[0], frame.at);
  assert.ok(frame.path.every(p => p[0] >= 100 && p[0] <= 700 && p[1] >= 100 && p[1] <= 500));
});

test('CA7 a real cross-window helper result preserves both resolved endpoint windows', () => {
  const h = crossWindowDragFixture(), result = h.run();
  assert.equal(result.ok, true, result.error);
  const frame = result._sleightHand;
  assert.equal(frame.pid, 7); assert.equal(frame.windowId, 11);
  assert.deepEqual(frame.windowRect, [100, 100, 600, 400]);
  assert.ok(frame.path[0][0] >= 100 && frame.path[0][0] <= 700);
  assert.ok(frame.path[1][0] >= 750 && frame.path[1][0] <= 1250);
  assert.deepEqual(frame.path[0], frame.at);
});

test('CA7 drag metadata reaches only the renderer after a successful helper result', async () => {
  const frame = { kind: 'drag', pid: 42, windowId: 7, at: [1100, 700], path: [[350, 700], [1100, 700]] };
  for (const ok of [true, false]) {
    const observed = [];
    const result = await callLocalTool('drag', { app: 'Fixture', from: [1, 2], to: [3, 4] }, async () => true,
      async script => script === 'drag-focus.js' ? { ok: true } : { ok, path: 'accessibility', _sleightHand: frame },
      undefined, undefined, { onDrag: value => observed.push(value) });
    assert.deepEqual(observed, ok ? [frame] : []);
    assert.ok(!JSON.stringify(result).includes('_sleightHand'));
  }
});

test('CH-1 a late client load cannot repopulate protection after the terminal boundary', async t => {
  let finish;
  const sent = [];
  const hand = createRelayHand({ env: {},
    setting: () => ({ enabled: true, style: 'sprite', size: 'stage' }), locate: async () => ({ ok: false }),
    loadClient: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => hand.close());
  hand.protect?.(target); await settle();
  assert.equal(typeof finish, 'function');
  hand.endTurn?.(); finish({ createHandClient: () => ({ enabled: true, send: value => sent.push(value), hide() {}, close() {} }) });
  await settle();
  assert.deepEqual(sent, []);
});
