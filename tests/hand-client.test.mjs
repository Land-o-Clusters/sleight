import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { createHandClient, handWireFrame, sessionHandClient, shareConsent } from '../plugins/sleight/lib/hand/client.mjs';
import { handPid, setHandPid } from '../plugins/sleight/lib/hand/pid.mjs';
import * as host from '../plugins/sleight/lib/direct-browser/host.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const pauseEvent = (child, phase, paused, token = '1'.repeat(32), extra = {}) => child.stdout.emit('data',
  JSON.stringify({ hand: 'pause', nonce: child.menus[0].nonce, token, phase, paused, ...extra }) + '\n');
const commitPause = (child, value, token = '1'.repeat(32)) => {
  for (const phase of ['request', 'commit', 'confirm']) pauseEvent(child, phase, value, token);
};
test('pause uses an exact nonce-bound prepare and commit, and duplicate commits do not toggle state', async t => {
  const child = fakeChild(), values = [];
  const client = createHandClient({ setting: () => ({ enabled: true, style: 'ring' }), built: () => true,
    watch: () => undefined, permissions: null, usage: null, onPause: value => values.push(value),
    prepare: async () => ({ status: 'ready', spawn: () => child }) });
  t.after(() => client.close()); client.send(frame()); await settle();
  pauseEvent(child, 'request', true, undefined, { nonce: 'b'.repeat(64) });
  pauseEvent(child, 'request', 'yes'); pauseEvent(child, 'request', true, undefined, { extra: true });
  assert.deepEqual(values, []);
  pauseEvent(child, 'request', true); assert.deepEqual(values, [], 'ready alone never blocks admission');
  assert.equal(child.lines.at(-1).phase, 'ready');
  pauseEvent(child, 'commit', true); pauseEvent(child, 'commit', true);
  assert.deepEqual(values, [true]); assert.equal(child.lines.at(-1).phase, 'applied');
  pauseEvent(child, 'confirm', true); commitPause(child, false, '2'.repeat(32));
  assert.deepEqual(values, [true, false]);
});
test('drawing off and SLEIGHT_HAND=0 never start pause controls', async t => {
  for (const env of [{}, { SLEIGHT_HAND: '0' }]) {
    let starts = 0;
    const client = createHandClient({ env, setting: () => ({ enabled: false }), built: () => true, watch: () => undefined,
      permissions: null, usage: null, prepare: async () => { starts++; throw Error(); } });
    t.after(() => client.close()); client.activity(); await settle(); assert.equal(starts, 0);
    assert.equal(sessionHandClient({ env, controls: true, setting: () => ({ enabled: false }) }), undefined);
  }
});
test('one paused host replacement restores the pause and its target, then reports control loss on another exit', async t => {
  const children = [], values = [];
  const client = createHandClient({ setting: () => ({ enabled: true, style: 'ring' }), built: () => true,
    watch: () => undefined, permissions: null, usage: null, onPause: value => values.push(value),
    prepare: async () => ({ status: 'ready', spawn() { const child = fakeChild(); children.push(child); return child; } }) });
  t.after(() => client.close()); client.send(frame()); await settle();
  commitPause(children[0], true); children[0].exitCode = 1; children[0].emit('exit', 1); await settle();
  assert.equal(children.length, 2); assert.deepEqual(values, [true]);
  assert.equal(children[1].lines.find(f => f.phase === 'restore').paused, true);
  assert.equal(children[1].lines.find(f => f.hand === 'status').state, 'paused');
  // The dead child's stdout no longer has authority.
  commitPause(children[0], false, '2'.repeat(32)); assert.deepEqual(values, [true]);
  children[1].exitCode = 1; children[1].emit('exit', 1); await settle();
  assert.equal(children.length, 2); assert.equal(client.controlLost, true); assert.deepEqual(values, [true]);
});
test('a hand-channel fault recovers controls even when the consent process stays alive', async t => {
  const children = [], values = [];
  const client = createHandClient({ setting: () => ({ enabled: true }), built: () => true, watch: () => undefined,
    permissions: null, usage: null, onPause: value => values.push(value), prepare: async () => ({ status: 'ready', spawn() {
      const child = fakeChild(); children.push(child); return child;
    } }) });
  t.after(() => client.close()); client.send(frame()); await settle(); commitPause(children[0], true);
  children[0].stdout.emit('data', JSON.stringify({ hand: 'control-gone', nonce: children[0].menus[0].nonce }) + '\n');
  await settle(); assert.equal(children.length, 2); assert.deepEqual(values, [true]);
  children[1].stdout.emit('end'); assert.equal(client.controlLost, true);
});
test('a control-gone fault tells the old shared host to exit before preparing its replacement', async t => {
  const children = [], order = [];
  const client = createHandClient({ setting: () => ({ enabled: true }), built: () => true, watch: () => undefined,
    permissions: null, usage: null, prepare: async () => {
      order.push('prepare');
      if (children.length) assert.equal(children[0].lines.at(-1).hand, 'control-exit');
      return { status: 'ready', spawn() { const child = fakeChild(); children.push(child); return child; } };
    } });
  t.after(() => client.close()); client.send(frame()); await settle();
  const shared = await shareConsent(); shared.release();
  const old = children[0], write = old.stdio[3].write;
  old.stdio[3].write = line => { order.push(JSON.parse(line).hand); return write(line); };
  commitPause(old, true);
  old.stdout.emit('data', JSON.stringify({ hand: 'control-gone', nonce: old.menus[0].nonce }) + '\n');
  await settle();
  assert.deepEqual(order, ['prepare', 'control-exit', 'prepare']);
  assert.deepEqual(old.lines.at(-1), { hand: 'control-exit', nonce: old.menus[0].nonce });
  assert.equal(old.ended, true); assert.equal(old.killed, undefined);
  assert.equal(children.length, 2);
  assert.equal(children[1].lines.find(f => f.phase === 'restore').paused, true);
});
test('a failed paused host respawn preserves pause and exposes the recovery result', async t => {
  const child = fakeChild(), values = []; let prepares = 0;
  const client = createHandClient({ setting: () => ({ enabled: true }), built: () => true, watch: () => undefined,
    permissions: null, usage: null, onPause: value => values.push(value), prepare: async () => ++prepares === 1
      ? { status: 'ready', spawn: () => child } : { status: 'unavailable' } });
  t.after(() => client.close()); client.send(frame()); await settle(); commitPause(child, true);
  child.exitCode = 1; child.emit('exit', 1); await settle();
  assert.equal(prepares, 2); assert.equal(client.controlLost, true); assert.deepEqual(values, [true]);
});
for (const acknowledge of [true, false]) test(`paused replacement must acknowledge restored state: ${acknowledge}`, async t => {
  const children = [], values = [];
  const client = createHandClient({ setting: () => ({ enabled: true }), built: () => true, watch: () => undefined,
    permissions: null, usage: null, onPause: value => values.push(value), prepare: async () => ({ status: 'ready', spawn() {
      const child = fakeChild(); children.push(child); return child;
    } }) });
  t.after(() => client.close()); client.send(frame()); await settle(); commitPause(children[0], true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  children[0].exitCode = 1; children[0].emit('exit', 1); await settle();
  const replacement = children[1], restore = replacement.lines.find(f => f.phase === 'restore');
  if (acknowledge) pauseEvent(replacement, 'restored', true, restore.token);
  t.mock.timers.tick(500); assert.equal(client.controlLost, !acknowledge); assert.deepEqual(values, [true]);
  t.mock.timers.reset();
});
test('no ack in 500 ms leaves admission running and an unconfirmed applied pause rolls back', async t => {
  const child = fakeChild(), values = [];
  const client = createHandClient({ setting: () => ({ enabled: true }), built: () => true, watch: () => undefined,
    permissions: null, usage: null, onPause: value => values.push(value), prepare: async () => ({ status: 'ready', spawn: () => child }) });
  t.after(() => client.close()); client.send(frame()); await settle();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pauseEvent(child, 'request', true); t.mock.timers.tick(500);
  assert.deepEqual(values, []); assert.equal(child.lines.at(-1).phase, 'aborted');
  pauseEvent(child, 'commit', true); assert.deepEqual(values, [], 'late commit is discarded');
  pauseEvent(child, 'request', true, '2'.repeat(32)); pauseEvent(child, 'commit', true, '2'.repeat(32));
  assert.deepEqual(values, [true]); t.mock.timers.tick(500); assert.deepEqual(values, [true, false]);
  t.mock.timers.reset();
});
test('foreground actions wait for clear, then send a direct hide at 100 ms without ending a slow shared host', async t => {
  const h = harness(); t.after(() => h.client.close()); h.client.send(frame()); await settle();
  const child = h.children[0];
  const waiting = h.client.clearForAction(), request = child.lines.at(-1);
  child.stdout.emit('data', JSON.stringify({ hand: 'clear-ready', nonce: 'b'.repeat(64), token: request.token }) + '\n');
  child.stdout.emit('data', JSON.stringify({ hand: 'clear-ready', nonce: request.nonce, token: request.token }) + '\n');
  assert.equal(await waiting, true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = await shareConsent(); shared.release();
  const timeout = h.client.clearForAction();
  child.stdin.writableLength = 70000;
  t.mock.timers.tick(100); assert.equal(await timeout, false);
  assert.equal(child.lines.at(-1).hand, 'hide'); assert.equal(child.killed, undefined);
  assert.equal(child.ended, false); assert.equal(child.stdio[3].destroyed, undefined); assert.equal(h.client.enabled, true);
  child.stdin.writableLength = 0;
  const later = h.client.clearForAction(), next = child.lines.at(-1);
  child.stdout.emit('data', JSON.stringify({ hand: 'clear-ready', nonce: next.nonce, token: next.token }) + '\n');
  assert.equal(await later, true); assert.equal(h.children.length, 1); t.mock.timers.reset();
});
test('a backpressured clear waits for drain and the matching host acknowledgment', async t => {
  const h = harness(); t.after(() => h.client.close()); h.client.send(frame()); await settle();
  const child = h.children[0], write = child.stdin.write.bind(child.stdin);
  child.stdin.write = line => { write(line); return false; };
  let result;
  const waiting = h.client.clearForAction().then(value => { result = value; });
  await tick(); assert.equal(result, undefined);
  const request = child.lines.at(-1);
  child.stdout.emit('data', JSON.stringify({ hand: 'clear-ready', nonce: request.nonce, token: request.token }) + '\n');
  await tick(); assert.equal(result, undefined);
  child.stdin.emit('drain'); await waiting; assert.equal(result, true);
  assert.equal(child.stdin.listenerCount('drain'), 0);
});
test('backpressure without drain stays bounded and sends hide without killing the host', async t => {
  const h = harness(); t.after(() => h.client.close()); h.client.send(frame()); await settle();
  const child = h.children[0], write = child.stdin.write.bind(child.stdin);
  child.stdin.write = line => { write(line); return false; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let result;
  const waiting = h.client.clearForAction().then(value => { result = value; });
  t.mock.timers.tick(99); await tick(); assert.equal(result, undefined);
  t.mock.timers.tick(1); await waiting; assert.equal(result, false);
  assert.equal(child.lines.at(-1).hand, 'hide'); assert.equal(child.killed, undefined);
  assert.equal(child.stdin.listenerCount('drain'), 0); assert.equal(h.client.enabled, true); t.mock.timers.reset();
});
test('a thrown clear write is a real failure and settles without waiting for drain', async t => {
  const h = harness(); t.after(() => h.client.close()); h.client.send(frame()); await settle();
  h.children[0].stdin.write = () => { throw Object.assign(Error('closed pipe'), { code: 'EPIPE' }); };
  assert.equal(await h.client.clearForAction(), false);
  assert.equal(h.client.enabled, false);
});
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
// A fake shared host: act and hide frames land in lines, menu frames in menus, and stdout and fds 3 and 4 are streams.
function fakeChild(pid = 4242, consent = true) {
  const child = new EventEmitter(), lines = [], menus = [];
  child.pid = pid; child.ended = false;
  child.stdin = Object.assign(new EventEmitter(), {
    writableLength: 0,
    write(text) { for (const line of text.trimEnd().split('\n').map(line => JSON.parse(line))) { (line.hand === 'menu' ? menus : lines).push(line); } return true; },
    end() { child.ended = true; },
  });
  child.stdout = new EventEmitter();
  child.kill = () => { child.killed = true; };
  child.stdio = [child.stdin, child.stdout, null, ...consent ? [Object.assign(new EventEmitter(), { name: 'consent-in', write(text) { const line = JSON.parse(text); lines.push(line); queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ hand: 'consent-ready', nonce: line.nonce, token: line.token }) + '\n')); }, destroy() { this.destroyed = true; } }),
    Object.assign(new EventEmitter(), { name: 'consent-out', destroy() { this.destroyed = true; } })] : []];
  child.lines = lines; child.menus = menus;
  return child;
}
function harness({ enabled = true, built = true, capture = 'hidden', style, result, now, setHand, killAfterMs, permissions = null, usage = null, currentApp = () => undefined, watch = () => undefined } = {}) {
  const children = [], traces = [], spawns = [];
  let preparing = 0, setting = { enabled, capture, style };
  const client = createHandClient({
    setting: () => setting, built: () => built, now, watch, setHand, permissions, usage, currentApp, ...killAfterMs ? { killAfterMs } : {},
    prepare: async () => { preparing++; return result ?? { status: 'ready', spawn: options => { spawns.push(options); const c = fakeChild(4242 + children.length, options?.consent); children.push(c); return c; } }; },
    trace: (direction, detail) => traces.push([direction, detail]),
  });
  return { client, children, traces, spawns, preparing: () => preparing, set: next => { setting = next; } };
}
const frame = (over = {}) => ({ kind: 'click', pid: 501, windowId: 77, at: [10.123, 20], path: [[0, 0], [10.123, 20]], ...over });

