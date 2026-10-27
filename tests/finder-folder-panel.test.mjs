import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function fixture({ role = 'AXWindow', subrole = 'AXDialog', parent = 'window', fail, cancelCode = 0 } = {}) {
  const source = { ObjC: { import() {}, unwrap: v => v, castRefToObject: v => v }, Ref: () => [] };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), source);
  const owner = { AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow' };
  const window = { AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow', AXTitle: 'Recents', AXCloseButton: {} };
  const app = { AXRole: 'AXApplication', AXWindows: [owner], AXChildren: [], AXFocusedWindow: owner };
  const field = { AXRole: 'AXTextField' }, go = { AXRole: 'AXButton', AXTitle: 'Go' };
  const cancel = { AXRole: 'AXButton', AXTitle: 'arbitrary cancel title' };
  const panel = { AXRole: role, AXSubrole: subrole, AXChildren: [field, go], AXCancelButton: cancel,
    AXParent: parent === 'window' ? window : parent === 'foreign' ? owner : app };
  if (parent === 'attribute') panel.AXWindow = window;
  field.AXParent = panel;
  const newItem = { AXRole: 'AXMenuItem', AXTitle: 'New Finder Window', AXEnabled: 1 };
  const goItem = { AXRole: 'AXMenuItem', AXTitle: 'Go to Folder…', AXEnabled: 1 };
  const top = (name, item) => ({ AXRole: 'AXMenuBarItem', AXTitle: name,
    AXChildren: [{ AXRole: 'AXMenu', AXChildren: [item] }] });
  app.AXMenuBar = { AXChildren: [top('File', newItem), top('Go', goItem)] };
  const actions = [], events = [], writes = [];
  let time = 0, retained, hook = () => {};
  const present = () => !panel.gone && app.AXChildren.includes(panel);
  const show = () => {
    app.AXChildren.push(panel);
    if (role === 'AXSheet') window.AXSheets = [panel];
    else app.AXWindows.push(panel);
    app.AXFocusedWindow = panel; app.AXFocusedUIElement = field;
  };
  const dismiss = () => {
    panel.gone = true; app.AXChildren = app.AXChildren.filter(w => w !== panel);
    app.AXWindows = app.AXWindows.filter(w => w !== panel); window.AXSheets = [];
    app.AXFocusedWindow = window; app.AXFocusedUIElement = window;
  };
  const native = v => v;
  Object.assign(native, {
    CFEqual: (a, b) => a === b,
    AXUIElementGetPid: (_window, ref) => { ref[0] = 42; return 0; },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout() {},
    AXUIElementCopyAttributeValue: (element, name, output) => {
      hook(element, name);
      if (element.gone) return -25202;
      const value = element[name];
      output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
      return value === undefined ? -25212 : 0;
    },
    AXUIElementSetAttributeValue: (element, name, value) => { writes.push([element, name, value]); return fail === 'write-error' ? -25203 : 0; },
    AXUIElementPerformAction: (element, action) => {
      actions.push([element, action]);
      if (element === newItem) { app.AXWindows.push(window); app.AXFocusedWindow = window; }
      if (element === goItem) { show(); if (fail === 'press-error') return -25204; }
      if (element === panel && action === 'AXCancel') { if (!cancelCode) dismiss(); return cancelCode; }
      if (element === cancel) dismiss();
      if (element === go) { window.AXDocument = '/fixture/target'; dismiss(); }
      if (element === window.AXCloseButton) { app.AXWindows = app.AXWindows.filter(w => w !== window); window.gone = true; }
      return 0;
    },
    NSThread: { sleepForTimeInterval() { time += 100; } },
  });
  source.$ = native;
  const clock = { check() {}, now: () => time, wait: ms => { time += ms; }, emit(event) {
    events.push(event);
    if (fail === 'retention-receipt' && event.stage === 'finder-panel-retained') throw new Error('receipt failure');
  } };
  const api = source.nativeAX({ setup: true, bundle: 'com.apple.finder' }, clock);
  const request = { bundle: 'com.apple.finder', mode: 'folder', fixtureRoot: '/fixture', target: '/fixture/target', token: 'target' };
  // Paths are fixture strings; all AX reads, menu presses and writes use the native adapter.
  api.path = v => v || null;
  const submit = api.submitFolder;
  if (fail === 'before-write') api.submitFolder = () => { throw new Error('setup failure before navigation'); };
  if (fail === 'controls') panel.AXChildren = [];
  return { source, api, app, owner, window, panel, request, actions, events, writes, show, dismiss, present, native, goItem, newItem, field, cancel,
    setHook: fn => { hook = fn; }, submit: () => submit.call(api, window, panel, request.target),
    open: () => source.openFinderFolder(request, app, owner, api, clock, w => { retained = w; }),
    recover: () => source.recoverSetup(retained, request, api, app, {}),
    probe: () => source.finderSetupProbe(request, app, api, clock) };
}

for (const [role, subrole, parent] of [
  ['AXSheet', '', 'window'], ['AXWindow', 'AXDialog', 'window'],
  ['AXWindow', 'AXSystemDialog', 'attribute'],
]) test(`own Go to Folder ${role}/${subrole} with ${parent} parent is accepted without reading its title`, () => {
  const f = fixture({ role, subrole, parent });
  f.setHook((element, name) => { if (element === f.panel && name === 'AXTitle') assert.fail('panel title is not identity'); });
  assert.equal(f.open(), f.window);
  const panel = f.request.finderOwnership.folderPanel;
  assert.equal(panel.attempted, true);
  assert.equal(panel.reference, f.panel);
  assert.equal(panel.role, role); assert.equal(panel.subrole, subrole);
  assert.equal(f.request.finderOwnership.created.length, 1);
  assert.deepEqual(f.writes, [[f.field, 'AXValue', '/fixture/target']]);
  assert.equal(f.events.filter(e => e.stage === 'finder-panel-retained').length, 1);
});

for (const fail of ['before-write', 'controls', 'press-error', 'retention-receipt', 'write-error']) {
  for (const role of ['AXSheet', 'AXWindow']) test(`recovery dismisses own ${role} and closes documentless created window after ${fail}`, () => {
    const f = fixture({ role, fail });
    assert.throws(f.open, /setup failure|controls ambiguous|press failed|receipt failure|AXValue failed/);
    assert.equal(f.request.finderOwnership.folderPanel.reference, f.panel);
    assert.equal(f.recover(), 'closed retained fixture');
    assert.equal(f.present(), false);
    assert.deepEqual(f.app.AXWindows, [f.owner]);
    assert.deepEqual(f.actions.filter(([target, action]) => target === f.panel && action === 'AXCancel'), [[f.panel, 'AXCancel']]);
    assert.equal(f.actions.filter(([target]) => target === f.window.AXCloseButton).length, 1);
    assert.equal(f.actions.some(([target]) => target === f.owner), false);
    assert.deepEqual(f.writes, fail === 'write-error' ? [[f.field, 'AXValue', '/fixture/target']] : []);
  });
}

test('a foreign dialog already present refuses before New Finder Window', () => {
  const f = fixture(); f.show();
  assert.throws(f.open, /Foreign Finder dialog/);
  assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []);
});

