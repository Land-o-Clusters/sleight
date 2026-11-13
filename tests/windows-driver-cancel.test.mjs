import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createWindowsDriverClient } from '../plugins/sleight/lib/driver-client.mjs';
import { createDriverSafety } from '../plugins/sleight/lib/driver-safety.mjs';
import { runWindows } from '../plugins/sleight/lib/windows-launch.mjs';
import { windowsClipboardError } from '../plugins/sleight/lib/windows-driver/clipboard.mjs';
import { slowDriverHost } from './fixtures/windows-driver-slow-fake.mjs';
import { driverFixture } from './fixtures/driver-fake.mjs';
import { ACTION_METHODS } from '../plugins/sleight/lib/windows-driver/actions.mjs';
import { readFileSync } from 'node:fs';

const lib = new URL('../plugins/sleight/lib/', import.meta.url);
async function mutate(relative, change) {
  const url = new URL(relative, lib), original = readFileSync(url, 'utf8'), changed = change(original);
  assert.notEqual(changed, original, 'mutation must change its source');
  const absolute = changed.replace(/from (['"])(\.[^'"]+)\1/g,
    (_, quote, path) => 'from ' + quote + new URL(path, url).href + quote);
  return import('data:text/javascript;base64,' + Buffer.from(absolute).toString('base64'));
}

function clientFixture(t, scenario, factory = createWindowsDriverClient) {
  const host = slowDriverHost(t, scenario);
  const client = factory({ platform: 'win32', prepare: host.prepare, timeoutMs: 3000 });
  t.after(() => client.close());
  return { ...host, client };
}

async function cancelWitness(t, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'normal', factory);
  const action = h.client.request('typeText', { args: ['x'.repeat(1000)] });
  const stopped = assert.rejects(action, error => {
    assert.equal(error.code, 'USER_STOPPED'); assert.equal(error.reason, 'cancel');
    assert.equal(error.delivery, 'sent-unverified'); assert.equal(error.retry, 'read-first');
    assert.ok(error.typed > 0 && error.typed < 1000);
    return true;
  });
  const frame = await h.waitFor('typeText');
  await h.waitForEvent('progress');
  await Promise.all([h.client.cancel(), h.client.cancel()]);
  await stopped;
  const cancel = h.frames.filter(row => row.method === 'cancel');
  assert.equal(cancel.length, 1, 'concurrent cancellation sends one frame per job');
  assert.deepEqual(cancel[0].params, { id: frame.id });
  assert.ok(cancel[0].id > frame.id);
  const status = await h.client.ping();
  assert.equal(status.cleanup, 1); assert.equal(status.pending, 0);
  await delay(30); assert.equal((await h.client.ping()).typed, status.typed);
  return h;
}
test('cancel reaches a sleeping job, preserves partial delivery and stops further units', { timeout: 10000 }, t => cancelWitness(t));

async function idleWitness(t, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'normal', factory);
  await h.client.cancel(); assert.equal(h.children.length, 0);
  await h.client.ping(); await h.client.cancel();
  assert.equal(h.frames.filter(row => row.method === 'cancel').length, 0);
  assert.deepEqual(await h.client.request('cancel', { id: 999 }), { cancelled: 999, inFlight: false });
}
test('cancel is lazy and completed or unknown ids are harmless', t => idleWitness(t));

async function boundedWitness(t, scenario, factory = createWindowsDriverClient) {
  const h = clientFixture(t, scenario, factory);
  const result = assert.rejects(h.client.request('typeText', { args: ['x'.repeat(1000)] }), { code: 'USER_STOPPED' });
  await h.waitFor('typeText');
  const began = performance.now(); await h.client.cancel();
  assert.ok(performance.now() - began < 1000, '300 ms wait with scheduler tolerance');
  await result; await delay(500);
  assert.equal((await h.client.ping()).pending, 0);
  assert.equal(h.children.length, 1, 'no replacement peer');
}
for (const scenario of ['late-cancel', 'silent-cancel']) test(`${scenario}: cancel wait is bounded and late replies keep the peer usable`,
  { timeout: 10000 }, t => boundedWitness(t, scenario));

async function multiWitness(t, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'late-cancel', factory);
  const results = ['typeText', 'getScreenshot', 'getAXState'].map(method =>
    assert.rejects(h.client.request(method, { args: ['x'.repeat(1000)] }), { code: 'USER_STOPPED', reason: 'cancel' }));
  await h.waitFor('getAXState');
  await h.client.cancel(); await Promise.all(results);
  const jobs = h.frames.filter(row => !['cancel', 'ping', 'turn-start', 'turn-end'].includes(row.method));
  assert.deepEqual(h.frames.filter(row => row.method === 'cancel').map(row => row.params.id), jobs.map(row => row.id));
  await delay(500); assert.equal((await h.client.ping()).pending, 0);
}
test('cancel addresses every pending data id and matches crossed job/cancel replies', t => multiWitness(t));

async function fieldsWitness(t, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'normal', factory);
  for (const code of ['USER_STOPPED', 'PERSON_TOOK_OVER', 'SCREEN_LOCKED', 'SECURE_DESKTOP_ACTIVE']) {
    const fields = { delivery: 'sent-unverified', retry: 'read-first', reason: code === 'USER_STOPPED' ? 'escape' : 'session-locked',
      typed: 17, personTookOver: false, limits: ['secure-desktop-seen'] };
    await assert.rejects(h.client.request('refuse', { code, message: 'private diagnostic', unhealthy: false, ...fields }), error => {
      for (const [key, value] of Object.entries(fields)) assert.deepEqual(error[key], value, key);
      windowsClipboardError(error);
      assert.match(error.message, /delivery=sent-unverified; retry=read-first; reason=/);
      assert.match(error.message, /typed=17/); assert.match(error.message, /Read the app state before repeating/);
      assert.doesNotMatch(error.message, /private diagnostic/); return true;
    });
  }
}
test('Windows error envelope retains all six refusal fields for the formatter', t => fieldsWitness(t));

