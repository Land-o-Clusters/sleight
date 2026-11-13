import { fakeReplNode } from './fixtures/repl-node-fake.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { DRIVER_CORE_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { InputLease, LEASE_MS, leaseKey } from '../plugins/sleight/lib/input-lease.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { macLeaseTarget } from '../plugins/sleight/lib/mac-safety.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';

const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'com.example.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
const binding = { windowId: window.windowId, processStart: window.processStart };
const identity = { pid: window.pid, processStart: window.processStart, bundleId: window.bundleId, token: 'fixture-token' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { restore, read, token = 'fixture-token', localTimeout = false, local, restart, policy, lease: customLease, driver: customDriver, replOptions, closeFailure, inputEnabled = false } = {}) {
  const order = [], requests = [], logs = [];
  let reads = 0;
  const driver = customDriver ?? {
      async ping() { return { build: 'a'.repeat(64), methods: ['localTool'] }; },
      async request(method, params, options) {
        if (method === 'inputGateState') return { enabled: true };
        order.push(method); requests.push({ method, params: structuredClone(params), options });
        if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app,
          pid: window.pid, processStart: window.processStart }, windows: [window] };
        if (method === 'verifyWindowIdentity') return { window };
        if (method === 'ping') return { methods: ['localTool'] };
        if (method === 'localTool' && local) return local();
        if (method === 'localTool' && localTimeout) throw Object.assign(Error('fixture timeout'), { code: 'DEADLINE_EXCEEDED' });
        if (method === 'rendererRestore') {
          const lease = params.args[0].lease;
          return restore ? restore({ lease }, options) : { restored: true, token: lease.token };
        }
        if (['getAXState', 'getAXStateAndScreenshot', 'getScreenshot'].includes(method)) {
          await read?.(method);
          return { window, text: 'Window: "Draft", App: Editor.\n0 standard window Draft', readId: ++reads,
            rendererAttributeChanged: false };
        }
        assert.fail('unexpected driver method ' + method);
      },
      async restart() { order.push('driver-restart'); await restart?.(); },
      async close() { order.push('driver-close'); },
    };
  // Only the offline input cases receive a capability, bound to this fake
  // driver through the production build pin and registrar.
  const inputRegistrar = inputEnabled ? await prepareMacInputRegistrar(driver, 'a'.repeat(64)) : undefined;
  const runtime = createOwnRuntime({
    driver, inputRegistrar, localToolOptions: { fallback: () => assert.fail('no live fallback') },
    lease: customLease ?? {
      acquire() { order.push('acquire'); return leaseKey(macLeaseTarget(window)); },
      renew() { order.push('renew'); },
      grant(key) { assert.equal(key, leaseKey(macLeaseTarget(window))); return { token }; },
      renewGrant(key, value) { assert.equal(key, leaseKey(macLeaseTarget(window))); assert.equal(value, token); order.push('renew-grant'); },
      release() { order.push('release'); }, close() { order.push('lease-close'); },
    },
    replOptions,
    approve: () => true, policy: policy ?? (() => ({ allow: true })),
    permissions: { app() {}, page() {}, sitesLimited: () => false },
    targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }], rendererLog: message => logs.push(message),
  });
  t.after(() => closeFailure ? assert.rejects(runtime.close(), closeFailure) : runtime.close());
  return { runtime, order, requests, logs,
    acquire: () => runtime.safety.request('getApp', { selector: 'Editor' }) };
}

test('leased acquisition and both AX reads carry the parent identity and token', async t => {
  const f = await fixture(t);
  await f.acquire();
  for (const method of ['getAXState', 'getAXStateAndScreenshot'])
    await f.runtime.safety.request(method, { ...binding, depth: 64, budgetMs: 1000 });
  const reads = f.requests.filter(row => ['getAXState', 'getAXStateAndScreenshot'].includes(row.method));
  assert.equal(reads.length, 3);
  for (const row of reads) assert.deepEqual(row.params.args, [{ renderer: true, lease: identity }]);
  assert.equal(reads[2].params.depth, 64); assert.equal(reads[2].params.budgetMs, 1000);
  await f.runtime.safety.request('getScreenshot', binding);
  const screenshot = f.requests.at(-1);
  assert.equal(screenshot.params.args, undefined);
});

