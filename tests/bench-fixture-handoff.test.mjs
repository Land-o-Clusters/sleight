import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { openFixture, closeFixtures } from '../bench/real-fixture.mjs';

const bundle = 'com.apple.dt.Devices';
function nativeFixture({ openedAt = 700, initiallyRunning = false, launched = true, oldAlive = false,
  replacementBundle = bundle, secondChange = false, cleanupChange = false, mode = 'document', cancelAt = Infinity,
  successorLaunchedAt = 400, overlap = false, originalExitsAt = 400 } = {}) {
  const events = [], closes = [], lookups = [];
  let time = 0, ready = false;
  const date = ms => ({ isNil: () => false, timeIntervalSince1970: ms / 1000 });
  const original = { processIdentifier: 42, bundleIdentifier: bundle, launchDate: date(200), get isFinishedLaunching() { return time >= 900; } };
  const replacement = { processIdentifier: 43, bundleIdentifier: replacementBundle, launchDate: date(successorLaunchedAt), get isFinishedLaunching() { return time >= 900; } };
  const third = { processIdentifier: 44, bundleIdentifier: bundle, launchDate: date(600) };
  const sandbox = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  const foundation = value => ({ dataUsingEncoding: () => value });
  foundation.AXIsProcessTrusted = () => true;
  foundation.NSRunningApplication = {
    runningApplicationsWithBundleIdentifier: () => {
      // overlap lists the original and its successor together for one tick.
      if (overlap && time >= 300 && time < 400) return { count: 2, objectAtIndex: i => [original, replacement][i] };
      const target = ready && cleanupChange || secondChange && time >= 600 ? third
        : time >= 400 ? replacement : initiallyRunning || time >= 200 ? original : null;
      return { count: target ? 1 : 0, objectAtIndex: () => target };
    },
    runningApplicationWithProcessIdentifier: pid => {
      lookups.push(pid);
      return { isNil: () => false, isTerminated: !oldAlive && (pid === 42 ? time >= originalExitsAt : time >= 600) };
    },
  };
  foundation.AXUIElementCreateApplication = pid => ({ pid });
  foundation.AXUIElementSetMessagingTimeout = () => {};
  foundation.NSFileHandle = { fileHandleWithStandardOutput: { writeData: line => {
    const event = JSON.parse(line); events.push(event);
    if (event.stage === 'ready') ready = true;
  } } };
  foundation.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
  foundation.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({
    command: ready || time >= cancelAt ? 'close' : time >= openedAt ? 'opened' : 'launching', launched,
  }) } };
  sandbox.$ = foundation;
  sandbox.Date = { now: () => time };
  sandbox.waitForLaunch = seconds => { time += Math.round((seconds ?? 0.1) * 1000); };
  sandbox.nativeAX = () => ({
    focused: app => time >= 900 ? { pid: app.pid } : null,
    dialog: () => [], readiness: () => ({}), matches: () => true,
    wait: () => { time += 100; },
  });
  sandbox.closeOwnedWindow = (window, _request, app) => closes.push({ windowPid: window.pid, appPid: app.pid });
  return { events, closes, lookups, run: () => sandbox.run([JSON.stringify({
    app: 'DeviceHub', bundle, mode, control: 'fake', startedAtMs: 0,
  })]) };
}

for (const mode of ['inherit', 'document']) for (const openedAt of [300, 700]) test(`${mode} setup adopts one exited launch process during ${openedAt === 300 ? 'readiness' : 'pending launch'}`, () => {
  const fixture = nativeFixture({ openedAt, mode });
  fixture.run();
  const handoff = fixture.events.find(event => event.stage === 'process-handoff');
  assert.deepEqual(handoff?.processHandoff, { fromPid: 42, toPid: 43, elapsedMs: 400 });
  assert.deepEqual(handoff.pids, [42, 43]);
  assert.equal(fixture.events.find(event => event.stage === 'ready').pid, 43);
  assert.deepEqual(fixture.closes, mode === 'inherit' ? [] : [{ windowPid: 43, appPid: 43 }]);
  assert.deepEqual(fixture.lookups, [42]);
});