async function latchWitness(t, factory = createDriverSafety) {
  let escape = true;
  const h = await driverFixture('win32', factory, { afterInput() {
    if (escape) { escape = false; throw Object.assign(Error('stop'), {
      code: 'USER_STOPPED', reason: 'escape', delivery: 'sent-unverified', retry: 'read-first', typed: 17 }); }
  } });
  t.after(() => h.safety.close());
  h.safety.windowsLifecycleAttributed();
  let first = await h.safety.request('getApp', { selector: 'Fixture' });
  const input = method => h.safety.request(method, { ...h.binding(), readId: first.readId, args: [1] });
  const firstStop = assert.rejects(input('click'), { code: 'USER_STOPPED', reason: 'escape' });
  const queued = assert.rejects(input('click'), { code: 'USER_STOPPED', delivery: 'not-sent' });
  await Promise.all([firstStop, queued]);
  const before = h.calls.length;
  for (const method of ACTION_METHODS) await assert.rejects(input(method), { code: 'USER_STOPPED', reason: 'escape',
    delivery: 'not-sent', retry: 'safe', unhealthy: false, ...['typeText', 'paste'].includes(method) ? { typed: 0 } : {} });
  assert.equal(h.calls.length, before);
  await h.safety.request('getAXState', h.binding());
  await assert.rejects(h.safety.request('cancel', { id: 1 }), { code: 'METHOD_NOT_FOUND' });
  await h.safety.reset(); await h.safety.endTurn({ clipboardTurnEnded: false });
  first = await h.safety.request('getApp', { selector: 'Fixture' });
  await assert.rejects(input('click'), { code: 'USER_STOPPED' });
  await h.safety.endTurn({ clipboardTurnEnded: true, windowsTurnEnded: true });
  first = await h.safety.request('getApp', { selector: 'Fixture' });
  await input('click'); assert.equal(h.actions.length, 2);
}
test('Escape latches queued and later input across reset, clearing only at a trusted turn end', t => latchWitness(t));

async function ownershipWitness(t, factory = createDriverSafety) {
  let reason = 'cancel', release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  const h = await driverFixture('win32', factory, { async afterInput() {
    if (!reason) return;
    const current = reason;
    if (current === 'escape') { entered(); await held; }
    throw Object.assign(Error('stop'), { code: 'USER_STOPPED', reason: current });
  } });
  t.after(() => h.safety.close());
  h.safety.windowsLifecycleAttributed();
  let first = await h.safety.request('getApp', { selector: 'Fixture' });
  const input = () => h.safety.request('click', { ...h.binding(), readId: first.readId, args: [1] });
  await assert.rejects(input(), { code: 'USER_STOPPED' });
  reason = undefined; first = await h.safety.request('getAXState', h.binding()); await assert.doesNotReject(input());
  reason = 'escape'; first = await h.safety.request('getAXState', h.binding());
  const stopped = assert.rejects(input(), { code: 'USER_STOPPED' }); await seen;
  await h.safety.endTurn({ clipboardTurnEnded: true, windowsTurnEnded: true }); release(); await stopped;
  reason = undefined; first = await h.safety.request('getApp', { selector: 'Fixture' }); await assert.doesNotReject(input());
}
test('parent cancel does not latch and a late Escape error cannot stop a new turn', t => ownershipWitness(t));

async function clipboardCancelWitness(t, factory = createDriverSafety) {
  let changed = true, cancels = 0;
  const h = await driverFixture('win32', factory, { afterInput() {
    if (changed) throw Object.assign(Error('changed'), { code: 'CLIPBOARD_CHANGED', clipboardChanged: true,
      delivery: 'sent-unverified', retry: 'read-first' });
  } });
  h.driver.cancel = async () => { cancels++; };
  t.after(() => h.safety.close());
  let first = await h.safety.request('getApp', { selector: 'Fixture' });
  const click = () => h.safety.request('click', { ...h.binding(), readId: first.readId, args: [1] });
  await assert.rejects(click(), { code: 'CLIPBOARD_CHANGED' });
  await assert.rejects(h.safety.request('cancel', { id: 1 }), { code: 'METHOD_NOT_FOUND' });
  await h.safety.reset(); await h.safety.endTurn({ clipboardTurnEnded: false });
  assert.equal(cancels, 2);
  first = await h.safety.request('getApp', { selector: 'Fixture' });
  await assert.rejects(click(), { code: 'CLIPBOARD_CHANGED', delivery: 'not-sent' });
  changed = false;
  await h.safety.endTurn({ clipboardTurnEnded: true });
  first = await h.safety.request('getApp', { selector: 'Fixture' });
  await assert.doesNotReject(click());
}
test('worker and parent cancellation cannot clear a clipboard stop', t => clipboardCancelWitness(t));

