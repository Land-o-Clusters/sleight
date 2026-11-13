import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createHandClient } from '../plugins/sleight/lib/hand/client.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/driver-client.mjs';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { createDragViaDriver } from '../plugins/sleight/lib/drag-via-driver.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function variant(path, before, after, name) {
  const url = new URL(path, import.meta.url), source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before), 'missing mutation anchor: ' + before);
  const changed = source.replace(before, after).replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
    (_, prefix, quote, relative) => prefix + quote + new URL(relative, url).href + quote)
    .replace(/new URL\((['"])(\.[^'"]+)\1,\s*import.meta.url\)/g,
      (_, quote, relative) => `new URL(${JSON.stringify(new URL(relative, url).href)})`);
  return (await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64')))[name];
}
function hand(create = createHandClient, mode = 'ready') {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.pid = 999999; child.kill = () => {};
  let begin;
  child.stdin = new Writable({ write(bytes, _, done) {
    const row = JSON.parse(bytes); done();
    if (row.phase !== 'begin') return;
    begin = row;
    if (mode !== 'timeout') queueMicrotask(() => emit(mode));
  } });
  const emit = phase => child.stdout.write(JSON.stringify({ hand: begin.hand, nonce: begin.nonce, token: begin.token, phase }) + '\n');
  const client = create({ setting: () => ({ enabled: false }), permissions: null, usage: null, watch: () => undefined,
    built: () => true, prepare: async () => mode === 'start-failed' ? { status: 'unavailable' } : { status: 'ready', spawn: () => child } });
  return { client, child, emit };
}
const window = { pid: 42, windowId: '7' };
async function refusesStart(create = createHandClient) {
  const f = hand(create, 'start-failed');
  try {
    await assert.rejects(f.client.beginGlideStop(window, () => {}), error => {
      assert.equal(error.code, 'HAND_HOST_UNAVAILABLE');
      assert.match(error.message, /Glide engine.*Stop control.*unavailable/);
      assert.equal(error.delivery, 'not-sent'); return true;
    });
  } finally { f.client.close(); }
}
test('host startup failure refuses input with a person-facing explanation', () => refusesStart());
test('broken permissive startup is rejected', async () => {
  const create = await variant('../plugins/sleight/lib/hand/client.mjs',
    "if (!await ensure() || host !== 'running' || glideStop) throw glideStopFailure();",
    "if (!await ensure() || host !== 'running' || glideStop) return Object.assign(() => {}, { controlUnavailable: true });", 'createHandClient');
  await assert.rejects(refusesStart(create));
});
test('invalid binding, occupied control, failed write and ready timeout all refuse', async t => {
  for (const bad of [{}, { pid: 0, windowId: '7' }, { pid: 42, windowId: '0' }]) {
    const f = hand();
    try { await assert.rejects(f.client.beginGlideStop(bad, () => {}), { code: 'HAND_HOST_UNAVAILABLE' }); }
    finally { f.client.close(); }
  }
  const f = hand();
  try {
    const end = await f.client.beginGlideStop(window, () => {});
    await assert.rejects(f.client.beginGlideStop(window, () => {}), { code: 'HAND_HOST_UNAVAILABLE' }); end();
    f.child.stdin.write = () => { throw Error('broken pipe'); };
    await assert.rejects(f.client.beginGlideStop(window, () => {}), { code: 'HAND_HOST_UNAVAILABLE' });
  } finally { f.client.close(); }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = hand(createHandClient, 'timeout');
  try {
    const call = slow.client.beginGlideStop(window, () => {});
    const refused = assert.rejects(call, { code: 'HAND_HOST_UNAVAILABLE' });
    for (let i = 0; i < 10; i++) await tick();
    t.mock.timers.tick(1000); await refused;
  } finally { slow.client.close(); t.mock.timers.reset(); }
});
test('only the placement frame permits guarded input without a control', async () => {
  const f = hand(createHandClient, 'control-unavailable');
  try { const end = await f.client.beginGlideStop(window, () => {}); assert.equal(end.controlUnavailable, true); end(); }
  finally { f.client.close(); }
  const other = hand(createHandClient, 'unavailable');
  try { await assert.rejects(other.client.beginGlideStop(window, () => {}), { code: 'HAND_HOST_UNAVAILABLE' }); }
  finally { other.client.close(); }
});
for (const cause of ['death', 'close']) test(`host ${cause} mid-action reports a fault without person attribution`, async () => {
  const f = hand(); let stops = 0;
  try {
    const end = await f.client.beginGlideStop(window, () => { stops++; });
    if (cause === 'death') f.child.emit('exit', 65); else f.client.close();
    assert.equal((await end.failure).code, 'HAND_HOST_UNAVAILABLE');
    assert.equal(stops, 0); assert.equal(end.controlUnavailable, false); end();
  } finally { f.client.close(); }
});
async function collectionLatch(create = createOwnRuntime) {
  const runtime = create({ driver: { close() {}, restart() {}, userPrompt: () => true }, lease: { close() {}, release() {} } });
  try {
    runtime.safety.stop(); await runtime.stopEngine();
    assert.equal(runtime.safety.stop(), false, 'collection must preserve the existing Stop latch');
    assert.equal(runtime.safety.userPrompt(), true); assert.equal(runtime.safety.stop(), true);
  } finally { await runtime.close(); }
}
test('collecting a stopped runtime does not end its turn or clear its latch', () => collectionLatch());
test('broken collection clearing the latch is rejected', async () => {
  const create = await variant('../plugins/sleight/lib/runtime-select.mjs',
    'return { collected: true,', 'stopSession.userPrompt(); return { collected: true,', 'createOwnRuntime');
  await assert.rejects(collectionLatch(create), /collection must preserve the existing Stop latch/);
});
async function lateStop(create = createMacDriverClient) {
  let click, kills = 0;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { kills++; queueMicrotask(() => child.emit('close', 0)); };
  child.stdin = new Writable({ write(bytes, _, done) {
    const row = JSON.parse(bytes); done(); if (row.control) return;
    child.stdout.write(JSON.stringify({ protocol: row.protocol, platform: 'darwin', nonce: row.nonce, id: row.id, ok: true,
      result: row.method === 'ping' ? { protocol: row.protocol, apiVersion: 2, build: 'b'.repeat(64),
        methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS] } : { delivery: 'sent-unverified' } }) + '\n');
    if (row.method === 'click') click();
  } });
  const client = create({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn: () => child }),
    stopControl: { async begin(_, stop) { click = stop; return () => {}; } } });
  try {
    assert.equal((await client.request('click', { windowId: '7', processStart: '1.2', readId: 1, args: [1] })).delivery, 'sent-unverified');
    assert.equal(kills, 0, 'a completed action keeps its helper');
    await assert.rejects(client.request('click', { windowId: '7', processStart: '1.2', readId: 1, args: [1] }), { code: 'USER_STOPPED' });
  } finally { await client.close(); }
}
test('Stop after the successful reply latches input and preserves the result and helper', () => lateStop());
test('broken late-success retirement is rejected', async () => {
  const create = await variant('../plugins/sleight/lib/driver-client.mjs', 'if (userStopped && !operation.completed)', 'if (userStopped)', 'createMacDriverClient');
  await assert.rejects(lateStop(create));
});

