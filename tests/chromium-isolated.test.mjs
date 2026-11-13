import { assertChildStatus } from './fixtures/child-status.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumShellName, chromiumAppExecutable, testChromiumExecutable, isolatedChromiumSpawn, isolatedChromiumOptions, launchTestChromium, launchTestChromiumContext, readTestDevToolsPort } from './fixtures/chromium-isolated.mjs';

test('Mac test browsers keep their arguments inside the OS handoff sandbox', async () => {
  const launched = options => {
    const child = Object.assign(new EventEmitter(), { pid: 123456, exitCode: 0, signalCode: null });
    const context = { options, async close() {} };
    const browser = { ...options, contexts: () => [context], async newContext() { return context; }, async close() {},
      _connection: { toImpl: () => ({ options: { browserProcess: { process: child } } }) } };
    context.browser = () => browser;
    return { browser, context };
  };
  const chromium = { executablePath: () => '/pinned/chromium-1248/chrome-mac-arm64/' + chromiumAppExecutable,
    launch: async options => launched(options).browser,
    launchPersistentContext: async (profile, options) => Object.assign(launched(options).context, { profile }) };
  const input = { executablePath: '/pinned/full-chromium', args: ['--site-per-process'], env: { FIXTURE_ONLY: '1' }, viewport: null };
  const options = isolatedChromiumOptions(chromium, input, 'darwin');
  assert.match(options.executablePath, /\/tests\/fixtures\/chromium-no-apps\.sh$/);
  assert.equal(options.env.SLEIGHT_TEST_CHROMIUM_EXECUTABLE, input.executablePath);
  assert.equal(options.env.FIXTURE_ONLY, '1');
  assert.deepEqual(options.args, input.args);
  assert.equal(options.viewport, null);
  assert.equal(options.headless, true);
  assert.equal(isolatedChromiumOptions(chromium, {}, 'darwin').env.SLEIGHT_TEST_CHROMIUM_EXECUTABLE,
    '/pinned/chromium_headless_shell-1248/' + chromiumShellName + '-mac-arm64/' + chromiumShellName);
  assert.equal(isolatedChromiumOptions(chromium, { channel: 'chromium' }, 'darwin').env.SLEIGHT_TEST_CHROMIUM_EXECUTABLE, chromium.executablePath());
  assert.throws(() => isolatedChromiumOptions(chromium, { channel: 'chrome' }, 'darwin'), /explicit executable/);
  assert.throws(() => isolatedChromiumOptions(chromium, { headless: false }), /headless/);
  assert.equal((await launchTestChromium(chromium, input)).headless, true);
  const persistent = await launchTestChromiumContext(chromium, '/private/test-profile', input);
  assert.equal(persistent.profile, '/private/test-profile');
  assert.equal(persistent.options.headless, true);
  assert.equal(input.executablePath, '/pinned/full-chromium');
});