async function triggerWitness(t, trigger, factory = createDriverSafety) {
  const h = clientFixture(t);
  const order = [];
  const driver = { ...h.client, cancel() { order.push('cancel'); return h.client.cancel(); } };
  const safety = factory({ platform: 'win32', driver, lease: {
    release() { order.push('release'); }, close() { order.push('release'); },
  } });
  const stopped = assert.rejects(driver.request('typeText', { args: ['x'.repeat(1000)] }), { code: 'USER_STOPPED', reason: 'cancel' });
  await h.waitFor('typeText'); await safety[trigger](); await stopped;
  assert.deepEqual(order, ['cancel', 'release']);
}
for (const trigger of ['reset', 'endTurn', 'close']) test(`${trigger} cancels the pending native job before releasing the lease`, t => triggerWitness(t, trigger));

async function launcherWitness(t, launch = runWindows) {
  const h = clientFixture(t);
  const input = new PassThrough(), output = new PassThrough();
  let resolveCell, resets = 0;
  const lines = [];
  output.on('data', bytes => { for (const line of bytes.toString().trim().split('\n')) lines.push(JSON.parse(line)); });
  const repl = { execute: () => new Promise(resolve => { resolveCell = resolve; }),
    async reset() { resets++; resolveCell?.({ content: [], isError: true }); return { content: [] }; },
    async close() { resolveCell?.({ content: [], isError: true }); },
  };
  const runtime = await launch({ input, output, signals: new EventEmitter(), driver: h.client, repl,
    setting: () => ({ enabled: false, stream: false }), discovery: { browsers: async () => [] }, paths: { cache: 'fixture' } });
  t.after(() => runtime.close());
  const write = message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  write({ id: 'cell', method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getState();' } } });
  const stopped = assert.rejects(h.client.request('typeText', { args: ['x'.repeat(1000)] }), { code: 'USER_STOPPED' });
  await h.waitFor('typeText');
  write({ method: 'notifications/cancelled', params: { requestId: 'other' } });
  await delay(30); assert.equal(resets, 0);
  write({ method: 'notifications/cancelled', params: { requestId: 'cell' } });
  await stopped; await delay(30); assert.equal(resets, 1);
  assert.equal(lines.some(row => row.id === undefined && (row.result || row.error)), false, 'notification has no reply');
  write({ method: 'notifications/cancelled', params: { requestId: 'cell' } });
  await delay(30); assert.equal(resets, 1, 'completed cell cancellation ignored');
}
test('MCP cancellation targets only the active js request and sends a native cancel', { timeout: 10000 }, t => launcherWitness(t));

async function cleanupWitness(t, launch = runWindows) {
  let collected = false;
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const runtime = await launch({ input, output, signals: new EventEmitter(),
    driver: { cancel() { throw Error('fixture cleanup failure'); } },
    repl: { async close() { collected = true; } },
    setting: () => ({ enabled: false, stream: false }), discovery: { browsers: async () => [] }, paths: { cache: 'fixture' } });
  t.after(() => { runtime.relay.dispose(); runtime.cursor.close(); input.destroy(); output.destroy(); });
  await assert.rejects(runtime.close(), /Windows session cleanup failed/);
  assert.equal(collected, true);
  assert.equal(input.isPaused(), true);
}
test('launcher cleanup failure still collects the worker and disposes the relay', t => cleanupWitness(t));

async function leaseCleanupWitness(t, launch = runWindows) {
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  let collected = 0, released = 0;
  const runtime = await launch({ input, output, signals: new EventEmitter(),
    driver: { cancel() {}, async restart() {}, async close() { collected++; } },
    lease: { release() { released++; }, close() { throw Error('fixture unsafe lease'); } },
    setting: () => ({ enabled: false, stream: false }), discovery: { browsers: async () => [] }, paths: { cache: 'fixture' } });
  t.after(() => { runtime.relay.dispose(); runtime.cursor.close(); input.destroy(); output.destroy(); });
  await assert.rejects(runtime.close(), /Windows session cleanup failed/);
  assert.equal(collected, 1, 'owned driver cleanup runs after the unsafe lease failure');
  assert.equal(released, 2, 'relay disposal and the REPL reset callback both release leases');
  assert.equal(input.isPaused(), true);
}
test('unsafe lease shutdown still collects the owned driver and clears streams', t => leaseCleanupWitness(t));

async function launcherResetCleanupWitness(t, trigger, launch = runWindows, asynchronous = false) {
  const input = new PassThrough(), output = new PassThrough(), lines = [];
  output.on('data', bytes => { for (const line of bytes.toString().trim().split('\n')) lines.push(JSON.parse(line)); });
  let resolveCell, entered, resets = 0;
  const seen = new Promise(resolve => { entered = resolve; });
  const runtime = await launch({ input, output, signals: new EventEmitter(),
    driver: { cancel() {
      if (asynchronous) return Promise.reject(Error('fixture cancel failure'));
      throw Error('fixture cancel failure');
    } },
    repl: { execute: () => new Promise(resolve => { resolveCell = resolve; entered(); }),
      async reset() { resets++; await delay(30); resolveCell?.({ content: [] }); return { content: [] }; },
      async close() { resolveCell?.({ content: [] }); } },
    setting: () => ({ enabled: false, stream: false }), discovery: { browsers: async () => [] }, paths: { cache: 'fixture' } });
  t.after(() => { runtime.relay.dispose(); runtime.cursor.close(); input.destroy(); output.destroy(); });
  const write = message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  write({ id: 'cell', method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getState();' } } });
  await seen;
  if (trigger === 'js_reset') write({ id: 'reset', method: 'tools/call', params: { name: trigger } });
  else write({ method: trigger, params: { requestId: 'cell' } });
  await delay(60);
  assert.equal(resets, 1, 'worker reset still runs when early cancellation fails');
  if (trigger === 'js_reset') assert.equal(lines.find(row => row.id === 'reset')?.result?.isError, true);
  assert.equal(lines.some(row => row.error?.code === -32700), false);
  await assert.rejects(runtime.close(), /Windows session cleanup failed/);
}
for (const trigger of ['js_reset', 'notifications/cancelled']) for (const asynchronous of [false, true])
  test(`launcher ${trigger} collects cancellation failure, asynchronous=${asynchronous}`,
    t => launcherResetCleanupWitness(t, trigger, runWindows, asynchronous));

async function safetyCleanupWitness(trigger, factory = createDriverSafety, asynchronous = false) {
  const order = [];
  const safety = factory({ platform: 'win32', driver: { cancel() {
    order.push('cancel');
    if (asynchronous) {
      const failed = Promise.reject(Error('fixture cancel failure')); failed.catch(() => {}); return failed;
    }
    throw Error('fixture cancel failure');
  } }, lease: {
    release() { order.push('release'); throw Error('fixture lease failure'); },
    close() { order.push('release'); throw Error('fixture lease failure'); },
  } });
  let failure;
  try { await safety[trigger](); } catch (error) { failure = error; }
  assert.deepEqual(order, ['cancel', 'release'], 'both cleanup operations are attempted');
  assert.ok(failure instanceof AggregateError, 'cleanup retains every failure');
  assert.deepEqual(failure.errors.map(error => error.message), ['fixture cancel failure', 'fixture lease failure']);
}
for (const trigger of ['reset', 'endTurn', 'close']) for (const asynchronous of [false, true])
  test(`${trigger} collects cancellation and lease failures, asynchronous=${asynchronous}`,
    () => safetyCleanupWitness(trigger, createDriverSafety, asynchronous));

async function startingWitness(t, factory = createWindowsDriverClient, method = 'typeText', trigger = 'cancel') {
  const host = slowDriverHost(t);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  const client = factory({ platform: 'win32', prepare: async () => { entered(); await held; return host.prepare(); } });
  t.after(() => client.close());
  const stopped = assert.rejects(client.request(method, { args: ['x'] }), {
    code: 'USER_STOPPED', reason: 'cancel', delivery: 'not-sent', retry: 'safe',
    ...['typeText', 'paste'].includes(method) ? { typed: 0 } : {} });
  await seen;
  const cancelled = client[trigger]();
  if (trigger === 'cancel') await cancelled;
  release(); await stopped; await cancelled;
  if (trigger !== 'close') await client.ping();
  assert.equal(host.frames.some(row => row.method === method), false);
}
test('cancel fences an action still awaiting lazy host preparation', t => startingWitness(t));
for (const method of ['paste', 'getAXState', 'getScreenshot'])
  test(`cancel fences ${method} still awaiting lazy host preparation`, t => startingWitness(t, createWindowsDriverClient, method));
for (const trigger of ['restart', 'close'])
  test(`${trigger} fences an action still awaiting lazy host preparation`, t => startingWitness(t, createWindowsDriverClient, 'typeText', trigger));

async function controlFenceWitness(t, factory = createWindowsDriverClient) {
  for (const method of ['ping', 'cancel']) {
    const host = slowDriverHost(t);
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const seen = new Promise(resolve => { entered = resolve; });
    const client = factory({ platform: 'win32', prepare: async () => { entered(); await held; return host.prepare(); } });
    t.after(() => client.close());
    const control = client.request(method, method === 'cancel' ? { id: 999 } : {});
    control.catch(() => {});
    await seen; await client.cancel(); release();
    await assert.doesNotReject(control, 'startup fencing excludes health and control frames');
  }
}
test('startup cancellation leaves health probes and cancel frames available', t => controlFenceWitness(t));

async function warmFenceWitness(t, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'normal', factory);
  await h.client.ping();
  const stopped = assert.rejects(h.client.request('typeText', { args: ['x'] }), {
    code: 'USER_STOPPED', reason: 'cancel', delivery: 'not-sent', retry: 'safe', typed: 0 });
  await h.client.cancel(); await stopped;
  assert.equal(h.frames.some(row => row.method === 'typeText'), false, 'no frame after the warm admission await');
  assert.equal(h.frames.some(row => row.method === 'cancel'), false, 'unsent work needs no control frame');
}
test('cancel also fences unsent work on an already warm peer', t => warmFenceWitness(t));

async function fullQueueWitness(t, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'normal', factory);
  const calls = Array.from({ length: 32 }, () => assert.rejects(
    h.client.request('typeText', { args: ['x'.repeat(1000)] }), { code: 'USER_STOPPED', reason: 'cancel' }));
  while (h.frames.filter(row => row.method === 'typeText').length < 32) await delay(5);
  await h.client.cancel(); await Promise.all(calls);
  assert.equal(h.frames.filter(row => row.method === 'cancel').length, 32);
  assert.equal((await h.client.ping()).cleanup, 32);
}
test('a full data queue still admits one control frame per pending id', t => fullQueueWitness(t));

async function retirementWitness(t, trigger, factory = createWindowsDriverClient, scenario = 'normal') {
  const h = clientFixture(t, scenario, factory);
  const stopped = assert.rejects(h.client.request('typeText', { args: ['x'.repeat(1000)] }), { code: 'USER_STOPPED', reason: 'cancel' });
  stopped.catch(() => {});
  await h.waitFor('typeText'); await h.client[trigger](); await stopped;
  assert.equal(h.events.filter(row => row.event === 'cleanup').length, 1);
}
for (const trigger of ['restart', 'close']) test(`transport ${trigger} collects the cancelled job before retiring its peer`, t => retirementWitness(t, trigger));
for (const trigger of ['restart', 'close']) test(`transport ${trigger} waits for delayed cleanup after the acknowledgment`,
  t => retirementWitness(t, trigger, createWindowsDriverClient, 'slow-cleanup'));

async function missingCleanupWitness(t, trigger, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'stalled-cleanup', factory);
  const stopped = assert.rejects(h.client.request('typeText', { args: ['x'.repeat(1000)] }), {
    code: trigger === 'close' ? 'DRIVER_CLOSED' : 'DRIVER_RESTARTED' });
  await h.waitFor('typeText');
  const began = performance.now(); await h.client[trigger](); await stopped;
  assert.ok(performance.now() - began < 1500, 'bounded retirement after cancellation');
  assert.equal(h.frames.filter(row => row.method === 'typeText').length, 1, 'no replay');
  assert.equal(h.frames.filter(row => row.method === 'cancel').length, 1);
}
for (const trigger of ['restart', 'close']) test(`transport ${trigger} bounds a missing job cleanup reply`,
  t => missingCleanupWitness(t, trigger));

async function retirementAdmissionWitness(t, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'slow-cleanup', factory);
  const stopped = assert.rejects(h.client.request('typeText', { args: ['x'.repeat(1000)] }), { code: 'USER_STOPPED' });
  stopped.catch(() => {});
  const old = await h.waitFor('typeText');
  const restarting = h.client.restart(); await h.waitFor('cancel');
  const fresh = h.client.getState();
  fresh.catch(() => {});
  await restarting; await stopped; await fresh;
  const read = await h.waitFor('getState');
  assert.notEqual(read.nonce, old.nonce, 'new work waits for retirement and uses a fresh peer');
  assert.equal(h.children.length, 2);
  assert.equal(h.events.filter(row => row.event === 'cleanup').length, 1);
}
test('new work waits for cancelled-job retirement before using a replacement peer', t => retirementAdmissionWitness(t));

