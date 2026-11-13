import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayHand } from '../plugins/sleight/lib/hand/relay-hand.mjs';
import { GUARD_READ_MS, WRITE_MS } from '../plugins/sleight/lib/hand/planner.mjs';

const BOUNDS = { X: 100, Y: 200, Width: 656, Height: 422 };
const GEOMETRY = { ok: true, pid: 321, window: { pid: 321, windowId: 77, bounds: BOUNDS },
  windows: [{ id: 77, pid: 321, layer: 0, owner: 'Editor', bounds: BOUNDS }], displays: [{ X: 0, Y: 0, Width: 1512, Height: 982 }],
  elements: { 1: { X: 120, Y: 240, Width: 80, Height: 20 } }, focused: { frame: { X: 300, Y: 400, Width: 200, Height: 24 }, window: false, inWindow: true } };
const TREE = 'Window: "notes.txt", App: Editor.\n0 standard window notes.txt\n\t1 button Description: Save, ID: saveButton';
const TARGET = { app: 'Editor', title: 'notes.txt', appId: 'com.example.editor' };

function fixture(options = {}) {
  let clock = 1000;
  const sent = [], traces = [], requests = [], deferred = [];
  const client = { enabled: true, pid: 4242, sent, hidden: 0, closed: 0,
    send(frame) { sent.push({ ...frame, sentAt: clock }); }, hide() { this.hidden++; }, close() { this.closed++; } };
  let answer = () => GEOMETRY;
  const hand = createRelayHand({ client, env: { SLEIGHT_HAND: '1' }, setting: () => ({ enabled: true }), now: () => clock, defer: fn => deferred.push(fn),
    locate: async request => { requests.push(request); return answer(request); },
    trace: (direction, msg) => traces.push([direction, msg]), ...options });
  return { hand, client, sent, traces, requests, deferred,
    advance: ms => { clock += ms; }, setAnswer: fn => { answer = fn; },
    run: async () => { while (deferred.length) deferred.shift()(); for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); } };
}
const admit = (f, id, code) => f.hand.admit(id, { code, target: TARGET, lines: () => TREE, screenshotSize: () => [1312, 844] });
const approval = (f, id, tool) => f.hand.approval(id, { tool_name: tool, tool_params: { app: 'Editor' } });

test('admission only queues work; the frames go out after the engine call, with the time left on the schedule', async () => {
  const f = fixture();
  admit(f, 1, 'await app.click([400, 196]); await app.click(1); await app.typeText("hi");');
  assert.equal(f.requests.length, 0, 'nothing runs inside admission');
  assert.equal(f.deferred.length, 1);
  f.advance(100);
  await f.run();
  assert.deepEqual(f.requests, [{ app: 'Editor', appId: 'com.example.editor', title: 'notes.txt', identities: {
    1: { role: 'AXButton', id: 'saveButton', description: 'Save', title: undefined } }, versions: { 1: '9e41af0cf584a429d820306e6ac8d456aa18381d53495fc7d022b6b68cbcc080' }, focus: false }]);
  assert.deepEqual(f.sent.map(s => [s.kind, s.at, s.delayMs]), [
    ['click', [300, 298], 0], ['click', [160, 250], GUARD_READ_MS + WRITE_MS - 100], ['type', [160, 250], GUARD_READ_MS + 2 * WRITE_MS - 100]]);
  assert.deepEqual(Object.keys(f.sent[0]).sort(), ['at', 'beats', 'delayMs', 'kind', 'path', 'pid', 'sentAt', 'windowId']);
});

test('once an app sends approval requests, each accepted approval is the exact beat for its action', async () => {
  const f = fixture();
  // The first call learns that this app's actions come with approval requests.
  admit(f, 1, 'await app.click([400, 196])');
  approval(f, 'a1', 'click'); f.hand.answered('a1', 'accept');
  await f.run(); f.hand.result(1, false);
  f.sent.length = 0;
  admit(f, 2, 'await app.click([400, 196]); await app.pressKey("Return"); await app.click([20, 20]);');
  await f.run();
  assert.equal(f.sent.length, 0, 'frames wait for their approvals');
  f.advance(300);
  approval(f, 'a2', 'click'); f.hand.answered('a2', 'accept');
  assert.deepEqual(f.sent.map(s => [s.kind, s.delayMs, s.sentAt]), [['click', 0, 1300]]);
  // A key's approval names press_key: it is the second action's beat.
  f.advance(50);
  approval(f, 'a3', 'press_key'); f.hand.answered('a3', 'accept');
  assert.deepEqual(f.sent.map(s => s.kind), ['click', 'key']);
  // The result re-anchors the rest of the schedule at its own time.
  f.advance(1000);
  f.hand.result(2, false);
  const beats = f.traces.filter(([d]) => d === 'hand-beat').map(([, m]) => m);
  assert.deepEqual(beats.slice(-2), [{ id: 2, action: 0, driftMs: 300 }, { id: 2, action: 1, driftMs: 350 - WRITE_MS }]);
  assert.deepEqual(f.sent.map(s => [s.kind, s.delayMs, s.sentAt]).at(-1), ['click', 0, 2350]);
});

