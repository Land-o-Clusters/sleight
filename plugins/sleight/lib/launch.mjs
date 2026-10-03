// Starts the computer-use MCP server that ships with the ChatGPT desktop app.
//
// The ChatGPT app writes the server's launch config to a versioned folder,
// ~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json,
// and deletes the old folder on every update. Resolving the newest folder at
// each launch keeps the registration working across those updates.
//
//   launch.mjs           run the server over stdio, through relay.mjs
//   launch.mjs --doctor  print what would run, and check it exists

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay.mjs';

const PLUGIN_DIR = ['plugins', 'cache', 'openai-bundled', 'unified-computer-use'];
const SERVER_KEY = 'cua_repl';

function fail(message) {
  process.stderr.write(`sleight: ${message}\n`);
  process.exit(1);
}

// "26.930.31730" > "26.928.20755"; folders that are not dotted numbers sort first.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function resolveServer(env = process.env) {
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  const root = join(codexHome, ...PLUGIN_DIR);
  if (!existsSync(root)) {
    return { error: `no Codex computer-use plugin at ${root}. Install the ChatGPT desktop app and turn on Computer Use in Codex once.` };
  }
  const versions = readdirSync(root)
    .filter(v => /^\d+(\.\d+)*$/.test(v) && existsSync(join(root, v, '.mcp.json')))
    .sort(compareVersions);
  if (!versions.length) return { error: `no versioned .mcp.json under ${root}` };

  const version = versions.at(-1);
  const configPath = join(root, version, '.mcp.json');
  let server;
  try {
    server = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers?.[SERVER_KEY];
  } catch (err) {
    return { error: `could not read ${configPath}: ${err.message}` };
  }
  if (!server?.command) return { error: `${configPath} has no "${SERVER_KEY}" server` };

  const serverEnv = { ...server.env };
  // Codex's in-app browser only exists inside the ChatGPT app, so default to
  // native apps only. SLEIGHT_SURFACES=browser,computer opts back in.
  serverEnv.CUA_REPL_ENABLED_SURFACES = env.SLEIGHT_SURFACES || 'computer';

  return { version, configPath, command: server.command, args: server.args || [], env: serverEnv };
}

function doctor() {
  const s = resolveServer();
  if (s.error) fail(s.error);
  const checks = [
    ['node', s.command],
    ['server script', s.args[0]],
    ['node_repl', s.env.CUA_REPL_NODE_REPL_PATH],
    ['computer-use helper', s.env.SKY_CUA_SERVICE_PATH],
  ];
  console.log(`Codex computer-use ${s.version}`);
  console.log(`config    ${s.configPath}`);
  console.log(`surfaces  ${s.env.CUA_REPL_ENABLED_SURFACES}`);
  let ok = true;
  for (const [label, path] of checks) {
    const found = Boolean(path) && existsSync(path);
    ok &&= found;
    console.log(`${found ? 'ok     ' : 'MISSING'}   ${label}: ${path ?? '(not set)'}`);
  }
  process.exit(ok ? 0 : 1);
}

// SLEIGHT_TRACE=1 logs every relayed message to
// ~/Library/Logs/sleight/trace-<pid>.jsonl; any other value is used as the
// directory. Long strings (screenshots, UI state) are cut to 300 characters.
function traceTo(setting) {
  const dir = setting === '1' ? join(homedir(), 'Library', 'Logs', 'sleight') : setting;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `trace-${process.pid}.jsonl`);
  process.stderr.write(`sleight: tracing to ${file}\n`);
  const cut = (_key, value) =>
    typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…(${value.length})` : value;
  return (direction, msg) =>
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), direction, msg }, cut) + '\n');
}

// Asks about an app approval with sleight's own prompt (ask.js). The desktop
// app's Code tab (Claude 2.19675.0, 2026-10-03) declines MCP form prompts
// without showing them, so under it the relay asks this way instead. The
// prompt gives up (cancel) after five minutes; the engine waits that long.
const LIB = dirname(fileURLToPath(import.meta.url));
const ICON = join(LIB, '..', 'assets', 'icon.png');
const ASK_SECONDS = 300;

function askWithDialog(message, sessionScoped) {
  const app = /"(.+)"/.exec(message)?.[1];
  const question = app ? `Allow Claude to use ${app}?` : message;
  const detail = `Claude can then click and type in ${app ?? 'the app'} in the background. ` +
    (sessionScoped ? 'A yes lasts until this Claude session ends.' : 'It asks again next time.');
  const args = ['-l', 'JavaScript', join(LIB, 'ask.js'), question, detail, ICON, String(ASK_SECONDS)];
  return new Promise(resolve => {
    execFile('osascript', args, (err, stdout, stderr) => {
      const answer = stdout.trim();
      if (!err && ['accept', 'decline', 'cancel'].includes(answer)) return resolve(answer);
      // Logged, so a broken prompt doesn't pass for a decline.
      process.stderr.write(`sleight: approval prompt failed: ${stderr || err?.message || answer}\n`);
      resolve('decline');
    });
  });
}

// SLEIGHT_APPROVAL_PROMPT=dialog or client picks how approvals reach the user;
// by default the desktop app gets the dialog and everything else Claude Code's prompt.
function approvalPrompt(env = process.env) {
  const setting = env.SLEIGHT_APPROVAL_PROMPT || (env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop' ? 'dialog' : 'client');
  return setting === 'dialog' ? askWithDialog : undefined;
}

function run() {
  const s = resolveServer();
  if (s.error) fail(s.error);
  if (!existsSync(s.command)) fail(`server runtime missing: ${s.command}`);

  const child = spawn(s.command, s.args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...s.env },
  });
  child.on('error', err => fail(`could not start server: ${err.message}`));
  child.on('exit', code => process.exit(code ?? 0));

  const relay = createRelay({
    clientIn: process.stdin,
    clientOut: process.stdout,
    serverIn: child.stdin,
    serverOut: child.stdout,
    // SLEIGHT_APPROVAL_SCOPE=once asks again on every action instead.
    approvalScope: process.env.SLEIGHT_APPROVAL_SCOPE === 'once' ? 'once' : 'session',
    ask: approvalPrompt(),
    trace: process.env.SLEIGHT_TRACE ? traceTo(process.env.SLEIGHT_TRACE) : undefined,
  });

  // Claude Code closing the connection is the end of the session: end the
  // open turn so the server releases what it holds, then stop the server.
  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    await relay.endOpenTurn();
    child.stdin.end();
    setTimeout(() => child.kill(signal || 'SIGTERM'), 2000).unref();
  }
  process.stdin.on('end', () => stop());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => stop(signal));
  }
}

if (process.argv.includes('--doctor')) doctor();
else run();