async function retirementCancelWitness(t, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'slow-cleanup', factory);
  const stopped = assert.rejects(h.client.request('typeText', { args: ['x'.repeat(1000)] }), { code: 'USER_STOPPED' });
  await h.waitFor('typeText');
  const restarting = h.client.restart(); await h.waitFor('cancel');
  const fresh = assert.rejects(h.client.getState(), {
    code: 'USER_STOPPED', reason: 'cancel', delivery: 'not-sent', retry: 'safe' });
  await h.client.cancel();
  await Promise.all([restarting, stopped, fresh]);
  assert.equal(h.frames.some(row => row.method === 'getState'), false);
}
test('a later cancel also fences unsent work waiting for retirement', t => retirementCancelWitness(t));

async function productionLauncherWitness(t, trigger, launch = runWindows) {
    const h = clientFixture(t);
    const input = new PassThrough(), output = new PassThrough(), pending = new Map(), replies = [];
    const within = (work, stage) => {
      let timer;
      return Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new assert.AssertionError({ message: stage + ': ' + JSON.stringify({
          frames: h.frames.map(row => ({ id: row.id, method: row.method })),
          replies: replies.map(row => ({ id: row.id, method: row.method, error: row.error, isError: row.result?.isError })),
        }) })), 2000);
      })]).finally(() => clearTimeout(timer));
    };
    const write = message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    output.on('data', bytes => {
      for (const line of bytes.toString().trim().split('\n')) {
        const message = JSON.parse(line);
        replies.push(message);
        if (message.method === 'elicitation/create') write({ id: message.id, result: { action: 'accept' } });
        else if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      }
    });
    const request = (id, name, args = {}) => new Promise(resolve => {
      pending.set(id, resolve); write({ id, method: 'tools/call', params: { name, arguments: args } });
    });
    const runtime = await launch({ input, output, signals: new EventEmitter(), driver: h.client,
      lease: { acquire: () => 'fixture-lease', renew() {}, release() {}, close() {} },
      replOptions: { environment: () => ({ LANE_FIXTURE: '1' }) },
      setting: () => ({ enabled: false, stream: false }), discovery: { browsers: async () => [] }, paths: { cache: 'fixture' } });
    t.after(() => runtime.close());
    await new Promise(resolve => {
      pending.set('initialize', resolve);
      write({ id: 'initialize', method: 'initialize', params: {
        capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-test', version: '1' },
      } });
    });
    const acquired = await request('acquire', 'js', { code: 'let app = await cua.getApp("Notepad");' });
    assert.equal(acquired.result.isError, false, JSON.stringify(acquired));
    const typing = request('typing', 'js', { code: 'await app.typeText("' + 'x'.repeat(1000) + '");' });
    await h.waitFor('typeText');
    if (trigger === 'notifications/cancelled') write({ method: trigger, params: { requestId: 'typing' } });
    else if (trigger === 'close') await runtime.close();
    else await request('stop', trigger);
    const control = await within(h.waitFor('cancel'), 'cancel frame');
    assert.equal(control.params.id, h.frames.find(row => row.method === 'typeText').id);
    if (trigger !== 'close') await within(typing, 'typing reply');
    await within(runtime.close(), 'session close');
    assert.equal(h.children.length, 1);
    assert.equal(h.events.filter(row => row.event === 'cleanup').length, 1, 'job cleanup precedes peer retirement');
}
for (const trigger of ['notifications/cancelled', 'js_reset', 'close', 'turn_ended'])
  test(`production launcher ${trigger} cancels the sleeping native job`, { skip: windowsWorkerSkip, timeout: 10000 }, t => productionLauncherWitness(t, trigger));

