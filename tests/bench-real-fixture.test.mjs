import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { runOwned } from '../bench/preapproved-process.mjs';
import { fileURLToPath } from 'node:url';

function nativeSource() {
  const sandbox = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

test('fresh setup retries only the two startup AX errors and records the bounded wait', () => {
  const { setupRead } = nativeSource();
  assert.equal(typeof setupRead, 'function');
  const state = { fresh: true, setup: true, retryWaitMs: 0 }, events = [];
  let time = 0, attempts = 0;
  const clock = { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) };
  const value = setupRead(() => {
    attempts++;
    if (attempts <= 2) throw Object.assign(new Error('starting'), { code: attempts === 1 ? -25204 : -25205 });
    return 'ready';
  }, state, clock);
  assert.equal(value, 'ready');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.code), [-25204, -25205]);
  assert.equal(state.retryWaitMs, 200);
  attempts = 0;
  assert.throws(() => setupRead(() => { attempts++; throw Object.assign(new Error('still starting'), { code: -25204 }); }, state, clock), /still starting/);
  assert.equal(time, 15000, 'all reads share one fifteen-second startup budget');
  assert.equal(attempts, 148, 'no additional read begins after the deadline');
});

test('retry elapsed time includes slow AX reads and stops before a read after fifteen seconds', () => {
  const { setupRead } = nativeSource();
  const state = { fresh: true, setup: true, retryWaitMs: 0 }, events = [];
  let time = 0, lastReadAt = 0;
  assert.throws(() => setupRead(() => {
    lastReadAt = time; time += 500;
    throw Object.assign(new Error('slow AX'), { code: -25204 });
  }, state, { now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) }), /slow AX/);
  assert.equal(time, 15500);
  assert.equal(state.retryWaitMs, 15000);
  assert.ok(lastReadAt < 15500);
  assert.ok(events.at(-1).totalWaitMs <= 15000);
  assert.ok(events.reduce((sum, e) => sum + e.waitMs, 0) < 3000);
});

test('existing apps, cleanup and acted-on fixtures never retry an AX read', () => {
  const { setupRead } = nativeSource();
  assert.equal(typeof setupRead, 'function');
  for (const state of [
    { fresh: false, setup: true }, { fresh: true, setup: false },
    { fresh: true, setup: true, fixtureExists: true, actionTaken: true },
  ]) {
    let attempts = 0;
    assert.throws(() => setupRead(() => { attempts++; throw Object.assign(new Error('refuse'), { code: -25204 }); }, state,
      { now: () => 0, wait: () => assert.fail('no backoff'), emit: () => assert.fail('no retry') }), /refuse/);
    assert.equal(attempts, 1);
  }
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

test('a partially successful launch is quit by its recorded PID after the launch command rejects', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-partial-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir }, quits = [];
  let finish;
  await assert.rejects(openFixture(ctx, { app: 'Preview', bundle: 'com.apple.Preview', mode: 'document' }, {
    run: async (_command, args, options) => {
      const request = JSON.parse(args.at(-1));
      if (request.mode === 'quit') { quits.push(request.pid); return { exit: { code: 0 }, groupClean: true }; }
      options.onStdout('{"stage":"armed","running":false}\n');
      return new Promise(resolve => { finish = () => {
        const stdout = '{"stage":"setup-failure","cleanup":"unconfirmed","pid":42}\n';
        options.onStdout(stdout); resolve({ exit: { code: 1 }, stdout, groupClean: true });
      }; });
    },
    open: async () => { finish(); throw new Error('launch command failed after starting app'); },
  }), /launch command failed/);
  await closeFixtures(ctx);
  assert.deepEqual(quits, [42]);
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
  let controlReads = 0;
  const native = value => ({ dataUsingEncoding: () => value });
  Object.assign(native, {
    AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 0 }) },
    NSData: { dataWithContentsOfFile: () => ({ isNil: () => false }) },
    NSString: { alloc: { initWithDataEncoding: () => JSON.stringify({ command: ++controlReads > 201 ? 'close' : 'opened' }) } },
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
      setTimeout(() => options.onStdout('{"stage":"armed","running":false}\n{"stage":"ready","pid":123}\n'), 5);
      return new Promise(resolve => { finish = resolve; });
    },
  });
  assert.deepEqual(actions, [
    ['-g', '-a', 'Safari'],
  ]);
  assert.equal(lease.running, false);
  assert.equal(lease.pid, 123);
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
  assert.equal(api.matches({}, { mode: 'document', target: '/private/tmp/Pages-abc.pdf', token: 'Pages-abc.pdf' }), true);
  assert.equal(api.matches({}, { mode: 'document', target: '/private/tmp/Other.pdf', token: 'Pages-abc.pdf' }), false,
    'a matching title must never override another document path');
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
  const app = { processIdentifier: 42, bundleIdentifier: 'com.apple.Safari', terminate: () => true };
  let observations = 0;
  assert.equal(quitFixtureApplication(42, 'com.apple.Safari', () => ++observations < 3 ? app : null, () => {}), true);
  assert.throws(() => quitFixtureApplication(42, 'com.apple.Safari', () => ({ ...app, processIdentifier: 43 }),
    () => assert.fail('no quit of replacement')), /identity/);
});

test('native JXA quit identity unwraps a bridged bundle string without accessing an app',
  { skip: process.platform !== 'darwin' }, async () => {
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
  assert.throws(() => readFileSync(join(dir, 'window-0-control.json')), /ENOENT/);
});
