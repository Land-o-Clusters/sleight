// Four Word runs that ended without saving left the fixture's own Save/Don't Save sheet outside AXSheets, cleanup refused it
// as an app dialog, and the pass stopped (claim run 2026-10-18T01-06Z). sleight-arch answered it by hand: AX press of
// Don't Save on the sheet of "Report-<nonce>  -  Compatibility Mode", terminate (ignored with no windows), forceTerminate.
// These fakes cover that path and the refusals around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { openFixture, closeFixtures } from '../bench/real-fixture.mjs';
import { executeRealTask, cleanupContained } from '../bench/real-run.mjs';

function source() {
  const sandbox = { ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

// where: 'focused sheet' (Word: AXSheets unsupported, the sheet is the focused window), 'children', or 'alert'.
function wordFixture({ where = 'focused sheet', preexisting = true, label = 'Don’t Save' } = {}) {
  const sandbox = source(), app = {}, events = [], presses = [];
  const button = { AXRole: 'AXButton', AXTitle: label };
  const prompt = { AXRole: where === 'alert' ? 'AXWindow' : 'AXSheet', ...(where === 'alert' && { AXSubrole: 'AXDialog' }),
    AXChildren: [{ AXRole: 'AXStaticText', AXValue: 'Do you want to save the changes you made to Report-nonce.docx?' },
      button, { AXRole: 'AXButton', AXTitle: 'Cancel' }, { AXRole: 'AXButton', AXTitle: 'Save' }] };
  const window = { AXRole: 'AXWindow', AXWindowNumber: 100, AXTitle: 'Report-nonce  -  Compatibility Mode', AXDocument: 'file:///run/Report-nonce.docx',
    AXChildren: [], AXCloseButton: { AXRole: 'AXButton' } };
  prompt.AXWindowNumber = 101;
  app.AXWindows = [window];
  if (where !== 'alert') prompt.AXParent = window;
  const show = () => {
    if (where === 'children') window.AXChildren = [prompt];
    else app.AXFocusedWindow = prompt;
  };
  app.AXFocusedWindow = window;
  if (preexisting) show();
  const native = value => value;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (element === window && attribute === 'AXSheets') return -25205;
    const value = element[attribute] ?? null;
    output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
    return 0;
  };
  native.AXUIElementPerformAction = element => {
    presses.push(element);
    if (element === window.AXCloseButton) show();
    else { window.AXRole = ''; window.AXChildren = []; app.AXFocusedWindow = null; app.AXWindows = []; }
    return 0;
  };
  native.CFEqual = (a, b) => a === b;
  native.AXUIElementGetPid = (_app, output) => { output[0] = 42; return 0; };
  native.CGWindowListCopyWindowInfo = () => [100, 101].map(kCGWindowNumber => ({ kCGWindowNumber, kCGWindowOwnerPID: 42, kCGWindowLayer: 0 }));
  native.NSThread = { sleepForTimeInterval() {} };
  native.NSURL = {
    URLWithString: value => ({ isNil: () => false, isFileURL: value.startsWith('file://'), URLByResolvingSymlinksInPath: { path: value.slice(7) } }),
    fileURLWithPath: value => ({ absoluteString: `file://${value}` }),
  };
  sandbox.$ = native; sandbox.Ref = () => []; sandbox.ObjC.castRefToObject = value => value;
  let time = 0;
  const api = sandbox.nativeAX({ cleanup: true, setupCase: 'cold-launch' },
    { now: () => time, check() {}, emit: event => events.push(event), wait: ms => { time += ms; }, cleanupRequested: () => true });
  const request = { mode: 'document', target: '/run/Report-nonce.docx', token: 'Report-nonce.docx', runToken: 'nonce', stopOnAppDialog: true };
  const receipt = api.retain(window, request, app);
  return { sandbox, app, button, prompt, window, presses, events, api, request, receipt,
    close() { return sandbox.closeOwnedWindow(window, request, app, api); } };
}

test('Numbers reports the saved document before a changed document identity refuses cleanup', () => {
  const f = wordFixture();
  Object.assign(f.request, { bundle: 'com.apple.iWork.Numbers', reportDocument: true });
  f.window.AXDocument = 'file:///custom/Renamed.numbers';
  assert.throws(f.close, /identity changed/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.events.find(e => e.stage === 'numbers-document')?.numbersDocument)),
    { status: 'available', path: '/custom/Renamed.numbers' });
  assert.deepEqual(f.presses, []);
});

