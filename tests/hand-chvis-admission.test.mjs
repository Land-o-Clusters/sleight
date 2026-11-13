import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { exposure } from '../plugins/sleight/lib/hand/planner.mjs';
import { createRelayHand } from '../plugins/sleight/lib/hand/relay-hand.mjs';
import { callLocalTool } from './fixtures/local-tools.mjs';
import { handWireFrame } from '../plugins/sleight/lib/hand/client.mjs';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(t) {
  const sent = [], requests = [];
  const hand = createRelayHand({ env: {}, setting: () => ({ enabled: true, style: 'sprite', size: 'stage' }),
    client: { enabled: true, send: value => sent.push(value), hide() {}, close() {} },
    locate: async request => { requests.push(request); return { ok: true, pid: 42 }; } });
  t.after(() => hand.close());
  return { hand, sent, requests };
}
test('CH-1 app-only reads send wide protection before a helper read', async t => {
  const { hand, sent, requests } = fixture(t);
  hand.protect({ app: 'Preview' });
  await settle();
  assert.ok(sent.some(f => f.hand === 'wide' && f.app === 'Preview'));
  assert.equal(requests.length, 0, 'the host already observes app windows');
});
test('CH-1 no-geometry and skipped scroll retain the reason without a fabricated point', async t => {
  const { hand, sent } = fixture(t);
  hand.admit(1, { code: 'for (let i=0;i<3;i++) await app.scroll("down")',
    target: { app: 'Preview', nativeIdentity: { pid: 42, windowNumber: 7 } } });
  await settle();
  const wide = sent.find(f => f.hand === 'wide');
  assert.ok(wide); assert.equal(wide.reason, 'scroll'); assert.equal(wide.pid, 42);
  assert.equal(wide.at, undefined); assert.equal(wide.windowId, 7);
});
test('CH-1 acquisition and several-handle calls widen every supplied app before planning', async t => {
  const { hand, sent } = fixture(t);
  hand.admit(1, { code: 'await a.click(1); await b.click(2)', target: { app: 'Fixture A' },
    areaTargets: [{ app: 'Fixture A' }, { app: 'Fixture B' }] });
  await settle();
  assert.deepEqual(sent.filter(f => f.hand === 'wide').map(f => f.app).sort(), ['Fixture A', 'Fixture B']);
});
test('CH-1 the private wide wire leaves action geometry absent and validates identity and turn', () => {
  const frame = { hand: 'wide', app: 'Preview', reason: 'read', epoch: 0 };
  assert.deepEqual(handWireFrame(frame), frame);
  for (const change of [{ app: '' }, { app: 'a\n' }, { epoch: -1 }, { reason: 'anything' }, { at: [1, 2] }, { pid: 0 }])
    assert.equal(typeof handWireFrame({ ...frame, ...change }), 'string');
  assert.deepEqual(handWireFrame({ hand: 'wide', pid: 42, windowId: 7, reason: 'scroll', epoch: 1 }),
    { hand: 'wide', pid: 42, windowId: 7, reason: 'scroll', epoch: 1 });
});

test('CH-4 local hover geometry is private and only forwarded on success', async () => {
  const frame = { hand: 'aim', kind: 'move', pid: 42, windowId: 7, at: [100, 200] };
  for (const ok of [true, false]) {
    const observed = [];
    const reply = await callLocalTool('hover', { app: 'Fixture', at: [1, 2] }, async () => true,
      async () => ({ ok, _sleightHand: frame }), undefined, undefined, { onDrag: value => observed.push(value) });
    assert.deepEqual(observed, ok ? [frame] : []);
    assert.ok(!JSON.stringify(reply).includes('_sleightHand'));
  }
});

test('CH-8 full-display system overlays are uncertain while banners and sheets remain cover', () => {
  const bounds = { X: 100, Y: 100, Width: 500, Height: 400 }, window = { pid: 42, windowId: 7, bounds };
  const displays = [{ X: 0, Y: 0, Width: 1512, Height: 982 }], own = { id: 7, pid: 42, layer: 0, alpha: 1, bounds };
  const overlay = { id: 10, pid: 99, layer: 21, alpha: 1, systemOverlay: true, bounds: displays[0] };
  assert.equal(exposure([200, 200], window, [overlay, own], displays), 'uncertain-cover');
  assert.equal(exposure([200, 200], window, [{ ...overlay, bounds: { X: 150, Y: 150, Width: 100, Height: 100 } }, own], displays), 'covered');
  assert.equal(exposure([200, 200], window, [{ ...overlay, pid: 42, layer: 0, systemOverlay: false }, own], displays), 'covered');
  assert.equal(exposure([200, 200], window, [{ ...overlay, alpha: 0 }, own], displays), undefined);
});

test('CH-1 a lazy client receives every app area after loading without another helper read', async t => {
  const sent = [];
  const client = { enabled: true, send: value => sent.push(value), hide() {}, close() {} };
  const hand = createRelayHand({ env: {}, setting: () => ({ enabled: true, style: 'sprite', size: 'stage' }),
    loadClient: async () => ({ createHandClient: () => client }), locate: async () => { assert.fail('area admission needs no helper'); } });
  t.after(() => hand.close());
  hand.admit(1, { code: 'await a.click(1); await b.click(2)', target: { app: 'Fixture A' }, areaTargets: [{ app: 'Fixture A' }, { app: 'Fixture B' }] });
  await settle();
  assert.deepEqual(sent.filter(f => f.hand === 'wide').map(f => f.app).sort(), ['Fixture A', 'Fixture B']);
});

test('CH-4 the real hover controller reports its resolved point without changing its input sequence', () => {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/hover.js', import.meta.url), 'utf8'), context);
  let time = 0;
  const events = [];
  const native = { screenCaptureAllowed: () => true, resolve: () => ({ pid: 42, windowId: 7, bounds: { X: 100, Y: 200, Width: 500, Height: 300 } }),
    point: () => ({ x: 110, y: 220 }), visible: () => true, idleSeconds: () => 60,
    save: () => ({}), now: () => time, activate: () => events.push('activate'),
    wait: ms => { time += ms; }, move: () => events.push('move'), typedSince: () => false,
    capture: () => { events.push('capture'); return 'fixture'; }, restorePointer: () => events.push('restorePointer'), restoreFront: () => events.push('restoreFront') };
  const result = context.performHover({ app: 'Fixture', at: [10, 20], waitMs: 100 }, native);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result._sleightHand)), { hand: 'aim', kind: 'move', pid: 42, windowId: 7, at: [110, 220], windowRect: [100, 200, 500, 300] });
  assert.deepEqual(events, ['activate', 'move', 'capture', 'restorePointer', 'restoreFront']);
});

test('CH-1 a late approval cannot restart a finished turn mood', t => {
  const statuses = [];
  const events = { enabled: true, call: () => 1, connectHost() {}, action() {}, status: state => statuses.push(state) };
  const hand = createRelayHand({ events, env: {}, setting: () => ({ enabled: true, style: 'sprite', size: 'stage' }),
    client: { enabled: true, send() {}, hide() {}, close() {} }, locate: async () => ({ ok: false }) });
  t.after(() => hand.close());
  hand.admit(1, { code: 'await app.click(1)', target: { app: 'Fixture' }, lines: {} });
  hand.approval(2, { tool_name: 'click', tool_params: { app: 'Fixture' } });
  assert.deepEqual(statuses, ['waiting']); hand.endTurn(); statuses.length = 0;
  hand.answered(2, 'accept'); hand.approval(3, { tool_name: 'click', tool_params: { app: 'Fixture' } });
  assert.deepEqual(statuses, []);
});