test('evaluated requests cannot supply renderer controls or the restore operation', async t => {
  const f = await fixture(t); await f.acquire(); const before = f.requests.length;
  for (const params of [{ ...binding, renderer: true }, { ...binding, lease: identity },
    { ...binding, args: [{ renderer: true, lease: identity }] }])
    await assert.rejects(f.runtime.safety.request('getAXState', params), { code: 'INVALID_PARAMS' });
  await assert.rejects(f.runtime.safety.request('rendererRestore', { lease: identity }), { code: 'METHOD_NOT_FOUND' });
  assert.equal(f.requests.length, before);
});

test('a missing parent lease token refuses before dispatching content', async t => {
  const f = await fixture(t, { token: '' });
  await assert.rejects(f.acquire(), { code: 'LEASE_REFUSED' });
  assert.equal(f.requests.filter(row => row.method === 'getAXState').length, 0);
});

for (const ending of ['endTurn', 'reset', 'revoke', 'close']) {
  test(`${ending} waits for renderer confirmation before releasing its lease`, async t => {
    const held = deferred(), entered = deferred();
    const f = await fixture(t, { restore: params => { entered.resolve(); return held.promise.then(() => ({ restored: true, token: params.lease.token })); } });
    await f.acquire();
    const endingPromise = ending === 'close' ? f.runtime.close() : f.runtime.safety[ending](...[ending === 'revoke' ? [window.bundleId] : undefined].filter(Boolean));
    await entered.promise;
    assert.equal(f.order.includes('release'), false); assert.equal(f.order.includes('lease-close'), false);
    assert.equal(f.order.includes('driver-close'), false);
    held.resolve(); await endingPromise;
    assert.equal(f.requests.filter(row => row.method === 'rendererRestore').length, 1);
    assert.deepEqual(f.requests.find(row => row.method === 'rendererRestore').params, { args: [{ lease: identity }] });
    const release = f.order.indexOf(ending === 'close' ? 'lease-close' : 'release');
    assert.ok(release > f.order.indexOf('rendererRestore'));
    if (ending === 'close') assert.ok(f.order.indexOf('driver-close') > f.order.indexOf('rendererRestore'));
    else await assert.rejects(f.runtime.safety.request('getAXState', binding), { code: 'APP_NOT_ACQUIRED' });
    assert.deepEqual(f.logs, []);
  });
}

test('turn_ended replies only after restoration and lease release', async t => {
  const held = deferred(), entered = deferred();
  const f = await fixture(t, { restore: params => { entered.resolve(); return held.promise.then(() => ({ restored: true, token: params.lease.token })); } });
  await f.acquire();
  let replied = false;
  const response = once(f.runtime.serverOut, 'data').then(([bytes]) => { replied = true; return JSON.parse(bytes); });
  f.runtime.serverIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'turn_ended' } }) + '\n');
  await entered.promise; await tick(); assert.equal(replied, false);
  held.resolve(); assert.equal((await response).id, 1); assert.ok(f.order.includes('release'));
});

test('worker reset restores before restarting the shared helper', async t => {
  const f = await fixture(t); await f.acquire();
  const response = once(f.runtime.serverOut, 'data');
  f.runtime.serverIn.write(JSON.stringify({ id: 2, method: 'tools/call', params: { name: 'js_reset' } }) + '\n');
  const [bytes] = await response;
  assert.notEqual(JSON.parse(bytes).result.isError, true);
  assert.ok(f.order.indexOf('rendererRestore') < f.order.indexOf('driver-restart'));
  assert.ok(f.order.indexOf('release') < f.order.indexOf('driver-restart'));
});

