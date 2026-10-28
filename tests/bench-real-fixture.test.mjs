// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { runOwned } from '../bench/preapproved-process.mjs';
import { fileURLToPath } from 'node:url';
import { macCommandSkip } from './requirements.mjs';

function nativeSource() {
  const sandbox = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

function unsupportedRecovery({ foreignParent = false, listedSheet = false, extraCG = false, receiptNumber = 100 } = {}) {
  const sandbox = nativeSource(), presses = [], events = [];
  sandbox.ObjC.castRefToObject = value => value;
  sandbox.ObjC.deepUnwrap = value => value;
  let closed = false, exited = false, time = 0;
  const button = { AXRole: 'AXButton', AXTitle: "Don't Save" };
  const window = { AXRole: 'AXWindow', AXDocument: 'file:///run/Report-nonce.docx', AXWindowNumber: 100, AXChildren: [] };
  const sheet = { AXRole: 'AXSheet', AXParent: foreignParent ? {} : window, AXWindowNumber: 101,
    AXChildren: [button, { AXRole: 'AXButton', AXTitle: 'Save' }, { AXRole: 'AXButton', AXTitle: 'Cancel' }] };
  const app = { AXFocusedWindow: sheet };
  const process = { processIdentifier: 42, bundleIdentifier: 'com.microsoft.Word', isNil: () => false,
    isFinishedLaunching: true, launchDate: { isNil: () => false, timeIntervalSince1970: 5 },
    get isTerminated() { return exited; },
    get terminate() { assert.equal(closed, true); exited = true; return true; } };
  const native = value => value;
  native.CFEqual = (a, b) => a === b;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (element === window && attribute === 'AXTitle') return -25205;
    if (element === window && attribute === 'AXSheets') { output[0] = null; return 0; }
    let value = element[attribute] ?? null;
    if (element === app && attribute === 'AXWindows') value = closed ? [] : listedSheet ? [window, sheet] : [window];
    if (element === app && attribute === 'AXFocusedWindow' && closed) value = null;
    if (element === window && attribute === 'AXRole' && closed) value = '';
    output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
    return 0;
  };
  native.AXUIElementPerformAction = element => {
    assert.equal(element, button, 'an existing sheet needs no second close request');
    presses.push(element); closed = true; return 0;
  };
  native.AXUIElementCreateApplication = pid => { assert.equal(pid, 42); return app; };
  native.AXUIElementSetMessagingTimeout = () => {};
  native.AXUIElementGetPid = (_app, output) => { output[0] = 42; return 0; };
  native.NSRunningApplication = {
    runningApplicationsWithBundleIdentifier: () => ({ count: exited ? 0 : 1, objectAtIndex: () => process }),
    runningApplicationWithProcessIdentifier: () => process,
  };
  native.NSThread = { sleepForTimeInterval: seconds => { time += seconds * 1000; } };
  native.NSURL = {
    URLWithString: value => ({ isNil: () => false, isFileURL: true, URLByResolvingSymlinksInPath: { path: value.slice(7) } }),
    fileURLWithPath: value => ({ absoluteString: `file://${value}` }),
  };
  native.CGWindowListCopyWindowInfo = () => (closed ? [] : [100, 101, ...(extraCG ? [102] : [])])
    .map(kCGWindowNumber => ({ kCGWindowNumber, kCGWindowOwnerPID: 42, kCGWindowLayer: 0 }));
  sandbox.$ = native; sandbox.Ref = () => [];
  const clock = { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) };
  const api = sandbox.nativeAX({ cleanup: true, bundle: 'com.microsoft.Word' }, clock);
  const request = { fixtureMode: 'document', running: false, launched: true, startedAtMs: 4000, runToken: 'nonce',
    fixtureDir: '/run', bundle: 'com.microsoft.Word', pids: [42],
    fixtureWindows: [{ target: '/run/Report-nonce.docx', windowNumber: receiptNumber }] };
  return { presses, events, api, window, app, request, native,
    run: () => sandbox.recoverFixtureApplications(request, api, clock) };
}

for (const listedSheet of [false, true]) test(`recovery excludes the fixture's parented CG sheet with persistent AXTitle -25205 (AXWindows sheet=${listedSheet})`, () => {
  const f = unsupportedRecovery({ listedSheet });
  assert.deepEqual(Array.from(f.run().pids), [42]);
  assert.equal(f.presses.length, 1);
  assert.equal(f.events.filter(event => event.stage === 'fixture-sheet').length, 1);
  assert.equal(f.events.at(-1).quitWait.reason, 'exited');
});

for (const options of [{ foreignParent: true }, { extraCG: true }, { receiptNumber: 999 }]) {
  test(`recovery refuses foreign sheets or unmatched windows ${JSON.stringify(options)}`, () => {
    const f = unsupportedRecovery(options);
    assert.throws(f.run, /dialog present|Extra window|outside owned run/);
    assert.deepEqual(f.presses, []);
  });
}

test('setup CG identity maps AX bounds without a title and refuses ambiguous or foreign-pid bounds', () => {
  const f = unsupportedRecovery();
  delete f.window.AXWindowNumber;
  f.api.frame = () => ({ x: 10, y: 20, width: 400, height: 300 });
  let cg = [{ kCGWindowOwnerPID: 42, kCGWindowLayer: 0, kCGWindowNumber: 100,
    kCGWindowIsOnscreen: true, kCGWindowBounds: { X: 10, Y: 20, Width: 400, Height: 300 } }];
  f.native.CGWindowListCopyWindowInfo = () => cg;
  assert.equal(f.api.windowNumber(f.window, f.app), 100);
  cg.push({ ...cg[0], kCGWindowNumber: 102 });
  assert.equal(f.api.windowNumber(f.window, f.app), null);
  cg = [{ ...cg[0], kCGWindowOwnerPID: 43 }];
  assert.equal(f.api.windowNumber(f.window, f.app), null);
});

for (const evidence of ['app name', 'window reasons']) test(`created-window cleanup failures retain ${evidence}`, async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'web-cleanup-row-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, ownerAway: true }, done = Promise.withResolvers();
  const windows = [
    { index: 0, owned: true, stillListed: true, closeRefused: true, sheets: 1, dialogs: 1, reason: 'close-refused' },
    { index: 1, owned: false, stillListed: true, reason: 'additional-created-window' },
  ];
  const lease = await openFixture(ctx, { app: 'Example Browser', bundle: 'test.browser', mode: 'window' }, {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {},
    run: (_command, _args, options) => {
      options.onStdout('{"stage":"armed","running":true}\n{"stage":"ready"}\n');
      done.publish = options.onStdout;
      return done.promise;
    },
  });
  const verdict = assert.rejects(lease.close(), evidence === 'app name'
    ? /Owned Example Browser fixture window cleanup unconfirmed/ : /cleanup unconfirmed/);
  done.publish(JSON.stringify({ stage: 'window-cleanup', windows }) + '\n');
  done.resolve({ groupClean: true, exit: { code: 1 }, stdout: '', stderr: 'close refused' });
  await verdict;
  if (evidence === 'window reasons') {
    assert.deepEqual(ctx.fixtureDiagnostics[0].windows, windows);
    assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'unconfirmed');
  }
});

test('an unconfirmed created-window close never quits its app and other windows', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'web-cleanup-no-quit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, ownerAway: true }, done = Promise.withResolvers();
  let runs = 0;
  await openFixture(ctx, { app: 'Safari', bundle: 'com.apple.Safari', mode: 'window' }, {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {},
    run: (_command, _args, options) => {
      if (++runs > 1) return { groupClean: true, exit: { code: 0 }, stdout: '' };
      options.onStdout('{"stage":"launch","running":false,"pid":42}\n{"stage":"armed"}\n{"stage":"ready"}\n');
      return done.promise;
    },
  });
  const verdict = assert.rejects(closeFixtures(ctx), /cleanup unconfirmed/);
  done.resolve({ groupClean: true, exit: { code: 1 }, stdout: '', stderr: 'window still listed' });
  await verdict;
  await assert.rejects(ctx.windowLeases[0].quit({ final: true }), /cleanup unconfirmed/);
  assert.equal(runs, 1, 'app termination would close windows the helper did not create');
});

test('an unconfirmed created-window setup receipt cannot authorize app quit', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'web-cleanup-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, ownerAway: true };
  await assert.rejects(openFixture(ctx, { app: 'Safari', bundle: 'com.apple.Safari', mode: 'window' }, {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {},
    run: async (_command, _args, options) => {
      options.onStdout('{"stage":"launch","running":false,"pid":42}\n{"stage":"armed"}\n');
      return { groupClean: true, exit: { code: 1 }, stderr: 'setup refused',
        stdout: '{"stage":"setup-failure","cleanup":"unconfirmed"}\n' };
    },
  }), /setup failed/);
  await assert.rejects(ctx.windowLeases[0].close(), /cleanup unconfirmed/);
  await assert.rejects(ctx.windowLeases[0].quit(), /cleanup unconfirmed/);
  await assert.rejects(ctx.windowLeases[0].quit({ final: true }), /cleanup unconfirmed/);
});

test('the generic Chess fixture reaches the accessibility gate without acting', () => {
  const sandbox = nativeSource();
  sandbox.$ = { AXIsProcessTrusted: () => false };
  assert.throws(() => sandbox.run([JSON.stringify({ app: 'Chess', bundle: 'com.apple.Chess', mode: 'inherit', control: '/fixture/control' })]),
    /Accessibility is unavailable/);
});

test('cold Office readiness polls both startup AX errors until the fixture arrives after twelve seconds', () => {
  const { waitForOfficeFixture } = nativeSource();
  assert.equal(typeof waitForOfficeFixture, 'function');
  const state = { fresh: true, setup: true, actionTaken: false }, events = [];
  let time = 0, probes = 0;
  const ready = waitForOfficeFixture(() => {
    probes++;
    if (time < 12000) throw Object.assign(new Error('launching'), { code: time < 5000 ? -25204 : -25205, attribute: 'AXFocusedWindow' });
    return true;
  }, state, { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) });
  assert.equal(ready, true);
  assert.equal(probes, 121);
  assert.equal(time, 12000);
  assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1).launchWait)),
    { reason: 'ready', elapsedMs: 12000, code: -25205, attribute: 'AXFocusedWindow' });
  assert.equal(state.actionTaken, false);
});

test('cold Office readiness stops at thirty seconds with the last AX error and no fixture action', () => {
  const { waitForOfficeFixture } = nativeSource();
  const state = { fresh: true, setup: true, actionTaken: false }, events = [];
  let time = 0, lastProbeAt;
  assert.throws(() => waitForOfficeFixture(() => {
    lastProbeAt = time; time += 500;
    throw Object.assign(new Error('launching'), { code: -25205, attribute: 'AXFocusedWindow' });
  }, state, { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) }),
  /Office fixture readiness timed out.*-25205.*AXFocusedWindow/);
  assert.equal(time, 30000);
  assert.ok(lastProbeAt < 30000);
  assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1).launchWait)),
    { reason: 'deadline', elapsedMs: 30000, code: -25205, attribute: 'AXFocusedWindow' });
  assert.equal(state.actionTaken, false);
  assert.equal(state.officeWaiting, false);
});

test('cold Office readiness bounds missing windows and does not retry permission identity or cancellation errors', () => {
  const { waitForOfficeFixture } = nativeSource();
  let time = 0;
  const state = () => ({ fresh: true, setup: true, actionTaken: false });
  const clock = { now: () => time, wait: ms => { time += ms; }, emit() {} };
  assert.throws(() => waitForOfficeFixture(() => false, state(), clock), /timed out.*no AX error/);
  assert.equal(time, 30000);
  for (const error of [Object.assign(new Error('permission'), { code: -25211 }), new Error('Fixture process changed'), new Error('interrupted')]) {
    assert.throws(() => waitForOfficeFixture(() => { throw error; }, state(),
      { now: () => 0, wait: () => assert.fail('no retry'), emit() {} }), actual => actual === error);
  }
});

test('Office launch treats unsupported optional document attributes as absent without an attribute retry', () => {
  const sandbox = nativeSource(), state = { office: true, fresh: true, setup: true, officeWaiting: true, officeDeadline: 30000 };
  let time = 0, reads = 0;
  const native = value => value;
  native.AXUIElementCopyAttributeValue = () => { reads++; return -25205; };
  sandbox.$ = native; sandbox.Ref = () => [];
  const api = sandbox.nativeAX(state, { now: () => time, wait: () => assert.fail('no inner retry'), emit() {} });
  assert.equal(api.read({}, 'AXDocument'), null);
  assert.equal(api.read({}, 'AXSheets'), null);
  assert.throws(() => api.focused({}), error => error.code === -25205 && error.attribute === 'AXFocusedWindow');
  time = 30000;
  assert.throws(() => api.read({}, 'AXDocument'), /timed out/);
  assert.equal(reads, 3, 'no AX read starts after the deadline');
});