test('public narration checks accept only the native host nonce and pending token, and cancellation drops late replies', async t => {
  const h = harness({ style: 'ring' }); t.after(() => h.client.close());
  const answered = [];
  h.client.checkNarration(value => answered.push(value)); assert.deepEqual(answered, [false]);
  h.client.send(frame()); await settle(); answered.length = 0;
  const child = h.children[0];
  h.client.checkNarration(value => answered.push(value)); const request = child.lines.at(-1);
  assert.deepEqual(Object.keys(request).sort(), ['hand', 'nonce', 'token']);
  const reply = value => child.stdout.emit('data', JSON.stringify({ ...request, secure: false, ...value }) + '\n');
  reply({ nonce: 'f'.repeat(64) }); reply({ token: 'f'.repeat(32) }); reply({ secure: 'false' });
  assert.deepEqual(answered, []); reply({ secure: true }); assert.deepEqual(answered, [false]);
  const cancel = h.client.checkNarration(value => answered.push(value)); cancel();
  child.stdout.emit('data', JSON.stringify({ ...child.lines.at(-1), secure: false }) + '\n');
  assert.deepEqual(answered, [false]);
  h.client.checkNarration(value => answered.push(value));
  child.stdout.emit('data', JSON.stringify({ ...child.lines.at(-1), secure: false }) + '\n');
  assert.deepEqual(answered, [false, true]);
});

test('ring host frames share one nonce and sequence, retain filtered labels, and pass the selected style to spawn', async t => {
  const h = harness({ style: 'seam' }); t.after(() => h.client.close());
  const record = { type: 'action', phase: 'aim', kind: 'click', point: [10, 20], rect: [1, 2, 30, 40], window: { pid: 501, id: 77 }, label: 'button' };
  h.client.cursor(record); h.client.send(frame({ label: 'button' }));
  for (const state of ['waiting', 'error', 'done', 'handback', 'thinking', 'idle']) h.client.cursor({ type: 'status', state });
  await settle();
  assert.equal(h.spawns[0].cursorStyle, 'seam');
  const lines = h.children[0].lines;
  assert.deepEqual(lines.map(l => l.hand), ['aim', 'act', 'status', 'status', 'status', 'status', 'status']);
  assert.equal(lines[0].holdMs, 0); assert.deepEqual(lines[0].rect, record.rect); assert.equal(lines[1].label, 'button');
  assert.deepEqual(lines.map(l => l.seq), [1, 2, 3, 4, 5, 6, 7]); assert.ok(lines.every(l => l.nonce === lines[0].nonce));
});
test('glove sends no new frames or labels, and a targetless status cannot start a host', async t => {
  const h = harness(); t.after(() => h.client.close());
  h.client.cursor({ type: 'status', state: 'waiting' });
  h.client.cursor({ type: 'action', phase: 'aim', kind: 'click', point: [1, 2], window: { pid: 501, id: 77 } });
  await settle(); assert.equal(h.children.length, 0);
  h.client.send(frame({ label: 'button' })); await settle(); assert.equal(h.children[0].lines[0].label, undefined);
});

