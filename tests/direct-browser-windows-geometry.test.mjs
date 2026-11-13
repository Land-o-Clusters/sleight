import test from 'node:test';
import assert from 'node:assert/strict';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { parseWindowsWindowBounds } from '../plugins/sleight/lib/direct-browser/windows-geometry.mjs';

const bounds = extra => ({ windowId: 7, bounds: { left: -1200, top: -40, width: 1200, height: 900, windowState: 'normal', ...extra } });
function fixture() {
  const listeners = new Set(), calls = [];
  let read = async () => bounds();
  const upstream = { sessionId: 'root', on(name, cb) { listeners.add(cb); }, off(name, cb) { listeners.delete(cb); },
    async send(method, params, route) {
      calls.push({ method, params, route });
      if (method === 'Browser.getWindowForTarget') return read();
      if (method === 'Target.attachToTarget') return { sessionId: 'page-route' };
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: params.targetId, type: 'page', url: 'about:blank' } };
      return {};
    } };
  return { upstream, calls, setRead(fn) { read = fn; }, emit(frame) { for (const cb of listeners) cb(frame); } };
}

test('CDP geometry preserves negative origins and labels its coordinate space without inventing DPI or exposure', () => {
  assert.deepEqual(parseWindowsWindowBounds(bounds()), { windowId: 7, rect: [-1200, -40, 1200, 900], state: 'normal', units: 'cdp-bounds' });
  assert.equal(parseWindowsWindowBounds(bounds({ windowState: 'minimized' })).state, 'minimized');
  for (const state of ['maximized', 'fullscreen']) assert.equal(parseWindowsWindowBounds(bounds({ windowState: state })).state, state);
  const implicit = bounds(); delete implicit.bounds.windowState;
  assert.equal(parseWindowsWindowBounds(implicit).state, 'unknown');
});

test('CDP geometry refuses missing, fractional, oversized and invalid state evidence', () => {
  for (const value of [null, {}, { ...bounds(), windowId: 0 }, { ...bounds(), windowId: '7' },
    bounds({ left: NaN }), bounds({ top: 0.5 }), bounds({ width: 0 }), bounds({ height: -1 }),
    bounds({ width: 10000001 }), bounds({ windowState: 'hidden' }), bounds({ windowState: null })])
    assert.throws(() => parseWindowsWindowBounds(value), /WINDOWS_GEOMETRY_UNPROVED/);
});

test('only Windows filters expose the private owned-target bounds reader', async t => {
  const f = fixture(), mac = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'], platform: 'darwin' });
  t.after(() => mac.dispose());
  assert.equal(mac.windowBounds, undefined);
  const win = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'], platform: 'win32' });
  t.after(() => win.dispose());
  assert.deepEqual(await win.windowBounds('owned'), { windowId: 7, rect: [-1200, -40, 1200, 900], state: 'normal', units: 'cdp-bounds' });
  assert.deepEqual(f.calls, [{ method: 'Browser.getWindowForTarget', params: { targetId: 'owned' }, route: undefined }]);
  await assert.rejects(win.windowBounds('foreign'), /CDP_TARGET_NOT_OWNED/);
  assert.equal(f.calls.length, 1);
  for (const method of ['Browser.getWindowForTarget', 'Browser.getWindowBounds', 'Browser.setWindowBounds'])
    await assert.rejects(win.session.send(method, { targetId: 'owned', windowId: 7 }), /CDP_COMMAND_REFUSED/);
  assert.equal(f.calls.length, 1, 'the public CDP socket cannot use the private bounds capability');
});

test('bounds sampled during target revocation are discarded and disposal fences later reads', async t => {
  const f = fixture(), win = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'], platform: 'win32' });
  t.after(() => win.dispose());
  let complete;
  f.setRead(() => new Promise(resolve => { complete = resolve; }));
  const pending = win.windowBounds('owned');
  f.emit({ method: 'Target.targetDestroyed', params: { targetId: 'owned' } });
  complete(bounds());
  await assert.rejects(pending, /CDP_TARGET_NOT_OWNED/);
  await win.dispose();
  await assert.rejects(win.windowBounds('owned'), /CDP_FILTER_CLOSED/);
});

test('invalid or unsupported CDP bounds never become cursor geometry', async t => {
  const f = fixture(), win = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'], platform: 'win32' });
  t.after(() => win.dispose());
  f.setRead(async () => ({ windowId: 7, bounds: {} }));
  await assert.rejects(win.windowBounds('owned'), /WINDOWS_GEOMETRY_UNPROVED/);
  f.setRead(async () => { throw Error('CDP_COMMAND_FAILED'); });
  await assert.rejects(win.windowBounds('owned'), /CDP_COMMAND_FAILED/);
});

test('Windows filter keeps the DevTools port guard across loopback, machine names, userinfo and WebSocket URLs', async t => {
  const f = fixture(), win = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'], protectedPort: 9222, platform: 'win32' });
  t.after(() => win.dispose());
  await win.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  for (const [index, url] of ['http://localhost:9222/json', 'http://127.0.0.1:9222/json',
    'http://[::1]:9222/json', 'http://[::ffff:127.0.0.1]:9222/json', 'http://LANE-PC:9222/json',
    'http://user@127.0.0.1:9222/json', 'ws://localhost:9222/devtools/browser/x', 'http://127.1:9222/json'].entries()) {
    await assert.rejects(win.session.send('Target.createTarget', { url }), /CDP_COMMAND_REFUSED/);
    // A browser-level paused request from a popup must fail without reaching the public client.
    // The attachment installed that guard without a listener/socket or browser launch.
    f.emit({ method: 'Fetch.requestPaused', params: { requestId: String(index), request: { url } } });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.method === 'Fetch.failRequest').length, 8);
  assert.equal(f.calls.some(call => call.method === 'Target.createTarget' || call.method === 'Fetch.continueRequest'), false);
  assert.deepEqual(f.calls.find(call => call.method === 'Fetch.enable').params.patterns, [{ urlPattern: '*://*:9222/*', requestStage: 'Request' }]);
});

test('Windows interception matches the parsed port, ignoring port text in the host, credentials, path and query', async t => {
  const f = fixture(), win = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'], protectedPort: 9222, platform: 'win32' });
  t.after(() => win.dispose());
  await win.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  const cases = [
    ['http://elsewhere.invalid:9222/ordinary', true],
    ['ws://elsewhere.invalid:9222/ordinary', true],
    ['http://localhost:9223/json', false],
    ['http://localhost:19222/json', false],
    ['http://port9222.invalid/json', false],
    ['http://user:9222@localhost:9223/json', false],
    ['http://localhost:9223/a:9222/json?port=9222', false],
    ['http://localhost/json?url=http://other:9222/json', false],
    ['http://localhost:9223/#http://other:9222/json', false],
  ];
  for (const [index, [url]] of cases.entries())
    f.emit({ method: 'Fetch.requestPaused', params: { requestId: `port-${index}`, request: { url } } });
  await new Promise(resolve => setImmediate(resolve));
  for (const [index, [, blocked]] of cases.entries()) {
    const calls = f.calls.filter(call => call.params?.requestId === `port-${index}`);
    assert.deepEqual(calls.map(call => call.method), [blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest']);
  }
});
