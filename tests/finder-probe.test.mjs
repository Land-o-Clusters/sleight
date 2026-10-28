import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { runFinderProbe } from '../bench/finder-probe.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function fixture({ owners = 1, failure, extra = false } = {}) {
  const source = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), source);
  const desktop = { role: 'AXScrollArea' }, replacement = { role: 'AXScrollArea' };
  const ownerWindows = Array.from({ length: owners }, () => ({ role: 'AXWindow' }));
  const owned = { role: 'AXWindow', document: '', url: '', title: 'Recents', number: 71 }, unrecorded = { role: 'AXWindow' };
  const request = { bundle: 'com.apple.finder', mode: 'folder', target: '/fixture/Finder-probe-0123456789abcdef', fixtureRoot: '/fixture', token: 'Finder-probe-0123456789abcdef' };
  let current = [desktop, ...ownerWindows], time = 0;
  const closed = [], events = [];
  const api = {
    windows: () => [...current], finderRole: w => w.role, equal: (a, b) => !!a && a === b,
    exists: w => current.includes(w), path: value => value, windowNumber: w => w.number,
    text: (w, attribute) => {
      assert.equal(w, owned, 'never read existing owner window titles or documents');
      return attribute === 'AXDocument' ? w.document : attribute === 'AXTitle' ? w.title : w.url;
    },
    fileMenu: (_app, _titles, validate) => { validate(); current = [replacement, ...ownerWindows, owned]; },
    finderFolderGuard: (_app, w) => { if (failure === 'early' && w) throw new Error('Finder folder window lost focus'); },
    menu: (_app, _name, _titles, validate) => validate(), folderSheet: () => ({}),
    submitFolder: (_w, _sheet, target, validate) => {
      validate(); owned.document = failure === 'location' ? '/owner/private' : target; owned.title = 'Finder-probe-0123456789abcdef';
      if (extra) current.push(unrecorded);
    },
    dialog: () => [], wait() {}, emit: event => events.push(event),
    closeButton: (w, validate) => { validate(); closed.push(w); current = current.filter(item => item !== w); },
  };
  const clock = { check() {}, now: () => time, wait: ms => { time += ms; }, beginCleanup() {} };
  return { run: () => JSON.parse(JSON.stringify(source.finderSetupProbe(request, {}, api, clock))),
    source, request, api, clock, ownerWindows, owned, unrecorded, closed, events, current: () => current };
}

for (const owners of [0, 1]) test(`setup probe records desktop equality and preserves ${owners} owner windows`, () => {
  const f = fixture({ owners }), result = f.run();
  assert.equal(result.passed, true);
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(result.snapshots.map(row => row.phase), ['before-new', 'after-new', 'after-navigation', 'after-cleanup']);
  assert.deepEqual(result.snapshots.map(row => row.desktopReferenceEquality), [[[true]], [[false]], [[false]], [[false]]]);
  assert.deepEqual(result.snapshots[1].createdWindow, { document: '', url: '', title: 'Recents' });
  assert.equal(result.snapshots[2].createdWindow.document, '/fixture/Finder-probe-0123456789abcdef');
  assert.ok(result.snapshots.every(row => row.ownerWindowsEqual && row.ownerWindowCount === owners));
  assert.deepEqual(result.snapshots[0].roles, ['AXScrollArea', ...Array(owners).fill('AXWindow')]);
  assert.deepEqual(result.snapshots[1].roles, ['AXScrollArea', ...Array(owners + 1).fill('AXWindow')]);
  assert.deepEqual(f.closed, [f.owned]);
  assert.ok(f.ownerWindows.every(w => f.current().includes(w)));
  assert.equal(f.events.some(e => e.stage === 'finder-baseline-changed'), false);
});

test('setup probe recovers its documentless created window after an offline early failure', () => {
  const f = fixture({ failure: 'early' }), result = f.run();
  assert.equal(result.passed, false);
  assert.equal(result.failure.failureReason, 'window-focus-lost');
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(f.closed, [f.owned]);
});

