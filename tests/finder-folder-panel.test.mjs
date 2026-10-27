import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { runFinderProbe } from '../bench/finder-probe.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function fixture({ role = 'AXWindow', subrole = 'AXDialog', parent = 'window', fail, cancelCode = 0,
  identifier, inputRole = 'AXTextField', button = true, cancelNoop = false, fieldCancel = false, escapeNoop = false,
  measuredSheet = false, closeNoop = false, delayedSheet = false } = {}) {
  if (measuredSheet) { role = 'AXSheet'; subrole = undefined; identifier = 'GoToWindow'; button = false; }
  const source = { ObjC: { import() {}, unwrap: v => v, castRefToObject: v => v }, Ref: () => [] };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), source);
  const owner = { AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow' };
  const window = { AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow', AXTitle: 'Recents', AXCloseButton: {} };
  const app = { AXRole: 'AXApplication', AXWindows: [owner], AXChildren: [], AXFocusedWindow: owner };
  const field = { AXRole: inputRole, AXIdentifier: 'PathTextField' }, go = { AXRole: 'AXButton', AXTitle: 'Go' };
  const close = { AXRole: 'AXButton', AXIdentifier: 'CloseButton', AXDescription: 'Close', AXTitle: '' };
  const cancel = { AXRole: 'AXButton', AXTitle: 'arbitrary cancel title' };
  const panel = { AXRole: role, AXSubrole: subrole, AXIdentifier: identifier, AXChildren: button ? [field, go] : [field], AXCancelButton: cancel,
    AXParent: parent === 'window' ? window : parent === 'foreign' ? owner : app };
  if (parent === 'attribute') panel.AXWindow = window;
  if (parent === 'self') panel.AXWindow = panel;
  if (measuredSheet) {
    delete panel.AXSubrole;
    panel.AXWindow = panel.AXParent;
    panel.AXDefaultButton = null; panel.AXCancelButton = null; panel.AXFocused = false;
    panel.AXChildren = [{ AXRole: 'AXStaticText' }, close, field,
      { AXRole: 'AXScrollArea', AXChildren: [{ AXRole: 'AXTable', AXChildren: [{ AXRole: 'AXRow' }] }] }];
  }
  close.AXParent = panel;
  field.AXParent = panel;
  const newItem = { AXRole: 'AXMenuItem', AXTitle: 'New Finder Window', AXEnabled: 1 };
  const goItem = { AXRole: 'AXMenuItem', AXTitle: 'Go to Folder…', AXEnabled: 1 };
  const top = (name, item) => ({ AXRole: 'AXMenuBarItem', AXTitle: name,
    AXChildren: [{ AXRole: 'AXMenu', AXChildren: [item] }] });
  app.AXMenuBar = { AXChildren: [top('File', newItem), top('Go', goItem)] };
  const actions = [], events = [], writes = [], keys = [];
  let time = 0, retained, pendingSheet = false, hook = () => {};
  const present = () => !panel.gone && app.AXChildren.includes(panel);
  const show = () => {
    app.AXChildren.push(panel);
    if (role === 'AXSheet') window.AXSheets = [panel];
    else app.AXWindows.push(panel);
    app.AXFocusedWindow = measuredSheet ? window : panel; app.AXFocusedUIElement = field;
  };
  const dismiss = () => {
    panel.gone = true; app.AXChildren = app.AXChildren.filter(w => w !== panel && !(w.AXRole === 'AXSheet' && w.AXParent === window));
    app.AXWindows = app.AXWindows.filter(w => w !== panel); window.AXSheets = [];
    window.AXChildren = [];
    app.AXFocusedWindow = window; app.AXFocusedUIElement = window;
  };
  const native = v => v;
  Object.assign(native, {
    CFEqual: (a, b) => a === b,
    AXUIElementGetPid: (_window, ref) => { ref[0] = 42; return 0; },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout() {},
    AXUIElementCopyAttributeValue: (element, name, output) => {
      hook(element, name);
      // The poll just missed the async sheet, but the following guard sees it.
      if (pendingSheet && element === window && name === 'AXRole') { pendingSheet = false; show(); }
      if (element.gone) return -25202;
      const value = element[name];
      output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
      return value === undefined ? -25212 : 0;
    },
    AXUIElementSetAttributeValue: (element, name, value) => { writes.push([element, name, value]); return fail === 'write-error' ? -25203 : 0; },
    AXUIElementPerformAction: (element, action) => {
      actions.push([element, action]);
      if (element === newItem) { app.AXWindows.push(window); app.AXFocusedWindow = window; }
      if (element === goItem) { if (delayedSheet) pendingSheet = true; else show(); if (fail === 'press-error') return -25204; }
      if (element === panel && action === 'AXCancel') { if (!cancelCode && !cancelNoop) dismiss(); return cancelCode; }
      if (element === field && action === 'AXCancel') { if (fieldCancel) dismiss(); return fieldCancel ? 0 : -25206; }
      if (element === cancel && !cancelNoop) dismiss();
      if (element === close && !closeNoop) dismiss();
      if (element === go) { window.AXDocument = '/fixture/target'; dismiss(); }
      if (element === window.AXCloseButton) { app.AXWindows = app.AXWindows.filter(w => w !== window); window.gone = true; }
      return 0;
    },
    NSThread: { sleepForTimeInterval() { time += 100; } },
    // CGEventRef is a C reference, without an Objective-C isNil method.
    CGEventCreateKeyboardEvent: (_source, key, down) => ({ key, down }),
    CGEventSetFlags: (event, flags) => { assert.equal(flags, 0); event.flags = flags; },
    CGEventPostToPid: (pid, event) => {
      assert.equal(pid, 42); assert.equal(event.flags, 0); keys.push([event.key, event.down]);
      if (!event.down) return;
      if (event.key === 36) assert.equal(request.finderOwnership.documentless.length, 0);
      if (event.key === 36) { window.AXDocument = '/fixture/target'; dismiss(); }
      if (event.key === 53 && !escapeNoop) dismiss();
    },
  });
  source.$ = native;
  const clock = { check() {}, now: () => time, wait: ms => { time += ms; }, emit(event) {
    events.push(event);
    if (fail === 'retention-receipt' && event.stage === 'finder-panel-retained') throw new Error('receipt failure');
  } };
  const api = source.nativeAX({ setup: true, bundle: 'com.apple.finder' }, clock);
  if (measuredSheet) {
    panel.testFrame = { x: 100, y: 100, width: 500, height: 200 };
    panel.AXWindowNumber = 71;
    api.frame = element => element.testFrame || null;
  }
  const request = { bundle: 'com.apple.finder', mode: 'folder', fixtureRoot: '/fixture', target: '/fixture/target', token: 'target' };
  // Paths are fixture strings; all AX reads, menu presses and writes use the native adapter.
  api.path = v => v || null;
  const submit = api.submitFolder;
  if (fail === 'before-write') api.submitFolder = () => { throw new Error('setup failure before navigation'); };
  if (fail === 'controls') panel.AXChildren = [];
  return { source, api, app, owner, window, panel, request, actions, events, writes, keys, show, dismiss, present, native, clock, goItem, newItem, field, cancel, close,
    setHook: fn => { hook = fn; }, submit: () => submit.call(api, window, panel, request.target),
    open: () => source.openFinderFolder(request, app, owner, api, clock, w => { retained = w; }),
    recover: () => source.recoverSetup(retained, request, api, app, {}),
    probe: () => source.finderSetupProbe(request, app, api, clock) };
}

for (const delayedSheet of [false, true]) test(`measured macOS 27 sheet submits its focused PathTextField (delayed=${delayedSheet})`, () => {
  const f = fixture({ measuredSheet: true, delayedSheet });
  assert.equal(f.open(), f.window);
  assert.deepEqual(f.writes, [[f.field, 'AXValue', '/fixture/target']]);
  assert.deepEqual(f.keys, [[36, true], [36, false]]);
  assert.equal(f.request.finderOwnership.folderPanel.reference, f.panel);
  assert.equal(f.present(), false);
  assert.equal(f.window.AXDocument, '/fixture/target');
  assert.equal(f.recover(), 'closed retained fixture');
  assert.deepEqual(f.app.AXWindows, [f.owner]);
});

function retainedPanel() {
  const f = fixture({ measuredSheet: true, fail: 'before-write' });
  assert.throws(f.open, /setup failure before navigation/);
  assert.equal(f.request.finderOwnership.folderPanel.reference, f.panel);
  return f;
}

test('pre-command validation never reads sheet geometry and closes only its new window on failure', async t => {
  const f = fixture({ measuredSheet: true }), original = f.api.menu;
  let releases = 0, frameReads = 0;
  f.api.frame = () => { frameReads++; throw new Error('must not read geometry before the command'); };
  f.api.menu = function (app, name, ...args) {
    if (name === 'Go') throw new Error('offline Go-menu failure');
    return original.call(this, app, name, ...args);
  };
  const result = await runFinderProbe({ ownerAway: true }, {
    hold: () => false, tempRoot: tmpdir(), lock: async () => async () => { releases++; },
    run: async (_command, args) => {
      const request = JSON.parse(args[3]);
      trackTemp(request.fixtureRoot); t.after(() => rmSync(request.fixtureRoot, { recursive: true, force: true }));
      return { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify(f.probe()) };
    },
  });
  assert.equal(result.panel.commandAttempted, false);
  assert.equal(frameReads, 0);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.liveLockKept, false);
  assert.equal(releases, 1);
  assert.deepEqual(f.app.AXWindows, [f.owner]);
  assert.equal(f.actions.some(([target]) => target === f.goItem), false);
});