async function preservedCollection(create = createOwnRuntime) {
  let restarts = 0;
  const runtime = create({ driver: { close() {}, restart() { restarts++; }, userPrompt: () => true,
    stopHeld() {}, stopAfterSuccess: true }, lease: { close() {}, release() {} } });
  try {
    runtime.safety.stop();
    assert.equal((await runtime.stopEngine()).helperRetained, true);
    assert.equal(restarts, 0, 'late Stop must keep the completed helper during collection');
    assert.equal(runtime.safety.stop(), false);
  } finally { await runtime.close(); }
}
test('runtime collection retains a helper after a late successful call', () => preservedCollection());
test('broken collection that restarts a completed helper is rejected', async () => {
  const create = await variant('../plugins/sleight/lib/runtime-select.mjs', 'if (!preserveStoppedHelper) return driver.restart();',
    'return driver.restart();', 'createOwnRuntime');
  await assert.rejects(preservedCollection(create), /late Stop/);
});

async function hostAdmission(create = createHandClient) {
  const f = hand(create, 'start-failed'); let inputs = 0;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', 0));
  child.stdin = new Writable({ write(bytes, _, done) {
    const row = JSON.parse(bytes); done(); if (row.control) return;
    if (row.method !== 'ping') inputs++;
    child.stdout.write(JSON.stringify({ protocol: row.protocol, platform: 'darwin', nonce: row.nonce, id: row.id, ok: true,
      result: { protocol: row.protocol, apiVersion: 2, build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS] } }) + '\n');
  } });
  const client = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn: () => child }),
    stopControl: { begin: (_, stop) => f.client.beginGlideStop(window, stop) } });
  try {
    await assert.rejects(client.request('click', { windowId: '7', processStart: '1.2', readId: 1, args: [1] }), error => {
      assert.equal(error.code, 'HAND_HOST_UNAVAILABLE');
      assert.match(formatMacDriverError(error), /HAND_HOST_UNAVAILABLE: The Glide engine refused input because its Stop control host is unavailable/);
      return true;
    });
    assert.equal(inputs, 0, 'host failure sends zero input requests');
  } finally { await client.close(); f.client.close(); }
}
test('real hand-to-driver admission refuses a failed host before input', () => hostAdmission());
test('broken hand admission cannot hide its failure in a model-only notice', async () => {
  const create = await variant('../plugins/sleight/lib/hand/client.mjs',
    "if (!await ensure() || host !== 'running' || glideStop) throw glideStopFailure();",
    "if (!await ensure() || host !== 'running' || glideStop) return Object.assign(() => {}, { controlUnavailable: true });", 'createHandClient');
  await assert.rejects(hostAdmission(create));
});

