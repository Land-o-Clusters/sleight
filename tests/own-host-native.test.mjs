// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Security: the native helpers sleight runs itself (the lease target, hover, drag, window selection and the menu bar)
// refuse sleight's own consent host by its process: the executable behind its pid is in sleight's helper cache. Fakes
// stand in for AppKit and System Events; nothing runs osascript.
const OWN = "That is sleight's own confirmation window; only you can answer it.";
const source = name => readFileSync(new URL(`../plugins/sleight/lib/${name}`, import.meta.url), 'utf8');
const url = path => ({ isNil: () => !path, path });
const running = (name, bundleId, executable, pid) => ({ localizedName: name, bundleIdentifier: bundleId,
  bundleURL: url(bundleId ? `/Applications/${name}.app` : null), executableURL: url(executable), processIdentifier: pid });
// The host renamed (a later build might bundle it), so only its executable and pid give it away.
const HOST = running('Glove', 'com.example.glove', `${MAC_USERS}x/Library/Caches/sleight/turbo-host/k1/consent-host`, 4242);
const BARE = running('consent-host', null, `${MAC_USERS}x/Library/Caches/sleight/turbo-host/k1/consent-host`, 4243);
const OTHER = running('Chess', 'com.apple.Chess', '/System/Applications/Chess.app/Contents/MacOS/Chess', 77);
const APPS = [HOST, BARE, OTHER];
function appKit(apps = APPS) {
  const list = { count: apps.length, objectAtIndex: i => apps[i] };
  return { NSWorkspace: { sharedWorkspace: { runningApplications: list, frontmostApplication: OTHER } },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: pid => apps.find(a => a.processIdentifier === pid) ?? { isNil: () => true } } };
}
const objc = { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v, bindFunction() {} };
function load(name, extra = {}) {
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
function systemEvents(processes) {
  const clicked = [];
  const proc = p => ({ exists: () => true, name: () => p.name, unixId: () => p.pid, applicationFile: () => ({ posixPath: () => p.file }),
    windows: () => [], menuBars: () => [{}, { menuBarItems: () => [{ position: () => [1, 1], size: () => [1, 1], click: () => clicked.push(p.name), menus: () => [] }] }] });
  const se = { processes: { byName: name => proc(processes.find(p => p.name === name) ?? { name, pid: 1, file: '' }),
    name: () => processes.map(p => p.name), unixId: () => processes.map(p => p.pid), menuBars: () => processes.map(() => [{}, {}]) } };
  const $ = { ...appKit(), CGEventSourceSecondsSinceLastEventType: () => 60, CGPointMake: (x, y) => ({ x, y }), CGEventCreate: () => 0,
    CGEventGetLocation: () => ({ x: 0, y: 0 }), CGEventCreateMouseEvent: () => ({}), CGEventPost: () => clicked.push('posted'), CGWarpMouseCursorPosition() {} };
  const context = vm.createContext({ ObjC: objc, Application: () => se, $, delay() {} });
  vm.runInContext(source('menubar.js'), context);
  return { run: request => JSON.parse(context.run([JSON.stringify(request)])), clicked };
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
});
