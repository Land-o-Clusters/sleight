import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webBrowsers } from '../bench/tasks-web.mjs';
import { REAL_APPS } from '../bench/tasks.mjs';

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
    serveWebPage: ctx => { ctx.url = 'http://127.0.0.1:1234/abc123/'; },
    checkWeb() {}, closeFixtures() {}, acquireFixture: (_ctx, _key, operation) => operation(),
    openFixture: (_ctx, request) => { assert.equal(request.fixtureKind, 'web-page'); requests.push(request); },
  });
  for (const task of tasks) await task.setup({ nonce: 'abc123' });
  assert.equal(requests.length, 126);
  assert.equal(new Set(requests.map(request => request.bundle)).size, 5);
});