async function invalidFieldsWitness(t, factory = createWindowsDriverClient) {
  for (const patch of [
    { delivery: 'sent', retry: 'safe' }, { delivery: 'sent-unverified', retry: 'safe' }, { delivery: 'not-sent' },
    { reason: 'escape\ninjected' }, { typed: -1 }, { typed: 0.5 }, { typed: '1' },
    { personTookOver: 'false' }, { limits: 'secure-desktop-seen' }, { limits: [false] },
  ]) {
    const h = clientFixture(t, 'normal', factory);
    await assert.rejects(h.client.request('refuse', { code: 'USER_STOPPED', message: 'fixture', unhealthy: false, ...patch }),
      { code: 'DRIVER_PROTOCOL', unhealthy: true });
  }
}
test('invalid refusal field types and inconsistent retry dispositions fail closed', t => invalidFieldsWitness(t));

async function paramsWitness(t, factory = createWindowsDriverClient) {
  const h = clientFixture(t, 'normal', factory);
  for (const params of [{}, { id: 0 }, { id: -1 }, { id: 1.1 }, { id: '1' }, { id: 1, extra: true }])
    await assert.rejects(h.client.request('cancel', params), { code: 'INVALID_PARAMS' });
  assert.equal(h.children.length, 0);
}
test('cancel frame validates a positive target id before starting a peer', t => paramsWitness(t));