async function steppedRelease(t, create = createDragViaDriver) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = []; let click, started;
  const began = new Promise(resolve => { started = resolve; });
  const bound = { windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.fake', title: 'fixture', identityVerified: true };
  const holds = [{ button: 0, x: 10, y: 12 }, { key: 56 }];
  const run = create({ current() {}, bindings: async () => ({ source: bound }),
    driver: { resolveApp: async () => ({ app: { id: bound.bundleId, pid: 42, processStart: '1.2', running: true } }),
      verifyWindowIdentity: async () => ({ window: bound }),
      releasePostedInput: async (identity, retained) => {
        assert.deepEqual(identity, bound); assert.deepEqual(retained, holds); events.push('release'); return 'posted';
      } },
    beginStop: async (_, stop) => { click = stop; return () => {}; },
    runLocal: async (_, __, options) => {
      options.run('osascript', ['-l', 'JavaScript', fileURLToPath(new URL('../plugins/sleight/lib/drag.js', import.meta.url)), '{}'], {}, () => {});
      started(); return new Promise(() => {});
    } });
  const call = run('drag.js', { app: bound.bundleId, windowId: 7, from: [1, 1], to: [2, 2] }, {
    run: (_, args) => {
      const path = JSON.parse(args[5].match(/,("[^"]+")\);$/)[1]);
      writeFileSync(path + '.holds', JSON.stringify(holds));
      return { kill(signal) { events.push(signal); } };
    },
  });
  const refused = assert.rejects(call, error => {
    assert.equal(error.code, 'USER_STOPPED'); assert.equal(error.stopRelease, 'posted');
    assert.match(error.message, /OS delivery unconfirmed/); return true;
  });
  try {
    await began; click(); t.mock.timers.tick(400); await tick();
    assert.deepEqual(events, ['SIGSTOP', 'release'], 'release every recorded hold before retirement');
    t.mock.timers.tick(100); await refused;
    assert.deepEqual(events, ['SIGSTOP', 'release', 'SIGKILL']);
  } finally { t.mock.timers.tick(500); await refused.catch(() => {}); t.mock.timers.reset(); }
}
test('stepped backstop releases its held button and modifier before retiring its frozen child', steppedRelease);
test('broken stepped backstop that omits releases is rejected', async t => {
  const create = await variant('../plugins/sleight/lib/drag-via-driver.mjs',
    "stopRelease = await driver.releasePostedInput?.(source, holds) ?? 'unconfirmed';", "stopRelease = 'unconfirmed';", 'createDragViaDriver');
  await assert.rejects(steppedRelease(t, create), /release every recorded hold/);
});

test('a host lost during native input cancels remaining input and reports the host fault', async () => {
  const f = hand(); let started, controls = 0;
  const began = new Promise(resolve => { started = resolve; });
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let active;
  const reply = (row, error) => child.stdout.write(JSON.stringify({ protocol: row.protocol, platform: 'darwin', nonce: row.nonce,
    id: row.id, ok: !error, ...error ? { error } : { result: { protocol: row.protocol, apiVersion: 2, build: 'b'.repeat(64),
      methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS] } } }) + '\n');
  child.kill = () => queueMicrotask(() => child.emit('close', 0));
  child.stdin = new Writable({ write(bytes, _, done) {
    const row = JSON.parse(bytes); done();
    if (row.method === 'ping') reply(row);
    else if (row.control === 'stop') { controls++; reply(active, { code: 'USER_STOPPED', message: 'stopped', next: 'stop-tell-user',
      delivery: 'unknown', retry: 'read-first', unhealthy: false }); }
    else if (row.method) { active = row; started(); }
  } });
  const client = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn: () => child }),
    stopControl: { begin: (_, stop) => f.client.beginGlideStop(window, stop) } });
  try {
    const call = client.request('typeText', { windowId: '7', processStart: '1.2', readId: 1, args: ['text'] });
    const refused = assert.rejects(call, { code: 'HAND_HOST_UNAVAILABLE', delivery: 'unknown', retry: 'read-first' });
    await began; f.child.emit('exit', 65); await refused; assert.equal(controls, 1);
  } finally { await client.close(); f.client.close(); }
});