for (const fresh of [true, false]) test(`${fresh ? 'cold-launch' : 'already-running'} initial setup retries both AX errors within one thirty-second budget`, () => {
  const { setupRead } = nativeSource();
  assert.equal(typeof setupRead, 'function');
  const setupCase = fresh ? 'cold-launch' : 'already-running';
  const state = { fresh, setupCase, setup: true, retryWaitMs: 0 }, events = [];
  let time = 0, attempts = 0;
  const clock = { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) };
  const value = setupRead(() => {
    attempts++;
    if (attempts <= 2) throw Object.assign(new Error('starting'), { code: attempts === 1 ? -25204 : -25205, attribute: 'AXFocusedWindow' });
    return 'ready';
  }, state, clock);
  assert.equal(value, 'ready');
  assert.deepEqual(events.filter(e => e.stage === 'retry').map(e => e.code), [-25204, -25205]);
  assert.equal(state.retryWaitMs, 200);
  assert.ok(events.at(-1).readWait, 'the completed read must retain its startup case and last AX error');
  assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1).readWait)),
    { reason: 'ready', setupCase, elapsedMs: 200, code: -25205, attribute: 'AXFocusedWindow' });
  attempts = 0;
  assert.throws(() => setupRead(() => { attempts++; throw Object.assign(new Error('still starting'), { code: -25204 }); }, state, clock), /still starting/);
  assert.equal(time, 30000, 'all reads share one thirty-second startup budget');
  assert.equal(attempts, 298, 'no additional read begins after the deadline');
  assert.equal(events.at(-1).readWait.reason, 'deadline');
  assert.equal(events.at(-1).readWait.setupCase, setupCase);
});

test('retry elapsed time includes slow AX reads and stops before a read after thirty seconds', () => {
  const { setupRead } = nativeSource();
  const state = { fresh: true, setup: true, retryWaitMs: 0 }, events = [];
  let time = 0, lastReadAt = 0;
  assert.throws(() => setupRead(() => {
    lastReadAt = time; time += 500;
    throw Object.assign(new Error('slow AX'), { code: -25204 });
  }, state, { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) }), /slow AX/);
  assert.equal(time, 30500);
  assert.equal(state.retryWaitMs, 30000);
  assert.ok(lastReadAt < 30500);
  assert.ok(events.filter(e => e.stage === 'retry').every(e => e.totalWaitMs <= 30000));
  assert.ok(events.reduce((sum, e) => sum + (e.waitMs ?? 0), 0) < 6000);
});

test('reads outside setup or cleanup and acted-on setup never retry, and other setup errors stop immediately', () => {
  const { setupRead } = nativeSource();
  assert.equal(typeof setupRead, 'function');
  for (const state of [
    { fresh: false, setup: false }, { fresh: true, setup: false },
    { fresh: true, setup: true, fixtureExists: true, actionTaken: true },
    { fresh: false, setup: true, actionTaken: true },
  ]) {
    let attempts = 0;
    assert.throws(() => setupRead(() => { attempts++; throw Object.assign(new Error('refuse'), { code: -25204 }); }, state,
      { now: () => 0, wait: () => assert.fail('no backoff'), emit: () => assert.fail('no retry') }), /refuse/);
    assert.equal(attempts, 1);
  }
  for (const fresh of [true, false]) for (const code of [-25211, -25202]) {
    assert.throws(() => setupRead(() => { throw Object.assign(new Error('stop immediately'), { code }); },
      { fresh, setup: true }, { now: () => 0, wait: () => assert.fail('no backoff'), emit: () => assert.fail('no retry') }), /stop immediately/);
  }
});

function cleanupNative(readAttribute, state = {}) {
  const sandbox = nativeSource(), events = [];
  let time = 0;
  const native = value => value;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    const result = readAttribute(element, attribute, time, ms => { time += ms; });
    output[0] = result.value;
    return result.code || 0;
  };
  native.AXUIElementPerformAction = () => assert.fail('read retries must not perform an action');
  native.CFEqual = (a, b) => a === b;
  sandbox.$ = native; sandbox.Ref = () => []; sandbox.ObjC.castRefToObject = value => value;
  const clock = { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) };
  const contextState = { setup: false, cleanup: true, setupCase: 'already-running', ...state };
  return { sandbox, native, events, clock, state: contextState, time: () => time,
    api: sandbox.nativeAX(contextState, clock) };
}

test('cleanup AX reads recover after twelve seconds without reusing the setup deadline', () => {
  const focused = {};
  const fixture = cleanupNative((_element, attribute, time) => {
    assert.equal(attribute, 'AXFocusedWindow');
    return time < 12000 ? { code: -25204 } : { value: focused };
  }, { retryStarted: -30000 });
  assert.equal(fixture.api.focused({}), focused);
  assert.equal(fixture.time(), 12000);
  const retries = fixture.events.filter(event => event.stage === 'retry');
  assert.equal(retries.length, 120);
  assert.ok(retries.every(event => event.phase === 'cleanup' && event.code === -25204));
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.events.at(-1).cleanupReadWait)),
    { reason: 'ready', setupCase: 'already-running', elapsedMs: 12000, code: -25204, attribute: 'AXFocusedWindow' });
});

test('cleanup AX reads share one fifteen-second deadline across attributes', () => {
  let reads = 0, lastReadAt;
  const fixture = cleanupNative((_element, attribute, time) => {
    reads++; lastReadAt = time;
    return attribute === 'AXRole' && time >= 10000 ? { value: 'AXWindow' } : { code: -25204 };
  });
  assert.equal(fixture.api.text({}, 'AXRole'), 'AXWindow');
  assert.throws(() => fixture.api.focused({}), error => error.code === -25204 && error.attribute === 'AXFocusedWindow');
  assert.equal(fixture.time(), 15000);
  assert.ok(lastReadAt < 15000);
  assert.equal(fixture.events.at(-1).cleanupReadWait.reason, 'deadline');
  assert.equal(fixture.events.at(-1).cleanupReadWait.elapsedMs, 15000);
  const readsAtDeadline = reads;
  assert.throws(() => fixture.api.focused({}), error => error.code === -25204);
  assert.equal(reads, readsAtDeadline, 'no later AX read begins after cleanup used its wait budget');
});

test('cleanup deadline accounts for slow AX reads', () => {
  let lastReadAt;
  const fixture = cleanupNative((_element, _attribute, time, advance) => {
    lastReadAt = time; advance(500); return { code: -25204 };
  });
  assert.throws(() => fixture.api.focused({}), error => error.code === -25204);
  assert.equal(fixture.time(), 15500, 'the budget starts at the first error and includes later slow reads');
  assert.ok(lastReadAt < 15500);
  assert.equal(fixture.events.at(-1).cleanupReadWait.elapsedMs, 15000);
});

test('a close request during an observation wait carries its spent budget into cleanup', () => {
  const fixture = cleanupNative(() => ({ code: -25204 }), { cleanup: false, observation: {} });
  fixture.clock.cleanupRequested = () => fixture.time() >= 14000;
  assert.throws(() => fixture.api.focused({}), error => error.code === -25204);
  assert.equal(fixture.time(), 15000);
  assert.equal(fixture.events.at(-1).cleanupReadWait.elapsedMs, 15000);
});

test('a close request during a successful observation read preserves the original deadline', () => {
  let closeRequested = false, recovered = false;
  const focused = {};
  const fixture = cleanupNative((_element, _attribute, time, advance) => {
    if (!recovered && time === 100) {
      advance(500); closeRequested = true; recovered = true; return { value: focused };
    }
    return { code: -25204 };
  }, { cleanup: false, observation: {} });
  fixture.clock.cleanupRequested = () => closeRequested;
  assert.equal(fixture.api.focused({}), focused);
  // End the complete observation as the ready loop does, then enter cleanup.
  fixture.state.observation = null; fixture.state.cleanup = true;
  assert.throws(() => fixture.api.focused({}), error => error.code === -25204);
  assert.equal(fixture.time(), 15000, 'a successful read must not discard the preceding wait');
  assert.equal(fixture.events.at(-1).cleanupReadWait.elapsedMs, 15000);
});

test('cleanup stops immediately on other AX errors and retains a terminating hard error after a retry', () => {
  for (const code of [-25211, -25202, -25200]) {
    const fixture = cleanupNative(() => ({ code }));
    assert.throws(() => fixture.api.focused({}), error => error.code === code);
    assert.equal(fixture.time(), 0);
    assert.equal(fixture.events.length, 0);
  }
  const fixture = cleanupNative((_element, _attribute, time) => ({ code: time ? -25211 : -25204 }));
  assert.throws(() => fixture.api.focused({}), error => error.code === -25211);
  assert.equal(fixture.time(), 100);
  assert.equal(fixture.events.at(-1).cleanupReadWait.reason, 'error');
  assert.equal(fixture.events.at(-1).cleanupReadWait.code, -25211);
});

test('cleanup retries transient AXTitle -25205 with a short pump and a three-second bound', () => {
  for (const recoverAt of [200, 2900, Infinity]) {
    const fixture = cleanupNative((_element, attribute, time) => {
      assert.equal(attribute, 'AXTitle');
      return time < recoverAt ? { code: -25205 } : { value: 'Memo nonce' };
    });
    if (Number.isFinite(recoverAt)) assert.equal(fixture.api.text({}, 'AXTitle'), 'Memo nonce');
    else assert.throws(() => fixture.api.text({}, 'AXTitle'), error => error.code === -25205);
    assert.equal(fixture.time(), Math.min(recoverAt, 3000));
    assert.ok(fixture.events.filter(e => e.stage === 'retry').every(e => e.waitMs <= 100));
  }
});

test('a retried title cannot authorize a close after the fixture identity changed', () => {
  const window = {}, actions = [];
  const fixture = cleanupNative((_element, attribute, time) => {
    if (attribute === 'AXTitle') return time < 200 ? { code: -25205 } : { value: 'Owner document' };
    return { value: attribute === 'AXRole' ? 'AXWindow' : null };
  });
  fixture.native.AXUIElementPerformAction = () => { actions.push('press'); return 0; };
  assert.throws(() => fixture.sandbox.closeOwnedWindow(window, { mode: 'document', token: 'nonce' }, {}, fixture.api), /identity changed/);
  assert.deepEqual(actions, []);
});

test('cleanup preserves absent optional attributes without retries and never retries a press', () => {
  const fixture = cleanupNative(() => ({ code: -25205 }));
  assert.equal(fixture.api.read({}, 'AXSheets'), null);
  let presses = 0;
  fixture.native.AXUIElementPerformAction = () => { presses++; return -25204; };
  assert.throws(() => fixture.api.press({}), /AX fixture press failed: -25204/);
  assert.equal(presses, 1);
  assert.equal(fixture.time(), 0);
  assert.equal(fixture.events.length, 0);
});

test('cleanup revalidates recovered focus before closing the retained document', () => {
  for (const focusChanged of [false, true]) {
    const owned = {}, other = {}, actions = [];
    let exists = true;
    const fixture = cleanupNative((element, attribute, time) => {
      if (attribute === 'AXFocusedWindow') return time < 12000 ? { code: -25204 } : { value: focusChanged ? other : owned };
      if (element === other && attribute === 'AXTitle') return { value: 'Notes' };
      if (attribute === 'AXFocusedUIElement') return { code: -25212 }; // the closed-window sheet scan
      assert.equal(element, owned);
      return { value: attribute === 'AXRole' ? exists ? 'AXWindow' : '' : attribute === 'AXTitle' ? 'Report nonce' : null };
    });
    fixture.native.AXUIElementPerformAction = () => { actions.push('close'); exists = false; return 0; };
    const api = { ...fixture.api, wait() {}, closeDocument: (_app, validate) => { validate(); fixture.api.press({}); } };
    const close = () => fixture.sandbox.closeOwnedWindow(owned, { mode: 'document', token: 'nonce' }, {}, api);
    if (focusChanged) {
      assert.throws(close, /lost focus/);
      assert.deepEqual(actions, []);
    } else {
      close();
      assert.deepEqual(actions, ['close']);
    }
    assert.equal(fixture.time(), 12000);
  }
});

test('cleanup treats a window with an unsupported title as closed only when the app no longer lists it', () => {
  const list = items => ({ count: items.length, objectAtIndex: index => items[index] });
  for (const [listing, expect] of [['absent', 'closed'], ['listed', 'stop'], ['unreadable', 'stop']]) {
    const owned = {}, other = {}, app = {}, actions = [];
    const fixture = cleanupNative((element, attribute) => {
      if (element === app && attribute === 'AXWindows') return listing === 'unreadable' ? { code: -25204 } : { value: list(listing === 'listed' ? [other, owned] : [other]) };
      return attribute === 'AXRole' ? { value: 'AXWindow' } : { code: -25205 };
    });
    fixture.native.AXUIElementPerformAction = () => { actions.push('close'); return 0; };
    const api = { ...fixture.api, wait() {} };
    const close = () => fixture.sandbox.closeOwnedWindow(owned, { mode: 'document', token: 'nonce' }, app, api);
    if (expect === 'closed') close(); else assert.throws(close, /AX fixture read failed|unconfirmed|-25204/);
    assert.deepEqual(actions, [], listing);
  }
});

test('cleanup repeats document identity checks when final focus validation waited', () => {
  const owned = {}, actions = [];
  let focusReads = 0;
  const fixture = cleanupNative((_element, attribute, time) => {
    if (attribute === 'AXFocusedWindow') {
      focusReads++;
      return focusReads > 1 && time < 12000 ? { code: -25204 } : { value: owned };
    }
    return { value: attribute === 'AXRole' ? 'AXWindow' : attribute === 'AXTitle' ? time < 12000 ? 'Report nonce' : 'Unrelated document' : null };
  });
  fixture.native.AXUIElementPerformAction = () => { actions.push('close'); return 0; };
  const api = { ...fixture.api, wait() {}, closeDocument: (_app, validate) => { validate(); fixture.api.press({}); } };
  assert.throws(() => fixture.sandbox.closeOwnedWindow(owned, { mode: 'document', token: 'nonce' }, {}, api), /identity changed/);
  assert.equal(fixture.time(), 12000);
  assert.deepEqual(actions, []);
});