async function readStopWitness(factory = createDriverSafety) {
  let sent = 0;
  const safety = factory({ platform: 'win32' }, {
    queue: { serial: Promise.resolve(), queued: 0 }, epoch: () => 0, fail: assert.fail,
    dispatch() { sent++; throw Object.assign(Error('stop'), { code: 'USER_STOPPED', reason: 'escape' }); },
  });
  await assert.rejects(safety.request('getAXState', {}), { code: 'USER_STOPPED' });
  await assert.rejects(safety.request('click', {}), { code: 'USER_STOPPED', delivery: 'not-sent' });
  assert.equal(sent, 1);
}
test('the latch also accepts Escape observed on a read between actions', () => readStopWitness());

async function fakeEscapeWitness(t, factory = createDriverSafety) {
  const h = clientFixture(t, 'escape');
  const safety = factory({ platform: 'win32' }, {
    queue: { serial: Promise.resolve(), queued: 0 }, epoch: () => 0, fail: assert.fail,
    dispatch: (method, params) => h.client.request(method, params),
  });
  safety.windowsLifecycleAttributed();
  await assert.rejects(safety.request('typeText', { args: ['x'.repeat(1000)] }), {
    code: 'USER_STOPPED', reason: 'escape', typed: 3, delivery: 'sent-unverified', retry: 'read-first' });
  for (let repeat = 0; repeat < 3; repeat++) await assert.rejects(safety.request('paste', { args: ['x'] }), {
    code: 'USER_STOPPED', reason: 'escape', delivery: 'not-sent', retry: 'safe', typed: 0 });
  await safety.request('getAXState', {});
  assert.equal(h.frames.filter(row => ['typeText', 'paste'].includes(row.method)).length, 1);
  assert.equal((await h.client.ping()).cleanup, 1);
  await safety.endWindowsTurn(() => h.client.endWindowsTurn());
  await safety.request('typeText', { args: ['x'] });
}
test('a synthetic Escape reply stops further input until turn end, with reads still available', t => fakeEscapeWitness(t));

async function latchedMenuReadWitness(t, factory = createDriverSafety) {
  const h = await driverFixture('win32', factory, {
    body: '1 menu File\n\t\t2 menu item Open',
    afterInput(method) { if (method === 'click') throw Object.assign(Error('stop'), { code: 'USER_STOPPED', reason: 'escape' }); },
  });
  t.after(() => h.safety.close());
  const first = await h.safety.request('getApp', { selector: 'Fixture' }, { cell: 1 });
  await assert.rejects(h.safety.request('click', { ...h.binding(), readId: first.readId, args: [2] }, { cell: 1 }), {
    code: 'USER_STOPPED', reason: 'escape' });
  await h.safety.finishCell(1);
  for (const cell of [2, 3, 4]) {
    const read = await h.safety.request('getAXState', h.binding(), { cell });
    assert.match(read.text, /menu File/);
    await assert.doesNotReject(h.safety.finishCell(cell), 'a stopped turn still returns menu reads');
  }
  assert.deepEqual(h.actions.map(([method]) => method), ['click']);
}
test('latched menu reads remain available without an automatic Escape', t => latchedMenuReadWitness(t));