for (const label of ['Delete', "Don't Save", 'Don’t Save']) for (const preexisting of [true, false]) {
  test(`Numbers discards its nonce-titled imported CSV without AXDocument using ${label} (${preexisting ? 'existing sheet' : 'on close'})`, () => {
    const f = wordFixture({ label, preexisting, where: 'children' });
    Object.assign(f.request, { bundle: 'com.apple.iWork.Numbers', target: '/run/Transfer-nonce.csv', token: 'Transfer-nonce', reportDocument: true });
    f.window.AXTitle = 'Transfer-nonce'; delete f.window.AXDocument;
    f.prompt.AXChildren[0].AXValue = 'Do you want to save this document?';
    f.close();
    assert.equal(f.window.AXRole, '');
    assert.equal(f.presses.at(-1), f.button);
    assert.equal(f.events.find(e => e.stage === 'fixture-sheet')?.fixtureSheet.pressed, label);
    assert.equal(f.events[0].stage, 'numbers-document');
    assert.equal(f.events[0].numbersDocument.status, 'available');
  });
}

for (const kind of ['foreign title', 'foreign document', 'non-file document', 'another app', 'two discard buttons', 'permission', 'foreign parent', 'unattached alert']) {
  test(`Numbers import discard refuses ${kind}`, () => {
    const f = wordFixture({ label: 'Delete' });
    Object.assign(f.request, { bundle: 'com.apple.iWork.Numbers', target: '/run/Transfer-nonce.csv', token: 'Transfer-nonce' });
    f.window.AXTitle = 'Transfer-nonce'; delete f.window.AXDocument;
    if (kind === 'foreign title') f.window.AXTitle = 'Owner document';
    if (kind === 'foreign document') f.window.AXDocument = 'file:///owner/Transfer-nonce.csv';
    if (kind === 'non-file document') f.window.AXDocument = 'https://example.test/Transfer-nonce.csv';
    if (kind === 'another app') f.request.bundle = 'com.microsoft.Word';
    if (kind === 'two discard buttons') f.prompt.AXChildren.push({ AXRole: 'AXButton', AXTitle: "Don't Save" });
    if (kind === 'permission') f.prompt.AXChildren.push({ AXRole: 'AXStaticText', AXValue: 'Numbers needs access to Documents' });
    if (kind === 'foreign parent') f.prompt.AXParent = { AXRole: 'AXWindow' };
    if (kind === 'unattached alert') { f.prompt.AXRole = 'AXWindow'; f.prompt.AXSubrole = 'AXDialog'; delete f.prompt.AXParent; }
    assert.throws(f.close, /cleanup refused|identity changed|focus/);
    assert.deepEqual(f.presses, []);
  });
}

for (const where of ['focused sheet', 'children', 'alert']) for (const preexisting of [true, false]) {
  test(`cleanup answers the fixture's own Don't Save ${where} ${preexisting ? 'left open by the task' : 'shown on close'}`, () => {
    const f = wordFixture({ where, preexisting });
    f.close();
    assert.equal(f.window.AXRole, '');
    assert.equal(f.presses.at(-1), f.button);
    assert.equal(f.presses.length, preexisting ? 1 : 2);
    const pressed = f.events.filter(event => event.stage === 'fixture-sheet');
    assert.equal(pressed.length, 1);
    const source = { 'focused sheet': 'focused sheet', children: 'AXChildren', alert: 'focused alert' }[where];
    assert.deepEqual(JSON.parse(JSON.stringify(pressed[0].fixtureSheet)), { pressed: 'Don’t Save', source,
      windowTitle: 'Report-nonce  -  Compatibility Mode', buttons: ['Don’t Save', 'Cancel', 'Save'] });
  });
}

