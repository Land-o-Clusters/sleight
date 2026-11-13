import test from 'node:test';
import assert from 'node:assert/strict';
import * as hygiene from '../bench/pass-hygiene.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const app = (pid, start = pid) => ({ pid, start, bundle: `org.fixture.${pid}` });
const win = (id, pid, start = pid) => ({ ...app(pid, start), id, title: `fixture-${id}`, onScreen: true });
const fixtureNames = ['fixture-11', 'fixture-12', 'fixture-21', 'fixture-40'];
const baseline = { apps: [app(1), app(2)], windows: [win(10, 1), { ...win(20, 2), onScreen: false }] };
const current = { apps: [...baseline.apps, app(3), app(4)], windows: [...baseline.windows, win(11, 1), win(21, 2), win(30, 3), win(40, 4)] };

test('quits only proven cold launches; closes only new windows of other apps', () => {
  assert.deepEqual(hygiene.planWindows(baseline, current, [app(3), app(1)], current.apps.map(app => app.bundle), [], new Map(), { fixtureNames }), [
    { ...win(11, 1), action: 'close', fixtures: { fixtureNames } }, { ...win(21, 2), action: 'close', fixtures: { fixtureNames } },
    { ...app(3), action: 'quit' }, { ...win(40, 4), action: 'close', fixtures: { fixtureNames } },
  ]);
});

test('PID reuse does not inherit launch ownership and window IDs are process-scoped', () => {
  const after = { apps: [app(1, 100)], windows: [win(10, 1, 100)] };
  assert.deepEqual(hygiene.planWindows(baseline, after, [app(1)]), [{ ...win(10, 1, 100), action: 'keep' }]);
});

test('dry run prints every planned action without acting or stopping a daemon', async () => {
  const calls = [], logs = [];
  const result = await hygiene.finishWindows(baseline, {
    fixtureNames, touchedApps: current.apps.map(app => app.bundle), snapshot: async () => current, act: async item => calls.push(item), launched: [app(3)],
    dryRun: true, log: line => logs.push(line), daemons: [{ stop: () => calls.push('stop') }],
  });
  assert.equal(calls.length, 0);
  assert.equal(logs.filter(line => /would (close|quit|stop)/.test(line)).length, 5);
  assert.equal(result.planned.length, 4);
});

test('a refused quit and close are left in results; no prompt response is attempted', async () => {
  const calls = [];
  const result = await hygiene.finishWindows(baseline, {
    fixtureNames, touchedApps: current.apps.map(app => app.bundle), snapshot: async () => current, launched: [app(3)],
    act: async item => { calls.push(item.action); throw new Error('prompt or identity changed'); }, log() {},
  });
  assert.deepEqual(calls, ['close', 'close', 'quit', 'close']);
  assert.equal(result.leftWindows.length, 4);
  assert.equal(result.errors.length, 4);
});

test('an owned app still running with no window after Quit is reported', async () => {
  let reads = 0;
  const result = await hygiene.finishWindows({ apps: [], windows: [] }, {
    fixtureNames, touchedApps: current.apps.map(app => app.bundle), snapshot: async () => ++reads === 1 ? { apps: [app(3)], windows: [win(30, 3)] } : { apps: [app(3)], windows: [] },
    launched: [app(3)], act: async () => {}, log() {},
  });
  assert.deepEqual(result.leftWindows, [{ ...app(3), reason: 'still running after Quit' }]);
});

test('a proven cold-launched app whose fixture window already closed still gets a gentle Quit', () => {
  assert.deepEqual(hygiene.planWindows({ apps: [], windows: [] }, { apps: [app(3)], windows: [] }, [app(3)]), [{ ...app(3), action: 'quit' }]);
});

test('an observation stop prevents every later action, including in other apps', async () => {
  let checks = 0;
  const result = await hygiene.finishWindows(baseline, { fixtureNames, touchedApps: current.apps.map(app => app.bundle), snapshot: async () => current,
    beforeAction: async () => { checks++; throw new Error('permission prompt'); }, act: () => assert.fail('blocked'), log() {} });
  assert.equal(checks, 1); assert.equal(result.leftWindows.length, 4);
});

test('permission, user interruption and uncollected drivers block window actions but collect owned daemons', async () => {
  const calls = [];
  const result = await hygiene.finishWindows(baseline, {
    fixtureNames, touchedApps: current.apps.map(app => app.bundle), snapshot: async () => current, blocked: true, act: () => assert.fail('blocked'), log() {},
    daemons: [{ stop: async () => calls.push('owned stop') }],
  });
  assert.deepEqual(calls, ['owned stop']);
  assert.equal(result.leftWindows.length, 4);
});