test('cleanup revalidates identity after waiting for close or discard buttons', () => {
  for (const discard of [false, true]) {
    const owned = {}, sheet = {}, button = {}, actions = [];
    const array = values => ({ count: values.length, objectAtIndex: index => values[index] });
    const fixture = cleanupNative((element, attribute, time) => {
      if ((discard && attribute === 'AXSheets') || (!discard && attribute === 'AXCloseButton')) {
        return time < 12000 ? { code: -25204 } : { value: discard ? array([sheet]) : button };
      }
      if (attribute === 'AXFocusedWindow') return { value: owned };
      if (element === owned) return { value: attribute === 'AXRole' ? 'AXWindow' : attribute === 'AXTitle' ? time < 12000 ? 'Report nonce' : 'Unrelated document' : null };
      if (element === sheet) return { value: attribute === 'AXChildren' ? array([button]) : null };
      assert.equal(element, button);
      return { value: attribute === 'AXRole' ? 'AXButton' : attribute === 'AXTitle' ? "Don't Save" : null };
    });
    fixture.native.AXUIElementPerformAction = () => { actions.push('press'); return 0; };
    const api = { ...fixture.api, wait() {}, closeDocument() {} };
    assert.throws(() => fixture.sandbox.closeOwnedWindow(owned, { mode: discard ? 'document' : 'window', token: 'nonce' }, {}, api), /identity changed/);
    assert.equal(fixture.time(), 12000);
    assert.deepEqual(actions, []);
  }
});

test('ready dialog reads survive pre-close and in-flight close failures without losing the retained fixture', () => {
  for (const [inFlight, closeAt] of [[false, 12000], [true, 12000], [false, 40000]]) {
    const sandbox = nativeSource(), events = [], actions = [], window = { AXRole: 'AXWindow', AXTitle: 'Report nonce' }, button = {};
    const app = { AXFocusedWindow: window, AXMainWindow: window };
    const target = { processIdentifier: 42 };
    let time = 0, ready = false, closed = false, closeRequested = false;
    const native = value => typeof value === 'string' && value.startsWith('{') ? { dataUsingEncoding: () => value } : value;
    native.AXIsProcessTrusted = () => true;
    native.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => target }) };
    native.AXUIElementCreateApplication = () => app;
    native.AXUIElementSetMessagingTimeout = () => {};
    native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
      if (ready && attribute === 'AXFocusedWindow' && (time < 12000 || (closeAt === 40000 && time >= 30000 && time < 32000))) {
        if (inFlight) { closeRequested = true; time += 500; }
        return -25204;
      }
      if (element === window && closed) return -25202;
      output[0] = attribute === 'AXCloseButton' ? button : element[attribute];
      return 0;
    };
    native.AXUIElementPerformAction = (element) => { assert.equal(element, button); actions.push('close'); closed = true; return 0; };
    native.CFEqual = (a, b) => a === b;
    native.NSFileHandle = { fileHandleWithStandardOutput: { writeData: line => {
      const event = JSON.parse(line); events.push(event); if (event.stage === 'ready') ready = true;
    } } };
    native.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
    native.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({ command: closeRequested || time >= closeAt ? 'close' : 'opened' }) } };
    native.NSThread = { sleepForTimeInterval: seconds => { time += seconds * 1000; } };
    sandbox.$ = native; sandbox.Ref = () => []; sandbox.ObjC.castRefToObject = value => value; sandbox.Date = { now: () => time };
    sandbox.waitForLaunch = seconds => { time += (seconds ?? 0.1) * 1000; };
    sandbox.run([JSON.stringify({ app: 'Microsoft Excel', bundle: 'com.microsoft.Excel', mode: 'window', control: 'fake',
      token: 'nonce', target: 'nonce', stopOnAppDialog: true })]);
    assert.deepEqual(actions, ['close']);
    assert.equal(events.at(-1).stage, 'closed');
    assert.equal(events.some(event => event.phase === 'cleanup' || event.phase === 'observation'), true);
    assert.ok(time >= closeAt && time < closeAt + 4000);
    if (closeAt === 40000) {
      assert.equal(events.filter(event => event.observationReadWait).at(-1).observationReadWait.elapsedMs, 2000,
        'a complete successful observation resets its episode before a later busy period');
    }
  }
});

test('parent cleanup retains retry receipts and allows the helper to finish beyond fifteen seconds', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-cleanup-read-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = { dir, stopOnAppDialog: true }, done = Promise.withResolvers();
  let publish;
  const lease = await openFixture(ctx, { app: 'Microsoft Excel', bundle: 'com.microsoft.Excel', mode: 'document' }, {
    run: (_command, _args, options) => {
      assert.equal(JSON.parse(_args.at(-1)).stopOnAppDialog, true, 'a guarded pass enables native app observation centrally');
      publish = options.onStdout;
      publish('{"stage":"armed","running":true,"pid":42}\n{"stage":"ready","setupCase":"already-running"}\n');
      return done.promise;
    }, open: async () => {},
  });
  const closed = lease.close();
  const verdict = closed.then(() => null, error => error);
  t.mock.timers.tick(16000);
  const cleanupReadWait = { reason: 'ready', setupCase: 'already-running', elapsedMs: 14900,
    code: -25204, attribute: 'AXFocusedWindow' };
  publish(JSON.stringify({ stage: 'retry', phase: 'cleanup', code: -25204, waitMs: 100, totalWaitMs: 14900, setupCase: 'already-running' }) + '\n');
  publish(JSON.stringify({ stage: 'cleanup-read-wait', cleanupReadWait }) + '\n');
  done.resolve({ groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' });
  assert.equal(await verdict, null);
  assert.deepEqual(ctx.fixtureDiagnostics[0].cleanupReadWait, cleanupReadWait);
  assert.equal(ctx.fixtureDiagnostics[0].cleanupRetries.length, 1);
  assert.equal(ctx.fixtureDiagnostics[0].cleanupTotalWaitMs, 14900);
  assert.deepEqual(ctx.fixtureDiagnostics[0].retries, [], 'setup retry records remain separate');
});

test('already-running Office readiness shares the initial-read deadline and reports its case', () => {
  const { setupRead, waitForOfficeFixture } = nativeSource(), events = [];
  const state = { fresh: false, setup: true, setupCase: 'already-running', actionTaken: false };
  let time = 0;
  const clock = { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) };
  assert.equal(setupRead(() => {
    if (time < 12000) throw Object.assign(new Error('slow running app'), { code: -25204, attribute: 'AXFocusedWindow' });
    return true;
  }, state, clock), true);
  assert.throws(() => waitForOfficeFixture(() => {
    throw Object.assign(new Error('not ready'), { code: -25205, attribute: 'AXFocusedWindow' });
  }, state, clock), /timed out.*-25205.*AXFocusedWindow/);
  assert.equal(time, 30000, 'readiness must not renew the first AX read budget');
  assert.equal(events.at(-1).launchWait.setupCase, 'already-running');
  assert.equal(events.at(-1).launchWait.elapsedMs, 30000);
  assert.equal(state.actionTaken, false);
});

test('Office final identity validation cannot start another budget after late window readiness', () => {
  const { setupRead, waitForOfficeFixture } = nativeSource(), events = [];
  const state = { fresh: true, office: true, setup: true, setupCase: 'cold-launch', actionTaken: false };
  let time = 0;
  const clock = { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) };
  assert.equal(waitForOfficeFixture(() => {
    if (time < 29000) throw Object.assign(new Error('starting'), { code: -25204, attribute: 'AXFocusedWindow' });
    return true;
  }, state, clock), true);
  assert.throws(() => setupRead(() => {
    throw Object.assign(new Error('identity read not ready'), { code: -25205, attribute: 'AXTitle' });
  }, state, clock), /identity read not ready/);
  assert.equal(time, 30000, 'the final identity read has only the remainder of the original deadline');
  assert.equal(events.at(-1).readWait.reason, 'deadline');
  assert.equal(events.at(-1).readWait.code, -25205);
});

test('a hard AX error after a setup retry is recorded as the error that ended the read wait', () => {
  const { setupRead } = nativeSource(), events = [];
  const state = { fresh: false, setup: true, setupCase: 'already-running' };
  let time = 0;
  assert.throws(() => setupRead(() => {
    throw Object.assign(new Error('AX read'), { code: time ? -25211 : -25204, attribute: 'AXFocusedWindow' });
  }, state, { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) }), error => error.code === -25211);
  assert.equal(time, 100);
  assert.equal(events.at(-1).readWait.reason, 'error');
  assert.equal(events.at(-1).readWait.code, -25211);
});

for (const fresh of [true, false]) test(`native first AX read waits for ${fresh ? 'a cold launch' : 'an already-running app'}`, () => {
  const sandbox = nativeSource(), setupCase = fresh ? 'cold-launch' : 'already-running';
  const state = { fresh, office: true, setup: true, setupCase, actionTaken: false }, owned = {};
  let time = 0, reads = 0;
  const native = value => value;
  native.AXUIElementCopyAttributeValue = (_element, attribute, output) => {
    assert.equal(attribute, 'AXFocusedWindow'); reads++;
    if (time < 12000) return time < 5000 ? -25204 : -25205;
    output[0] = owned; return 0;
  };
  native.AXUIElementPerformAction = () => assert.fail('waiting is read-only');
  sandbox.$ = native; sandbox.Ref = () => []; sandbox.ObjC.castRefToObject = value => value;
  const api = sandbox.nativeAX(state, { now: () => time, wait: ms => { time += ms; }, emit() {} });
  assert.equal(api.focused({}), owned);
  assert.equal(reads, 121);
  assert.equal(time, 12000);
  assert.equal(state.readWait.setupCase, setupCase);
  assert.equal(state.readWait.code, -25205);
  assert.equal(state.actionTaken, false);
});

test('a pre-existing Word setup failure retains the read deadline receipt and never quits that app', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-existing-word-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir }, readWait = { reason: 'deadline', setupCase: 'already-running', elapsedMs: 30000,
    code: -25204, attribute: 'AXFocusedWindow' };
  await assert.rejects(openFixture(ctx, { app: 'Microsoft Word', bundle: 'com.microsoft.Word', mode: 'document' }, {
    run: async (_command, args, options) => {
      assert.notEqual(JSON.parse(args.at(-1)).mode, 'quit', 'the old Word process is not this lease\'s to quit');
      const stdout = JSON.stringify({ stage: 'setup-failure', running: true, pid: 42, setupCase: 'already-running',
        readWait, cleanup: 'unconfirmed', actionTaken: false }) + '\n';
      options.onStdout(stdout);
      return { stdout, groupClean: true, exit: { code: 1 }, stderr: 'read deadline reached' };
    }, open: async () => assert.fail('unresponsive existing app must not be given a new fixture'),
  }), /read deadline reached/);
  await closeFixtures(ctx);
  assert.deepEqual(ctx.fixtureDiagnostics[0].readWait, readWait);
  assert.equal(ctx.fixtureDiagnostics[0].setupCase, 'already-running');
  assert.equal(ctx.fixtureDiagnostics[0].running, true);
  assert.equal(ctx.fixtureDiagnostics[0].appQuit, undefined);
});

test('failed setup recovery closes only a retained reference, never a title match', () => {
  const { recoverSetup } = nativeSource();
  assert.equal(typeof recoverSetup, 'function');
  const owned = {}, actions = [];
  const request = { fixtureTitle: 'Form abc', mode: 'window' };
  let exists = true;
  const api = {
    windows: () => assert.fail('never inventory windows for recovery'),
    text: () => assert.fail('a matching title never grants ownership'),
    matches: () => true,
    exists: window => { assert.equal(window, owned); return exists; },
    closeButton: window => { assert.equal(window, owned); actions.push('close'); exists = false; },
    wait() {},
  };
  assert.equal(recoverSetup(owned, request, api), 'closed retained fixture');
  assert.deepEqual(actions, ['close']);
  assert.equal(recoverSetup(undefined, request, api), 'unconfirmed');
  assert.deepEqual(actions, ['close']);
});

test('setup recovery preserves a retained Safari window whose identity does not match', () => {
  const { recoverSetup } = nativeSource();
  const owned = {}, request = { bundle: 'com.apple.Safari', mode: 'window', target: 'http://127.0.0.1/nonce/' };
  const api = {
    exists: window => { assert.equal(window, owned); return true; },
    matches: (window, expected, retained) => {
      assert.equal(window, owned); assert.equal(expected, request); assert.equal(retained, true); return false;
    },
    closeButton: () => assert.fail('never close another focused Safari window'),
  };
  assert.equal(recoverSetup(owned, request, api), 'unconfirmed');
});

test('setup failure diagnostics confirm nothing-created cleanup and retain every retry', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-startup-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir };
  await assert.rejects(openFixture(ctx, { app: 'Preview', bundle: 'com.apple.Preview', mode: 'document' }, {
    run: async (_command, _args, options) => {
      const events = [{ stage: 'retry', code: -25204, waitMs: 100, totalWaitMs: 100 },
        { stage: 'setup-failure', cleanup: 'nothing created', actionTaken: false, totalWaitMs: 100 }];
      const stdout = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      options.onStdout(stdout);
      return { exit: { code: 1 }, stdout, stderr: 'not ready', groupClean: true };
    }, open: async () => assert.fail('no launch'),
  }), error => error.noMutation === true);
  await closeFixtures(ctx);
  assert.equal(ctx.fixtureDiagnostics[0].retries.length, 1);
  assert.equal(ctx.fixtureDiagnostics[0].totalWaitMs, 100);
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'nothing created');
});

