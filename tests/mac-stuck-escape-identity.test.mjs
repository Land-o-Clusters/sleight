import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createMacDriverTools } from '../plugins/sleight/lib/mac-driver/tools.mjs';
import { createMacRuntimeTools } from '../plugins/sleight/lib/mac-driver/runtime-tools.mjs';
import { createStuckEscapes } from '../plugins/sleight/lib/stuck-escape.mjs';
import { nativeLocal, nativeToolsSkip, prepareNativeToolsFixture, localInputFixture } from './fixtures/mac-driver-tools.mjs';

before(() => { if (!nativeToolsSkip) prepareNativeToolsFixture(); });

const window = { windowId: '42', pid: 321, processStart: '100.25', bundleId: 'org.test.editor',
  identityVerified: true, title: 'Draft' };
const target = { appId: window.bundleId, title: window.title, url: null, windowNumber: 42 };
const grant = { path: '/fixture/lease.json', token: 'owned' };
function fixture({ observed = window, idle = 20, result = { ok: true, posted: true, selected: false },
  bind = () => window, ping = async () => ({}) } = {}) {
  const calls = [], fallbacks = [];
  const driver = { ping, async request(method, params) {
    calls.push([method, structuredClone(params)]);
    if (method === 'verifyWindowIdentity') return { window: observed };
    if (method === 'health') return { hidIdleSeconds: idle };
    return typeof result === 'function' ? result() : result;
  } };
  const tools = createMacDriverTools({ driver, fallback: async (...args) => { fallbacks.push(args); assert.fail('no runtime fallback'); } });
  const escape = tools.stuckEscape({ binding: bind, env: {} });
  return { driver, calls, fallbacks, tools, escape, send: () => escape.send(target, grant, { since: 0, clock: () => 100 }) };
}
test('runtime Escape sends the retained driver identity and the existing lease without legacy identity coercion', async () => {
  const f = fixture();
  assert.deepEqual(await f.send(), { posted: true, selected: false });
  assert.deepEqual(f.calls.map(([method]) => method), ['verifyWindowIdentity', 'health', 'localTool']);
  const [script, request] = f.calls.at(-1)[1].args;
  assert.equal(script, 'stuck-escape.js'); assert.equal(request.processStart, '100.25');
  assert.deepEqual(request.driverIdentity, window); assert.deepEqual(request.lease, grant);
  assert.equal(typeof request.resultAt, 'number'); assert.equal(request.quietSeconds, 0.5);
  assert.deepEqual(await f.escape.check(target), undefined);
  assert.deepEqual(f.fallbacks, []);
});

test('replacement PID/start, another bundle/window/title and unknown identity refuse before Escape', async () => {
  for (const patch of [{ pid: 322 }, { processStart: '101.25' }, { bundleId: 'org.test.other' },
    { windowId: '43' }, { title: 'Other' }, { identityVerified: false }]) {
    const f = fixture({ observed: { ...window, ...patch } });
    assert.equal((await f.send()).posted, false, JSON.stringify(patch));
    assert.equal(f.calls.some(([method]) => method === 'localTool'), false);
  }
  for (const bind of [() => undefined, () => ({ ...window, title: 'Other' }), () => ({ ...window, windowId: '43' }),
    () => { throw Error('Input lease expired'); }]) {
    const f = fixture({ bind }); assert.equal((await f.send()).posted, false); assert.equal(f.calls.length, 0);
  }
});

test('typing, missing HID evidence, disable and stopped calls all refuse without a post or fallback', async () => {
  for (const idle of [0, 0.01, NaN, Infinity, undefined]) {
    const f = fixture({ idle: idle === undefined ? null : idle });
    assert.equal((await f.send()).posted, false); assert.equal(f.calls.some(([method]) => method === 'localTool'), false);
  }
  const f = fixture();
  assert.equal(f.tools.stuckEscape({ binding: () => window, env: { SLEIGHT_STUCK_ESCAPE: '0' } }), undefined);
  const stopped = f.tools.stuckEscape({ binding: () => window, current: () => { throw Error('Stopped'); }, env: {} });
  assert.equal((await stopped.send(target, grant, { since: 0, clock: () => 10 })).posted, false);
  assert.equal(f.calls.length, 0);
  const unavailable = fixture({ ping: async () => { throw Object.assign(Error('unavailable'), { code: 'DRIVER_UNAVAILABLE' }); } });
  assert.equal((await unavailable.send()).posted, false); assert.equal(unavailable.fallbacks.length, 0);
  const preview = fixture({ result: () => { throw Object.assign(Error('METHOD_NOT_FOUND'), { code: 'METHOD_NOT_FOUND' }); } });
  assert.equal((await preview.send()).posted, false); assert.equal(preview.fallbacks.length, 0);
});

