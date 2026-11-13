import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createAppHealthHelper } from '../plugins/sleight/lib/read-failure.mjs';

const source = new URL('../plugins/sleight/lib/front-restore.js', import.meta.url);
const owner = { bundleId: 'org.example.writer', pid: 12, app: 'Writer' };
const target = { bundleId: 'org.example.canvas', pid: 34, app: 'Canvas' };
const other = { bundleId: 'org.example.other', pid: 56, app: 'Other' };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

function fixture() {
  assert.ok(existsSync(source), 'front restoration has a helper controller');
  const create = runInNewContext(readFileSync(source, 'utf8') + '\nfrontRestoreController', {});
  let serial = 0;
  const state = { front: owner, targets: [], previous: owner, time: 100, idleSeconds: 20, activationOK: true };
  const activated = [];
  const controller = create({ observe: () => state, token: () => String(++serial),
    activate: app => { activated.push(JSON.parse(JSON.stringify(app))); state.front = app; return state.activationOK; } });
  return { state, activated, request: request => JSON.parse(JSON.stringify(controller(request))) };
}

function launch(f) {
  const { token } = f.request({ action: 'begin', selector: 'Canvas' });
  assert.ok(token);
  assert.equal(f.request({ action: 'arm', token }).armed, true);
  f.state.targets = [target]; f.state.front = target; f.state.time++;
  return token;
}

test('the helper restores only a new launch and consumes each call before activation', () => {
  const f = fixture(), token = launch(f);
  assert.deepEqual(f.request({ action: 'finish', token, success: true }), { restored: true, ...owner });
  f.state.front = target;
  assert.equal(f.request({ action: 'finish', token, success: true }).restored, false);
  assert.deepEqual(f.activated, [owner]);
  for (const [name, change] of [
    ['launch failed', (f, r) => { r.success = false; }],
    ['target absent', f => { f.state.targets = []; }],
    ['ambiguous target', f => { f.state.targets = [target, other]; }],
    ['user switched', f => { f.state.front = other; }],
    ['real input', f => { f.state.idleSeconds = 0; }],
    ['unknown input', f => { f.state.idleSeconds = NaN; }],
    ['expired call', f => { f.state.time += 600; }],
    ['owner quit', f => { f.state.previous = undefined; }],
    ['owner restarted', f => { f.state.previous = { ...owner, pid: 99 }; }],
    ['pid reused', f => { f.state.previous = { ...other, pid: owner.pid }; }],
    ['driven bundle was owner', f => { f.state.targets = [owner]; f.state.front = owner; }],
  ]) {
    const f = fixture(), token = launch(f), request = { action: 'finish', token, success: true };
    change(f, request);
    assert.equal(f.request(request).restored, false, name);
    assert.deepEqual(f.activated, [], name);
  }
  for (const change of [f => { f.state.front = other; }, f => { f.state.time++; f.state.idleSeconds = 0; }]) {
    const f = fixture(), { token } = f.request({ action: 'begin', selector: 'Canvas' });
    change(f);
    assert.equal(f.request({ action: 'arm', token }).armed, false, 'switch or input before dispatch');
    f.state.targets = [target]; f.state.front = target;
    assert.equal(f.request({ action: 'finish', token, success: true }).restored, false);
    assert.deepEqual(f.activated, []);
  }
  const failed = fixture(), failedToken = launch(failed);
  failed.state.activationOK = false;
  assert.equal(failed.request({ action: 'finish', token: failedToken, success: true }).restored, false);
  failed.request({ action: 'finish', token: failedToken, success: true });
  assert.deepEqual(failed.activated, [owner], 'failed activation is never retried');
  for (const change of [f => { f.state.targets = [target]; }, f => { f.state.front = undefined; },
    f => { f.state.front = { ...owner, bundleId: undefined }; }]) {
    const f = fixture(); change(f);
    assert.equal(f.request({ action: 'begin', selector: 'Canvas' }).token, undefined);
    assert.deepEqual(f.activated, []);
  }
  // Exercise the JXA adapter with native objects supplied in memory, without macOS calls.
  const activated = [], apps = [];
  const native = data => ({ ...data, bundleIdentifier: data.bundleId, processIdentifier: data.pid,
    localizedName: data.app, isNil: () => false,
    activateWithOptions: options => { assert.equal(options, 0); activated.push(data.pid); ws.frontmostApplication = apps[0]; return true; } });
  apps.push(native(owner));
  const ws = { runningApplications: apps, frontmostApplication: apps[0] };
  let uptime = 100;
  const run = runInNewContext(readFileSync(source, 'utf8') + '\nrun', {
    ObjC: { unwrap: value => value }, matchingApps: (list, selector) => list.filter(a => a.localizedName === selector),
    $: { NSWorkspace: { sharedWorkspace: ws }, NSUUID: { UUID: { UUIDString: 'native-token' } },
      NSRunningApplication: { runningApplicationWithProcessIdentifier: pid => apps.find(a => a.pid === pid) },
      NSProcessInfo: { processInfo: { get systemUptime() { return uptime++; } } },
      NSRunLoop: { currentRunLoop: { runUntilDate() {} } }, NSDate: { dateWithTimeIntervalSinceNow() {} },
      CGEventSourceSecondsSinceLastEventType: (state, type) => { assert.equal(state, 1); assert.ok([1, 3, 25].includes(type), 'clicks only, never keys'); return 20; } },
  });
  const begin = run({ action: 'begin', selector: 'Canvas' });
  assert.equal(run({ action: 'arm', token: begin.token }).armed, true);
  apps.push(native(target)); ws.frontmostApplication = apps[1];
  assert.equal(run({ action: 'finish', token: begin.token, success: true }).restored, true);
  assert.deepEqual(activated, [12], 'native adapter only activates the earlier pid');
});