test('native adapter refuses an uncollected compiler or helper before claiming a baseline', async t => {
  const cacheDir = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-compile-')));
  await assert.rejects(hygiene.beginPassHygiene({ cacheDir, run: async () => ({ stdout: '{}', groupClean: false, exit: { code: 0 } }) }), /group cleanup unconfirmed/);
  const helperOnly = async (command, args) => {
    if (command === '/usr/bin/xcrun' && args[1] === '--version') return { stdout: 'Swift test version', groupClean: true, exit: { code: 0 } };
    if (command === '/usr/bin/xcrun') { writeFileSync(args.at(-1), 'fake'); return { stdout: '{}', groupClean: true, exit: { code: 0 } }; }
    return { stdout: '{}', groupClean: false, exit: { code: 0 } };
  };
  await assert.rejects(hygiene.beginPassHygiene({ cacheDir, run: helperOnly }),
    error => /group cleanup unconfirmed/.test(error.message) && error.receiptsOnly === undefined, 'an uncollected baseline helper gets no receipts-only handle');
});

test('native adapter checks its baseline and routes every helper through owned process collection', async t => {
  const cacheDir = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-native-'))), calls = [];
  let malformed = true;
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/xcrun' && args[1] === '--version') return { stdout: 'Swift test version', groupClean: true, exit: { code: 0 } };
    if (command === '/usr/bin/xcrun') writeFileSync(args.at(-1), 'fake compiled helper');
    const request = command === '/usr/bin/xcrun' ? {} : JSON.parse(args[0]);
    return { stdout: JSON.stringify(request.action === 'snapshot' ? malformed ? {} : baseline : {}), groupClean: true, exit: { code: 0 } };
  };
  await assert.rejects(hygiene.beginPassHygiene({ cacheDir, run }), /snapshot unavailable or incomplete/);
  malformed = false;
  const pass = await hygiene.beginPassHygiene({ cacheDir, run });
  const result = await pass.finish({ dryRun: true, log() {} });
  assert.deepEqual(result.planned, []);
  assert.equal(calls.filter(call => call.command === '/usr/bin/xcrun' && call.args[1] !== '--version').length, 1, 'compiled source hash is cached');
  assert.ok(calls.every(call => call.options.timeoutMs > 0));
});

test('window control reuses the shared source-hash binary and module cache across rounds', async t => {
  const home = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-shared-cache-'))), compiles = [], helpers = [];
  const run = async (command, args) => {
    if (command === '/usr/bin/xcrun' && args[1] === '--version') return { stdout: 'Swift test version', groupClean: true, exit: { code: 0 } };
    if (command === '/usr/bin/xcrun') {
      compiles.push(args);
      writeFileSync(args.at(-1), 'fake compiled helper');
    } else helpers.push(command);
    return { stdout: JSON.stringify(baseline), groupClean: true, exit: { code: 0 } };
  };
  for (let round = 0; round < 2; round++) {
    const control = await hygiene.beginWindowControl({ home, run, includeFloating: true });
    await control.snapshot();
  }
  assert.equal(compiles.length, 1);
  assert.deepEqual(compiles[0].slice(0, 3), ['swiftc', '-module-cache-path', join(home, 'Library/Caches/sleight-bench/swift-module-cache')]);
  assert.equal(helpers[0], helpers[1]);
  assert.equal(helpers[0].startsWith(join(home, 'Library/Caches/sleight-bench/window-control/pass-hygiene-')), true);
});

test('window control rebuilds on a swiftc version change and reuses each toolchain cache', async t => {
  const home = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-toolchain-'))), binaries = [];
  let version = 'Apple Swift version 6.2\nTarget: arm64-apple-macosx26.0\n', compiles = 0;
  const run = async (command, args) => {
    if (command === '/usr/bin/xcrun' && args[1] === '--version') {
      return { stdout: version, groupClean: true, exit: { code: 0 } };
    }
    if (command === '/usr/bin/xcrun') { compiles++; writeFileSync(args.at(-1), 'compiled'); }
    else binaries.push(command);
    return { stdout: JSON.stringify(baseline), groupClean: true, exit: { code: 0 } };
  };
  const read = async () => (await hygiene.beginWindowControl({ home, run })).snapshot();
  await read(); await read();
  assert.equal(compiles, 1);
  version = 'Apple Swift version 6.3\nTarget: arm64-apple-macosx26.0\n';
  await read(); await read();
  assert.equal(compiles, 2);
  assert.equal(binaries[0], binaries[1]);
  assert.notEqual(binaries[1], binaries[2]);
  assert.equal(binaries[2], binaries[3]);
});

