import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { windowsDriverSources } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { inspectDriverSource } from './fixtures/windows-source-policy.mjs';
import { createWindowsSafety } from '../plugins/sleight/lib/windows-driver/safety.mjs';
import { matchBlockedWindowsApp, forbiddenWindowsTarget, windowsForbiddenWarning } from '../plugins/sleight/lib/blocked-apps-windows.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { windowsReplFixture } from './fixtures/windows-repl-client.mjs';
import { createWindowsConsent, createWindowsFilePermissions } from '../plugins/sleight/lib/direct-browser/windows-gates.mjs';

const binding = w => ({ windowId: w.windowId, processStart: w.processStart });
function fixture(t, options = {}) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-wdr5-')));
  const windows = structuredClone(fakeWindows), calls = [], cards = [];
  const worker = windowsReplFixture(t, options);
  const lease = new InputLease({ directory: root, holder: 'safety fixture' });
  const driver = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'getState') {
      if (options.stateFailure) throw Object.assign(Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' });
      return { windows, apps: [] };
    }
    if (method === 'verifyWindowIdentity') return { window: windows.find(w => w.windowId === params.windowId) };
    if (method === 'stuckMenuEscape' && options.idle === false) throw Object.assign(Error('USER_ACTIVE'), { code: 'USER_ACTIVE' });
    const result = await worker.driver.request(method === 'stuckMenuEscape' ? 'pressKey' : method, params);
    if (['click', 'stuckMenuEscape'].includes(method)) Object.assign(result, options.foreground);
    return { ...result, ...result.window ? { window: windows.find(w => w.windowId === result.window.windowId) } : {} };
  } };
  const safety = createWindowsSafety({ driver, lease, allowForbidden: false, stuckEscape: true,
    approve: async card => { cards.push(card); return options.allow !== false; }, ...options });
  safety.setPolicy({ beforeAction: async ({ args }) => args, checkPause() {} });
  t.after(() => { safety.close(); removeTemp(root); });
  return { safety, windows, lease, calls, cards, root };
}

for (const policy of [undefined, null, {}, { beforeAction: true }])
  test(`actions fail closed without a callable parent policy (${JSON.stringify(policy)})`, async t => {
    const f = fixture(t);
    const first = await f.safety.request('getApp', { selector: 'Notepad' });
    f.safety.setPolicy(policy);
    const count = f.calls.length;
    await assert.rejects(f.safety.request('click', { ...binding(first.window), readId: first.readId, args: [1] }),
      { code: 'WINDOWS_SAFETY_UNAVAILABLE' });
    assert.equal(f.calls.length, count, 'no identity, read or action request without policy');
  });

test('decline precedes the first tree and releases no unapproved data', async t => {
  const f = fixture(t, { allow: false });
  await assert.rejects(f.safety.request('getApp', { selector: 'Notepad' }), /APP_DECLINED/);
  assert.equal(f.cards.length, 1);
  assert.deepEqual(f.calls.map(c => c.method), ['getState']);
  assert.equal(f.lease.owned.size, 0);
});

test('approval, lease and identity precede reads, approval is remembered per app', async t => {
  const f = fixture(t);
  const first = await f.safety.request('getApp', { selector: 'Notepad' });
  const second = await f.safety.request('getAXState', binding(first.window));
  assert.match(second.text, /<redacted>/);
  assert.doesNotMatch(JSON.stringify(second), /hidden fixture secret|password fixture secret|secret help/);
  await f.safety.request('getApp', { selector: 'Calculator' });
  assert.equal(f.cards.length, 2);
  assert.deepEqual(f.calls.slice(0, 3).map(c => c.method), ['getState', 'verifyWindowIdentity', 'getAXState']);
  assert.equal(f.lease.owned.size, 2);
});

for (const [name, mutate, code] of [
  ['forbidden', w => { w.image = 'C:\\Apps\\WindowsTerminal.exe'; w.app = 'Windows Terminal'; }, 'FORBIDDEN_TARGET'],
  ['console', w => { w.className = 'ConsoleWindowClass'; }, 'FORBIDDEN_TARGET'],
  ['elevated', w => { w.integrity = 'high'; w.refused = 'ELEVATED_TARGET'; }, 'ELEVATED_TARGET'],
  ['own host', w => { w.refused = 'OWN_HOST'; }, 'OWN_HOST'],
  ['frame host', w => { w.image = 'C:\\Windows\\System32\\ApplicationFrameHost.exe'; }, 'HOSTED_APP_UNRESOLVED'],
  ['frame class without app identity', w => { w.className = 'ApplicationFrameWindow'; }, 'HOSTED_APP_UNRESOLVED'],
  ['frame class with app identity', w => { w.className = 'ApplicationFrameWindow'; w.aumid = 'Fixture.Package!App'; }, 'HOSTED_APP_UNRESOLVED'],
  ['renamed terminal', w => { w.image = 'C:\\Tools\\Editor.exe'; w.originalFilename = 'alacritty.exe'; }, 'FORBIDDEN_TARGET'],
  ['short terminal path', w => { w.image = 'C:\\PROGRA~1\\ALACRI~1\\ALACRI~1.EXE'; w.productName = 'Alacritty'; }, 'FORBIDDEN_TARGET'],
]) test(`${name} refuses before approval or a tree`, async t => {
  const f = fixture(t); mutate(f.windows[0]);
  await assert.rejects(f.safety.request('getApp', { selector: { windowId: '101' } }), new RegExp(code));
  assert.equal(f.cards.length, 0);
  assert.deepEqual(f.calls.map(c => c.method), ['getState']);
});