for (const kind of ['foreign path', 'foreign title', 'no Don\'t Save', 'unknown button', 'sign-in text', 'other window\'s sheet',
  'alert without the file', 'foreign dialog over the window']) {
  test(`cleanup still refuses ${kind} and presses nothing`, () => {
    const f = wordFixture();
    if (kind === 'foreign path') f.window.AXDocument = 'file:///owner/Report-nonce.docx';
    if (kind === 'foreign title') f.window.AXTitle = 'Owner report';
    if (kind === 'no Don\'t Save') f.button.AXTitle = 'Delete';
    if (kind === 'unknown button') f.prompt.AXChildren.push({ AXRole: 'AXButton', AXTitle: 'Allow' });
    if (kind === 'sign-in text') f.prompt.AXChildren.push({ AXRole: 'AXStaticText', AXValue: 'Sign in to save to OneDrive' });
    if (kind === 'other window\'s sheet') f.prompt.AXParent = { AXRole: 'AXWindow', AXTitle: 'Owner document' };
    if (kind === 'alert without the file') {
      Object.assign(f.prompt, { AXRole: 'AXWindow', AXSubrole: 'AXDialog' }); delete f.prompt.AXParent;
      f.prompt.AXChildren[0].AXValue = 'Do you want to save the changes you made to Notes?';
    }
    if (kind === 'foreign dialog over the window') {
      f.window.AXChildren = [f.prompt];
      f.app.AXFocusedWindow = { AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'Sign in',
        AXChildren: [{ AXRole: 'AXButton', AXTitle: 'Sign In' }] };
    }
    assert.throws(() => f.close(), /cleanup refused|focus|identity changed/);
    assert.deepEqual(f.presses, []);
    assert.equal(f.events.some(event => event.stage === 'fixture-sheet'), false);
  });
}

test('the refusal names the dialog it saw', () => {
  const f = wordFixture();
  f.prompt.AXChildren.push({ AXRole: 'AXButton', AXTitle: 'Allow' });
  assert.throws(() => f.close(), /fixture cleanup refused \(application-result "" \[Don’t Save, Cancel, Save, Allow\]\)/);
});

test('the retained Word helper records setup CG identity and answers its own sheet despite unsupported AXTitle', () => {
  const f = wordFixture({ preexisting: false }), out = [];
  let command = 'opened', titleMissing = false;
  Object.assign(f.app, { processIdentifier: 42, bundleIdentifier: 'com.microsoft.Word', isFinishedLaunching: true });
  const native = f.sandbox.$;
  const read = native.AXUIElementCopyAttributeValue;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (titleMissing && element === f.window && attribute === 'AXTitle') return -25205;
    return read(element, attribute, output);
  };
  native.AXIsProcessTrusted = () => true;
  native.NSRunningApplication = {
    runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => f.app }),
    runningApplicationWithProcessIdentifier: () => f.app,
  };
  f.app.isNil = () => false;
  native.AXUIElementCreateApplication = () => f.app;
  native.AXUIElementSetMessagingTimeout = () => {};
  native.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
  native.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({ command }) } };
  native.NSFileHandle = { fileHandleWithStandardOutput: { writeData: value => {
    const event = JSON.parse(value); out.push(event);
    // The task typed and never saved: Word shows its sheet as the focused window, then the harness asks for cleanup.
    if (event.stage === 'ready') { titleMissing = true; f.app.AXFocusedWindow = f.prompt; command = 'close'; }
  } } };
  f.sandbox.$ = Object.assign(value => ({ toString: () => value, dataUsingEncoding: () => value }), native);
  f.sandbox.run([JSON.stringify({ ...f.request, app: 'Microsoft Word', bundle: 'com.microsoft.Word', control: 'fake' })]);
  assert.equal(out.at(-1).stage, 'closed');
  assert.deepEqual(out.find(event => event.stage === 'ready').fixtureWindow, { target: f.request.target, windowNumber: 100 });
  assert.equal(out.find(event => event.stage === 'fixture-sheet')?.fixtureSheet.pressed, 'Don’t Save');
  assert.deepEqual(f.presses, [f.button]);
});