test('unrelated new windows are listed but only touched fixture apps are closed', async () => {
  const calls = [];
  const result = await hygiene.finishWindows(baseline, { snapshot: async () => current,
    fixtureNames, touchedApps: [app(1).bundle], act: async item => calls.push(item), log() {} });
  assert.deepEqual(calls, [{ ...win(11, 1), action: 'close', fixtures: { fixtureNames, fixturePaths: [] } }]);
  assert.equal(result.leftWindows.length, 4);
});

test('blocked passes still gently quit proven launches while window closes stay plan-only', async () => {
  const calls = [];
  await hygiene.finishWindows(baseline, { snapshot: async () => current, launched: [app(3)],
    blocked: true, beforeAction: () => assert.fail('no window observation on a blocked quit'),
    act: async item => calls.push(item), log() {} });
  assert.deepEqual(calls, [{ ...app(3), action: 'quit' }]);
});

test('snapshot errors preserve known plans and leftovers and still quit proven launches', async () => {
  let reads = 0;
  const calls = [];
  const result = await hygiene.finishWindows(baseline, { launched: [app(3)], fixtureNames, touchedApps: [app(1).bundle],
    snapshot: async () => { if (++reads > 1) throw new Error('snapshot timeout'); return current; },
    act: async item => calls.push(item), log() {} });
  assert.equal(result.planned.length, 4);
  assert.equal(result.leftWindows.length, 4);
  assert.match(result.errors.join(), /snapshot timeout/);
  const failed = await hygiene.finishWindows(baseline, { launched: [app(3)],
    snapshot: async () => { throw new Error('initial timeout'); }, act: async item => calls.push(item), log() {} });
  assert.equal(calls.filter(item => item.action === 'quit').length, 2);
  assert.match(failed.errors.join(), /initial timeout/);
});

test('a missing AX window skips a phantom without stopping real windows or listing the phantom', async () => {
  const windows = [{ ...win(11, 1), onScreen: false }, win(12, 1)], calls = [];
  const result = await hygiene.finishWindows(baseline, { snapshot: async () => ({ apps: baseline.apps, windows }),
    fixtureNames, touchedApps: [app(1).bundle], act: async item => { calls.push(item.id); return item.id === 11 ? { skipped: 'no-ax-window' } : { closed: true }; }, log() {} });
  assert.deepEqual(calls, [11, 12]);
  assert.deepEqual(result.leftWindows.map(item => item.id), [12]);
});

test('a sheet reported after a successful close stops the app before another close', async () => {
  const calls = [];
  const result = await hygiene.finishWindows(baseline, { snapshot: async () => ({ apps: baseline.apps, windows: [win(11, 1), win(12, 1)] }),
    fixtureNames, touchedApps: [app(1).bundle], act: async item => { calls.push(item.id); return { closed: true, dialog: true }; }, log() {} });
  assert.deepEqual(calls, [11]);
  assert.ok(result.leftWindows.some(item => item.reason === 'application dialog'));
});

test('native adapter registers default fixture launches and leaves pre-existing apps unowned', async t => {
  const cacheDir = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-launch-')));
  let state = baseline;
  const run = async (command, args) => {
    if (command === '/usr/bin/xcrun' && args[1] === '--version') return { stdout: 'Swift test version', groupClean: true, exit: { code: 0 } };
    if (command === '/usr/bin/xcrun') writeFileSync(args.at(-1), 'fake');
    return { stdout: JSON.stringify(state), groupClean: true, exit: { code: 0 } };
  };
  const pass = await hygiene.beginPassHygiene({ cacheDir, run });
  assert.equal(typeof pass.trackLaunch, 'function');
  await pass.trackLaunch([app(3).bundle, app(1).bundle], async () => { state = current; });
  const result = await pass.finish({ dryRun: true, log() {} });
  assert.ok(result.planned.some(item => item.action === 'quit' && item.pid === 3));
  assert.ok(!result.planned.some(item => item.action === 'quit' && item.pid === 1));
});