test('send and hide return at once without a promise, and the host gets exact nonce-bound frames with rising seq', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  assert.equal(h.client.enabled, true);
  assert.equal(h.client.send(frame({ text: 'secret', app: 'Fixture' })), undefined);
  assert.equal(h.children.length, 0, 'the spawn happens off the caller\'s path');
  await settle();
  assert.equal(h.children.length, 1);
  h.client.send(frame({ kind: 'drag', delayMs: 470.4, beats: 2 }));
  assert.equal(h.client.hide(), undefined);
  const [first, second, hide] = h.children[0].lines;
  assert.match(first.nonce, /^[0-9a-f]{64}$/);
  assert.deepEqual(first, { hand: 'act', nonce: first.nonce, seq: 1, kind: 'click', pid: 501, windowId: 77, at: [10.12, 20], path: [[0, 0], [10.12, 20]], delayMs: 0, beats: 1 });
  assert.deepEqual(Object.keys(first), ['hand', 'nonce', 'seq', 'kind', 'pid', 'windowId', 'at', 'path', 'delayMs', 'beats']);
  assert.deepEqual([second.seq, second.kind, second.delayMs, second.beats, second.nonce], [2, 'drag', 470, 2, first.nonce]);
  assert.deepEqual(hide, { hand: 'hide', nonce: first.nonce });
  assert.deepEqual(h.spawns, [{ capture: 'hidden', consent: true }]);
});

test('the host pid is set while the host runs and cleared when it ends; a dead host only traces and is not respawned', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  h.client.send(frame()); await settle();
  assert.equal(handPid(), 4242);
  h.children[0].emit('exit', 65, null);
  assert.equal(handPid(), 0);
  assert.deepEqual(h.traces.find(([d]) => d === 'hand-off'), ['hand-off', { reason: 'exit', code: 65, signal: null }]);
  assert.equal(h.client.enabled, false);
  h.client.send(frame()); h.client.hide(); await settle();
  assert.equal(h.children.length, 1); assert.equal(h.children[0].lines.length, 1);
});

test('a cold build starts the hand in the same session without blocking sends', async t => {
  t.after(() => setHandPid(0));
  const h = harness({ built: false });
  t.after(() => h.client.close());
  h.client.send(frame()); await settle();
  assert.equal(h.preparing(), 1); assert.equal(h.children.length, 1);
  assert.equal(h.client.enabled, true);
  assert.ok(h.traces.some(([d, detail]) => d === 'hand-building' && detail.reason === 'cold-cache'));
  assert.ok(h.traces.some(([d, detail]) => d === 'hand-built' && detail.status === 'ready'));
  h.client.send(frame()); await settle();
  assert.equal(h.preparing(), 1); assert.equal(h.children.length, 1);
});

test('turbo falls back immediately during a cold build, which later starts one shared host', async t => {
  t.after(() => setHandPid(0));
  let finish, options, spawns = 0;
  const traces = [], child = fakeChild();
  const client = createHandClient({ built: () => false, setting: () => ({ enabled: true }), watch: () => undefined,
    permissions: null, usage: null, prepare: value => { options = value; return new Promise(resolve => { finish = resolve; }); },
    trace: (direction, detail) => traces.push([direction, detail]) });
  t.after(() => client.close());
  assert.equal(await shareConsent(), undefined);
  await settle();
  assert.equal(typeof finish, 'function');
  assert.equal(await shareConsent(), undefined, 'a build does not hold turbo startup');
  options.onProgress({ stage: 'compile', helper: 'consent-host', compiler: 'swiftc' });
  assert.deepEqual(traces.at(-1), ['hand-build', { stage: 'compile', helper: 'consent-host', compiler: 'swiftc' }]);
  finish({ status: 'ready', spawn() { spawns++; return child; } });
  await settle();
  assert.equal(spawns, 1);
  assert.equal((await shareConsent()).pid, child.pid);
});

test('closing a cold build aborts compilation and traces the session ending without launching a host', async () => {
  let options, finish;
  const traces = [];
  const client = createHandClient({ built: () => false, setting: () => ({ enabled: true }), watch: () => undefined,
    permissions: null, usage: null, prepare: value => { options = value; return new Promise(resolve => { finish = resolve; }); },
    trace: (direction, detail) => traces.push([direction, detail]) });
  client.send(frame()); await settle();
  client.close();
  assert.equal(options.signal.aborted, true);
  assert.ok(traces.some(([d, m]) => d === 'hand-off' && m.reason === 'session-ended' && m.code === 'HAND_BUILD_CANCELLED'));
  finish({ status: 'ready', spawn: () => assert.fail('closed sessions never launch') });
  await settle();
});

test('frames that expired while compiling are dropped instead of replayed on the user desktop', async t => {
  t.after(() => setHandPid(0));
  let clock = 0, finish;
  const child = fakeChild(), traces = [];
  const client = createHandClient({ built: () => false, setting: () => ({ enabled: true }), now: () => clock,
    watch: () => undefined, permissions: null, usage: null,
    prepare: () => new Promise(resolve => { finish = resolve; }), trace: (d, m) => traces.push([d, m]) });
  t.after(() => client.close());
  client.send(frame()); await settle(); clock = 10000;
  finish({ status: 'ready', spawn: () => child }); await settle();
  assert.equal(child.lines.length, 0);
  assert.ok(traces.some(([d, m]) => d === 'hand-dropped' && m.reason === 'build-delay'));
  client.send(frame()); assert.equal(child.lines.length, 1);
});

test('the hand off: no build, no spawn and no writes', async () => {
  const h = harness({ enabled: false });
  assert.equal(h.client.enabled, false);
  h.client.send(frame()); h.client.hide(); await settle();
  assert.equal(h.preparing(), 0); assert.equal(h.children.length, 0);
});

test('an unavailable build, a throwing spawn, a broken pipe and backpressure only trace', async t => {
  t.after(() => setHandPid(0));
  const unavailable = harness({ result: { status: 'unavailable', code: 'HOST_BUILD_BUSY' } });
  unavailable.client.send(frame()); await settle();
  assert.deepEqual(unavailable.traces.at(-1), ['hand-off', { reason: 'unavailable', code: 'HOST_BUILD_BUSY' }]);
  const throwing = harness({ result: { status: 'ready', spawn: () => { throw Error('HOST_PACKAGE_MISMATCH'); } } });
  throwing.client.send(frame()); await settle();
  assert.deepEqual(throwing.traces.at(-1), ['hand-off', { reason: 'spawn', code: 'HOST_PACKAGE_MISMATCH' }]);
  const broken = harness(); t.after(() => broken.client.close());
  broken.client.send(frame()); await settle();
  broken.children[0].stdin.emit('error', Object.assign(Error('pipe'), { code: 'EPIPE' }));
  assert.deepEqual(broken.traces.at(-1), ['hand-off', { reason: 'pipe', code: 'EPIPE' }]);
  assert.equal(broken.client.enabled, false);
  const h = harness(); t.after(() => h.client.close());
  h.client.send(frame()); await settle();
  h.children[0].stdin.writableLength = 70000; h.client.send(frame());
  assert.deepEqual(h.traces.at(-1), ['hand-dropped', { reason: 'backpressure' }]);
  h.children[0].stdin.write = () => { throw Object.assign(Error('closed'), { code: 'ERR_STREAM_DESTROYED' }); };
  h.children[0].stdin.writableLength = 0;
  assert.doesNotThrow(() => h.client.send(frame()));
  assert.doesNotThrow(() => h.client.hide());
});