async function internalEscapeWitness(t, trustedEnd, factory = createDriverSafety) {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  const h = await driverFixture('win32', factory, {
    body: '1 menu File\n\t\t2 menu item Open',
    async beforeInput(method) { if (method === 'stuckMenuEscape') { entered(); await held; } },
    afterInput(method) { if (method === 'stuckMenuEscape') throw Object.assign(Error('stop'), { code: 'USER_STOPPED', reason: 'escape' }); },
  });
  t.after(() => h.safety.close());
  h.safety.windowsLifecycleAttributed();
  await h.safety.request('getApp', { selector: 'Fixture' }, { cell: 1 });
  await h.safety.finishCell(1);
  await h.safety.request('getAXState', h.binding(), { cell: 2 });
  const stopped = assert.rejects(h.safety.finishCell(2), { code: 'USER_STOPPED' });
  await seen;
  if (trustedEnd) await h.safety.endTurn({ clipboardTurnEnded: true, windowsTurnEnded: true });
  else await h.safety.reset();
  release(); await stopped;
  const first = await h.safety.request('getApp', { selector: 'Fixture' }, { cell: 3 });
  const click = () => h.safety.request('click', { ...h.binding(), readId: first.readId, args: [2] }, { cell: 3 });
  if (trustedEnd) await assert.doesNotReject(click());
  else await assert.rejects(click(), { code: 'USER_STOPPED', delivery: 'not-sent' });
}
for (const trustedEnd of [false, true]) test(`internal menu Escape error after reset preserves turn ownership: ${trustedEnd}`,
  t => internalEscapeWitness(t, trustedEnd));

