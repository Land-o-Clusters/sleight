import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);
const INSTALLER_REL = 'Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/MacOS/Codex Computer Use Installer';
const HELPER_REL = 'Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app';
const NODE_REL = 'Contents/Resources/cua_node/bin/node';
const REPL_REL = 'Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs';
const MODULES_REL = 'Contents/Resources/cua_node/lib/node_modules';
const NODE_REPL_REL = 'Contents/Resources/cua_node/bin/node_repl';
const CODEX_CLI_REL = 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const PANES = [
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
];

function chatgptApp(env = process.env) {
  return env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app';
}

function appVersion(app) {
  const plist = join(app, 'Contents/Info.plist');
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist],
      { encoding: 'utf8' }).trim();
  } catch {
    try {
      return execFileSync('/usr/bin/defaults', ['read', plist, 'CFBundleShortVersionString'],
        { encoding: 'utf8' }).trim();
    } catch { return undefined; }
  }
}

export function serverFromChatGPTApp({ app, env = process.env, home = homedir() } = {}) {
  const chatgpt = app || chatgptApp(env);
  const node = join(chatgpt, NODE_REL);
  const repl = join(chatgpt, REPL_REL);
  const modules = join(chatgpt, MODULES_REL);
  const helper = join(chatgpt, HELPER_REL);
  if (!existsSync(chatgpt) || !existsSync(node) || !existsSync(repl) || !existsSync(helper)) {
    return { error: `no ChatGPT computer-use engine in ${chatgpt}` };
  }
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  return {
    version: appVersion(chatgpt) || 'bundle',
    configPath: repl,
    command: node,
    args: [repl],
    env: {
      NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
      NODE_REPL_NODE_MODULE_DIRS: modules,
      NODE_REPL_NODE_PATH: node,
      NODE_REPL_TRUSTED_CODE_PATHS: `${codexHome}:${modules}`,
      NODE_REPL_TRUSTED_SERVICES: '{"browser":"@oai/browser-desktop/service","sky":"@oai/sky/service"}',
      NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE: 'Control desktop apps on macOS through Computer Use.',
      CODEX_HOME: codexHome,
      CODEX_CLI_PATH: join(chatgpt, CODEX_CLI_REL),
      CUA_REPL_NODE_REPL_PATH: join(chatgpt, NODE_REPL_REL),
      CUA_REPL_ENABLED_SURFACES: 'computer',
      SKY_CUA_SERVICE_PATH: helper,
    },
  };
}

function defaultOpen(url) {
  return execFileAsync('/usr/bin/open', [url]);
}

async function runInstaller(execFile, installer, args) {
  try {
    return await execFile(installer, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    err.stdout ??= '';
    err.stderr ??= '';
    throw err;
  }
}

function statusOk(result, failed) {
  const text = `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim();
  return !failed && /^OK\b/m.test(text);
}

export async function setup({
  env = process.env,
  log = console.log,
  dryRun = false,
  resolveServer: resolve,
  doctor: runDoctor,
  open = defaultOpen,
  execFile = execFileAsync,
} = {}) {
  const app = chatgptApp(env);
  const version = existsSync(app) ? appVersion(app) : undefined;
  if (!version) {
    log('ChatGPT.app not found. Install the ChatGPT desktop app from https://chatgpt.com/download/ and run setup again.');
    return 1;
  }
  log(`ChatGPT.app ${version} at ${app}`);
  const installer = join(app, INSTALLER_REL);
  if (dryRun) {
    log(`would run: ${installer} status`);
    log(`would run: ${installer} install`);
    for (const url of PANES) log(`would open: ${url}`);
    log("would run doctor's live read");
    return 0;
  }
  if (!existsSync(installer)) {
    log(`helper installer missing: ${installer}`);
    return 1;
  }
  let status;
  let failed = false;
  try { status = await runInstaller(execFile, installer, ['status']); }
  catch (err) { status = err; failed = true; }
  if (!statusOk(status, failed)) {
    log("macOS will ask for an administrator's Touch ID or password");
    try { await runInstaller(execFile, installer, ['install']); }
    catch (err) {
      log(`helper installer failed: ${(err.stderr || err.stdout || err.message).toString().trim()}`);
      return 1;
    }
    log('helper installer: ran install');
  } else log(`helper installer: ${(status.stdout || 'OK').toString().trim()}`);

  const resolveFn = resolve ?? (await import('./launch.mjs')).resolveServer;
  const server = resolveFn(env);
  if (server.error) { log(`sleight: ${server.error}`); return 1; }
  log(`engine config ${server.configPath}`);
  mkdirSync(env.CODEX_HOME || join(homedir(), '.codex'), { recursive: true });
  for (const url of PANES) await open(url);
  log('allow Codex Computer Use in Accessibility and Screen Recording');
  const doctorFn = runDoctor ?? (await import('./launch.mjs')).doctor;
  return doctorFn({ env, log });
}