test('an approval before the frames are planned still counts, and a result long after planning drops late frames', async () => {
  const f = fixture();
  admit(f, 1, 'await app.click([400, 196])');
  approval(f, 'a1', 'click'); f.hand.answered('a1', 'accept');
  await f.run();
  assert.deepEqual(f.sent.map(s => s.delayMs), [0]);
  f.hand.result(1, false);
  f.sent.length = 0;
  // Geometry arrives after the result: frames older than the late limit are dropped.
  let release;
  f.setAnswer(() => new Promise(r => { release = r; }));
  admit(f, 2, 'await app.click([400, 196]); await app.click([20, 20]);');
  await f.run();
  f.hand.result(2, false);
  f.advance(5000);
  release(GEOMETRY); await f.run();
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.traces.filter(([d]) => d === 'hand-skipped').map(([, m]) => m.reason), ['late', 'late']);
});

test('the relay finishing a call after its result keeps frames whose geometry is still on the way', async () => {
  const f = fixture();
  let release;
  f.setAnswer(() => new Promise(r => { release = r; }));
  admit(f, 1, 'await app.click([400, 196])');
  await f.run();
  f.hand.result(1, false); f.hand.result(1, true);
  release(GEOMETRY); await f.run();
  assert.deepEqual(f.sent.map(s => [s.kind, s.delayMs]), [['click', 0]]);
  // A resent call replaces its first try.
  admit(f, 2, 'await app.click([400, 196])'); admit(f, 2, 'await app.click([20, 20])');
  f.setAnswer(() => GEOMETRY); await f.run();
  assert.deepEqual(f.sent.slice(1).map(s => s.at), [[110, 210]]);
  // The first try's planning never forgets the replacement, so its approval still beats.
  approval(f, 'a1', 'click'); f.hand.answered('a1', 'accept'); f.hand.result(2, false);
  f.sent.length = 0;
  admit(f, 3, 'await app.click([400, 196])'); admit(f, 3, 'await app.click([20, 20])');
  await f.run();
  assert.equal(f.sent.length, 0, 'held for its approval');
  approval(f, 'a2', 'click'); f.hand.answered('a2', 'accept');
  assert.deepEqual(f.sent.map(s => s.at), [[110, 210]]);
});

test('a declined approval or a failed call drops what is left, and a failed call hides frames still due', async () => {
  const f = fixture();
  admit(f, 1, 'await app.click([400, 196]); await app.click([20, 20]);');
  await f.run();
  assert.equal(f.sent.length, 2);
  f.hand.result(1, true);
  assert.equal(f.client.hidden, 1, 'the second frame was still due');
  const g = fixture();
  admit(g, 1, 'await app.click([400, 196])');
  approval(g, 'a1', 'click'); g.hand.answered('a1', 'accept'); await g.run(); g.hand.result(1, false);
  g.sent.length = 0;
  admit(g, 2, 'await app.click([400, 196]); await app.click([20, 20]);');
  await g.run();
  approval(g, 'a2', 'click'); g.hand.answered('a2', 'decline');
  g.hand.result(2, true);
  assert.equal(g.sent.length, 0);
});

test('skips are traced with the reason and no window names; a second call while one locates is skipped as busy', async () => {
  const f = fixture();
  f.setAnswer(() => ({ ...GEOMETRY, state: 'minimized' }));
  admit(f, 1, 'await app.click([400, 196])');
  await f.run();
  assert.deepEqual(f.traces, [['hand-skipped', { id: 1, action: 0, method: 'click', reason: 'minimized' }]]);
  let release;
  f.setAnswer(() => new Promise(r => { release = r; }));
  admit(f, 2, 'await app.click([400, 196])');
  await f.run();
  admit(f, 3, 'await app.click([400, 196])');
  await f.run();
  assert.deepEqual(f.traces.at(-1), ['hand-skipped', { id: 3, reason: 'busy' }]);
  f.setAnswer(() => { throw new Error('helper failed'); });
  release(undefined); await f.run();
  assert.deepEqual(f.traces.at(-1), ['hand-skipped', { id: 2, reason: 'no-geometry' }]);
  admit(f, 4, 'await app.getAXState()');
  await f.run();
  assert.equal(f.requests.length, 2, 'a read needs no geometry');
});

test('SLEIGHT_HAND=0, a missing client module or a disabled client means no hand and no helper', async () => {
  assert.equal(createRelayHand({ env: { SLEIGHT_HAND: '0' }, locate: () => GEOMETRY }), undefined);
  for (const options of [{ client: undefined, loadClient: () => import('./no-such-hand-client.mjs') },
    { client: { enabled: false, send() { throw new Error('sent'); }, hide() {}, close() {} } }]) {
    const f = fixture(options);
    admit(f, 1, 'await app.click([400, 196])');
    await f.run();
    assert.equal(f.requests.length, 0);
    f.hand.hide(); f.hand.result(1, false); f.hand.close();
  }
  // The client module loads once, lazily, on the first action call.
  let loads = 0;
  const sent = [];
  const f = fixture({ client: undefined, loadClient: async () => { loads++; return { createHandClient: () => ({ enabled: true, send: frame => sent.push(frame), hide() {}, close() {} }) }; } });
  f.hand.hide();
  assert.equal(loads, 0, 'no client is loaded just to hide');
  admit(f, 1, 'await app.click([400, 196])'); await f.run();
  admit(f, 2, 'await app.click([400, 196])'); await f.run();
  assert.equal(loads, 1);
  assert.equal(sent.length, 2);
});

