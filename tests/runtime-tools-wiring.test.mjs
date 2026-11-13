import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnRuntime, runOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { createMacRuntimeTools } from '../plugins/sleight/lib/mac-driver/runtime-tools.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { trackTemp, registerTemp } from '../scripts/temp-leftovers.mjs';

const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'com.example.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
const plain = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const failure = code => Object.assign(Error(code), { code });
const temporary = t => registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-runtime-tools-'))));

async function fixture(t, { ping, reply, inputEnabled = true, ...localToolOptions } = {}) {
  const calls = [], scripts = [];
  const driver = {
    async ping() { calls.push(['ping']); return ping ? ping() : { methods: ['localTool', 'resolveApp'] }; },
    async request(method, params) {
      if (method === 'inputGateState') return { enabled: true };
      calls.push([method, structuredClone(params)]);
      if (reply) return reply(method, params);
      if (method === 'resolveApp') return { app: { id: window.bundleId, pid: window.pid, processStart: window.processStart, running: true } };
      return { ok: true, path: 'background', target: { appId: window.bundleId, title: window.title } };
    },
    async close() {}, async restart() {},
  };
  const originalPing = driver.ping;
  driver.ping = async () => ({ build: 'a'.repeat(64) });
  const inputRegistrar = inputEnabled ? await prepareMacInputRegistrar(driver, 'a'.repeat(64)) : undefined;
  driver.ping = originalPing;
  const runtime = createOwnRuntime({ driver, inputRegistrar,
    lease: { renew() {}, release() {}, close() {} },
    localToolOptions: { fallback: async (script, request) => { scripts.push([script, request]); return { ok: true, fallback: true }; }, ...localToolOptions },
  });
  t.after(() => runtime.close());
  return { runtime, services: runtime.localServices, calls, scripts };
}

test('the gated facade wires local results and registers the reviewed input tools', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.calls, [], 'construction is inert');
  assert.deepEqual(f.services.localTools.tools.map(tool => tool.name).sort(), ['drag', 'open_file', 'select_window']);
  for (const [name, args, script] of [
    ['menu_bar', { op: 'apps' }, 'menubar.js'],
    ['notifications', { op: 'list' }, 'menubar.js'],
    ['select_window', { app: 'Editor', title: 'Draft' }, 'select-window.js'],
  ]) {
    const result = await f.services.localTools.call(name, args, async () => true);
    assert.notEqual(result.isError, true, plain(result));
    assert.match(plain(result), /com.example.Editor/);
    assert.equal(f.calls.at(-1)[1].args[0], script);
  }
  assert.deepEqual(f.scripts, []);
});

test('the own open_file result goes through the driver with a temporary document', async t => {
  const path = join(temporary(t), 'fixture.txt'); writeFileSync(path, 'fixture');
  const f = await fixture(t);
  const result = await f.services.localTools.call('open_file', { app: 'Editor', path }, async () => true);
  assert.notEqual(result.isError, true, plain(result));
  assert.ok(f.calls.some(([method, params]) => method === 'localTool' && params.args[0] === 'open-file-window.js' && params.args[1].op === 'open'));
  assert.deepEqual(f.scripts, []);
});

test('the facade probes and keyboard scans share the driver without front restoration', async t => {
  const f = await fixture(t, { reply: async () => ({ ok: true, taps: ['fixture'], status: 'responding' }) });
  assert.equal((await f.services.spaceProbe('Editor')).status, 'responding');
  assert.equal(f.services.frontRestore, undefined);
  assert.deepEqual(await f.services.keyboardTaps(), ['fixture']);
  assert.equal((await f.services.keyboardTapState()).ok, true);
  assert.deepEqual(f.calls.filter(([method]) => method === 'localTool').map(([, params]) => params.args[0]),
    ['app-health.js', 'keyboard-taps.js', 'keyboard-taps.js']);
  assert.deepEqual(f.scripts, []);
});

