import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { selectRuntime, createOwnRuntime, runOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { macProcessAncestry } from '../plugins/sleight/lib/mac-safety.mjs';
import { createMacReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { createCursorEvents } from '../plugins/sleight/lib/hand/events.mjs';
import { createV3Bridge, createV3Frontend, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';

test('INT22C scheduled safety rejects coordinate evidence from a replaced helper generation', async t => {
  let generation = Symbol('first helper'), readId = 0, captureId = 100;
  const calls = [];
  const window = { windowId: '42', pid: 321, processStart: '1.25', bundleId: 'org.test.App', app: 'Fixture',
    title: 'Draft', identityVerified: true, onScreen: true, minimized: false,
    bounds: { x: 0, y: 0, width: 400, height: 300 } };
  const binding = { windowId: '42', processStart: '1.25' };
  const driver = { get helperGeneration() { return generation; },
    ping: async () => ({ build: 'a'.repeat(64) }), async close() {}, async restart() {},
    async request(method, params) {
      calls.push([method, structuredClone(params)]);
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app,
        pid: window.pid, processStart: window.processStart }, windows: [window] };
      if (method === 'verifyWindowIdentity') return { window };
      if (method === 'personState') return { token: 'fixture', personTookOver: false };
      if (method === 'getAXState') return { window, text: 'Window: "Draft", App: Fixture.\n0 standard window Draft\n\t1 button Press',
        readId: ++readId, truncated: false };
      if (method === 'getScreenshot') return { window, coordinateReadId: captureId,
        screenshot: { data: 'fixture-image', mimeType: 'image/png' } };
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'click') return { window, delivery: 'sent-unverified' };
      assert.fail(method);
    } };
  const runtime = createOwnRuntime({ driver, compactReads: false,
    inputRegistrar: await prepareMacInputRegistrar(driver, 'a'.repeat(64)),
    lease: { acquire: () => 'lease', grant: () => ({ token: 'lease-token' }), renewGrant() {}, renew() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 999, path: '/fixture/host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false }, ownHostPid: () => false });
  t.after(() => runtime.close());
  runtime.safety.setPolicy({ checkPause() {}, beforeAction: ({ args }) => ({ args }) });
  await runtime.safety.request('getApp', { selector: 'Fixture' });
  const capture = () => runtime.safety.request('getScreenshot', binding);
  const click = () => runtime.safety.request('click', { ...binding, readId: 1, args: [[40, 30]] });
  const old = await capture();
  runtime.safety.recordReadDelivery(old, { screenshotDelivered: true });
  generation = Symbol('replacement helper'); readId = 0;
  await capture();
  await assert.rejects(click(), { code: 'TARGET_CHANGED' });
  runtime.safety.recordReadDelivery(old, { screenshotDelivered: true });
  await assert.rejects(click(), { code: 'TARGET_CHANGED' });
  assert.equal(calls.filter(([method]) => method === 'click').length, 0);
  captureId = 1;
  runtime.safety.recordReadDelivery(await capture(), { screenshotDelivered: true });
  await click();
  assert.equal(calls.filter(([method]) => method === 'click').length, 1);
  assert.equal(calls.findLast(([method]) => method === 'click')[1].coordinateReadId, 1);
});

test('runtime defaults to engine, own requires the exact opt-in value', () => {
  assert.equal(selectRuntime({}), 'engine');
  assert.equal(selectRuntime({ SLEIGHT_RUNTIME: 'engine' }), 'engine');
  assert.equal(selectRuntime({ SLEIGHT_RUNTIME: 'own' }), 'own');
  for (const value of ['', 'OWN', ' own', 'native', 'false']) assert.throws(() => selectRuntime({ SLEIGHT_RUNTIME: value }), /engine or own/);
});

test('engine startup does not load the own runtime module graph', () => {
  const source = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (/\\/(?:runtime-select|mac-safety|repl\\/client|mac-driver\\/client)\\.mjs$/.test(result.url))
        throw Error('OWN_GRAPH_LOADED: ' + result.url);
      return result;
    } });
    delete process.env.SLEIGHT_RUNTIME;
    const { run } = await import(${JSON.stringify(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).href)});
    await run({ platform: 'darwin', sweepClipboard: () => {}, recoverClipboard: async () => { throw Error('ENGINE_START_REACHED'); } })
      .then(() => { throw Error('unexpected startup'); }, error => {
        if (error.message !== 'ENGINE_START_REACHED') throw error;
      });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { killSignal: 'SIGKILL', timeout: 10000, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

test('ancestry follows actual executable paths with bounded parent-only metadata', () => {
  const calls = [];
  const rows = macProcessAncestry({ pid: 100,
    executable: pid => `/Applications/Host.app/Contents/MacOS/${pid}`,
    readBundleId: () => 'test.host',
    run(file, args) { calls.push([file, args]); return args[1] === '100' ? '50\n' : '1\n'; },
  });
  assert.deepEqual(rows.map(row => row.pid), [100, 50]);
  assert.deepEqual(rows.map(row => row.bundleId), ['test.host', 'test.host']);
  assert.deepEqual(calls[0], ['/bin/ps', ['-p', '100', '-o', 'ppid=']]);
  assert.throws(() => macProcessAncestry({ pid: 100, executable: () => undefined }), /ANCESTRY/);
  assert.throws(() => macProcessAncestry({ pid: 100, executable: () => '/bin/node', run: () => '100' }), /ANCESTRY/);
});

test('the launcher selects own before clipboard recovery or engine startup', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('export async function run('));
  assert.ok(run.indexOf("selectRuntime() === 'own'") < run.indexOf('await recoverClipboard()'));
  assert.ok(run.indexOf('runOwnRuntime(') < run.indexOf('await startEngine('));
  assert.match(run.slice(0, run.indexOf('await recoverClipboard()')), /return .*runOwnRuntime/);
});