test('a launch exception waits for recovery before clearing the pending acquisition', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const { acquireFixture } = await import('../bench/real-run.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-launch-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir };
  await assert.rejects(acquireFixture(ctx, 'preview', () => openFixture(ctx,
    { app: 'Preview', bundle: 'com.apple.Preview', mode: 'document' }, {
      run: async (_command, _args, options) => {
        options.onStdout('{"stage":"armed"}\n');
        await new Promise(resolve => {
          const timer = setInterval(() => {
            try { if (JSON.parse(readFileSync(join(dir, 'window-0-control.json'), 'utf8')).command === 'close') {
              clearInterval(timer); resolve();
            } } catch {}
          }, 5);
        });
        const stdout = '{"stage":"setup-failure","cleanup":"nothing created","actionTaken":false,"totalWaitMs":0}\n';
        options.onStdout(stdout);
        return { exit: { code: 1 }, stdout, stderr: 'opening cancelled', groupClean: true };
      }, open: async () => { throw new Error('launch refused'); },
    })), /launch refused/);
  await closeFixtures(ctx);
  assert.equal(ctx.pendingAcquisitions.size, 0);
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'nothing created');
});

test('a failed Office launch keeps its startup and quit receipts and quits only its recorded PID', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-partial-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir }, quits = [];
  const launchWait = { reason: 'deadline', elapsedMs: 30000, code: -25205, attribute: 'AXFocusedWindow' };
  const quitWait = { reason: 'exited', accepted: true, elapsedMs: 12000, finishedLaunching: false };
  let finish;
  await assert.rejects(openFixture(ctx, { app: 'Microsoft Excel', bundle: 'com.microsoft.Excel', mode: 'document' }, {
    run: async (_command, args, options) => {
      const request = JSON.parse(args.at(-1));
      if (request.mode === 'quit') {
        assert.equal(options.timeoutMs, 35000, 'parent allows the full thirty-second normal quit');
        quits.push(request.pid);
        return { exit: { code: 0 }, groupClean: true, stdout: JSON.stringify({ stage: 'quit', quitWait }) + '\n' };
      }
      options.onStdout('{"stage":"armed","running":false}\n');
      return new Promise(resolve => { finish = () => {
        const stdout = JSON.stringify({ stage: 'setup-failure', cleanup: 'unconfirmed', pid: 42, launchWait }) + '\n';
        options.onStdout(stdout); resolve({ exit: { code: 1 }, stdout, groupClean: true });
      }; });
    },
    open: async () => { finish(); throw new Error('launch command failed after starting app'); },
  }), /launch command failed/);
  await closeFixtures(ctx);
  assert.deepEqual(quits, [42]);
  assert.deepEqual(ctx.fixtureDiagnostics[0].launchWait, launchWait);
  assert.deepEqual(ctx.fixtureDiagnostics[0].quitWait, quitWait);
});

test('inherit helpers never claim or close an application window during setup recovery', () => {
  const { recoverSetup } = nativeSource();
  assert.equal(recoverSetup(undefined, { mode: 'inherit' }, {
    windows: () => assert.fail('no task-owned window exists to inventory'),
    closeButton: () => assert.fail('inherited app windows stay open'),
  }), 'unconfirmed');
});

test('an inherited app that never launches fails setup before reporting readiness', () => {
  const events = [];
  const native = value => ({ dataUsingEncoding: () => value });
  Object.assign(native, {
    AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 0 }) },
    NSData: { dataWithContentsOfFile: () => ({ isNil: () => false }) },
    NSString: { alloc: { initWithDataEncoding: () => JSON.stringify({ command: 'opened' }) } },
    NSThread: { sleepForTimeInterval() {} },
    NSFileHandle: { fileHandleWithStandardOutput: { writeData: value => events.push(JSON.parse(value)) } },
  });
  const sandbox = { $: native, ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  assert.throws(() => sandbox.run([JSON.stringify({ bundle: 'com.apple.calculator', mode: 'inherit', control: '/fake/control' })]), /readiness/);
  assert.equal(events.some(e => e.stage === 'ready'), false);
  assert.equal(events.at(-1).cleanup, 'unconfirmed');
});

test('Helium opens a new window on its real profile and closes through its retained helper', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs').catch(() => ({}));
  assert.equal(typeof openFixture, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'real-fixture-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const actions = [];
  let finish;
  const ctx = { dir };
  const lease = await openFixture(ctx, { app: 'Helium', bundle: 'net.imput.helium', target: 'http://127.0.0.1:1234/abc/', token: 'abc', mode: 'window' }, {
    helper: async request => { assert.equal(request.bundle, 'net.imput.helium'); return { command: 'native-AX-helper', args: [] }; },
    run: async (_command, _args, options) => {
      options.onStdout(Buffer.from('{"stage":"armed","running":true}\n'));
      const done = new Promise(resolve => { finish = resolve; });
      const ready = setInterval(() => {
        try { if (JSON.parse(readFileSync(join(dir, 'window-0-control.json'), 'utf8')).command === 'opened') {
          clearInterval(ready); options.onStdout(Buffer.from('{"stage":"ready","pid":123}\n'));
        } } catch {}
      }, 5);
      return done;
    },
    open: async (command, args) => { assert.equal(command, '/usr/bin/open'); actions.push(args); },
  });
  assert.deepEqual(actions, [['-n', '-g', '-a', 'Helium', '--args', '--new-window', 'http://127.0.0.1:1234/abc/']]);
  const closed = lease.close();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(JSON.parse(readFileSync(join(dir, 'window-0-control.json'), 'utf8')).command, 'close');
  finish({ exit: { code: 0 }, stdout: '{"stage":"closed"}\n', groupClean: true });
  await closed;
});

test('a streamed helper dialog records the original process before aborting setup', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-fixture-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dialog = { app: 'Microsoft Word', category: 'activation' };
  const ctx = { dir, onAppDialog: value => assert.deepEqual(value, dialog) };
  await assert.rejects(openFixture(ctx, { app: 'Microsoft Word', bundle: 'com.microsoft.Word', mode: 'document' }, {
    helper: async () => ({ command: 'inert-helper', args: [] }),
    run: async (_command, _args, options) => {
      options.onStdout('{"stage":"identified","running":false,"pid":812}\n');
      options.onStdout(JSON.stringify({ stage: 'app-dialog', appDialog: dialog }) + '\n');
      return { exit: { code: 1 }, groupClean: true, stderr: 'application dialog',
        stdout: '{"stage":"setup-failure","cleanup":"unconfirmed"}\n' };
    },
    open: () => assert.fail('no document open before armed'),
  }), /application dialog/);
  assert.equal(ctx.windowLeases[0].pid, 812);
  assert.equal(ctx.windowLeases[0].running, false);
  assert.deepEqual(ctx.fixtureDiagnostics[0].appDialog, dialog);
});

test('AX cleanup closes the retained fixture without reading any other window', () => {
  const source = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  const sandbox = { ObjC: { import() {} } };
  runInNewContext(source, sandbox);
  const owned = {}, other = {}, actions = [];
  let exists = true;
  const api = {
    exists: window => { assert.equal(window, owned); return exists; },
    matches: window => { assert.equal(window, owned); return true; },
    closeButton: window => { assert.equal(window, owned); actions.push('close'); exists = false; },
    discard: window => assert.equal(window, owned),
    wait() {},
    focused: () => other,
  };
  sandbox.closeOwnedWindow(owned, { mode: 'window' }, {}, api);
  assert.deepEqual(actions, ['close']);
});

test('Safari records launch ownership before acquiring a new fixture window', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-safari-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const actions = [];
  let finish;
  const lease = await openFixture({ dir, ownerAway: true }, {
    app: 'Safari', bundle: 'com.apple.Safari', target: 'http://127.0.0.1/test', mode: 'window',
  }, {
    helper: async () => ({ command: 'native-browser-helper', args: [] }),
    open: async (command, args) => {
      assert.equal(command, '/usr/bin/open');
      actions.push(args);
    },
    run: async (_command, _args, options) => {
      assert.deepEqual(actions, [], 'running state must be observed before launching');
      options.onStdout('{"stage":"launch","running":false}\n');
      setTimeout(() => options.onStdout('{"stage":"armed","running":false}\n{"stage":"ready","pid":123,"fixtureWindow":{"title":"sleight benchmark \\u2014 fixture test","profile":"sleight benchmark","pid":123}}\n'), 5);
      return new Promise(resolve => { finish = resolve; });
    },
  });
  assert.deepEqual(actions, [
    ['-g', '-a', 'Safari', '--args', '-ApplePersistenceIgnoreState', 'YES'],
  ]);
  assert.equal(lease.running, false);
  assert.equal(lease.pid, 123);
  assert.deepEqual(lease.diagnostics.fixtureWindow, { title: 'sleight benchmark \u2014 fixture test', profile: 'sleight benchmark', pid: 123 });
  const closed = lease.close();
  finish({ exit: { code: 0 }, stdout: '{"stage":"closed"}\n', groupClean: true });
  await closed;
});

test('Safari process acquisition waits for LaunchServices startup without a window inventory', () => {
  const source = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  const sandbox = { ObjC: { import() {} } };
  runInNewContext(source, sandbox);
  assert.equal(typeof sandbox.waitForApplication, 'function');
  const starting = { isFinishedLaunching: false }, ready = { isFinishedLaunching: true };
  const observations = [null, starting, ready];
  let waits = 0;
  assert.equal(sandbox.waitForApplication(() => observations.shift(), () => { waits++; }), ready);
  assert.equal(waits, 2);
  waits = 0;
  assert.equal(sandbox.waitForApplication(() => null, () => { waits++; }), null);
  assert.equal(waits, 100, 'a process that never appears must fail within ten seconds');
});

test('Safari startup polling advances AppKit cached properties through the native run loop', () => {
  const source = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  const target = { isFinishedLaunching: false }, turns = [], sleeps = [];
  const deadline = { timeIntervalSinceNow: 0.04 };
  const sandbox = { ObjC: { import() {} }, $: {
    NSDefaultRunLoopMode: 'default',
    NSDate: { dateWithTimeIntervalSinceNow: seconds => { assert.equal(seconds, 0.1); return deadline; } },
    NSThread: { sleepForTimeInterval: seconds => sleeps.push(seconds) },
    NSRunLoop: { mainRunLoop: { runModeBeforeDate(mode, deadline) {
      turns.push([mode, deadline]); target.isFinishedLaunching = true;
    } } },
  } };
  runInNewContext(source, sandbox);
  assert.equal(typeof sandbox.waitForLaunch, 'function');
  assert.equal(sandbox.waitForApplication(() => target, sandbox.waitForLaunch), target);
  assert.deepEqual(turns, [['default', deadline]]);
  assert.deepEqual(sleeps, [0.04], 'an early run-loop return still waits the rest of the poll interval');
});

test('document cleanup refuses a changed focus or document identity before pressing anything', () => {
  const source = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  const sandbox = { ObjC: { import() {} } };
  runInNewContext(source, sandbox);
  const owned = {}, other = {};
  const api = { exists: () => true, matches: () => true, focused: () => other, equal: (a, b) => a === b,
    closeDocument: () => assert.fail('must not close another document'), closeButton: () => assert.fail('must not close a document window'),
  };
  assert.throws(() => sandbox.closeOwnedWindow(owned, { mode: 'document' }, {}, api), /focus/);
  api.matches = () => false;
  assert.throws(() => sandbox.closeOwnedWindow(owned, { mode: 'window' }, {}, api), /identity/);
});

test('a generic Archive title cannot establish Finder ownership during setup', () => {
  const source = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  const native = value => value;
  native.AXUIElementCopyAttributeValue = (_window, name, output) => {
    output[0] = name === 'AXTitle' ? 'Archive' : null; return 0;
  };
  const sandbox = { $: native, Ref: () => [], ObjC: { import() {}, castRefToObject: value => value, unwrap: value => value } };
  runInNewContext(source, sandbox);
  const api = sandbox.nativeAX(), request = { mode: 'folder', target: '/fixture/Files-abc', token: 'Files-abc' };
  assert.equal(api.matches({}, request), false, 'a generic title must not authorize a new reference');
  assert.equal(api.matches({}, request, true), true, 'the retained owned reference can navigate into Archive');
});