test('local-tool timeout restores before restarting while already holding the scheduler', { timeout: 5000 }, async t => {
  const f = await fixture(t, { localTimeout: true }); await f.acquire();
  const result = await f.runtime.localServices.keyboardTapState();
  assert.equal(result.helperRestarted, true);
  assert.ok(f.order.indexOf('rendererRestore') < f.order.indexOf('driver-restart'));
  assert.deepEqual(f.logs, []);
});

test('revocation during a read restores after that read and before lease release', async t => {
  const held = deferred(), entered = deferred(); let count = 0;
  const f = await fixture(t, { read: () => { if (++count > 1) { entered.resolve(); return held.promise; } } });
  await f.acquire();
  const reading = f.runtime.safety.request('getAXState', binding);
  await entered.promise;
  const revoked = f.runtime.safety.revoke([window.bundleId]);
  assert.equal(f.order.includes('release'), false);
  held.resolve(); await assert.rejects(reading, { code: 'REPL_CELL_ENDED' }); await revoked;
  assert.ok(f.order.indexOf('rendererRestore') < f.order.indexOf('release'));
});

test('a timed-out queued restore collects the activating helper before releasing, then retries', { timeout: 10000 }, async t => {
  const held = deferred(), entered = deferred(), retiring = deferred(), collected = deferred(); let count = 0;
  const f = await fixture(t, { read: () => { if (++count > 1) { entered.resolve(); return held.promise; } },
    restart: () => { retiring.resolve(); return collected.promise; } });
  await f.acquire();
  const reading = f.runtime.safety.request('getAXState', binding);
  await entered.promise;
  const refused = assert.rejects(reading, { code: 'REPL_CELL_ENDED' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ending = f.runtime.safety.endTurn();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(2000); await retiring.promise;
  assert.equal(f.order.includes('release'), false);
  assert.equal(f.requests.filter(row => row.method === 'rendererRestore').length, 0);
  held.resolve(); await refused;
  collected.resolve(); await ending;
  assert.ok(f.order.indexOf('driver-restart') < f.order.indexOf('rendererRestore'));
  assert.ok(f.order.indexOf('rendererRestore') < f.order.indexOf('release'));
  assert.equal(f.requests.filter(row => row.method === 'rendererRestore').length, 1);
  assert.deepEqual(f.logs, []);
});

test('shutdown also waits for an already pending turn-end restore', async t => {
  const held = deferred(), entered = deferred();
  const f = await fixture(t, { restore: params => { entered.resolve(); return held.promise.then(() => ({ restored: true, token: params.lease.token })); } });
  await f.acquire(); const ended = f.runtime.safety.endTurn(); await entered.promise;
  const closing = f.runtime.close(); await tick(); assert.equal(f.order.includes('driver-close'), false);
  held.resolve(); await ended; await closing;
  assert.equal(f.requests.filter(row => row.method === 'rendererRestore').length, 1);
});

test('two bounded restore attempts retain durable undo and identify the app after retirement', { timeout: 10000 }, async t => {
  const f = await fixture(t, { restore: () => new Promise(() => {}) }); await f.acquire();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ending = assert.rejects(f.runtime.safety.endTurn(), /com.example.Editor pid 120.*may remain enabled/);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(2000);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(f.order.includes('release'), false);
  t.mock.timers.tick(2000); await ending;
  assert.equal(f.order.filter(row => row === 'driver-restart').length, 2);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /saved record retained for com.example.Editor pid 120 start 100.25/);
  assert.match(f.logs[0], /Automatic recovery leaves it unchanged; quitting the app clears it/);
  assert.ok(f.requests.filter(row => row.method === 'rendererRestore').every(row => row.options.timeoutMs <= 2000));
  assert.equal(f.requests.filter(row => row.method === 'rendererRestore').length, 2);
  assert.equal(f.order.includes('release'), false);
  f.runtime.safety.abandon();
});

test('a false or wrong-token restore reply cannot count as confirmation', async t => {
  for (const result of [{ restored: false, token: identity.token }, { restored: true, token: 'wrong-token' }]) {
    const f = await fixture(t, { restore: () => result }); await f.acquire();
    await assert.rejects(f.runtime.safety.endTurn(), /com.example.Editor pid 120.*may remain enabled/);
    assert.equal(f.logs.length, 1); assert.equal(f.order.includes('release'), false);
    f.runtime.safety.abandon();
  }
});

for (const inputEnabled of [false, true]) for (const ending of ['endTurn', 'reset', 'revoke']) {
  for (const reason of ['assistive-technology-running', 'value-changed-since', 'identity-changed', 'lease-unavailable', 'recovery-disabled']) {
    test(`${ending} releases a deliberately retained ${reason} record and admits later work (${inputEnabled ? 'gated input' : 'read-only preview'})`, async t => {
      const record = { ...identity, attribute: 'AXManualAccessibility', reason }; delete record.token;
      const f = await fixture(t, { inputEnabled, local: () => ({ ok: true }), restore: ({ lease }) => ({
        restored: true, retained: 1, token: lease.token,
        recovery: { restored: 0, retained: 1, failed: 0, reasonSaveFailed: 1, complete: true, remaining: [record] },
      }) });
      await f.acquire();
      await f.runtime.safety[ending](...[ending === 'revoke' ? [window.bundleId] : undefined].filter(Boolean));
      assert.equal(f.order.filter(op => op === 'release').length, 1);
      await f.acquire();
      await f.runtime.safety.request('getAXState', binding);
      const action = () => f.runtime.localServices.localTools.call('select_window', { app: 'Editor', title: 'Draft' },
        async () => true, undefined, { appId: window.bundleId });
      if (inputEnabled) assert.notEqual((await action()).isError, true);
      else await assert.rejects(action(), { code: 'METHOD_NOT_FOUND', delivery: 'not-sent', retry: 'safe' });
      assert.equal(f.requests.filter(row => row.method === 'getAXState').length, 3);
      assert.equal(f.requests.filter(row => row.method === 'localTool').length, inputEnabled ? 1 : 0);
      assert.equal(f.order.includes('driver-restart'), false); assert.deepEqual(f.logs, []);
    });
  }
}

test('synchronous exit retains lease reservations and logs deferred recovery', async t => {
  const f = await fixture(t); await f.acquire(); f.runtime.closeSync();
  assert.equal(f.order.includes('release'), false); assert.equal(f.order.includes('lease-close'), false);
  assert.equal(f.requests.filter(row => row.method === 'rendererRestore').length, 0);
  assert.match(f.logs[0], /synchronous exit.*saved record retained.*com.example.Editor pid 120.*quitting the app clears it.*leases expire/);
});

test('the unchanged real driver client transports the renderer read and restore envelopes', async t => {
  const requests = [];
  const driver = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', build: 'b'.repeat(64),
    spawn: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(bytes, _encoding, done) {
        const request = JSON.parse(bytes); requests.push(request); done();
        const result = request.method === 'ping' ? { protocol: 'sleight.driver/1', apiVersion: 2,
          build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, 'rendererRestore'] } :
          request.method === 'rendererRestore' ? { restored: true, token: request.params.args[0].lease.token } : { rendererAttributeChanged: false };
        queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
          nonce: request.nonce, id: request.id, ok: true, result }) + '\n'));
      } });
      child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
      return child;
    },
  }) });
  t.after(() => driver.close());
  for (const method of ['getAXState', 'getAXStateAndScreenshot']) {
    const params = { ...binding, args: [{ renderer: true, lease: identity }] };
    assert.equal((await driver.request(method, params)).rendererAttributeChanged, false);
    assert.deepEqual(requests.at(-1).params, params);
  }
  assert.equal((await driver.request('rendererRestore', { args: [{ lease: identity }] })).restored, true);
  assert.equal(requests.length, 4);
});