test('the wait-0 Word title failure recovers before pressing its own save sheet', () => {
  const f = wordFixture({ preexisting: false });
  let time = 0;
  const native = f.sandbox.$, read = native.AXUIElementCopyAttributeValue;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (element === f.window && attribute === 'AXTitle' && f.presses.includes(f.window.AXCloseButton) && time < 600) return -25205;
    return read(element, attribute, output);
  };
  native.NSThread.sleepForTimeInterval = seconds => { time += seconds * 1000; };
  const api = f.sandbox.nativeAX({ cleanup: true, setupCase: 'cold-launch' }, { now: () => time, wait: ms => { time += ms; }, emit: e => f.events.push(e) });
  f.sandbox.closeOwnedWindow(f.window, f.request, f.app, api);
  assert.deepEqual(f.presses, [f.window.AXCloseButton, f.button]);
  assert.equal(f.events.find(e => e.stage === 'cleanup-read-wait').cleanupReadWait.elapsedMs, 500);
});

for (const preexisting of [false, true]) test(`persistent unsupported Word title answers its parented focused sheet (${preexisting ? 'already open' : 'wait-0'})`, () => {
  const f = wordFixture({ preexisting }), native = f.sandbox.$, read = native.AXUIElementCopyAttributeValue;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (element === f.window && attribute === 'AXTitle' && (preexisting || f.presses.length)) return -25205;
    return read(element, attribute, output);
  };
  f.close();
  assert.equal(f.window.AXRole, '');
  assert.equal(f.presses.filter(element => element === f.button).length, 1);
  assert.equal(f.events.filter(event => event.stage === 'fixture-sheet').length, 1);
  assert.equal(f.events.find(event => event.stage === 'fixture-sheet').fixtureSheet.windowTitle, null);
});

test('a save sheet that stays visible after discard is pressed only once and still needs close proof', () => {
  const f = wordFixture(), native = f.sandbox.$, read = native.AXUIElementCopyAttributeValue;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (element === f.window && attribute === 'AXTitle') return -25205;
    return read(element, attribute, output);
  };
  native.AXUIElementPerformAction = element => { f.presses.push(element); return 0; };
  assert.throws(f.close, /still open/);
  assert.deepEqual(f.presses, [f.button]);
});

for (const change of ['path', 'number', 'reference', 'listed', 'parent']) test(`unsupported title never bypasses changed ${change}`, () => {
  const f = wordFixture(), native = f.sandbox.$, read = native.AXUIElementCopyAttributeValue;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (element === f.window && attribute === 'AXTitle') return -25205;
    return read(element, attribute, output);
  };
  if (change === 'path') f.window.AXDocument = 'file:///owner/Report-nonce.docx';
  if (change === 'number') f.window.AXWindowNumber = 101;
  if (change === 'listed') f.app.AXWindows = [];
  if (change === 'parent') f.prompt.AXParent = { AXRole: 'AXWindow' };
  const window = change === 'reference' ? { ...f.window } : f.window;
  if (change === 'reference') f.app.AXWindows = [window];
  // A missing listing can establish absence, but can never authorize a discard.
  try { f.sandbox.closeOwnedWindow(window, f.request, f.app, f.api); } catch {}
  assert.deepEqual(f.presses, []);
});

function officeQuit({ windows = { none: true, axWindows: 0, onScreen: 0 }, launchMs = 5000, startedAtMs = 5000, pid = 42 } = {}) {
  const { quitFixtureApplication } = source();
  let forced = false, time = 0;
  const events = [], seen = [];
  const app = { processIdentifier: pid, bundleIdentifier: 'com.microsoft.Word', terminate: true, isFinishedLaunching: true,
    launchDate: { isNil: () => false, timeIntervalSince1970: launchMs / 1000 }, get forceTerminate() { forced = true; return true; } };
  const clock = { now: () => time, wait: ms => { time += ms; }, emit: e => events.push(e), startedAtMs,
    windowless: target => { seen.push(target.processIdentifier); return windows; } };
  return { run: () => quitFixtureApplication(42, 'com.microsoft.Word', () => forced ? null : app, clock),
    events, seen, get forced() { return forced; }, get time() { return time; } };
}