test('hide drops calls still in flight, so no frame follows it into a local drag or hover', async () => {
  const f = fixture();
  let release;
  f.setAnswer(() => new Promise(r => { release = r; }));
  admit(f, 1, 'await app.click([400, 196])');
  await f.run();
  f.hand.hide();
  release(GEOMETRY); await f.run();
  assert.equal(f.sent.length, 0, 'the click whose geometry came back after hide shows nothing');
  assert.equal(f.client.hidden, 1);
  // Held frames waiting for approvals are dropped too, and the approval no longer beats.
  f.setAnswer(() => GEOMETRY);
  admit(f, 2, 'await app.click([400, 196])'); approval(f, 'a1', 'click'); f.hand.answered('a1', 'accept'); await f.run(); f.hand.result(2, false);
  f.sent.length = 0;
  admit(f, 3, 'await app.click([400, 196])'); await f.run();
  approval(f, 'a2', 'click');
  f.hand.hide();
  f.hand.answered('a2', 'accept');
  assert.equal(f.sent.length, 0);
});

test('a hide while the client loads reaches it once loaded, and a declined approval hides', async () => {
  let finish;
  const loaded = { enabled: true, sent: [], hidden: 0, send(frame) { this.sent.push(frame); }, hide() { this.hidden++; }, close() {} };
  const f = fixture({ client: undefined, loadClient: () => new Promise(r => { finish = r; }) });
  admit(f, 1, 'await app.click([400, 196])');
  await f.run();
  f.hand.hide();
  finish({ createHandClient: () => loaded }); await f.run();
  assert.equal(loaded.hidden, 1);
  assert.deepEqual(loaded.sent, [], 'the call admitted before the hide shows nothing');
  const g = fixture();
  admit(g, 1, 'await app.click([400, 196]); await app.click([20, 20]);');
  approval(g, 'a1', 'click'); g.hand.answered('a1', 'decline');
  assert.equal(g.client.hidden, 1);
  await g.run();
  assert.equal(g.sent.length, 0);
});

test('hide and close reach the client, and a throwing client never reaches the relay', async () => {
  const f = fixture();
  admit(f, 1, 'await app.click([400, 196])'); await f.run();
  f.hand.hide(); f.hand.close();
  assert.deepEqual([f.client.hidden, f.client.closed], [1, 1]);
  const bad = { enabled: true, send() { throw new Error('pipe'); }, hide() { throw new Error('pipe'); }, close() { throw new Error('pipe'); } };
  const g = fixture({ client: bad });
  admit(g, 1, 'await app.click([400, 196])'); await g.run();
  g.hand.hide(); g.hand.result(1, true); g.hand.close();
  g.hand.admit(2, undefined); g.hand.approval(undefined, undefined); g.hand.answered(undefined);
});

test('default off installs no hand hooks; saved on enables hooks and env 0 still wins', () => {
  const options = { env: {}, setting: () => ({ enabled: false }), locate: () => { throw Error('must not locate'); },
    loadClient: () => { throw Error('must not load'); } };
  assert.equal(createRelayHand(options), undefined);
  const on = { ...options, setting: () => ({ enabled: true }) };
  const hand = createRelayHand(on);
  assert.ok(hand);
  hand.close();
  assert.equal(createRelayHand({ ...on, env: { SLEIGHT_HAND: '0' } }), undefined);
});


test('guard binding decisions correct approval drift for this call', async () => {
  const f = fixture();
  admit(f, 1, 'await app.click(1); await app.click(1)');
  approval(f, 'a', 'click'); f.hand.answered('a', 'accept');
  await f.run();
  f.advance(72); approval(f, 'b', 'click'); f.hand.answered('b', 'accept');
  f.hand.bindings(1, [{ index: 0, bound: false }, { index: 1, bound: true }]);
  f.hand.result(1, false);
  const beats = f.traces.filter(([d]) => d === 'hand-beat').map(([, m]) => m);
  assert.equal(beats[0].driftMs, beats[1].driftMs);
});


test('approval drift uses the original approval time when geometry arrives later', async () => {
  const f = fixture();
  admit(f, 1, 'await app.click(1)');
  approval(f, 'a', 'click'); f.hand.answered('a', 'accept');
  f.advance(500); await f.run(); f.hand.result(1, false);
  const beat = f.traces.find(([d]) => d === 'hand-beat')[1];
  assert.equal(beat.driftMs, -GUARD_READ_MS);
});