test('relay waits for the helper, reports restoration once, and skips failures and non-acquisitions', async () => {
  const f = fixture(), clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], trace = [], requests = [];
  serverIn.on('data', b => sent.push(...b.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', b => received.push(...b.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    trace: (event, detail) => trace.push({ event, detail }),
    frontRestore: async request => { requests.push(request); return f.request(request); } });
  const call = (id, code = 'let app = await cua.getApp("Canvas")') => clientIn.write(JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, isError = false) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id,
    result: { isError, content: [{ type: 'text', text: 'Window: "Sketch", App: Canvas.' }] } }) + '\n');
  try {
    call(1); assert.equal(sent.length, 0, 'snapshot precedes engine dispatch'); await settle();
    assert.equal(sent.at(-1).id, 1);
    f.state.targets = [target]; f.state.front = target; f.state.time++;
    reply(1); assert.equal(received.length, 0, 'restore precedes client result'); await settle();
    assert.match(JSON.stringify(received), /sleight gave the front back to Writer after the launch/);
    assert.equal(trace.filter(t => t.event === 'front-restored').length, 1);
    reply(1); await settle(); assert.deepEqual(f.activated, [owner]);
    f.state.front = owner; f.state.targets = [];
    call(7); await settle(); f.state.front = target; f.state.targets = [target];
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 7 }) + '\n'); await settle();
    assert.deepEqual(f.activated, [owner], 'a missing result is not a successful launch');
    for (const [id, kind] of [[2, 'failure'], [3, 'running'], [4, 'input'], [5, 'switched']]) {
      f.state.front = owner; f.state.previous = owner; f.state.idleSeconds = 20;
      f.state.targets = kind === 'running' ? [target] : [];
      call(id); await settle(); f.state.targets = [target]; f.state.front = target; f.state.time++;
      if (kind === 'input') f.state.idleSeconds = 0;
      if (kind === 'switched') f.state.front = other;
      reply(id, kind === 'failure'); await settle();
      assert.doesNotMatch(JSON.stringify(received.at(-1)), /gave the front back/);
    }
    const count = requests.length;
    call(6, 'await app.getAXState()'); await settle(); reply(6); await settle();
    assert.equal(requests.length, count, 'ordinary reads do not query front restoration');
    assert.deepEqual(f.activated, [owner], 'never activates the driven app');
  } finally { relay.dispose(); }
  for (const mode of ['off', 'unavailable', 'closed']) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const sent = [], received = [];
    serverIn.on('data', b => sent.push(JSON.parse(b)));
    clientOut.on('data', b => received.push(JSON.parse(b)));
    let helperCalls = 0, finishBegin;
    const old = process.env.SLEIGHT_FRONT_RESTORE;
    if (mode === 'off') process.env.SLEIGHT_FRONT_RESTORE = '0';
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
      frontRestore: request => {
        helperCalls++;
        if (mode === 'closed' && request.action === 'begin') return new Promise(resolve => { finishBegin = resolve; });
        if (mode === 'closed') { assert.equal(request.success, false); return {}; }
        throw new Error('helper unavailable');
      } });
    if (old === undefined) delete process.env.SLEIGHT_FRONT_RESTORE; else process.env.SLEIGHT_FRONT_RESTORE = old;
    try {
      clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'js', arguments: { code: 'await cua.getApp("org.example.canvas")' } } }) + '\n');
      if (mode === 'closed') { relay.dispose(); finishBegin({ token: 'cancel-me' }); }
      await settle();
      assert.equal(sent.length, mode === 'closed' ? 0 : 1, mode);
      assert.equal(helperCalls, mode === 'off' ? 0 : mode === 'closed' ? 2 : 1, mode);
      if (mode !== 'closed') {
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }) + '\n'); await settle();
        assert.equal(received.length, 1); assert.doesNotMatch(JSON.stringify(received), /gave the front back/);
      }
    } finally { relay.dispose(); }
  }
  // The production lease path splits a batched acquisition from its actions.
  const batch = fixture(), batchIn = new PassThrough(), batchOut = new PassThrough();
  const engineIn = new PassThrough(), engineOut = new PassThrough(), sentBatch = [], results = [];
  engineIn.on('data', b => sentBatch.push(JSON.parse(b)));
  batchOut.on('data', b => results.push(JSON.parse(b)));
  const batchRelay = createRelay({ clientIn: batchIn, clientOut: batchOut, serverIn: engineIn, serverOut: engineOut,
    changeReview: false, resultTrim: true,
    inputLease: { acquire: () => 'fixture-key', renew() {}, grant() {}, close() {} },
    frontRestore: async request => batch.request(request) });
  const batchReply = (id, text) => engineOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: {
    content: [{ type: 'text', text }], _meta: { 'codex/toolSurface': { app: { appId: 'org.example.canvas' } } },
  } }) + '\n');
  try {
    batchIn.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'js',
      arguments: { code: 'let app = await cua.getApp("Canvas"); await app.typeText("hello")' } } }) + '\n');
    await settle();
    assert.match(sentBatch[0].id, /^sleight-acquire-/);
    batch.state.targets = [target]; batch.state.front = target; batch.state.time++;
    batchReply(sentBatch[0].id, 'Window: "Sketch", App: Canvas.\n0 standard window Sketch');
    await settle();
    assert.equal(sentBatch.length, 2);
    assert.deepEqual(batch.activated, [owner], 'restoration precedes the batched action');
    batchReply(9, 'Window: "Sketch", App: Canvas.\n0 standard window Sketch\n1 text entry area hello');
    await settle();
    assert.equal(results.length, 1);
    assert.equal(JSON.stringify(results).match(/gave the front back/g)?.length, 1, 'notice survives acquisition trimming');
    assert.deepEqual(batch.activated, [owner]);
  } finally { await batchRelay.close(); }
});

test('front transactions reuse the probe helper instead of spawning for each acquisition', async () => {
  let spawned = 0;
  const { EventEmitter } = await import('node:events');
  const helper = createAppHealthHelper({ spawnHelper: kind => {
    assert.equal(kind, 'probe'); spawned++;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', 0)); };
    child.stdin.on('data', b => {
      const request = JSON.parse(b);
      child.stdout.write(JSON.stringify({ id: request.id, status: 'responding',
        ...(request.op === 'front-restore' ? { token: request.action } : {}) }) + '\n');
    });
    return child;
  } });
  try {
    assert.equal(typeof helper.frontRestore, 'function');
    assert.equal((await helper.frontRestore({ action: 'begin', selector: 'Canvas' })).token, 'begin');
    await helper.probe('Canvas');
    assert.equal((await helper.frontRestore({ action: 'finish', token: 'begin', success: true })).token, 'finish');
    assert.equal(spawned, 1);
  } finally { await helper.close(); }
});