test('Word that ignores a quit with no windows is force-terminated after ten seconds', () => {
  const q = officeQuit();
  assert.equal(q.run(), true);
  assert.equal(q.forced, true);
  assert.ok(q.time >= 10000 && q.time < 11000, `forced at ${q.time} ms`);
  assert.deepEqual(JSON.parse(JSON.stringify(q.events.at(-1).quitWait)), { reason: 'force-terminated-windowless', accepted: true,
    elapsedMs: q.time, finishedLaunching: true, windowless: { none: true, axWindows: 0, onScreen: 0 } });
  assert.ok(q.seen.every(pid => pid === 42));
});

for (const [kind, options] of [
  ['a window still open', { windows: { none: false, axWindows: 1, onScreen: 1 } }],
  ['an on-screen sheet the AX list misses', { windows: { none: false, axWindows: 0, onScreen: 1 } }],
  ['an unreadable window list', { windows: { none: false, axWindows: -1, onScreen: 0 } }],
  ['another launch time on the same pid', { launchMs: 9000 }],
  ['no recorded launch time', { startedAtMs: 0 }],
]) test(`Word with ${kind} keeps the quit stop and is never force-terminated`, () => {
  const q = officeQuit(options);
  assert.throws(q.run, /quit unconfirmed after thirty seconds|start time changed/);
  assert.equal(q.forced, false);
});

test('Word under another pid is refused before any force', () => {
  const q = officeQuit({ pid: 43 });
  assert.throws(q.run, /identity changed/);
  assert.equal(q.forced, false);
});

function quittingOffice({ bundle = 'com.microsoft.Word', label = "Don't Save", change, terminateAt = 600, where = 'children', unsupportedTitle = false } = {}) {
  const f = wordFixture({ preexisting: false, label, where });
  let time = 0, quitting = false;
  const native = f.sandbox.$;
  if (unsupportedTitle) {
    const read = native.AXUIElementCopyAttributeValue;
    native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
      if (element === f.window && attribute === 'AXTitle') return -25205;
      return read(element, attribute, output);
    };
    f.request.fixtureWindow = f.receipt;
  }
  Object.assign(f.app, { processIdentifier: 42, bundleIdentifier: bundle, isFinishedLaunching: true,
    AXWindows: [f.window], isNil: () => false });
  Object.defineProperties(f.app, {
    launchDate: { get: () => ({ isNil: () => false, timeIntervalSince1970: quitting && change === 'start' ? 6 : 5 }) },
    isTerminated: { get: () => quitting && f.presses.includes(f.button) && time >= terminateAt },
    terminate: { get: () => {
      quitting = true;
      if (where === 'children') f.window.AXChildren = [f.prompt];
      else f.app.AXFocusedWindow = f.prompt;
      if (change === 'path') f.window.AXDocument = 'file:///owner/Report-nonce.docx';
      if (change === 'sheet') f.prompt.AXParent = { AXRole: 'AXWindow' };
      if (change === 'button') f.prompt.AXChildren.push({ AXRole: 'AXButton', AXTitle: 'Always Allow' });
      if (change === 'sign-in') f.prompt.AXChildren[0].AXValue = 'Sign in to save to OneDrive';
      if (change === 'bundle') f.app.bundleIdentifier = 'owner.app';
      if (change === 'pid') f.app.processIdentifier = 43;
      return true;
    } },
    forceTerminate: { get: () => assert.fail('Office with a window must not be forced') },
  });
  native.AXIsProcessTrusted = () => true;
  native.NSRunningApplication = { runningApplicationWithProcessIdentifier: pid => { assert.equal(pid, 42); return f.app; } };
  native.AXUIElementCreateApplication = pid => { assert.equal(pid, 42); return f.app; };
  native.AXUIElementSetMessagingTimeout = () => {};
  native.NSFileHandle = { fileHandleWithStandardOutput: { writeData: line => f.events.push(JSON.parse(line)) } };
  f.sandbox.$ = Object.assign(value => typeof value === 'string' && value.startsWith('{') ? { dataUsingEncoding: () => value } : value, native);
  f.sandbox.Date = { now: () => time };
  f.sandbox.waitForLaunch = seconds => { time += seconds * 1000; };
  f.sandbox.windowlessProcess = () => ({ none: false });
  return { ...f, time: () => time, run: () => f.sandbox.run([JSON.stringify({ bundle, mode: 'quit', pid: 42,
    processStartedAtMs: 5000, fixture: f.request })]) };
}