test('frames the host would refuse are dropped with a reason, and long paths, delays and beats are fitted to the host\'s limits', () => {
  for (const [over, reason] of [[{ kind: 'hover' }, 'kind'], [{ pid: 0 }, 'target'], [{ pid: true }, 'target'], [{ windowId: 2 ** 32 }, 'target'],
    [{ at: [NaN, 1] }, 'target'], [{ at: [1] }, 'target'], [{ at: [200000, 0] }, 'target'], [{ path: [[0, 0], [0, '1']] }, 'path'], [{ path: 'x' }, 'path']]) {
    assert.equal(handWireFrame(frame(over)), reason, JSON.stringify(over));
  }
  assert.equal(handWireFrame(null), 'kind');
  const long = handWireFrame(frame({ path: Array.from({ length: 500 }, (_, i) => [i, i]), delayMs: 99999, beats: 50 }));
  assert.equal(long.path.length, 64); assert.deepEqual([long.path[0], long.path[63]], [[0, 0], [499, 499]]);
  assert.deepEqual([long.delayMs, long.beats], [10000, 20]);
  assert.deepEqual(handWireFrame({ kind: 'key', pid: 1, windowId: 1, at: [5, 6] }).path, [[5, 6]]);
  assert.deepEqual(handWireFrame(frame({ path: [], delayMs: -5, beats: 0 })), { ...handWireFrame(frame({ path: [[10.123, 20]] })), delayMs: 0, beats: 1 });
  const h = harness();
  h.client.send(frame({ kind: 'hover' }));
  assert.deepEqual(h.traces, [['hand-dropped', { reason: 'kind' }]]);
});

test('frames queued while the host starts keep their timing: the wait comes off delayMs', async t => {
  t.after(() => setHandPid(0));
  let clock = 1000;
  const h = harness({ now: () => clock });
  h.client.send(frame({ delayMs: 500 })); clock += 120;
  h.client.send(frame({ delayMs: 50 }));
  await settle();
  assert.deepEqual(h.children[0].lines.map(line => [line.seq, line.delayMs]), [[1, 380], [2, 50]]);
});

test('close ends the host\'s stdin and the session stops sending', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  h.client.send(frame()); await settle();
  h.client.close();
  assert.equal(h.children[0].ended, true); assert.equal(h.client.enabled, false);
  h.children[0].emit('exit', 0, null);
  assert.equal(handPid(), 0);
  h.client.send(frame()); await settle();
  assert.equal(h.children[0].lines.length, 1);
});

test('the host starts with a menu frame, and the minute\'s reread updates it: off hides and keeps the shared host, capture changes in place', async t => {
  t.after(() => setHandPid(0));
  let clock = 0;
  const h = harness({ now: () => clock });
  h.client.send(frame()); await settle();
  const [first] = h.children[0].menus;
  assert.deepEqual(Object.keys(first), ['hand', 'nonce', 'enabled', 'capture', 'version']);
  assert.deepEqual([first.enabled, first.capture, first.nonce], [true, 'hidden', h.children[0].lines[0].nonce]);
  assert.match(first.version, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  h.set({ enabled: false, capture: 'hidden' });
  clock = 30000; h.client.send(frame()); await settle();
  assert.equal(h.children[0].menus.length, 1, 'no reread inside the minute');
  clock = 61000; h.client.send(frame()); await settle();
  assert.deepEqual(h.children[0].lines.at(-1), { hand: 'hide', nonce: first.nonce });
  assert.equal(h.children[0].menus.at(-1).enabled, false);
  assert.equal(h.children[0].ended, false, 'turbo may still use the shared host'); assert.equal(h.client.enabled, false);
  const sent = h.children[0].lines.length;
  h.client.send(frame()); await settle();
  assert.equal(h.children[0].lines.length, sent, 'no act frames while the hand is off');
  h.set({ enabled: true, capture: 'visible' });
  clock = 122000; h.client.send(frame()); await settle();
  assert.equal(h.client.enabled, true);
  assert.deepEqual([h.children[0].menus.at(-1).enabled, h.children[0].menus.at(-1).capture], [true, 'visible']);
  h.client.send(frame()); await settle();
  assert.equal(h.children.length, 1, 'one host for the session'); assert.equal(h.children[0].lines.at(-1).hand, 'act');
});

test('a change to the settings folder (the menu row or the hand command) hides this session\'s hand at once', async t => {
  t.after(() => setHandPid(0));
  let fire, closed = 0, setting = { enabled: true }, watched;
  const children = [];
  const client = createHandClient({ setting: () => setting, built: () => true, now: () => 0,
    watch: (folder, listener) => { watched = folder; fire = listener; return { close() { closed++; }, unref() {} }; },
    prepare: async () => ({ status: 'ready', spawn: () => { const c = fakeChild(); children.push(c); return c; } }) });
  assert.match(watched, /Library\/Application Support\/sleight$/);
  client.send(frame()); await settle();
  setting = { enabled: false };
  fire('rename', 'hand.json'); await settle();
  assert.equal(children[0].lines.at(-1).hand, 'hide', 'no wait for the minute');
  assert.equal(children[0].menus.at(-1).enabled, false);
  assert.equal(client.enabled, false);
  fire('change', 'turbo.json'); await settle();
  setting = { enabled: true };
  fire('rename', 'hand.json'); await settle();
  assert.equal(client.enabled, true);
  client.close(); assert.equal(closed, 1);
});

test('the Ghost Hand toggle reaches the relay on the host\'s stdout, nonce-bound, and writes the setting', async t => {
  t.after(() => setHandPid(0));
  const writes = [];
  const h = harness({ setHand: async enabled => { writes.push(enabled); } });
  h.client.send(frame()); await settle();
  const { nonce } = h.children[0].menus[0], stdout = h.children[0].stdout;
  stdout.emit('data', Buffer.from(JSON.stringify({ hand: 'toggle', nonce, enabled: false }) + '\n'));
  await settle();
  assert.deepEqual(writes, [false]);
  // Split across chunks, it still arrives once.
  const text = JSON.stringify({ hand: 'toggle', nonce, enabled: true }) + '\n';
  stdout.emit('data', Buffer.from(text.slice(0, 10))); stdout.emit('data', Buffer.from(text.slice(10)));
  await settle();
  assert.deepEqual(writes, [false, true]);
  for (const bad of [{ hand: 'toggle', nonce: 'f'.repeat(64), enabled: false }, { hand: 'toggle', nonce, enabled: 'no' },
    { hand: 'toggle', nonce, enabled: false, extra: 1 }, { id: 'x', nonce, choice: 'once' }]) {
    stdout.emit('data', Buffer.from(JSON.stringify(bad) + '\n')); await settle();
  }
  stdout.emit('data', Buffer.from('not json\n')); await settle();
  assert.deepEqual(writes, [false, true], 'only exact toggles with this session\'s nonce count');
  assert.equal(h.traces.filter(([d]) => d === 'hand-toggle-refused').length, 5);
});

test('the sprite style\'s character result reaches the trace, nonce-bound, with the host\'s refusal reason', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  h.client.send(frame()); await settle();
  const { nonce } = h.children[0].menus[0], stdout = h.children[0].stdout;
  const event = more => ({ hand: 'character', nonce, id: 'fixture', loaded: false, reason: 'size', warnings: [], ...more });
  for (const e of [event(), event({ reason: 'sandbox' }), event({ loaded: true, reason: null, warnings: ['chroma fringe'] })]) stdout.emit('data', Buffer.from(JSON.stringify(e) + '\n'));
  await settle();
  assert.deepEqual(h.traces.filter(([d]) => d.startsWith('hand-character')),
    [['hand-character-refused', { id: 'fixture', reason: 'size' }], ['hand-character-refused', { id: 'fixture', reason: 'sandbox' }],
      ['hand-character', { id: 'fixture', warnings: ['chroma fringe'] }]]);
  // A foreign nonce, an unknown reason, a reason on success or an extra key is refused like any other bad event.
  for (const bad of [event({ nonce: 'f'.repeat(64) }), event({ reason: 'oops' }), event({ loaded: true }), event({ extra: 1 })]) {
    stdout.emit('data', Buffer.from(JSON.stringify(bad) + '\n')); await settle();
  }
  assert.equal(h.traces.filter(([d]) => d.startsWith('hand-character')).length, 3);
  assert.equal(h.traces.filter(([d]) => d === 'hand-toggle-refused').length, 4);
});

