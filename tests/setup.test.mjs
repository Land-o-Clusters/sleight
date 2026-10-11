import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { serverFromChatGPTApp, setup } from '../plugins/sleight/lib/setup.mjs';

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
  const root = await mkdtemp(join(tmpdir(), 'sleight-setup-'));
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
  assert.match(lines.join('\n'), /install.*ChatGPT/i);
  assert.deepEqual(opened, []);
  assert.deepEqual(doctors, []);
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