test('arm descendants are touched and only fresh exact arm daemons receive stop actions', async () => {
  const proc = (pid, ppid, start, path) => ({ pid, ppid, start, path });
  const before = { ...baseline, at: 100, processes: [proc(8, 1, 50, '/arm/daemon')] };
  const after = { apps: [...baseline.apps, app(3), app(4)], windows: [win(30, 3), win(40, 4)],
    processes: [proc(8, 1, 50, '/arm/daemon'), proc(9, 1, 101, '/arm/daemon'), proc(3, 20, 3, '/app'), proc(20, 1, 101, '/arm/client')] };
  const calls = [];
  await hygiene.finishWindows(before, { snapshot: async () => after, armPids: [20], daemonPaths: ['/arm/daemon'],
    act: async item => calls.push(item), log() {} });
  assert.deepEqual(calls.map(item => [item.action, item.pid]), [['stop', 9], ['close', 3]]);
});

test('arm sampling retains descendant identity after reparenting and rejects a reused PID', async t => {
  const cacheDir = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-arm-'))), actions = [];
  let state = { ...baseline, processes: [], at: 100 };
  const run = async (command, args) => {
    if (command === '/usr/bin/xcrun' && args[1] === '--version') return { stdout: 'Swift test version', groupClean: true, exit: { code: 0 } };
    if (command === '/usr/bin/xcrun') writeFileSync(args.at(-1), 'fake');
    else if (JSON.parse(args[0]).action !== 'snapshot') { actions.push(JSON.parse(args[0])); return { stdout: '{}', groupClean: true, exit: { code: 0 } }; }
    return { stdout: JSON.stringify(state), groupClean: true, exit: { code: 0 } };
  };
  const pass = await hygiene.beginPassHygiene({ cacheDir, run });
  assert.equal(typeof pass.recordArm, 'function');
  state = { apps: [...baseline.apps, app(3)], windows: [win(30, 3)],
    processes: [{ pid: 20, ppid: 1, start: 101 }, { pid: 3, ppid: 20, start: 3 }] };
  pass.recordArm(20);
  await pass.betweenTasks();
  state.processes = [{ pid: 3, ppid: 1, start: 3 }];
  await pass.finish({ log() {} });
  assert.deepEqual(actions.map(item => [item.action, item.pid]), [['close', 3]]);
  actions.length = 0;
  state = { apps: [app(3, 200)], windows: [win(30, 3, 200)], processes: [{ pid: 3, ppid: 1, start: 200 }] };
  await pass.finish({ log() {} });
  assert.deepEqual(actions, []);
});

test('an unmatched on-screen window stays listed and does not suppress the next real close', async () => {
  const calls = [], windows = [win(11, 1), win(12, 1)];
  const result = await hygiene.finishWindows(baseline, { fixtureNames, touchedApps: [app(1).bundle],
    snapshot: async () => ({ apps: baseline.apps, windows }),
    act: async item => { calls.push(item.id); return { skipped: 'no-ax-window' }; }, log() {} });
  assert.deepEqual(calls, [11, 12]);
  assert.deepEqual(result.leftWindows.map(item => item.id), [11, 12]);
});

test('daemon dry run preserves new and pre-existing helpers without signaling', async () => {
  const before = { apps: [], windows: [], at: 100, processes: [{ pid: 8, start: 90, path: '/arm/daemon' }] };
  const after = { ...before, processes: [...before.processes, { pid: 9, start: 101, path: '/arm/daemon' }, { pid: 10, start: 102, path: '/owner/helper' }] };
  const result = await hygiene.finishWindows(before, { snapshot: async () => after, dryRun: true,
    daemonPaths: ['/arm/daemon'], act: () => assert.fail('dry run'), log() {} });
  assert.deepEqual(result.planned.map(item => [item.action, item.pid]), [['stop', 9]]);
});


test('a phantom that becomes visible is retained in the final leftover report', async () => {
  let reads = 0;
  const result = await hygiene.finishWindows(baseline, { fixtureNames, touchedApps: [app(1).bundle],
    snapshot: async () => ({ apps: baseline.apps, windows: [{ ...win(11, 1), onScreen: ++reads > 1 }] }),
    act: async () => ({ skipped: 'no-ax-window' }), log() {} });
  assert.deepEqual(result.leftWindows.map(item => item.id), [11]);
});


