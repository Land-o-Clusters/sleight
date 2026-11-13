import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { serverFromChatGPTApp, setup } from '../plugins/sleight/lib/setup.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const NODE_REL = 'Contents/Resources/cua_node/bin/node';
const REPL_REL = 'Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs';
const MODULES_REL = 'Contents/Resources/cua_node/lib/node_modules';
const REPL_BIN_REL = 'Contents/Resources/cua_node/bin/node_repl';
const CODEX_REL = 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const HELPER_REL = 'Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app';
const INSTALLER_REL = `${HELPER_REL}/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/MacOS/Codex Computer Use Installer`;
const ACCESSIBILITY = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const SCREEN_RECORDING = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

function probeEnv(app, codexHome) {
  const node = join(app, NODE_REL);
  const modules = join(app, MODULES_REL);
  return {
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
    NODE_REPL_NODE_MODULE_DIRS: modules,
    NODE_REPL_NODE_PATH: node,
    NODE_REPL_TRUSTED_CODE_PATHS: `${codexHome}:${modules}`,
    NODE_REPL_TRUSTED_SERVICES: '{"browser":"@oai/browser-desktop/service","sky":"@oai/sky/service"}',
    NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE: 'Control desktop apps on macOS through Computer Use.',
    CODEX_HOME: codexHome,
    CODEX_CLI_PATH: join(app, CODEX_REL),
    CUA_REPL_NODE_REPL_PATH: join(app, REPL_BIN_REL),
    CUA_REPL_ENABLED_SURFACES: 'computer',
    SKY_CUA_SERVICE_PATH: join(app, HELPER_REL),
  };
}