test('close keeps its first rejected promise and still closes policy after the fake driver', async () => {
  const order = [], failure = Error('fixture driver cleanup failed');
  const runtime = createOwnRuntime({
    driver: { request() { assert.fail('no driver request'); }, restart() { assert.fail('no restart during close'); },
      async close() { order.push('driver'); throw failure; } },
    lease: { close() { order.push('lease'); }, release() { assert.fail('no lease release before final close'); } },
  });
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  await assert.rejects(closing, error => error === failure);
  assert.equal(runtime.close(), closing);
  await assert.rejects(runtime.close(), error => error === failure);
  assert.deepEqual(order, ['driver', 'lease']);
  assert.equal(runtime.serverIn.destroyed, true); assert.equal(runtime.serverOut.destroyed, true);
});

test('a fake driver must finish cleanup before the lease is released', async () => {
  const order = [];
  let collect;
  const held = new Promise(resolve => { collect = resolve; });
  const runtime = createOwnRuntime({
    driver: { async close() { order.push('driver-stop'); await held; order.push('driver-collected'); } },
    lease: { close() { order.push('lease'); }, release() { assert.fail('no early reset'); } },
  });
  const closing = runtime.close();
  await Promise.resolve();
  assert.deepEqual(order, ['driver-stop']);
  collect(); await closing;
  assert.deepEqual(order, ['driver-stop', 'driver-collected', 'lease']);
});

test('a js call dispatched during shutdown returns REPL_CLOSED without starting work', { timeout: 10000 }, async t => {
  let stop, collect, closed = false, spawned = 0, dispatched = 0;
  const stopping = new Promise(resolve => { stop = resolve; });
  const held = new Promise(resolve => { collect = resolve; });
  const repl = createMacReplClient({
    driver: { async restart() { stop(); await held; }, async close() { closed = true; } },
    spawn() { spawned++; assert.fail('a closing REPL cannot start a worker'); },
    dispatch() { dispatched++; assert.fail('a closing REPL cannot request native work'); },
  });
  t.after(async () => { collect(); await repl.close(); });
  const closing = repl.close(); await stopping;
  assert.equal(closed, false, 'driver cleanup is still pending');
  // Call the same dispatcher the runtime line handler uses. A closed readline
  // would drop a transport write and could never prove this refusal.
  const pending = repl.execute({ code: 'await cua.getApp("Editor");' }, { id: 1 });
  assert.equal(spawned, 0); assert.equal(dispatched, 0);
  assert.equal(closed, false, 'the new call does not finish shutdown');
  collect(); await closing;
  const result = await pending;
  assert.deepEqual(result, { isError: true, content: [{ type: 'text', text: 'REPL_CLOSED' }] });
  assert.equal(spawned, 0); assert.equal(dispatched, 0);
  assert.equal(closed, true);
});

async function inertServer({ input = new PassThrough(), output = new PassThrough(), turnHook, ...options } = {}) {
  const order = [], signals = new EventEmitter();
  const owner = await runOwnRuntime({ input, output, signals, turnHook,
    driver: { async close() { order.push('driver'); } },
    lease: { close() { order.push('lease'); }, release() { order.push('release'); } },
    policy: () => ({ allow: true }), permissions: { app() {}, page() {}, sitesLimited: () => false },
    allowForbidden: () => false, ownHostPid: () => false,
    approvalStorage: { load: () => ({}), live: () => ({ list: () => [], allows: () => false }) },
    grantAudit() {}, relayOptions: { idleTurnEndMs: 0 }, ...options,
  });
  return { owner, signals, order, input, output };
}