test('setup probe fails closed when its retained window navigates outside the fixture', () => {
  const f = fixture({ failure: 'location' }), result = f.run();
  assert.equal(result.passed, false);
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.cleanupFailure.failureReason, 'fixture-location-mismatch');
  assert.deepEqual(f.closed, []);
});

for (const [name, state, passed] of [
  ['title only on a window without location attributes', { document: '' }, true],
  ['missing location attributes', { document: undefined, url: undefined }, true],
  ['both location attributes', { url: '/fixture/Finder-probe-0123456789abcdef' }, true],
  ['URL without document', { document: '', url: '/fixture/Finder-probe-0123456789abcdef' }, true],
  ['a different title', { title: 'Other folder' }, false],
  ['the old Recents title', { title: 'Recents' }, false],
  ['a document at the bank root', { document: '/fixture' }, false],
  ['a document in a sibling folder', { document: '/fixture/Other' }, false],
  ['a document below the target', { document: '/fixture/Finder-probe-0123456789abcdef/Other' }, false],
  ['a conflicting URL', { url: '/owner/private' }, false],
  ['the same folder name outside the bank', { document: '/owner/Finder-probe-0123456789abcdef' }, false],
  ['a conflicting document', { document: '/owner/private', url: '/fixture/Finder-probe-0123456789abcdef' }, false],
  ['a different window number', { number: 72 }, false],
  ['a missing window number', { number: null }, false],
]) test(`navigation checks ${name} independently of the retained window`, () => {
  const f = fixture(), submit = f.api.submitFolder;
  f.api.submitFolder = (...args) => { submit(...args); Object.assign(f.owned, state); };
  const result = f.run();
  assert.equal(result.passed, passed, JSON.stringify(result));
  assert.equal(result.navigationConfirmed === true, passed);
  if (!passed) assert.equal(result.failure.failureReason, 'number' in state ? 'fixture-identity-changed' : 'navigation-unconfirmed');
  if (passed) assert.equal(result.cleanupConfirmed, true);
});

for (const [name, change] of [
  ['a non-unique name', request => { request.target = '/fixture/Finder-probe'; request.token = 'Finder-probe'; }],
  ['less than 64 bits', request => { request.target = '/fixture/Finder-probe-0123456789abcde'; request.token = 'Finder-probe-0123456789abcde'; }],
  ['a target outside its fixture root', request => { request.fixtureRoot = '/other-bank'; }],
  ['the fixture root itself', request => { request.fixtureRoot = request.target; }],
  ['a root with a shared prefix', request => { request.fixtureRoot = '/fixtur'; }],
  ['a mismatched token', request => { request.token = 'other'; }],
]) test(`a documentless title cannot prove ${name}`, () => {
  const f = fixture(), submit = f.api.submitFolder;
  change(f.request);
  f.api.submitFolder = (...args) => {
    submit(...args); f.owned.document = ''; f.owned.url = '';
    f.owned.title = f.request.target.split('/').at(-1);
  };
  const result = f.run();
  assert.equal(result.passed, false);
  assert.equal(result.failure.failureReason, 'navigation-unconfirmed');
  assert.equal(result.navigationConfirmed, undefined);
  assert.equal(result.cleanupConfirmed, true, 'creation ownership permits closing despite unconfirmed navigation');
  assert.deepEqual(f.closed, [f.owned]);
});

test('navigation refuses a replacement AX window with the same number and location', () => {
  const f = fixture(), submit = f.api.submitFolder, windows = f.api.windows;
  let navigated = false;
  f.api.submitFolder = (...args) => { submit(...args); navigated = true; };
  f.api.windows = () => windows().map(w => navigated && w === f.owned ? { ...w } : w);
  const result = f.run();
  assert.equal(result.passed, false);
  assert.equal(result.navigationConfirmed, undefined);
});