async function fakeBundle(t, { status = 'OK: installed', statusExit = 0 } = {}) {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-setup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'ChatGPT.app');
  const installer = join(app, INSTALLER_REL);
  await mkdir(join(installer, '..'), { recursive: true });
  await mkdir(join(app, 'Contents/Resources/cua_node/bin'), { recursive: true });
  await mkdir(join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin'), { recursive: true });
  await mkdir(join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>26.0</string>
</dict></plist>
`);
  const logFile = join(root, 'installer.log');
  await writeFile(installer, `#!/bin/sh
printf '%s\\n' "$1" >> ${JSON.stringify(logFile)}
if [ "$1" = status ]; then
  printf '%s\\n' ${JSON.stringify(status)}
  exit ${statusExit}
fi
exit 0
`, { mode: 0o755 });
  await writeFile(join(app, NODE_REL), '');
  await writeFile(join(app, REPL_REL), '');
  await writeFile(join(app, REPL_BIN_REL), '');
  await writeFile(join(app, CODEX_REL), '');
  return { root, app, logFile, installer, codexHome: join(root, 'codex') };
}

function harness(bundle) {
  const lines = [];
  const opened = [];
  const doctors = [];
  const env = { SLEIGHT_CHATGPT_APP: bundle.app, CODEX_HOME: bundle.codexHome };
  return {
    env, lines, opened, doctors,
    opts: {
      env,
      log: line => lines.push(line),
      open: url => opened.push(url),
      resolveServer: () => ({
        version: '26.0', configPath: join(bundle.app, REPL_REL),
        command: join(bundle.app, NODE_REL), args: [join(bundle.app, REPL_REL)], env: {},
      }),
      doctor: async ({ log }) => {
        doctors.push(true);
        log('live read ok (helper inventory)');
        return 0;
      },
    },
  };
}

async function installerCalls(logFile) {
  if (!existsSync(logFile)) return [];
  const text = await readFile(logFile, 'utf8');
  return text.trim() ? text.trim().split('\n') : [];
}

function mockVersionRead(t, run) {
  t.mock.method(childProcess, 'execFileSync', run);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('setup stops when ChatGPT.app is missing', async () => {
  const lines = [];
  const opened = [];
  const doctors = [];
  const code = await setup({
    env: { SLEIGHT_CHATGPT_APP: '/no-such-ChatGPT.app' },
    log: line => lines.push(line),
    open: url => opened.push(url),
    doctor: async () => { doctors.push(true); return 0; },
    resolveServer: () => assert.fail('resolveServer'),
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /ChatGPT\.app not found\. Install the ChatGPT desktop app/);
  assert.doesNotMatch(lines.join('\n'), /timed out/i);
  assert.deepEqual(opened, []);
  assert.deepEqual(doctors, []);
});

for (const command of ['/usr/bin/plutil', '/usr/bin/defaults']) {
  test(`setup reports a ${command.split('/').at(-1)} version timeout and stops before installation`, async t => {
    const bundle = await fakeBundle(t);
    const h = harness(bundle), calls = [];
    mockVersionRead(t, file => {
      calls.push(file);
      if (file === command) throw Object.assign(new Error(`spawnSync ${file} ETIMEDOUT`), { code: 'ETIMEDOUT', signal: 'SIGKILL' });
      throw Object.assign(new Error('invalid plist'), { status: 1 });
    });
    const code = await setup(h.opts);
    assert.equal(code, 1);
    assert.match(h.lines.join('\n'), /version.*timed out/i);
    assert.match(h.lines.join('\n'), new RegExp(command.split('/').at(-1)));
    assert.match(h.lines.join('\n'), /run setup again/i);
    assert.doesNotMatch(h.lines.join('\n'), /not found|Install the ChatGPT desktop app/);
    assert.deepEqual(calls, ['/usr/bin/plutil', '/usr/bin/defaults']);
    assert.deepEqual(await installerCalls(bundle.logFile), []);
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.doctors, []);
  });
}

test('setup still uses defaults when plutil fails without timing out', async t => {
  const bundle = await fakeBundle(t);
  const h = harness(bundle), calls = [];
  mockVersionRead(t, file => {
    calls.push(file);
    if (file === '/usr/bin/plutil') throw Object.assign(new Error('invalid plist'), { status: 1 });
    assert.equal(file, '/usr/bin/defaults');
    return '26.0\n';
  });
  assert.equal(await setup({ ...h.opts, dryRun: true }), 0);
  assert.deepEqual(calls, ['/usr/bin/plutil', '/usr/bin/defaults']);
  assert.match(h.lines.join('\n'), /ChatGPT\.app 26\.0/);
  assert.deepEqual(await installerCalls(bundle.logFile), []);
  assert.deepEqual(h.opened, []);
});

test('setup uses defaults when plutil times out', async t => {
  const bundle = await fakeBundle(t);
  const h = harness(bundle), calls = [];
  mockVersionRead(t, file => {
    calls.push(file);
    if (file === '/usr/bin/plutil') throw Object.assign(new Error('spawnSync plutil ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGKILL' });
    return '26.0\n';
  });
  assert.equal(await setup({ ...h.opts, dryRun: true }), 0);
  assert.deepEqual(calls, ['/usr/bin/plutil', '/usr/bin/defaults']);
  assert.match(h.lines.join('\n'), /ChatGPT\.app 26\.0/);
  assert.doesNotMatch(h.lines.join('\n'), /timed out|not found/);
});

test('setup names both readers when both time out', async t => {
  const bundle = await fakeBundle(t);
  const h = harness(bundle);
  mockVersionRead(t, file => { throw Object.assign(new Error(`spawnSync ${file} ETIMEDOUT`), { code: 'ETIMEDOUT' }); });
  assert.equal(await setup(h.opts), 1);
  assert.match(h.lines.join('\n'), /version check timed out \(plutil and defaults, 30 seconds\)/);
  assert.doesNotMatch(h.lines.join('\n'), /not found/);
  assert.deepEqual(h.doctors, []);
});

test('setup reports an unreadable version separately from a missing app', async t => {
  const bundle = await fakeBundle(t);
  const h = harness(bundle);
  mockVersionRead(t, () => {
    throw Object.assign(new Error('invalid plist'), { status: 1 });
  });
  assert.equal(await setup(h.opts), 1);
  assert.match(h.lines.join('\n'), /could not read.*version/i);
  assert.match(h.lines.join('\n'), /run setup again/i);
  assert.doesNotMatch(h.lines.join('\n'), /not found|timed out/);
  assert.deepEqual(await installerCalls(bundle.logFile), []);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.doctors, []);
});

test('fallback server resolution keeps bundle metadata when the version reader times out', async t => {
  const bundle = await fakeBundle(t);
  mockVersionRead(t, () => { throw Object.assign(new Error('version read timed out'), { code: 'ETIMEDOUT' }); });
  const server = serverFromChatGPTApp({ app: bundle.app, env: { CODEX_HOME: bundle.codexHome } });
  assert.equal(server.error, undefined);
  assert.equal(server.version, 'bundle');
  assert.equal(server.command, join(bundle.app, NODE_REL));
});

test('setup skips install when installer status is OK', async t => {
  const bundle = await fakeBundle(t);
  const h = harness(bundle);
  const code = await setup(h.opts);
  assert.equal(code, 0);
  assert.match(h.lines.join('\n'), /ChatGPT\.app 26\.0/);
  assert.equal(h.lines.some(line => /administrator's Touch ID or password/.test(line)), false);
  assert.deepEqual(await installerCalls(bundle.logFile), ['status']);
  assert.deepEqual(h.opened, [ACCESSIBILITY, SCREEN_RECORDING]);
  assert.match(h.lines.join('\n'), /Codex Computer Use/);
  assert.deepEqual(h.doctors, [true]);
  assert.match(h.lines.join('\n'), /live read ok/);
});

test('setup runs install when installer status is not OK', async t => {
  const bundle = await fakeBundle(t, { status: 'not installed' });
  const h = harness(bundle);
  const code = await setup(h.opts);
  assert.equal(code, 0);
  assert.match(h.lines.join('\n'), /administrator's Touch ID or password/);
  assert.doesNotMatch(h.lines.join('\n'), /password=/);
  assert.deepEqual(await installerCalls(bundle.logFile), ['status', 'install']);
  assert.deepEqual(h.opened, [ACCESSIBILITY, SCREEN_RECORDING]);
  assert.deepEqual(h.doctors, [true]);
});

test('setup runs install when status says NOT OK', async t => {
  const bundle = await fakeBundle(t, { status: 'NOT OK: helper missing' });
  const h = harness(bundle);
  assert.equal(await setup(h.opts), 0);
  assert.deepEqual(await installerCalls(bundle.logFile), ['status', 'install']);
});

test('setup dry-run prints commands and runs nothing', async t => {
  const bundle = await fakeBundle(t, { status: 'not installed' });
  const h = harness(bundle);
  const code = await setup({ ...h.opts, dryRun: true });
  assert.equal(code, 0);
  const text = h.lines.join('\n');
  assert.match(text, /ChatGPT\.app 26\.0/);
  assert.match(text, new RegExp(bundle.installer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /status/);
  assert.match(text, /install/);
  assert.match(text, new RegExp(ACCESSIBILITY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, new RegExp(SCREEN_RECORDING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(await installerCalls(bundle.logFile), []);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.doctors, []);
});

test('the fallback server definition matches the probe v2 env', async t => {
  const bundle = await fakeBundle(t);
  const got = serverFromChatGPTApp({ app: bundle.app, env: { CODEX_HOME: bundle.codexHome } });
  assert.equal(got.error, undefined);
  assert.equal(got.command, join(bundle.app, NODE_REL));
  assert.deepEqual(got.args, [join(bundle.app, REPL_REL)]);
  assert.deepEqual(got.env, probeEnv(bundle.app, bundle.codexHome));
  const resolved = resolveServer({ CODEX_HOME: bundle.codexHome, SLEIGHT_CHATGPT_APP: bundle.app });
  assert.equal(resolved.command, got.command);
  assert.deepEqual(resolved.args, got.args);
  assert.equal(resolved.env.SKY_CUA_SERVICE_PATH, join(bundle.app, HELPER_REL));
  assert.equal(resolved.env.CUA_REPL_ENABLED_SURFACES, 'computer');
});
