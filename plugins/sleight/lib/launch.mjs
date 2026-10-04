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
import { randomUUID } from 'node:crypto';
import { createRelay } from './relay.mjs';
import { loadFlowRules } from './flow-rules.mjs';
import { InputLease } from './input-lease.mjs';

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
const ownedHelpers = new Set();
let helpersClosing = false;
function ownHelper(child) {
  ownedHelpers.add(child);
  child.once('close', () => ownedHelpers.delete(child));
  return child;
}
async function stopHelpers() {
  helpersClosing = true;
  await Promise.all([...ownedHelpers].map(child => new Promise(resolve => {
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('close', () => { clearTimeout(force); resolve(); });
    child.kill('SIGTERM');
  })));
}

function askWithDialog(message, sessionScoped, options) {
  if (helpersClosing) return Promise.resolve('cancel');
  // The engine asks 'Allow Computer Use to use "App"?'; sleight's own tools ask in plain words.
  const app = /^Allow Computer Use to use "(.+)"\?$/.exec(message)?.[1];
  const question = app ? `Allow Claude to use ${app}?` : message;
  const review = options?.kind === 'review';
  const flow = options?.kind === 'flow';
  const detail = flow ? options.detail : review ? `${options.detail}\n\nUndo restores the session's original saved file. Reopen it in the app afterward. Later leaves the decision pending.` : (app ? `Claude can then click and type in ${app} in the background. ` : '') +
    (sessionScoped ? 'A yes lasts until this Claude session ends.' : 'It asks again next time.');
  const args = ['-l', 'JavaScript', join(LIB, 'ask.js'), question, detail, ICON, String(ASK_SECONDS), flow ? 'flow' : review ? 'review' : 'approval'];
  return new Promise(resolve => {
    ownHelper(execFile('osascript', args, (err, stdout, stderr) => {
      const answer = stdout.trim();
      if (!err && (review ? ['keep', 'undo', 'cancel'] : ['accept', 'decline', 'cancel']).includes(answer)) return resolve(answer);
      // Logged, so a broken prompt doesn't pass for a decline.
      process.stderr.write(`sleight: approval prompt failed: ${stderr || err?.message || answer}\n`);
      resolve('decline');
    }));
  });
}

// sleight's own tools for what the engine can't reach: apps' status items in
// the menu bar and notification banners (lib/menubar.js, System Events UI
// scripting). Each app's status item, and notifications as a whole, need the
// user's approval once per session.
const MENU_BAR_TOOLS = [
  {
    name: 'menu_bar',
    description: "Use apps' status items in the macOS menu bar (the icons at the right end), which the js tool can't reach. " +
      'op "apps" lists the apps that have one. "open" clicks an app\'s item and returns its menu (read, then closed again) ' +
      'or the window it opened, with numbered elements. "choose" clicks the menu item at `path`, a list of titles from the ' +
      'top menu down. "press" clicks `element` in the open window. "close" closes the menu. `item` picks among several ' +
      'items of one app (default 0). The user approves each app once per session.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['apps', 'open', 'choose', 'press', 'close'] },
        app: { type: 'string', description: 'The app, as "apps" names it' },
        path: { type: 'array', items: { type: 'string' } },
        element: { type: 'integer' },
        item: { type: 'integer' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'notifications',
    description: 'Read the notification banners on screen and press their buttons (such as Close or Snooze), which the js tool ' +
      'can\'t reach. op "list" returns each banner\'s texts and button names; "press" presses `button` on `banner`. ' +
      'The user approves notifications once per session.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'press'] },
        banner: { type: 'integer' },
        button: { type: 'string' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
];

const DRAG_TOOL = {
  name: 'drag',
  description: 'A drag that holds the mouse down and moves in steps, for what app.drag in the js tool can\'t do, such as ' +
    'moving selected text (select it with js first). `from` and `to` are in the same frame as the app\'s engine ' +
    'screenshot, from that window\'s top-left corner. Pass `windowId` when several windows fit; an ambiguous target refuses. ' +
    'Both points must be in window content; TextEdit requires the same text area. A lost-text error tells you to press Cmd+Z in the named window. ' +
    'It brings the app to the front and moves the real pointer ' +
    'for a few seconds, then puts both back, so use it only when app.drag fails. The user approves each app once per session.',
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: 'App name, bundle ID or path' },
      windowId: { type: 'integer', minimum: 1, description: 'Exact window ID from the engine inventory or app state' },
      from: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      holdMs: { type: 'integer', description: 'How long to hold before moving (default 500)' },
      steps: { type: 'integer', description: 'Moves between start and end (default 25)' },
    },
    required: ['app', 'from', 'to'],
    additionalProperties: false,
  },
};

function runScript(script, request) {
  if (helpersClosing) return Promise.resolve({ ok: false, error: 'sleight session is closing' });
  return new Promise(resolve => {
    ownHelper(execFile('osascript', ['-l', 'JavaScript', join(LIB, script), JSON.stringify(request)], { timeout: 30000 }, (err, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, error: stderr.trim() || err?.message || 'no output' });
      }
    }));
  });
}

const text = (value, isError) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], ...(isError ? { isError: true } : {}) });