async function releasedBackstop(t, create = createMacDriverClient) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = []; let click, started;
  const began = new Promise(resolve => { started = resolve; });
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { events.push(signal); queueMicrotask(() => child.emit('close', 0)); };
  child.stdin = new Writable({ write(bytes, _, done) {
    const row = JSON.parse(bytes); done();
    if (row.method === 'ping') child.stdout.write(JSON.stringify({ protocol: row.protocol, platform: 'darwin', nonce: row.nonce, id: row.id,
      ok: true, result: { protocol: row.protocol, apiVersion: 2, build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS] } }) + '\n');
    if (row.method === 'typeText') started();
    if (row.control === 'stop') {
      events.push('mouse-up', 'key-up');
      child.stdout.write(JSON.stringify({ protocol: row.protocol, platform: 'darwin', nonce: row.nonce, control: 'released', release: 'posted' }) + '\n');
    }
  } });
  const client = create({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn: () => child }),
    stopControl: { async begin(_, stop) { click = stop; return () => {}; } } });
  const call = client.request('typeText', { windowId: '7', processStart: '1.2', readId: 1, args: ['text'] });
  let failure;
  const collected = call.catch(error => { failure = error; });
  try {
    await began; click();
    assert.deepEqual(events, ['mouse-up', 'key-up'], 'release posting precedes helper retirement');
    t.mock.timers.tick(500); await collected;
    assert.deepEqual(events, ['mouse-up', 'key-up', 'SIGKILL']);
    assert.equal(failure.stopRelease, 'posted');
    assert.match(formatMacDriverError(failure), /stopRelease=posted; OS delivery unconfirmed/);
  } finally { t.mock.timers.tick(500); await collected; await client.close(); t.mock.timers.reset(); }
}
test('native backstop reports confirmed posting separately from OS delivery before retirement', releasedBackstop);
test('broken native backstop that omits its release request is rejected', async t => {
  const create = await variant('../plugins/sleight/lib/driver-client.mjs',
    "if (operation.id !== undefined) sendStopControl(operation.g, 'stop', operation.id);", '', 'createMacDriverClient');
  await assert.rejects(releasedBackstop(t, create), /release posting precedes/);
});

function recordedHolds(broken = false) {
  const source = readFileSync(new URL('../plugins/sleight/lib/drag-via-driver.mjs', import.meta.url), 'utf8');
  let body = source.slice(source.indexOf('function installDragGuards('), source.indexOf('\nfunction guardedOptions(')).trim();
  if (broken) {
    assert.ok(body.includes('holds.set(id,'));
    body = body.replace('holds.set(id,', 'new Map().set(id,');
  }
  let recorded;
  const bridge = value => ({ writeToFileAtomicallyEncodingError() { recorded = JSON.parse(value); return true; } });
  Object.assign(bridge, { NSFileManager: { defaultManager: { fileExistsAtPath: () => false } }, NSUTF8StringEncoding: 4,
    CGEventGetType: event => event.type, CGEventGetIntegerValueField: (event, field) => field === 9 ? event.key : event.button,
    CGEventGetLocation: event => event.point ?? { x: 0, y: 0 } });
  const context = { $: bridge, dragHeldInput: null, dragStopChannel: null, findApp() {}, resolveWindow() {}, settleAfterTextWrite() {} };
  const install = vm.runInNewContext('(' + body + ')', context);
  install({ pid: 42 }, null, 'identity changed', 'fixture/stop');
  const post = event => { context.dragHeldInput(event, 42, false); context.dragHeldInput(event, 42, true); };
  post({ type: 1, button: 0, point: { x: 10, y: 12 } });
  post({ type: 10, key: 56 });
  post({ type: 25, button: 2, point: { x: 20, y: 22 } });
  assert.deepEqual(recorded, [{ button: 0, x: 10, y: 12 }, { key: 56 }, { button: 2, x: 20, y: 22 }], 'every attempted down is recorded');
  post({ type: 6, button: 0, point: { x: 30, y: 32 } });
  assert.deepEqual(recorded[0], { button: 0, x: 30, y: 32 });
  post({ type: 26, button: 2 }); post({ type: 11, key: 56 }); post({ type: 2, button: 0 });
  assert.deepEqual(recorded, []);
  assert.throws(() => context.dragHeldInput({ type: 1, button: 0 }, 99, false), /identity changed/);
}
test('the real stepped child records all held buttons and modifiers and clears only posted releases', () => recordedHolds());
test('broken child hold recording is rejected', () => assert.throws(() => recordedHolds(true), /every attempted down/));
