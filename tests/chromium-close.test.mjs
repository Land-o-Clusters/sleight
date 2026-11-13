import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { boundTestChromium, closeTestChromium } from './fixtures/chromium-close.mjs';
import { launchTestChromium, launchTestChromiumContext } from './fixtures/chromium-isolated.mjs';

const posix = { skip: process.platform === 'win32' && 'requires POSIX process groups' };

// Removing the deadline would strand the child test runner; removing the group
// signal would leave this fixture alive. No browser or OS application is used.
async function fakeBrowser(t, { neverClose = false, contextNeverClose = false, timeoutMs = 1000, mode, protect = true } = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/chromium-close-child.mjs', import.meta.url)), ...(mode ? [mode] : [])],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const collected = once(child, 'close');
  t.after(async () => { child.stdin.end(); await exited; });
  await once(child.stdout, 'data');
  let calls = 0;
  const context = { async close() { return contextNeverClose ? new Promise(() => {}) : 'context closed'; } };
  const browser = { contexts: () => [context], async newContext() { return { async close() {
    return contextNeverClose ? new Promise(() => {}) : 'new context closed';
  } }; },
    async close() { calls++; if (neverClose) return new Promise(() => {}); child.stdin.end(); await exited; return 'browser closed'; } };
  browser._connection = { toImpl: () => ({ options: { browserProcess: { process: child } } }) };
  context.browser = () => browser;
  if (protect) boundTestChromium(browser, child, { timeoutMs });
  return { browser, context, child, exited, collected, calls: () => calls };
}

test('a normal browser close preserves its result and remains idempotent', { ...posix, timeout: 5000 }, async t => {
  const f = await fakeBrowser(t, { timeoutMs: 1000 });
  assert.equal(await f.browser.close(), 'browser closed');
  assert.equal(await f.browser.close(), 'browser closed');
  assert.equal(f.calls(), 1);
  assert.deepEqual(await f.exited, [0, null]);
});

for (const route of ['browser', 'persistent']) test(`the isolated ${route} launch binds its actual owned process`, { ...posix, timeout: 15000 }, async t => {
  const f = await fakeBrowser(t, { neverClose: true, contextNeverClose: true, protect: false });
  const chromium = { launch: async () => f.browser, launchPersistentContext: async () => f.context };
  const options = { executablePath: '/unused-test-executable' };
  const resource = route === 'browser' ? await launchTestChromium(chromium, options)
    : await launchTestChromiumContext(chromium, '/unused-test-profile', options);
  const start = performance.now();
  await assert.rejects(resource.close(), { code: 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT' });
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 12000, 'the default deadline must finish within 10 seconds plus the bounded reap');
  t.diagnostic('default ' + route + ' forced cleanup: ' + elapsed.toFixed(1) + ' ms');
  assert.deepEqual(await f.exited, [null, 'SIGKILL']);
  await assert.rejects(f.browser.close(), { code: 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT' });
});

test('a hung close kills the owned process group and rejects within the bound', { ...posix, timeout: 5000 }, async t => {
  const f = await fakeBrowser(t, { neverClose: true, timeoutMs: 100 });
  const start = performance.now();
  await assert.rejects(f.browser.close(), error => {
    assert.equal(error.code, 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT');
    assert.match(error.message, /100 ms.*SIGKILL.*process group/);
    return true;
  });
  assert.ok(performance.now() - start < 2000, 'a hung close must not wait on the original promise after the deadline');
  assert.deepEqual(await f.exited, [null, 'SIGKILL']);
  await assert.rejects(f.browser.close(), { code: 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT' });
});

test('existing and new context closes use the same owned-browser deadline', { ...posix, timeout: 5000 }, async t => {
  const f = await fakeBrowser(t);
  assert.equal(await f.context.close(), 'context closed');
  const context = await f.browser.newContext();
  assert.equal(await context.close(), 'new context closed');
  await f.browser.close();
  for (const kind of ['existing', 'new']) {
    const hanging = await fakeBrowser(t, { contextNeverClose: true, timeoutMs: 100 });
    const context = kind === 'existing' ? hanging.context : await hanging.browser.newContext();
    await assert.rejects(context.close(), { code: 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT' });
    assert.deepEqual(await hanging.exited, [null, 'SIGKILL']);
    await assert.rejects(hanging.browser.close(), { code: 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT' });
  }
});

for (const mode of ['--tree', '--exited-leader']) test(`forced close collects descendant pipes (${mode})`,
  { ...posix, timeout: 6000 }, async t => {
    const f = await fakeBrowser(t, { neverClose: true, timeoutMs: 100, mode });
    if (mode === '--exited-leader') await f.exited;
    const start = performance.now();
    await assert.rejects(f.browser.close(), error => {
      assert.equal(error.code, 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT');
      assert.doesNotMatch(error.message, /not observed/);
      return true;
    });
    await f.collected;
    assert.ok(performance.now() - start < 2000, 'collect the whole owned group, including after its leader exits');
  });

test('teardown before browser.close is bounded and the failure survives later cleanup', { ...posix, timeout: 5000 }, async t => {
  const f = await fakeBrowser(t, { timeoutMs: 100 });
  await assert.rejects(closeTestChromium(f.context, () => new Promise(() => {})), { code: 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT' });
  assert.deepEqual(await f.exited, [null, 'SIGKILL']);
  await assert.rejects(f.browser.close(), { code: 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT' });
  assert.equal(f.calls(), 0);
});

test('a rejected close remains a failure instead of becoming a successful cleanup', { ...posix, timeout: 5000 }, async t => {
  const f = await fakeBrowser(t);
  const failure = Error('fixture close rejected');
  await assert.rejects(closeTestChromium(f.browser, () => { throw failure; }), error => error === failure);
  assert.equal(await f.browser.close(), 'browser closed');
});

test('a child collected before binding is never signaled through a stale PID', { ...posix, timeout: 5000 }, async t => {
  const child = Object.assign(new EventEmitter(), { pid: process.pid + 1, exitCode: 0, signalCode: null,
    stdio: [{ destroyed: true }, { destroyed: true }, { destroyed: true }] });
  const browser = { contexts: () => [], async newContext() { throw Error('unused'); },
    close: () => new Promise(() => {}) };
  const kill = t.mock.method(process, 'kill', () => { throw Error('a collected child must not be signaled'); });
  boundTestChromium(browser, child, { timeoutMs: 20 });
  await assert.rejects(browser.close(), { code: 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT' });
  assert.equal(kill.mock.callCount(), 0);
});

for (const hang of [false, true]) test(`a real test-runner after hook exits ${hang ? '1 on forced cleanup' : '0 after normal close'}`,
  { ...posix, timeout: 8000 }, async () => {
    const env = { ...process.env, SLEIGHT_TEST_CLOSE_HANG: hang ? '1' : '0' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./fixtures/chromium-close-hook.mjs', import.meta.url))],
      { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const start = performance.now(), [code, signal] = await once(child, 'close');
    assert.equal(signal, null, output);
    assert.equal(code, hang ? 1 : 0, output);
    if (hang) {
      assert.match(output, /hookFailed/);
      assert.match(output, /SIGKILL required for owned process group/);
      assert.ok(performance.now() - start < 3000, output);
    }
  });
