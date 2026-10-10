import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { openFixture, closeFixtures } from '../bench/real-fixture.mjs';

const bundle = 'com.apple.dt.Devices';
function nativeFixture({ openedAt = 700, initiallyRunning = false, launched = true, oldAlive = false,
  replacementBundle = bundle, secondChange = false, cleanupChange = false, mode = 'document', cancelAt = Infinity } = {}) {
  const events = [], closes = [], lookups = [];
  let time = 0, ready = false;
  const original = { processIdentifier: 42, bundleIdentifier: bundle, get isFinishedLaunching() { return time >= 900; } };
  const replacement = { processIdentifier: 43, bundleIdentifier: replacementBundle, get isFinishedLaunching() { return time >= 900; } };
  const third = { processIdentifier: 44, bundleIdentifier: bundle };
  const sandbox = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  const foundation = value => ({ dataUsingEncoding: () => value });
  foundation.AXIsProcessTrusted = () => true;
  foundation.NSRunningApplication = {
    runningApplicationsWithBundleIdentifier: () => {
      const target = ready && cleanupChange || secondChange && time >= 600 ? third
        : time >= 400 ? replacement : initiallyRunning || time >= 200 ? original : null;
      return { count: target ? 1 : 0, objectAtIndex: () => target };
    },
    runningApplicationWithProcessIdentifier: pid => {
      lookups.push(pid);
      return { isNil: () => false, isTerminated: !oldAlive && (pid === 42 ? time >= 400 : time >= 600) };
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
  ['a still-running original process', { oldAlive: true }, 42],
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