test('a foreign dialog appearing while the Go menu opens never gets a command receipt', () => {
  const f = fixture();
  const action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (element, name) => {
    const code = action(element, name);
    if (element.AXTitle === 'Go' && name === 'AXPress') f.show();
    return code;
  };
  assert.throws(f.open, /identity changed|Foreign Finder dialog/);
  assert.equal(f.request.finderOwnership.folderPanel.attempted, false);
  assert.equal(f.request.finderOwnership.folderPanel.reference, undefined);
  assert.equal(f.actions.some(([target]) => target === f.goItem), false);
  assert.throws(f.recover, /Foreign Finder dialog/);
  assert.equal(f.present(), true);
});

for (const parent of ['foreign', 'application']) test(`post-command dialog with ${parent} parent refuses adoption and cleanup`, () => {
  const f = fixture({ parent });
  assert.throws(f.open, /identity changed|Foreign Finder dialog/);
  assert.equal(f.request.finderOwnership.folderPanel.reference, undefined);
  assert.throws(f.recover, /Foreign Finder dialog/);
  assert.equal(f.present(), true); assert.deepEqual(f.writes, []);
});

test('a plain untitled standard window is never adopted as a Go to Folder panel', () => {
  const f = fixture({ subrole: 'AXStandardWindow' });
  assert.throws(f.open, /identity changed/);
  assert.equal(f.request.finderOwnership.folderPanel.reference, undefined);
  assert.deepEqual(f.writes, []);
});