export async function callLocalTool(name, args, approve) {
  if (name === 'drag') {
    if (!await approve(['drag', args.app], `Allow Claude to drag in ${args.app}? It moves your pointer for a few seconds.`)) {
      return text(`The user didn't allow dragging in ${args.app}. Stop and tell them; don't work around it.`, true);
    }
    const result = await runScript('drag.js', args);
    if (!result.ok) return text(result.error, true);
    const { ok, ...rest } = result;
    return text(rest);
  }
  let request;
  if (name === 'menu_bar') {
    if (args.op !== 'apps') {
      if (!args.app) return text('menu_bar needs `app` for this op.', true);
      if (!await approve(['menu_bar', args.app], `Allow Claude to use ${args.app}'s menu bar item?`)) {
        return text(`The user didn't allow ${args.app}'s menu bar item. Stop and tell them; don't work around it.`, true);
      }
    }
    request = args;
  } else {
    if (!await approve(['notifications'], 'Allow Claude to read and use your notifications?')) {
      return text("The user didn't allow notifications. Stop and tell them; don't work around it.", true);
    }
    request = args.op === 'list' ? { op: 'notifications' } : { op: 'notify-press', banner: args.banner, button: args.button };
  }
  const result = await runScript('menubar.js', request);
  if (result.ok) {
    const { ok, ...rest } = result;
    return text(rest);
  }
  const hint = result.accessibility
    ? ' macOS hasn\'t given the app running Claude Code Accessibility permission. Turn it on under System Settings → Privacy & Security → Accessibility (for Terminal, iTerm or Claude, whichever runs this session).'
    : '';
  return text(`${result.error}${hint}`, true);
}

// SLEIGHT_APPROVAL_PROMPT=dialog or client picks how approvals reach the user;
// by default the desktop app gets the dialog and everything else Claude Code's prompt.
function approvalPrompt(env = process.env) {
  const setting = env.SLEIGHT_APPROVAL_PROMPT || (env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop' ? 'dialog' : 'client');
  return setting === 'dialog' ? askWithDialog : undefined;
}

export function run({ leaseDirectory } = {}) {
  let flowRules;
  try { flowRules = loadFlowRules(); } catch (err) { fail(err.message); }
  const s = resolveServer();
  if (s.error) fail(s.error);
  if (!existsSync(s.command)) fail(`server runtime missing: ${s.command}`);

  const child = spawn(s.command, s.args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...s.env },
  });
  child.on('error', err => fail(`could not start server: ${err.message}`));
  child.on('close', async code => { await stopHelpers(); relay.close(); process.exit(code ?? 0); });
  let terminating = false;
  function terminateEngine(signal = 'SIGTERM') {
    if (terminating) return;
    terminating = true;
    child.stdin.end();
    // The launcher owns this child. Finish collecting it before exit cleanup
    // releases the leases, including when a call or approval never answers.
    setTimeout(() => child.kill(signal), 2000).unref();
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }
  const sessionId = randomUUID();

  const relay = createRelay({
    clientIn: process.stdin,
    clientOut: process.stdout,
    serverIn: child.stdin,
    serverOut: child.stdout,
    sessionId,
    // SLEIGHT_APPROVAL_SCOPE=once asks again on every action instead.
    approvalScope: ['once', 'document'].includes(process.env.SLEIGHT_APPROVAL_SCOPE) ? process.env.SLEIGHT_APPROVAL_SCOPE : 'session',
    ask: approvalPrompt(),
    flowRules,
    changeReview: process.env.SLEIGHT_CHANGE_REVIEW === '1',
    // End the engine's turn after 30 s without a running call, so the app it
    // holds is released even where the mod doesn't run. 0 turns this off.
    idleTurnEndMs: Number(process.env.SLEIGHT_IDLE_TURN_END_MS ?? 30000),
    inputLease: new InputLease({ directory: leaseDirectory, holder: `session ${sessionId} (pid ${process.pid})` }),
    onLeaseFault: err => { process.stderr.write(`sleight: ${err.message}; stopping the owned engine.\n`); terminateEngine(); },
    // SLEIGHT_MENU_BAR=0 leaves out the menu bar and notification tools,
    // SLEIGHT_DRAG=0 the drag tool.
    localTools: {
      tools: [
        ...(process.env.SLEIGHT_MENU_BAR === '0' ? [] : MENU_BAR_TOOLS),
        ...(process.env.SLEIGHT_DRAG === '0' ? [] : [DRAG_TOOL]),
      ],
      call: callLocalTool,
      target: async args => {
        const result = await runScript('lease-target.js', args);
        if (!result.ok) throw new Error(`Input lease: ${result.error}`);
        return result.target;
      },
    },
    trace: process.env.SLEIGHT_TRACE ? traceTo(process.env.SLEIGHT_TRACE) : undefined,
  });
  process.once('exit', () => relay.close());

  // Claude Code closing the connection is the end of the session: end the
  // open turn so the server releases what it holds, then stop the server.
  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    // Begin the deadline before draining, not after an unanswered call.
    const deadline = setTimeout(() => terminateEngine(signal), 3000);
    deadline.unref();
    await relay.shutdown();
    clearTimeout(deadline);
    terminateEngine(signal);
  }
  process.stdin.on('end', () => stop());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => stop(signal));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--doctor')) doctor();
  else run();
}