test('the first host is consent-capable and successive worker forks reuse its pid after exit and reset', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  h.client.send(frame()); await settle();
  assert.deepEqual(h.spawns, [{ capture: 'hidden', consent: true }]);
  const pipes = await shareConsent(); pipes.release();
  assert.equal(h.children.length, 1); assert.equal(handPid(), 4242);
  assert.notEqual(pipes.write.destroyed, true, 'the session retains its descriptors');
  await assert.rejects(shareConsent(), /HAND_CONSENT_IN_USE/, 'no simultaneous readers or fallback host');
  pipes.detached();
  assert.equal(h.children[0].lines.at(-1).hand, 'consent-reset', 'worker exit clears consent without another attach');
  const resets = h.children[0].lines.length;
  pipes.detached();
  assert.equal(h.children[0].lines.length, resets, 'detaching twice sends one reset');
  const again = await shareConsent(); again.release();
  assert.equal(h.children.length, 1); assert.equal(h.children[0].ended, false);
  assert.equal(again.write, pipes.write); assert.equal(again.read, pipes.read);
  assert.equal(h.children[0].lines.at(-1).hand, 'consent-reset');
  assert.equal(h.traces.filter(([d]) => d === 'hand-started').length, 1);
  h.client.send(frame()); await settle();
  assert.equal(h.children[0].lines.at(-1).hand, 'act');
  h.client.close();
});

test('turbo can fall back when the shared host cannot start or has exited', async t => {
  t.after(() => setHandPid(0));
  for (const options of [{ built: false }, { result: { status: 'unavailable', code: 'APPLE_TOOLS_MISSING' } },
    { result: { status: 'unavailable', code: 'HOST_COMPILE_FAILED' } },
    { result: { status: 'ready', spawn() { throw Error('SPAWN_FAILED'); } } }]) {
    const h = harness(options);
    try {
      assert.equal(await shareConsent(), undefined);
      assert.equal(await shareConsent(), undefined, 'a dead host still permits fallback');
    } finally { h.client.close(); }
  }
  const h = harness();
  h.client.send(frame()); await settle();
  h.children[0].emit('exit', 65, null);
  try { assert.equal(await shareConsent(), undefined); } finally { h.client.close(); }
});

test('a successor waits for the exit reset acknowledgement, and a failed reset permits fallback', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  t.after(() => h.client.close());
  const first = await shareConsent(), child = h.children[0];
  let reset;
  first.write.write = text => { reset = JSON.parse(text); };
  first.detached();
  let attached = false;
  const pending = shareConsent().then(pipes => { attached = true; return pipes; });
  await settle();
  assert.equal(attached, false, 'no worker may inherit an uncleared consent channel');
  child.stdout.emit('data', JSON.stringify({ hand: 'consent-ready', nonce: reset.nonce, token: reset.token }) + '\n');
  const second = await pending;
  assert.equal(second.pid, first.pid);
  second.write.write = () => { throw Error('EPIPE'); };
  second.detached();
  assert.equal(await shareConsent(), undefined);
  assert.equal(first.write.destroyed, true);
  assert.equal(first.read.destroyed, true);
});

test('turbo gets a host even with the hand off; a closed client shares nothing', async t => {
  t.after(() => setHandPid(0));
  const h = harness({ enabled: false });
  const pipes = await shareConsent();
  assert.equal(h.children.length, 1, 'started for turbo'); assert.equal(h.children[0].menus[0].enabled, false);
  pipes.release();
  h.client.close();
  assert.equal(await shareConsent(), undefined, 'a closed client shares nothing');
});

test('closing the hand client never kills a host turbo still uses', async t => {
  t.after(() => setHandPid(0));
  const h = harness({ killAfterMs: 10 });
  (await shareConsent()).release();
  h.client.close();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.children[0].ended, true, 'the hand channel ends'); assert.equal(h.children[0].killed, undefined, 'the host stays for turbo');
});

test('the launcher creates the session client before turbo\'s bridge can fork', () => {
  const launch = readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
  const run = launch.slice(launch.indexOf('export async function run('));
  assert.ok(run.indexOf('sessionHandClient(') > 0 && run.indexOf('sessionHandClient(') < run.indexOf('prepareInstalledStartup('), 'created first');
  assert.match(run, /process\.once\('exit', \(\) => hand\?\.close\(\)\)/);
});

test('the session\'s hand client is the integration point: one per process, none with SLEIGHT_HAND=0, and turbo\'s bridge forks onto its host', async t => {
  t.after(() => setHandPid(0));
  createHandClient({ setting: () => ({ enabled: false }), watch: () => undefined }).close(); // no earlier test's client stays current
  assert.equal(sessionHandClient({ env: { SLEIGHT_HAND: '0' } }), undefined);
  let watched = 0, prepared = 0;
  const off = { env: {}, setting: () => ({ enabled: false }), watch: () => { watched++; }, prepare: () => { prepared++; } };
  assert.equal(sessionHandClient(off), undefined);
  assert.equal(await shareConsent(), undefined);
  assert.deepEqual([watched, prepared], [0, 0], 'off creates no watcher or host');
  const children = [], options = { setting: () => ({ enabled: true }), built: () => true, watch: () => undefined,
    prepare: async () => ({ status: 'ready', spawn: spawnOptions => { const c = fakeChild(5000 + children.length, spawnOptions.consent); children.push(c); return c; } }) };
  const first = sessionHandClient(options);
  assert.equal(sessionHandClient(options), first, 'the relay and its hooks share one client');
  const { createV3Bridge, serveV3Worker } = await import('../plugins/sleight/lib/direct-browser/worker.mjs');
  const child = new EventEmitter(), endpoint = new EventEmitter();
  child.connected = endpoint.connected = true;
  child.send = value => { queueMicrotask(() => endpoint.emit('message', structuredClone(value))); };
  endpoint.send = value => { queueMicrotask(() => child.emit('message', structuredClone(value))); };
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const session = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin() { return null; } });
  let fork;
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker(_path, args, forkOptions) { fork = { args, stdio: forkOptions.stdio }; queueMicrotask(() => session.ready()); return child; } });
  try {
    assert.deepEqual(fork.args, ['--shared-ui', '--shared-hand-pid=' + children.at(-1).pid]);
    const before = children.at(-1).lines.length;
    child.emit('message', { version: 3, hand: frame() });
    assert.equal(children.at(-1).lines.length, before + 1, 'browser hand IPC uses the same host');
    assert.equal(fork.stdio[4], children.at(-1).stdio[3]); assert.equal(fork.stdio[5], children.at(-1).stdio[4]);
    assert.notEqual(children.at(-1).stdio[3].destroyed, true, 'retained for the session');
  } finally { await bridge.detach(); first.close(); }
  assert.notEqual(sessionHandClient(options), first, 'a closed session client is replaced');
  sessionHandClient(options).close();
});

test('the tools check asks xcode-select, never xcrun, and needs swiftc and clang under the developer folder', async () => {
  const calls = [];
  const run = dir => async (command, args, options) => { calls.push([command, args, options.env]); if (dir instanceof Error) throw dir; return { stdout: dir + '\n' }; };
  const tools = ['swiftc', 'clang'];
  const present = paths => path => paths.some(prefix => tools.some(tool => path === prefix + '/' + tool));
  assert.equal(await host.appleToolsPresent({ run: run('/Library/Developer/CommandLineTools'), exists: present(['/Library/Developer/CommandLineTools/usr/bin']) }), true);
  assert.deepEqual(calls[0], ['/usr/bin/xcode-select', ['-p'], { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }]);
  assert.equal(await host.appleToolsPresent({ run: run('/Applications/Xcode.app/Contents/Developer'),
    exists: present(['/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin']) }), true);
  assert.equal(await host.appleToolsPresent({ run: run(Object.assign(Error('unable to get active developer directory'), { code: 2 })), exists: () => true }), false);
  assert.equal(await host.appleToolsPresent({ run: run('relative/dir'), exists: () => true }), false);
  assert.equal(await host.appleToolsPresent({ run: run('/Library/Developer/CommandLineTools'), exists: path => path.endsWith('/swiftc') }), false);
  assert.ok(calls.every(([command]) => command === '/usr/bin/xcode-select'));
});