for (const [name, options, lastPid] of [
  ['a second handoff', { secondChange: true }, 43],
  ['another bundle', { replacementBundle: 'other.app' }, 42],
  ['an app present before setup', { initiallyRunning: true }, 42],
  ['an app opened by the owner during preparation', { launched: false }, 42],
]) test(`setup refuses ${name} without adopting or closing it`, () => {
  const fixture = nativeFixture(options);
  assert.throws(fixture.run, /Fixture process changed/);
  assert.equal(fixture.events.at(-1).pid, lastPid);
  assert.equal(fixture.events.filter(event => event.stage === 'process-handoff').length, lastPid === 43 ? 1 : 0);
  assert.deepEqual(fixture.closes, []);
});

test('cleanup refuses a replacement after setup has finished', () => {
  const fixture = nativeFixture({ cleanupChange: true });
  assert.throws(fixture.run, /Fixture process changed before cleanup/);
  assert.deepEqual(fixture.closes, []);
});

for (const openedAt of [300, 700]) test(`cancellation during ${openedAt === 300 ? 'readiness' : 'pending launch'} records the one eligible successor for cleanup`, () => {
  const fixture = nativeFixture({ mode: 'inherit', openedAt, cancelAt: 400 });
  assert.throws(fixture.run, /interrupted before identity was recorded/);
  assert.equal(fixture.events.at(-1).stage, 'setup-failure');
  assert.equal(fixture.events.at(-1).pid, 43);
  assert.deepEqual(fixture.events.at(-1).pids, [42, 43]);
  assert.deepEqual(fixture.closes, []);
});

test('the parent retains both launch PIDs and quits only the adopted replacement after collecting its helper', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-handoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir }, quits = [];
  let collected = false;
  const handoff = { fromPid: 42, toPid: 43, elapsedMs: 400 };
  const lease = await openFixture(ctx, { app: 'DeviceHub', bundle, mode: 'inherit' }, {
    launch: async beginLaunch => {
      beginLaunch(true);
      assert.equal(JSON.parse(readFileSync(join(dir, 'window-0-control.json'))).launched, true);
    },
    run: async (_command, args, options) => {
      const request = JSON.parse(args.at(-1));
      if (request.mode === 'quit') {
        assert.equal(collected, true);
        quits.push(request.pid);
        return { groupClean: true, exit: { code: 0 }, stdout: '' };
      }
      options.onStdout('{"stage":"armed","running":false}\n');
      await new Promise(resolve => setImmediate(resolve));
      options.onStdout(JSON.stringify({ stage: 'process-handoff', pid: 43, pids: [42, 43], processHandoff: handoff }) + '\n');
      options.onStdout('{"stage":"ready","pid":43}\n');
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      collected = true;
      return { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' };
    },
  });
  assert.deepEqual(lease.pids, [42, 43]);
  assert.deepEqual(ctx.fixtureDiagnostics[0].pids, [42, 43]);
  assert.deepEqual(ctx.fixtureDiagnostics[0].processHandoff, handoff);
  // Collection is explicit here because the fake helper waits for an abort.
  await lease.dispose();
  await closeFixtures(ctx);
  assert.equal(JSON.parse(readFileSync(join(dir, 'window-0-control.json'))).launched, true,
    'a close command must preserve the launch ownership needed for a pending handoff');
  assert.deepEqual(quits, [43]);
});

test('an inherit DeviceHub opened control records launch ownership and simulator boot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-opened-control-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir };
  let opened;
  const lease = await openFixture(ctx, { app: 'DeviceHub', bundle, mode: 'inherit' }, {
    launch: async beginLaunch => { beginLaunch(true); beginLaunch.simulatorBooted = true; },
    run: async (_command, _args, options) => {
      options.onStdout('{"stage":"armed","running":false,"pid":73541}\n');
      await new Promise(resolve => setImmediate(resolve));
      opened = JSON.parse(readFileSync(join(dir, 'window-0-control.json'), 'utf8'));
      options.onStdout('{"stage":"ready","pid":73541,"inheritReady":"window"}\n');
      return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({
        groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n',
      }), { once: true }));
    },
  });
  assert.equal(opened.command, 'opened');
  assert.equal(opened.launched, true);
  assert.equal(opened.simulatorBooted, true);
  assert.equal(ctx.fixtureDiagnostics[0].inheritReady, 'window');
  assert.equal(lease.pid, 73541);
  await lease.dispose();
});