test('document identity normalizes both Foundation file URLs and private fixture paths', () => {
  const source = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  const native = value => value;
  native.AXUIElementCopyAttributeValue = (_window, name, output) => {
    output[0] = name === 'AXDocument' ? 'file:///tmp/Pages-abc.pdf' : 'Pages-abc.pdf'; return 0;
  };
  const url = value => ({ isNil: () => false, isFileURL: true, absoluteString: value,
    URLByResolvingSymlinksInPath: { path: value.replace('file://', '').replace(/^\/private\//, '/') } });
  native.NSURL = { URLWithString: url, fileURLWithPath: value => url('file://' + value) };
  const sandbox = { $: native, Ref: () => [], ObjC: { import() {}, castRefToObject: value => value, unwrap: value => value } };
  runInNewContext(source, sandbox);
  const api = sandbox.nativeAX();
  assert.equal(api.matches({}, { mode: 'document', target: `${MAC_TMP}/Pages-abc.pdf`, token: 'Pages-abc.pdf' }), true);
  assert.equal(api.matches({}, { mode: 'document', target: `${MAC_TMP}/Other.pdf`, token: 'Pages-abc.pdf' }), false,
    'a matching title must never override another document path');
});

test('https shop smoke documents match only the allowlisted host', () => {
  const source = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  const native = value => value;
  native.AXUIElementCopyAttributeValue = (_window, name, output) => {
    output[0] = name === 'AXDocument' ? native.document : 'Target'; return 0;
  };
  native.NSURL = { URLWithString: value => ({
    isNil: () => !value, host: new URL(value).hostname, scheme: new URL(value).protocol.replace(':', ''),
  }) };
  const sandbox = { $: native, Ref: () => [], ObjC: { import() {}, castRefToObject: value => value, unwrap: value => value } };
  runInNewContext(source, sandbox);
  const api = sandbox.nativeAX();
  const request = { mode: 'window', target: 'https://www.target.com/', token: 'Target' };
  native.document = 'https://www.target.com/s?searchTerm=towels';
  assert.equal(api.matches({}, request), true);
  native.document = 'https://www.bestbuy.com/';
  assert.equal(api.matches({}, request), false);
  native.document = 'https://evil.test/';
  assert.equal(api.matches({}, request), false);
  native.document = 'http://www.target.com/';
  assert.equal(api.matches({}, request), false);
});

test('ordinary cancellation retains the helper until its owned window is closed', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-fixture-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controller = new AbortController(), cleanup = new AbortController();
  let finish, helperSignal;
  const lease = await openFixture({ dir, ownerAway: true, signal: controller.signal, cleanupSignal: cleanup.signal },
    { app: 'Safari', bundle: 'com.apple.Safari', target: 'http://127.0.0.1/test', mode: 'window' }, {
      helper: async () => ({ command: 'native-browser-helper', args: [] }),
      run: async (_command, _args, options) => {
        helperSignal = options.signal;
        options.onStdout('{"stage":"launch","running":true}\n{"stage":"armed","running":true}\n{"stage":"ready"}\n');
        return new Promise(resolve => { finish = resolve; });
      }, open: async () => {},
    });
  controller.abort();
  assert.equal(helperSignal.aborted, false, 'ordinary cancellation must preserve the retained AX reference');
  const closed = lease.close();
  finish({ exit: { code: 0 }, stdout: '{"stage":"closed"}\n', groupClean: true });
  await closed;
  cleanup.abort();
  assert.equal(helperSignal.aborted, true, 'permission cancellation must stop the helper immediately');
});

test('fixture cleanup quits only apps this lease launched, after closing its window', async () => {
  const { closeFixtures } = await import('../bench/real-fixture.mjs');
  const events = [];
  for (const running of [true, false]) {
    const ctx = { windowLeases: [{ running, launched: true, app: 'Safari',
      close: async () => events.push(`close:${running}`), dispose: async () => true, quit: async () => events.push(`quit:${running}`) }] };
    await closeFixtures(ctx);
  }
  assert.deepEqual(events, ['close:true', 'close:false', 'quit:false']);
});

test('a failed window close collects its helper before quitting a launched app', async () => {
  const { closeFixtures } = await import('../bench/real-fixture.mjs');
  for (const collected of [true, false]) {
    const events = [];
    await assert.rejects(closeFixtures({ windowLeases: [{ running: false, launched: true,
      close: async () => { events.push('close'); throw new Error('close failed'); },
      dispose: async () => { events.push('collect'); return collected; },
      quit: async () => events.push('quit'),
    }] }), /close failed/);
    assert.deepEqual(events, collected ? ['close', 'collect', 'quit'] : ['close', 'collect']);
  }
});

test('permission cancellation during helper collection prevents a new app quit command', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-quit-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cleanup = new AbortController();
  const lease = await openFixture({ dir, cleanupSignal: cleanup.signal },
    { app: 'Preview', bundle: 'com.apple.Preview', mode: 'document' }, {
      open: async () => {},
      run: async (_command, args, options) => {
        assert.notEqual(JSON.parse(args.at(-1)).mode, 'quit', 'never launch a quit after cancellation during collection');
        options.onStdout('{"stage":"armed","running":false,"pid":42}\n{"stage":"ready"}\n');
        return new Promise(resolve => options.signal.addEventListener('abort', () => {
          cleanup.abort(new Error('permission appeared during collection'));
          resolve({ exit: { code: 0 }, stdout: '{"stage":"closed"}\n', groupClean: true });
        }, { once: true }));
      },
    });
  await assert.rejects(lease.quit(), /permission appeared during collection/);
});

test('final pass cleanup quits the exact launched app after permission cancellation without AX', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  for (const collected of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'real-final-quit-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cleanup = new AbortController(), quits = [];
    const ctx = { dir, cleanupSignal: cleanup.signal, beforeFixtureCleanup: () => assert.fail('no AX observation or cleanup during a permission stop') };
    const lease = await openFixture(ctx, { app: 'DeviceHub', bundle: 'com.apple.dt.Devices', mode: 'inherit' }, {
      open: async () => {},
      run: async (_command, args, options) => {
        const request = JSON.parse(args.at(-1));
        if (request.mode === 'quit') {
          assert.equal(options.signal, undefined);
          quits.push(request.pid);
          return { exit: { code: 0 }, groupClean: true };
        }
        options.onStdout('{"stage":"armed","running":false,"pid":42}\n{"stage":"ready"}\n');
        return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({
          exit: { code: 0 }, stdout: '', groupClean: collected,
        }), { once: true }));
      },
    });
    cleanup.abort(new Error('permission stop'));
    await lease.quit({ final: true });
    await lease.quit({ final: true });
    assert.deepEqual(quits, [42], 'confirmed native quit is idempotent');
    assert.equal(ctx.fixtureDiagnostics[0].appQuit, true);
    assert.equal(ctx.fixtureDiagnostics[0].helperCollectionConfirmed, collected);
  }
});

test('native quit refuses a replacement process and confirms only the launched app exits', () => {
  const { quitFixtureApplication } = nativeSource();
  assert.equal(typeof quitFixtureApplication, 'function');
  const app = { processIdentifier: 42, bundleIdentifier: 'com.apple.Safari', terminate: true };
  let observations = 0;
  const clock = { now: () => 0, wait: () => {}, emit() {} };
  assert.equal(quitFixtureApplication(42, 'com.apple.Safari', () => ++observations < 3 ? app : null, clock), true);
  assert.throws(() => quitFixtureApplication(42, 'com.apple.Safari', () => ({ ...app, processIdentifier: 43 }),
    { ...clock, wait: () => assert.fail('no quit of replacement') }), /identity/);
});

test('native quit names both pid and bundle when identity differs', () => {
  const { quitFixtureApplication } = nativeSource();
  const clock = { now: () => 0, wait: () => assert.fail('no quit of replacement'), emit() {} };
  assert.throws(() => quitFixtureApplication(73541, 'com.apple.dt.Devices', () => ({
    processIdentifier: 73541, bundleIdentifier: 'com.apple.dt.Xcode',
  }), clock), /pid 73541 vs 73541, bundle com\.apple\.dt\.Xcode vs com\.apple\.dt\.Devices/);
  assert.throws(() => quitFixtureApplication(73541, 'com.apple.dt.Devices', () => ({
    processIdentifier: 64001, bundleIdentifier: 'com.apple.dt.Devices',
  }), clock), /pid 64001 vs 73541, bundle com\.apple\.dt\.Devices vs com\.apple\.dt\.Devices/);
});

test('native quit with an empty bundle string needs the process to run from the expected app', () => {
  const { quitFixtureApplication } = nativeSource();
  let gone = false;
  const app = { processIdentifier: 73541, bundleIdentifier: null, get terminate() { gone = true; return true; } };
  // The clock advances so a wrong quit hits its deadline instead of looping.
  const clock = sameApp => { let time = 0; return { now: () => (time += 1000), wait: () => {}, emit() {}, sameApp }; };
  // A reused PID that runs some other program: never quit it.
  assert.throws(() => quitFixtureApplication(73541, 'com.apple.dt.Devices', () => app, clock(() => false)), /quit refused/);
  assert.throws(() => quitFixtureApplication(73541, 'com.apple.dt.Devices', () => app, clock(undefined)), /quit refused/);
  assert.equal(gone, false);
  assert.equal(quitFixtureApplication(73541, 'com.apple.dt.Devices', () => gone ? null : app,
    clock((target, bundle) => target === app && bundle === 'com.apple.dt.Devices')), true);
});

test('native quit uses the pid the setup recorded even when it arrives as a string', () => {
  const { quitFixtureApplication } = nativeSource();
  let gone = false;
  const app = { processIdentifier: 73541, bundleIdentifier: 'com.apple.dt.Devices',
    get terminate() { gone = true; return true; } };
  assert.equal(quitFixtureApplication('73541', 'com.apple.dt.Devices', () => gone ? null : app,
    { now: () => 0, wait: () => {}, emit() {} }), true);
});

test('native quit treats an AppKit processIdentifier of -1 as the launched pid when the bundle matches', () => {
  const { quitFixtureApplication } = nativeSource();
  let gone = false;
  const app = { processIdentifier: -1, bundleIdentifier: 'com.apple.dt.Devices',
    get terminate() { gone = true; return true; } };
  assert.equal(quitFixtureApplication(89311, 'com.apple.dt.Devices', () => gone ? null : app,
    { now: () => 0, wait: () => {}, emit() {} }), true);
  assert.equal(gone, true);
});

test('a streamed pid of -1 does not replace the launched process id', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-pid-keep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir };
  await assert.rejects(openFixture(ctx, { app: 'DeviceHub', bundle: 'com.apple.dt.Devices', mode: 'inherit' }, {
    launch: async beginLaunch => { beginLaunch(true); },
    run: async (_command, args, options) => {
      assert.notEqual(JSON.parse(args.at(-1)).mode, 'quit');
      options.onStdout('{"stage":"armed","running":false,"pid":89311}\n');
      await new Promise(resolve => setImmediate(resolve));
      const stdout = '{"stage":"setup-failure","pid":-1,"cleanup":"unconfirmed"}\n';
      options.onStdout(stdout);
      return { exit: { code: 1 }, stdout, stderr: 'Fixture application readiness unconfirmed', groupClean: true };
    },
  }), /readiness unconfirmed/);
  assert.equal(ctx.windowLeases[0].pid, 89311);
  assert.equal(ctx.fixtureDiagnostics[0].pid, 89311);
});

test('normal quit waits for a cold app beyond five seconds and records the exact process outcome', () => {
  const { quitFixtureApplication } = nativeSource(), events = [];
  let time = 0, quits = 0;
  const app = { processIdentifier: 42, bundleIdentifier: 'com.microsoft.Excel', isFinishedLaunching: false,
    get terminate() { quits++; return true; }, get forceTerminate() { assert.fail('never force quit'); } };
  assert.equal(quitFixtureApplication(42, 'com.microsoft.Excel', () => time < 12000 ? app : null,
    { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) }), true);
  assert.equal(quits, 1);
  assert.equal(time, 12000);
  assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1).quitWait)),
    { reason: 'exited', accepted: true, elapsedMs: 12000, finishedLaunching: false });
});

test('normal quit leaves an app that does not exit unconfirmed and refuses a replacement during the wait', () => {
  const { quitFixtureApplication } = nativeSource(), events = [];
  let time = 0, quits = 0;
  const app = { processIdentifier: 42, bundleIdentifier: 'com.microsoft.Excel', isFinishedLaunching: true,
    get terminate() { quits++; return true; }, get forceTerminate() { assert.fail('never force quit unsaved work'); } };
  assert.throws(() => quitFixtureApplication(42, 'com.microsoft.Excel', () => app,
    { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) }), /quit unconfirmed/);
  assert.equal(time, 30000);
  assert.equal(quits, 1);
  assert.equal(events.at(-1).quitWait.reason, 'deadline');
  assert.equal(events.at(-1).quitWait.accepted, true);
  time = 0;
  assert.throws(() => quitFixtureApplication(42, 'com.microsoft.Excel', () => time ? { processIdentifier: 43, bundleIdentifier: app.bundleIdentifier } : app,
    { now: () => time, wait: ms => { time += ms; }, emit() {} }), /identity/);
});