test('close kills a host that ignores the end of its input', async t => {
  t.after(() => setHandPid(0));
  const children = [];
  const client = createHandClient({ setting: () => ({ enabled: true }), built: () => true, killAfterMs: 10,
    prepare: async () => ({ status: 'ready', spawn: () => { const c = fakeChild(); c.kill = () => { c.killed = true; }; children.push(c); return c; } }) });
  client.send(frame()); await settle();
  client.close();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(children[0].ended, true); assert.equal(children[0].killed, true);
  // A host that exits on its own is not killed.
  const quiet = createHandClient({ setting: () => ({ enabled: true }), built: () => true, killAfterMs: 10,
    prepare: async () => ({ status: 'ready', spawn: () => { const c = fakeChild(); c.kill = () => { c.killed = true; }; c.stdin.end = () => { c.exitCode = 0; c.emit('exit', 0, null); }; children.push(c); return c; } }) });
  quiet.send(frame()); await settle();
  quiet.close();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(children[1].killed, undefined);
});

test('prepareHandHost builds through the helper pipeline and its handle starts only the hand, with the capture mode', { skip: process.platform !== 'darwin' && 'macOS only' }, async t => {
  const root = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-hand-build-')))));
  const sourceRoot = join(root, 'sources'), cacheRoot = join(root, 'cache');
  mkdirSync(sourceRoot, { mode: 0o700 });
  for (const name of ['peer-host.c', 'consent-host.swift']) writeFileSync(join(sourceRoot, name), 'source ' + name, { mode: 0o600 });
  let builds = 0;
  // Each fake helper writes its arguments next to itself.
  const compile = async ({ binary }) => { builds++; writeFileSync(binary, '#!/bin/sh\nprintf "%s" "$*" > "$0.args"\n', { mode: 0o700 }); };
  assert.equal(host.handHostBuilt({ cacheRoot, sourceRoot }), false);
  // Without Apple's command-line tools nothing compiles, so xcrun never gets to open macOS's install dialog.
  assert.deepEqual(await host.prepareHandHost({ cacheRoot, sourceRoot, compile, tools: async () => false }), { status: 'unavailable', code: 'APPLE_TOOLS_MISSING' });
  assert.equal(builds, 0);
  const ready = await host.prepareHandHost({ cacheRoot, sourceRoot, compile, tools: async () => true });
  assert.equal(ready.status, 'ready'); assert.equal(builds, 2);
  assert.deepEqual(Object.keys(ready).sort(), ['checkCharacter', 'spawn', 'status'], 'no receipt leaves the hand handle');
  assert.equal(host.handHostBuilt({ cacheRoot, sourceRoot }), true);
  // A hand-only host has the menu and no consent descriptors; one opened for turbo's fork has fds 3 and 4.
  // The cursor style goes before the terminal --menu or --consent, glove by default.
  for (const [options, args, descriptors] of [[undefined, '--hand --capture=hidden --cursor-style=glove --menu', 3],
    [{ capture: 'visible' }, '--hand --capture=visible --cursor-style=glove --menu', 3],
    [{ consent: true }, '--hand --capture=hidden --cursor-style=glove --consent', 5],
    [{ cursorStyle: 'ring' }, '--hand --capture=hidden --cursor-style=ring --menu', 3],
    [{ cursorStyle: 'sprite' }, '--hand --capture=hidden --cursor-style=sprite --menu', 3],
    [{ cursorStyle: 'seam', consent: true }, '--hand --capture=hidden --cursor-style=seam --consent', 5],
    [{ cursorStyle: 'glove', capture: 'visible' }, '--hand --capture=visible --cursor-style=glove --menu', 3]]) {
    const child = ready.spawn(options);
    assert.match(child.spawnfile, /\/consent-host$/, 'consent runs directly at normal priority');
    assert.equal(child.stdio.filter(Boolean).length, descriptors - 1, args);
    child.stdin.end();
    assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
    const key = createHash('sha256').update(JSON.stringify({ protocol: 1, arch: process.arch,
      sources: Object.fromEntries(['peer-host.c', 'consent-host.swift'].map(name => [name, createHash('sha256').update('source ' + name).digest('hex')])) })).digest('hex');
    assert.equal(readFileSync(join(cacheRoot, key, 'consent-host.args'), 'utf8'), args);
  }
  assert.throws(() => ready.spawn({ capture: 'readOnly' }), /HAND_CAPTURE_INVALID/);
  for (const cursorStyle of ['Ring', 'Sprite', '', null, 1]) assert.throws(() => ready.spawn({ cursorStyle }), /HAND_CURSOR_STYLE_INVALID/);
  // The cached build is reused without asking for the tools, and a changed source is a different build.
  assert.equal((await host.prepareHandHost({ cacheRoot, sourceRoot, compile, tools: async () => false })).status, 'ready'); assert.equal(builds, 2);
  writeFileSync(join(sourceRoot, 'consent-host.swift'), 'changed', { mode: 0o600 });
  assert.equal(host.handHostBuilt({ cacheRoot, sourceRoot }), false);
  assert.deepEqual(await host.prepareHandHost({ cacheRoot, sourceRoot: join(root, 'missing'), compile }), { status: 'unavailable', code: 'HOST_SOURCE_MISMATCH' });
});

// The menu's Permissions rows: a fake provider whose payload the test changes, and the clicks it receives.
function permissionRows() {
  const applied = [];
  let payload = { grants: [{ title: 'Fixture', detail: 'always', used: null, target: 'app:Fixture' }], blocked: [] };
  return { applied, set: next => { payload = next; },
    provider: { menu: async () => ({ payload, offered: new Set(payload.grants.map(g => g.target)) }), apply: async (event, offered) => { applied.push([event, [...offered]]); } } };
}

test('the first menu frame carries the Permissions rows, and a click with this nonce reaches the writer with what the menu offered', async t => {
  t.after(() => setHandPid(0));
  const rows = permissionRows(), h = harness({ permissions: rows.provider });
  h.client.send(frame()); await settle();
  assert.equal(h.children[0].menus.length, 1, 'one menu frame at start, rows included');
  const [first] = h.children[0].menus;
  assert.deepEqual(first.permissions, { grants: [{ title: 'Fixture', detail: 'always', used: null, target: 'app:Fixture' }], blocked: [] });
  const stdout = h.children[0].stdout, send = event => stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  rows.set({ grants: [], blocked: [] });
  send({ permissions: 'revoke', nonce: first.nonce, target: 'app:Fixture' }); await settle();
  assert.deepEqual(rows.applied, [[{ permissions: 'revoke', nonce: first.nonce, target: 'app:Fixture' }, ['app:Fixture']]]);
  assert.deepEqual(h.children[0].menus.at(-1).permissions, { grants: [], blocked: [] }, 'the rows are sent again after the click');
  for (const bad of [{ permissions: 'revoke', nonce: 'f'.repeat(64), target: 'app:Fixture' }, { permissions: 'unblock', nonce: first.nonce, target: 'x' },
    { permissions: 'revoke-all', nonce: first.nonce, target: 'x' }, { permissions: 'block', nonce: first.nonce }, { permissions: 'revoke', nonce: first.nonce, target: 7 }]) send(bad);
  await settle();
  assert.equal(rows.applied.length, 1, 'only exact events with this session\'s nonce reach the writer');
  assert.equal(h.traces.filter(([d]) => d === 'hand-toggle-refused').length, 5);
  send({ permissions: 'revoke-all', nonce: first.nonce }); await settle();
  assert.equal(rows.applied.length, 2);
  assert.equal(h.traces.filter(([d, detail]) => d === 'permissions-click').map(([, detail]) => detail.op).join(), 'revoke,revoke-all', 'traces name the op, never the app');
});