test('fixture endpoint discovery waits for both port-file lines and rejects incomplete data at its deadline', async () => {
  const profile = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-devtools-port-check-')));
  let first, second;
  try {
    first = setTimeout(() => writeFileSync(join(profile, 'DevToolsActivePort'), '12345\n'), 15);
    second = setTimeout(() => writeFileSync(join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/fixture-id\n'), 30);
    assert.deepEqual(await readTestDevToolsPort(profile), ['12345', '/devtools/browser/fixture-id']);
    writeFileSync(join(profile, 'DevToolsActivePort'), '0\n/devtools/browser/fixture-id');
    await assert.rejects(readTestDevToolsPort(profile, 15), /did not become ready/);
  } finally { clearTimeout(first); clearTimeout(second); removeTemp(profile); }
});

// Keep this predicate testable on synthetic source as well as the repository.
const v3Worker = fileURLToPath(new URL('../bench/turbo/v3-worker.mjs', import.meta.url));
export function assertIsolatedSource(source, path) {
  assert.doesNotMatch(source, /\b(?:chromium|browserType)\s*\.\s*launch\s*\(|\blaunchPersistentContext\s*\(/, path);
  // MT2C, Chromium sandbox exception: this exact v3 benchmark file keeps
  // Chromium's own content/GPU sandbox. Nesting sandbox-exec breaks its GPU.
  // Its closed-ad1, closed-shadow, combobox, x6, turbo-v3-arm and
  // turbo-v3-bench-worker real suites navigate only http(s) fixture pages.
  // Any new non-http navigation in those suites must use the wrapped helper.
  if (path !== v3Worker)
    assert.doesNotMatch(source, new RegExp(chromiumShellName + '|' + chromiumAppExecutable.split('/').at(-1)), path);
}

test('test and bench Chromium launches use isolation except the exact v3 Chromium sandbox exception', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const helper = join(root, 'tests/fixtures/chromium-isolated.mjs');
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { inspect(path); continue; }
      if (!/\.(?:mjs|js|cjs)$/.test(entry.name) || path === helper) continue;
      assertIsolatedSource(readFileSync(path, 'utf8'), path);
    }
  }
  inspect(join(root, 'tests'));
  inspect(join(root, 'bench'));
  // media/launch/render.mjs is an intentional non-test browser renderer and is
  // outside both scanned trees.
});

test('the source guard rejects all launch spellings and executable literals', () => {
  for (const source of ['chromium' + '.launch({})', 'chromium' + '.launchPersistentContext' + '({})',
    'browserType' + '.launch({})', 'other.' + 'launchPersistentContext' + '({})',
    chromiumShellName, chromiumAppExecutable]) {
    assert.throws(() => assertIsolatedSource(source, 'synthetic fixture'));
  }
  assertIsolatedSource('launchTestChromium(chromium, {})', 'safe fixture');
  assertIsolatedSource(chromiumShellName, v3Worker);
  assert.throws(() => assertIsolatedSource(chromiumShellName, v3Worker + '.copy.mjs'));
  assert.throws(() => assertIsolatedSource('chromium' + '.launch({})', v3Worker));
});

function assertHttpFixtureSource(source, path) {
  // Built-in module specifiers are not navigation URLs. Keep URL literals in
  // HTML and JS, including opaque custom schemes without //, in the scan.
  const fixtures = source.replace(/\b(?:from|import)\s*(['"])node:[^'"]+\1/g, '');
  for (const match of fixtures.matchAll(/(?:['"`]|\b(?:href|src|action)\s*=\s*)([a-z][a-z0-9+.-]*):/gi))
    assert.ok(/^https?$/i.test(match[1]), path + ': non-http fixture URL ' + match[1] + ': must use the wrapped helper');
  for (const match of fixtures.matchAll(/\b([a-z][a-z0-9+.-]*):\/\//gi))
    assert.ok(/^https?$/i.test(match[1]), path + ': non-http fixture URL ' + match[1] + ': must use the wrapped helper');
}

test('the six v3 browser real suites contain only http(s) fixture URLs', () => {
  for (const name of ['direct-browser-closed-ad1', 'direct-browser-closed-shadow', 'direct-browser-combobox',
    'direct-browser-x6', 'turbo-v3-arm', 'turbo-v3-bench-worker']) {
    const path = fileURLToPath(new URL('./' + name + '.real.test.mjs', import.meta.url));
    assertHttpFixtureSource(readFileSync(path, 'utf8'), path);
  }
});

test('the v3 fixture URL scan rejects OS protocols and custom schemes', () => {
  for (const url of ['mailto:fixture@example.invalid', 'tel:+15555550100', 'sleight-fixture://blocked/',
    'sleight-fixture:opaque', 'data:text/html,fixture', 'javascript:void(0)', 'file:///fixture']) {
    for (const source of ["const url = '" + url + "';", '<a href="' + url + '">Fixture</a>', '<a href=' + url + '>Fixture</a>'])
      assert.throws(() => assertHttpFixtureSource(source, 'synthetic fixture'), /non-http fixture URL/);
  }
  assertHttpFixtureSource("import test from 'node:test'; const url = 'http://127.0.0.1:1234/';", 'http fixture');
  assertHttpFixtureSource('const url = `https://fixture.invalid/`;', 'https fixture');
});

test('raw spawn isolation preserves every browser flag and wraps only on Mac', () => {
  const args = ['--headless', '--user-data-dir=fixture', 'about:blank'];
  const options = { stdio: 'ignore', env: { FIXTURE_ONLY: '1' } };
  const mac = isolatedChromiumSpawn('/fixture/browser', args, options, 'darwin');
  assert.match(mac.executablePath, /chromium-no-apps\.sh$/);
  assert.strictEqual(mac.args, args);
  assert.equal(mac.options.stdio, 'ignore');
  assert.equal(mac.options.env.FIXTURE_ONLY, '1');
  assert.equal(mac.options.env.SLEIGHT_TEST_CHROMIUM_EXECUTABLE, '/fixture/browser');
  assert.deepEqual(isolatedChromiumSpawn('/fixture/browser', args, options, 'linux'),
    { executablePath: '/fixture/browser', args, options });
  assert.match(testChromiumExecutable({ revision: 1234, platform: 'darwin', arch: 'arm64' }),
    new RegExp('chromium_headless_shell-1234/'));
});

test('Mac sandbox denies lsopen, the opening service and Apple events while allowing browser registration', { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-no-apps-check-')));
  try {
    const executable = join(root, 'sandbox-check');
    execFileSync('xcrun', ['clang', fileURLToPath(new URL('./fixtures/chromium-sandbox-check.c', import.meta.url)),
      '-o', executable, '-lsandbox'], { stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' });
    const control = spawnSync(executable, [], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
    assertChildStatus(control, 1);
    assert.equal(JSON.parse(control.stdout).lsopenDenied, false, 'the unsandboxed control permits Launch Services opens');
    const wrapper = fileURLToPath(new URL('./fixtures/chromium-no-apps.sh', import.meta.url));
    const output = execFileSync(wrapper, [], { env: { ...process.env, SLEIGHT_TEST_CHROMIUM_EXECUTABLE: executable }, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
    assert.deepEqual(JSON.parse(output), { openServiceDenied: true, lsopenDenied: true, appleEventsDenied: true, registrationAllowed: true });
    const child = spawn(wrapper, ['--wait'], { env: { ...process.env, SLEIGHT_TEST_CHROMIUM_EXECUTABLE: executable },
      stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('sandbox child did not become ready')), 5000);
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(Error('sandbox child exited before its probe')); });
      });
      const byPid = execFileSync(executable, [String(child.pid)], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
      assert.deepEqual(JSON.parse(byPid), JSON.parse(output), 'the same denies can be queried on a live external PID');
    } finally { child.stdin.end(); assert.deepEqual(await exited, { code: 0, signal: null }); }

  } finally { removeTemp(root); }
});