test('a failing retention callback still leaves a documentless cleanup receipt', () => {
  const f = fixture();
  let owned;
  assert.throws(() => f.source.openFinderFolder(f.request, f.app, f.owner, f.api, f.clock, window => {
    owned = window;
    throw new Error('offline retention failure');
  }), /offline retention failure/);
  assert.equal(f.request.finderOwnership.folderPanel, undefined);
  assert.equal(f.source.recoverSetup(owned, f.request, f.api, f.app, {}), 'closed retained fixture');
  assert.deepEqual(f.app.AXWindows, [f.owner]);
  assert.equal(f.actions.some(([target]) => target === f.goItem), false);
});

for (const attribute of ['AXPosition', 'AXSize']) test(`unsupported initial ${attribute} retains equality-only sheet identity`, () => {
  const f = fixture({ measuredSheet: true });
  f.api.frame = () => { throw Object.assign(new Error('unsupported geometry'), { code: -25205, attribute }); };
  assert.equal(f.open(), f.window);
  assert.equal(f.request.finderOwnership.folderPanel.sheetGeometry, undefined);
  assert.equal(f.recover(), 'closed retained fixture');
  assert.deepEqual(f.app.AXWindows, [f.owner]);
});

for (const attribute of ['AXPosition', 'AXSize']) test(`unsupported initial ${attribute} never authorizes a replacement sheet`, () => {
  const f = fixture({ measuredSheet: true, fail: 'before-write' });
  f.api.frame = () => { throw Object.assign(new Error('unsupported geometry'), { code: -25205, attribute }); };
  assert.throws(f.open, /setup failure before navigation/);
  revendedSheet(f); f.panel.gone = true;
  assert.throws(f.submit, /sheet identity changed|AX fixture read failed/);
  assert.throws(f.recover, /sheet identity changed|inventory|Foreign Finder/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

for (const attribute of ['AXPosition', 'AXSize']) test(`unsupported retained ${attribute} fails the existing geometry binding`, () => {
  const f = retainedPanel();
  f.api.frame = () => { throw Object.assign(new Error('unsupported geometry'), { code: -25205, attribute }); };
  assert.throws(f.submit, /sheet identity changed/);
  assert.throws(f.recover, /sheet identity changed/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

function revendedSheet(f, changes = {}) {
  const panel = { ...f.panel, testFrame: { ...f.panel.testFrame }, ...changes };
  f.window.AXSheets = [panel]; f.window.AXChildren = [panel];
  f.app.AXChildren = [panel]; f.field.AXParent = panel; f.close.AXParent = panel;
  if (f.app.AXFocusedWindow === f.panel) f.app.AXFocusedWindow = panel;
  return panel;
}

test('guard accepts newly vended sheet references in each inventory and focused ancestry', () => {
  const f = retainedPanel();
  revendedSheet(f);
  f.setHook((element, name) => {
    if (element === f.window && ['AXSheets', 'AXChildren'].includes(name))
      f.window[name] = [{ ...f.panel, testFrame: { ...f.panel.testFrame } }];
  });
  f.api.finderFolderGuard(f.app, f.window, f.panel);
  assert.equal(f.api.finderPanelExists(f.panel), true);
});

test('focus comparisons settle when every focused-sheet read returns a new reference', () => {
  const f = retainedPanel();
  revendedSheet(f);
  let reads = 0;
  f.setHook((element, name) => {
    if (element === f.app && name === 'AXFocusedWindow') {
      assert.ok(++reads < 12, 'focus revalidation must terminate');
      f.app.AXFocusedWindow = { ...f.panel, testFrame: { ...f.panel.testFrame } };
    }
  });
  f.api.finderFolderGuard(f.app, f.window, f.panel);
  assert.equal(f.clock.now(), 0);
});

test('role inventory accepts the current sheet when AXWindows lists a re-vended reference', () => {
  const f = retainedPanel(), panel = revendedSheet(f);
  f.app.AXWindows.push(panel);
  const entries = f.source.finderRoleInventory(f.app, f.api, f.request.finderOwnership, 'cleanup-inventory');
  assert.deepEqual(Array.from(entries, entry => entry.reference), [f.owner, f.window]);
});

test('submission accepts a sheet re-vended after the path field write', () => {
  const f = fixture({ measuredSheet: true });
  const write = f.native.AXUIElementSetAttributeValue;
  f.native.AXUIElementSetAttributeValue = (...args) => {
    const code = write(...args); revendedSheet(f); f.panel.gone = true; return code;
  };
  assert.equal(f.open(), f.window);
  assert.deepEqual(f.keys, [[36, true], [36, false]]);
  assert.equal(f.api.finderPanelExists(f.panel), false);
  assert.equal(f.recover(), 'closed retained fixture');
});

test('dismissal wait sees the re-vended sheet even when the original AX reference is invalid', () => {
  const f = retainedPanel();
  revendedSheet(f); f.panel.gone = true;
  assert.equal(f.api.finderPanelExists(f.panel), true);
  f.window.AXSheets = []; f.window.AXChildren = []; f.app.AXChildren = [];
  assert.equal(f.api.finderPanelExists(f.panel), false);
});

test('cleanup accepts a re-vended sheet', () => {
  const f = retainedPanel(); revendedSheet(f); f.panel.gone = true;
  assert.equal(f.recover(), 'closed retained fixture');
  assert.deepEqual(f.keys, [[53, true], [53, false]]);
});

for (const attribute of ['AXSheets', 'AXChildren', 'app-children', 'app-windows']) test(`second sheet in ${attribute} refuses guard, dismissal and cancellation`, () => {
  const f = retainedPanel(), current = revendedSheet(f);
  if (attribute === 'app-children') f.app.AXChildren = [current, { ...current }];
  else if (attribute === 'app-windows') f.app.AXWindows.push(current, { ...current });
  else f.window[attribute] = [current, { ...current }];
  assert.throws(() => f.api.finderFolderGuard(f.app, f.window, f.panel), /sheet identity changed/);
  assert.throws(() => f.api.finderPanelExists(f.panel), /sheet identity changed/);
  assert.throws(f.recover, /sheet identity changed/);
  assert.deepEqual(f.keys, []);
});

for (const change of ['identifier', 'parent', 'owner', 'number', 'missing-number', 'frame', 'missing-frame', 'subrole']) {
  test(`re-vended sheet with changed ${change} refuses submission and cleanup`, () => {
    const f = retainedPanel();
    const changes = {
      identifier: { AXIdentifier: 'ForeignPanel' }, parent: { AXParent: f.owner }, owner: { AXWindow: f.owner },
      number: { AXWindowNumber: 72 }, 'missing-number': { AXWindowNumber: undefined },
      frame: { testFrame: { ...f.panel.testFrame, x: 104 } }, 'missing-frame': { testFrame: null },
      subrole: { AXSubrole: 'AXDialog' },
    };
    revendedSheet(f, changes[change]);
    assert.throws(f.submit, /sheet identity changed/);
    assert.throws(f.recover, /sheet identity changed/);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
  });
}

test('frame tolerance stays anchored to the original sheet', () => {
  const f = retainedPanel();
  const panel = revendedSheet(f, { testFrame: { x: 103, y: 97, width: 503, height: 197 } });
  f.api.finderFolderGuard(f.app, f.window, f.panel);
  panel.testFrame.x = 106;
  assert.throws(() => f.api.finderFolderGuard(f.app, f.window, f.panel), /sheet identity changed/);
});

for (const key of ['x', 'y', 'width', 'height']) test(`equal sheet reference cannot bypass ${key} frame drift`, () => {
  const f = retainedPanel(); f.panel.testFrame[key] += 4;
  assert.throws(f.submit, /sheet identity changed/);
  assert.throws(f.recover, /sheet identity changed/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

for (const foreign of ['second-sheet', 'foreign-parent']) test(`${foreign} appearing after field input blocks Return and cleanup`, () => {
  const f = fixture({ measuredSheet: true });
  const write = f.native.AXUIElementSetAttributeValue;
  f.native.AXUIElementSetAttributeValue = (...args) => {
    const code = write(...args), panel = revendedSheet(f);
    if (foreign === 'second-sheet') f.window.AXSheets.push({ ...panel });
    else { panel.AXParent = f.owner; panel.AXWindow = f.owner; }
    return code;
  };
  assert.throws(f.open, /sheet identity changed/);
  assert.throws(f.recover, /sheet identity changed/);
  assert.equal(f.writes.length, 1); assert.deepEqual(f.keys, []);
});

test('discovery tolerates sheet references re-vended before retention', () => {
  const f = fixture({ measuredSheet: true });
  f.setHook((element, name) => {
    if (element === f.window && ['AXSheets', 'AXChildren'].includes(name) && f.present())
      f.window[name] = [{ ...f.panel, testFrame: { ...f.panel.testFrame } }];
  });
  assert.equal(f.open(), f.window);
  assert.deepEqual(f.keys, [[36, true], [36, false]]);
});

test('submission waits for dismissal of the current sheet after reference replacement', () => {
  const f = fixture({ measuredSheet: true });
  const post = f.native.CGEventPostToPid;
  let submitted = false;
  f.native.CGEventPostToPid = (pid, event) => {
    if (event.key !== 36) return post(pid, event);
    if (event.down) {
      submitted = true; revendedSheet(f); f.panel.gone = true;
      f.window.AXDocument = '/fixture/target';
    }
  };
  const wait = f.clock.wait;
  f.clock.wait = ms => { wait(ms); if (submitted) f.dismiss(); };
  assert.equal(f.open(), f.window);
  assert.equal(f.clock.now(), 100);
  assert.equal(f.api.finderPanelExists(f.panel), false);
});

test('cleanup resolves the current sheet for CloseButton after ineffective Escape', () => {
  const f = fixture({ measuredSheet: true, fail: 'before-write', escapeNoop: true });
  assert.throws(f.open, /setup failure/);
  revendedSheet(f); f.panel.gone = true;
  assert.equal(f.recover(), 'closed retained fixture');
  assert.ok(f.actions.some(([target]) => target === f.close));
});

function focusSequence(f, sequence) {
  const reads = [];
  f.setHook((element, name) => {
    if (element !== f.app || name !== 'AXFocusedWindow') return;
    f.app.AXFocusedWindow = sequence[Math.min(reads.length, sequence.length - 1)];
    reads.push(f.app.AXFocusedWindow);
  });
  return reads;
}

for (const direction of ['window-to-sheet', 'sheet-to-window']) {
  test(`guard settles ${direction} during dialog inspection`, () => {
    const f = retainedPanel();
    const [before, after] = direction === 'window-to-sheet' ? [f.window, f.panel] : [f.panel, f.window];
    f.app.AXFocusedWindow = before;
    let flipped = false;
    f.setHook((element, name) => {
      if (!flipped && element === f.window && name === 'AXSubrole') {
        flipped = true; f.app.AXFocusedWindow = after;
      }
    });
    const started = f.clock.now();
    f.api.finderFolderGuard(f.app, f.window, f.panel);
    assert.equal(flipped, true);
    assert.equal(f.app.AXFocusedWindow, after);
    assert.equal(f.clock.now() - started, 100);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
  });

  for (const dismissed of [false, true]) test(`focus reader settles ${direction} after ${dismissed ? 'dismissal' : 'opening'}`, () => {
    const f = retainedPanel();
    if (dismissed) f.dismiss();
    const [before, after] = direction === 'window-to-sheet' ? [f.window, f.panel] : [f.panel, f.window];
    const reads = focusSequence(f, [before, after, before, after, after]);
    const started = f.clock.now();
    assert.equal(f.api.focused(f.app), after);
    assert.deepEqual(reads.slice(-2), [after, after]);
    assert.equal(reads.length, 5);
    assert.equal(f.clock.now() - started, 300);
  });
}

test('guard refuses a foreign window appearing during dialog inspection without waiting', () => {
  const f = retainedPanel();
  f.setHook((element, name) => {
    if (element === f.window && name === 'AXSubrole') f.app.AXFocusedWindow = f.owner;
  });
  const started = f.clock.now();
  assert.throws(() => f.api.finderFolderGuard(f.app, f.window, f.panel), /focus changed during validation/);
  assert.equal(f.clock.now(), started);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

for (const foreign of ['window', 'sheet', 'missing']) test(`settling refuses ${foreign} focus on its first read`, () => {
  const f = retainedPanel();
  const stranger = foreign === 'window' ? f.owner : foreign === 'sheet'
    ? { AXRole: 'AXSheet', AXParent: f.owner } : null;
  const reads = focusSequence(f, [f.window, f.panel, stranger, f.window, f.window]);
  const started = f.clock.now();
  assert.throws(() => f.api.finderFolderGuard(f.app, f.window, f.panel), /focus changed during validation/);
  assert.equal(reads.length, 3);
  assert.equal(f.clock.now() - started, 100);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

test('endless window-sheet alternation fails after six waits', () => {
  const f = retainedPanel();
  const reads = focusSequence(f, Array.from({ length: 12 }, (_, index) => index % 2 ? f.panel : f.window));
  const started = f.clock.now();
  assert.throws(() => f.api.finderFolderGuard(f.app, f.window, f.panel), /focus changed during validation/);
  assert.equal(reads.length, 8);
  assert.equal(f.clock.now() - started, 600);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

test('slow focus reads reach the one-second deadline before the read limit', () => {
  const f = retainedPanel();
  let reads = 0;
  f.setHook((element, name) => {
    if (element !== f.app || name !== 'AXFocusedWindow') return;
    f.app.AXFocusedWindow = reads++ % 2 ? f.panel : f.window;
    f.clock.wait(200);
  });
  const started = f.clock.now();
  assert.throws(() => f.api.focused(f.app), /focus changed during validation/);
  assert.equal(reads, 4);
  assert.equal(f.clock.now() - started, 1000);
});

test('an unretained sheet cannot authorize a focus transition', () => {
  const f = fixture({ measuredSheet: true });
  f.app.AXWindows.push(f.window); f.show();
  let reads = 0;
  f.setHook((element, name) => {
    if (element === f.app && name === 'AXFocusedWindow') f.app.AXFocusedWindow = reads++ ? f.panel : f.window;
  });
  assert.throws(() => f.api.finderFolderGuard(f.app, f.window, f.panel), /focus changed during validation/);
  assert.equal(f.clock.now(), 0);
});

test('settled focus cannot bypass a retained panel parent change', () => {
  const f = retainedPanel();
  f.panel.AXParent = f.owner; f.panel.AXWindow = f.owner;
  focusSequence(f, [f.window, f.panel, f.panel]);
  assert.throws(() => f.api.finderFolderGuard(f.app, f.window, f.panel), /sheet identity changed/);
});

test('guard rechecks panel ownership after waiting for focus to settle', () => {
  const f = retainedPanel();
  let flipped = false;
  f.setHook((element, name) => {
    if (!flipped && element === f.window && name === 'AXSubrole') {
      flipped = true; f.app.AXFocusedWindow = f.panel;
    }
  });
  const wait = f.clock.wait;
  f.clock.wait = ms => {
    wait(ms); f.panel.AXParent = f.owner; f.panel.AXWindow = f.owner;
  };
  assert.throws(() => f.api.finderFolderGuard(f.app, f.window, f.panel), /sheet identity changed/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

test('repeated transitions during revalidation share the same six-read budget', () => {
  const f = retainedPanel();
  const listed = f.api.listed;
  f.api.listed = (...args) => {
    const result = listed(...args);
    f.app.AXFocusedWindow = f.app.AXFocusedWindow === f.window ? f.panel : f.window;
    return result;
  };
  const started = f.clock.now();
  assert.throws(() => f.api.finderFolderGuard(f.app, f.window, f.panel), /focus changed during validation/);
  assert.equal(f.clock.now() - started, 600);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

for (const foreign of [false, true]) test(`submission checks focus after sheet dismissal (foreign=${foreign})`, () => {
  const f = fixture({ measuredSheet: true });
  const post = f.native.CGEventPostToPid;
  let reads;
  f.native.CGEventPostToPid = (pid, event) => {
    post(pid, event);
    if (event.key === 36 && !event.down) reads = focusSequence(f, [f.panel, foreign ? f.owner : f.window, f.window]);
  };
  if (foreign) assert.throws(f.open, /focus changed during validation/);
  else assert.equal(f.open(), f.window);
  assert.equal(f.present(), false);
  if (foreign) assert.equal(reads.length, 2);
  else assert.deepEqual(reads.slice(-2), [f.window, f.window]);
});

test('opening settles a late sheet that takes focus during the guarded adoption scan', () => {
  const f = fixture({ measuredSheet: true, delayedSheet: true });
  const emit = f.clock.emit;
  f.clock.emit = event => {
    emit(event);
    if (event.stage === 'finder-panel-retained') f.app.AXFocusedWindow = f.panel;
  };
  assert.equal(f.open(), f.window);
  assert.equal(f.clock.now(), 100);
  assert.deepEqual(f.keys, [[36, true], [36, false]]);
});

for (const foreign of [false, true]) test(`cleanup checks focus after Escape dismissal (foreign=${foreign})`, () => {
  const f = retainedPanel();
  const post = f.native.CGEventPostToPid;
  let reads;
  f.native.CGEventPostToPid = (pid, event) => {
    post(pid, event);
    if (event.key === 53 && !event.down) reads = focusSequence(f, [f.panel, foreign ? f.owner : f.window, f.window]);
  };
  if (foreign) {
    assert.throws(f.recover, /focus changed during validation/);
    assert.equal(f.actions.some(([target]) => target === f.window.AXCloseButton), false);
    assert.equal(reads.length, 2);
  } else {
    assert.equal(f.recover(), 'closed retained fixture');
    assert.deepEqual(reads.slice(-2), [f.window, f.window]);
  }
  assert.equal(f.present(), false);
});

test('measured sheet cleanup sends Escape first and verifies disappearance before any Close press', () => {
  const f = fixture({ measuredSheet: true, fail: 'before-write', cancelCode: -25206 });
  assert.throws(f.open, /setup failure/);
  assert.equal(f.recover(), 'closed retained fixture');
  assert.deepEqual(f.keys, [[53, true], [53, false]]);
  assert.equal(f.actions.some(([target]) => target === f.panel || target === f.close), false);
  assert.equal(f.present(), false);
});

test('measured sheet cleanup presses CloseButton only after ineffective Escape and verifies its disappearance', () => {
  const f = fixture({ measuredSheet: true, fail: 'before-write', cancelCode: -25206, escapeNoop: true });
  const action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (target, name) => {
    if (target === f.close) assert.deepEqual(f.keys, [[53, true], [53, false]]);
    return action(target, name);
  };
  assert.throws(f.open, /setup failure/);
  assert.equal(f.recover(), 'closed retained fixture');
  assert.ok(f.actions.some(([target, name]) => target === f.close && name === 'AXPress'));
  assert.equal(f.present(), false);
});

test('measured sheet with ignored Escape and ineffective Close reports cleanup unconfirmed', () => {
  const f = fixture({ measuredSheet: true, fail: 'before-write', cancelCode: -25206, escapeNoop: true, closeNoop: true });
  assert.throws(f.open, /setup failure/);
  assert.throws(f.recover, /sheet cleanup unconfirmed/);
  assert.equal(f.present(), true);
  assert.equal(f.actions.some(([target]) => target === f.window.AXCloseButton), false);
});

test('Return refuses a different focused field within the measured retained sheet', () => {
  const f = fixture({ measuredSheet: true });
  const write = f.native.AXUIElementSetAttributeValue;
  f.native.AXUIElementSetAttributeValue = (...args) => {
    const code = write(...args);
    f.app.AXFocusedUIElement = { AXRole: 'AXTextField', AXParent: f.panel };
    return code;
  };
  assert.throws(f.open, /keyboard target unconfirmed/);
  assert.deepEqual(f.keys, []);
});

test('measured GoToWindow refuses a field without the PathTextField identifier', () => {
  const f = fixture({ measuredSheet: true });
  f.field.AXIdentifier = 'OtherField';
  assert.throws(f.open, /controls ambiguous/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

for (const parent of ['foreign', 'application']) test(`measured GoToWindow with ${parent} parent is refused`, () => {
  const f = fixture({ measuredSheet: true, parent });
  assert.throws(f.open, /Foreign Finder|identity changed/);
  assert.equal(f.request.finderOwnership.folderPanel.reference, undefined);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

test('measured GoToWindow present before the command has no ownership receipt', () => {
  const f = fixture({ measuredSheet: true }); f.show();
  assert.throws(f.open, /Foreign Finder/);
  assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

test('Return refuses a focus change while creating its events and keeps documentless cleanup', () => {
  const f = fixture({ measuredSheet: true }), create = f.native.CGEventCreateKeyboardEvent;
  f.native.CGEventCreateKeyboardEvent = (...args) => {
    const event = create(...args);
    f.app.AXFocusedUIElement = { AXRole: 'AXTextField', AXParent: f.owner };
    return event;
  };
  assert.throws(f.open, /keyboard target unconfirmed/);
  assert.deepEqual(f.keys, []);
  assert.equal(f.request.finderOwnership.documentless.length, 1);
  assert.equal(f.recover(), 'closed retained fixture');
  assert.ok(f.actions.some(([target]) => target === f.close));
});

test('CloseButton fallback refuses parent drift after ignored Escape', () => {
  const f = fixture({ measuredSheet: true, fail: 'before-write', escapeNoop: true });
  assert.throws(f.open, /setup failure/);
  f.setHook((element, name) => { if (element === f.close && name === 'AXIdentifier') f.panel.AXParent = f.owner; });
  assert.throws(f.recover, /identity changed/);
  assert.deepEqual(f.keys, [[53, true], [53, false]]);
  assert.equal(f.actions.some(([target]) => target === f.close || target === f.window.AXCloseButton), false);
});

test('a late sheet attached to an owner window stays foreign during the guarded scan', () => {
  const f = fixture({ measuredSheet: true, parent: 'foreign', delayedSheet: true });
  assert.throws(f.open, /Foreign Finder/);
  assert.equal(f.request.finderOwnership.folderPanel.reference, undefined);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
});

test('menu Escape handles a C event reference without masking the original menu refusal', () => {
  const f = fixture(), action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (element, name) =>
    element.AXRole === 'AXMenu' && name === 'AXCancel' ? -25206 : action(element, name);
  f.native.CGEventPostToPid = (pid, event) => {
    assert.equal(pid, 42); f.keys.push([event.key, event.down]);
  };
  assert.throws(() => f.api.fileMenu(f.app, ['Missing command']), error => {
    assert.match(error.message, /menu item unavailable/);
    assert.equal(error.menuCleanupError, undefined);
    return true;
  });
  assert.deepEqual(f.keys, [[53, true], [53, false]]);
});

test('measured sheet with ineffective Escape and Close keeps the synthetic probe lock', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture({ measuredSheet: true, fail: 'before-write', cancelCode: -25206, escapeNoop: true, closeNoop: true });
  let releases = 0;
  const result = await runFinderProbe({ ownerAway: true }, {
    hold: () => false, lock: async () => async () => { releases++; },
    run: async (command, args) => {
      assert.equal(command, '/usr/bin/osascript');
      const request = JSON.parse(args[3]);
      trackTemp(request.fixtureRoot); t.after(() => rmSync(request.fixtureRoot, { recursive: true, force: true }));
      const receipt = f.probe();
      assert.equal(receipt.cleanupConfirmed, false);
      assert.equal(receipt.cleanupFailure.failureReason, 'folder-panel-cleanup-unconfirmed');
      assert.equal(receipt.cleanupFailure.errorName, 'Error');
      return { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify(receipt) };
    },
  });
  assert.equal(result.liveLockKept, true); assert.equal(result.passed, false); assert.equal(releases, 0);
  assert.equal(f.present(), true);
  assert.equal(f.actions.some(([target]) => target === f.window.AXCloseButton), false);
  assert.equal(JSON.parse(readFileSync(result.receiptPath, 'utf8')).liveLockKept, true);
});

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

for (const [role, subrole, parent] of [
  ['AXSheet', 'AXStandardWindow', 'window'], ['AXSheet', '', 'self'],
  ['AXWindow', 'AXDialog', 'self'], ['AXWindow', 'AXSystemDialog', 'application'],
]) test(`GoToWindow ${role}/${subrole} with ${parent} parent uses its command receipt`, () => {
  const f = fixture({ role, subrole, parent, identifier: 'GoToWindow' });
  assert.equal(f.open(), f.window);
  assert.equal(f.request.finderOwnership.folderPanel.goToWindow, true);
  assert.deepEqual(f.writes, [[f.field, 'AXValue', '/fixture/target']]);
});

for (const role of ['AXSheet', 'AXWindow']) test(`stale GoToWindow ${role} is refused without a command or cleanup action`, () => {
  const f = fixture({ role, identifier: 'GoToWindow' }); f.show();
  assert.throws(f.open, /Foreign Finder Go to Folder panel/);
  assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.keys, []);
  assert.equal(f.present(), true);
});

for (const inputRole of ['AXTextField', 'AXComboBox']) test(`GoToWindow with ${inputRole} and no Go button submits Return to the proved input`, () => {
  const f = fixture({ role: 'AXSheet', subrole: 'AXStandardWindow', identifier: 'GoToWindow', inputRole, button: false });
  assert.equal(f.open(), f.window);
  assert.deepEqual(f.keys, [[36, true], [36, false]]);
  assert.equal(f.present(), false);
  assert.equal(f.request.finderOwnership.documentless.length, 0);
});

test('a default button within the retained sheet submits without an English Go title', () => {
  const f = fixture({ identifier: 'GoToWindow' });
  const go = f.panel.AXChildren[1]; go.AXTitle = 'Open'; f.panel.AXDefaultButton = go;
  assert.equal(f.open(), f.window);
  assert.ok(f.actions.some(([target]) => target === go)); assert.deepEqual(f.keys, []);
});

for (const failure of ['missing-focus', 'foreign-focus', 'input-change']) test(`Return refuses ${failure} and recovery cancels only the retained panel`, () => {
  const f = fixture({ role: 'AXSheet', identifier: 'GoToWindow', button: false });
  const write = f.native.AXUIElementSetAttributeValue;
  f.native.AXUIElementSetAttributeValue = (...args) => {
    const code = write(...args);
    if (failure === 'foreign-focus') f.app.AXFocusedWindow = f.owner;
    else if (failure === 'missing-focus') delete f.app.AXFocusedUIElement;
    else f.app.AXFocusedUIElement = { AXRole: 'AXButton', AXParent: f.panel };
    return code;
  };
  assert.throws(f.open, /keyboard target unconfirmed|lost focus/);
  assert.deepEqual(f.keys, []);
  assert.equal(f.recover(), 'closed retained fixture'); assert.equal(f.present(), false);
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

for (const mutation of ['parent', 'role', 'subrole', 'replacement', 'identifier']) test(`recovery refuses ${mutation} drift before cancelling or closing`, () => {
  const f = fixture({ fail: 'before-write' }); assert.throws(f.open);
  if (mutation === 'parent') f.panel.AXParent = f.owner;
  if (mutation === 'role') f.panel.AXRole = 'AXGroup';
  if (mutation === 'subrole') f.panel.AXSubrole = 'AXStandardWindow';
  if (mutation === 'replacement') { f.dismiss(); f.app.AXWindows.push({ AXRole: 'AXWindow', AXSubrole: 'AXDialog' }); }
  if (mutation === 'identifier') f.panel.AXIdentifier = 'GoToWindow';
  const count = f.actions.length;
  assert.throws(f.recover, /identity changed|Foreign Finder dialog|dialog present/);
  assert.equal(f.actions.length, count);
});

test('a foreign dialog after retention does not strand our panel or permit closing the foreign one', () => {
  const f = fixture({ fail: 'before-write' }); assert.throws(f.open);
  const foreign = { AXRole: 'AXSheet', AXParent: f.owner }; f.app.AXChildren.push(foreign);
  assert.throws(f.recover, /Foreign Finder dialog/);
  assert.equal(f.present(), false);
  assert.ok(f.app.AXChildren.includes(foreign));
  assert.equal(f.actions.some(([target]) => target === foreign || target === f.window.AXCloseButton), false);
});

test('a failed command with a panel arriving after setup is retained again during cleanup', () => {
  const f = fixture(), action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (element, name) => element === f.goItem ? -25204 : action(element, name);
  assert.throws(f.open, /press failed/);
  assert.equal(f.request.finderOwnership.folderPanel.reference, undefined);
  f.show();
  assert.equal(f.recover(), 'closed retained fixture');
  assert.equal(f.present(), false);
});

test('a Go action returning success with its sheet still open fails setup and cancels the sheet', () => {
  const f = fixture(), action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (element, name) => {
    if (element.AXRole === 'AXButton' && element.AXTitle === 'Go') {
      f.window.AXDocument = '/fixture/target'; return 0;
    }
    return action(element, name);
  };
  assert.throws(f.open, /still open after submission/);
  assert.equal(f.recover(), 'closed retained fixture');
  assert.equal(f.present(), false);
});

test('panel cancellation fallback uses its AXCancelButton after unsupported AXCancel', () => {
  const f = fixture({ fail: 'before-write', cancelCode: -25206 }); assert.throws(f.open);
  assert.equal(f.recover(), 'closed retained fixture');
  assert.ok(f.actions.some(([element]) => element === f.cancel));
});

for (const cancelCode of [0, -25206]) test(`GoToWindow uses Escape before the panel cancellation action ${cancelCode}`, () => {
  const f = fixture({ role: 'AXSheet', identifier: 'GoToWindow', fail: 'before-write', cancelCode, cancelNoop: true });
  assert.throws(f.open);
  assert.equal(f.recover(), 'closed retained fixture');
  assert.equal(f.present(), false);
  assert.deepEqual(f.keys, [[53, true], [53, false]]);
  assert.equal(f.actions.some(([target, action]) => target === f.panel && action === 'AXCancel'), false);
});

test('GoToWindow input cancellation works after ineffective Escape and unsupported panel cancellation', () => {
  const f = fixture({ role: 'AXSheet', identifier: 'GoToWindow', fail: 'before-write', cancelCode: -25206, fieldCancel: true, escapeNoop: true });
  delete f.panel.AXCancelButton;
  assert.throws(f.open); assert.equal(f.recover(), 'closed retained fixture');
  assert.equal(f.present(), false); assert.deepEqual(f.keys, [[53, true], [53, false]]);
  assert.equal(f.actions.some(([target, action]) => target === f.field && action === 'AXCancel'), true);
});

test('an English Cancel button is bound and rechecked when AXCancelButton is absent', () => {
  const f = fixture({ fail: 'before-write', cancelCode: -25206 });
  delete f.panel.AXCancelButton; f.cancel.AXTitle = 'Cancel'; f.panel.AXChildren.push(f.cancel);
  assert.throws(f.open); assert.equal(f.recover(), 'closed retained fixture');
  assert.equal(f.present(), false); assert.ok(f.actions.some(([target]) => target === f.cancel));
});

test('a retained panel is cancelled even if the failed Go attempt revoked parent-title cleanup', () => {
  const f = fixture();
  const action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (element, name) => {
    if (element.AXRole === 'AXButton' && element.AXTitle === 'Go') return -25204;
    return action(element, name);
  };
  assert.throws(f.open, /press failed/);
  assert.equal(f.request.finderOwnership.documentless.length, 0);
  assert.equal(f.recover(), 'unconfirmed');
  assert.equal(f.present(), false);
  assert.equal(f.actions.some(([target]) => target === f.window.AXCloseButton), false);
});

test('a dismissed panel retaining readable AXRole is absent once its app tree no longer contains it', () => {
  const f = fixture({ fail: 'before-write' }); assert.throws(f.open);
  f.dismiss(); delete f.panel.gone;
  assert.equal(f.api.finderPanelExists(f.panel), false);
  assert.equal(f.recover(), 'closed retained fixture');
});

for (const target of ['parent', 'app']) test(`an invalid ${target} read cannot count as panel dismissal`, () => {
  const f = fixture({ fail: 'before-write' }); assert.throws(f.open);
  const read = f.native.AXUIElementCopyAttributeValue;
  f.native.AXUIElementCopyAttributeValue = (element, name, output) =>
    element === (target === 'parent' ? f.window : f.app) ? -25202 : read(element, name, output);
  assert.throws(() => f.api.finderPanelExists(f.panel), /read failed/);
  assert.equal(f.present(), true);
});

test('all ineffective cancellation routes report unconfirmed cleanup and keep the parent open', () => {
  const f = fixture({ identifier: 'GoToWindow', fail: 'before-write', cancelCode: -25206, cancelNoop: true, escapeNoop: true });
  assert.throws(f.open);
  assert.throws(f.recover, /sheet cleanup unconfirmed/);
  assert.equal(f.present(), true);
  assert.equal(f.actions.some(([target]) => target === f.window.AXCloseButton), false);
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

test('native probe clock supports production menu action receipts before its first snapshot', () => {
  const f = fixture(), target = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder' };
  Object.assign(f.native, {
    AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => target }) },
    NSData: { dataWithContentsOfFile: () => ({ isNil: () => false }) },
    NSString: { alloc: { initWithDataEncoding: () => '{"cancelled":false}' } },
  });
  f.source.finderProcessBirth = () => '1.000000';
  const nativeAX = f.source.nativeAX;
  f.source.nativeAX = (state, clock) => {
    assert.equal(typeof clock.emit, 'function');
    const api = nativeAX(state, clock); api.path = value => value || null; return api;
  };
  const root = ['', 'private', 'tmp', 'sleight-finder-probe-OFFLINE'].join('/');
  // The fake Go button reports the fixed fixture path used throughout this tree.
  const action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (element, name) => {
    const code = action(element, name);
    if (element.AXRole === 'AXButton' && element.AXTitle === 'Go') f.window.AXDocument = root + '/Finder-probe';
    return code;
  };
  const result = JSON.parse(f.source.runFinderSetupProbe({ bundle: 'com.apple.finder', ownerAway: true, stopOnLiveHold: true,
    fixtureRoot: root, target: root + '/Finder-probe', control: root + '/control.json' }, () => {}));
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(f.present(), false);
  assert.deepEqual(f.app.AXWindows, [f.owner]);
});