test('a new app to act in, a settings file change or the minute\'s reread sends fresh rows, and an unchanged payload sends nothing', async t => {
  t.after(() => setHandPid(0));
  let app, listener, clock = 0;
  const rows = permissionRows(), h = harness({ permissions: rows.provider, currentApp: () => app, now: () => clock, watch: (_folder, fn) => { listener = fn; } });
  h.client.send(frame()); await settle();
  assert.equal(h.children[0].menus.length, 1);
  h.client.send(frame()); await settle();
  assert.equal(h.children[0].menus.length, 1, 'same app, same rows: nothing sent');
  app = { bundleId: 'com.example.editor', name: 'Editor' };
  rows.set({ grants: [], blocked: [], current: { title: 'Editor', target: 'com.example.editor' } });
  h.client.send(frame()); await settle();
  assert.deepEqual(h.children[0].menus.at(-1).permissions.current, { title: 'Editor', target: 'com.example.editor' });
  rows.set({ grants: [], blocked: ['Editor'] });
  listener('rename', 'permissions.json'); await settle();
  assert.deepEqual(h.children[0].menus.at(-1).permissions.blocked, ['Editor']);
  const count = h.children[0].menus.length;
  listener('rename', 'used'); await settle();
  assert.equal(h.children[0].menus.length, count, 'a use stamp is not a settings change');
  rows.set({ grants: [{ title: 'Fixture', detail: 'always', used: 5, target: 'app:Fixture' }], blocked: ['Editor'] });
  clock = 61000; h.client.send(frame()); await settle();
  assert.equal(h.children[0].menus.at(-1).permissions.grants[0].used, 5, 'the minute\'s reread picks up a new last use');
});

test('without a provider the menu frame has no Permissions rows, and a permissions event is refused', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  h.client.send(frame()); await settle();
  const [first] = h.children[0].menus;
  assert.equal(Object.hasOwn(first, 'permissions'), false);
  h.children[0].stdout.emit('data', Buffer.from(JSON.stringify({ permissions: 'revoke-all', nonce: first.nonce }) + '\n')); await settle();
  assert.equal(h.traces.filter(([d]) => d === 'hand-toggle-refused').length, 1);
});

test('the menu frame carries the action log\'s last 7 days once read, after the host starts, and again at most every five minutes', async t => {
  t.after(() => setHandPid(0));
  let clock = 0, reads = 0, release, next = { native: 1.5, turbo: 0.6, saved: 6 };
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ now: () => clock, usage: async () => { reads++; if (reads === 1) await gate; return next; } });
  h.client.send(frame()); await settle();
  assert.equal(h.children.length, 1, 'the host starts without waiting for the log');
  assert.equal(Object.hasOwn(h.children[0].menus[0], 'usage'), false);
  release(); await settle();
  const usage = h.children[0].menus.at(-1);
  assert.deepEqual(Object.keys(usage), ['hand', 'nonce', 'enabled', 'capture', 'version', 'usage']);
  assert.deepEqual(usage.usage, { native: 1.5, turbo: 0.6, saved: 6 });
  next = { turbo: 1.2, saved: 7 };
  clock = 61000; h.client.send(frame()); await settle();
  assert.equal(reads, 1, 'the minute\'s recheck leaves the log alone inside five minutes');
  clock = 301000; h.client.send(frame()); await settle();
  assert.equal(reads, 2);
  assert.deepEqual(h.children[0].menus.at(-1).usage, { turbo: 1.2, saved: 7 });
  const sent = h.children[0].menus.length;
  clock = 602000; h.client.send(frame()); await settle();
  assert.equal(h.children[0].menus.length, sent, 'no new frame when nothing changed');
  for (const bad of [{ native: '1.2', saved: 7 }, { native: 1.2, saved: 7.5 }, { native: -1, saved: 7 }, { native: 1.2, saved: 7, turbo: Infinity },
    { saved: 7 }, { perAction: 1.2, saved: 7 }, null]) {
    next = bad; clock += 301000; h.client.send(frame()); await settle();
    assert.equal(Object.hasOwn(h.children[0].menus.at(-1), 'usage'), false, JSON.stringify(bad));
    next = { native: 1, saved: 1 }; clock += 301000; h.client.send(frame()); await settle();
  }
});

test('with the action log off the menu frame has no usage, and a failing read only leaves it out', async t => {
  t.after(() => setHandPid(0));
  for (const usage of [async () => undefined, async () => { throw Error('EACCES'); }]) {
    const h = harness({ usage });
    h.client.send(frame()); await settle();
    assert.ok(h.children[0].menus.every(menu => !Object.hasOwn(menu, 'usage')));
    h.client.close();
  }
});


test('checkCharacterInHost sends one frame to --check-character and returns only an exact result', async () => {
  const { EventEmitter } = await import('node:events');
  const fake = (reply, code = 0, { silent = false } = {}) => (binary, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { setEncoding() {} }), kill: () => { child.killed = true; },
      stdin: Object.assign(new EventEmitter(), { end: text => { child.sent = { binary, args, opts, text }; if (!silent) setImmediate(() => { child.stdout.emit('data', reply); child.emit('close', code); }); } }) });
    fake.last = child; return child;
  };
  const frame = { hand: 'character', id: 'pet' }, result = { id: 'pet', loaded: false, reason: 'size', warnings: [] };
  assert.deepEqual(await host.checkCharacterInHost('/bin/host', frame, { run: fake(JSON.stringify(result) + '\n') }), result);
  assert.deepEqual(fake.last.sent.args, ['--check-character']); assert.equal(fake.last.sent.text, JSON.stringify(frame) + '\n');
  assert.deepEqual(Object.keys(fake.last.sent.opts.env).sort(), ['LANG', 'PATH', 'SLEIGHT_CONSENT_ICON'], 'the test bank switch never reaches it');
  await assert.rejects(host.checkCharacterInHost('/bin/host', frame, { run: fake(JSON.stringify({ ...result, extra: 1 }) + '\n') }), /CHARACTER_CHECK_FAILED/);
  await assert.rejects(host.checkCharacterInHost('/bin/host', frame, { run: fake('', 65) }), /CHARACTER_CHECK_FAILED/);
  await assert.rejects(host.checkCharacterInHost('/bin/host', frame, { run: fake('', 0, { silent: true }), timeoutMs: 20 }), /CHARACTER_CHECK_TIMEOUT/);
  assert.equal(fake.last.killed, true);
});

// A VC3-shaped installed character for the relay tests: 19 resolved states on one 512x192 sheet, and a resolver.
const spriteStates = ['idle', 'move', 'aim', 'click', 'double-click', 'right-click', 'type', 'key', 'scroll-up', 'scroll-down', 'drag-grab', 'drag-carry',
  'drag-drop', 'waiting-approval', 'error', 'success', 'thinking', 'handoff', 'working'];
const testSprite = () => {
  const resolved = spriteStates.map(state => ({ state, sheet: 'sheet.png', row: 0, start: 0, frames: 1, ms: [100], loop: false, flip: false, hotspot: { x: 32, y: 32 }, repeat: 1 }));
  return { character: { manifest: { id: 'pet', sheet: 'sheet.png', frame: { w: 64, h: 64 }, scale: 0.5, states: {} }, folder: '/chars/pet',
    sheets: { sheet: { width: 512, height: 192 } }, resolved }, resolve: () => resolved };
};

test('cursorStyle is an optional spawn option and adds no wait to send', async t => {
  t.after(() => setHandPid(0));
  for (const cursorStyle of ['ring', 'seam', 'glove', 'sprite']) {
    const spawns = [], child = fakeChild();
    const client = createHandClient({ cursorStyle, character: 'pet', loadSprite: async () => testSprite(), setting: () => ({ enabled: true }), watch: () => undefined,
      permissions: null, usage: null, built: () => true,
      prepare: async () => ({ status: 'ready', spawn: options => { spawns.push(options); return child; } }) });
    t.after(() => client.close());
    assert.equal(client.send(frame()), undefined);
    assert.equal(spawns.length, 0);
    await settle();
    assert.deepEqual(spawns, [{ capture: 'hidden', consent: true, cursorStyle }]);
  }
  assert.throws(() => createHandClient({ cursorStyle: 'unknown' }), /HAND_CURSOR_STYLE_INVALID/);
});