test('pre-existing touched apps retain owner windows and close only exact fixture titles or paths', () => {
  const after = { apps: baseline.apps, windows: [
    { ...win(11, 1), title: 'Owner folder' },
    { ...win(12, 1), title: 'Files-abc' },
    { ...win(13, 1), document: 'file:///pass/abc/Calculation.txt' },
    { ...win(14, 1), document: 'file:///pass/abc-other/notes.txt' },
  ] };
  const plan = hygiene.planWindows(baseline, after, [], [app(1).bundle], [], new Map(),
    { fixturePaths: ['/pass/abc'], fixtureNames: ['Files-abc'] });
  assert.deepEqual(plan.map(item => [item.id, item.action]), [[11, 'keep'], [12, 'close'], [13, 'close'], [14, 'keep']]);
});

async function nativeFixture(t, snapshot) {
  const cacheDir = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-boundary-')));
  return hygiene.beginPassHygiene({ cacheDir, run: async (command, args) => {
    if (command === '/usr/bin/xcrun' && args[1] === '--version') return { stdout: 'Swift test version', groupClean: true, exit: { code: 0 } };
    if (command === '/usr/bin/xcrun') { writeFileSync(args.at(-1), 'fake'); return { stdout: '{}', groupClean: true, exit: { code: 0 } }; }
    const request = JSON.parse(args[0]);
    return { stdout: JSON.stringify(request.action === 'snapshot' ? await snapshot() : {}), groupClean: true, exit: { code: 0 } };
  } });
}

test('arm registration and launch tracking never snapshot inside a timed task', async t => {
  let timed = false, reads = 0, timedReads = 0;
  const pass = await nativeFixture(t, () => { if (timed) timedReads++; reads++; return baseline; });
  try {
    timed = true;
    await pass.recordArm(20);
    await pass.trackLaunch([app(3).bundle], async () => {
      await new Promise(resolve => setTimeout(resolve, 1100));
    });
    assert.equal(timedReads, 0, 'snapshot inside timed task');
    assert.equal(reads, 1, 'only the pass baseline has been sampled');
  } finally { timed = false; await pass.finish({ dryRun: true, log() {} }); }
});

test('snapshot failures never skip a setup and retain only the first twenty tracking errors', async t => {
  let fail = false, setups = 0;
  const pass = await nativeFixture(t, () => { if (fail) throw new Error('inventory offline'); return baseline; });
  fail = true;
  await pass.trackLaunch([app(3).bundle], async () => { setups++; });
  for (let i = 0; i < 25; i++) await pass.betweenTasks();
  const result = await pass.finish({ dryRun: true, log() {} });
  assert.equal(setups, 1);
  assert.equal(result.trackingErrors.length, 20);
  assert.equal(result.trackingErrorCount, 25);
  assert.match(result.errors.join(), /inventory offline/);
});

test('a leftover Save sheet is listed once at pass end with an owner instruction', async () => {
  const sheet = { ...win(10, 1), dialog: true }, logs = [];
  const result = await hygiene.finishWindows(baseline, {
    snapshot: async () => ({ apps: baseline.apps, windows: [sheet] }),
    act: () => assert.fail('baseline document must never be closed'), log: line => logs.push(line),
  });
  assert.equal(result.leftWindows.length, 1);
  assert.equal(result.leftWindows[0].id, 10);
  assert.match(result.leftWindows[0].instruction, /Resolve.*dialog.*before.*pass/i);
  assert.equal(logs.filter(line => line.startsWith('leftWindows')).length, 1);
});


test('a failed boundary cannot grant launch ownership when inventory later recovers', async t => {
  let state = baseline, fail = false;
  const pass = await nativeFixture(t, () => { if (fail) throw new Error('snapshot failed'); return state; });
  await pass.trackLaunch([app(3).bundle], async () => { state = current; });
  fail = true; await pass.betweenTasks(); fail = false;
  const result = await pass.finish({ dryRun: true, log() {} });
  assert.ok(!result.planned.some(item => item.action === 'quit'));
  assert.equal(result.trackingErrorCount, 1);
});

test('hygiene tracking preserves the real setup error for the runner', async t => {
  const pass = await nativeFixture(t, () => baseline);
  await assert.rejects(pass.trackLaunch([], async () => { throw new Error('fixture unavailable'); }), /fixture unavailable/);
  await pass.finish({ dryRun: true, log() {} });
});