for (const integrity of ['high', 'unknown', 'medium']) for (const selector of ['Notepad', { windowId: '101' }])
  test(`elevated verdict with ${integrity} integrity preserves its refusal by ${JSON.stringify(selector)}`, async t => {
    const f = fixture(t); f.windows[0].refused = 'ELEVATED_TARGET'; f.windows[0].integrity = integrity;
    await assert.rejects(f.safety.request('getApp', { selector }), { code: 'ELEVATED_TARGET', message: 'ELEVATED_TARGET' });
    assert.equal(f.cards.length, 0);
    assert.deepEqual(f.calls.map(c => c.method), ['getState'], 'zero input or pattern requests');
    assert.equal(f.lease.owned.size, 0);
  });

for (const className of ['ApplicationFrameWindow', 'Windows.UI.Core.CoreWindow'])
  test(`packaged class ${className} refuses even with a complete AUMID mapping`, async t => {
    const f = fixture(t);
    Object.assign(f.windows[0], { className, aumid: 'Fixture.Package!App',
      coreWindowId: '201', framePid: 99, frameProcessStart: '134381300000000000' });
    await assert.rejects(f.safety.request('getApp', { selector: { windowId: '101' } }), { code: 'HOSTED_APP_UNRESOLVED' });
    assert.equal(f.cards.length, 0); assert.equal(f.lease.owned.size, 0);
    assert.deepEqual(f.calls.map(c => c.method), ['getState']);
  });

for (const resolved of [false, true]) test(`disabled native packaged route refuses a ${resolved ? 'resolved' : 'unresolved'} frame before approval or content`, async t => {
  const f = fixture(t);
  Object.assign(f.windows[0], { className: 'ApplicationFrameWindow', refused: 'HOSTED_APP_UNRESOLVED',
    aumid: resolved ? 'Fixture.Package!App' : null,
    ...resolved ? { coreWindowId: '201', framePid: 99, frameProcessStart: '134381300000000000' } : {} });
  await assert.rejects(f.safety.request('getApp', { selector: { windowId: '101' } }), { code: 'HOSTED_APP_UNRESOLVED' });
  assert.equal(f.cards.length, 0); assert.equal(f.lease.owned.size, 0);
  assert.deepEqual(f.calls.map(c => c.method), ['getState']);
});

test('ordinary binding retains native lifetime, topology, thread and desktop identity', async t => {
  const f = fixture(t);
  Object.assign(f.windows[0], { threadId: 51, bindingId: 'a'.repeat(32), windowGeneration: '17', topologyGeneration: 'tree-1',
    desktopId: '11111111-2222-3333-4444-555555555555', onCurrentDesktop: true });
  const acquired = await f.safety.request('getApp', { selector: { windowId: '101' } });
  assert.equal(acquired.window.pid, f.windows[0].pid);
  assert.equal(f.cards.length, 1);
  assert.equal(f.calls[1].params.bindingId, 'a'.repeat(32));
  await f.safety.request('getAXState', binding(acquired.window));
  assert.equal(f.calls.at(-1).params.bindingId, 'a'.repeat(32), 'parent retains binding even when worker omits it');
  const { verifyWindowIdentity } = await import('../plugins/sleight/lib/repl/identity.mjs');
  for (const key of ['bindingId', 'windowGeneration', 'topologyGeneration', 'desktopId', 'onCurrentDesktop', 'threadId'])
    assert.throws(() => verifyWindowIdentity(acquired.window, { ...acquired.window, [key]: key === 'onCurrentDesktop' ? false : 'changed' }),
      { code: 'IDENTITY_CHANGED' });
});

test('same-incarnation windows refuse ambiguous app selection before approval and reads', async t => {
  const f = fixture(t);
  f.windows.push({ ...f.windows[0], windowId: '103', popup: false });
  await assert.rejects(f.safety.request('getApp', { selector: 'Notepad' }), { code: 'AMBIGUOUS_APP' });
  assert.equal(f.cards.length, 0);
  assert.deepEqual(f.calls.map(c => c.method), ['getState']);
  assert.equal((await f.safety.request('getApp', { selector: { windowId: '101' } })).window.windowId, '101');
});