test('native Office setup waits in both running cases and retains a failed PID without acting', () => {
  for (const initiallyRunning of [false, true]) for (const windowAt of [12000, Infinity]) {
    const sandbox = nativeSource(), events = [];
    let time = 0, closed = false, reads = 0;
    const target = { processIdentifier: 42 }, owned = {};
    const foundation = value => ({ dataUsingEncoding: () => value });
    foundation.AXIsProcessTrusted = () => true;
    foundation.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => {
      const count = initiallyRunning || reads++ ? 1 : 0;
      return { count, objectAtIndex: () => target };
    } };
    foundation.AXUIElementCreateApplication = () => ({});
    foundation.AXUIElementSetMessagingTimeout = () => {};
    foundation.NSFileHandle = { fileHandleWithStandardOutput: { writeData: line => {
      const event = JSON.parse(line); events.push(event); if (event.stage === 'ready') closed = true;
    } } };
    foundation.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
    foundation.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({ command: closed ? 'close' : 'opened' }) } };
    sandbox.$ = foundation; sandbox.Date = { now: () => time };
    sandbox.waitForLaunch = seconds => { time += Math.round((seconds ?? 0.1) * 1000); };
    sandbox.nativeAX = (state, clock) => ({
      dialog: () => {
        if (!state.setup) assert.equal(state.cleanup, true, 'cleanup must cover its initial dialog read too');
        return [];
      }, readiness: () => ({}),
      focused: () => {
        assert.equal(state.office, true, 'Office readiness covers existing apps as well as cold launches');
        const read = () => {
          if (time < windowAt) throw Object.assign(new Error('not ready'), { code: time < 5000 ? -25204 : -25205, attribute: 'AXFocusedWindow' });
          return owned;
        };
        return state.officeWaiting ? read() : sandbox.setupRead(read, state, clock);
      },
      matches: () => true, exists: () => false,
      press: () => assert.fail('no fixture action while starting'), wait: () => assert.fail('use the launch run loop'),
    });
    const request = JSON.stringify({ app: 'Microsoft Excel', bundle: 'com.microsoft.Excel', mode: 'document', control: 'fake', token: 'fixture', target: '/fixture.xlsx' });
    if (windowAt === Infinity) {
      assert.throws(() => sandbox.run([request]), initiallyRunning
        ? error => error.code === -25205 && error.attribute === 'AXFocusedWindow'
        : /timed out.*-25205.*AXFocusedWindow/);
      const failed = events.at(-1);
      assert.equal(failed.stage, 'setup-failure');
      assert.equal(failed.pid, 42);
      assert.equal(failed.actionTaken, false);
      assert.equal((failed.readWait || failed.launchWait).reason, 'deadline');
      assert.equal(failed.running, initiallyRunning);
      assert.equal(failed.setupCase, initiallyRunning ? 'already-running' : 'cold-launch');
    } else {
      sandbox.run([request]);
      const receipt = events.find(event => event.stage === 'office-wait').launchWait;
      assert.equal(receipt.elapsedMs, 12000);
      assert.equal(receipt.setupCase, initiallyRunning ? 'already-running' : 'cold-launch');
      assert.equal(events.some(event => event.stage === 'ready'), true);
      assert.equal(events.at(-1).stage, 'closed');
    }
  }
});

test('native JXA quit identity unwraps a bridged bundle string without accessing an app',
  { skip: macCommandSkip('osascript') }, async () => {
    const result = await runOwned('/usr/bin/osascript', ['-l', 'JavaScript',
      fileURLToPath(new URL('../bench/real-fixture.js', import.meta.url)), '{"mode":"self-test"}'], { timeoutMs: 15000 });
    assert.equal(result.groupClean, true);
    assert.equal(result.exit.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { quit: true });
  });

test('native setup records a new app PID while launch is pending, before cancellation', () => {
  const sandbox = nativeSource(), events = [];
  let waits = 0, pumped = false;
  const foundation = value => ({ dataUsingEncoding: () => value });
  foundation.AXIsProcessTrusted = () => true;
  foundation.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => {
    assert.ok(waits < 2, 'never discover an app after cancellation');
    const count = pumped ? 1 : 0;
    return { count, objectAtIndex: () => ({ processIdentifier: 42 }) };
  } };
  foundation.NSFileHandle = { fileHandleWithStandardOutput: { writeData: line => events.push(JSON.parse(line)) } };
  foundation.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
  foundation.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({ command: waits < 2 ? 'launching' : 'close' }) } };
  sandbox.$ = foundation;
  sandbox.waitForLaunch = () => { pumped = true; waits++; };
  sandbox.nativeAX = () => ({ wait: () => assert.fail('PID visibility needs the main run loop'), focused: () => assert.fail('no AX read before launch completes') });
  assert.throws(() => sandbox.run([JSON.stringify({ bundle: 'com.apple.dt.Devices', mode: 'inherit', control: 'fake-control' })]),
    /interrupted before identity was recorded/);
  assert.equal(events.find(event => event.stage === 'armed').running, false);
  assert.equal(events.at(-1).pid, 42, 'failed launch keeps the original PID for exact app cleanup');
});

test('native setup never discovers an app during pre-launch simulator preparation', () => {
  const sandbox = nativeSource(), events = [];
  let waits = 0, appReads = 0;
  const foundation = value => ({ dataUsingEncoding: () => value });
  foundation.AXIsProcessTrusted = () => true;
  foundation.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => {
    assert.equal(appReads++, 0, 'only the initial running-state query is allowed before launch starts');
    return { count: 0 };
  } };
  foundation.NSFileHandle = { fileHandleWithStandardOutput: { writeData: line => events.push(JSON.parse(line)) } };
  foundation.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
  foundation.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({ command: waits < 2 ? '' : 'close' }) } };
  sandbox.$ = foundation;
  sandbox.waitForLaunch = () => { waits++; };
  sandbox.nativeAX = () => ({ wait: () => { waits++; } });
  assert.throws(() => sandbox.run([JSON.stringify({ bundle: 'com.apple.dt.Devices', mode: 'inherit', control: 'fake-control' })]),
    /interrupted before identity was recorded/);
  assert.equal(events.at(-1).pid, undefined);
});

test('a viewer opened during simulator preparation is preserved at the actual launch step', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-viewer-existing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir };
  let finish;
  await assert.rejects(openFixture(ctx, { app: 'DeviceHub', bundle: 'com.apple.dt.Devices', mode: 'inherit' }, {
    launch: async beginLaunch => {
      assert.equal(ctx.windowLeases[0].launched, false, 'simulator boot alone is not a viewer launch');
      beginLaunch(false);
      assert.equal(JSON.parse(readFileSync(join(dir, 'window-0-control.json'))).command, 'launching');
      finish(); throw new Error('URL setup timed out');
    },
    run: async (_command, args, options) => {
      assert.notEqual(JSON.parse(args.at(-1)).mode, 'quit', 'preserve the viewer that appeared before our open call');
      options.onStdout('{"stage":"armed","running":false}\n');
      return new Promise(resolve => { finish = () => {
        const stdout = '{"stage":"setup-failure","cleanup":"unconfirmed","pid":42}\n';
        options.onStdout(stdout); resolve({ exit: { code: 1 }, stdout, groupClean: true });
      }; });
    },
  }), /URL setup timed out/);
  await closeFixtures(ctx);
  assert.equal(ctx.fixtureDiagnostics[0].running, false, 'keep the initial running report');
  assert.equal(ctx.windowLeases[0].launched, false);
});

test('a failed Safari File-menu lookup cancels that menu before propagating the failure', () => {
  const { chooseFileMenu } = nativeSource();
  assert.equal(typeof chooseFileMenu, 'function');
  const file = {}, menu = {}, unrelated = {}, events = [];
  const api = {
    press: element => { assert.equal(element, file); events.push('open'); },
    children: element => element === file ? [menu] : [unrelated],
    text: (_element, attribute) => attribute === 'AXRole' ? 'AXMenu' : 'Another item',
    cancel: element => { assert.equal(element, menu); events.push('cancel'); },
  };
  assert.throws(() => chooseFileMenu(file, ['New Window'], api), /unavailable/);
  assert.deepEqual(events, ['open', 'cancel']);
  api.cancel = () => { throw new Error('cancel failed'); };
  assert.throws(() => chooseFileMenu(file, ['New Window'], api), error => error.menuCleanupError === 'cancel failed');
});

test('document cleanup does not inspect or discard the document exposed after its fixture closes', () => {
  const { closeOwnedWindow } = nativeSource(), owned = {};
  let matches = true;
  closeOwnedWindow(owned, { mode: 'document' }, {}, {
    exists: () => true, matches: () => matches, focused: () => owned, equal: (a, b) => a === b,
    closeDocument: () => { matches = false; }, wait() {},
    discard: () => assert.fail('preserve the owner document now visible in the retained window'),
  });
});

test('a fixture can forbid answering save dialogs during retained-window cleanup', () => {
  const { closeOwnedWindow } = nativeSource(), owned = {};
  let discarded = false;
  assert.throws(() => closeOwnedWindow(owned, { mode: 'document', refuseDialogs: true }, {}, {
    exists: () => true, matches: () => true, focused: () => owned, equal: (a, b) => a === b,
    closeDocument() {}, wait() {}, dialog: () => [], discard() { discarded = true; },
  }), /still open/);
  assert.equal(discarded, false);
});

test('refuseDialogs blocks every app dialog category and stops before closing a document', () => {
  const { appDialogInfo, closeOwnedWindow } = nativeSource(), owned = {};
  assert.equal(appDialogInfo({ subrole: 'AXDialog', title: 'Save changes' }, 'TextEdit', true).stop, true);
  assert.throws(() => closeOwnedWindow(owned, { mode: 'document', refuseDialogs: true }, {}, {
    exists: () => true, matches: () => true, focused: () => owned, equal: (a, b) => a === b,
    dialog: () => [{ category: 'application-result' }],
    closeDocument: () => assert.fail('must not act while an app dialog is present'),
  }), /dialog/);
});

test('strict fixture menu cancellation never sends Escape or targets a dialog', () => {
  const { cancelFixtureMenu } = nativeSource();
  let cancels = 0, escapes = 0;
  const api = { role: () => 'AXMenu', cancel: () => { cancels++; return false; }, escape: () => { escapes++; } };
  assert.throws(() => cancelFixtureMenu({}, api, true), /Escape/);
  assert.equal(escapes, 0);
  api.role = () => 'AXSheet';
  assert.throws(() => cancelFixtureMenu({}, api, true), /menu/);
  assert.equal(cancels, 1);
});

test('document menu closure prefers the enabled per-document command over window closure', () => {
  const { chooseFileMenu } = nativeSource(), file = {}, menu = {}, selected = { title: 'Close Selected PDF Document' },
    wholeWindow = { title: 'Close Window' }, disabled = { title: 'Close Selected PDF Document', disabled: true }, presses = [];
  chooseFileMenu(file, ['Close Selected PDF Document', 'Close Window'], {
    children: element => element === file ? [menu] : [disabled, wholeWindow, selected],
    text: (element, name) => name === 'AXRole' ? 'AXMenu' : element.title,
    enabled: element => !element.disabled, press: element => presses.push(element), cancel() {},
  });
  assert.deepEqual(presses, [file, selected]);
});

test('document close revalidates focus after menu lookup and cancels on an owner switch', () => {
  const { chooseFileMenu, closeOwnedWindow } = nativeSource();
  const owned = {}, owner = {}, app = {}, file = {}, menu = {}, close = {}, presses = [];
  let focused = owned, cancelled = false;
  const api = {
    exists: () => true, matches: () => true, focused: () => focused, equal: (a, b) => a === b,
    closeDocument: (_app, beforePress) => chooseFileMenu(file, ['Close'], {
      children: element => { if (element === file) return [menu]; focused = owner; return [close]; },
      text: (_element, name) => name === 'AXRole' ? 'AXMenu' : 'Close',
      press: element => presses.push(element), beforePress,
      cancel: () => { cancelled = true; },
    }),
    wait() {}, discard: () => assert.fail('no discard after an owner switch'),
  };
  assert.throws(() => closeOwnedWindow(owned, { mode: 'document' }, app, api), /focus/);
  assert.deepEqual(presses, [file]);
  assert.equal(cancelled, true);
});

test('Safari refuses blank-window setup before any mutation without an owner-away boundary', async () => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  await assert.rejects(openFixture({ dir: '/unused' }, { app: 'Safari', bundle: 'com.apple.Safari' }, {
    helper: async () => assert.fail('must not start a native helper'),
    open: async () => assert.fail('must not launch Safari'),
  }), error => error.noMutation === true && /owner-away/.test(error.message));
});

test('disabled document close activates only with an explicit owner-away boundary and revalidates', () => {
  const { closeDocumentSafely } = nativeSource(), events = [];
  assert.equal(typeof closeDocumentSafely, 'function');
  let active = false;
  const api = {
    menu: (_app, validate) => { events.push('menu'); if (!active) throw new Error('Fixture menu item unavailable or ambiguous'); validate(); events.push('close'); },
    activate: () => { active = true; events.push('activate'); },
  };
  assert.throws(() => closeDocumentSafely({}, {}, () => events.push('validate'), api), /unavailable/);
  assert.deepEqual(events, ['menu']);
  events.length = 0;
  closeDocumentSafely({}, { ownerAway: true }, () => events.push('validate'), api);
  assert.deepEqual(events, ['menu', 'validate', 'activate', 'validate', 'menu', 'validate', 'close']);
});

test('application dialog classification distinguishes result UI from licensing and access prompts', () => {
  const { appDialogCategory } = nativeSource();
  assert.equal(typeof appDialogCategory, 'function');
  assert.equal(appDialogCategory({ title: 'Activate Office', document: '' }), 'activation');
  assert.equal(appDialogCategory({ title: 'Microsoft Word', document: '', buttons: ['Sign In'] }), 'sign-in');
  assert.equal(appDialogCategory({ title: 'Welcome to Microsoft Excel', document: '' }), 'first-run');
  assert.equal(appDialogCategory({ title: 'Grant Access', subrole: 'AXDialog', document: '' }), 'permission');
  assert.equal(appDialogCategory({ title: 'Welcome.docx', document: 'file:///owner/Welcome.docx' }), null);
  assert.equal(appDialogCategory({ title: 'Document1', document: '', buttons: ['Sign In'] }), null);
  assert.equal(appDialogCategory({ title: 'Word', document: '', buttons: ['Open'] }), null);
  assert.equal(appDialogCategory({ title: 'Microsoft Word', subrole: 'AXDialog', buttons: ['OK'] }), 'application-result');
  assert.equal(appDialogCategory({ title: 'Unexpected sheet', subrole: 'AXDialog', document: '' }), 'application-result');
  assert.equal(appDialogCategory({ title: 'Word would like to access files', subrole: 'AXDialog', buttons: ["Don't Allow", 'Allow'] }), 'permission');
  assert.equal(appDialogCategory({ title: 'Microsoft Word', subrole: 'AXDialog', document: 'file:///fixture.docx', buttons: ['Sign In'] }), 'sign-in');
  assert.equal(appDialogCategory({ title: 'Welcome to Microsoft Word', subrole: 'AXDialog', buttons: ['Grant Access'] }), 'permission');
  assert.equal(appDialogCategory({ title: 'Microsoft Word', subrole: 'AXDialog', text: ['Sign in to Office to continue'], buttons: ['Continue', 'Cancel'] }), 'sign-in');
  assert.equal(appDialogCategory({ title: 'Microsoft Word', subrole: 'AXDialog', text: ['Grant access to this file'], buttons: ['OK', 'Cancel'] }), 'permission');
});