test('a lease that expires behind a local action refuses its queued renderer write', async t => {
  let clock = 1, checks = 0, blocking;
  const entered = deferred(), held = deferred();
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-renderer-lease-'))));
  const lease = new InputLease({ directory, now: () => clock });
  const f = await fixture(t, { lease, local: () => { entered.resolve(); return held.promise; },
    policy: () => {
      if (++checks === 3) blocking = f.runtime.localServices.keyboardTapState();
      return { allow: true };
    } });
  const acquiring = f.acquire();
  const refused = assert.rejects(acquiring, { code: 'LEASE_REFUSED' });
  await entered.promise; await tick(); // The final safety renew ran; the read is queued.
  const key = leaseKey(macLeaseTarget(window));
  assert.equal(typeof lease.grant(key).token, 'string');
  clock += LEASE_MS;
  assert.equal(lease.inspect(key).active, false);
  held.resolve({ ok: true }); await blocking; await refused;
  assert.equal(f.requests.filter(row => row.method === 'getAXState').length, 0);
});

test('failed helper retirement retains the lease instead of releasing around a running read', async t => {
  const f = await fixture(t, { restore: () => ({ restored: false }), restart: () => { throw Error('collect failed'); } });
  await f.acquire();
  await assert.rejects(f.runtime.safety.endTurn(), error => {
    assert.match(error.message, /com.example.Editor pid 120 start 100.25/);
    assert.match(error.message, /retirement failed/); assert.equal(error.cause.message, 'collect failed'); return true;
  });
  assert.equal(f.logs.length, 1); assert.match(f.logs[0], /com.example.Editor pid 120 start 100.25/);
  assert.equal(f.order.includes('release'), false);
  await assert.rejects(f.runtime.safety.reset(), /com.example.Editor pid 120 start 100.25/);
  assert.equal(f.order.includes('release'), false);
  f.runtime.safety.abandon();
});