test('an approved Electron turbo turn keeps its input on the worker while Glide is selected', async t => {
  const child = new EventEmitter(), endpoint = new EventEmitter(), turboCalls = [], nativeCalls = [];
  child.connected = endpoint.connected = true;
  child.send = value => queueMicrotask(() => endpoint.emit('message', structuredClone(value)));
  endpoint.send = value => queueMicrotask(() => child.emit('message', structuredClone(value)));
  child.unref = () => {};
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  const service = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin(message, binding, { apps }) {
    assert.deepEqual(apps, ['com.microsoft.VSCode']);
    return { async call(request) { turboCalls.push(request); return { text: 'Electron CDP fixture', isError: false }; },
      delivered: () => true, end: async () => ({ revoked: true, cleanup: [] }) };
  } });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker() { queueMicrotask(() => service.ready()); return child; } });
  t.after(() => bridge.detach());
  assert.equal(await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'uc2c', text: 'click the fixture' }, ['com.microsoft.VSCode']), true);
  const f = await inertServer({ directBrowser: createV3Frontend(bridge),
    driver: { request(...args) { nativeCalls.push(args); throw Error('Unexpected Glide request'); }, close: async () => {} } });
  t.after(() => f.owner.close());
  let output = ''; f.output.on('data', data => { output += data; });
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'browser_act',
    arguments: { tab: 't1', steps: [{ do: 'press', key: 'a' }] } } }) + '\n');
  for (let tick = 0; tick < 50 && !output.includes('Electron CDP fixture'); tick++) await new Promise(resolve => setImmediate(resolve));
  assert.match(output, /Electron CDP fixture/);
  assert.equal(turboCalls.length, 1); assert.equal(turboCalls[0].name, 'browser_act');
  assert.deepEqual(nativeCalls, []);
});
test('own runtime starts with zero saved grants when approval loading fails', async () => {
  let grants;
  const f = await inertServer({ approvalStorage: { load() { throw Error('unsafe fixture list'); },
    live(initial) { grants = initial; return initial; } } });
  try { assert.equal(grants.size, 0); assert.equal(grants.allows('com.apple.finder', 'low'), false); }
  finally { await f.owner.close(); }
});

test('a disabled cursor does not attach a runtime event consumer', async () => {
  const cursor = createCursorEvents({ env: {}, setting: () => ({ stream: false, style: 'off' }) });
  const f = await inertServer({ relayOptions: { idleTurnEndMs: 0, cursor } });
  try { assert.equal(f.owner.runtime.actionEvents.enabled, false); }
  finally { await f.owner.close(); }
});

test('an enabled cursor attaches a runtime event consumer', async () => {
  const cursor = createCursorEvents({ env: {}, setting: () => ({ stream: true, style: 'off' }),
    sink: { write() {}, close() {} }, repeat: () => ({ unref() {} }), cancelRepeat() {} });
  const f = await inertServer({ relayOptions: { idleTurnEndMs: 0, cursor } });
  try { assert.equal(f.owner.runtime.actionEvents.enabled, true); }
  finally { await f.owner.close(); }
});

test('an enabled hand attaches a runtime event consumer without a cursor', async () => {
  const f = await inertServer({ relayOptions: { idleTurnEndMs: 0, runtimeHandClient: { enabled: true } } });
  try { assert.equal(f.owner.runtime.actionEvents.enabled, true); }
  finally { await f.owner.close(); }
});

test('already ended or destroyed transports close without starting a worker or helper', { timeout: 10000 }, async t => {
  for (const state of ['readableEnded', 'destroyed', 'output-destroyed']) {
    const input = new PassThrough(), output = new PassThrough();
    if (state === 'readableEnded') Object.defineProperty(input, state, { value: true });
    else if (state === 'destroyed') input.destroy();
    else output.destroy();
    const f = await inertServer({ input, output });
    t.after(() => f.owner.close());
    if (!f.owner.runtime.serverIn.destroyed) await new Promise(resolve => f.owner.runtime.serverIn.once('close', resolve));
    assert.deepEqual(f.order.slice(0, 2), ['driver', 'lease']);
    await f.owner.close();
    assert.equal(f.owner.runtime.serverIn.destroyed, true);
    assert.deepEqual(f.order, ['driver', 'lease', 'release']);
    assert.equal(f.signals.listenerCount('exit'), 0);
  }
});

test('a driver close that never settles hits the fixed 5 second deadline and keeps its rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closed = 0;
  const runtime = createOwnRuntime({ driver: { close: () => new Promise(() => {}) },
    lease: { close() { closed++; } } });
  const closing = runtime.close();
  const rejected = assert.rejects(closing, /OWN_RUNTIME_SHUTDOWN_TIMEOUT/);
  await Promise.resolve();
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(closed, 0);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(closed, 1);
  assert.equal(runtime.serverIn.destroyed, true); assert.equal(runtime.serverOut.destroyed, true);
  assert.equal(runtime.close(), closing);
  await assert.rejects(runtime.close(), /OWN_RUNTIME_SHUTDOWN_TIMEOUT/);
});