for (const aumid of [null, 'Fixture.Package!App']) for (const imageIdentity of ['134059077770000001:4096', '134059077770000000:8192'])
  test(`session approval binds executable birth and size for ${aumid ?? 'image path'} (${imageIdentity})`, async t => {
    const f = fixture(t); f.windows[0].aumid = aumid;
    const acquire = () => f.safety.request('getApp', { selector: 'Notepad' });
    await acquire();
    f.safety.reset(); await acquire();
    f.safety.endTurn(); await acquire();
    assert.equal(f.cards.length, 1, 'unchanged app keeps one card across reset and turn end');
    f.windows[0].imageIdentity = imageIdentity;
    const inventory = await f.safety.request('getState', {});
    assert.equal(inventory.windows[0].title, null, 'replacement does not inherit inventory approval');
    await acquire();
    assert.equal(f.cards.length, 2, 'replacement at the same path needs a new card');
    assert.equal(f.cards[0].app, f.cards[1].app, 'the app name is unchanged');
  });

for (const imageIdentity of [undefined, null, '', '0:4096', '1:0', 123, '1:2\n'])
  test(`unproved executable identity refuses before approval (${JSON.stringify(imageIdentity)})`, async t => {
    const f = fixture(t); f.windows[0].imageIdentity = imageIdentity;
    await assert.rejects(f.safety.request('getApp', { selector: 'Notepad' }), { code: 'TARGET_UNAVAILABLE' });
    assert.equal(f.cards.length, 0);
    assert.deepEqual(f.calls.map(c => c.method), ['getState']);
  });

for (const integrity of ['high', 'system']) for (const selector of ['Notepad', { windowId: '101' }])
  test(`parent refuses ${integrity} without a native refusal by ${JSON.stringify(selector)}`, async t => {
    const f = fixture(t); f.windows[0].integrity = integrity;
    await assert.rejects(f.safety.request('getApp', { selector }), { code: 'ELEVATED_TARGET' });
    assert.equal(f.cards.length, 0);
    assert.deepEqual(f.calls.map(c => c.method), ['getState']);
    assert.equal(f.lease.owned.size, 0);
  });

test('parent allows a Medium target admitted by the native driver', async t => {
  const f = fixture(t);
  assert.equal((await f.safety.request('getApp', { selector: 'Notepad' })).window.integrity, 'medium');
  assert.equal(f.cards.length, 1);
});

test('declining a replacement binary stops before its first identity query or tree', async t => {
  let cards = 0;
  const f = fixture(t, { approve: async () => ++cards === 1 });
  await f.safety.request('getApp', { selector: 'Notepad' });
  f.windows[0].imageIdentity = '134059077770000001:4096';
  const count = f.calls.length;
  await assert.rejects(f.safety.request('getApp', { selector: 'Notepad' }), { code: 'APP_DECLINED' });
  assert.equal(cards, 2);
  assert.deepEqual(f.calls.slice(count).map(c => c.method), ['getState']);
});

test('parent action admission carries the native foreground observation', async t => {
  const f = fixture(t, { driverScenario: 'foreground-changed' });
  const first = await f.safety.request('getApp', { selector: 'Notepad' });
  const result = await f.safety.request('click', { ...binding(first.window), readId: first.readId, args: [2] });
  assert.equal(result.foregroundChanged, true);
  assert.equal(result.foregroundExecutable, 'Calculator.exe');
  assert.equal(Object.hasOwn(result, 'tookFocus'), false);
});

test('foreground names are bounded plain basenames and the change flag is boolean or null', async t => {
  const foreground = { foregroundChanged: true, foregroundExecutable: 'Calculator.exe' };
  const f = fixture(t, { foreground, driverScenario: 'foreground-changed' });
  let current = await f.safety.request('getApp', { selector: 'Notepad' });
  for (const name of [42, {}, '', '.', '..', 'x'.repeat(261), 'C:\\Apps\\Calculator.exe', 'Apps/Calculator.exe',
    'C:Calculator.exe', 'Calculator.exe\n', 'Calc\u007f.exe', 'Calc\u0085.exe', 'Calc\u202e.exe', 'Calc\ud800.exe']) {
    foreground.foregroundExecutable = name;
    foreground.foregroundChanged = 'true';
    current = await f.safety.request('click', { ...binding(current.window), readId: current.readId, args: [2] });
    assert.equal(current.foregroundExecutable, null, JSON.stringify(name));
    assert.equal(current.foregroundChanged, null);
  }
  for (const name of ['cAlCuLaToR.ExE', 'x'.repeat(260)]) {
    foreground.foregroundExecutable = name;
    foreground.foregroundChanged = false;
    f.windows[1].image = 'C:\\Apps\\' + name;
    current = await f.safety.request('click', { ...binding(current.window), readId: current.readId, args: [2] });
    assert.equal(current.foregroundExecutable, name);
    assert.equal(current.foregroundChanged, false);
  }
});

