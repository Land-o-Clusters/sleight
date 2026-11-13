import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createMacDriverClient } from '../plugins/sleight/lib/driver-client.mjs';
import { DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { createRuntimeActionEvents } from '../plugins/sleight/lib/mac-driver/action-events.mjs';
import { createHandClient } from '../plugins/sleight/lib/hand/client.mjs';
import { dragScriptFixture } from './fixtures/drag-script.mjs';
import vm from 'node:vm';
import { measureGlideStop, glideStopProbePlan } from '../bench/glide-stop-live.mjs';

function fixture(t, { earlyStop = false, clipboardChanged = false } = {}) {
  const frames = [], controls = [];
  let active, activate, ended = 0;
  const began = new Promise(resolve => { activate = resolve; });
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const reply = (request, error) => child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
    nonce: request.nonce, id: request.id, ok: !error, ...error ? { error } : { result: request.method === 'ping' ? {
      protocol: 'sleight.driver/1', apiVersion: 2, build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS],
    } : {} } }) + '\n');
  child.stdin = new Writable({ write(bytes, encoding, done) {
    const frame = JSON.parse(bytes); frames.push(frame); done();
    if (frame.control) {
      controls.push(frame);
      if (frame.control === 'cancel-before-input') reply(frame, { code: 'USER_STOPPED', message: 'stopped', next: 'stop-tell-user',
        unhealthy: false, delivery: 'not-sent', retry: 'safe' });
      if (frame.control === 'stop') reply(active, { code: 'USER_STOPPED', message: 'stopped', next: 'stop-tell-user',
        unhealthy: false, delivery: 'sent-unverified', retry: 'read-first', ...clipboardChanged ? { clipboardChanged: true } : {} });
    } else if (frame.method === 'typeText') { active = frame; activate(); }
    else reply(frame);
  } });
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
  let stop;
  const client = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn: () => child }),
    stopControl: { async begin(params, onStop) { stop = onStop; if (earlyStop) onStop(); return () => { ended++; }; } } });
  t.after(() => client.close());
  return { client, frames, controls, began, stop: () => stop(), get ended() { return ended; } };
}
const params = { windowId: '7', processStart: '1.2', readId: 1, args: ['a'.repeat(1000)] };

test('a person stop bypasses an in-flight request, preserves USER_STOPPED and closes its control', async t => {
  const f = fixture(t), call = f.client.request('typeText', params);
  const rejected = assert.rejects(call, { code: 'USER_STOPPED', next: 'stop-tell-user', delivery: 'sent-unverified' });
  await f.began; f.stop(); await rejected;
  assert.equal(f.controls.length, 1); assert.equal(f.controls[0].call, f.frames.find(row => row.method === 'typeText').id);
  assert.equal(f.ended, 1);
});

test('stop refuses later input until a new prompt, and stale callbacks cannot stop the next call', async t => {
  const f = fixture(t), call = f.client.request('typeText', params);
  const rejected = assert.rejects(call, { code: 'USER_STOPPED' });
  await f.began; f.stop(); await rejected;
  await assert.rejects(f.client.request('click', { ...params, args: [1] }), { code: 'USER_STOPPED', delivery: 'not-sent' });
  await f.client.ping();
  await f.client.userPrompt();
  await f.client.request('click', { ...params, args: [1] });
  f.stop();
  assert.equal(f.controls.filter(row => row.control === 'stop').length, 1);
});

test('action events distinguish a user stop from an ordinary failed action', async () => {
  const records = [], events = createRuntimeActionEvents({ defer: fn => fn() });
  events.connect(record => { records.push(record); });
  await assert.rejects(events.run('typeText', params, {}, async () => {
    throw Object.assign(Error('stopped'), { code: 'USER_STOPPED', delivery: 'sent-unverified' });
  }));
  assert.equal(records.at(-1).outcome.userStopped, true);
  events.close();
});

