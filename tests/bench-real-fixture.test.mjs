import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

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

test('ordinary cancellation retains the helper until its owned window is closed', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-fixture-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controller = new AbortController(), cleanup = new AbortController();
  let finish, helperSignal;
  const lease = await openFixture({ dir, signal: controller.signal, cleanupSignal: cleanup.signal },
    { app: 'Safari', bundle: 'com.apple.Safari', target: 'http://127.0.0.1/test', mode: 'window' }, {
      run: async (_command, _args, options) => {
        helperSignal = options.signal;
        options.onStdout('{"stage":"armed"}\n{"stage":"ready"}\n');
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

test('a collected helper refusal before any mutation confirms cleanup without an AX action', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'real-fixture-unavailable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir };
  await assert.rejects(openFixture(ctx, { app: 'Safari', bundle: 'com.apple.Safari', mode: 'window' }, {
    run: async () => ({ exit: { code: 1 }, stdout: '{"stage":"untouched"}\n', stderr: 'Safari is unavailable', groupClean: true }),
    open: async () => assert.fail('must not launch after a read-only refusal'),
  }), error => error.noMutation === true);
  await closeFixtures(ctx);
  assert.equal(await ctx.windowLeases[0].dispose(), true);
  assert.throws(() => readFileSync(join(dir, 'window-0-control.json')), /ENOENT/);
});