for (const [name, mutate] of [
  ['native refusal', w => { w.refused = 'TARGET_UNAVAILABLE'; }],
  ['High target without a native refusal', w => { w.integrity = 'high'; }],
  ['terminal', w => { w.image = 'C:\\Apps\\cmd.exe'; }],
  ['renamed terminal', w => { w.originalFilename = 'alacritty.exe'; }],
  ['OpenAI app', w => { w.image = 'C:\\Apps\\ChatGPT.exe'; }],
  ['own host', w => { w.refused = 'OWN_HOST'; }],
]) test(`foreground name is private for a ${name}`, async t => {
  const foreground = { foregroundChanged: true };
  const f = fixture(t, { foreground, driverScenario: 'foreground-changed' });
  const observed = [];
  f.safety.setPolicy({ beforeAction: async ({ args }) => args, checkPause() {}, observe: result => observed.push(result) });
  const first = await f.safety.request('getApp', { selector: 'Notepad' });
  // The foreground can become unsafe after acquisition, so use a fresh inventory.
  mutate(f.windows[1]);
  foreground.foregroundExecutable = f.windows[1].image.split('\\').at(-1);
  const result = await f.safety.request('click', { ...binding(first.window), readId: first.readId, args: [2] });
  assert.equal(result.foregroundExecutable, null);
  assert.equal(result.foregroundChanged, true);
  assert.equal(observed.at(-1).foregroundExecutable, null, 'policy observers receive the sanitized result');
  assert.equal(f.calls.at(-1).method, 'getState');
});

test('unknown or ambiguously refused foreground names are private', async t => {
  const foreground = { foregroundChanged: true, foregroundExecutable: 'Unknown.exe' };
  const f = fixture(t, { foreground, driverScenario: 'foreground-changed' });
  const first = await f.safety.request('getApp', { selector: 'Notepad' });
  const result = await f.safety.request('click', { ...binding(first.window), readId: first.readId, args: [2] });
  assert.equal(result.foregroundExecutable, null);
  foreground.foregroundExecutable = 'Calculator.exe';
  f.windows.push({ ...f.windows[1], windowId: '103', pid: 43, refused: 'OWN_HOST' });
  const next = await f.safety.request('click', { ...binding(result.window), readId: result.readId, args: [2] });
  assert.equal(next.foregroundExecutable, null);
});

test('failed foreground inventory withholds the name and preserves the completed action', async t => {
  const options = { driverScenario: 'foreground-changed', foreground: { foregroundChanged: true, foregroundExecutable: 'Calculator.exe' } };
  const f = fixture(t, options);
  const first = await f.safety.request('getApp', { selector: 'Notepad' });
  options.stateFailure = true;
  const result = await f.safety.request('click', { ...binding(first.window), readId: first.readId, args: [2] });
  assert.equal(result.foregroundExecutable, null);
  assert.equal(result.foregroundChanged, true);
  assert.equal(typeof result.text, 'string');
  assert.equal(f.calls.filter(c => c.method === 'click').length, 1);
});

test('a stuck-menu Escape keeps its foreground observation after the combined capture read', async t => {
  const f = fixture(t, { driverScenario: 'safety-menu' });
  const observed = [];
  f.safety.setPolicy({ beforeAction: async ({ args }) => args, checkPause() {}, observe: result => observed.push(result) });
  const first = await f.safety.request('getApp', { selector: 'Notepad' }, { cell: 1 });
  await f.safety.finishCell(1);
  await f.safety.request('getAXStateAndScreenshot', binding(first.window), { cell: 2 });
  const result = await f.safety.finishCell(2);
  assert.equal(result.foregroundChanged, false);
  assert.equal(result.foregroundExecutable, null, 'unmatched foreground is private on the Escape path too');
  assert.equal(observed.at(-1).foregroundExecutable, null);
  assert.equal(result.screenshot.mimeType, 'image/png');
  assert.equal(f.calls.filter(c => c.method === 'stuckMenuEscape').length, 1);
});

test('driver admission caps the entire queued approval wait at eight calls', async t => {
  let release;
  const f = fixture(t, { approve: () => new Promise(resolve => { release = resolve; }) });
  const calls = Array.from({ length: 8 }, () => f.safety.request('getApp', { selector: 'Notepad' }));
  await assert.rejects(f.safety.request('getState', {}), /DRIVER_BUSY/);
  await new Promise(resolve => setImmediate(resolve));
  f.safety.reset(); release(false);
  const results = await Promise.allSettled(calls);
  assert.equal(results.filter(r => r.status === 'rejected').length, 8);
  assert.equal(f.calls.length, 1);
  assert.ok((await f.safety.request('getState', {})).windows.length);
});

test('another session holds the HWND lease, including after a retitle', async t => {
  const f = fixture(t), other = new InputLease({ directory: f.root, holder: 'another session' });
  t.after(() => other.close());
  const first = await f.safety.request('getApp', { selector: 'Notepad' });
  const second = createWindowsSafety({ driver: { request: async () => ({ windows: [{ ...f.windows[0], title: 'Retitled' }] }) },
    lease: other, approve: async () => true });
  await assert.rejects(second.request('getApp', { selector: { windowId: '101' } }), /held by safety fixture/);
  assert.equal(first.window.windowId, '101');
});

