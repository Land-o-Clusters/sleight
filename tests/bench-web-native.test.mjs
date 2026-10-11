import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webBrowsers } from '../bench/tasks-web.mjs';
import { REAL_APPS } from '../bench/tasks.mjs';

// Run the actual helper selector and launch choreography, replacing only the
// compiler and process boundaries. No helper, app or engine starts.
for (const [app, bundle, opens, initialStage] of [
  ['Safari', 'com.apple.Safari', [['-g', '-a', 'Safari']], 'launch'],
  ['Helium', 'net.imput.helium', [['-n', '-g', '-a', 'Helium', '--args', '--new-window', 'http://127.0.0.1:1234/abc123/']], 'armed'],
]) test(`${app} web-page fixtures use the same helper and launch path as its older web tasks`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'web-fixture-routing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL('../bench/real-fixture.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    .replaceAll('import.meta.url', '"file:///fixture/bench/real-fixture.mjs"');
  const { openFixture } = runInNewContext(`${source}\n({ openFixture })`, {
    execFile() {}, promisify: () => () => assert.fail('no real process'),
    runOwned: () => assert.fail('no real helper'), heliumHelper: async () => '/fixture/retained-browser-helper',
    writeFileSync, join, fileURLToPath, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
  });
  const target = 'http://127.0.0.1:1234/abc123/';
  for (const fixtureKind of [undefined, 'web-page']) {
    const actions = [];
    let finish;
    const lease = await openFixture({ dir, ownerAway: true }, { app, bundle, target, token: 'abc123', mode: 'window', ...(fixtureKind && { fixtureKind }) }, {
      run: async (command, args, options) => {
        assert.equal(command, '/fixture/retained-browser-helper', 'use the helper that passed the older web tasks');
        assert.equal(JSON.parse(args.at(-1)).target, target);
        options.onStdout(JSON.stringify({ stage: initialStage, running: true, pid: 123 }) + '\n');
        setTimeout(() => options.onStdout('{"stage":"armed"}\n{"stage":"ready"}\n'), 0);
        return new Promise(resolve => { finish = resolve; });
      },
      open: async (command, args) => { assert.equal(command, '/usr/bin/open'); actions.push([...args]); },
    });
    assert.deepEqual(actions, opens);
    const closed = lease.close();
    finish({ exit: { code: 0 }, stdout: '{"stage":"closed"}\n', groupClean: true });
    await closed;
  }
});

test('all browser-table identities are approved in the real suite', () => {
  for (const { app, bundle } of webBrowsers) {
    assert.ok(REAL_APPS.includes(app), app);
    assert.ok(REAL_APPS.includes(bundle), bundle);
  }
});

test('generic web fixtures reach the same accessibility gate for all five browsers', () => {
  const sandbox = { ObjC: { import() {}, unwrap: value => value }, $: { AXIsProcessTrusted: () => false } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  for (const { app, bundle } of webBrowsers) assert.throws(() => sandbox.run([JSON.stringify({
    app, bundle, fixtureKind: 'web-page', mode: 'window', control: '/fixture/control', target: 'http://127.0.0.1:1234/abc123/',
  })]), /Accessibility is unavailable/);
});

test('every web task requests the generic web fixture kind without browser-specific setup', async () => {
  const requests = [];
  const source = readFileSync(new URL('../bench/tasks-web.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const tasks = runInNewContext(`${source}\nwebTasks`, {
    webBrowsers,
    serveWebPage: ctx => { ctx.url = 'http://127.0.0.1:1234/abc123/'; },
    checkWeb() {}, closeFixtures() {}, acquireFixture: (_ctx, _key, operation) => operation(),
    openFixture: (_ctx, request) => { assert.equal(request.fixtureKind, 'web-page'); requests.push(request); },
  });
  for (const task of tasks) await task.setup({ nonce: 'abc123' });
  assert.equal(requests.length, 126);
  assert.equal(new Set(requests.map(request => request.bundle)).size, 5);
});
