import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

export function fixture({ role = 'AXWindow', subrole = 'AXDialog', parent = 'window', fail, cancelCode = 0,
  identifier, inputRole = 'AXTextField', button = true, cancelNoop = false, fieldCancel = false, escapeNoop = false,
  measuredSheet = false, closeNoop = false, delayedSheet = false, sourceText } = {}) {
  if (measuredSheet) { role = 'AXSheet'; subrole = undefined; identifier = 'GoToWindow'; button = false; }
  const source = { ObjC: { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v }, Ref: () => [] };
  runInNewContext(sourceText ?? readFileSync(new URL('../../bench/real-fixture.js', import.meta.url), 'utf8'), source);
  const owner = { AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow' };
  const window = { AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow', AXTitle: 'Recents', AXWindowNumber: 71, AXCloseButton: {} };
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
    CGWindowListCopyWindowInfo: () => [{ kCGWindowOwnerPID: 42, kCGWindowLayer: 0, kCGWindowNumber: 71 }],
    AXUIElementCopyAttributeValue: (element, name, output) => {
      hook(element, name);
      // The poll just missed the async sheet, but the following guard sees it.
      if (pendingSheet && element === window && name === 'AXRole') { pendingSheet = false; show(); }
      if (element.gone) return -25202;
      const value = element[name];
      output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
      return value === undefined ? -25212 : 0;
    },
    AXUIElementSetAttributeValue: (element, name, value) => {
      writes.push([element, name, value]);
      if (fail === 'write-error') return -25203;
      element[name] = value;
      return 0;
    },
    AXUIElementPerformAction: (element, action) => {
      actions.push([element, action]);
      if (element === newItem) { app.AXWindows.push(window); app.AXFocusedWindow = window; }
      if (element === goItem) { if (delayedSheet) pendingSheet = true; else show(); if (fail === 'press-error') return -25204; }
      if (element === panel && action === 'AXCancel') { if (!cancelCode && !cancelNoop) dismiss(); return cancelCode; }
      if (element === field && action === 'AXCancel') { if (fieldCancel) dismiss(); return fieldCancel ? 0 : -25206; }
      if (element === cancel && !cancelNoop) dismiss();
      if (element === close && !closeNoop) dismiss();
      if (element === go) { window.AXDocument = '/fixture/target'; window.AXTitle = 'target'; dismiss(); }
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
      if (event.key === 36) { window.AXDocument = '/fixture/target'; window.AXTitle = 'target'; dismiss(); }
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