for (const bundle of ['com.microsoft.Word', 'com.microsoft.Excel']) for (const label of ["Don't Save", 'Don’t Save']) {
  test(`${bundle} quit answers only its owned ${label} sheet and waits for isTerminated`, () => {
    const f = quittingOffice({ bundle, label });
    assert.equal(f.run(), true);
    assert.deepEqual(f.presses, [f.button]);
    assert.equal(f.events.find(e => e.stage === 'fixture-sheet').fixtureSheet.pressed, label);
    assert.equal(f.time(), 600, 'an accepted quit and an AX press are not exit proof');
    assert.equal(f.events.at(-1).quitWait.reason, 'exited');
  });
}

test('Office quit binds the setup number despite a persistently unsupported title and presses once', () => {
  const f = quittingOffice({ unsupportedTitle: true, where: 'focused sheet' });
  assert.equal(f.run(), true);
  assert.deepEqual(f.presses, [f.button]);
  assert.equal(f.events.at(-1).quitWait.reason, 'exited');
});

test('Office quit with unsupported title never answers another window\'s sheet', () => {
  const f = quittingOffice({ unsupportedTitle: true, where: 'focused sheet', change: 'sheet' });
  assert.throws(f.run, /quit unconfirmed|sheet/);
  assert.deepEqual(f.presses, []);
});

for (const receipt of [null, { target: '/run/Report-nonce.docx', windowNumber: 999 }, { target: '/owner/report.docx', windowNumber: 100 }]) {
  test(`Office quit refuses unsupported title without the matching setup CG receipt ${JSON.stringify(receipt)}`, () => {
    const f = quittingOffice({ unsupportedTitle: true, where: 'focused sheet' });
    f.request.fixtureWindow = receipt;
    assert.throws(f.run, /quit unconfirmed/);
    assert.deepEqual(f.presses, []);
  });
}

for (const change of ['path', 'sheet', 'button', 'sign-in', 'bundle', 'pid', 'start']) {
  test(`Office quit refuses changed ${change} identity`, () => {
    const f = quittingOffice({ change, where: change === 'sheet' ? 'focused sheet' : 'children' });
    assert.throws(f.run, /identity changed|start time changed|sheet|quit unconfirmed/);
    assert.deepEqual(f.presses, []);
  });
}

test('Office quit never answers an app-wide alert even when it names the fixture', () => {
  const f = quittingOffice({ where: 'alert' });
  assert.throws(f.run, /sheet/);
  assert.deepEqual(f.presses, []);
});

test('Office quit cannot report exit merely because its save sheet was pressed', () => {
  const f = quittingOffice({ terminateAt: Infinity });
  // Keep the no-window force fallback unavailable in this fake.
  f.sandbox.windowlessProcess = () => ({ none: false });
  assert.throws(f.run, /quit unconfirmed after thirty seconds/);
  assert.deepEqual(f.presses, [f.button]);
});