test('safety witnesses reject broken production variants', { timeout: 90000 }, async t => {
  const brokenClient = async (name, change, witness = cancelWitness) => t.test(name, async child => {
    const broken = await mutate('driver-client.mjs', change);
    await assert.rejects(witness(child, broken.createWindowsDriverClient), { code: 'ERR_ASSERTION' });
  });
  await brokenClient('cancel omitted', s => s.replace("const calls = [...pending.entries()].filter", "const calls = [].filter"));
  await brokenClient('cancel starts an idle peer', s => s.replace('...!mac ? { cancel, endWindowsTurn } : {}', "...!mac ? { cancel: () => request('ping') } : {}"), idleWitness);
  await brokenClient('duplicate cancel per job', s => s.replace('if (!call.cancelling)', 'if (true)'));
  await brokenClient('wrong cancel target', s => s.replace("send(call.g, 'cancel', { id }, 300)", "send(call.g, 'cancel', { id: id + 999 }, 300)"));
  await brokenClient('read and capture cancellation omitted', s => s.replace("!['cancel', 'ping', 'turn-start', 'turn-end'].includes(call.method)", 'call.action'), multiWitness);
  await brokenClient('full queue blocks controls', s => s.replace('(cancelling || lifecycle ? 64 : 32)', '32'), fullQueueWitness);
  await brokenClient('late cancel retires peer', s => s.replace('        if (cancelling) {', '        if (false) {'),
    (child, factory) => boundedWitness(child, 'late-cancel', factory));
  await brokenClient('cancel wait unbounded by 300 ms', s => s.replace('Math.min(budget, 300)', '3000'),
    (child, factory) => boundedWitness(child, 'silent-cancel', factory));
  await brokenClient('invalid refusal fields accepted', s => s.replace('      if (!value.ok) {', '      if (false && !value.ok) {'), invalidFieldsWitness);
  await brokenClient('invalid cancel params accepted', s => s.replace("if (!mac && method === 'cancel' &&", "if (false && method === 'cancel' &&"), paramsWitness);
  for (const key of ['delivery', 'retry', 'reason', 'typed', 'personTookOver', 'limits'])
    await brokenClient('dropped ' + key, s => s.replace(
      "['delivery', 'retry', 'reason', 'typed', 'personTookOver', 'limits', 'escapeStops', 'counters']",
      JSON.stringify(['delivery', 'retry', 'reason', 'typed', 'personTookOver', 'limits', 'escapeStops', 'counters'].filter(field => field !== key))), fieldsWitness);
  for (const [name, change] of [
    ['Escape not latched', s => s.replace("error.code === 'USER_STOPPED' && ['escape', 'turn-unproven'].includes(error.reason)", 'false')],
    ['queued input skips latch', s => s.replace('        checkUserStop(method);', '')],
    ['reset clears the latch', s => s.replace('reset() { return cancelAndRelease(); }', 'reset() { void requests.endWindowsTurn(() => {}); return cancelAndRelease(); }')],
    ['untrusted end clears latch', s => s.replace('if (!windowsTurnEnded) return cleanup;', 'if (false) return cleanup;')],
  ]) await t.test(name, async child => {
    const broken = await mutate('driver-safety.mjs', change);
    await assert.rejects(latchWitness(child, broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  });
  for (const [name, change] of [
    ['parent cancel latches', s => s.replace("error.code === 'USER_STOPPED' && ['escape', 'turn-unproven'].includes(error.reason)", "error.code === 'USER_STOPPED'")],
    ['old Escape poisons new turn', s => s.replace("turn === inputTurn && error.code === 'USER_STOPPED'", "error.code === 'USER_STOPPED'")],
  ]) await t.test(name, async child => {
    const broken = await mutate('driver-safety.mjs', change);
    await assert.rejects(ownershipWitness(child, broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  });
  await t.test('read Escape discarded', async () => {
    const broken = await mutate('driver-safety.mjs', s => s.replace('        observeStop(error, input);', '        if (ACTION_METHODS.includes(method)) observeStop(error, input);'));
    await assert.rejects(readStopWitness(broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  });
  for (const trigger of ['reset', 'endTurn', 'close']) await t.test('missing ' + trigger + ' trigger', async child => {
    const broken = await mutate('driver-safety.mjs', s => {
      const at = s.indexOf('    ' + trigger + '(');
      return s.slice(0, at) + s.slice(at).replace(/cancelAndRelease\((?:true)?\)/, 'Promise.resolve()');
    });
    await assert.rejects(triggerWitness(child, trigger, broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  });
  await t.test('MCP cancellation ignored', async child => {
    const broken = await mutate('windows-launch.mjs', s => s.replace("message.method === 'notifications/cancelled' && pendingJs", 'false && pendingJs'));
    await assert.rejects(launcherWitness(child, broken.runWindows), { code: 'ERR_ASSERTION' });
  });
  await t.test('reply becomes visible before cell ownership is released', async child => {
    const broken = await mutate('windows-launch.mjs', s => s.replace("finish(); cursor.status(result.isError", "cursor.status(result.isError"));
    await assert.rejects(productionLauncherWitness(child, 'notifications/cancelled', broken.runWindows), { code: 'ERR_ASSERTION' });
  });
  await brokenClient('startup cancellation fence omitted', s => s.replace('function cancel() {\n    cancelEpoch++;', 'function cancel() {'), startingWitness);
  await brokenClient('warm cancellation fence omitted', s => s.replace('function cancel() {\n    cancelEpoch++;', 'function cancel() {'), warmFenceWitness);
  await brokenClient('startup cancellation includes control frames', s => s.replace(
    "const cancellable = !mac && !['cancel', 'ping'].includes(method);", 'const cancellable = !mac;'), controlFenceWitness);
  await brokenClient('retirement skips original job cleanup', s => s.replace('Promise.all(jobs.map(call => call.done))', 'Promise.resolve()'),
    (child, factory) => retirementWitness(child, 'restart', factory, 'slow-cleanup'));
  await brokenClient('missing job cleanup exceeds its bound', s => s.replace('setTimeout(resolve, 300)', 'setTimeout(resolve, 1800)'),
    (child, factory) => missingCleanupWitness(child, 'restart', factory));
  await brokenClient('admission ignores retirement', s => s.replace('while (!mac && windowsRetirement)', 'while (false && windowsRetirement)'),
    retirementAdmissionWitness);
  await brokenClient('retirement wait forgets cancellation ownership', s => s.replace('const admission = cancelEpoch;', 'let admission = cancelEpoch;')
    .replace('while (!mac && windowsRetirement) await windowsRetirement;',
      'while (!mac && windowsRetirement) await windowsRetirement; admission = cancelEpoch;'), retirementCancelWitness);
  await t.test('launcher abandons cleanup after synchronous cancellation error', async child => {
    const broken = await mutate('windows-launch.mjs', s => s.replace(
      'try { cancelled = safety ? safety.close() : driver.cancel?.(); }\n      catch (error) { errors.push(error); }',
      'cancelled = safety ? safety.close() : driver.cancel?.();'));
    await assert.rejects(cleanupWitness(child, broken.runWindows), { code: 'ERR_ASSERTION' });
  });
  await t.test('launcher skips worker cleanup after unsafe lease shutdown', async child => {
    const broken = await mutate('windows-launch.mjs', s => s.replace(
      'Promise.resolve().then(() => repl.close())', 'Promise.resolve()'));
    await assert.rejects(leaseCleanupWitness(child, broken.runWindows), { code: 'ERR_ASSERTION' });
  });
  for (const trigger of ['js_reset', 'notifications/cancelled']) await t.test(trigger + ' skips worker reset after cancel failure', async child => {
    const broken = await mutate('windows-launch.mjs', s => s.replace('() => repl.reset()', '() => Promise.resolve({ content: [] })'));
    await assert.rejects(launcherResetCleanupWitness(child, trigger, broken.runWindows), { code: 'ERR_ASSERTION' });
  });
  for (const trigger of ['reset', 'endTurn', 'close']) await t.test(trigger + ' abandons lease cleanup after cancel failure', async () => {
    const broken = await mutate('driver-safety.mjs', s => s.replace(
      'try { return Promise.resolve(operation()); }\n      catch (error) { return Promise.reject(error); }',
      'try { return Promise.resolve(operation()); }\n      catch (error) { throw error; }'));
    await assert.rejects(safetyCleanupWitness(trigger, broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  });
  for (const trustedEnd of [false, true]) await t.test('internal Escape loses turn ownership: ' + trustedEnd, async child => {
    const broken = await mutate('driver-safety.mjs', s => s.replace('                observeTurnStop(error);',
      trustedEnd ? '                requests.observeStop(error);' : '                if (generation === epoch) observeTurnStop(error);'));
    await assert.rejects(internalEscapeWitness(child, trustedEnd, broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  });
  await t.test('latched text refusal drops typed zero', async child => {
    const broken = await mutate('driver-safety.mjs', s => s.replace("...['typeText', 'paste'].includes(method) ? { typed: 0 } : {}", ''));
    await assert.rejects(latchWitness(child, broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  });
  await t.test('reset clears the clipboard stop', async child => {
    const broken = await mutate('driver-safety.mjs', s => s.replace('reset() { return cancelAndRelease(); }',
      'reset() { requests.endClipboardTurn(); return cancelAndRelease(); }'));
    await assert.rejects(clipboardCancelWitness(child, broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  });
  await t.test('latched menu read attempts automatic Escape', async child => {
    const broken = await mutate('driver-safety.mjs', s => s.replace(
      "          try { requests.checkUserStop('stuckMenuEscape'); }\n          catch (error) { if (error.code === 'USER_STOPPED') return; throw error; }", ''));
    await assert.rejects(latchedMenuReadWitness(child, broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  });
});