test('dialog records retain titles and button names and stop only access or licensing prompts', () => {
  const { appDialogInfo } = nativeSource();
  assert.equal(typeof appDialogInfo, 'function');
  const result = appDialogInfo({ title: 'Microsoft Word', subrole: 'AXDialog', buttons: ['OK'] }, 'Microsoft Word');
  assert.equal(result.title, 'Microsoft Word');
  assert.deepEqual(Array.from(result.buttons), ['OK']);
  assert.equal(result.stop, false);
  for (const info of [{ title: 'Activate Office' }, { title: 'Microsoft Word', buttons: ['Sign In'] },
    { title: 'Grant Access', subrole: 'AXDialog', buttons: ['OK'] }]) {
    assert.equal(appDialogInfo(info, 'Microsoft Word').stop, true);
  }
});

test('native dialog content classifies static prompt text without reading editable values or publishing body text', () => {
  const { dialogContents, appDialogInfo } = nativeSource();
  const content = dialogContents('dialog', {
    children: element => element === 'dialog' ? ['group'] : element === 'group' ? ['body', 'button', 'password'] : [],
    text: (element, attribute) => {
      if (attribute === 'AXRole') return { group: 'AXGroup', body: 'AXStaticText', button: 'AXButton', password: 'AXTextField' }[element];
      assert.notEqual(element, 'password');
      return element === 'body' && attribute === 'AXValue' ? 'Sign in to Office to continue' : element === 'button' ? 'Continue' : '';
    },
  });
  const record = appDialogInfo({ title: 'Microsoft Word', subrole: 'AXDialog', ...content }, 'Microsoft Word');
  assert.equal(record.category, 'sign-in');
  assert.equal(record.stop, true);
  assert.deepEqual(Array.from(record.buttons), ['Continue']);
  assert.equal(record.text, undefined);
  const loop = { children: () => ['loop'], text: () => 'AXGroup' };
  assert.throws(() => dialogContents('loop', loop), /exceeded its bound/);
});

test('native dialog observation includes a focused permission dialog that carries a document URL', () => {
  const sandbox = nativeSource();
  const body = { AXRole: 'AXStaticText', AXValue: 'Grant access to this file' }, button = { AXRole: 'AXButton', AXTitle: 'OK' };
  const focused = { AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'Microsoft Word',
    AXDocument: 'file:///fixture.docx', AXChildren: [body, button] };
  const foundation = value => value;
  foundation.AXUIElementCopyAttributeValue = (element, attribute, ref) => { ref[0] = element[attribute] ?? null; return 0; };
  foundation.CFEqual = (a, b) => a === b;
  sandbox.$ = foundation; sandbox.Ref = () => [];
  sandbox.ObjC.castRefToObject = value => Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
  const dialogs = sandbox.nativeAX({}, {}).dialog({ AXFocusedWindow: focused }, {},
    { app: 'Microsoft Word', stopOnAppDialog: true, target: 'http://fixture.test/' });
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].category, 'permission');
  assert.equal(dialogs[0].stop, true);
});

test('a collected helper refusal before any mutation confirms cleanup without an AX action', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-fixture-unavailable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir };
  await assert.rejects(openFixture(ctx, { app: 'Preview', bundle: 'com.apple.Preview', mode: 'document' }, {
    run: async () => ({ exit: { code: 1 }, stdout: '{"stage":"untouched"}\n', stderr: 'Preview is unavailable', groupClean: true }),
    open: async () => assert.fail('must not launch after a read-only refusal'),
  }), error => error.noMutation === true);
  await closeFixtures(ctx);
  assert.equal(await ctx.windowLeases[0].dispose(), true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'window-0-control.json'))).command, 'waiting');
});

test('a document fixture launches without window restoration or the iCloud open panel', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-document-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const actions = [];
  let finish;
  const lease = await openFixture({ dir, ownerAway: true }, {
    app: 'TextEdit', bundle: 'com.apple.TextEdit', target: join(dir, 'nonce.txt'), token: 'nonce.txt', mode: 'document',
  }, {
    helper: async () => ({ command: 'native-helper', args: [] }),
    open: async (command, args) => { assert.equal(command, '/usr/bin/open'); actions.push(args); },
    run: async (_command, _args, options) => {
      options.onStdout('{"stage":"launch","running":false}\n');
      setTimeout(() => options.onStdout('{"stage":"armed","running":false}\n{"stage":"ready","pid":123}\n'), 5);
      return new Promise(resolve => { finish = resolve; });
    },
  });
  assert.deepEqual(actions, [['-g', '-a', 'TextEdit', join(dir, 'nonce.txt'), '--args', '-ApplePersistenceIgnoreState', 'YES',
    '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO', '-NSDocumentSaveNewDocumentsToCloud', 'NO']]);
  const closed = lease.close();
  finish({ exit: { code: 0 }, stdout: '{"stage":"closed"}\n', groupClean: true });
  await closed;
});

test('the app dialog scan reads an untitled focused window as untitled instead of stopping', () => {
  const owned = {}, other = {}, app = {};
  const fixture = cleanupNative((element, attribute) => {
    if (element === app && attribute === 'AXFocusedWindow') return { value: other };
    if (element === other) return attribute === 'AXTitle' ? { code: -25205 } : attribute === 'AXRole' ? { value: 'AXWindow' } : { value: null };
    return { value: attribute === 'AXRole' ? 'AXWindow' : attribute === 'AXTitle' ? 'Game nonce' : null };
  });
  assert.doesNotThrow(() => fixture.api.dialog(app, owned, { stopOnAppDialog: true, app: 'Chess', token: 'nonce', mode: 'window' }));
});

test('the app dialog scan skips the sheets of a fixture window the task already closed', () => {
  const owned = {}, app = {};
  const fixture = cleanupNative((element, attribute) => {
    if (element === app && attribute === 'AXFocusedWindow') return { value: null };
    if (element === owned && attribute === 'AXSheets') return { code: -25202 };
    return { value: null };
  });
  assert.equal(fixture.api.dialog(app, owned, { stopOnAppDialog: true, app: 'TextEdit', token: 'nonce', mode: 'document' }).length, 0);
});

test('the app dialog scan skips a dialog that disappears while it is read', () => {
  const owned = {}, alert = {}, app = {};
  const fixture = cleanupNative((element, attribute) => {
    if (element === app && attribute === 'AXFocusedWindow') return { value: alert };
    // Word's "All done" alert, dismissed between the focus read and its contents (-25202, word-edit 2026-10-16).
    if (element === alert) return attribute === 'AXChildren' ? { code: -25202 } : attribute === 'AXSubrole' ? { value: 'AXDialog' } :
      attribute === 'AXRole' ? { value: 'AXWindow' } : { value: null };
    return { value: attribute === 'AXRole' ? 'AXWindow' : attribute === 'AXTitle' ? 'Report nonce' : null };
  });
  assert.equal(fixture.api.dialog(app, owned, { stopOnAppDialog: true, app: 'Microsoft Word', token: 'nonce', mode: 'document' }).length, 0);
});

test('a second document lease carries only an earlier cold-launch process receipt from this run', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fixture-launch-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir }, requests = [], pending = [];
  const bundle = 'com.apple.TextEdit', processStartedAtMs = 1792220400123;
  const options = {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {},
    run: (_command, args, options) => {
      requests.push(JSON.parse(args.at(-1)));
      const running = requests.length > 1, done = Promise.withResolvers();
      pending.push(done);
      options.onStdout(JSON.stringify({ stage: 'identified-process', pid: 29976, bundle, processStartedAtMs }) + '\n' +
        JSON.stringify({ stage: 'identified', running, setupCase: running ? 'already-running' : 'cold-launch' }) + '\n' +
        '{"stage":"armed"}\n{"stage":"ready"}\n');
      return done.promise;
    },
  };
  t.after(async () => {
    pending.forEach(done => done.resolve({ groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' }));
    await Promise.all(ctx.windowLeases.map(lease => lease.dispose()));
  });
  const first = await openFixture(ctx, { app: 'TextEdit', bundle, mode: 'document' }, options);
  const second = await openFixture(ctx, { app: 'TextEdit', bundle, mode: 'document' }, options);
  assert.equal(first.launched, true);
  assert.equal(first.running, false);
  assert.equal(second.launched, true);
  assert.equal(second.running, true);
  assert.deepEqual(requests[1].launchedProcesses, [{ pid: 29976, bundle, processStartedAtMs }]);
  assert.deepEqual(requests[0].launchedProcesses, []);
  await openFixture({ dir, windowLeases: [{ ...first, launched: false }, { ...second }] },
    { app: 'TextEdit', bundle, mode: 'document' }, options);
  assert.deepEqual(requests[2].launchedProcesses, [], 'neither an unlaunched nor already-running lease grants process ownership');
});

function runningDocumentCleanup({ launchedProcesses = [], focusedSibling = true, siblingTitle = 'Source-nonce.txt', changedStart = false } = {}) {
  const owned = {}, sibling = {}, button = {}, app = {}, bar = {}, file = {}, menu = {}, close = {}, actions = [], events = [];
  let ready = false, exists = true, time = 0;
  const processStartedAtMs = 1792220400123;
  const target = { processIdentifier: 29976, bundleIdentifier: 'com.apple.TextEdit',
    get launchDate() { return { isNil: () => false, timeIntervalSince1970: (processStartedAtMs + (ready && changedStart ? 1 : 0)) / 1000 }; } };
  const fixture = cleanupNative((element, attribute) => {
    const children = values => ({ count: values.length, objectAtIndex: index => values[index] });
    if (attribute === 'AXMenuBar') return { value: bar };
    if (attribute === 'AXChildren') return { value: children(element === bar ? [file] : element === file ? [menu] : element === menu ? [close] : []) };
    if (element === file) return { value: attribute === 'AXTitle' ? 'File' : null };
    if (element === menu) return { value: attribute === 'AXRole' ? 'AXMenu' : null };
    if (element === close) return { value: attribute === 'AXTitle' ? 'Close' : attribute === 'AXEnabled' ? 1 : null };
    if (attribute === 'AXFocusedWindow') return { value: ready && focusedSibling ? sibling : owned };
    if (attribute === 'AXCloseButton') { assert.equal(element, owned); return { value: button }; }
    if (attribute === 'AXTitle') return { value: element === sibling ? siblingTitle : 'Target-nonce.txt' };
    return { value: attribute === 'AXRole' ? exists ? 'AXWindow' : '' : null };
  });
  const foundation = value => typeof value === 'string' && value.startsWith('{') ? { dataUsingEncoding: () => value } : value;
  Object.assign(foundation, fixture.native, {
    AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => target }) },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout() {}, AXUIElementSetAttributeValue() {},
    AXUIElementPerformAction: (element, action) => {
      actions.push(action);
      if (action === 'AXPress') {
        if (element === file) return 0;
        assert.ok(element === button || element === close);
        actions.push(element === button ? 'button' : 'menu-close'); exists = false;
      }
      else assert.equal(action, 'AXRaise');
      return 0;
    },
    NSFileHandle: { fileHandleWithStandardOutput: { writeData: line => {
      const event = JSON.parse(line); events.push(event); if (event.stage === 'ready') ready = true;
    } } },
    NSData: { dataWithContentsOfFile: () => ({ isNil: () => false }) },
    NSString: { alloc: { initWithDataEncoding: () => JSON.stringify({ command: ready ? 'close' : 'opened', launched: true }) } },
    NSThread: { sleepForTimeInterval: seconds => { time += seconds * 1000; } },
  });
  fixture.sandbox.$ = foundation;
  fixture.sandbox.Date = { now: () => time };
  return { actions, events, run: () => fixture.sandbox.run([JSON.stringify({ app: 'TextEdit', bundle: 'com.apple.TextEdit',
    mode: 'document', token: 'nonce', control: 'fake', startedAtMs: processStartedAtMs - 1000, launchedProcesses })]) };
}

test('the already-running second fixture closes by its own button when this run launched that exact process', () => {
  const fixture = runningDocumentCleanup({ launchedProcesses: [
    { pid: 29976, bundle: 'com.apple.TextEdit', processStartedAtMs: 1792220400123 },
  ] });
  fixture.run();
  assert.deepEqual(fixture.actions, ['AXRaise', 'AXPress', 'button']);
  assert.equal(fixture.events.at(-1).stage, 'closed');
  assert.equal(fixture.events.find(event => event.stage === 'ready').processStartedAtMs, 1792220400123);
});

test('an already-running app this run did not launch still closes through its File menu when focused', () => {
  const fixture = runningDocumentCleanup({ focusedSibling: false });
  fixture.run();
  assert.deepEqual(fixture.actions, ['AXPress', 'AXPress', 'menu-close']);
  assert.equal(fixture.events.at(-1).stage, 'closed');
});