test('the native window count reads AXWindows and on-screen layer-zero windows of only that pid', () => {
  const sandbox = source(), calls = [];
  let axWindows = [], cg = [{ kCGWindowOwnerPID: 43, kCGWindowLayer: 0 }, { kCGWindowOwnerPID: 42, kCGWindowLayer: 25 }];
  const native = value => value;
  Object.assign(native, {
    kCGWindowListOptionOnScreenOnly: 1, kCGNullWindowID: 0,
    AXUIElementCreateApplication: pid => ({ pid }), AXUIElementSetMessagingTimeout() {},
    AXUIElementCopyAttributeValue: (app, attribute, output) => {
      calls.push([app.pid, attribute]);
      if (!axWindows) return -25204;
      output[0] = { count: axWindows.length }; return 0;
    },
    CGWindowListCopyWindowInfo: options => { assert.equal(options, 1, 'on-screen windows only'); return cg; },
  });
  sandbox.$ = native; sandbox.Ref = () => []; sandbox.ObjC.castRefToObject = value => value;
  assert.equal(sandbox.windowlessProcess(42).none, true);
  cg.push({ kCGWindowOwnerPID: 42, kCGWindowLayer: 0 });
  assert.equal(sandbox.windowlessProcess(42).none, false, 'an on-screen sheet or window');
  cg.pop(); axWindows = [{}];
  assert.equal(sandbox.windowlessProcess(42).none, false, 'a listed window');
  axWindows = null;
  assert.equal(sandbox.windowlessProcess(42).none, false, 'an unreadable list');
  assert.ok(calls.every(([pid, attribute]) => pid === 42 && attribute === 'AXWindows'));
});