test('the real client collects its timed-out helper before a fresh-helper undo and release', { timeout: 10000 }, async t => {
  const handles = [], killed = deferred(), entered = deferred(); let reads = 0, f;
  const driver = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', build: 'b'.repeat(64),
    spawn: () => {
      const child = new EventEmitter(); handles.push(child);
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(bytes, _encoding, done) {
        const request = JSON.parse(bytes); done();
        f.order.push('wire:' + request.method);
        let result;
        if (request.method === 'ping') result = { protocol: 'sleight.driver/1', apiVersion: 2,
          build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, 'rendererRestore'] };
        else if (request.method === 'resolveApp') result = { app: { id: window.bundleId, name: window.app,
          pid: window.pid, processStart: window.processStart }, windows: [window] };
        else if (request.method === 'verifyWindowIdentity') result = { window };
        else if (request.method === 'getAXState') {
          if (++reads === 2) { entered.resolve(); return; }
          result = { window, text: 'Window: "Draft", App: Editor.\n0 standard window Draft', readId: reads };
        } else if (request.method === 'rendererRestore') result = { restored: true, token: request.params.args[0].lease.token };
        else assert.fail(request.method);
        queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
          nonce: request.nonce, id: request.id, ok: true, result }) + '\n'));
      } });
      child.kill = () => {
        f.order.push('kill');
        if (handles.length === 1) killed.resolve();
        else queueMicrotask(() => child.emit('close', 0));
        return true;
      };
      return child;
    },
  }) });
  f = await fixture(t, { driver }); await f.acquire();
  const reading = f.runtime.safety.request('getAXState', binding);
  const refused = assert.rejects(reading, { code: 'DRIVER_RESTARTED' }); await entered.promise;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ending = f.runtime.safety.endTurn();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(2000); await killed.promise; await refused;
  assert.equal(f.order.includes('release'), false); assert.equal(handles.length, 1);
  f.order.push('collected'); handles[0].emit('close', 0);
  await ending;
  assert.equal(handles.length, 2);
  assert.ok(f.order.indexOf('collected') < f.order.indexOf('wire:rendererRestore'));
  assert.ok(f.order.indexOf('wire:rendererRestore') < f.order.indexOf('release'));
  assert.deepEqual(f.logs, []);
});