test('a launch inventory gap cannot transfer ownership of new unmatched owner windows', async t => {
  let state = { apps: [], windows: [], at: 100 }, fail = false;
  const pass = await nativeFixture(t, () => { if (fail) throw new Error('inventory gap'); return state; });
  await pass.trackLaunch([app(3).bundle], async () => { state = { apps: [app(3)], windows: [{ ...win(30, 3), title: 'Owner document' }] }; });
  fail = true; await pass.betweenTasks(); fail = false;
  const result = await pass.finish({ touchedApps: [app(3).bundle], log() {} });
  assert.deepEqual(result.planned.map(item => item.action), ['keep']);
});

test('deferred arm sampling never adopts a PID incarnation born after registration', async t => {
  let state = { apps: [], windows: [], at: Date.now() / 1000 - 10, processes: [] };
  const pass = await nativeFixture(t, () => state);
  pass.recordArm(20);
  const later = Date.now() / 1000 + 1;
  state = { apps: [app(20, later)], windows: [win(30, 20, later)], processes: [{ pid: 20, ppid: 1, start: later }] };
  await pass.betweenTasks();
  const result = await pass.finish({ log() {} });
  assert.deepEqual(result.planned.map(item => item.action), ['keep']);
});

test('a sheet in its own window gets the dialog label, not the owner window beside it', async () => {
  const owner = { ...win(11, 1), title: 'Untitled' }, sheet = { ...win(12, 1), title: '', dialog: true };
  const result = await hygiene.finishWindows(baseline, { snapshot: async () => ({ apps: baseline.apps, windows: [...baseline.windows, owner, sheet] }),
    act: () => assert.fail('nothing is closed or answered'), log() {} });
  assert.deepEqual(result.leftWindows.map(item => [item.id, item.reason, Boolean(item.instruction)]),
    [[11, undefined, false], [12, 'application dialog', true]]);
});

test('without a baseline, exact launch receipts still get one gentle Quit and no window closes', async t => {
  const cacheDir = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-no-baseline-'))), actions = [];
  let fail = true, state = baseline;
  const run = async (command, args) => {
    if (command === '/usr/bin/xcrun' && args[1] === '--version') return { stdout: 'Swift test version', groupClean: true, exit: { code: 0 } };
    if (command === '/usr/bin/xcrun') { writeFileSync(args.at(-1), 'fake'); return { stdout: '{}', groupClean: true, exit: { code: 0 } }; }
    const request = JSON.parse(args[0]);
    if (request.action !== 'snapshot') {
      actions.push(request);
      if (request.pid === 3) state = { ...state, apps: state.apps.filter(item => item.pid !== 3), windows: state.windows.filter(item => item.pid !== 3) };
      return { stdout: '{}', groupClean: true, exit: { code: 0 } };
    }
    return fail ? { stdout: '', stderr: 'AX timeout', groupClean: true, exit: { code: 1 } } : { stdout: JSON.stringify(state), groupClean: true, exit: { code: 0 } };
  };
  const error = await hygiene.beginPassHygiene({ cacheDir, run }).then(() => assert.fail('baseline failed'), error => error);
  assert.match(error.message, /AX timeout/);
  const pass = error.receiptsOnly;
  fail = false;
  await pass.betweenTasks();
  // The setup launches app 3; app 5 is a lease receipt whose Quit raised a Save sheet.
  await pass.trackLaunch([app(3).bundle], async () => { state = { apps: [...baseline.apps, app(3)], windows: [...baseline.windows, win(11, 1), win(30, 3)] }; });
  await pass.betweenTasks();
  state = { apps: [...state.apps, app(5)], windows: [...state.windows, { ...win(50, 5), dialog: true }] };
  const result = await pass.finish({ fixtureNames, touchedApps: [app(1).bundle, app(3).bundle], launched: [app(5)], log() {} });
  assert.deepEqual(actions.map(item => [item.action, item.pid]), [['quit', 3], ['quit', 5]]);
  assert.deepEqual(result.leftWindows.map(item => [item.pid, item.id, item.reason]), [[5, 50, 'application dialog']]);
  assert.match(result.leftWindows[0].instruction, /Resolve.*dialog/);
  const unconfirmed = await error.receiptsOnly.finish({ launched: [app(5)], dryRun: true, log() {} });
  assert.deepEqual(unconfirmed.planned.map(item => [item.action, item.pid]), [['quit', 3], ['quit', 5]]);
  assert.equal(actions.length, 2, 'dry run sends nothing');
});