// The parent side: the helper's close receipt and press event, then a quit the helper force-terminated by the exact pid.
function wordLease(t, { close, quit, exited = async () => true, fixtureWindow }) {
  const dir = mkdtempSync(join(tmpdir(), 'save-sheet-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir: join(dir, 'fixture'), nonce: 'nonce' }, quits = [], recoveries = [];
  const options = {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {}, exited,
    run: async (_command, args, runOptions) => {
      const request = JSON.parse(args.at(-1));
      if (request.mode === 'quit') { quits.push(request); return quit; }
      if (request.mode === 'recover') {
        recoveries.push(request);
        return { groupClean: true, exit: { code: 1 }, stdout: '', stderr: 'Application dialog present; fixture recovery refused' };
      }
      runOptions.onStdout('{"stage":"armed","running":false,"pid":42,"processStartedAtMs":5000}\n' +
        JSON.stringify({ stage: 'ready', bundle: 'com.microsoft.Word', fixtureWindow }) + '\n');
      return new Promise(resolve => {
        const poll = setInterval(() => {
          try { if (JSON.parse(readFileSync(request.control, 'utf8')).command !== 'close') return; } catch { return; }
          clearInterval(poll);
          runOptions.onStdout(close.events);
          resolve(close.result);
        }, 5);
        runOptions.signal.addEventListener('abort', () => { clearInterval(poll); resolve({ groupClean: true, exit: { code: 0 }, stdout: '' }); }, { once: true });
      });
    },
  };
  const task = {
    setup: async c => { c.word = await openFixture(c, { app: 'Microsoft Word', bundle: 'com.microsoft.Word', mode: 'document',
      target: join(c.dir, 'Report-nonce.docx'), token: 'Report-nonce.docx', stopOnAppDialog: true }, options); },
    prompt: () => 'edit', check: () => 'the report was not saved', cleanup: closeFixtures,
  };
  return { ctx, task, quits, recoveries };
}

const sheetEvent = '{"stage":"fixture-sheet","fixtureSheet":{"pressed":"Don’t Save","source":"focused sheet","windowTitle":"Report-nonce  -  Compatibility Mode","buttons":["Don’t Save","Cancel","Save"]}}\n';
const forcedQuit = { groupClean: true, exit: { code: 0 },
  stdout: '{"stage":"quit","quitWait":{"reason":"force-terminated-windowless","accepted":true,"elapsedMs":10000,"windowless":{"none":true,"axWindows":0,"onScreen":0}}}\n' };

test('an answered fixture sheet is a clean cleanup and the pass continues on the task verdict', async t => {
  const { ctx, task, quits } = wordLease(t, { close: { events: sheetEvent, result: { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' } }, quit: forcedQuit });
  const result = await executeRealTask(task, ctx, { lockHeld: true, drive: async () => ({ code: 0, out: { result: '' } }) });
  assert.equal(result.cleanupError, undefined);
  assert.equal(result.passed, false, 'the task failed on its own merits');
  assert.equal(result.reason, 'the report was not saved');
  const [diagnostics] = result.fixtureDiagnostics;
  assert.equal(diagnostics.fixtureSheets[0].pressed, 'Don’t Save');
  assert.equal(diagnostics.quitWait.reason, 'force-terminated-windowless');
  assert.equal(diagnostics.appQuit, true);
  assert.equal(quits[0].pid, 42);
  assert.equal(quits[0].processStartedAtMs, 5000, 'the helper checks the launch time before any force');
  assert.deepEqual(quits[0].fixture, { mode: 'document', target: join(ctx.dir, 'Report-nonce.docx'), token: 'Report-nonce.docx', runToken: 'nonce' });
});

test('the parent keeps quit-time sheet receipts with the launched process identity', async t => {
  const { ctx, task } = wordLease(t, { close: { events: '', result: { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' } },
    quit: { ...forcedQuit, stdout: sheetEvent + forcedQuit.stdout } });
  const result = await executeRealTask(task, ctx, { lockHeld: true, drive: async () => ({ code: 0, out: { result: '' } }) });
  assert.equal(result.cleanupError, undefined);
  assert.equal(result.fixtureDiagnostics[0].fixtureSheets[0].pressed, 'Don’t Save');
});

test('the parent carries the setup CG receipt to quit and recovery instead of inventing a cleanup identity', async t => {
  const fixtureWindow = { target: '/run/Report-nonce.docx', windowNumber: 100 };
  const { ctx, task, quits, recoveries } = wordLease(t, { fixtureWindow,
    close: { events: '', result: { groupClean: true, exit: { code: 1 }, stdout: '', stderr: 'unsupported title' } },
    quit: { groupClean: true, exit: { code: 1 }, stdout: '', stderr: 'quit unconfirmed' } });
  await executeRealTask(task, ctx, { lockHeld: true, drive: async () => ({ code: 0, groupClean: true, out: { result: '' } }) });
  assert.deepEqual(quits[0].fixture.fixtureWindow, fixtureWindow);
  assert.deepEqual(recoveries[0].fixtureWindows, [fixtureWindow]);
});

test('a forced Word exit the kernel does not confirm keeps the stop', async t => {
  const { ctx, task } = wordLease(t, { close: { events: sheetEvent, result: { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' } },
    quit: forcedQuit, exited: async () => false });
  const result = await executeRealTask(task, ctx, { lockHeld: true, drive: async () => ({ code: 0, out: { result: '' } }) });
  assert.match(result.cleanupError, /exit disagreement after quit/);
  assert.equal(result.fixtureDiagnostics[0].appQuit, undefined);
});

test('a foreign dialog still refuses cleanup and stops the pass', async t => {
  const refused = 'Error: Application dialog present; fixture cleanup refused (sign-in "Sign in" [Sign In])';
  const { ctx, task, quits } = wordLease(t, {
    close: { events: '', result: { groupClean: true, exit: { code: 1 }, stdout: '', stderr: refused } },
    quit: { groupClean: true, exit: { code: 1 }, stdout: '{"stage":"quit","quitWait":{"reason":"deadline"}}\n', stderr: 'Launched app quit unconfirmed after thirty seconds' },
  });
  const result = await executeRealTask(task, ctx, { lockHeld: true, drive: async () => ({ code: 0, groupClean: true, out: { result: '' } }) });
  assert.match(result.cleanupError, /^Owned Microsoft Word fixture window cleanup unconfirmed: .*fixture cleanup refused \(sign-in/);
  assert.equal(result.fixtureDiagnostics[0].fixtureSheets, undefined);
  assert.equal(result.fixtureDiagnostics[0].appQuit, false);
  assert.equal(cleanupContained(result), false);
  assert.match(result.cleanupError, /fixture recovery refused/);
  assert.equal(quits.length, 1);
});