test('the gated facade without a script fallback never runs scripts when preparation is unavailable', async t => {
  const scripts = [];
  // Trap the real script boundary even during the failing regression run.
  // No fallback override is supplied to the facade under test.
  t.mock.method(childProcess, 'execFile', (...args) => {
    scripts.push(args[0]);
    const child = new EventEmitter();
    queueMicrotask(() => { args.at(-1)(null, '{"ok":true,"taps":[]}', ''); child.emit('close', 0); });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const f = await fixture(t, { fallback: undefined, ping: () => { throw failure('DRIVER_UNAVAILABLE'); } });
  assert.deepEqual(await f.services.keyboardTapState(), { ok: false, error: 'Keyboard tap scan unavailable' });
  await assert.rejects(f.services.localTools.call('menu_bar', { op: 'apps' }, async () => true),
    { code: 'DRIVER_UNAVAILABLE', delivery: 'not-sent' });
  assert.deepEqual(scripts, []);
  assert.equal(f.calls.some(([method]) => method === 'localTool'), false);
});

test('only unavailable preparation uses scripts; dispatched refusals and lost replies never replay', async t => {
  const unavailable = await fixture(t, { ping: () => { throw failure('DRIVER_UNAVAILABLE'); } });
  const result = await unavailable.services.localTools.call('menu_bar', { op: 'apps' }, async () => true);
  assert.match(plain(result), /fallback/); assert.equal(unavailable.scripts.length, 1);
  for (const code of ['SCREEN_LOCKED', 'METHOD_NOT_FOUND', 'IDENTITY_CHANGED', 'DRIVER_EXIT']) {
    const refused = await fixture(t, { reply: () => { throw failure(code); } });
    await assert.rejects(refused.services.localTools.call('menu_bar', { op: 'apps' }, async () => true), { code });
    assert.deepEqual(refused.scripts, []);
  }
  const stopped = await fixture(t);
  await assert.rejects(stopped.services.localTools.call('menu_bar', { op: 'apps' }, async () => true,
    undefined, undefined, undefined, { current: () => { throw Error('stopped'); } }), /stopped/);
  assert.deepEqual(stopped.calls, []); assert.deepEqual(stopped.scripts, []);
});

test('the local drag result uses driver identity checks around the stepped executor', async () => {
  const calls = [];
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }), async request(method) {
      if (method === 'inputGateState') return { enabled: true };
      calls.push(method);
      return method === 'resolveApp' ? { app: { id: window.bundleId, pid: window.pid, processStart: window.processStart, running: true } } : { window };
    } };
  const inputRegistrar = await prepareMacInputRegistrar(driver, 'a'.repeat(64));
  const services = createMacRuntimeTools({ driver, inputRegistrar, bindings: () => ({ source: window }),
    runLocal: async (script, request, options) => {
      calls.push(script);
      if (script === 'drag-focus.js') return { ok: true };
      assert.equal(typeof options.run, 'function', 'the real adapter installed its child guards');
      return { ok: true, path: 'background', windowId: 101, deliveryVerified: false };
    },
  });
  const result = await services.localTools.call('drag', { app: 'Editor', windowId: 101, from: [1, 2], to: [3, 4] }, async () => true);
  assert.notEqual(result.isError, true, plain(result)); assert.match(plain(result), /background/);
  assert.deepEqual(calls, ['resolveApp', 'drag-focus.js', 'resolveApp', 'verifyWindowIdentity', 'drag.js', 'verifyWindowIdentity']);
});

test('the facade refuses a drag without an acquired parent binding', async t => {
  const calls = [], f = await fixture(t, { runLocal: async script => { calls.push(script); return { ok: true }; } });
  const result = await f.services.localTools.call('drag', { app: 'Editor', windowId: 101, from: [1, 2], to: [3, 4] }, async () => true);
  assert.equal(result.isError, true); assert.match(plain(result), /IDENTITY_UNVERIFIED/);
  assert.deepEqual(calls, ['drag-focus.js']);
});

test('a shared helper request never overlaps a local-tool operation', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const calls = [];
  // getState requires policy plumbing but reads no app content.
  const runtime = createOwnRuntime({
    driver: { ping: async () => ({}), request: async (...args) => {
      calls.push([args[0]]);
      if (args[0] === 'localTool') { entered(); await held; return { ok: true }; }
      return { apps: [] };
    }, close() {} },
    lease: { release() {}, close() {} },
    permissions: { app() {}, page() {}, sitesLimited: () => false },
  });
  t.after(() => runtime.close());
  const local = runtime.localServices.spaceProbe('Editor'); await ready;
  const state = runtime.safety.request('getState', {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(([method]) => method === 'getState'), false);
  release(); await local; assert.deepEqual(await state, { apps: [], windows: [], errors: [] });
  assert.equal(calls.at(-1)[0], 'getState');
});