test('inherited launch ownership still refuses an owner document gaining focus', () => {
  const fixture = runningDocumentCleanup({ siblingTitle: 'Owner.txt', launchedProcesses: [
    { pid: 29976, bundle: 'com.apple.TextEdit', processStartedAtMs: 1792220400123 },
  ] });
  assert.throws(fixture.run, /lost focus/);
  assert.deepEqual(fixture.actions, []);
});

for (const [name, launchedProcesses] of [
  ['no earlier launch receipt despite a fresh launchDate', []],
  ['another PID', [{ pid: 29977, bundle: 'com.apple.TextEdit', processStartedAtMs: 1792220400123 }]],
  ['another bundle', [{ pid: 29976, bundle: 'other.app', processStartedAtMs: 1792220400123 }]],
  ['a recycled PID', [{ pid: 29976, bundle: 'com.apple.TextEdit', processStartedAtMs: 1792220400122 }]],
  ['a missing start time', [{ pid: 29976, bundle: 'com.apple.TextEdit' }]],
]) test(`an already-running app with ${name} still refuses cleanup after lost focus`, () => {
  const fixture = runningDocumentCleanup({ launchedProcesses });
  assert.throws(fixture.run, /lost focus/);
  assert.deepEqual(fixture.actions, ['AXRaise']);
});

test('inherited launch ownership refuses a changed process start time before cleanup', () => {
  const fixture = runningDocumentCleanup({ changedStart: true, launchedProcesses: [
    { pid: 29976, bundle: 'com.apple.TextEdit', processStartedAtMs: 1792220400123 },
  ] });
  assert.throws(fixture.run, /process changed/i);
  assert.deepEqual(fixture.actions, []);
});

test('document cleanup raises its own window only over a sibling fixture window of the same run', () => {
  for (const [label, siblingTitle, setupCase, followsRaise, expect] of [
    ['sibling follows', 'Source-nonce.txt', 'already-running', true, 'closed'],
    ['stranger', 'Notes.txt', 'already-running', true, 'refused'],
    ['cold stranger', 'Notes.txt', 'cold-launch', false, 'refused'],
    ['cold sibling stays focused', 'Source-nonce.txt', 'cold-launch', false, 'closed'],
    ['running sibling stays focused', 'Source-nonce.txt', 'already-running', false, 'refused'],
  ]) {
    const owned = {}, sibling = {}, button = {}, actions = [];
    let focused = sibling, exists = true;
    const fixture = cleanupNative((element, attribute) => {
      if (attribute === 'AXFocusedWindow') return { value: focused };
      if (element === sibling) return { value: attribute === 'AXTitle' ? siblingTitle : attribute === 'AXRole' ? 'AXWindow' : null };
      if (attribute === 'AXCloseButton') { assert.equal(element, owned); return { value: button }; }
      return { value: attribute === 'AXRole' ? exists ? 'AXWindow' : '' : attribute === 'AXTitle' ? 'Target-nonce.txt' : null };
    }, { setupCase });
    fixture.native.AXUIElementPerformAction = (element, action) => {
      actions.push(action);
      if (action === 'AXRaise') { assert.equal(element, owned); if (followsRaise) focused = owned; }
      else { assert.equal(action, 'AXPress'); assert.equal(element, button); exists = false; }
      return 0;
    };
    fixture.native.AXUIElementSetAttributeValue = () => 0;
    const api = { ...fixture.api, wait() {} };
    if (setupCase !== 'cold-launch') api.closeDocument = (_app, validate) => { validate(); actions.push('close'); exists = false; };
    const close = () => fixture.sandbox.closeOwnedWindow(owned, { mode: 'document', token: 'nonce' }, {}, api);
    if (expect === 'closed') { close(); assert.deepEqual(actions, ['AXRaise', setupCase === 'cold-launch' ? 'AXPress' : 'close'], label); }
    else { assert.throws(close, /lost focus/, label); assert.deepEqual(actions, siblingTitle === 'Notes.txt' ? [] : ['AXRaise'], label); }
  }
});

for (const setupCase of ['cold-launch', 'already-running'])
for (const change of ['document', 'focus', 'sibling identity', 'dialog']) test(`${setupCase} run-launched sibling cleanup refuses a changed ${change} during close-button lookup`, () => {
  const owned = {}, sibling = {}, stranger = {}, button = {}, actions = [];
  let changed = false;
  const fixture = cleanupNative((element, attribute) => {
    if (attribute === 'AXFocusedWindow') return { value: changed && change === 'focus' ? stranger : sibling };
    if (attribute === 'AXCloseButton') { assert.equal(element, owned); changed = true; return { value: button }; }
    if (attribute === 'AXTitle') return { value: changed && (change === 'document' && element === owned ||
      change === 'sibling identity' && element === sibling) ? 'Unrelated.txt' : element === sibling ? 'Source-nonce.txt' : 'Target-nonce.txt' };
    return { value: attribute === 'AXRole' ? 'AXWindow' : null };
  }, { setupCase, launchedByRun: true });
  fixture.native.AXUIElementPerformAction = (element, action) => {
    assert.equal(element, owned); assert.equal(action, 'AXRaise'); actions.push(action); return 0;
  };
  fixture.native.AXUIElementSetAttributeValue = () => 0;
  const api = { ...fixture.api, wait() {}, dialog: () => changed && change === 'dialog' ? [{}] : [] };
  assert.throws(() => fixture.sandbox.closeOwnedWindow(owned,
    { mode: 'document', token: 'nonce', refuseDialogs: true }, {}, api), /identity changed|lost focus|dialog present/);
  assert.equal(changed, true, 'must reach close-button lookup before refusing');
  assert.deepEqual(actions, ['AXRaise']);
});

test('document close in an app this run launched uses the window close button and never opens a menu', () => {
  // A File menu opened by Accessibility in a background app can stay in its tracking loop, and the app then ignores quit
  // (TextEdit, Preview and Word, 2026-10-16; TextEdit's sample showed NSMenuTrackingSession).
  const { closeDocumentSafely } = nativeSource(), events = [];
  const api = {
    menu: () => { events.push('menu'); throw new Error('Fixture menu item unavailable or ambiguous'); },
    activate: () => events.push('activate'),
    button: validate => { validate(); events.push('button'); },
  };
  closeDocumentSafely({}, {}, () => events.push('validate'), api);
  assert.deepEqual(events, ['validate', 'button']);
});

test('native quit force-terminates a launched app that ignores an accepted quit, except Word and Excel', () => {
  // TextEdit deadlocked in a save and Preview and TextEdit sat in background menus (2026-10-16): each accepted quit, never exited,
  // and stopped the pass. Office keeps the stop, because a forced end leaves recovery files that broke later runs.
  const { quitFixtureApplication } = nativeSource();
  for (const [bundle, expect] of [['com.apple.TextEdit', 'forced'], ['com.microsoft.Word', 'stop'], ['com.microsoft.Excel', 'stop']]) {
    let forced = false, time = 0;
    const events = [];
    const app = { processIdentifier: 42, bundleIdentifier: bundle, terminate: true, get forceTerminate() { forced = true; return true; } };
    const clock = { now: () => time, wait: ms => { time += ms; }, emit: e => events.push(e) };
    const run = () => quitFixtureApplication(42, bundle, () => forced ? null : app, clock);
    if (expect === 'forced') {
      assert.equal(run(), true);
      assert.equal(events.at(-1).quitWait.reason, 'force-terminated');
    } else {
      assert.throws(run, /quit unconfirmed after thirty seconds/);
      assert.equal(forced, false, bundle);
    }
  }
});

test('document cleanup recognizes a sibling by the run nonce when each token is the document file name', () => {
  // The world tasks pass token: basename(document), so Target-<nonce>.txt never appears in its sibling's title
  // Source-<nonce>.txt. Matching on the token refused every sibling: 4 native passes stopped on 2026-10-19.
  for (const [label, siblingTitle, setupCase, followsRaise, expect] of [
    ['cold sibling stays focused', 'Source-nonce.txt', 'cold-launch', false, 'closed'],
    ['running sibling follows', 'Source-nonce.txt', 'already-running', true, 'closed'],
    ['cold stranger', 'Notes.txt', 'cold-launch', false, 'refused'],
    ['running stranger', 'Notes.txt', 'already-running', true, 'refused'],
  ]) {
    const owned = {}, sibling = {}, button = {}, actions = [];
    let focused = sibling, exists = true;
    const fixture = cleanupNative((element, attribute) => {
      if (attribute === 'AXFocusedWindow') return { value: focused };
      if (element === sibling) return { value: attribute === 'AXTitle' ? siblingTitle : attribute === 'AXRole' ? 'AXWindow' : null };
      if (attribute === 'AXCloseButton') { assert.equal(element, owned); return { value: button }; }
      return { value: attribute === 'AXRole' ? exists ? 'AXWindow' : '' : attribute === 'AXTitle' ? 'Target-nonce.txt' : null };
    }, { setupCase });
    fixture.native.AXUIElementPerformAction = (element, action) => {
      actions.push(action);
      if (action === 'AXRaise') { assert.equal(element, owned); if (followsRaise) focused = owned; }
      else { assert.equal(action, 'AXPress'); assert.equal(element, button); exists = false; }
      return 0;
    };
    fixture.native.AXUIElementSetAttributeValue = () => 0;
    const api = { ...fixture.api, wait() {} };
    if (setupCase !== 'cold-launch') api.closeDocument = (_app, validate) => { validate(); actions.push('close'); exists = false; };
    const close = () => fixture.sandbox.closeOwnedWindow(owned, { mode: 'document', token: 'Target-nonce.txt', runToken: 'nonce' }, {}, api);
    if (expect === 'closed') { close(); assert.deepEqual(actions, ['AXRaise', setupCase === 'cold-launch' ? 'AXPress' : 'close'], label); }
    else { assert.throws(close, /lost focus/, label); assert.deepEqual(actions, [], label); }
  }
});

for (const stillThere of [false, true]) test(`a window that closes between two reads of the wait loop ${stillThere ? 'but still exists keeps the stop' : 'counts as closed'}`, () => {
  // 3 TextEdit stops on 2026-10-19 read -25202 for AXDocument, AXSheets or AXRole at wait-0 or wait-2, every probe -25202.
  const { closeOwnedWindow } = nativeSource(), window = {}, actions = [];
  let gone = false;
  const api = {
    exists: () => !gone, text: () => 'File-nonce.txt', matches: () => true, focused: () => window, equal: (a, b) => a === b,
    wait() {}, dialog: () => [], closeButton: (_window, validate) => { validate(); actions.push('button'); },
    discard: () => {
      actions.push('discard');
      if (!stillThere) gone = true;
      throw Object.assign(new Error('AX fixture read failed: -25202 (AXSheets)'), { code: -25202 });
    },
  };
  const close = () => closeOwnedWindow(window, { mode: 'window', token: 'File-nonce.txt' }, {}, api);
  if (stillThere) assert.throws(close, error => error.code === -25202);
  else close();
  assert.deepEqual(actions, ['button', 'discard']);
});

test('fixture slots fit side by side inside the visible frame of any display', () => {
  const { fixtureFrame } = nativeSource();
  // The built-in display on 2026-10-19 (3024 x 1964 pixels at 2x), with the menu bar and Dock taken out; a 5K display; a small one.
  for (const visible of [{ x: 0, y: 33, width: 1512, height: 875 }, { x: 0, y: 25, width: 2560, height: 1415 }, { x: -1280, y: 25, width: 1280, height: 775 }]) {
    const [left, right] = [0, 1].map(slot => fixtureFrame(visible, slot, 2));
    assert.ok(left.x + left.width < right.x, `no overlap on ${visible.width}`);
    for (const frame of [left, right]) {
      assert.ok(frame.x >= visible.x && frame.x + frame.width <= visible.x + visible.width, 'inside horizontally');
      assert.ok(frame.y >= visible.y && frame.y + frame.height <= visible.y + visible.height, 'inside vertically');
      assert.ok(frame.width >= 320 && frame.height >= 240);
    }
  }
  assert.throws(() => fixtureFrame({ x: 0, y: 25, width: 600, height: 400 }, 0, 2), /too small/);
  assert.throws(() => fixtureFrame({ x: 0, y: 25, width: 1512, height: 875 }, 2, 2), /slot invalid/);
});

test('placement fails setup when the window does not end inside its own slot', () => {
  const { placeFixtureWindow } = nativeSource(), visible = { x: 0, y: 33, width: 1512, height: 875 };
  for (const [label, read, expect] of [
    ['as asked', frame => frame, 'placed'],
    ['narrower', frame => ({ ...frame, width: frame.width - 100 }), 'placed'],
    ['cascaded over the first slot', frame => ({ ...frame, x: 40 }), 'refused'],
    ['unreadable', () => null, 'refused'],
  ]) {
    let asked;
    const api = { visibleFrame: () => visible, place: (_window, frame) => { asked = frame; }, frame: () => read(asked) };
    if (expect === 'placed') assert.equal(placeFixtureWindow({}, { slot: 1, count: 2 }, api).slot, 1, label);
    else assert.throws(() => placeFixtureWindow({}, { slot: 1, count: 2 }, api), /placement unconfirmed/, label);
  }
});

test('the JXA setup path refuses Safari before any application lookup or menu action', () => {
  const source = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  const sandbox = { ObjC: { import() {} } };
  runInNewContext(source, sandbox);
  assert.throws(() => sandbox.run([JSON.stringify({ bundle: 'com.apple.Safari', mode: 'window' })]), /profile-proven created-window helper/);
});
