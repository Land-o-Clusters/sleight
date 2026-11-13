// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import { test, describe } from 'node:test';
import { localBackendSkip, localBackends, nativeLocal, localSpaceFixture, prepareNativeToolsFixture } from './fixtures/mac-driver-tools.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Security: the native helpers sleight runs itself (the lease target, hover, drag, window selection and the menu bar)
// refuse sleight's own consent host by its process: the executable behind its pid is in sleight's helper cache. Fakes
// stand in for AppKit and System Events; nothing runs osascript.
for (const backend of localBackends) describe(backend, { skip: localBackendSkip(backend) }, () => {
const OWN = "That is sleight's own confirmation window; only you can answer it.";
const source = name => readFileSync(new URL(`../plugins/sleight/lib/${name}`, import.meta.url), 'utf8');
const url = path => ({ isNil: () => !path, path });
const running = (name, bundleId, executable, pid) => ({ localizedName: name, bundleIdentifier: bundleId,
  bundleURL: url(bundleId ? `/Applications/${name}.app` : null), executableURL: url(executable), processIdentifier: pid });
// The host renamed (a later build might bundle it), so only its executable and pid give it away.
const HOST = running('Glove', 'com.example.glove', `${MAC_USERS}x/Library/Caches/sleight/turbo-host/k1/consent-host`, 4242);
const BARE = running('consent-host', null, `${MAC_USERS}x/Library/Caches/sleight/turbo-host/k1/consent-host`, 4243);
const OTHER = running('Chess', 'com.apple.Chess', '/System/Applications/Chess.app/Contents/MacOS/Chess', 77);
const GLIDE_LINE = "That is sleight's Glide engine; tools never act on it.";
const GLIDE_PATH = `${MAC_USERS}x/Library/Caches/sleight/turbo-host/mac-driver/k2/glide-engine`;
const GLIDE = running('Helper', 'com.example.helper', GLIDE_PATH, 5252);
const GLIDE_NAMED = running('Glide Engine.app', 'com.example.glide', '/usr/local/bin/glide-engine', 5253);
const GLIDE_PREBUILT = running('Prebuilt', 'com.example.prebuilt', '/cache/test-market/sleight/1.6.0/lib/mac-driver/prebuilt/darwin-arm64/glide-engine/Contents/MacOS/Helper', 5254);
const STALE = running('Stale', 'com.example.stale', `${MAC_USERS}x/Library/Caches/sleight/turbo-host/mac-driver/k0/consent-host`, 5255);
const APPS = [HOST, BARE, GLIDE, GLIDE_NAMED, GLIDE_PREBUILT, STALE, OTHER];
function appKit(apps = APPS) {
  const list = { count: apps.length, objectAtIndex: i => apps[i] };
  return { NSWorkspace: { sharedWorkspace: { runningApplications: list, frontmostApplication: OTHER } },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: pid => apps.find(a => a.processIdentifier === pid) ?? { isNil: () => true } } };
}
const objc = { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v, bindFunction() {} };
function load(name, extra = {}) {
  if (backend === 'driver' && name === 'select-window.js') return { run: ([request]) => JSON.stringify(nativeLocal(name, JSON.parse(request), {
    apps: APPS.map(a => ({ appId: a.bundleIdentifier, name: a.localizedName, path: a.bundleURL.path,
      executable: a.executableURL.path, pid: a.processIdentifier })),
  }).result) };
  const context = vm.createContext({ ObjC: objc, $: appKit(), Ref: () => [], Application: () => assert.fail('no Apple events'), delay() {}, ...extra });
  vm.runInContext(source(name), context);
  return context;
}

test('lease target: the host is refused by its executable, renamed or bare, and an ordinary app resolves', () => {
  const context = load('lease-target.js');
  for (const app of ['Glove', 'com.example.glove', 'consent-host']) {
    const result = JSON.parse(context.run([JSON.stringify({ app })]));
    assert.equal(result.ok, false, app); assert.equal(result.error, OWN, app); assert.equal(result.ownHost, true, app);
  }
  assert.deepEqual(JSON.parse(context.run([JSON.stringify({ app: 'Chess' })])),
    { ok: true, target: { appId: 'com.apple.Chess', app: 'Chess', pid: 77, title: null, url: null } });
});

test('hover: resolving the host refuses before any window or pointer work', () => {
  const context = load('hover.js');
  const native = context.nativeHover();
  for (const app of ['Glove', 'consent-host']) assert.throws(() => native.resolve(app), { message: OWN }, app);
  assert.equal(native.resolve('Chess').pid, 77);
});

test('drag: finding the host refuses, in one window and across windows, and an ordinary app is found', () => {
  const context = load('drag.js');
  for (const app of ['Glove', 'consent-host']) assert.throws(() => context.findApp(app), { message: OWN }, app);
  assert.equal(context.findApp('Chess'), OTHER);
  const result = JSON.parse(context.run([JSON.stringify({ app: 'Glove', from: [1, 1], to: [5, 5] })]));
  assert.equal(result.ok, false); assert.match(result.error, /sleight's own confirmation window/);
});

test('select_window: the host is refused before any AXRaise', () => {
  const context = load('select-window.js', { Application: () => assert.fail('no Apple events') });
  const result = JSON.parse(context.run([JSON.stringify({ app: 'Glove', title: 'Allow this payment?' })]));
  assert.equal(result.ok, false); assert.equal(result.error, OWN);
});

// menubar.js reaches processes through System Events: its pid (unixId) leads to the executable, and its file and name count too.
function systemEvents(processes, spaceInventory = localSpaceFixture(77, 'com.apple.Chess')) {
  const clicked = [], events = [];
  if (backend === 'driver') return { clicked, events, run: request => {
    prepareNativeToolsFixture();
    const apps = processes.map(p => ({ name: p.name, appId: APPS.find(a => a.processIdentifier === p.pid)?.bundleIdentifier, pid: p.pid, path: p.file,
      executable: APPS.find(a => a.processIdentifier === p.pid)?.executableURL.path,
      tree: { AXWindows: (spaceInventory.windows ?? []).filter(window => window.pid === p.pid).map(window => ({
        AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow', AXTitle: window.title, AXWindowNumber: Number(window.windowId),
      })), AXChildren: [{ AXRole: 'AXMenuBar' }, { AXRole: 'AXMenuBar',
        AXChildren: [{ key: p.name, pid: p.pid, AXPosition: [1, 1], AXSize: [1, 1] }] }] } }));
    const identity = { ...localSpaceFixture(77, 'com.apple.Chess').windows[0], identityVerified: true };
    const grant = { path: '/fixture/lease', token: 'owned' };
    const f = nativeLocal('menubar.js', { caller: 'menu_bar', driverIdentity: identity, lease: grant, ...request }, { apps, spaceInventory,
      lease: { token: 'owned', expires: Date.now() + 30000,
        window: { appId: identity.bundleId, title: identity.title, windowNumber: 7, url: null } } });
    events.push(...f.events);
    clicked.push(...f.events.filter(e => e[0] === 'action').map(e => e[1]), ...f.events.filter(e => e[0] === 'post').map(() => 'posted'));
    return f.result;
  } };
  const proc = p => ({ exists: () => true, name: () => p.name, unixId: () => p.pid, applicationFile: () => ({ posixPath: () => p.file }),
    windows: () => [], menuBars: () => [{}, { menuBarItems: () => [{ position: () => [1, 1], size: () => [1, 1], click: () => clicked.push(p.name), menus: () => [] }] }] });
  const se = { processes: { byName: name => proc(processes.find(p => p.name === name) ?? { name, pid: 1, file: '' }),
    name: () => processes.map(p => p.name), unixId: () => processes.map(p => p.pid), menuBars: () => processes.map(() => [{}, {}]) } };
  const $ = { ...appKit(), CGEventSourceSecondsSinceLastEventType: () => 60, CGPointMake: (x, y) => ({ x, y }), CGEventCreate: () => 0,
    CGEventGetLocation: () => ({ x: 0, y: 0 }), CGEventCreateMouseEvent: () => ({}), CGEventPost: () => clicked.push('posted'), CGWarpMouseCursorPosition() {} };
  const context = vm.createContext({ ObjC: objc, Application: () => se, $, delay() {} });
  vm.runInContext(source('menubar.js'), context);
  return { run: request => JSON.parse(context.run([JSON.stringify({ caller: 'menu_bar', ...request })])), clicked };
}

test('menu_bar: the host\'s status item, menus and alert windows are refused by name, file and pid, and left out of apps', () => {
  const se = systemEvents([{ name: 'consent-host', pid: 4243, file: `${MAC_USERS}x/Library/Caches/sleight/turbo-host/k1/consent-host` },
    { name: 'Glove', pid: 4242, file: '' }, { name: 'Filed', pid: 9, file: `${MAC_USERS}x/Library/Caches/sleight/turbo-host/k2/consent-host` },
    { name: 'Chess', pid: 77, file: '/System/Applications/Chess.app' }]);
  for (const request of [{ op: 'open', app: 'consent-host' }, { op: 'choose', app: 'consent-host', path: ['Turn Turbo Off…'] },
    { op: 'press', app: 'consent-host', element: 0 }, { op: 'close', app: 'consent-host' }, { op: 'open', app: 'Glove' },
    { op: 'press', app: 'Glove', element: 0 }, { op: 'open', app: 'Filed' }]) {
    const result = se.run(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error, OWN, JSON.stringify(request));
  }
  assert.deepEqual(se.clicked, []);
  assert.deepEqual(se.run({ op: 'apps' }).apps, ['Chess']);
  const opened = se.run({ op: 'open', app: 'Chess' });
  assert.equal(opened.ok, true, opened.error);
  assert.ok(se.clicked.includes('Chess'), 'an ordinary status item still opens');
  if (backend === 'driver') assert.equal(se.events.filter(event => event[0] === 'post').length, 2);
});

if (backend === 'driver') test('menu_bar refuses a windowless ordinary app before AXPress or HID posting', () => {
  const se = systemEvents([{ name: 'Chess', pid: 77, file: '/System/Applications/Chess.app' }], {});
  const opened = se.run({ op: 'open', app: 'Chess' });
  assert.equal(opened.ok, false);
  assert.deepEqual(se.clicked, []);
  assert.equal(se.events.filter(event => ['action', 'main'].includes(event[0])).length, 0);
  assert.equal(se.events.filter(event => event[0] === 'post').length, 0);
  assert.deepEqual(se.events, []);
});

if (backend === 'driver') test('menu_bar admits its leased window with siblings and gates every refused AXPress', () => {
  const processes = [{ name: 'Chess', pid: 77, file: '/System/Applications/Chess.app' }];
  const data = localSpaceFixture(77, 'com.apple.Chess');
  data.windows.unshift({ ...data.windows[0], windowId: '8', title: 'Sibling',
    bounds: { x: 400, y: 0, width: 200, height: 200 } });
  const admitted = systemEvents(processes, data);
  assert.equal(admitted.run({ op: 'open', app: 'Chess' }).ok, true);
  assert.deepEqual(admitted.clicked, ['Chess', 'posted', 'posted']);
  for (const [inventory, args] of [
    [{ ...data, windows: [data.windows[0], { ...data.windows[1], onScreen: false }] }, {}],
    [localSpaceFixture(77, 'com.apple.Chess'), { driverIdentity: undefined }],
    [localSpaceFixture(77, 'com.apple.Chess'), { lease: undefined }],
    [localSpaceFixture(77, 'com.apple.Chess'), { lease: { path: '/fixture/lease', token: 'other' } }],
  ]) {
    const se = systemEvents(processes, inventory);
    const result = se.run({ op: 'open', app: 'Chess', ...args });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.deepEqual(se.clicked, []);
    assert.equal(se.events.filter(e => ['action', 'main', 'post', 'restore'].includes(e[0])).length, 0);
  }
});


test('GL1A 3: renamed Glide executables refuse across the native helpers before AX or input', () => {
  for (const app of [GLIDE, GLIDE_NAMED, GLIDE_PREBUILT]) {
    const name = app.localizedName;
    const target = JSON.parse(load('lease-target.js').run([JSON.stringify({ app: name })]));
    assert.equal(target.ok, false); assert.equal(target.error, GLIDE_LINE);
    assert.throws(() => load('hover.js').nativeHover().resolve(name), { message: GLIDE_LINE });
    assert.throws(() => load('drag.js').findApp(name), { message: GLIDE_LINE });
    const selected = JSON.parse(load('select-window.js').run([JSON.stringify({ app: name, title: 'Private' })]));
    assert.equal(selected.ok, false); assert.equal(selected.error, GLIDE_LINE);
    const se = systemEvents([{ name, pid: app.processIdentifier, file: app.bundleURL.path }]);
    assert.equal(se.run({ op: 'open', app: name }).error, GLIDE_LINE);
    assert.deepEqual(se.clicked, []);
    assert.deepEqual(se.run({ op: 'apps' }).apps, []);
  }
  assert.throws(() => load('hover.js').nativeHover().resolve('Stale'), { message: OWN });
});

});