test('the real own server lists reads only and rejects forged local input calls', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const input = new PassThrough(), output = new PassThrough(), calls = [], pending = new Map();
  let buffer = '', next = 0;
  const owner = await runOwnRuntime({ input, output, signals: new EventEmitter(),
    driver: { async request(method) { calls.push(method); assert.fail(method); }, async close() {} },
    lease: { release() {}, close() {} },
    approvalStorage: { load: () => ({}), live: () => ({ list: () => [], allows: () => false }) },
    policy: () => ({ allow: true }), permissions: { app() {}, page() {}, sitesLimited: () => false },
    relayOptions: { idleTurnEndMs: 0 }, grantAudit() {},
  });
  t.after(async () => { await owner.close(); input.destroy(); output.destroy(); });
  output.on('data', chunk => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const call = (method, params) => new Promise(resolve => {
    const id = ++next; pending.set(id, resolve); input.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const listing = await call('tools/list', {});
  assert.deepEqual(listing.result.tools.map(tool => tool.name), ['js', 'js_reset', 'turn_ended']);
  const context = await call('tools/call', { name: 'js', arguments: {
    code: 'nodeRepl.write(JSON.stringify([typeof process, typeof require, "process" in globalThis, "require" in globalThis]))',
  } });
  assert.equal(context.result?.isError, false, JSON.stringify(context));
  assert.equal(plain(context.result).split('\n').at(-1), '["undefined","undefined",false,false]');
  for (const [code, refusal] of [
    ['process.env.SLEIGHT_DRIVER_INPUT_GATE = "1"', /ReferenceError: process is not defined/],
    ['require("./mac-driver/input-registrar.mjs")', /^sleight stopped this call before it ran: `js` has no `require` and no file system access[.]$/],
    ['await import("./mac-driver/input-registrar.mjs")', /REPL_IMPORT_DISABLED/],
  ]) {
    const attempted = await call('tools/call', { name: 'js', arguments: { code } });
    assert.equal(attempted.result?.isError, true, JSON.stringify(attempted));
    assert.match(plain(attempted.result), refusal);
  }
  const cell = await call('tools/call', { name: 'js', arguments: { code: 'globalThis.SLEIGHT_DRIVER_INPUT_GATE = true;' } });
  assert.equal(cell.result?.isError, false, JSON.stringify(cell));
  const stillPreview = await call('tools/list', {});
  assert.deepEqual(stillPreview.result.tools.map(tool => tool.name), ['js', 'js_reset', 'turn_ended']);
  for (const name of ['drag', 'menu_bar', 'notifications', 'select_window', 'open_file']) {
    const result = await call('tools/call', { name, arguments: { inputRegistrar: { enabled: true }, inputGate: true } });
    assert.equal(result.error?.code, -32601, JSON.stringify(result));
  }
  assert.deepEqual(calls, []);
});

test('a possibly sent driver Escape reaches the real relay tool result exactly once', async t => {
  const target = { appId: window.bundleId, app: 'Editor', title: 'Draft', url: null };
  const calls = [];
  const services = createMacRuntimeTools({ driver: { ping: async () => ({}), request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'verifyWindowIdentity') return { window };
    if (method === 'health') return { hidIdleSeconds: 20 };
    throw failure('DRIVER_EXIT');
  } }, bindings: () => ({ source: window, sourceLease: { path: '/fixture/identity-lease', token: 'owned' } }) });
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const directory = temporary(t), inputLease = new InputLease({ directory });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false,
    stuckEscape: services.stuckEscape, takeNotices: services.takeNotices });
  t.after(async () => { await relay.close(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const sent = [], replies = [];
  serverIn.on('data', chunk => sent.push(...String(chunk).trim().split('\n').map(JSON.parse)));
  clientOut.on('data', chunk => replies.push(...String(chunk).trim().split('\n').map(JSON.parse)));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const header = 'Window: "Draft", App: Editor.\n0 standard window Draft';
  const stuck = header + '\n124 menu bar\n\t129 Insert\n\t132 (selected) Table\n\t133 Window';
  async function call(id, code, tree) {
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    for (let i = 0; i < 5 && sent.length < id; i++) await tick();
    serverOut.write(JSON.stringify({ id: sent.at(-1).id, result: { content: [{ type: 'text', text: tree }],
      _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId: window.bundleId } } } } }) + '\n');
    for (let i = 0; i < 20 && !replies.some(reply => reply.id === id); i++) await tick();
    return plain(replies.find(reply => reply.id === id).result);
  }
  await call(1, 'let app = await cua.getApp("Editor")', header);
  await call(2, 'await app.typeText("x")', stuck);
  const uncertain = await call(3, 'await app.typeText("x")', stuck);
  assert.match(uncertain, /may have sent one Escape/);
  assert.match(uncertain, /Delivery could not be confirmed/);
  assert.doesNotMatch(await call(4, 'await app.typeText("x")', stuck), /may have sent one Escape/);
  assert.equal(calls.filter(([method]) => method === 'localTool').length, 1);
  assert.deepEqual(calls.find(([method]) => method === 'localTool')[1].args[1].lease,
    { path: '/fixture/identity-lease', token: 'owned' });
});


test('localTools.call refuses every call when input is disabled before any driver or script access', async t => {
  const f = await fixture(t, { inputEnabled: false });
  assert.deepEqual(f.services.localTools.tools, []);
  for (const name of ['drag', 'open_file', 'select_window', 'menu_bar'])
    await assert.rejects(f.services.localTools.call(name, {}, async () => assert.fail('no approval')),
      { code: 'METHOD_NOT_FOUND', delivery: 'not-sent', retry: 'safe' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.scripts, []);
});