test('Stop works with artwork off and accepts only its host nonce and current control token', async t => {
  const child = new EventEmitter(), sent = [];
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(line, encoding, done) {
    const frame = JSON.parse(line); sent.push(frame); done();
    if (frame.hand === 'glide-stop' && frame.phase === 'begin') queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ hand: 'glide-stop', nonce: frame.nonce, token: frame.token, phase: 'ready' }) + '\n');
    });
  } });
  child.kill = () => {}; child.pid = 999999;
  const client = createHandClient({ setting: () => ({ enabled: false }), permissions: null, usage: null,
    watch: () => undefined, built: () => true, prepare: async () => ({ status: 'ready', spawn: () => child }) });
  t.after(() => client.close());
  let stops = 0;
  const end = await client.beginGlideStop({ windowId: '7', pid: 42 }, () => { stops++; });
  const frame = sent.find(row => row.hand === 'glide-stop');
  for (const invalid of [{ nonce: 'b'.repeat(64) }, { token: 'b'.repeat(32) }, { extra: true }]) {
    child.stdout.write(JSON.stringify({ hand: 'glide-stop', nonce: frame.nonce, token: frame.token, phase: 'stop', ...invalid }) + '\n');
  }
  assert.equal(stops, 0);
  const click = { hand: 'glide-stop', nonce: frame.nonce, token: frame.token, phase: 'stop' };
  child.stdout.write(JSON.stringify(click) + '\n'); assert.equal(stops, 1);
  end(); child.stdout.write(JSON.stringify(click) + '\n'); assert.equal(stops, 1);
  assert.equal(sent.at(-1).phase, 'end');
});

test('stepped drag stops while holding and sends only its button release afterward', () => {
  let stopped = false, boundary;
  const f = dragScriptFixture({ background: true, selection: '', areaRole: 'AXGroup', onDelay() {
    if (!stopped && f.pidEvents.some(event => event.type === 1)) { stopped = true; boundary = f.pidEvents.length; }
  } });
  f.context.shouldStop = () => stopped;
  vm.runInContext(`dragStopChannel = () => {
    if (shouldStop()) throw Object.assign(new Error('USER_STOPPED'), { code: 'USER_STOPPED' });
  };`, f.context);
  const result = f.run({ app: 'com.apple.TextEdit', windowId: 11, from: [26.6, 38.5], to: [150, 38.5], dp2: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /USER_STOPPED/);
  assert.equal(stopped, true, 'Stop arrived after button down');
  assert.deepEqual(f.pidEvents.slice(boundary).map(event => event.type), [2], 'only mouse-up after Stop');
  assert.equal(f.events.length, 0, 'no foreground fallback');
  assert.equal(f.textWrites.length, 0, 'no text repair');
});

test('attended probe requires ten person stops, sub-500 ms receipts and zero held input', async () => {
  let time = 0, starts = 0;
  const adapter = { check: async () => {}, resetPrompt: async () => {},
    begin: async () => { starts++; return { result: Promise.resolve().then(() => {
      throw Object.assign(Error('stopped'), { code: 'USER_STOPPED', next: 'stop-tell-user' });
    }).catch(error => { return Promise.reject(error); }) }; },
    personStop: async () => ({ person: true, at: time }), now: () => time + 20,
    held: async () => ({ buttons: 0, keys: 0, modifiers: 0, postStopInput: 0, screenshotHasStop: false, latched: true }) };
  assert.equal(glideStopProbePlan.trials, 10);
  assert.equal((await measureGlideStop(adapter)).passed, 10); assert.equal(starts, 10);
  await assert.rejects(measureGlideStop({ ...adapter, now: () => time + 501 }), { message: 'STOP_QUALIFICATION_FAILED' });
  await assert.rejects(measureGlideStop({ ...adapter, held: async () => ({ buttons: 0, keys: 0, modifiers: 1 }) }),
    { message: 'STOP_QUALIFICATION_FAILED' });
});


test('a stop on the first UI frame requests only cancellation and held-input cleanup', async t => {
  const f = fixture(t, { earlyStop: true });
  await assert.rejects(f.client.request('typeText', params), { code: 'USER_STOPPED', delivery: 'not-sent' });
  assert.equal(f.controls.at(-1).control, 'cancel-before-input');
  assert.equal(f.frames.filter(frame => frame.method === 'typeText' && !frame.control).length, 0);
  assert.equal(f.ended, 1);
});


test('a simultaneous clipboard change cannot replace the person Stop outcome', async t => {
  const f = fixture(t, { clipboardChanged: true }), call = f.client.request('typeText', params);
  const rejected = assert.rejects(call, { code: 'USER_STOPPED', clipboardChanged: true });
  await f.began; f.stop(); await rejected;
});