for (const mutation of ['parent', 'role', 'subrole', 'replacement', 'foreign-dialog']) test(`recovery refuses ${mutation} drift before cancelling or closing`, () => {
  const f = fixture({ fail: 'before-write' }); assert.throws(f.open);
  if (mutation === 'parent') f.panel.AXParent = f.owner;
  if (mutation === 'role') f.panel.AXRole = 'AXGroup';
  if (mutation === 'subrole') f.panel.AXSubrole = 'AXStandardWindow';
  if (mutation === 'replacement') { f.dismiss(); f.app.AXWindows.push({ AXRole: 'AXWindow', AXSubrole: 'AXDialog' }); }
  if (mutation === 'foreign-dialog') f.app.AXChildren.push({ AXRole: 'AXSheet', AXParent: f.owner });
  const count = f.actions.length;
  assert.throws(f.recover, /identity changed|Foreign Finder dialog|dialog present/);
  assert.equal(f.actions.length, count);
});

test('panel cancellation fallback uses its AXCancelButton after unsupported AXCancel', () => {
  const f = fixture({ fail: 'before-write', cancelCode: -25206 }); assert.throws(f.open);
  assert.equal(f.recover(), 'closed retained fixture');
  assert.ok(f.actions.some(([element]) => element === f.cancel));
});

test('failed panel cancellation leaves its fixture window open', () => {
  const f = fixture({ fail: 'before-write', cancelCode: -25204 }); assert.throws(f.open);
  assert.throws(f.recover, /cancellation failed/);
  assert.ok(f.app.AXWindows.includes(f.window));
  assert.equal(f.actions.some(([target]) => target === f.window.AXCloseButton), false);
});

test('cancellation rechecks panel parent after reading its fallback button', () => {
  const f = fixture({ fail: 'before-write', cancelCode: -25206 }); assert.throws(f.open);
  f.setHook((element, name) => { if (element === f.panel && name === 'AXCancelButton') f.panel.AXParent = f.owner; });
  assert.throws(f.recover, /identity changed/);
  assert.equal(f.actions.some(([target]) => target === f.cancel || target === f.window.AXCloseButton), false);
});

test('two panels opened after the command remain ambiguous and neither is dismissed', () => {
  const f = fixture();
  const action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (element, name) => {
    const code = action(element, name);
    if (element === f.goItem) f.app.AXChildren.push({ AXRole: 'AXSheet', AXParent: f.window });
    return code;
  };
  assert.throws(f.open, /identity changed|Foreign Finder dialog/);
  assert.equal(f.request.finderOwnership.folderPanel.reference, undefined);
  assert.throws(f.recover, /Foreign Finder dialog/);
  assert.equal(f.actions.some(([target]) => target === f.panel || target === f.window.AXCloseButton), false);
});

test('a pre-existing attached sheet refuses before either menu action', () => {
  const f = fixture({ role: 'AXSheet' }); f.show();
  assert.throws(f.open, /Foreign Finder dialog/);
  assert.deepEqual(f.actions, []);
});

test('a cyclic panel parent chain cannot use its AXWindow attribute as an escape', () => {
  const f = fixture({ parent: 'attribute' });
  const group = { AXRole: 'AXGroup' }; group.AXParent = group; f.panel.AXParent = group;
  assert.throws(f.open, /identity changed|Foreign Finder dialog/);
  assert.equal(f.request.finderOwnership.folderPanel.reference, undefined);
  assert.deepEqual(f.writes, []);
});

test('navigation revokes default-title cleanup exactly when Go is attempted', () => {
  const f = fixture();
  const write = f.native.AXUIElementSetAttributeValue;
  f.native.AXUIElementSetAttributeValue = (...args) => {
    assert.equal(f.request.finderOwnership.documentless.length, 1);
    return write(...args);
  };
  const action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (element, name) => {
    if (element.AXTitle === 'Go' && element.AXRole === 'AXButton') assert.equal(f.request.finderOwnership.documentless.length, 0);
    return action(element, name);
  };
  assert.equal(f.open(), f.window);
});

test('setup probe records panel metadata and excludes its AXWindow from owner windows', () => {
  const f = fixture({ fail: 'before-write' }), result = f.probe();
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.panel)), { commandAttempted: true, retained: true,
    role: 'AXWindow', subrole: 'AXDialog', parentConfirmed: true });
  assert.equal(result.snapshots.every(row => row.ownerWindowsEqual), true);
});
