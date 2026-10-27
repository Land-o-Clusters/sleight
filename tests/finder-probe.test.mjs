import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { runFinderProbe } from '../bench/finder-probe.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function fixture({ owners = 1, failure, extra = false } = {}) {
  const source = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), source);
  const desktop = { role: 'AXScrollArea' }, replacement = { role: 'AXScrollArea' };
  const ownerWindows = Array.from({ length: owners }, () => ({ role: 'AXWindow' }));
  const owned = { role: 'AXWindow', document: '', title: 'Recents' }, unrecorded = { role: 'AXWindow' };
  const request = { bundle: 'com.apple.finder', mode: 'folder', target: '/fixture/Finder-probe', fixtureRoot: '/fixture', token: 'Finder-probe' };
  let current = [desktop, ...ownerWindows], time = 0;
  const closed = [], events = [];
  const api = {
    windows: () => [...current], finderRole: w => w.role, equal: (a, b) => !!a && a === b,
    exists: w => current.includes(w), path: value => value,
    text: (w, attribute) => {
      assert.equal(w, owned, 'never read existing owner window titles or documents');
      return attribute === 'AXDocument' ? w.document : attribute === 'AXTitle' ? w.title : '';
    },
    fileMenu: (_app, _titles, validate) => { validate(); current = [replacement, ...ownerWindows, owned]; },
    finderFolderGuard: (_app, w) => { if (failure === 'early' && w) throw new Error('Finder folder window lost focus'); },
    menu: (_app, _name, _titles, validate) => validate(), folderSheet: () => ({}),
    submitFolder: (_w, _sheet, target, validate) => {
      validate(); owned.document = failure === 'location' ? '/owner/private' : target; owned.title = 'Finder-probe';
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
  assert.equal(result.snapshots[2].createdWindow.document, '/fixture/Finder-probe');
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
    hold: () => false, lock: async () => async () => { releases++; },
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
    hold: () => false, lock: async () => async () => { releases++; },
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
  const root = '/private/tmp/sleight-finder-probe-OFFLINE';
  const result = JSON.parse(f.source.runFinderSetupProbe({ bundle: 'com.apple.finder', ownerAway: true, stopOnLiveHold: true,
    fixtureRoot: root, target: root + '/Finder-probe', control: root + '/control.json' }, () => {}));
  assert.equal(result.passed, true);
  assert.deepEqual(f.closed, [f.owned]);
});

for (const when of ['before-release', 'after-release']) test(`receipt failure ${when} reports the actual synthetic lock state`, async t => {
  let releases = 0, writes = 0;
  const operation = runFinderProbe({ ownerAway: true }, {
    hold: () => false, lock: async () => async () => { releases++; },
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