test('navigation rechecks the window number after reading the folder metadata', () => {
  const f = fixture(), text = f.api.text;
  f.api.text = (window, attribute) => {
    const value = text(window, attribute);
    if (attribute === 'AXDocument' && value === '/fixture/Finder-probe-0123456789abcdef') window.number = 72;
    return value;
  };
  const result = f.run();
  assert.equal(result.passed, false);
  assert.equal(result.navigationConfirmed, undefined);
  assert.equal(result.failure.failureReason, 'fixture-identity-changed');
});

test('rejected navigation metadata is available only in local debug output', () => {
  const f = fixture({ failure: 'location' }), diagnostics = [];
  f.clock.debugFailure = (step, error) => f.source.finderProbeDebug(step, error, text => diagnostics.push(text));
  const result = f.run();
  assert.equal(result.passed, false);
  assert.ok(diagnostics.some(text => text.includes('step=navigation metadata') && text.includes('/owner/private')));
  assert.doesNotMatch(JSON.stringify([result, f.events]), /owner\/private/);
});

test('setup probe records an extra owner window and closes only its created reference', () => {
  const f = fixture({ extra: true }), result = f.run();
  assert.equal(result.passed, false);
  assert.equal(result.snapshots.at(-1).ownerWindowsEqual, false);
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(f.closed, [f.owned]);
  assert.ok(f.current().includes(f.unrecorded));
});

test('dry run performs no lock, hold, filesystem or process work', async () => {
  const nope = () => assert.fail('dry run contacted a live dependency');
  const result = await runFinderProbe({ dryRun: true }, { hold: nope, lock: nope, run: nope });
  assert.equal(result.dryRun, true);
  assert.equal(result.opensWindows, false);
  assert.equal(result.writesFiles, false);
});

test('probe refuses missing owner-away authorization and live holds before locking', async () => {
  const lock = () => assert.fail('must refuse before lock');
  await assert.rejects(runFinderProbe({}, { lock }), /owner-away/);
  await assert.rejects(runFinderProbe({ ownerAway: true }, { hold: () => true, lock }), /Live hold/);
});