test('shared popup access reserves every HWND of an executable despite optional AUMID differences', async t => {
  const f = fixture(t);
  await f.safety.request('getApp', { selector: 'Notepad' });
  const other = new InputLease({ directory: f.root, holder: 'another session' });
  const window = { ...fakeWindows[0], windowId: '103', pid: 99, aumid: 'Fixture.Package!OtherApp' };
  const second = createWindowsSafety({ driver: { request: async () => ({ windows: [window] }) }, lease: other, approve: async () => true });
  try {
    await assert.rejects(second.request('getApp', { selector: { windowId: '103' } }), /held by safety fixture/);
  } finally { second.close(); }
});

test('changed incarnation or image refuses before a later read', async t => {
  for (const field of ['processStart', 'image', 'pid']) {
    const f = fixture(t);
    const first = await f.safety.request('getApp', { selector: 'Notepad' });
    f.windows[0][field] = field === 'pid' ? 99 : field === 'image' ? 'C:\\other.exe' : '134059077770000002';
    const reads = f.calls.filter(c => c.method === 'getAXState').length;
    await assert.rejects(f.safety.request('getAXState', binding(first.window)), /IDENTITY_CHANGED/);
    assert.equal(f.calls.filter(c => c.method === 'getAXState').length, reads);
  }
});

test('forged IPC validates every key, type, bound and read id before driver calls', async t => {
  const f = fixture(t);
  const first = await f.safety.request('getApp', { selector: 'Notepad' });
  const valid = { ...binding(first.window), readId: first.readId, args: [1] };
  for (const [method, params] of [
    ['getState', { extra: true }], ['getApp', { selector: 'Notepad', approved: true }],
    ['getApp', { selector: { windowId: '101', extra: 1 } }], ['getApp', { selector: 101 }],
    ['getAXState', { ...binding(first.window), lease: 'forged' }],
    ['getScreenshot', { windowId: 101, processStart: first.window.processStart }],
    ['getAXState', { windowId: '18446744073709551616', processStart: first.window.processStart }],
    ['click', { ...valid, args: [-1] }], ['click', { ...valid, args: [[Infinity, 1]] }],
    ['click', { ...valid, args: [3000] }], ['click', { ...valid, readId: '1' }],
    ['click', { ...valid, readId: first.readId + 100 }], ['click', { ...valid, extra: 1 }],
    ['typeText', { ...valid, args: ['x'.repeat(4001)] }],
    ['stuckMenuEscape', valid], ['verifyWindowIdentity', binding(first.window)],
  ]) {
    const count = f.calls.length;
    await assert.rejects(f.safety.request(method, params), /INVALID_PARAMS|STALE_READ|METHOD_NOT_FOUND/);
    assert.equal(f.calls.length, count, method + JSON.stringify(params));
  }
});

test('unacquired bindings cannot read, capture or act; revoked leases cannot read', async t => {
  const f = fixture(t);
  await assert.rejects(f.safety.request('getAXState', binding(fakeWindows[0])), /APP_NOT_ACQUIRED/);
  const first = await f.safety.request('getApp', { selector: 'Notepad' });
  f.lease.release();
  const count = f.calls.length;
  await assert.rejects(f.safety.request('getScreenshot', binding(first.window)), /ownership lost|expired/);
  assert.equal(f.calls.length, count);
});

test('inventory withholds unapproved titles, paths and image identities and strips refused app metadata', async t => {
  const f = fixture(t); f.windows[1].refused = 'OWN_HOST';
  const inventory = await f.safety.request('getState', {});
  assert.doesNotMatch(JSON.stringify(inventory), /Untitled|C:\\\\Windows|Calculator/);
  assert.equal(inventory.windows[0].title, null);
  assert.equal(inventory.windows[0].imageIdentity, null);
  assert.equal(inventory.apps[0].windows[0].imageIdentity, null);
  assert.equal(inventory.windows[1].app, null);
  assert.equal(inventory.windows[1].imageIdentity, null);
  await f.safety.request('getApp', { selector: 'Notepad' });
  const approved = await f.safety.request('listApps', {});
  assert.equal(approved.windows[0].imageIdentity, f.windows[0].imageIdentity);
  assert.equal(approved.windows[1].imageIdentity, null);
});

test('sanitized inventory retains one app group per process incarnation', async t => {
  const f = fixture(t);
  f.windows.push({ ...f.windows[0], windowId: '103', title: 'Another private document' });
  const inventory = await f.safety.request('listApps', {});
  assert.equal(inventory.apps.length, 2);
  assert.equal(inventory.apps[0].windows.length, 2);
  assert.doesNotMatch(JSON.stringify(inventory), /Another private document|Untitled/);
});