for (const priorEnd of [false, true]) test(`unsafe restore still closes the driver, worker and streams (prior end ${priorEnd})`, async t => {
  const worker = new EventEmitter(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
  worker.connected = true;
  let kills = 0, collected = false;
  worker.kill = () => { kills++; queueMicrotask(() => { collected = true; worker.emit('close', 0); }); return true; };
  worker.send = (message, callback) => {
    callback?.(); queueMicrotask(() => worker.emit('message', { type: 'result', id: message.id, result: { content: [] } }));
  };
  const failure = /com.example.Editor pid 120 start 100.25/;
  const f = await fixture(t, { restore: () => ({ restored: false }), replOptions: { selectNode: fakeReplNode, spawn: () => worker }, closeFailure: failure });
  const response = once(f.runtime.serverOut, 'data');
  f.runtime.serverIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } }) + '\n');
  await response; await f.acquire();
  if (priorEnd) await assert.rejects(f.runtime.safety.endTurn(), failure);
  await assert.rejects(f.runtime.close(), failure);
  assert.ok(f.order.includes('driver-close')); assert.ok(kills > 0); assert.equal(collected, true);
  assert.equal(f.runtime.serverIn.destroyed, true); assert.equal(f.runtime.serverOut.destroyed, true);
  assert.equal(f.order.includes('release'), false); assert.equal(f.order.includes('lease-close'), false);
  assert.equal(f.logs.length, 1);
});

test('helper renderer stderr reaches diagnostics through a bounded metadata filter', async t => {
  const logs = []; let child;
  const driver = createMacDriverClient({ platform: 'darwin', diagnostics: line => logs.push(line),
    prepare: async () => ({ status: 'ready', spawn: () => {
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(bytes, _encoding, done) {
        const request = JSON.parse(bytes); done();
        queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
          nonce: request.nonce, id: request.id, ok: true, result: { protocol: 'sleight.driver/1', apiVersion: 2,
            build: 'b'.repeat(64), methods: DRIVER_CORE_METHODS } }) + '\n'));
      } });
      child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; }; return child;
    } }),
  });
  t.after(() => driver.close()); await driver.ping();
  child.stderr.write('PRIVATE APP CONTENT\n');
  const disabled = 'sleight: renderer recovery state unavailable; activation disabled.';
  child.stderr.write(disabled.slice(0, 15)); child.stderr.write(disabled.slice(15) + '\n');
  const row = { pid: 120, processStart: '100.25', bundleId: 'com.example.Editor', attribute: 'AXManualAccessibility',
    reason: 'AX_UNAVAILABLE', title: 'PRIVATE APP CONTENT' };
  const report = { restored: 0, skipped: 0, quarantined: 0, pruned: 0, failed: 1, complete: true, remaining: [row],
    title: 'PRIVATE APP CONTENT' };
  child.stderr.write('sleight: renderer recovery pending: ' + JSON.stringify(report) + '\n');
  child.stderr.write('sleight: renderer recovery: ' + JSON.stringify({ ...report, remaining: [{ ...row, bundleId: 'com.example.Editor\n' }] }) + '\n');
  child.stderr.write('x'.repeat(70000) + '\n' + disabled + '\n');
  assert.equal(logs.length, 3); assert.equal(logs[0], disabled); assert.equal(logs[2], disabled);
  assert.match(logs[1], /com.example.Editor/); assert.match(logs[1], /AX_UNAVAILABLE/);
  assert.doesNotMatch(logs.join('\n'), /PRIVATE APP CONTENT|"title"/);
  child.stderr.write('sleight: renderer recovery: ' + JSON.stringify({ ...report, failed: 0, remaining: [],
    dropped: [{ ...row, reason: 'already-restored' }] }) + '\n');
  assert.match(logs[3], /already-restored/);
  for (const reason of ['assistive-technology-running', 'value-changed-since', 'identity-changed', 'lease-unavailable', 'recovery-disabled']) {
    child.stderr.write('sleight: renderer recovery: ' + JSON.stringify({ ...report, retained: 1, failed: 0, reasonSaveFailed: 1, remaining: [{ ...row, reason }] }) + '\n');
    assert.match(logs.at(-1), new RegExp(reason));
    assert.match(logs.at(-1), /"retained":1/); assert.match(logs.at(-1), /"failed":0/);
    assert.match(logs.at(-1), /"reasonSaveFailed":1/);
  }
  for (const key of ['retained', 'reasonSaveFailed']) for (const value of [-1, 1.5, '1', null]) {
    const count = logs.length;
    child.stderr.write('sleight: renderer recovery: ' + JSON.stringify({ ...report, [key]: value }) + '\n');
    assert.equal(logs.length, count);
  }
  for (let i = 0; i < 100; i++) child.stderr.write(disabled + '\n');
  assert.equal(logs.length, 64);
  await driver.ping();
});