test('a successor launched before this setup began is refused, not adopted', () => {
  const fixture = nativeFixture({ successorLaunchedAt: -100 });
  assert.throws(fixture.run, /predates this launch/);
  assert.equal(fixture.events.some(event => event.stage === 'process-handoff'), false);
  assert.deepEqual(fixture.closes, []);
});

test('the original and its successor listed together waits for the original to exit', () => {
  const fixture = nativeFixture({ overlap: true });
  fixture.run();
  assert.deepEqual(fixture.events.find(event => event.stage === 'process-handoff')?.processHandoff, { fromPid: 42, toPid: 43, elapsedMs: 400 });
  assert.equal(fixture.events.find(event => event.stage === 'ready').pid, 43);
});

test('a successor listed while the original is still exiting waits, then is adopted', () => {
  const fixture = nativeFixture({ originalExitsAt: 800 });
  fixture.run();
  assert.equal(fixture.events.find(event => event.stage === 'process-handoff')?.processHandoff.toPid, 43);
  assert.equal(fixture.events.find(event => event.stage === 'ready').pid, 43);
});

test('an original that never exits is never adopted or marked ready, and setup times out', () => {
  const fixture = nativeFixture({ oldAlive: true });
  assert.throws(fixture.run, /readiness unconfirmed/);
  assert.equal(fixture.events.some(event => event.stage === 'process-handoff' || event.stage === 'ready'), false);
  assert.deepEqual(fixture.closes, []);
});

function inheritReadyFixture({ finished = true, focused = false, main = false, windows = 0, simulatorBooted = false } = {}) {
  const events = [];
  let time = 0, ready = false;
  const target = { processIdentifier: 73541, bundleIdentifier: bundle, isFinishedLaunching: finished };
  const sandbox = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  const foundation = value => ({ dataUsingEncoding: () => value });
  foundation.AXIsProcessTrusted = () => true;
  foundation.NSRunningApplication = {
    runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => target }),
    runningApplicationWithProcessIdentifier: () => ({ isNil: () => true, isTerminated: true }),
  };
  foundation.AXUIElementCreateApplication = () => ({});
  foundation.AXUIElementSetMessagingTimeout = () => {};
  foundation.NSFileHandle = { fileHandleWithStandardOutput: { writeData: line => {
    const event = JSON.parse(line); events.push(event); if (event.stage === 'ready') ready = true;
  } } };
  foundation.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
  foundation.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({
    command: ready ? 'close' : 'opened', launched: true, simulatorBooted,
  }) } };
  sandbox.$ = foundation;
  sandbox.Date = { now: () => time };
  sandbox.waitForLaunch = seconds => { time += Math.round((seconds ?? 0.1) * 1000); };
  sandbox.nativeAX = () => ({
    focused: () => focused ? { role: 'AXWindow' } : null,
    mainWindow: () => main ? { role: 'AXWindow' } : null,
    windowCount: () => windows,
    dialog: () => [], readiness: () => ({}),
    wait: () => { time += 100; },
  });
  return { events, run: () => sandbox.run([JSON.stringify({
    app: 'DeviceHub', bundle, mode: 'inherit', control: 'fake', startedAtMs: 0,
  })]), inheritReady: sandbox.inheritReadyCondition };
}

test('inherit readiness accepts a finished launch with a window and no focused window', () => {
  const fixture = inheritReadyFixture({ finished: true, focused: false, main: true });
  fixture.run();
  assert.equal(fixture.events.find(event => event.stage === 'ready').inheritReady, 'window');
  assert.equal(fixture.events.find(event => event.stage === 'ready').pid, 73541);
});