test('server close retains a rejected completion and runs later cleanup once', async () => {
  let hooks = 0;
  const failure = Error('fixture turn hook failed');
  const f = await inertServer({ turnHook: { close() { hooks++; throw failure; } } });
  const closing = f.owner.close(); assert.equal(f.owner.close(), closing);
  await assert.rejects(closing, error => error === failure);
  assert.equal(f.owner.close(), closing); await assert.rejects(f.owner.close(), error => error === failure);
  assert.equal(hooks, 1); assert.deepEqual(f.order, ['driver', 'lease', 'release']);
  assert.equal(f.signals.listenerCount('exit'), 0);
});

test('a shell card close that never settles cannot hold runtime leases past 5 seconds', async t => {
  const { shellRelayOptions } = await import('../plugins/sleight/lib/launch.mjs');
  const f = await inertServer({ turboUnavailable: shellRelayOptions(undefined, null).turboUnavailable,
    paymentCardFactory: () => ({ close: () => new Promise(() => {}) }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = f.owner.close();
  const rejected = assert.rejects(closing, /OWN_CONSENT_SHUTDOWN_TIMEOUT/);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(5000);
  // Do not await an unbounded close on the unfixed implementation.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.ok(f.order.includes('lease'), 'stuck consent close prevented runtime lease cleanup');
  await rejected;
  assert.equal(f.owner.close(), closing);
  assert.deepEqual(f.order, ['driver', 'lease', 'release']);
  assert.equal(f.signals.listenerCount('exit'), 0);
});

test('worker tests skip with REPL_NODE_UNSUPPORTED when --allow-net is unavailable', () => {
  const source = `Object.defineProperty(process, 'allowedNodeEnvironmentFlags', {
    value: new Set([...process.allowedNodeEnvironmentFlags].filter(flag => flag !== '--allow-net')),
  });
  await import(${JSON.stringify(new URL('./mac-driver-multi-session.test.mjs', import.meta.url).href)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /REPL_NODE_UNSUPPORTED/);
  assert.match(child.stdout, /\bpass 0\b/); assert.match(child.stdout, /\bfail 0\b/);
  assert.match(child.stdout, /\bskipped 21\b/);
});

test('approval removal observes asynchronous revocation cleanup failures', async t => {
  let removed;
  const f = await inertServer({ approvalStorage: { load: () => ({}), live: () => ({
    list: () => [], allows: () => false, onRemoved(listener) { removed ??= listener; },
  }) } });
  t.after(() => f.owner.close());
  const messages = [];
  const original = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (bytes, ...args) => {
    if (String(bytes).startsWith('sleight: approval revocation cleanup failed:')) { messages.push(String(bytes)); return true; }
    return original(bytes, ...args);
  });
  for (const asynchronous of [false, true]) {
    let revoked = false;
    f.owner.runtime.safety.revoke = () => {
      revoked = true;
      if (asynchronous) return Promise.reject(Error('fixture async release failed'));
      throw Error('fixture sync release failed');
    };
    removed(['com.example.Editor']);
    assert.equal(revoked, true, 'revocation invalidates synchronously');
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(messages.length, 2);
  assert.match(messages[0], /fixture sync release failed/);
  assert.match(messages[1], /fixture async release failed/);
});


test('Electron route regression test detects a disabled turbo frontend', () => {
  const hook = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url.endsWith('/plugins/sleight/lib/runtime-select.mjs')) {
        const source = String(result.source);
        const from = 'directBrowser, directHost, turboUnavailable, clientIn: normalizedInput';
        if (!source.includes(from)) throw Error('MUTATION_NOT_APPLIED');
        return { ...result, source: source.replace(from, 'directBrowser: undefined, directHost: undefined, turboUnavailable, clientIn: normalizedInput') };
      }
      return result;
    } });`;
  const child = spawnSync(process.execPath, ['--import', 'data:text/javascript;base64,' + Buffer.from(hook).toString('base64'),
    '--test', '--test-reporter=tap', '--test-name-pattern=^an approved Electron turbo turn keeps its input on the worker while Glide is selected$',
    'tests/runtime-select.test.mjs'], { timeout: 20000, killSignal: 'SIGKILL', encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.doesNotMatch(child.stdout + child.stderr, /MUTATION_NOT_APPLIED/);
  assert.match(child.stdout, /not ok.*approved Electron turbo turn/);
  assert.match(child.stdout + child.stderr, /Electron CDP fixture/);
});