test('terminal list and switch match Windows identities, settings stay blocked', () => {
  for (const image of ['WindowsTerminal', 'conhost', 'OpenConsole', 'powershell_ise', 'mintty', 'bash', 'wsl',
    'ConEmu', 'ConEmu64', 'Cmder', 'Alacritty', 'wezterm-gui', 'Hyper', 'Tabby', 'ChatGPT', 'Codex', 'Atlas']) {
    const w = { image: `C:\\Apps\\${image}.exe`, app: image, title: 'ordinary window' };
    assert.ok(matchBlockedWindowsApp(w), image);
    assert.equal(forbiddenWindowsTarget(w)?.code, 'FORBIDDEN_TARGET');
    assert.equal(forbiddenWindowsTarget(w, { allowForbidden: true }), undefined);
    assert.equal(forbiddenWindowsTarget({ ...w, title: 'Settings' }, { allowForbidden: true })?.code, 'FORBIDDEN_SETTINGS');
  }
  assert.ok(matchBlockedWindowsApp({ aumid: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' }));
  assert.ok(matchBlockedWindowsApp({ aumid: 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT' }));
  assert.equal(matchBlockedWindowsApp({ image: 'C:\\Apps\\Notepad.exe' }), undefined);
});

const nativeDirectory = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
const interop = JSON.parse(readFileSync(new URL('./fixtures/windows-driver-interop.json', import.meta.url)));
test('every compiled driver source obeys the reviewed import and message policy, including Program', () => {
  const files = windowsDriverSources.filter(file => file.endsWith('.cs'));
  assert.ok(files.includes('Program.cs'));
  for (const file of files) inspectDriverSource(file, readFileSync(new URL(file, nativeDirectory), 'utf8'), interop[file] ?? []);
});

test('inventory lifetime imports are read-only and property writes are no longer allowlisted', () => {
  for (const name of ['GetClassLongPtrW', 'GetClassLongW', 'OpenThread', 'GetThreadTimes', 'GetPackageFullName']) {
    assert.ok(interop['DriverInventory.cs'].some(declaration => declaration.includes(' ' + name + '(')));
    assert.ok(interop._reasons['DriverInventory.cs'][name].length > 0);
  }
  for (const name of ['GetPropW', 'SetPropW', 'RemovePropW']) {
    assert.ok(!interop['DriverInventory.cs'].some(declaration => declaration.includes(' ' + name + '(')));
  }
  assert.throws(() => inspectDriverSource('DriverInventory.cs',
    '[DllImport("user32.dll")] static extern bool SetPropW(IntPtr hwnd, string name, IntPtr value);', interop['DriverInventory.cs']));
});

test('native edit style imports and the counter/error pair have reviewed reasons', () => {
  assert.deepEqual(interop['DriverClipboard.cs'], [
    '[DllImport("user32.dll", EntryPoint = "GetClipboardSequenceNumber", SetLastError = true)] static extern uint Sequence();',
    '[DllImport("kernel32.dll")] static extern void SetLastError(uint error);',
  ]);
  assert.match(interop._reasons['DriverClipboard.cs'].SetLastError, /valid 0.*denied read/);
  assert.match(interop._reasons['DriverClipboard.cs'].Sequence, /content-free GetClipboardSequenceNumber/);
  for (const name of ['GetWindowLongW', 'SetLastError']) {
    assert.ok(interop['DriverInput.cs'].some(declaration => declaration.includes(' ' + name + '(')));
    assert.match(interop._reasons['DriverInput.cs'][name], /GetWindowLongW|ES_READONLY/);
  }
});

test('WCB2 M10: the counter file refuses access probes even if the supplied allowlist grows', () => {
  const source = readFileSync(new URL('DriverClipboard.cs', nativeDirectory), 'utf8');
  for (const api of ['OpenClipboard', 'CloseClipboard', 'AddClipboardFormatListener', 'GetClipboardOwner', 'CountClipboardFormats']) {
    const declaration = '[DllImport("user32.dll")] static extern uint ' + api + '(uint value);';
    assert.throws(() => inspectDriverSource('DriverClipboard.cs', source + '\n' + declaration,
      [...interop['DriverClipboard.cs'], declaration]), /only the counter read/);
  }
});

for (const [name, source] of [
  ['alternate import attribute', '[DllImportAttribute("user32.dll", EntryPoint = "#2490")] static extern void Safe(IntPtr hwnd);'],
  ['foreground import', '[DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hwnd);'],
  ['concatenated entry point', '[DllImport("user32.dll", EntryPoint = "SetForeground" + "Window")] static extern void Safe(IntPtr hwnd);'],
  ['ordinal entry point', '[DllImport("user32.dll", EntryPoint = "#2490")] static extern void Safe(IntPtr hwnd);'],
  ['quoted comment delimiters', 'const string a = "/*"; SwitchToThisWindow(hwnd, true); const string b = "*/";'],
  ['dynamic lookup', 'GetProcAddress(handle, "SetForegroundWindow");'],
  ['dynamic invoke', 'method.DynamicInvoke(args);'],
  ['activation position', 'SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0);'],
  ['slot focus', 'element.Slot00();'],
  ['posted activation', 'DriverInput.Post(window, hwnd, 0x0006, 0, IntPtr.Zero);'],
  ['sent activation', 'SendMessageTimeoutW(hwnd, 0x0007, UIntPtr.Zero, IntPtr.Zero, 0, 1, out result);'],
]) test('source policy rejects ' + name + ' in any build source', () => {
  assert.throws(() => inspectDriverSource('Program.cs', source, []));
});

test('source policy rejects a missing post allowlist and a broader runtime message set', () => {
  const source = readFileSync(new URL('DriverInput.cs', nativeDirectory), 'utf8');
  assert.throws(() => inspectDriverSource('DriverInput.cs', source.replace('RequirePostMessage(message);', ''), interop['DriverInput.cs']));
  assert.throws(() => inspectDriverSource('DriverInput.cs', source.replace('case 0x100:', 'case 0x0006: case 0x100:'), interop['DriverInput.cs']));
});

test('native reads prune foreign provider subtrees before retrieving text and live patterns recheck ownership', () => {
  const uia = readFileSync(new URL('DriverUia.cs', nativeDirectory), 'utf8');
  assert.match(uia, /ProcessId = 30002/);
  assert.match(uia, /Properties = \{ RuntimeId, BoundingRectangle, ProcessId,/);
  assert.match(uia, /if \(!OwnedProcess\(element.GetCachedPropertyValueEx\(ProcessId, true\), window.Pid\)\) \{\s*excluded.Add\(element\); return false;/);
  assert.ok(uia.indexOf('if (!OwnedProcess(element.') < uia.indexOf('node = Node('));
  const actions = readFileSync(new URL('DriverActions.cs', nativeDirectory), 'utf8');
  assert.match(actions, /OwnedProcess\(node.Element.GetCurrentPropertyValueEx\(ProcessId, true\), window.Pid\)/);
  assert.match(actions, /OwnedProcess\(current.GetCurrentPropertyValueEx\(ProcessId, true\), window.Pid\)/);
});

test('native identity resolves long image paths and carries PE identity through observations', () => {
  const identity = readFileSync(new URL('DriverIdentity.cs', nativeDirectory), 'utf8');
  const inventory = readFileSync(new URL('DriverInventory.cs', nativeDirectory), 'utf8');
  assert.match(identity, /GetLongPathNameW\(path, full,/);
  assert.match(identity, /window.Image, window.OriginalFilename, window.ProductName/);
  assert.match(inventory, /DriverIdentity.LongImagePath\(image.ToString\(\)\)/);
  assert.match(inventory, /FileVersionInfo.GetVersionInfo\(row.Image\)/);
  assert.match(inventory, /row.OriginalFilename = version.OriginalFilename; row.ProductName = version.ProductName/);
  assert.match(inventory, /OriginalFilename == other.OriginalFilename && ProductName == other.ProductName/);
  assert.match(inventory, /ImageIdentity == other.ImageIdentity/);
  assert.match(inventory, /executable.CreationTimeUtc.ToFileTimeUtc\(\)/);
  assert.match(inventory, /executable.Length.ToString\(CultureInfo.InvariantCulture\)/);
});

test('native token denial preserves ELEVATED_TARGET and compares actual token RIDs before input', () => {
  const source = readFileSync(new URL('DriverInventory.cs', nativeDirectory), 'utf8');
  assert.match(source, /target && Marshal.GetLastWin32Error\(\) == 5 \? "ELEVATED_TARGET" : "TARGET_UNAVAILABLE"/);
  assert.match(source, /if \(!OpenProcessToken\(process, 8, out token\)\) throw TokenFault\(target\)/);
  assert.match(source, /if \(!GetTokenInformation\(token, 25, data, length, out length\)\) throw TokenFault\(target\)/);
  assert.match(source, /OpenProcess\(0x1000, false, GetCurrentProcessId\(\)\)/);
  assert.match(source, /return IntegrityOf\(process, false\)/);
  assert.match(source, /static readonly Lazy<uint> CachedOwnIntegrity = new Lazy<uint>\(OwnIntegrity\)/);
  assert.match(source, /uint ownIntegrity = CachedOwnIntegrity.Value, integrity = IntegrityOf\(process, true\)/);
  assert.match(source, /if \(\(integrity > ownIntegrity \|\| integrity >= 0x3000\) && !FrameHostElevationContinues\(row, integrity, ownIntegrity\)\)\s*\{ row\.Refused = "ELEVATED_TARGET"; return row; \}/);
  assert.match(source, /catch \(DriverFault error\) \{ row.Refused = error.Code; \}/);
  const actions = readFileSync(new URL('DriverActions.cs', nativeDirectory), 'utf8');
  const run = actions.slice(actions.indexOf('    object RunAction('));
  assert.ok(run.indexOf('window.RequireReadable();') < run.indexOf('Apply(secondary,'));
  assert.ok(run.indexOf('window.RequireReadable();') < run.indexOf('DriverInput.Click('));
  assert.ok(run.indexOf('window.RequireReadable();') < run.indexOf('latestWindow.SameIdentity(window)'));
  const input = readFileSync(new URL('DriverInput.cs', nativeDirectory), 'utf8');
  assert.ok(input.indexOf('current.RequireReadable();') < input.indexOf('window.SameIdentity(current)'));
  const uia = readFileSync(new URL('DriverUia.cs', nativeDirectory), 'utf8');
  assert.ok(uia.indexOf('after.RequireReadable();') < uia.indexOf('window.SameIdentity(after)'));
});

test('native integrity guard refuses High from High, High from Medium and Medium from Low (source expression)', () => {
  const source = readFileSync(new URL('DriverInventory.cs', nativeDirectory), 'utf8');
  const expression = /if \(\((integrity > ownIntegrity \|\| integrity >= 0x3000)\) && !FrameHostElevationContinues\(row, integrity, ownIntegrity\)\)/.exec(source)?.[1];
  assert.ok(expression, 'find the native refusal expression, without compiling C#');
  for (const [ownIntegrity, integrity, refused] of [
    [0x3000, 0x3000, true], [0x2000, 0x3000, true], [0x2000, 0x2000, false],
    [0x1000, 0x2000, true], [0x4000, 0x4000, true], [0x3000, 0x2000, false],
  ]) assert.equal(runInNewContext(expression, { ownIntegrity, integrity }, { timeout: 1000 }), refused,
    `driver ${ownIntegrity.toString(16)}, target ${integrity.toString(16)}`);
});

test('app consent is off by default, session only, and uses the guarded card path', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/Consent.cs', import.meta.url), 'utf8');
  assert.match(source, /Parse\(Dictionary<string, object> d, bool allowApp = false\)/);
  assert.match(source, /c.Kind == "app" && \(!allowApp \|\| !c.Choices.SequenceEqual\(new\[\] \{ "cancel", "session" \}\)\)\)/);
  assert.match(source, /SLEIGHT_WINDOWS_APP_CARD/);
  assert.doesNotMatch(source, /new Button\b|InvokePattern/);
});

test('forbidden settings policy covers every native root, popup fetch and live action root', () => {
  const directory = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
  const identity = readFileSync(new URL('DriverIdentity.cs', directory), 'utf8');
  assert.match(identity, /if \(ForbiddenSettings\(window\)\) \{ window.Refused = "FORBIDDEN_SETTINGS"; return; \}/);
  const inventory = readFileSync(new URL('DriverInventory.cs', directory), 'utf8');
  assert.match(inventory, /DriverIdentity.ApplyPolicy\(row\)/);
  const uia = readFileSync(new URL('DriverUia.cs', directory), 'utf8');
  assert.match(uia, /if \(popup.Refused != null/);
  const actions = readFileSync(new URL('DriverActions.cs', directory), 'utf8');
  assert.match(actions, /var host = DriverInventory.Observe\(node.Host.Handle\)/);
  assert.match(actions, /host.RequireReadable\(\)/);
});

test('app card flag permits session only and authenticates a native answer once', async () => {
  const card = { id: 'app-fixture', kind: 'app', question: 'Allow fixture?', detail: 'Fixture only', choices: ['cancel', 'session'], deadline: 2000 };
  const helper = { request: async request => JSON.stringify({ id: request.id, nonce: request.nonce, choice: 'session' }) };
  await assert.rejects(createWindowsConsent({ platform: 'win32', appCards: false, helper, now: () => 1000 }).present(card), /WINDOWS_CONSENT_INVALID/);
  const consent = createWindowsConsent({ platform: 'win32', appCards: true, helper, now: () => 1000 });
  for (const choices of [['cancel', 'always'], ['cancel', 'once'], ['cancel', 'session', 'always']])
    await assert.rejects(consent.present({ ...card, choices }), /WINDOWS_CONSENT_INVALID/);
  const answer = await consent.present(card);
  assert.equal(answer.choice, 'session'); assert.equal(consent.authenticate(answer), true); assert.equal(consent.authenticate(answer), false);
});

test('WIN2 coordinator proof selects metadata-only sharing and binds the native evidence', () => {
  const calls = [];
  const permissions = createWindowsFilePermissions({ platform: 'win32', helper: { requestSync(request) {
    calls.push(request); return JSON.stringify({ nonce: request.nonce, ok: true,
      evidence: { path: request.path, kind: 'file', volume: 1, fileId: '1:2:3', parents: 6 } });
  } } });
  assert.equal(permissions.privateCoordinator('C:\\Users\\Fixture\\AppData\\Local\\sleight\\leases\\.coordinator.sqlite').ok, true);
  assert.equal(calls[0].op, 'lease-coordinator'); assert.equal(calls[0].kind, 'file');
  assert.equal(permissions.privateCoordinator('C:\\Users\\Fixture\\other.json').ok, false);
  assert.equal(calls.length, 1);
});

test('approval hosts receive a warning while terminals remain refused', () => {
  for (const image of ['Claude', 'Cursor', 'Copilot', 'Code', 'Code-Insiders']) {
    const window = { image: `C:\\Apps\\${image}.exe` };
    assert.match(windowsForbiddenWarning(window), /approval cards/);
    assert.equal(forbiddenWindowsTarget(window), undefined);
  }
  assert.equal(forbiddenWindowsTarget({ image: 'C:\\Apps\\renamed.exe', originalFilename: 'alacritty.exe' }).code, 'FORBIDDEN_TARGET');
});