test('two calls are required and a lost reply spends one episode until a verified clear menu', async () => {
  const f = fixture({ result: () => { throw Object.assign(Error('lost reply'), { code: 'DRIVER_EXIT' }); } });
  const episodes = createStuckEscapes();
  async function observe() {
    const due = episodes.observe(target.appId, { stuck: true });
    if (due !== 'escape') return;
    episodes.tried(target.appId);
    const result = await f.send();
    if (result.posted) episodes.posted(target.appId, result.selected ?? null);
    return result;
  }
  assert.equal(await observe(), undefined); assert.equal(f.calls.length, 0);
  assert.equal((await observe()).posted, 'unknown');
  for (let i = 0; i < 4; i++) assert.equal(await observe(), undefined);
  assert.equal(f.calls.filter(([method]) => method === 'localTool').length, 1);
  episodes.observe(target.appId, { cleared: true }); episodes.confirmed(target.appId, { selected: true, open: false });
  assert.equal(await observe(), undefined);
  episodes.observe(target.appId, { cleared: true }); episodes.confirmed(target.appId, { selected: false, open: false });
  assert.equal(await observe(), undefined); assert.equal((await observe()).posted, 'unknown');
  assert.equal(f.calls.filter(([method]) => method === 'localTool').length, 2);
});

test('the runtime registrar renews and uses its parent binding rather than a model identity callback', async () => {
  const f = fixture(), bindings = [];
  const identityGrant = { path: '/fixture/driver-lease', token: 'driver-token' };
  const services = createMacRuntimeTools({ driver: f.driver, identity: () => assert.fail('legacy identity must never run'),
    bindings: args => { bindings.push(args); return { source: window, sourceLease: identityGrant }; } });
  assert.deepEqual(await services.stuckEscape.send(target, grant, { since: 0, clock: () => 100 }), { posted: true, selected: false });
  assert.deepEqual(bindings, [{ app: window.bundleId, windowId: 42 }]);
  assert.deepEqual(f.calls.at(-1)[1].args[1].lease, identityGrant);
});

const native = (name, fn) => test(name, { skip: nativeToolsSkip }, fn);
const args = () => ({ appId: target.appId, pid: window.pid, processStart: window.processStart, driverIdentity: window,
  lease: grant, quietSeconds: 0.5, waitSeconds: 1.5, resultAt: Date.now() - 100 });
const providers = () => ({ ...localInputFixture(window).fixture,
  apps: [{ appId: window.bundleId, pid: window.pid, processStart: 99 }],
  driverIdentities: [window], focusedWindowId: window.windowId, idle: 20,
  menuState: { selected: true, open: false }, afterEscape: false,
  lease: { token: grant.token, expires: Date.now() + 30000, window: { ...target } } });
native('native Escape validates kernel identity and the exact leased/focused window before posting its pair', () => {
  const reply = nativeLocal('stuck-escape.js', args(), providers());
  assert.equal(reply.result.posted, true, JSON.stringify(reply));
  assert.deepEqual(reply.events.filter(row => row[0] === 'key'), [['key', 321, 53, true, 0], ['key', 321, 53, false, 0]]);
  assert.equal(reply.events.filter(row => row[0] === 'driver-identity').length, 3);
  const exact = providers();
  exact.lease.window = { appId: window.bundleId, title: JSON.stringify(['42', 321, '100.25']), url: null };
  assert.equal(nativeLocal('stuck-escape.js', args(), exact).result.posted, true);
});
native('native Escape refuses identity changes before and after the wait, another focused window, typing, and a foreign lease', () => {
  const mutations = [
    { driverIdentities: [{ ...window, processStart: '101.25' }] },
    { driverIdentities: [window, { ...window, pid: 322 }] },
    { driverIdentities: [window, { ...window, processStart: '101.25' }] },
    { driverIdentities: [window, { ...window, windowId: '43' }] },
    { driverIdentities: [window, { ...window, bundleId: 'org.test.other' }] },
    { focusedWindowId: '43' }, { focusedWindowId: null }, { idle: 0 }, { idle: [20, 20, 0] },
    ...[{ ...target, windowNumber: 43 }, { ...target, title: 'Other' }, { ...target, appId: 'org.test.other' },
      { ...target, windowNumber: undefined }].map(window => ({ lease: { token: grant.token, expires: Date.now() + 30000, window } })),
    { lease: { token: 'foreign', expires: Date.now() + 30000, window: target } },
    { lease: { token: grant.token, expires: 0, window: target } },
  ];
  for (const patch of mutations) {
    const reply = nativeLocal('stuck-escape.js', args(), { ...providers(), ...patch });
    assert.equal(reply.result.posted, false, JSON.stringify(patch));
    assert.equal(reply.events.filter(row => row[0] === 'key').length, 0, JSON.stringify(reply));
  }
});

native('replacement after Escape down receives no release and leaves the episode spent', () => {
  const reply = nativeLocal('stuck-escape.js', args(), { ...providers(),
    driverIdentities: [window, window, { ...window, processStart: '101.25' }] });
  assert.equal(reply.result.ok, false); assert.equal(reply.result.posted, true);
  assert.deepEqual(reply.events.filter(row => row[0] === 'key'), [['key', 321, 53, true, 0]]);
});