test('sprite sends the installed character after the menu, and falls back to the ring with one trace line', async t => {
  t.after(() => setHandPid(0));
  // From the option or from the settings' style and character, the host runs sprite and gets one character frame first.
  for (const options of [{ cursorStyle: 'sprite', character: 'pet' }, { setting: () => ({ enabled: true, style: 'sprite', character: 'pet' }) }]) {
    const spawns = [], child = fakeChild(), asked = [];
    const client = createHandClient({ setting: () => ({ enabled: true }), ...options, loadSprite: async id => { asked.push(id); return testSprite(); },
      watch: () => undefined, permissions: null, usage: null, built: () => true,
      prepare: async () => ({ status: 'ready', spawn: spawnOptions => { spawns.push(spawnOptions); return child; } }) });
    t.after(() => client.close());
    client.send(frame({ label: 'Save' })); await settle();
    assert.equal(spawns[0].cursorStyle, 'sprite'); assert.deepEqual(asked, ['pet']);
    const [sprite, sent, act] = child.lines;
    assert.deepEqual([sprite.hand, sprite.id, sprite.seq, sprite.nonce], ['character', 'pet', 1, child.menus[0].nonce]);
    // A2: the sprite's perch and lines settings follow the character, off and on by default.
    assert.deepEqual(sent, { hand: "picker", nonce: sprite.nonce, op: "options", perch: false, lines: true });
    assert.deepEqual(Object.keys(sprite).sort(), ['cell', 'extra', 'hand', 'id', 'nonce', 'seq', 'sheet', 'table']);
    assert.equal(sprite.sheet, '/chars/pet/sheet.png'); assert.equal(sprite.table.idle.scale, 0.5);
    assert.deepEqual([act.hand, act.seq, act.label], ['act', 2, 'Save']);
    client.close();
  }
  // No character, a character VC3 refuses, or one too large to draw: the ring, and one hand-sprite-fallback line.
  const tooLarge = () => { const s = testSprite(); s.character.sheets.sheet = { width: 2048, height: 192 }; s.character.manifest.frame = { w: 256, h: 64 }; return s; };
  for (const [character, loadSprite, reason] of [[undefined, async () => testSprite(), 'CHARACTER_NOT_SET'],
    ['pet', async () => { throw Error('Character: "/chars/pet/character.json" manifest: invalid'); }, 'CHARACTER_INVALID'],
    ['pet', async () => tooLarge(), 'CHARACTER_INVALID']]) {
    const spawns = [], child = fakeChild(), traces = [];
    const client = createHandClient({ cursorStyle: 'sprite', ...character ? { character } : {}, loadSprite, setting: () => ({ enabled: true }), trace: (d, detail) => traces.push([d, detail]),
      watch: () => undefined, permissions: null, usage: null, built: () => true,
      prepare: async () => ({ status: 'ready', spawn: spawnOptions => { spawns.push(spawnOptions); return child; } }) });
    t.after(() => client.close());
    client.send(frame({ label: 'Save' })); await settle();
    assert.equal(spawns[0].cursorStyle, 'ring');
    assert.deepEqual(traces.filter(([d]) => d === 'hand-sprite-fallback'), [['hand-sprite-fallback', { reason }]]);
    assert.ok(child.lines.every(l => l.hand !== 'character')); assert.equal(child.lines[0].label, 'Save', 'ring acts keep their label');
    client.close();
  }
  createHandClient({ setting: () => ({ enabled: false }), watch: () => undefined }).close();
  const traces = [], spawns = [];
  const base = { env: {}, built: () => true, watch: () => undefined, permissions: null, usage: null, trace: (d, detail) => traces.push([d, detail]),
    prepare: async () => ({ status: 'ready', spawn: spawnOptions => { spawns.push(spawnOptions); return fakeChild(); } }) };
  const fallback = sessionHandClient({ ...base, setting: () => ({ enabled: true, style: 'Ring' }) });
  assert.ok(fallback, 'an invalid style still gives the session a hand');
  assert.deepEqual(traces, [['hand-style-invalid', { code: 'HAND_CURSOR_STYLE_INVALID' }]]);
  fallback.send(frame()); await settle();
  assert.deepEqual(spawns, [{ capture: 'hidden', consent: true, cursorStyle: 'glove' }]);
  fallback.close();
  assert.equal(sessionHandClient({ ...base, setting: () => { throw Error('read'); } }), undefined);
  const launch = readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
  assert.match(launch, /try \{\n\s+hand = \(await import\('\.\/hand\/client\.mjs'\)\)\.sessionHandClient\(/, 'the launcher wraps the call so the relay always starts');
});

test('host wire frames carry rect and caretX on acts, ok on done, and a move aim as click; preview aims drop silently', async t => {
  t.after(() => setHandPid(0));
  const target = { pid: 501, windowId: 77, at: [10, 20] };
  assert.deepEqual(handWireFrame({ ...target, kind: 'type', rect: [1, 2, 30, 40.456], caretX: 12.345 }),
    { kind: 'type', ...target, path: [[10, 20]], delayMs: 0, beats: 1, rect: [1, 2, 30, 40.46], caretX: 12.35 });
  const click = handWireFrame({ ...target, kind: 'click', caretX: 12, rect: [0, 0, 0, 4] });
  assert.equal(click.caretX, undefined, 'caretX is for type and key'); assert.equal(click.rect, undefined, 'an empty rect is dropped');
  assert.equal(handWireFrame({ ...target, kind: 'key', caretX: Infinity }).caretX, undefined);
  assert.deepEqual(handWireFrame({ hand: 'status', state: 'done', ok: true, ...target }), { hand: 'status', state: 'done', pid: 501, windowId: 77, at: [10, 20], ok: true });
  assert.equal(handWireFrame({ hand: 'status', state: 'error', ok: true, ...target }).ok, undefined, 'ok is for done only');
  assert.equal(handWireFrame({ hand: 'status', state: 'done', ok: 'yes', ...target }).ok, undefined);
  assert.equal(handWireFrame({ hand: 'aim', kind: 'move', ...target }).kind, 'click');
  assert.equal(handWireFrame({ hand: 'aim', kind: 'hover', ...target }), 'kind');
  const h = harness({ style: 'ring' }); t.after(() => h.client.close());
  h.client.cursor({ type: 'action', phase: 'aim', kind: 'click' });
  h.client.cursor({ type: 'action', phase: 'aim', kind: 'click', point: [1, 2] });
  h.client.cursor({ type: 'action', phase: 'aim', kind: 'move', point: [1, 2], window: { pid: 501, id: 77 } });
  h.client.send(frame({ kind: 'type', rect: [5, 6, 70, 20], caretX: 33 }));
  h.client.cursor({ type: 'status', state: 'done', call: 'a'.repeat(32) });
  h.client.cursor({ type: 'status', state: 'done' });
  await settle();
  assert.deepEqual(h.traces.filter(([d]) => d === 'hand-dropped'), [], 'aims without a point and window are not dropped frames');
  const lines = h.children[0].lines;
  assert.deepEqual(lines.map(l => [l.hand, l.kind ?? l.state]), [['aim', 'click'], ['act', 'type'], ['status', 'done'], ['status', 'done']]);
  assert.deepEqual([lines[1].rect, lines[1].caretX], [[5, 6, 70, 20], 33]);
  assert.equal(lines[2].ok, true, 'a call\'s done is its success'); assert.equal(lines[3].ok, undefined);
});

test('perch (A2): the character frame carries the perch keys only with perch on, and a flip resends it before the options', async t => {
  t.after(() => setHandPid(0));
  const sprite = () => {
    const s = testSprite(), state = { sheet: 'sheet.png', row: 0, columns: [0], ms: [100], loop: false, flip: false, hotspot: { x: 32, y: 32 } };
    s.character.perch = { anchor: { x: 32, y: 40 }, states: { perch: state } };
    return s;
  };
  let perch = false;
  const child = fakeChild();
  const client = createHandClient({ setting: () => ({ enabled: true, style: 'sprite', character: 'pet', perch }), loadSprite: async () => sprite(),
    watch: () => undefined, permissions: null, usage: null, built: () => true, recheckMs: 0,
    prepare: async () => ({ status: 'ready', spawn: () => child }) });
  t.after(() => client.close());
  client.send(frame({ label: 'Save' })); await settle();
  const first = child.lines.find(l => l.hand === 'character');
  assert.equal(first.perch, undefined); assert.equal(first.perchSheet, undefined);
  perch = true; child.lines.length = 0;
  client.send(frame({ label: 'Save' })); await settle();
  const [again, options] = child.lines.filter(l => l.hand === 'character' || l.op === 'options');
  assert.deepEqual([again.hand, Object.keys(again.perch.table), options.perch], ['character', ['perch'], true]);
  assert.ok(again.seq > first.seq);
});