test('inherit readiness records a focused window when that is what DeviceHub reports', () => {
  const fixture = inheritReadyFixture({ finished: true, focused: true });
  fixture.run();
  assert.equal(fixture.events.find(event => event.stage === 'ready').inheritReady, 'focused-window');
});

test('a booted simulator is not readiness while the viewer process is absent', () => {
  const fixture = inheritReadyFixture({ finished: false, simulatorBooted: true });
  assert.equal(fixture.inheritReady(null, {}, { focused: () => null }, { simulatorBooted: true }), null);
});

test('inherit readiness accepts a booted simulator once DeviceHub has a process, even if launching is unfinished', () => {
  const fixture = inheritReadyFixture({ finished: false, simulatorBooted: true });
  fixture.run();
  assert.equal(fixture.events.find(event => event.stage === 'ready').inheritReady, 'simulator-booted');
  assert.equal(fixture.events.find(event => event.stage === 'ready').pid, 73541);
});

test('inherit readiness accepts simctl boot state when DeviceHub has no window', () => {
  const fixture = inheritReadyFixture({ finished: true, simulatorBooted: true });
  fixture.run();
  assert.equal(fixture.events.find(event => event.stage === 'ready').inheritReady, 'simulator-booted');
});

test('inherit readiness stays unconfirmed without a window or simulator boot', () => {
  const fixture = inheritReadyFixture({ finished: true });
  assert.throws(fixture.run, /readiness unconfirmed/);
  assert.equal(fixture.events.some(event => event.stage === 'ready'), false);
});

test('inherit readiness pumps the run loop so a late isFinishedLaunching becomes ready', () => {
  const events = [];
  let time = 0, ready = false, pumped = false;
  const target = { processIdentifier: 73541, bundleIdentifier: bundle, get isFinishedLaunching() { return pumped; } };
  const sandbox = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  const foundation = value => ({ dataUsingEncoding: () => value });
  foundation.AXIsProcessTrusted = () => true;
  foundation.NSRunningApplication = {
    runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => target }),
    runningApplicationWithProcessIdentifier: () => ({ isNil: () => true, isTerminated: true }),
  };
  foundation.AXUIElementCreateApplication = () => ({});
  foundation.AXUIElementSetMessagingTimeout = () => {};
  foundation.NSFileHandle = { fileHandleWithStandardOutput: { writeData: line => {
    const event = JSON.parse(line); events.push(event); if (event.stage === 'ready') ready = true;
  } } };
  foundation.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
  foundation.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({
    command: ready ? 'close' : 'opened', launched: true,
  }) } };
  sandbox.$ = foundation;
  sandbox.Date = { now: () => time };
  sandbox.waitForLaunch = seconds => { pumped = true; time += Math.round((seconds ?? 0.1) * 1000); };
  sandbox.nativeAX = () => ({
    focused: () => pumped ? { role: 'AXWindow' } : null,
    mainWindow: () => null, windowCount: () => 0,
    dialog: () => [], readiness: () => ({}),
    wait: () => { time += 100; },
  });
  sandbox.run([JSON.stringify({ app: 'DeviceHub', bundle, mode: 'inherit', control: 'fake', startedAtMs: 0 })]);
  assert.equal(events.find(event => event.stage === 'ready').inheritReady, 'focused-window');
});

test('failed inherit readiness records finished, boot flag and viewer pid on the first and last probe', () => {
  const fixture = inheritReadyFixture({ finished: false });
  assert.throws(fixture.run, /readiness unconfirmed/);
  const probes = fixture.events.filter(event => event.stage === 'readiness');
  assert.equal(probes.length, 2);
  assert.deepEqual(probes.map(event => event.readiness), [
    { finished: false, simulatorBooted: false, pid: 73541, inheritReady: null },
    { finished: false, simulatorBooted: false, pid: 73541, inheritReady: null },
  ]);
});