for (const confirmed of [false, true]) test(`probe runner ${confirmed ? 'releases' : 'keeps'} its synthetic lock after cleanup receipt`, async t => {
  let releases = 0, calls = 0;
  const result = await runFinderProbe({ ownerAway: true }, {
    hold: () => false,
    tempRoot: tmpdir(),
    lock: async () => async () => { releases++; },
    run: async (command, args, options) => {
      calls++;
      assert.equal(command, '/usr/bin/osascript');
      assert.ok(args[2].endsWith('/bench/real-fixture.js'));
      const request = JSON.parse(args[3]);
      trackTemp(request.fixtureRoot); t.after(() => rmSync(request.fixtureRoot, { recursive: true, force: true }));
      assert.equal(request.mode, 'finder-probe');
      assert.equal(request.ownerAway, true);
      assert.equal(request.stopOnLiveHold, true);
      assert.match(request.target.slice(request.fixtureRoot.length), /^\/Finder-probe-[0-9a-f]{16}$/);
      assert.equal(options.signal, undefined, 'cancellation is delivered through the control file for host cleanup');
      return { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify({ probe: 'finder-setup', passed: confirmed, cleanupConfirmed: confirmed }) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(releases, confirmed ? 1 : 0);
  assert.equal(result.liveLockKept, !confirmed);
  assert.equal(result.passed, confirmed);
  assert.equal(JSON.parse(readFileSync(result.receiptPath, 'utf8')).liveLockKept, !confirmed);
});

test('probe cancellation asks its existing host to clean up before collecting it', async t => {
  const controller = new AbortController(); let releases = 0;
  const result = await runFinderProbe({ ownerAway: true, signal: controller.signal }, {
    hold: () => false, tempRoot: tmpdir(), lock: async () => async () => { releases++; },
    run: async (_command, args) => {
      const request = JSON.parse(args[3]);
      trackTemp(request.fixtureRoot); t.after(() => rmSync(request.fixtureRoot, { recursive: true, force: true }));
      controller.abort();
      assert.equal(JSON.parse(readFileSync(request.control, 'utf8')).cancelled, true);
      return { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify({ probe: 'finder-setup', passed: true, cleanupConfirmed: true }) };
    },
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.passed, false);
  assert.equal(releases, 1);
});

for (const failure of ['uncollected', 'bad-exit', 'missing-receipt']) test(`probe keeps its synthetic lock after ${failure}`, async t => {
  let releases = 0;
  const result = await runFinderProbe({ ownerAway: true }, {
    hold: () => false, tempRoot: tmpdir(), lock: async () => async () => { releases++; },
    run: async (_command, args) => {
      const request = JSON.parse(args[3]);
      trackTemp(request.fixtureRoot); t.after(() => rmSync(request.fixtureRoot, { recursive: true, force: true }));
      return { groupClean: failure !== 'uncollected', exit: { code: failure === 'bad-exit' ? 1 : 0 },
        stdout: failure === 'missing-receipt' ? '' : JSON.stringify({ probe: 'finder-setup', passed: true, cleanupConfirmed: true }) };
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.liveLockKept, true);
  assert.equal(releases, 0);
});

test('native probe route uses one existing Finder incarnation without a launch or relaunch path', () => {
  const f = fixture(), target = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder' };
  const native = value => value;
  Object.assign(native, {
    AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: bundle => {
      assert.equal(bundle, 'com.apple.finder'); return { count: 1, objectAtIndex: () => target };
    } },
    NSData: { dataWithContentsOfFile: () => ({ isNil: () => false }) },
    NSString: { alloc: { initWithDataEncoding: () => '{"cancelled":false}' } },
  });
  f.source.$ = native; f.source.ObjC.unwrap = value => value;
  f.source.finderProcessBirth = pid => { assert.equal(pid, 42); return '1.000000'; };
  f.api.app = process => { assert.equal(process, target); return {}; };
  f.source.nativeAX = () => f.api;
  f.source.ensureFinderAX = () => assert.fail('probe must never enter Finder restart recovery');
  const root = ['', 'private', 'tmp', 'sleight-finder-probe-OFFLINE'].join('/');
  const result = JSON.parse(f.source.runFinderSetupProbe({ bundle: 'com.apple.finder', ownerAway: true, stopOnLiveHold: true,
    fixtureRoot: root, target: root + '/Finder-probe-0123456789abcdef', control: root + '/control.json' }, () => {}));
  assert.equal(result.passed, true);
  assert.deepEqual(f.closed, [f.owned]);
});

for (const suffix of ['', '/Finder-probe', '/Finder-probe-0123456789abcde',
  '/Finder-probe-0123456789abcdef/Other', '/Other-0123456789abcdef', '/../Finder-probe-0123456789abcdef'])
test(`native probe refuses an invalid target suffix ${JSON.stringify(suffix)} before app access`, () => {
  const f = fixture(), root = ['', 'private', 'tmp', 'sleight-finder-probe-OFFLINE'].join('/');
  f.source.$ = new Proxy({}, { get: () => assert.fail('invalid target must not contact a native API') });
  assert.throws(() => f.source.runFinderSetupProbe({ bundle: 'com.apple.finder', ownerAway: true, stopOnLiveHold: true,
    fixtureRoot: root, target: root + suffix, control: root + '/control.json' }, () => {}), /Invalid Finder probe request/);
});

for (const when of ['before-release', 'after-release']) test(`receipt failure ${when} reports the actual synthetic lock state`, async t => {
  let releases = 0, writes = 0;
  const operation = runFinderProbe({ ownerAway: true }, {
    hold: () => false, tempRoot: tmpdir(), lock: async () => async () => { releases++; },
    persist: () => {
      writes++;
      if (when === 'before-release' || writes === 2) throw new Error('offline receipt failure');
    },
    run: async (_command, args) => {
      const request = JSON.parse(args[3]);
      trackTemp(request.fixtureRoot); t.after(() => rmSync(request.fixtureRoot, { recursive: true, force: true }));
      return { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify({ probe: 'finder-setup', passed: true, cleanupConfirmed: true }) };
    },
  });
  if (when === 'before-release') { await assert.rejects(operation, /live lock kept/); assert.equal(releases, 0); }
  else {
    const result = await operation;
    assert.equal(result.liveLockKept, false);
    assert.equal(result.receiptUpdateFailed, true);
    assert.equal(result.passed, false);
    assert.equal(releases, 1);
  }
});

for (const debug of [false, true]) test(`raw setup and cleanup failures use only the diagnostic channel (debug=${debug})`, () => {
  const f = fixture(), diagnostics = [];
  f.clock.debugFailure = debug ? (step, error) => f.source.finderProbeDebug(step, error, text => diagnostics.push(text)) : null;
  const setupError = new Error('local setup: Recents'), cleanupError = new Error('local cleanup: Recents');
  f.api.menu = () => { throw setupError; };
  f.api.closeButton = () => { throw cleanupError; };
  const originalMenu = f.api.menu, result = f.run();
  assert.equal(result.passed, false);
  assert.equal(result.panel.commandAttempted, false);
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.failure.failureReason, 'unclassified');
  assert.equal(result.cleanupFailure.failureReason, 'unclassified');
  assert.doesNotMatch(JSON.stringify([result, f.events]), /local setup|local cleanup|stack:/);
  assert.equal(f.api.menu, originalMenu, 'probe restores instrumented methods');
  if (debug) {
    assert.ok(diagnostics.some(text => text.includes('step=setup.menu') && text.includes(setupError.message) && text.includes(setupError.stack)));
    assert.ok(diagnostics.some(text => text.includes('step=cleanup.closeButton') && text.includes(cleanupError.message) && text.includes(cleanupError.stack)));
  } else assert.deepEqual(diagnostics, []);
});

test('debug reports a cleanup refusal that returns instead of throwing', () => {
  const f = fixture({ failure: 'location' }), diagnostics = [];
  f.clock.debugFailure = (step, error) => diagnostics.push([step, error.message]);
  const result = f.run();
  assert.equal(result.cleanupConfirmed, false);
  assert.ok(diagnostics.some(([step]) => step === 'cleanup.recoverSetup'));
});

test('a failed final snapshot cannot pass the probe after a confirmed fixture close', () => {
  const f = fixture(), inventory = f.api.windows;
  let closed = false;
  f.api.emit = event => { if (event.stage === 'finder-cleanup') closed = true; };
  f.api.windows = () => { if (closed) throw new Error('offline final snapshot failed'); return inventory(); };
  const result = f.run();
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.cleanupFailure.failureReason, 'unclassified');
  assert.equal(result.passed, false);
  assert.deepEqual(f.closed, [f.owned]);
});

test('a failed diagnostic writer or error getter cannot replace the original failure', () => {
  const f = fixture(), error = {};
  for (const key of ['message', 'stack']) Object.defineProperty(error, key, { get() { throw new Error('getter failed'); } });
  const messages = [];
  assert.doesNotThrow(() => f.source.finderProbeDebug('offline', error, text => messages.push(text)));
  assert.match(messages[0], /message: unavailable\nstack: unavailable/);
  assert.doesNotThrow(() => f.source.finderProbeDebug('offline', new Error('original'), () => { throw new Error('stderr failed'); }));
});

for (const debug of [false, true]) test(`runner forwards helper debug only to stderr and preserves both sanitized receipt writes (debug=${debug})`, async t => {
  const diagnostics = [], persisted = [], f = fixture(), local = 'local-only error and stack for Recents\n';
  f.api.menu = () => { throw new Error('offline pre-command failure'); };
  let releases = 0;
  const result = await runFinderProbe({ ownerAway: true, debug }, {
    hold: () => false, tempRoot: tmpdir(), stderr: text => diagnostics.push(text),
    lock: async () => async () => { releases++; },
    persist: receipt => persisted.push(JSON.stringify(receipt)),
    run: async (_command, args) => {
      const request = JSON.parse(args[3]);
      trackTemp(request.fixtureRoot); t.after(() => rmSync(request.fixtureRoot, { recursive: true, force: true }));
      assert.equal(request.debug, debug);
      return { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify(f.run()), stderr: local };
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.panel.commandAttempted, false);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.liveLockKept, false);
  assert.deepEqual(f.closed, [f.owned]);
  assert.equal(releases, 1);
  assert.equal(persisted.length, 2);
  assert.doesNotMatch(JSON.stringify([result, persisted]), /local-only|offline pre-command|stack:/);
  assert.deepEqual(diagnostics, debug ? [local] : []);
});

test('debug reports a runner failure before authorization without starting a helper', async () => {
  const diagnostics = [];
  await assert.rejects(runFinderProbe({ debug: true }, { stderr: text => diagnostics.push(text) }), /owner-away/);
  assert.match(diagnostics[0], /step=authorization/);
  assert.match(diagnostics[0], /message: Finder probe requires explicit --owner-away/);
  assert.match(diagnostics[0], /stack: Error:/);
});

for (const debug of [false, true]) test(`native probe writes raw failure only to local stderr (debug=${debug})`, () => {
  const f = fixture(), diagnostics = [], target = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder' };
  const error = new Error('local Go-menu error for Recents');
  f.api.menu = () => { throw error; };
  const native = value => ({ dataUsingEncoding: () => value });
  Object.assign(native, {
    AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => target }) },
    NSData: { dataWithContentsOfFile: () => ({ isNil: () => false }) },
    NSString: { alloc: { initWithDataEncoding: () => '{"cancelled":false}' } },
    NSFileHandle: { fileHandleWithStandardError: { writeData: text => diagnostics.push(text) } },
  });
  f.source.$ = native; f.source.ObjC.unwrap = value => value;
  f.source.finderProcessBirth = () => '1.000000';
  f.api.app = () => ({});
  f.source.nativeAX = () => f.api;
  const root = ['', 'private', 'tmp', 'sleight-finder-probe-OFFLINE'].join('/');
  const stdout = f.source.runFinderSetupProbe({ bundle: 'com.apple.finder', ownerAway: true, stopOnLiveHold: true,
    debug, fixtureRoot: root, target: root + '/Finder-probe-0123456789abcdef', control: root + '/control.json' }, () => {});
  const result = JSON.parse(stdout);
  assert.equal(result.panel.commandAttempted, false);
  assert.equal(result.cleanupConfirmed, true);
  assert.doesNotMatch(stdout, /local Go-menu|stack:/);
  if (debug) assert.ok(diagnostics.some(text => text.includes('step=setup.menu') && text.includes(error.message) && text.includes(error.stack)));
  else assert.deepEqual(diagnostics, []);
});

test('menu cancellation diagnostics include the swallowed cleanup error without putting it in a receipt', () => {
  const f = fixture(), diagnostics = [], error = new Error('local cancellation failed');
  assert.throws(() => f.source.chooseFileMenu({}, ['Go'], {
    tracksOpeningAttempt: true, press: (_element, attempt) => attempt(), children: () => [],
    cancel: () => { throw error; }, debugFailure: (step, failure) => diagnostics.push([step, failure]),
  }), /menu item unavailable/);
  assert.deepEqual(diagnostics, [['menu cancellation', error]]);
});
