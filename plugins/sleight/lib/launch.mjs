// Starts the computer-use MCP server that ships with the ChatGPT desktop app.
//
// The ChatGPT app writes the server's launch config to a versioned folder,
// ~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json,
// and deletes the old folder on every update. Resolving the newest folder at
// each launch keeps the registration working across those updates.
//
//   launch.mjs           run the server over stdio, through relay.mjs
//   launch.mjs --doctor  print what would run, and check it exists
//   launch.mjs record|replay …  turn a finished run into a script, and run it again (replay.mjs)

import { execFile, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { discoverExtensions } from './browser-discovery.mjs';
import { createSurfaceCache, refreshAfterInitialize } from './surface-cache.mjs';
import { createRelay } from './relay.mjs';
import { createAppHealthHelper, diagnoseReadFailure } from './read-failure.mjs';
import { loadFlowRules } from './flow-rules.mjs';
import { InputLease } from './input-lease.mjs';
import { loadPreapproved } from './preapproved.mjs';
import { createGrantAudit } from './preapproved-audit.mjs';
import { BLOCKED_APP_TOOL, callBlockedApp, forbiddenTargetsAllowed } from './blocked-apps.mjs';
import { SELECT_WINDOW_TOOL, selectWindow } from './select-window.mjs';
import { probeHelper, staleHelperJobs } from './helper-health.mjs';
import { replayBridge } from './replay.mjs';

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
  // Automatic selection below uses only a recent connected-extension inventory.
  serverEnv.CUA_REPL_ENABLED_SURFACES = env.SLEIGHT_SURFACES || 'computer';

  return { version, configPath, command: server.command, args: server.args || [], env: serverEnv };
}

export function selectSurfaces(server, env = process.env, options) {
  if (env.SLEIGHT_SURFACES) {
    server.env.CUA_REPL_ENABLED_SURFACES = env.SLEIGHT_SURFACES;
    return;
  }
  const cache = createSurfaceCache(server, options);
  server.env.CUA_REPL_ENABLED_SURFACES = cache.connected ? 'browser,computer' : 'computer';
  server.env.BROWSER_USE_AVAILABLE_BACKENDS = 'chrome';
  return cache;
}

// Doctor checks live availability; launch uses the cache without a synchronous discovery engine.
export async function probeSurfaces(server, env = process.env, options) {
  if (env.SLEIGHT_SURFACES) {
    server.env.CUA_REPL_ENABLED_SURFACES = env.SLEIGHT_SURFACES;
    return;
  }
  const browsers = await discoverExtensions(server, options);
  server.env.CUA_REPL_ENABLED_SURFACES = browsers.length ? 'browser,computer' : 'computer';
  // The in-app browser needs ChatGPT host context. Auto mode uses extensions only.
  server.env.BROWSER_USE_AVAILABLE_BACKENDS = 'chrome';
}

// The helper's own opt-out of its app refusals, which only the user sets.
const readForbiddenTargets = () => execFileSync('/usr/bin/defaults', ['read', '-g', 'ComputerUseAllowForbiddenTargets'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });

const listLaunchdJobs = () => new Promise((resolve, reject) =>
  execFile('/bin/launchctl', ['list'], { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

export async function doctor({ env = process.env, log = console.log, app = process.argv.includes('--doctor') ? process.argv[process.argv.indexOf('--doctor') + 1] : undefined, timeoutMs = 5000, startupTimeoutMs = 10000, launchctlList = listLaunchdJobs, forbiddenTargets = readForbiddenTargets, preapprovedIO, auditDirectory } = {}) {
  if (app !== undefined && (typeof app !== 'string' || !app.trim() || app.startsWith('-'))) {
    log('usage: sleight-mcp --doctor [running app name or bundle ID]'); return 1;
  }
  const s = resolveServer(env);
  if (s.error) { log(`sleight: ${s.error}`); return 1; }
  await probeSurfaces(s, env);
  const checks = [
    ['node', s.command],
    ['server script', s.args[0]],
    ['node_repl', s.env.CUA_REPL_NODE_REPL_PATH],
    ['computer-use helper', s.env.SKY_CUA_SERVICE_PATH],
  ];
  log(`Codex computer-use ${s.version}`);
  log(`config    ${s.configPath}`);
  log(`surfaces  ${s.env.CUA_REPL_ENABLED_SURFACES}`);
  log(`refused apps  ${forbiddenTargetsAllowed(forbiddenTargets) ? 'allowed through the engine (ComputerUseAllowForbiddenTargets is on)' : 'refused by the engine; blocked_app drives them'}`);
  let ok = true;
  for (const [label, path] of checks) {
    const found = Boolean(path) && existsSync(path);
    ok &&= found;
    log(`${found ? 'ok     ' : 'MISSING'}   ${label}: ${path ?? '(not set)'}`);
  }
  if (!ok) return 1;
  let preapproved, grantAudit;
  if (app !== undefined) {
    try {
      preapproved = loadPreapproved(preapprovedIO);
      grantAudit = preapproved.size ? createGrantAudit(auditDirectory) : undefined;
    } catch (err) { log(`sleight: ${err.message}`); return 1; }
  }
  let probe;
  try { probe = await probeHelper(s, { app, preapproved, grantAudit, timeoutMs, startupTimeoutMs }); }
  catch (err) { log(`live read cleanup FAILED: ${err.message}`); return 1; }
  if (probe.ok || probe.inventoryOk) log('live read ok (helper inventory)');
  if (probe.appRead) {
    const read = probe.appRead;
    log(read.status === 'skipped' ? `app read skipped (${app}): ${read.reason}`
      : `app read ${read.status === 'ok' ? 'ok' : 'FAILED'} (${app}): ${read.ms} ms, window header: ${read.hasWindowHeader ? 'yes' : 'no'}${read.error ? `; ${read.error}` : ''}`);
    return probe.ok ? 0 : 1;
  }
  if (probe.ok) return 0;
  log(`live read FAILED: ${probe.error}`);
  if (/startup request failed/i.test(probe.error)) {
    const jobs = staleHelperJobs(await launchctlList().catch(() => ''));
    log(jobs.length
      ? `macOS won't relaunch the helper while launchd keeps its old job. This clears it without restarting ChatGPT:\n${jobs.map(j => `  launchctl remove ${j}`).join('\n')}`
      : 'macOS refused to launch the helper. Check that the ChatGPT app is installed and Computer Use is on in Codex.');
  }
  if (probe.stuck) log('SkyComputerUseService helper appears stuck. Stop retrying. The user needs to restart ChatGPT; this ends their Codex sessions. Never quit or restart ChatGPT automatically.');
  return 1;
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

export function approvalLogging(preapproved, env = process.env, auditDirectory) {
  return {
    trace: env.SLEIGHT_TRACE ? traceTo(env.SLEIGHT_TRACE) : undefined,
    grantAudit: preapproved.size ? createGrantAudit(auditDirectory) : undefined,
  };
}

// Asks about an app approval with sleight's own prompt (ask.js). The desktop
// app's Code tab (Claude 2.19675.0, 2026-10-03) declines MCP form prompts
// without showing them, so under it the relay asks this way instead. The
// prompt gives up (cancel) after five minutes; the engine waits that long.
const LIB = dirname(fileURLToPath(import.meta.url));

// The skill's body, sent after the engine's first-call docs. Missing or unreadable means none.
export function skillRules(path = join(LIB, '..', 'skills', 'drive-mac-apps', 'SKILL.md')) {
  try { return readFileSync(path, 'utf8').replace(/^---\n[\s\S]*?\n---\n+/, '').trim() || undefined; }
  catch { return undefined; }
}
const ICON = join(LIB, '..', 'assets', 'icon.png');
const ASK_SECONDS = 300;
const ownedHelpers = new Set();
const pendingDrags = new Set();
let helpersClosing = false;
function ownHelper(child) {
  ownedHelpers.add(child);
  child.once('close', () => ownedHelpers.delete(child));
  return child;
}
export async function stopHelpers() {
  helpersClosing = true;
  await Promise.all([...ownedHelpers].map(child => new Promise(resolve => {
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('close', () => { clearTimeout(force); resolve(); });
    child.kill('SIGTERM');
  })));
  // A cancelled drag may start its restoration helper after the child snapshot.
  // The whole operation owns that cleanup, so drain it before the launcher exits.
  await Promise.allSettled([...pendingDrags]);
}

export function askWithDialog(message, sessionScoped, options = {}, launch = execFile) {
  if (helpersClosing) return Promise.resolve('cancel');
  // The engine asks 'Allow Computer Use to use "App"?'; sleight's own tools ask in plain words.
  const app = /^Allow Computer Use to use "(.+)"\?$/.exec(message)?.[1];
  const claudeCode = options.claudeCode !== false;
  let question = app ? `Allow Claude to use ${app}?` : message;
  if (!claudeCode) question = question.replace(/^Allow Claude to /, 'Allow this agent to ');
  const review = options?.kind === 'review';
  const flow = options?.kind === 'flow';
  // Blocked-app consent and terminal sends bring their own plain-words detail.
  const detail = flow || options?.kind === 'blocked' ? options.detail : review ? `${options.detail}\n\nUndo restores the saved copy shown above. Reopen it in the app afterward. Later leaves the decision pending.` : (app ? `${claudeCode ? 'Claude' : 'The agent'} can then click and type in ${app} in the background. ` : '') +
    (sessionScoped ? `A yes lasts until ${claudeCode ? 'this Claude session' : 'this sleight server session'} ends.` : 'It asks again next time.');
  const args = ['-l', 'JavaScript', join(LIB, 'ask.js'), question, detail, ICON, String(ASK_SECONDS), flow ? 'flow' : review ? 'review' : 'approval', claudeCode ? 'claude-code' : 'generic'];
  return new Promise((resolve, reject) => {
    ownHelper(launch('osascript', args, (err, stdout, stderr) => {
      const answer = stdout.trim();
      if (!err && (review ? ['keep', 'undo', 'cancel'] : ['accept', 'decline', 'cancel']).includes(answer)) return resolve(answer);
      // Logged, so a broken prompt doesn't pass for a decline.
      process.stderr.write(`sleight: approval prompt failed: ${stderr || err?.message || answer}\n`);
      reject(Object.assign(new Error("The approval prompt couldn't be shown. The user made no decision. Stop and tell them."), { code: 'SLEIGHT_PROMPT_UNAVAILABLE' }));
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
      "Not for an app's own menus (File, Edit, Format, View): those are in its tree, so use js. " +
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
    'It tries background PID posting first, with a 500 ms hold. When another app covers the points, or the posted drag ' +
    'leaves TextEdit text unchanged, it moves the text through Accessibility instead, with no pointer or focus change. ' +
    'Only if that fails does it fall back to foreground, after the user has paused typing and using the mouse; ' +
    'an unavailable private window-local API also selects foreground before posting. The result names the path. ' +
    'Foreground fallback moves the pointer and restores it and the front app. Other apps require readback to verify the move. ' +
    'For a line-end text drop, use the final glyph bounds, never a zero-length end-of-line range. The user approves each app once per session.',
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

export function localToolDefinitions(env = process.env) {
  return [
    ...(env.SLEIGHT_SELECT_WINDOW === '0' ? [] : [SELECT_WINDOW_TOOL]),
    ...(env.SLEIGHT_MENU_BAR === '0' ? [] : MENU_BAR_TOOLS),
    ...(env.SLEIGHT_HOVER === '0' ? [] : [HOVER_TOOL]),
    BLOCKED_APP_TOOL,
    ...(env.SLEIGHT_DRAG === '0' ? [] : [DRAG_TOOL]),
  ];
}

export const HOVER_TOOL = {
  name: 'hover',
  description: 'Hover with the real pointer only after Help text, secondary actions, right-click and keys fail. ' +
    'Tell the user first that it will move their pointer and bring the app forward for about N seconds: ' +
    'the dwell plus capture and restoration (about two seconds with the default dwell). ' +
    '`at` is relative to the selected window\'s top-left corner. Supply an exact `windowTitle` when more than one window is on screen. ' +
    'Requires Screen Recording permission. Refuses points covered by another app or a different window of the same app; do not retry unchanged. ' +
    'Brings the app forward, waits for hover UI, captures a screenshot while hovered, then ' +
    'restores the pointer and front app. Reports takeoverMs. The user approves each app once per session.',
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', minLength: 1, description: 'App name, bundle ID or path' },
      windowTitle: { type: 'string', minLength: 1, description: 'Exact on-screen window title; required when the app has several windows. Missing or duplicate matches refuse.' },
      at: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 2 },
      waitMs: { type: 'integer', minimum: 100, maximum: 4000, description: 'Hover dwell, default 1500 ms; increase only if needed' },
    },
    required: ['app', 'at'], additionalProperties: false,
  },
};

export function runScript(script, request, options = {}) {
  // Tests pass a stand-in for execFile directly; the drag cleanup path passes { cleanup: true }.
  const { cleanup = false, run = execFile } = typeof options === 'function' ? { run: options } : options;
  if (helpersClosing && !cleanup) return Promise.resolve({ ok: false, error: 'sleight session is closing' });
  // Base64 PNGs from ordinary app windows can exceed execFile's 1 MiB default.
  const execOptions = { timeout: cleanup ? 3000 : 30000, ...(script === 'hover.js' ? { maxBuffer: 16 * 1024 * 1024 } : {}) };
  return new Promise(resolve => {
    ownHelper(run('osascript', ['-l', 'JavaScript', join(LIB, script), JSON.stringify(request)], execOptions, (err, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        // A killed child prints nothing, and execFile's message is only the command line
        // (chess-drag, 2026-10-09). Say what happened instead.
        const timedOut = err?.killed && !stderr.trim();
        resolve({ ok: false, timedOut: !!timedOut, error: timedOut
          ? `${script} timed out after ${execOptions.timeout / 1000} s and was stopped; whether it pressed anything is unknown. Read the window again before acting`
          : stderr.trim() || err?.message || 'no output' });
      }
    }));
  });
}

// Set in run(); the trace writer is on whenever tracing is asked for or the
// blocked-apps feature is enabled, so every blocked_app action reaches it.
let relayTrace = () => {};

const text = (value, isError) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], ...(isError ? { isError: true } : {}) });

async function performDrag(args, runLocal) {
  const focus = await runLocal('drag-focus.js', { op: 'capture', app: args.app });
  if (!focus.ok) return text(focus.error, true);
  let result;
  try { result = await runLocal('drag.js', args); }
  catch (e) { result = { ok: false, error: String(e.message || e) }; }
  finally {
    // A completed background or Accessibility attempt never owned focus, including lost text.
    // Unknown child termination retains the existing guarded timeout cleanup.
    if (!['background', 'accessibility', 'none'].includes(result?.path)) {
      if (!result?.path) {
        // The child ended without reporting (a timeout or a crash), maybe mid-press.
        try {
          const released = await runLocal('drag-focus.js', { op: 'release' }, { cleanup: true });
          if (released?.released) result = { ...result, ok: false, error: [result?.error, 'a posted mouse button was still down, so sleight released it'].filter(Boolean).join('; ') };
        } catch {}
      }
      try {
        const restored = await runLocal('drag-focus.js', { ...focus, op: 'restore' }, { cleanup: true });
        if (!restored.ok) throw new Error(restored.error);
      } catch (e) {
        result = { ...result, ok: false, error: [result?.error, `Focus restoration failed: ${e.message || e}`].filter(Boolean).join('; ') };
      }
    }
  }
  const { ok, ...rest } = result;
  return text(rest, !ok);
}

// target is the resolved lease target the relay passes (bundle ID and pid),
// which pins blocked_app to exactly the app the consent named.
export async function callLocalTool(name, args, approve, runLocal = runScript, target) {
  if (name === 'blocked_app') {
    // Consent, terminal per-send prompts, logging and settings refusal live in
    // callBlockedApp; this only supplies the driver and a screenshot path.
    return callBlockedApp(args, {
      approve,
      run: request => runLocal('blocked-app.js', request),
      target,
      shot: join(tmpdir(), `sleight-blocked-${process.pid}-${Date.now()}.png`),
      trace: relayTrace,
    });
  }
  if (name === 'hover') {
    if (!await approve(['hover', args.app], `Allow Claude to hover in ${args.app}? It moves your pointer briefly.`)) {
      return text(`The user didn't allow hovering in ${args.app}. Stop and tell them; don't work around it.`, true);
    }
    const { ok, image, ...rest } = await runLocal('hover.js', args);
    const result = text(rest, !ok);
    if (ok && image) result.content.push({ type: 'image', data: image, mimeType: 'image/png' });
    return result;
  }
  if (name === 'select_window') return selectWindow(args, { approve, runScript: runLocal });
  if (name === 'drag') {
    if (!await approve(['drag', args.app], `Allow Claude to drag in ${args.app}? Background comes first; foreground fallback can move your pointer for a few seconds.`)) {
      return text(`The user didn't allow dragging in ${args.app}. Stop and tell them; don't work around it.`, true);
    }
    const operation = performDrag(args, runLocal);
    pendingDrags.add(operation);
    try { return await operation; }
    finally { pendingDrags.delete(operation); }
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
// Otherwise the relay selects the dialog when initialize advertises no form support.
export function approvalOptions(env = process.env, dialog = askWithDialog) {
  const setting = env.SLEIGHT_APPROVAL_PROMPT;
  let claudeCode = !!env.CLAUDE_CODE_ENTRYPOINT;
  // Claude Code's CLI names itself claude-code; the desktop app's Code tab may name itself otherwise.
  const onInitialize = info => { claudeCode = info ? /^claude/i.test(info.name ?? '') : !!env.CLAUDE_CODE_ENTRYPOINT; };
  const prompt = (message, scoped, options) => dialog(message, scoped, { ...options, claudeCode });
  if (setting === 'dialog' || (!setting && env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop')) return { ask: prompt, onInitialize };
  return { fallbackAsk: setting === 'client' ? undefined : prompt, onInitialize };
}

export async function run({ leaseDirectory } = {}) {
  let flowRules, preapproved;
  try { flowRules = loadFlowRules(); preapproved = loadPreapproved(); } catch (err) { fail(err.message); }
  const { trace, grantAudit } = approvalLogging(preapproved);
  relayTrace = trace;
  const s = resolveServer();
  if (s.error) fail(s.error);
  if (!existsSync(s.command)) fail(`server runtime missing: ${s.command}`);
  const surfaceCache = selectSurfaces(s);

  const child = spawn(s.command, s.args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...s.env },
  });
  child.on('error', err => fail(`could not start server: ${err.message}`));
  // Refresh every automatic session after initialization. Keep this description fixed;
  // the background inventory affects the next session only.
  const stopObservingInitialization = refreshAfterInitialize(child.stdout, surfaceCache);
  child.on('close', async code => {
    stopObservingInitialization(); await surfaceCache?.close();
    await stopHelpers(); await appHealth.close(); await relay.close(); process.exit(code ?? 0);
  });
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

  const appHealth = createAppHealthHelper();
  process.once('exit', () => appHealth.close());
  const replayClient = replayBridge({ input: process.stdin, output: process.stdout });
  const relay = createRelay({
    diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, { readControl, probeApp: appHealth.probe }),
    spaceProbe: appHealth.probe,
    guardMode: process.env.SLEIGHT_GUARD,
    firstCallBatch: process.env.SLEIGHT_FIRST_CALL_BATCH !== '0',
    clientIn: replayClient.clientIn,
    clientOut: replayClient.clientOut,
    serverIn: child.stdin,
    serverOut: child.stdout,
    sessionId,
    clipboardHelper: join(LIB, 'clipboard.js'),
    clipboardMode: process.env.SLEIGHT_CLIPBOARD,
    // SLEIGHT_APPROVAL_SCOPE=once asks again on every action instead.
    approvalScope: ['once', 'document'].includes(process.env.SLEIGHT_APPROVAL_SCOPE) ? process.env.SLEIGHT_APPROVAL_SCOPE : 'session',
    ...approvalOptions(),
    preapproved,
    grantAudit,
    flowRules,
    changeReview: process.env.SLEIGHT_CHANGE_REVIEW === '1',
    // End the engine's turn after 30 s without a running call, so the app it
    // holds is released even where the mod doesn't run. 0 turns this off.
    idleTurnEndMs: Number(process.env.SLEIGHT_IDLE_TURN_END_MS ?? 30000),
    inputLease: new InputLease({ directory: leaseDirectory, holder: `session ${sessionId} (pid ${process.pid})` }),
    engineForbiddenTargets: forbiddenTargetsAllowed(readForbiddenTargets),
    onLeaseFault: err => { process.stderr.write(`sleight: ${err.message}; stopping the owned engine.\n`); terminateEngine(); },
    // SLEIGHT_MENU_BAR=0 leaves out the menu bar and notification tools,
    // SLEIGHT_DRAG=0 the drag tool, SLEIGHT_HOVER=0 the hover tool,
    // SLEIGHT_SELECT_WINDOW=0 window selection.
    // blocked_app is always listed; the user's approval of its prompt is the
    // whole opt-in.
    localTools: {
      tools: localToolDefinitions(),
      call: callLocalTool,
      target: async args => {
        const result = await appHealth.target(args);
        if (!result.ok) throw new Error(`Input lease: ${result.error}`);
        return result.target;
      },
    },
    trace: relayTrace,
    guardTiming: !!process.env.SLEIGHT_TRACE,
    firstCallRules: skillRules(),
    keyboardTaps: appHealth.keyboardTaps,
    windowIdentity: appHealth.windowIdentity,
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

// `record` and `replay` (replay.mjs): a finished run, run again with no model. Approvals go to the
// terminal; without one, only apps the user pre-approved can run.
async function replayCommand(args) {
  const { record, replay, relayServer, replayOptions } = await import('./replay.mjs');
  const [command, source, out] = args;
  if (!source) { process.stderr.write('usage: sleight-mcp record <transcript.jsonl | session id> [out.json]\n       sleight-mcp replay <script.json> [--allow-positions] [--wait-ms 5000]\n'); return 2; }
  if (command === 'record') {
    const script = record(source);
    const text = JSON.stringify(script, null, 1) + '\n';
    if (out && !out.startsWith('--')) { (await import('node:fs')).writeFileSync(out, text); process.stderr.write(`sleight: ${script.steps.length} steps written to ${out}\n`); }
    else process.stdout.write(text);
    return 0;
  }
  const { createReadStream, openSync } = await import('node:fs');
  const { createInterface: lines } = await import('node:readline');
  let tty;
  try { tty = createReadStream(null, { fd: openSync('/dev/tty', 'r') }); } catch {}
  const ask = message => new Promise(resolve => {
    if (!tty) return resolve(false);
    process.stderr.write(`${message} [y/N] `);
    const rl = lines({ input: tty });
    rl.once('line', answer => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
  });
  const result = await replay(JSON.parse(readFileSync(source, 'utf8')), {
    server: relayServer, ask, ...replayOptions(args.slice(2)),
    log: line => process.stderr.write(`sleight: ${line}\n`),
  });
  tty?.destroy();
  process.stderr.write(result.ok ? `sleight: replayed ${result.steps} steps\n` : `sleight: stopped at step ${result.step}: ${result.error}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--doctor')) process.exitCode = await doctor();
  else if (['record', 'replay'].includes(process.argv[2])) {
    try { process.exitCode = await replayCommand(process.argv.slice(2)); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  } else run();
}