test('failed retry retirement names the app and keeps its lease', async t => {
  let restarts = 0;
  const f = await fixture(t, { restore: () => ({ restored: false }), restart: () => {
    if (++restarts === 2) throw Object.assign(Error('collect failed'), { code: 'DRIVER_RETIRE_TIMEOUT' });
  } });
  await f.acquire();
  await assert.rejects(f.runtime.safety.endTurn(), error => {
    assert.match(error.message, /com.example.Editor pid 120 start 100.25/);
    assert.match(error.message, /DRIVER_RETIRE_TIMEOUT/); assert.equal(error.cause.message, 'collect failed'); return true;
  });
  assert.equal(restarts, 2); assert.equal(f.logs.length, 1);
  assert.equal(f.order.includes('release'), false); f.runtime.safety.abandon();
});

test('the own runtime routes helper recovery diagnostics to its parent logger', async t => {
  const logs = []; let child;
  const runtime = createOwnRuntime({ rendererLog: line => logs.push(line),
    driverOptions: { platform: 'darwin', prepare: async () => ({ status: 'ready', spawn: () => {
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(bytes, _encoding, done) {
        const request = JSON.parse(bytes); done();
        const result = request.method === 'ping' ? { protocol: 'sleight.driver/1', apiVersion: 2, build: 'b'.repeat(64),
          methods: [...DRIVER_CORE_METHODS, 'rendererRestore'] } : request.method === 'resolveApp' ?
          { app: { id: window.bundleId, name: window.app, pid: window.pid, processStart: window.processStart }, windows: [window] } :
          request.method === 'verifyWindowIdentity' ? { window } : request.method === 'rendererRestore' ?
          { restored: true, token: request.params.args[0].lease.token } : { window, text: 'fake tree', readId: 1 };
        queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
          nonce: request.nonce, id: request.id, ok: true, result }) + '\n'));
      } });
      child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; }; return child;
    } }) },
    lease: { acquire: () => leaseKey(macLeaseTarget(window)), renew() {}, grant: () => ({ token: identity.token }), renewGrant() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), permissions: { app() {}, page() {}, sitesLimited: () => false },
    targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }],
  });
  t.after(() => runtime.close());
  await runtime.safety.request('getApp', { selector: 'Editor' });
  child.stderr.write('sleight: renderer recovery state unavailable; activation disabled.\n');
  assert.deepEqual(logs, ['sleight: renderer recovery state unavailable; activation disabled.']);
});
