import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as launch from './fixtures/local-tools.mjs';
import { createRelayHand } from '../plugins/sleight/lib/hand/relay-hand.mjs';
import { dragScriptFixture } from './fixtures/drag-script.mjs';
import { crossWindowDragFixture } from './fixtures/drag-cross-window.mjs';

const drag = { kind: 'drag', pid: 7, windowId: 11, at: [150, 140], path: [[150, 140], [850, 140]], delayMs: 0, beats: 1 };
test('CH-4 the helper streams resolved points before either a text edit or posted input', () => {
  for (const cross of [false, true]) {
    const h = cross ? crossWindowDragFixture() : dragScriptFixture({ ax: { nativeSettle: true } });
    const frames = [];
    h.context.sleightPlaceHand = frame => {
      assert.equal(h.events.length, 0, 'placement precedes posted input');
      assert.equal((h.axWrites ?? h.writes).length, 0, 'placement precedes text edits');
      frames.push(JSON.parse(JSON.stringify(frame)));
    };
    const result = h.run(cross ? {} : { windowId: 11, dp2: true, from: 'the current text selection', to: 'end of line 1' });
    assert.equal(result.ok, true, result.error);
    assert.ok(frames.length > 0, 'the real helper must call the placement boundary');
    assert.equal(frames[0].kind, 'drag'); assert.equal(frames[0].path.length, 2);
    if (cross) assert.ok(frames[0].path[1][0] >= 750);
  }
});
test('CH-4 the parent waits for placement, caps the line buffer and ignores stale tokens', async () => {
  assert.equal(typeof launch.attachPointerPlacement, 'function');
  const child = new EventEmitter(), output = [], calls = [], token = 'a'.repeat(32);
  child.stderr = new EventEmitter(); child.stdin = { write: line => output.push(JSON.parse(line)) };
  let accept;
  const close = launch.attachPointerPlacement(child, { token, place: (frame, deadline) => {
    calls.push({ frame, deadline }); return new Promise(resolve => { accept = resolve; });
  }, hide() {} });
  const deadline = Date.now() + 100;
  child.stderr.emit('data', 'sleight-place ' + JSON.stringify({ token: 'b'.repeat(32), frame: drag, deadline }) + '\n');
  assert.equal(calls.length, 0);
  const line = 'sleight-place ' + JSON.stringify({ token, frame: drag, deadline }) + '\n';
  child.stderr.emit('data', line.slice(0, 40)); child.stderr.emit('data', line.slice(40));
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].frame, drag); assert.equal(output.length, 0);
  accept(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(output[0].token, token); assert.equal(output[0].placed, true);
  close(); assert.equal(child.stderr.listenerCount('data'), 0);
});
test('CH-4 replacing the existing clear uses the same deadline and fences late turns', async t => {
  const calls = [], hides = [];
  const hand = createRelayHand({ env: {}, setting: () => ({ enabled: true, style: 'sprite', size: 'stage' }),
    locate: async () => ({ ok: false }), client: { enabled: true, send() {}, close() {}, hide: () => hides.push(1),
      clearForAction: async (frame, deadline) => { calls.push({ frame, deadline }); return true; } } });
  t.after(() => hand.close());
  assert.equal(hand.placementEnabled, true);
  const epoch = hand.turnEpoch, deadline = Date.now() + 100;
  assert.equal(await hand.placeLocal(drag, epoch, deadline), true);
  assert.deepEqual(calls, [{ frame: drag, deadline }]);
  hand.endTurn(); assert.equal(await hand.placeLocal(drag, epoch, deadline), false);
  assert.equal(calls.length, 1); assert.equal(hides.length, 1);
});

test('CH-4 helper timeout hides and proceeds within one 100 ms budget across fallbacks', () => {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/hand/pointer-placement.js', import.meta.url), 'utf8'), context);
  let time = 0; const lines = [], waits = [];
  const place = context.pointerPlacement('a'.repeat(32), { now: () => time, write: line => lines.push(line),
    ready: ms => { waits.push(ms); time += ms; return false; }, read: () => assert.fail('unready pipe never reads') });
  assert.equal(place(drag), false); assert.equal(time, 100);
  assert.equal(place(drag), false); assert.equal(time, 100);
  assert.deepEqual(waits, [100]);
  assert.equal(lines.filter(line => line.startsWith('sleight-place-timeout ')).length, 2);
});
test('CH-4 helper timeout uses monotonic time and sends the wall-clock deadline to its parent', () => {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/hand/pointer-placement.js', import.meta.url), 'utf8'), context);
  let time = 0; const lines = [];
  const place = context.pointerPlacement('a'.repeat(32), { now: () => time, wallNow: () => 1000000,
    write: line => lines.push(line), ready: ms => { time += ms; return false; }, read: () => assert.fail() });
  assert.equal(place(drag), false); assert.equal(time, 100);
  assert.equal(JSON.parse(lines[0].slice('sleight-place '.length)).deadline, 1000100);
});
test('CH-4 failed, late and overlong helper messages hide without returning endpoints', async () => {
  const child = new EventEmitter(), output = [], hides = [], token = 'a'.repeat(32);
  child.stderr = new EventEmitter(); child.stdin = { write: line => output.push(JSON.parse(line)) };
  const close = launch.attachPointerPlacement(child, { token, now: () => 1000,
    place: () => { throw Error('closed'); }, hide: () => hides.push(1) });
  const send = deadline => child.stderr.emit('data', 'sleight-place ' + JSON.stringify({ token, frame: drag, deadline }) + '\n');
  send(999); assert.equal(output[0].placed, false);
  send(1050); assert.equal(output[1].placed, false);
  child.stderr.emit('data', 'x'.repeat(8193));
  assert.ok(hides.length >= 3); assert.ok(output.every(row => !('frame' in row)));
  close();
});

test('CH-4 hover places its move aim before activation and preserves capture hiding', () => {
  const seen = [], context = vm.createContext({ ObjC: { import() {} }, sleightPlaceHand: frame => seen.push(JSON.parse(JSON.stringify(frame))) });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/hover.js', import.meta.url), 'utf8'), context);
  const native = { screenCaptureAllowed: () => true, resolve: () => ({ pid: 42, windowId: 7, bounds: { X: 100, Y: 200, Width: 500, Height: 300 } }),
    point: () => ({ x: 110, y: 220 }), visible: () => true, idleSeconds: () => 60,
    hideHand: () => { seen.push('capture-hide'); return () => seen.push('capture-release'); },
    save: () => ({}), now: () => 0, activate: () => seen.push('activate'), wait() {}, move: () => seen.push('move'),
    typedSince: () => false, capture: () => 'fixture', restorePointer() {}, restoreFront() {} };
  assert.equal(context.performHover({ app: 'Fixture', at: [10,20], waitMs: 100 }, native).ok, true);
  assert.equal(seen[0].hand, 'aim'); assert.equal(seen[0].kind, 'move'); assert.deepEqual(seen[0].at, [110,220]);
  assert.deepEqual(seen.slice(1), ['capture-hide', 'activate', 'move', 'capture-release']);
});
test('CH-4 local tools inject placement only into pointer helpers after approval', async () => {
  for (const approved of [true, false]) {
    const calls = [], placement = { place() {}, hide() {} };
    const result = await launch.callLocalTool('drag', { app: 'Fixture', from: [1, 2], to: [3, 4] }, async () => approved,
      async (script, request, options) => { calls.push({ script, options }); return { ok: true, path: 'accessibility' }; },
      undefined, undefined, { placeHand: placement });
    assert.equal(Boolean(result.isError), !approved);
    if (!approved) assert.equal(calls.length, 0);
    else {
      assert.equal(calls.find(c => c.script === 'drag.js').options.placeHand, placement);
      assert.ok(calls.filter(c => c.script !== 'drag.js').every(c => c.options?.placeHand === undefined));
    }
  }
});

test('CH-4 a stopped relay aborts helper input while a missing host only hides', () => {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/hand/pointer-placement.js', import.meta.url), 'utf8'), context);
  const token = 'a'.repeat(32);
  const place = context.pointerPlacement(token, { now: () => 0, write() {}, ready: () => true,
    read: () => JSON.stringify({ token, placed: false, stopped: true }) + '\n' });
  assert.throws(() => place(drag), error => error.code === 'USER_STOPPED');
});
test('CH-4 a relay stop during placement and an asynchronous pipe error settle safely', async () => {
  const child = new EventEmitter(), output = [], token = 'a'.repeat(32);
  child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.write = line => output.push(JSON.parse(line));
  let running = true, accept, hidden = 0;
  const close = launch.attachPointerPlacement(child, { token, current: () => { if (!running) throw Error('stopped'); },
    place: () => new Promise(resolve => { accept = resolve; }), hide: () => hidden++ });
  child.stderr.emit('data', 'sleight-place ' + JSON.stringify({ token, frame: drag, deadline: Date.now() + 100 }) + '\n');
  running = false; accept(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(output[0].stopped, true); assert.equal(output[0].placed, false);
  assert.doesNotThrow(() => child.stdin.emit('error', Object.assign(Error('closed'), { code: 'EPIPE' })));
  assert.ok(hidden > 0); close(); assert.equal(child.stdin.listenerCount('error'), 0);
});
test('CH-4 a declined local action cannot be redrawn by its deferred area preview', async t => {
  const sent = [], hides = [];
  const hand = createRelayHand({ env: {}, setting: () => ({ enabled: true, style: 'sprite', size: 'stage' }),
    locate: async () => ({ ok: false }), client: { enabled: true, send: frame => sent.push(frame), close() {}, hide: () => hides.push(1) } });
  t.after(() => hand.close());
  let allowed = true;
  hand.protect({ app: 'Earlier approved fixture' });
  hand.protect({ app: 'Fixture' }, () => allowed); allowed = false; hand.hide();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(hides.length, 1);
  assert.deepEqual(sent.map(frame => frame.app), ['Earlier approved fixture'], 'withdraw only the declined preview and retain prior protection');
});
