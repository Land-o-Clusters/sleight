import { createRemoteApprovals } from './remote-approvals.mjs';
import { requestedSubmitRules } from './requested-submit.mjs';
// Starts the computer-use MCP server that ships with the ChatGPT desktop app.
//
// The ChatGPT app writes the server's launch config to a versioned folder,
// ~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json,
// and deletes the old folder on every update. Resolving the newest folder at
// each launch keeps the registration working across those updates.
//
//   launch.mjs           run the server over stdio, through relay.mjs
//   launch.mjs --doctor  print what would run, and check it exists
//   launch.mjs setup     install the helper, open permission panes, run doctor
//   launch.mjs turbo on [--browser chrome|helium] | off | status   turbo is on by default; these are the user's controls
//   launch.mjs hand on | off | capture hidden|visible | status   the ghost hand is off by default; the user's controls
//   launch.mjs permissions [list] | revoke … | block|unblock … | sites …   what sleight may do, and where it never acts
//   launch.mjs record|replay …  turn a finished run into a script, and run it again (replay.mjs)

import { execFile, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { leanCallRules } from './lean-calls.mjs';
import { screenshotGuidance } from './screenshot-guidance.mjs';
export { SCREENSHOT_GUIDANCE_START, SCREENSHOT_GUIDANCE_END } from './screenshot-guidance.mjs';
import { discoverExtensions, createBrowserSelection } from './browser-discovery.mjs';
import { createSurfaceCache, firstClientCallRefresh } from './surface-cache.mjs';
import { createStartupCache, startupIdentity } from './startup-cache.mjs';
import { createRelay, firstCallBatchSetting } from './relay.mjs';
import { createRelayHand } from './hand/relay-hand.mjs';
import { isV3Frontend, createV3Frontend, transientStartup, traceStartupFailure } from './direct-browser/worker.mjs';
import { prepareTextWrite, settleTextWrite } from './text-save.mjs';
import { stuckEscapeOption } from './stuck-escape.mjs';
import { createAppHealthHelper, diagnoseReadFailure } from './read-failure.mjs';
import { loadFlowRules } from './flow-rules.mjs';
import { InputLease } from './input-lease.mjs';
import { lightReturnEnabled } from './light-return.mjs';
import { collectOwnedEngine } from './checked-stop.mjs';
import { addPreapproved, listPreapproved, livePreapproved, loadPreapproved, removePreapproved } from './preapproved.mjs';
import { createPermissionCheck, noteCurrentApp } from './permissions.mjs';
import { browserDefinitions } from './direct-browser/browsers.mjs';
import { createGrantAudit } from './preapproved-audit.mjs';
import { ALLOW_FORBIDDEN_COMMAND, forbiddenTargetsAllowed, matchBlockedApp } from './blocked-apps.mjs';
import { SELECT_WINDOW_TOOL, selectWindow } from './select-window.mjs';
import { probeHelper, staleHelperJobs } from './helper-health.mjs';
import { replayBridge } from './replay.mjs';
import { serverFromChatGPTApp, setup } from './setup.mjs';
import { handPid } from './hand/pid.mjs';
import { ActionLog, actionLogPath } from './action-outcomes.mjs';
import { codexDoctorLines, codexStatus } from './codex-host.mjs';
import { cursorDoctorLines, cursorStatus } from './cursor-host.mjs';
import { grokDoctorLines, grokStatus } from './grok-host.mjs';
import { grokbotDoctorLines, grokbotSessionStatus } from './grokbot-host.mjs';
import { hostLabel, hostName } from './host-label.mjs';
import { createPaymentCard } from './payment-card.mjs';
import { codexTurnClient } from './codex-turn.mjs';
import { doctorVersionLine } from './version.mjs';
import { isMainModule } from './main-module.mjs';
import { recoverNativeClipboard } from './clipboard.mjs';

const PLUGIN_DIR = ['plugins', 'cache', 'openai-bundled', 'unified-computer-use'];
const SERVER_KEY = 'cua_repl';

export function receiptOptions(env = process.env) {
  return { receipts: env.SLEIGHT_RECEIPTS === '1', stateReview: env.SLEIGHT_STATE_REVIEW === '1',
    redactReceiptTitles: env.SLEIGHT_RECEIPT_REDACT_TITLES !== '0' };
}

// SLEIGHT_COMPLETENESS=1 and SLEIGHT_OUTCOMES=1 are independent opt-ins. SLEIGHT_ACTION_LOG names a file under
// ~/Library/Logs/sleight/, rotated at 5 MB with two old files kept.
export function outcomeOptions(env = process.env, warn = message => process.stderr.write(message + '\n')) {
  const path = actionLogPath(env.SLEIGHT_ACTION_LOG);
  // A user who set a path outside the folder would otherwise believe the log is on.
  if (env.SLEIGHT_ACTION_LOG && !path) warn('sleight: SLEIGHT_ACTION_LOG takes a file name or a path under ~/Library/Logs/sleight/; this one is ignored and the action log is off.');
  return { completeness: env.SLEIGHT_COMPLETENESS === '1', outcomes: env.SLEIGHT_OUTCOMES === '1', actionLog: path ? new ActionLog({ path }) : undefined };
}

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

// Setup is the default fix for a missing engine: it needs the ChatGPT app installed, not a Codex sign-in.
const setupCommand = () => `\`${join(LIB, '..', 'bin', 'sleight-mcp').replace(homedir(), '~')} setup\``;

export function resolveServer(env = process.env) {
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  const root = join(codexHome, ...PLUGIN_DIR);
  const fromBundle = () => {
    const fallback = serverFromChatGPTApp({ env });
    if (fallback.error) {
      return { error: `no Codex computer-use plugin at ${root}, and no engine in the ChatGPT app. Install the ChatGPT desktop app (no sign-in needed), then run ${setupCommand()}.` };
    }
    const serverEnv = { ...fallback.env };
    serverEnv.CUA_REPL_ENABLED_SURFACES = env.SLEIGHT_SURFACES || 'computer';
    return { ...fallback, env: serverEnv, fromChatGPTApp: true };
  };
  if (!existsSync(root)) return fromBundle();
  const versions = readdirSync(root)
    .filter(v => /^\d+(\.\d+)*$/.test(v) && existsSync(join(root, v, '.mcp.json')))
    .sort(compareVersions);
  if (!versions.length) return fromBundle();

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
  // Started from ChatGPT.app, the browser surface needs a Codex sign-in ("Codex auth token is
  // unavailable", 2026-10-10), so it stays computer-only unless the user sets SLEIGHT_SURFACES.
  if (server.fromChatGPTApp) { server.env.CUA_REPL_ENABLED_SURFACES = 'computer'; return; }
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
  // Started from ChatGPT.app, the browser surface needs a Codex sign-in ("Codex auth token is
  // unavailable", 2026-10-10), so it stays computer-only unless the user sets SLEIGHT_SURFACES.
  if (server.fromChatGPTApp) { server.env.CUA_REPL_ENABLED_SURFACES = 'computer'; return; }
  const browsers = await discoverExtensions(server, options);
  server.env.CUA_REPL_ENABLED_SURFACES = browsers.length ? 'browser,computer' : 'computer';
  // The in-app browser needs ChatGPT host context. Auto mode uses extensions only.
  server.env.BROWSER_USE_AVAILABLE_BACKENDS = 'chrome';
}

// The helper's own opt-out of its app refusals, which only the user sets.
const readForbiddenTargets = () => execFileSync(process.execPath, [join(LIB, 'probe-supervisor.mjs'), '--forbidden-targets'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });

const listLaunchdJobs = () => new Promise((resolve, reject) =>
  execFile(process.execPath, [join(LIB, 'probe-supervisor.mjs'), '--launchd-jobs'], { timeout: 6000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

// Read-only, like the turbo lines: is sleight a Codex plugin here, and is Codex's own Computer Use on beside it.
function codexDoctor(env) {
  try { return codexDoctorLines(codexStatus({ env })); }
  catch (err) { return ['Codex', `PROBLEM   could not read Codex's config (${err.message})`]; }
}
// Read-only too: is sleight set up in Cursor, and by which route.
function cursorDoctor() {
  try { return cursorDoctorLines(cursorStatus()); }
  catch (err) { return ['Cursor', `PROBLEM   could not read Cursor's config (${err.message})`]; }
}
function grokDoctor(env) {
  try { return grokDoctorLines(grokStatus({ env })); }
  catch (err) { return ['Grok CLI', `PROBLEM   could not read Grok's config (${err.message})`]; }
}
async function grokbotDoctor() {
  return grokbotDoctorLines(await grokbotSessionStatus());
}

// Read-only. The doctor prints it first so it shows even when the engine checks below stop early.
async function turboDoctorLines() {
  try { const turbo = await import('./direct-browser/turbo-setup.mjs'); return turbo.doctorLines(turbo.turboDiagnosis()); }
  catch (err) { return ['turbo (direct browser path)', `PROBLEM   could not read turbo state (${err.message})`]; }
}
async function handDoctorSection() {
  try {
    const [{ handDoctorLines, handSetting }, { handHostBuilt }] = await Promise.all([import('./hand/settings.mjs'), import('./direct-browser/host.mjs')]);
    return handDoctorLines(handSetting(), handHostBuilt());
  } catch (err) { return ['ghost hand', `PROBLEM   could not read the hand's state (${err.message})`]; }
}
async function permissionsDoctorSection() {
  try {
    const lines = (await import('./permissions-command.mjs')).permissionsDoctorLines();
    return createPermissionCheck().sitesLimited() ? [...lines, ...await browserDoctorLines()] : lines;
  }
  catch (err) { return ['permissions', `PROBLEM   could not read the permissions (${err.message})`]; }
}

export async function doctor({ env = process.env, log = console.log, app = process.argv.includes('--doctor') ? process.argv[process.argv.indexOf('--doctor') + 1] : undefined, timeoutMs = 5000, startupTimeoutMs = 10000, launchctlList = listLaunchdJobs, forbiddenTargets = readForbiddenTargets, preapprovedIO, auditDirectory, turbo = turboDoctorLines, hand = handDoctorSection, permissions = permissionsDoctorSection, codex = codexDoctor, cursor = cursorDoctor, grok = grokDoctor, grokbot = grokbotDoctor } = {}) {
  if (app !== undefined && (typeof app !== 'string' || !app.trim() || app.startsWith('-'))) {
    log('usage: sleight-mcp --doctor [running app name or bundle ID]'); return 1;
  }
  log(doctorVersionLine());
  for (const line of await turbo()) log(line);
  for (const line of await hand()) log(line);
  for (const line of await permissions()) log(line);
  for (const line of codex(env)) log(line);
  for (const line of cursor()) log(line);
  for (const line of grok(env)) log(line);
  for (const line of await grokbot()) log(line);
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
  log(`refused apps  ${forbiddenTargetsAllowed(forbiddenTargets) ? 'allowed through the engine (ComputerUseAllowForbiddenTargets is on)' : `refused by the engine (the user can run ${ALLOW_FORBIDDEN_COMMAND})`}`);
  let ok = true;
  for (const [label, path] of checks) {
    const found = Boolean(path) && existsSync(path);
    ok &&= found;
    log(`${found ? 'ok     ' : 'MISSING'}   ${label}: ${path ?? '(not set)'}`);
  }
  if (!ok) { log(`Run ${setupCommand()} to install the helper and grant its permissions.`); return 1; }
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

// Which apps are web browsers, for site limits on the engine path: the apps LaunchServices lists for https (web-browsers.js),
// joined with the browsers below, so a short or wrong answer never clears a real browser. Asked in the background, at
// startup when permissions.json already has site limits (ask) or else the first time a check needs it. Answers: true or
// false; undefined while the ask is pending, when an action without a proven site is refused; null when the ask failed or
// came back empty, or the window has no bundle id, when the relay judges the window by whether its read shows web content.
// A failed ask is repeated after 5 minutes.
const KNOWN_BROWSERS = new Set([...browserDefinitions('/', '/').map(browser => browser.bundleId), 'com.apple.Safari', 'com.apple.SafariTechnologyPreview',
  'org.mozilla.firefox', 'org.mozilla.firefoxdeveloperedition', 'org.mozilla.nightly', 'company.thebrowser.Browser', 'com.operasoftware.Opera',
  'com.openai.atlas', 'com.kagi.kagimacOS', 'app.zen-browser.zen', 'com.duckduckgo.macos.browser'].map(id => id.toLowerCase()));
const BROWSER_RETRY_MS = 300000;
const browserIds = result => result?.ok === true && Array.isArray(result.ids) ? result.ids.filter(id => typeof id === 'string' && id) : [];
export function webBrowserCheck(run = runScript, now = Date.now) {
  let ids, pending = false, failedAt;
  const ask = () => {
    if (ids || pending || failedAt !== undefined && now() - failedAt < BROWSER_RETRY_MS) return;
    pending = true;
    Promise.resolve().then(() => run('web-browsers.js', {})).then(result => {
      const found = browserIds(result);
      if (found.length) { ids = new Set(found.map(id => id.toLowerCase())); failedAt = undefined; } else failedAt = now();
    }, () => { failedAt = now(); }).finally(() => { pending = false; });
  };
  const check = appId => {
    if (!ids) ask();
    if (typeof appId !== 'string' || !appId) return null;
    const id = appId.toLowerCase();
    if (KNOWN_BROWSERS.has(id) || ids?.has(id)) return true;
    return ids ? false : failedAt !== undefined ? null : undefined;
  };
  return Object.assign(check, { ask, failed: () => !ids && failedAt !== undefined });
}
// The doctor's line for that lookup, shown while site limits exist.
export async function browserDoctorLines(run = runScript) {
  let found = [];
  try { found = browserIds(await run('web-browsers.js', {})); } catch {}
  return found.length ? [`ok        browsers: ${found.length} apps open https links`]
    : ["PROBLEM   sleight couldn't list your browsers, so site limits on the engine path hold for known browsers and for windows that show web content",
      '          a session asks again every 5 minutes'];
}

// SLEIGHT_TRACE=1 logs every relayed message to
// ~/Library/Logs/sleight/trace-<pid>.jsonl; any other value is used as the
// directory. Long strings (screenshots, UI state) are cut to 300 characters, or to
// SLEIGHT_TRACE_CUT. Claude's code, which the relay records only with SLEIGHT_TRACE_CODE=1
// and caps itself, is kept whole: cut at 300, it lost the end of every batch (2026-10-10).
function traceTo(setting, limit) {
  const dir = setting === '1' ? join(homedir(), 'Library', 'Logs', 'sleight') : setting;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `trace-${process.pid}.jsonl`);
  process.stderr.write(`sleight: tracing to ${file}\n`);
  const max = /^[1-9]\d*$/.test(limit ?? '') ? Number(limit) : 300;
  const cut = keep => (key, value) =>
    typeof value === 'string' && value.length > max && !(keep && key === 'code') ? `${value.slice(0, max)}…(${value.length})` : value;
  return (direction, msg) =>
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), direction, msg }, cut(direction === 'call-received')) + '\n');
}

export function approvalLogging(preapproved, env = process.env, auditDirectory) {
  return {
    trace: env.SLEIGHT_TRACE ? traceTo(env.SLEIGHT_TRACE, env.SLEIGHT_TRACE_CUT) : undefined,
    grantAudit: preapproved.size ? createGrantAudit(auditDirectory) : undefined,
  };
}

// Asks about an app approval with sleight's own prompt (ask.js). The desktop
// app's Code tab (Claude 2.19675.0, 2026-10-03) declines MCP form prompts
// without showing them, so under it the relay asks this way instead. The
// prompt gives up (cancel) after five minutes; the engine waits that long.
const LIB = dirname(fileURLToPath(import.meta.url));

// 'always' keeps every payment confirmation. 'never' (the user's own opt-out, an MCP-server env var the model and pages cannot set) drops the
// one confirmation for a payment the user's message asked for. Anything else, unset included, is 'requested'. Exact match, as for 'always'.
export function paymentConfirmationSetting(env = process.env) {
  const value = env.SLEIGHT_CONFIRM_PAYMENTS;
  return value === 'always' || value === 'never' ? value : 'requested';
}

// The skill's body. The relay defers its Browsers section until a browser result.
// Missing or unreadable means none.
// Under the sheet A/B, the menu rule gets the call to send. 9 textedit-save runs opened Format in one call
// and chose Make Plain Text in the next, 33.8 s over 11 calls (turn study, 2026-10-11).
export function skillRules(path = join(LIB, '..', 'skills', 'drive-mac-apps', 'SKILL.md'), env = process.env) {
  if (env.SLEIGHT_SKILL === 'none') return undefined;
  if (env.SLEIGHT_PROMPT === 'lean') path = join(dirname(path instanceof URL ? fileURLToPath(path) : path), 'SKILL.lean.md');
  try {
    let text = readFileSync(path, 'utf8').replace(/^---\n[\s\S]*?\n---\n+/, '').trim() || undefined;
    text = requestedSubmitRules(screenshotGuidance(text, env.SLEIGHT_SCREENSHOT_READS !== '0'), env);
    return env.SLEIGHT_LEAN_CALLS === '1' ? leanCallRules(text) : text;
  }
  catch { return undefined; }
}
const ICON = join(LIB, '..', 'assets', 'icon.png');
const ASK_SECONDS = 300;
const ownedHelpers = new Set();
const pendingDrags = new Set();
let helpersClosing = false;
let helperTrace;
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
export function resumeHelpers() {
  if (ownedHelpers.size || pendingDrags.size) throw new Error('Owned helpers are not collected.');
  helpersClosing = false;
}

// Claude Code keeps "Claude" in the panel. Other hosts use clientInfo.title, or a titled
// form of clientInfo.name ("cursor" becomes "Cursor"). Missing identity stays "this agent".
// Claude Code is a positive signal only: the client name "claude-code", which both the CLI (2.1.289) and the desktop
// app's Code tab (its bundled 2.1.299) send, or, with no client name at all, Claude Code's own CLAUDE_CODE_ENTRYPOINT.
// Any other name, a lookalike such as "claude-desktop" included, is a host without the mod (see relay modHost).
export function hostWording(info, env = process.env) {
  const name = typeof info?.name === 'string' && info.name.trim() ? info.name.trim() : undefined;
  const claudeCode = name ? name === 'claude-code' : !!env.CLAUDE_CODE_ENTRYPOINT;
  if (claudeCode) return { claudeCode: true, host: 'Claude', panel: 'claude-code' };
  // The same name the menu bar shows ("Cursor" for Cursor's cursor-vscode). An odd name gets the generic wording.
  const host = hostName(info);
  if (!host) return { claudeCode: false, host: undefined, panel: 'generic' };
  return { claudeCode: false, host, panel: host };
}

export function wordForHost(message, wording) {
  if (typeof message !== 'string' || wording?.claudeCode !== false) return message;
  return message.replace(/^Allow Claude to /, `Allow ${wording.host || 'this agent'} to `);
}

// Shared by ask.js and the consent host's guarded shell card.
export function approvalCardText(message, sessionScoped, options = {}) {
  // The engine asks 'Allow Computer Use to use "App"?'; sleight's own tools ask in plain words.
  const app = /^Allow Computer Use to use "(.+)"\?$/.exec(message)?.[1];
  const claudeCode = options.claudeCode !== false;
  const who = claudeCode ? 'Claude' : (options.host || 'this agent');
  const actor = claudeCode ? 'Claude' : (options.host || 'The agent');
  const session = claudeCode ? 'this Claude session' : (options.host ? `this ${options.host} session` : 'this sleight server session');
  const panel = options.panel ?? (claudeCode ? 'claude-code' : 'generic');
  const question = app ? `Allow ${who} to use ${app}?` : wordForHost(message, { claudeCode, host: options.host });
  const review = options?.kind === 'review';
  const flow = options?.kind === 'flow';
  const detail = flow ? options.detail : review ? `${options.detail}\n\nUndo restores the saved copy shown above. Reopen it in the app afterward. Later leaves the decision pending.` : (app ? `${actor} can then click and type in ${app} in the background. ` : '') +
    (sessionScoped ? `Allow lasts until ${session} ends.${options?.always ? ' Always allow adds it to your pre-approved list.' : ''}` : 'It asks again next time.');
  return { question, detail, panel, mode: flow ? 'flow' : review ? 'review' : 'approval' };
}

export function askWithDialog(message, sessionScoped, options = {}, launch = execFile) {
  if (helpersClosing) return Promise.resolve('cancel');
  const { question, detail, panel, mode } = approvalCardText(message, sessionScoped, options);
  const review = mode === 'review';
  const args = ['-l', 'JavaScript', join(LIB, 'ask.js'), question, detail, ICON, String(ASK_SECONDS), mode, panel,
    options?.always ? 'always' : '', sessionScoped ? 'session' : 'once'];
  return new Promise((resolve, reject) => {
    ownHelper(launch('osascript', args, (err, stdout, stderr) => {
      const answer = stdout.trim();
      if (!err && (review ? ['keep', 'undo', 'cancel'] : ['accept', 'decline', 'cancel', ...(options?.always ? ['always'] : [])]).includes(answer)) return resolve(answer);
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
  // app.drag moved no priority row in Safari form-settings r1 or r3 (race-1017); this tool moved 6 of 6.
  description: 'A drag that holds the mouse down and moves in steps, for what app.drag in the js tool can\'t do, such as ' +
    'reordering list rows or moving selected text (select it with js first). `from` accepts an element number from the last window read or "the current text selection"; ' +
    '`to` accepts an element number or "end of line N" (one-based AX visual line in the focused text area). Numbers must identify a unique named AX element. ' +
    'Both also accept coordinate pairs, in the same frame as the app\'s engine ' +
    'screenshot, from that window\'s top-left corner. Omit `windowId` for one window; an ambiguous target refuses. ' +
    'Both points must be in window content. A text drag requires a non-blank selection and both points in the same text area or field. ' +
    'To drop text in another window of the same app, pass `windowId` and a different `toWindowId`; `to` uses the destination window\'s read and screenshot frame. ' +
    'The selection comes from the source window; a line end comes from the destination\'s single text area. Tile overlapping windows and read again. ' +
    'A lost-text error tells you to press Cmd+Z in the target app and named window. ' +
    'Selected text moves through Accessibility first, with no pointer or focus change. If that makes no change, ' +
    'it tries background PID posting with a 500 ms hold when the points are uncovered. ' +
    'Only if those paths fail without changing text does it fall back to foreground, after the user has paused typing and using the mouse; ' +
    'an unavailable private window-local API also selects foreground before posting. The result names the path. ' +
    'Foreground fallback moves the pointer and restores it and the front app. Non-text drags require readback to verify the move. ' +
    'For a line-end text drop, use the final glyph bounds, never a zero-length end-of-line range. The user approves each app once per session.',
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: 'App name, bundle ID or path' },
      windowId: { type: 'integer', minimum: 1, description: 'Window ID from the engine inventory, not an index or handle' },
      toWindowId: { type: 'integer', minimum: 1, description: 'Different destination window of the same app; requires windowId' },
      from: { description: 'Element number, [x, y], or "the current text selection"' },
      to: { description: 'Element number, [x, y], or "end of line N"' },
      holdMs: { type: 'integer', description: 'How long to hold before moving (default 500)' },
      steps: { type: 'integer', description: 'Moves between start and end (default 25)' },
    },
    required: ['app', 'from', 'to'],
    additionalProperties: false,
  },
};

export function localToolDefinitions(env = process.env) {
  const tools = [
    ...(env.SLEIGHT_SELECT_WINDOW === '0' ? [] : [SELECT_WINDOW_TOOL]),
    ...(env.SLEIGHT_MENU_BAR === '0' ? [] : MENU_BAR_TOOLS),
    ...(env.SLEIGHT_HOVER === '0' ? [] : [HOVER_TOOL]),
    ...(env.SLEIGHT_DRAG === '0' ? [] : [DRAG_TOOL]),
    ...(env.SLEIGHT_OPEN_FILE === '0' ? [] : [OPEN_FILE_TOOL]),
  ];
  return env.SLEIGHT_PROMPT === 'lean' ? tools.map(leanToolDescription) : tools;
}

// Change only descriptions, including descriptions nested inside argument schemas.
// Safety sentences stay in the original constants, shared by both variants.
function leanToolDescription(tool) {
  const descriptions = {
    menu_bar: 'Status icons; menus use js. item=0. The user approves each app once per session.',
    notifications: 'Banners. The user approves notifications once per session.',
  };
  const replacements = [
    ['If no title matches exactly, a unique ending may match within that app only at the title start or after whitespace. The request must contain at least 12 Unicode code points after trim(), excluding format (Cf) and combining (M) characters from the count. Matching still uses the original request.', 'No exact title: unique same-app suffix after whitespace; 12+ code points after trim(), excluding Cf/M. Match original request.'],
    ['Use windowNumber to distinguish equal titles. ', ''],
    ['`at` is relative to the selected window\'s top-left corner.', '`at`: window-relative.'],
    ['Supply an exact `windowTitle` when more than one window is on screen.', 'Pass an exact `windowTitle` when several windows show.'],
    ['If that makes no change, it tries background PID posting with a 500 ms hold when the points are uncovered.', 'Then uncovered PID posting (500 ms hold) if unchanged.'],
    ['A drag that holds the mouse down and moves in steps, for what app.drag in the js tool can\'t do, such as reordering list rows or moving selected text (select it with js first).', 'Stepped drag for list rows; select text with js first.'],
    ['`from` accepts an element number from the last window read or "the current text selection"; `to` accepts an element number or "end of line N" (one-based AX visual line in the focused text area). Numbers must identify a unique named AX element. Both also accept coordinate pairs, in the same frame as the app\'s engine screenshot, from that window\'s top-left corner.',
      '`from`/`to`: unique named element numbers from read, or window-relative engine screenshot coordinates. `from`: "the current text selection"; `to`: "end of line N" (1-based visual line in focused text area).'],
    ['The result names the path. ', ''],
    ['To drop text in another window of the same app, pass `windowId` and a different `toWindowId`; `to` uses the destination window\'s read and screenshot frame. The selection comes from the source window; a line end comes from the destination\'s single text area. Tile overlapping windows and read again.',
      'Cross-window: `toWindowId` names a different same-app destination for `to` (its read, frame and text area). Tile overlaps; read again.'],
    ['Reports takeoverMs. ', ''],
    ['`path` is absolute or starts with ~/.', 'Absolute or ~/ path.'],
    ['App name or bundle ID, such as TextEdit or com.apple.TextEdit', 'App name or bundle ID'],
    ['op "read" returns the window as numbered elements plus a screenshot file; "click" presses `element` (or a window-relative `point`, which brings the app to the front); "type" sends `text`; "key" presses `key` ("Return", "super+v"); "scroll" moves `amount` lines, positive up.',
      'read: tree/image; click: element or `point`, which brings the app to the front. Other ops use their named argument.'],
    ['Running app name, bundle ID or path', 'App name, bundle ID or path'],
    ['Window title, use when no file URL is known', 'Title if no URL'],
    ['Exact file URL from AXDocument, preferred over title', 'Exact AXDocument URL, preferred'],
    ['Native window number, to distinguish equal titles', 'Native window number for equal titles'],
    ['The app, as "apps" names it', 'Name from apps'],
    ['How long to hold before moving (default 500)', 'Hold ms (default 500)'],
    ['Moves between start and end (default 25)', 'Steps (default 25)'],
    ['Window ID from the engine inventory, not an index or handle', 'Engine window ID, not an index or handle'],
    ['Different destination window of the same app; requires windowId', 'Same-app destination window; requires windowId'],
    ['Hover dwell, default 1500 ms; increase only if needed', 'Dwell ms (default 1500); increase only if needed'],
    ['click: the element number from read', 'click: number from read'],
    ['click: window-relative [x, y]', 'click: window [x, y]'],
    ['type: the exact text to send', 'type: exact text'],
    ['key: Return, Tab, Escape, super+v, …', 'key: key or chord'],
    ['The file to open', 'File path'],
    ['App name, bundle ID or path', 'App'],
    ['Exact title if no URL', 'Exact title'],
    ['Exact AXDocument URL, preferred', 'Exact URL, preferred'],
    ['Native window number for equal titles', 'Native window number'],
    ['Name from apps', 'App'],
    ['click: number from read', 'Element from read'],
    ['click: window [x, y]', 'Window [x, y]'],
    ['type: exact text', 'Exact text'],
    ['key: key or chord', 'Key/chord'],
    ['scroll: lines, positive up', 'Lines, positive up'],
  ];
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'description' ?
      replacements.reduce((text, [from, to]) => text.replace(from, to), item) : visit(item)]));
  };
  return visit({ ...tool, description: descriptions[tool.name] ?? tool.description });
}

// Opening a document through an app's Open panel brought TextEdit to the front for about a second
// in 3 of about 21 textedit-edit runs (2026-10-10, WindowServer log), while the owner worked. `open -g`
// opens it with the app left in the background, in one call instead of about four actions.
export const OPEN_FILE_TOOL = {
  name: 'open_file',
  description: 'Open an existing file in an app without bringing the app forward, instead of its File > Open panel, ' +
    'which can take the user\'s focus. `path` is absolute or starts with ~/. The result includes the window ' +
    'and its app handle for the next action. The user approves each app once per session.',
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', minLength: 1, description: 'App name or bundle ID, such as TextEdit or com.apple.TextEdit' },
      path: { type: 'string', minLength: 1, description: 'The file to open' },
    },
    required: ['app', 'path'], additionalProperties: false,
  },
};

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
// Apps whose job is to run, install or unpack what they open, refused whatever file they get.
const LAUNCHER_BUNDLES = new Set(['org.python.pythonlauncher', 'com.apple.jarlauncher', 'com.apple.installer',
  'com.apple.archiveutility', 'com.apple.scriptmenuapp', 'com.apple.automator.runner', 'com.apple.shortcuts',
  'com.apple.systemevents', 'com.apple.applescriptutility']);
// Files that run code when the right app opens them, refused whatever app is named.
const RUNNABLE = /\.(?:command|tool|sh|bash|zsh|csh|ksh|fish|py|pyc|pyw|rb|pl|php|js|mjs|jar|app|pkg|mpkg|dmg|scpt|scptd|applescript|workflow|action|shortcut|terminal|osax|plugin|kext|so|dylib)$/i;
// LaunchServices' answer for an app name or bundle ID: its real bundle ID, or '' when no app matches.
const resolveAppId = name => new Promise(resolve => execFile(process.execPath, [join(LIB, 'probe-supervisor.mjs'), '--resolve-app', name],
  { timeout: 11000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim())));
const runOpen = (file, argv) => new Promise((resolve, reject) =>
  execFile(file, argv, { timeout: 15000 }, err => (err ? reject(err) : resolve())));
// Refuses what would run code or reach outside the app: a path or .app as the app, an app that
// doesn't resolve, the apps the engine refuses (terminals and OpenAI's apps), launchers, script and
// executable files, relative paths, and anything but an existing regular file. The open goes to the
// resolved bundle ID, so the app checked is the app that opens the file.
// blocked(bundleId, app) is the user's line for an app they blocked (permissions.mjs), checked once the name resolves, so a
// block by bundle id holds whatever name Claude used and whether or not the app runs.
export async function openDocument(args, { exec = runOpen, resolve = resolveAppId, home = homedir(),
  fast = false, bundleId: preparedId, current = () => {}, openedFiles, target, blocked = () => undefined,
  hasDocument = async (appId, path) => {
    const result = await runScript('open-file-window.js', { appId, path });
    return result.ok === true && result.matches === true;
  } } = {}) {
  const app = String(args.app ?? '').trim();
  const raw = String(args.path ?? '');
  const path = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  if (!app || app.includes('/') || /\.app$/i.test(app)) return text('open_file needs an app name or bundle ID, not a path.', true);
  if (!isAbsolute(path)) return text('open_file needs an absolute path or one starting with ~/.', true);
  if (RUNNABLE.test(path)) return text(`open_file doesn't open scripts, apps or installers (${raw}).`, true);
  let info;
  try { info = lstatSync(path); } catch { return text(`No file at ${raw}.`, true); }
  // sleight's own settings (permissions.json, the always list, turbo's switch) change only by the user's hand, so no app
  // opens them for Claude to edit. The real path decides, so a link elsewhere doesn't get around it.
  let actual = path;
  try { actual = realpathSync(path); } catch {}
  if ([path, actual].some(value => /\/library\/application support\/sleight(?:\/|$)/i.test(value.normalize('NFC')))) {
    return text("open_file doesn't open sleight's own settings files; only the user changes them.", true);
  }
  if (!info.isFile()) return text(`${raw} isn't a regular file.`, true);
  if (info.mode & 0o111) return text(`open_file doesn't open executable files (${raw}).`, true);
  const bundleId = await (preparedId ?? resolve(app));
  if (!BUNDLE_ID.test(bundleId)) return text(`macOS has no app named ${app}.`, true);
  const refusal = blocked(bundleId, app);
  if (refusal) return text(refusal, true);
  if (matchBlockedApp(app, bundleId) || LAUNCHER_BUNDLES.has(bundleId.toLowerCase())) {
    return text(`open_file doesn't open files in ${app}, which runs or installs what it opens or isn't driven by sleight.`, true);
  }
  current();
  const started = Date.now(), key = JSON.stringify([bundleId, path]);
  let present = false, lazy = false;
  if (fast && target?.appId === bundleId) {
    // The app runs, so the engine read that follows decides: the relay opens the file and reads again only
    // when the window it gets back isn't this file (the osascript probe cost 150 to 200 ms, 2026-10-18). A
    // file changed since the last open still opens now.
    try {
      const lastOpened = openedFiles?.get(key), latest = lstatSync(path);
      lazy = present = latest.isFile() && latest.mtimeMs === info.mtimeMs &&
        (lastOpened === undefined || latest.mtimeMs <= lastOpened);
    } catch { lazy = present = false; }
  } else if (fast) {
    let timer;
    try {
      present = await Promise.race([
        Promise.resolve().then(() => hasDocument(bundleId, path)),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
      ]) === true;
      // A visible window for this exact file URL needs no `open -g` (150 to 200 ms, 2026-10-17), as the skill
      // has Claude acquire an already-open document. The open still runs when the file changed during this
      // call or since this session last opened it.
      const lastOpened = openedFiles?.get(key), latest = lstatSync(path);
      present = present && latest.isFile() && latest.mtimeMs === info.mtimeMs &&
        (lastOpened === undefined || latest.mtimeMs <= lastOpened);
    } catch { present = false; }
    finally { clearTimeout(timer); }
  }
  current();
  try { if (!present) await exec('/usr/bin/open', ['-g', '-b', bundleId, path]); }
  catch (err) { return text(`macOS couldn't open ${raw} in ${app}: ${String(err.message || err).split('\n')[0]}`, true); }
  if (!present) openedFiles?.set(key, started);
  // The relay checks the window it reads next against this path (or its real path, /tmp being /private/tmp).
  let real = path;
  try { real = realpathSync(path); } catch { /* The open already ran; the plain path still names the file. */ }
  return { ...text(`Opened ${raw} in ${app} in the background.`),
    _meta: { 'sleight/openedApp': bundleId, 'sleight/openedFile': { path, real, size: info.size, ...(lazy ? { lazy } : {}) } } };
}

// The relay's follow-up when a running app's window wasn't showing the file: the same background open.
export async function reopenDocument(bundleId, path, { exec = runOpen, openedFiles } = {}) {
  const started = Date.now();
  await exec('/usr/bin/open', ['-g', '-b', bundleId, path]);
  openedFiles?.set(JSON.stringify([bundleId, path]), started);
}

const approveOpenFile = (args, approve) => approve(['open_file', args.app],
  `Allow Claude to open files in ${args.app}? They open in the background.`);

export function prepareOpenFile(args, approve, { resolve = resolveAppId, openedFiles, blocked } = {}) {
  let approval;
  const bundleId = Promise.resolve().then(() => resolve(String(args.app ?? '').trim())).catch(() => '');
  return {
    openedFiles,
    bundleId,
    // Resolution can overlap target lookup; approval starts only when the caller is ready. A blocked app is never asked about.
    get approval() {
      return approval ??= (blocked ? bundleId.then(id => BUNDLE_ID.test(id) && blocked(id, args.app)) : Promise.resolve())
        .then(refused => refused ? false : approveOpenFile(args, approve));
    },
  };
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
  const { cleanup = false, run = execFile, trace = helperTrace } = typeof options === 'function' ? { run: options } : options;
  if (helpersClosing && !cleanup) return Promise.resolve({ ok: false, error: 'sleight session is closing' });
  // Base64 PNGs from ordinary app windows can exceed execFile's 1 MiB default.
  // The ghost hand stops waiting for locate.js after 2 s; a stalled AX app must not leave osascripts running.
  const execOptions = { timeout: script === 'open-file-window.js' ? 1000 : script === 'hand/locate.js' ? 2500 : cleanup ? 3000 :
    script === 'remote-approvals.js' ? 1500 : script === 'stuck-escape.js' ? 5000 : 30000,
    ...(script === 'hover.js' ? { maxBuffer: 16 * 1024 * 1024 } : {}) };
  if (script === 'drag.js') request = { ...request, deadline: Date.now() + execOptions.timeout,
    dp7: process.env.SLEIGHT_DP7 !== '0', dp2: process.env.SLEIGHT_DP2 !== '0', trace: !!process.env.SLEIGHT_TRACE };
  // Their cover checks skip the ghost hand's panel by this pid, which only the launcher sets: a pid
  // in the call could exempt a window that really covers the point.
  if (script === 'drag.js' || script === 'hover.js') {
    const { handPid: _, ...rest } = request;
    request = handPid() ? { ...rest, handPid: handPid() } : rest;
  }
  return new Promise(resolve => {
    let child;
    child = ownHelper(run('osascript', ['-l', 'JavaScript', join(LIB, script), JSON.stringify(request)], execOptions, (err, stdout, stderr) => {
      const diagnostic = String(stderr ?? '').split('\n').filter(line => {
        if (script !== 'drag.js' || !line.startsWith('sleight-drag-phase ')) return true;
        if (request.trace) try {
          const { phase, edge, monoMs } = JSON.parse(line.slice('sleight-drag-phase '.length));
          if (['ax-move', 'raise', 'settle', 'posted-press'].includes(phase) && ['start', 'end'].includes(edge) &&
              Number.isFinite(monoMs) && monoMs >= 0) trace?.('drag-phase', { phase, edge, monoMs, helperPid: child?.pid });
        } catch {}
        return false;
      }).join('\n').trim();
      try {
        resolve(JSON.parse(stdout));
      } catch {
        // A killed child prints nothing, and execFile's message is only the command line
        // (chess-drag, 2026-10-09). Say what happened instead.
        const timedOut = err?.killed && !diagnostic;
        resolve({ ok: false, timedOut: !!timedOut, error: timedOut
          ? `${script} timed out after ${execOptions.timeout / 1000} s and was stopped; whether it pressed anything is unknown. Read the window again before acting`
          : diagnostic || err?.message || 'no output' });
      }
    }));
  });
}

const text = (value, isError) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], ...(isError ? { isError: true } : {}) });

async function performDrag(args, runLocal, afterDrag) {
  const focus = await runLocal('drag-focus.js', { op: 'capture', app: args.app });
  if (!focus.ok) return text(focus.error, true);
  let result, dragTimedOut = false;
  try {
    result = await runLocal('drag.js', args);
  }
  catch (e) { result = { ok: false, error: String(e.message || e) }; }
  finally {
    // Copy-and-Paste advice follows the drag's own timeout, not a focus restore timing out after a drag that worked.
    dragTimedOut = !result?.ok && (!!result?.timedOut || /timed out/i.test(result?.error ?? ''));
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
  if (!result.ok && dragTimedOut) {
    result = { ...result, error: `${result.error}; for files, use Copy and then the app's Move command; for list items, Cut and Paste` };
  }
  const { ok, ...rest } = result;
  const reply = text(rest, !ok);
  if (process.env.SLEIGHT_DP4 !== '0' && result.textChanged === true && afterDrag) {
    try { reply.content.push(...await afterDrag(result)); }
    catch { /* The drag result stands when its optional read fails. Never repeat input. */ }
  }
  return reply;
}

export async function callLocalTool(name, args, approve, runLocal = runScript, resolved, prepared, { blocked, resolve = resolveAppId, afterDrag } = {}) {
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
  if (name === 'open_file') {
    // A blocked app is refused before the user is asked to approve opening files in it.
    let bundleId = prepared?.bundleId;
    if (blocked) {
      bundleId ??= Promise.resolve().then(() => resolve(String(args.app ?? '').trim())).catch(() => '');
      const id = await bundleId, refusal = BUNDLE_ID.test(id) && blocked(id, args.app);
      if (refusal) return text(refusal, true);
    }
    if (!await approveOpenFile(args, approve)) {
      return text(`The user didn't allow opening files in ${args.app}. Stop and tell them; don't work around it.`, true);
    }
    return openDocument(args, { ...prepared ? { ...prepared, fast: true, target: resolved } : {}, ...bundleId ? { bundleId } : {}, ...blocked ? { blocked } : {} });
  }
  if (name === 'drag') {
    if (!await approve(['drag', args.app], `Allow Claude to drag in ${args.app}? Background comes first; foreground fallback can move your pointer for a few seconds.`)) {
      return text(`The user didn't allow dragging in ${args.app}. Stop and tell them; don't work around it.`, true);
    }
    const operation = performDrag(args, runLocal, afterDrag);
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
  let wording = hostWording(undefined, env);
  // Claude Code's CLI names itself claude-code; the desktop app's Code tab may name itself otherwise.
  const onInitialize = info => {
    wording = hostWording(info, env);
    // Once per session, so a host detected the wrong way shows in the host's MCP log.
    const label = hostLabel(info) ?? 'an unnamed client';
    process.stderr.write(`sleight: host ${label}, ${wording.claudeCode ? 'with the sleight mod (Claude Code)' : codexTurnClient(info)
      ? 'without the sleight mod: turn_ended hidden, Codex\'s prompt hook binds turbo turns, its Stop hook ends them'
      : 'without the sleight mod: turn_ended hidden, no turbo, sleight ends turns itself'}\n`);
  };
  const prompt = (message, scoped, options) => dialog(message, scoped, { ...options, ...wording });
  const extras = { onInitialize, wording: () => wording };
  if (setting === 'dialog' || (!setting && env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop')) return { ask: prompt, ...extras };
  return { fallbackAsk: setting === 'client' ? undefined : prompt, ...extras };
}

// No shell argument or environment setting supplies the user's message or a lasting consent answer.
export function shellRelayOptions(dialog, card = createPaymentCard()) {
  const wording = hostWording({ name: 'Grok Bot' });
  // Keep the GB12 input guard and own-host refusal while using ask.js's card text and appearance.
  dialog ??= async (message, scoped, options) => {
    const text = approvalCardText(message, scoped, options);
    const answer = await card.ask({ session: 'Grok Bot', site: 'this Mac', request: message, scoped, app: options?.app,
      presentation: { style: 'ask', question: text.question, detail: text.detail, host: 'Grok Bot', icon: ICON,
        kind: options?.appApproval && scoped ? 'app' : 'action' } });
    if (answer === undefined) throw Object.assign(new Error('sleight consent panel unavailable; no approval was granted. Retry when the panel is available.'),
      { code: 'SLEIGHT_PROMPT_UNAVAILABLE' });
    return answer === 'once' ? 'accept' : 'cancel';
  };
  return {
    ask: async (message, scoped, options) => {
      const answer = await dialog(message, scoped, { ...options, ...wording, always: false });
      return answer === 'always' ? 'cancel' : answer;
    },
    wording: () => wording,
    modHost: () => false,
    alwaysAllow: undefined,
    confirmPayments: 'always', rs: '0', prompt: null, panelOnly: true,
    resolveApprovalApp: resolveAppId,
    turboUnavailable: 'Grok Bot shell has no trusted user-turn binding',
  };
}

// Only the fixed socket relay supplies this envelope field. Tool arguments are
// never deadline authority, and the private envelope is removed before forwarding.
export function shellCardContext({ now = Date.now, clock = { setTimeout, clearTimeout } } = {}) {
  const calls = new Map();
  let closed = false;
  const end = id => {
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id); clock.clearTimeout(call.timer); call.controller.abort();
  };
  return {
    current: () => !closed && calls.size === 1 ? calls.values().next().value.context : undefined,
    onRequest(message) {
      if (message.method === 'notifications/cancelled') { end(message.params?.requestId); return; }
      if (message.method !== 'tools/call' || message.id === undefined) return;
      const supplied = message.params?._meta?.sleightShellDeadline;
      if (message.params?._meta) {
        delete message.params._meta.sleightShellDeadline;
        if (!Object.keys(message.params._meta).length) delete message.params._meta;
      }
      end(message.id);
      if (closed) return;
      const controller = new AbortController();
      const deadline = Number.isFinite(supplied) ? Math.min(supplied, now() + 300000) : now();
      const context = Object.freeze({ deadline, signal: controller.signal });
      const timer = clock.setTimeout(() => controller.abort(), Math.max(0, deadline - now()));
      timer?.unref?.();
      calls.set(message.id, { context, controller, timer });
      if (deadline <= now()) controller.abort();
    },
    onReply: message => end(message.id),
    onClose() { closed = true; for (const id of calls.keys()) end(id); },
  };
}

// The fixed trusted host authenticates opt-in and package before binding a
// branded frontend. Environment and project settings cannot supply one.
export function directBrowserServer(server, frontend) {
  if (frontend === undefined) return server;
  if (!isV3Frontend(frontend)) throw Error('TRUSTED_ROUTE_REQUIRED');
  return { ...server, env: { ...server.env, CUA_REPL_ENABLED_SURFACES: 'browser,computer' } };
}

// Preserve native guidance verbatim. Only an authenticated direct route selects
// the compact browser section; default and lean engine skills stay unchanged.
export function directBrowserRules(rules, frontend) {
  if (frontend === undefined) return rules;
  if (!isV3Frontend(frontend) || !/^b[A-Za-z0-9_-]{1,63}$/.test(frontend.browser ?? '') || typeof rules !== 'string') throw Error('TRUSTED_ROUTE_REQUIRED');
  const section = /## Browsers\n[\s\S]*?(?=\n## |$)/;
  if (!section.test(rules)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const compact = readFileSync(join(LIB, '../skills/drive-mac-apps/BROWSERS.turbo-v3.md'), 'utf8').trimEnd()
    .replace('{browser}', frontend.browser).replace('{application}', frontend.application ? ` (${frontend.application})` : '');
  return rules.replace(section, compact + '\n');
}

// Typed v3 unavailability is handled by installed startup, which keeps the
// engine route available. Retired factories never get a second connection.
// detail: the stage the worker's startup stopped at and its code (worker.mjs unavailableFrame), when it said.
const startupDetail = detail => detail?.stage ? ` at ${detail.stage}${detail.reason && detail.reason !== detail.code ? `: ${detail.reason}` : ''}` : '';
function installedUnavailable(code, detail) {
  process.stderr.write(`sleight: turbo unavailable (${code}${startupDetail({ ...detail, code })}); using the engine. Check turbo settings and run sleight-mcp --doctor before retrying turbo.\n`);
}
export async function createInstalledBrowserBridge(factories) {
  return (factories?.v3 ?? (await import('./direct-browser/worker.mjs')).createV3Bridge)();
}

// Turbo is on by default: before the bridge is built, write turbo.json when it is absent or no longer matches this
// install (a plugin update or a new node version). An opted-out or unsafe file is left alone. Any failure keeps the
// engine path and logs one line. Only the launcher's own entry asks for this (run's ensureTurbo), so a test or tool
// that imports run() or supplies a factory never writes the user's file.
export async function ensureInstalledTurbo(log = text => process.stderr.write(text), options = {}) {
  try {
    const result = (await import('./direct-browser/turbo-setup.mjs')).ensureTurboConfig(options);
    if (result.message) log(`sleight: ${result.message}\n`);
    return result;
  } catch { return undefined; }
}

// SLEIGHT_TURBO=0 keeps this server on the engine path: no turbo.json write, no bridge and no browser_* tools. It can only
// turn turbo off, so an environment that sets it never gains anything (the Firefox and Safari benchmark arms set it).
export const turboOff = (env = process.env) => env.SLEIGHT_TURBO === '0';
// The bridge's startup forks the worker and selects the browser connection; it sends the browser nothing. A failure
// that can pass on a second try (worker.mjs transientStartup: the worker died or hung, or Chrome changed an entry
// between two reads) starts once more after retryDelayMs, instead of leaving turbo off for the whole session. Each
// failed attempt goes to the trace (SLEIGHT_TRACE) with its stage and code.
export async function prepareInstalledStartup(factory, unavailable = installedUnavailable, { ensure, log = text => process.stderr.write(text), env = process.env,
  retryDelayMs = 300, trace = traceStartupFailure } = {}) {
  if (turboOff(env)) return { directBrowser: undefined, directHost: undefined };
  try { await ensure?.(log); } catch { /* Setup never blocks startup. */ }
  for (let attempt = 1; ; attempt++) {
    try {
      const bridge = await (factory ?? (() => createInstalledBrowserBridge()))();
      if (!bridge) return { directBrowser: undefined, directHost: undefined };
      return { directBrowser: createV3Frontend(bridge), directHost: bridge, turnHook: { close: () => bridge.detach() } };
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : 'TURBO_STARTUP_FAILED';
      const detail = typeof error?.stage === 'string' ? { stage: error.stage, reason: error.reason } : undefined;
      const retrying = attempt === 1 && transientStartup(error);
      if (detail) try { trace({ code, ...detail, attempt, retrying }); } catch {}
      if (retrying) {
        log(`sleight: turbo startup failed (${code}${startupDetail({ ...detail, code })}); starting it once more.\n`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }
      if (detail) unavailable(code, detail); else unavailable(code);
      return { directBrowser: undefined, directHost: undefined, turboUnavailable: code };
    }
  }
}

export function turboState(readConfig, env = process.env) {
  if (turboOff(env)) return { enabled: false };
  try { return { enabled: !!readConfig() }; } catch { return { enabled: false }; }
}

export async function run({ leaseDirectory, inspectInput: inspectStoppedInput, healthHelperFactory = createAppHealthHelper,
  directBrowser, ensureTurbo = false, shellRoute = false,
  approvalStorage = { load: loadPreapproved, live: livePreapproved, add: addPreapproved },
  paymentCardFactory = createPaymentCard, recoverClipboard = recoverNativeClipboard } = {}) {
  await recoverClipboard();
  let finishStartup;
  const startupReady = new Promise(resolve => { finishStartup = resolve; });
  process.stdin.on('end', () => stop());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => stop(signal));
  }
  // The ghost hand's session client, before turbo's bridge forks its worker so the worker can share the session's one host.
  // It spawns nothing until sleight acts or turbo forks, and the default off setting leaves it out. The relay's hand hooks take this
  // same client.
  // Startup can fork turbo before approval logging exists. Retain its numeric host events.
  let handTrace;
  const earlyHandTrace = [];
  const hand = (await import('./hand/client.mjs')).sessionHandClient({ trace: (direction, msg) => { if (handTrace) handTrace(direction, msg); else if (earlyHandTrace.length < 64) earlyHandTrace.push([direction, msg]); } });
  process.once('exit', () => hand?.close());
  const prepared = shellRoute ? { turboUnavailable: shellRelayOptions().turboUnavailable }
    : directBrowser === undefined ? await prepareInstalledStartup(undefined, undefined, { ensure: ensureTurbo ? ensureInstalledTurbo : undefined }) : { directBrowser };
  directBrowser = prepared.directBrowser;
  const turnHook = prepared.turnHook;
  process.once('exit', () => { turnHook?.close(); });
  let flowRules, preapproved;
  try { flowRules = loadFlowRules(); preapproved = approvalStorage.load(); } catch (err) { fail(err.message); }
  // A revoke from the menu or the command reaches this session at once; the startup list is the first copy.
  preapproved = approvalStorage.live(preapproved);
  // The user's blocks and site limits. With site limits already set, which apps are browsers is asked now, not at the first action.
  const permissionCheck = createPermissionCheck(), webBrowser = webBrowserCheck();
  if (permissionCheck.sitesLimited()) webBrowser.ask();
  const appBlocked = (bundleId, app) => permissionCheck.app({ bundleId, name: app });
  const { trace, grantAudit } = approvalLogging(preapproved);
  helperTrace = trace;
  handTrace = trace;
  for (const event of earlyHandTrace.splice(0)) trace?.(...event);
  let s = directBrowserServer(resolveServer(), directBrowser);
  if (s.error) fail(s.error);
  if (!existsSync(s.command)) fail(`server runtime missing: ${s.command}`);
  let surfaceCache, child, childClosed, firstCallObserver, relay, paymentCard;
  let stopping = false, deadCleanup;
  let stoppingForReceipt = false;
  let terminating = false;
  const browserSelection = createBrowserSelection();
  let activeServer = s;
  const serverIdentity = server => JSON.stringify([server.version, server.configPath, server.command, server.args]);
  let runningServerIdentity;
  function prepareEngine() {
    const latest = directBrowserServer(resolveServer(), directBrowser);
    if (latest.error) throw new Error(latest.error);
    if (!Array.isArray(latest.args) || !latest.args.length || latest.args.some(arg => typeof arg !== 'string')) {
      throw new Error('Engine launch arguments are invalid.');
    }
    const paths = [['runtime', latest.command], ['script', latest.args[0]],
      ...latest.args.slice(1).filter(isAbsolute).map(path => ['argument', path])];
    for (const [label, path] of paths) {
      if (typeof path !== 'string' || !existsSync(path)) throw new Error(`server ${label} missing: ${path}`);
    }
    return latest;
  }
  async function startEngine(isCurrent = () => true, preparedServer = prepareEngine(), first = false) {
    s = preparedServer;
    runningServerIdentity = serverIdentity(s);
    surfaceCache = directBrowser ? undefined : selectSurfaces(s);
    activeServer = directBrowser ? directBrowserServer(s, directBrowser) : await browserSelection.prepare(s);
    if (!isCurrent()) { await surfaceCache?.close(); throw new Error('Engine restart was stopped.'); }
    const current = spawn(activeServer.command, activeServer.args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...activeServer.env } });
    child = current;
    trace?.('engine-started', { pid: current.pid });
    childClosed = new Promise(resolve => current.once('close', (code, signal) => { trace?.('engine-closed', { code, signal }); resolve({ code, signal }); }));
    let startError;
    current.on('error', err => { startError = err; });
    const observer = firstClientCallRefresh(surfaceCache), cache = surfaceCache;
    firstCallObserver = observer;
    current.on('close', async (code, signal) => {
      if (current !== child || stoppingForReceipt) return;
      observer.dispose(); await cache?.close();
      relay?.engineEnded(startError ? `Could not start engine: ${startError.message}`
        : `Engine exited (${signal ?? code ?? 'unknown'}).`);
      if (stopping) {
        await paymentCard?.close?.();
        await stopHelpers(); await appHealth.close(); await relay.close(); process.exit(code ?? 0);
      }
      // The launcher outlives an engine that died unplanned, so stop its helpers as a Stop does (the relay revokes
      // direct browser work). A restart waits for this.
      deadCleanup = stopHelpers().catch(() => {});
    });
    terminating = false; stoppingForReceipt = false;
    // The first start is fatal when the engine can't spawn, as before: no client call or relay exists yet to
    // receive an error, and the client's initialize would wait forever. Later starts recover through the relay.
    if (first) await new Promise((resolve, reject) => current.once('spawn', resolve).once('error', reject))
      .catch(err => fail(`could not start server: ${err.message}`));
    return { serverIn: current.stdin, serverOut: current.stdout };
  }
  await startEngine(undefined, s, true);
  function terminateEngine(signal = 'SIGTERM') {
    if (terminating || child.exitCode !== null || child.signalCode !== null) return;
    terminating = true;
    const current = child;
    current.stdin.end();
    // The launcher owns this child. Finish collecting it before exit cleanup
    // releases the leases, including when a call or approval never answers.
    setTimeout(() => current.kill(signal), 2000).unref();
    setTimeout(() => current.kill('SIGKILL'), 5000).unref();
  }
  const sessionId = randomUUID();

  let appHealth = healthHelperFactory();
  const openedFiles = new Map();
  process.once('exit', () => appHealth.close());
  const cardContext = shellRoute ? shellCardContext() : undefined;
  const replayClient = replayBridge({ input: process.stdin, output: process.stdout, ...cardContext });
  paymentCard = paymentCardFactory(shellRoute ? { presentation: { icon: ICON },
    requestContext: cardContext.current, prepareTimeoutMs: 175000, onStatus: params => {
    replayClient.clientOut.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/sleight/approval', params }) + '\n');
  } } : undefined);
  // Compilation checks for installed Apple tools before xcrun and starts no UI.
  // The first request joins this work; startup does not wait for a cold compiler.
  if (shellRoute) void paymentCard.prepare?.();
  const approval = shellRoute ? shellRelayOptions(undefined, paymentCard) : approvalOptions();
  const { wording, ...promptOptions } = approval;
  relay = createRelay({
    directBrowser, turboUnavailable: prepared.turboUnavailable,
    directHost: prepared.directHost,
    remoteApprovals: createRemoteApprovals({ run: runScript }),
    startupCache: createStartupCache({ identity: startupIdentity(activeServer, join(LIB, '..')) }),
    browserChoice: browserSelection.choice,
    backendChanged: () => browserSelection.changed(),
    prepareEngine,
    engineChanged: () => {
      try {
        const latest = directBrowserServer(resolveServer(), directBrowser);
        return !latest.error && serverIdentity(latest) !== runningServerIdentity;
      } catch { return false; } // An update may be replacing the cache directory right now.
    },
    diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, { readControl, probeApp: appHealth.probe }),
    staleHelperCheck: async () => staleHelperJobs(await listLaunchdJobs()),
    settleTextWrite: (target, current, grant) => settleTextWrite(target, current, grant,
      { identity: window => appHealth.windowIdentity(window), run: runScript }),
    prepareTextWrite: (target, current) => {
      if (!existsSync(join(LIB, 'settle-text-write.js'))) throw new Error('Text-write settle helper is unavailable.');
      return prepareTextWrite(target, current, { identity: window => appHealth.windowIdentity(window), run: runScript });
    },
    stuckEscape: stuckEscapeOption(process.env, { identity: window => appHealth.windowIdentity(window), run: runScript }),
    spaceProbe: app => appHealth.probe(app),
    frontRestore: process.env.SLEIGHT_FRONT_RESTORE === '0' ? undefined : request => appHealth.frontRestore(request),
    guardMode: process.env.SLEIGHT_GUARD,
    guardLightReturn: lightReturnEnabled(),
    simFocusNote: process.env.SLEIGHT_SIM_FOCUS_NOTE !== '0', // Screenshot scale advice for any app.
    resultTrim: process.env.SLEIGHT_RESULT_TRIM === '1',
    firstCallBatch: firstCallBatchSetting(process.env.SLEIGHT_FIRST_CALL_BATCH),
    warmRepl: process.env.SLEIGHT_WARM_REPL !== '0',
    // Opt-in: as a default it timed out lease-launcher's stop-then-lazy-start test (2026-10-17); find why before defaulting it.
    warmEngine: process.env.SLEIGHT_WARM_ENGINE !== '0',
    // Default since the 2026-10-17 A/B; =0 only for A/B baselines.
    openFast: process.env.SLEIGHT_OPEN_FAST !== '0',
    onClientReply: message => firstCallObserver?.reply(message),
    confirmPayments: paymentConfirmationSetting(),
    rs: process.env.SLEIGHT_RS,
    // sleight's own card for an engine-path payment the gate stopped (payment-card.mjs); opened on the first such payment.
    paymentCard,
    // The shell waits for the card's own deadline, unlike hosts with a shorter MCP tool timeout.
    ...(shellRoute ? { paymentCardHoldMs: 300000 } : {}),
    clientIn: replayClient.clientIn,
    clientOut: replayClient.clientOut,
    serverIn: child.stdin,
    serverOut: child.stdout,
    sessionId,
    clipboardHelper: join(LIB, 'clipboard.js'),
    clipboardMode: process.env.SLEIGHT_CLIPBOARD,
    // SLEIGHT_APPROVAL_SCOPE=once asks again on every action instead.
    approvalScope: ['once', 'document'].includes(process.env.SLEIGHT_APPROVAL_SCOPE) ? process.env.SLEIGHT_APPROVAL_SCOPE : 'session',
    ...promptOptions,
    preapproved,
    alwaysAllow: (app, riskLevel) => { approvalStorage.add(app, riskLevel); preapproved.add(app, riskLevel); },
    grantAudit,
    flowRules,
    changeReview: process.env.SLEIGHT_CHANGE_REVIEW === '1',
    ...receiptOptions(),
    ...outcomeOptions(),
    // End the engine's turn after 30 s without a running call, so the app it
    // holds is released even where the mod doesn't run. 0 turns this off.
    idleTurnEndMs: Number(process.env.SLEIGHT_IDLE_TURN_END_MS ?? 30000),
    // The mod runs only in Claude Code, which initialize's clientInfo names (hostWording).
    modHost: () => wording().claudeCode,
    inputLease: new InputLease({ directory: leaseDirectory, holder: `session ${sessionId} (pid ${process.pid})` }),
    engineForbiddenTargets: forbiddenTargetsAllowed(readForbiddenTargets),
    // The user's blocks, read again whenever permissions.json changes.
    permissions: { ...permissionCheck, noteApp: noteCurrentApp },
    webBrowser,
    onLeaseFault: err => { process.stderr.write(`sleight: ${err.message}; stopping the owned engine.\n`); terminateEngine(); },
    // SLEIGHT_MENU_BAR=0 leaves out the menu bar and notification tools,
    // SLEIGHT_DRAG=0 the drag tool, SLEIGHT_HOVER=0 the hover tool,
    // SLEIGHT_SELECT_WINDOW=0 window selection.
    localTools: {
      tools: localToolDefinitions(),
      prepareOpen: (args, approve) => prepareOpenFile(args, (parts, message, options) =>
        approve(parts, wordForHost(message, wording()), options), { openedFiles, blocked: appBlocked }),
      reopen: (bundleId, path) => reopenDocument(bundleId, path, { openedFiles }),
      selectionWindow: target => runScript('handle-selection-window.js', target),
      call: (name, args, approve, runLocal, resolved, prepared, options) => callLocalTool(name, args, (parts, message, options) =>
        approve(parts, wordForHost(message, wording()), options), runLocal, resolved, prepared,
        { ...options, blocked: appBlocked }),
      target: async args => {
        const result = await appHealth.target(args);
        // sleight's own consent host answers with its one line, which Claude passes on.
        if (!result.ok) throw new Error(result.ownHost ? result.error : `Input lease: ${result.error}`);
        return result.target;
      },
    },
    trace,
    // The ghost hand, only when the settings enable it, on the session's one client (made above, before turbo forks).
    hand: hand && createRelayHand({ client: hand, locate: request => appHealth.handLocate(request), trace: (direction, msg) => trace?.(direction, msg),
      clientOptions: { trace: (direction, msg) => trace?.(direction, msg) } }),
    guardTiming: !!process.env.SLEIGHT_TRACE,
    traceCode: process.env.SLEIGHT_TRACE_CODE === '1',
    // SLEIGHT_SKILL=none leaves the skill out, for A/Bs. The app-agnostic skill replaced the old one after
    // matching or beating it: 14.5 s against 15.6 s a run, and 38.9 s against 44.7 s on textedit-save (2026-10-11).
    firstCallRules: process.env.SLEIGHT_SKILL === 'none' ? undefined : shellRoute
      ? skillRules(undefined, { ...process.env, SLEIGHT_CONFIRM_PAYMENTS: 'always', SLEIGHT_RS: '0' })
        .replaceAll('`mcp__plugin_sleight_computer__js`', "`sleight-mcp js '<code>'` through the local shell")
      : directBrowserRules(skillRules(), directBrowser),
    keyboardTaps: () => appHealth.keyboardTaps(),
    windowIdentity: window => appHealth.windowIdentity(window),
    // SLEIGHT_OFFSCREEN_CLICK=0 is the A/B arm without the offscreen-row note.
    elementVisibility: process.env.SLEIGHT_OFFSCREEN_CLICK === '0' ? undefined
      : async request => (await appHealth.elementVisibility?.(request)) ?? { status: 'unknown' },
    beginStop: () => { stoppingForReceipt = true; },
    stopEngine: async () => {
      const engine = await collectOwnedEngine({ child, closed: childClosed });
      firstCallObserver.dispose(); await surfaceCache?.close();
      await stopHelpers();
      return engine;
    },
    restartEngine: async (isCurrent, preparedServer) => {
      await deadCleanup;
      await appHealth.close();
      if (!isCurrent()) throw new Error('Engine restart was stopped.');
      resumeHelpers();
      appHealth = healthHelperFactory();
      return startEngine(isCurrent, preparedServer);
    },
    inspectInput: inspectStoppedInput ?? (async () => {
      const pointer = await runScript('input-state.js', {}, { cleanup: true });
      const taps = await appHealth.keyboardTapState();
      await appHealth.close(); await stopHelpers();
      const ok = pointer.ok === true && Array.isArray(pointer.buttons) && pointer.buttons.length === 0 &&
        taps.ok === true && Array.isArray(taps.taps) && taps.taps.length === 0 && ownedHelpers.size === 0;
      return { ok, error: ok ? undefined : pointer.ok !== true ? 'Pointer state inspection failed'
        : pointer.buttons.length ? 'A pointer button is down; its owner is unknown'
        : taps.ok !== true ? 'Keyboard tap inspection failed'
        : taps.taps.length ? 'Keyboard filter taps remain: ' + taps.taps.map(tap => tap.app || tap.bundleId || `pid ${tap.pid}`).join(', ')
        : 'Owned helper exit is unconfirmed' };
    }),
    onStopReported: report => {
      if (report.engine === 'unconfirmed') stoppingForReceipt = false;
    },
    // These fixed values follow all environment-derived options, including alwaysAllow and modHost.
    ...(shellRoute ? promptOptions : {}),
  });
  // Stamps for the harness tail (stop entry to exit); they only write when SLEIGHT_TRACE is set.
  process.once('exit', () => trace?.('process-exit', { code: process.exitCode ?? 0 }));
  process.once('exit', () => relay.close());

  // Claude Code closing the connection is the end of the session: end the
  // open turn so the server releases what it holds, then stop the server.
  async function stop(signal) {
    // Collect an early EOF or signal once the owned engine and relay are ready to shut down.
    await startupReady;
    if (stopping) return;
    stopping = true;
    cardContext?.onClose();
    const cardClosed = paymentCard.close?.();
    trace?.('stop-entry', { signal });
    // Begin the deadline before draining, not after an unanswered call.
    const deadline = setTimeout(() => terminateEngine(signal), 3000);
    deadline.unref();
    const ended = await relay.shutdown();
    trace?.('relay-shutdown', { ended });
    await turnHook?.close();
    if (ended !== false) clearTimeout(deadline);
    terminateEngine(signal);
    await childClosed;
    await cardClosed;
    await stopHelpers(); await appHealth.close(); await relay.close(); process.exit(0);
  }
  finishStartup();
}

// `record` and `replay` (replay.mjs): a finished run, run again with no model. Approvals go to the
// terminal; without one, only apps the user pre-approved can run.
async function replayCommand(args) {
  const { record, replay, relayServer, replayOptions } = await import('./replay.mjs');
  const [command, source, out] = args;
  if (!source) { process.stderr.write('usage: sleight-mcp record <transcript.jsonl | session id> [out.json]\n       sleight-mcp replay <script.json> [--allow-positions] [--wait-ms 5000]\n'); return 2; }
  if (command === 'record') {
    if (source === '--watch') {
      const { recordWatch, watchOptions } = await import('./demonstration.mjs');
      const options = watchOptions(args.slice(1));
      await recordWatch({ ...options, log: line => process.stderr.write(`sleight: ${line}\n`) });
      return 0;
    }
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

// `allow list` and `allow remove <app>`: the user's pre-approved list, which "Always allow" adds to.
export function allowCommand(args, { list = listPreapproved, remove = removePreapproved, out = text => process.stdout.write(text) } = {}) {
  const [, op, app] = args;
  if (op === 'list') {
    const apps = list();
    out(apps.length ? apps.map(a => `${a.app}  ${a.riskLevel}${a.added ? `  added ${a.added}${a.source === 'always-allow' ? ' by Always allow' : ''}` : ''}`).join('\n') + '\n' : 'No pre-approved apps.\n');
    return 0;
  }
  if (op === 'remove' && app) {
    out(remove(app) ? `Removed ${app}. It asks again from the next session.\n` : `${app} isn't on the list.\n`);
    return 0;
  }
  out('usage: sleight-mcp allow list\n       sleight-mcp allow remove <app>\n');
  return 2;
}

if (isMainModule(import.meta.url)) {
  if (['session', 'js', 'js_reset', 'open_file', 'select_window', 'drag'].includes(process.argv[2])) {
    try { process.exitCode = await (await import('./socket-bridge.mjs')).socketCommand(process.argv.slice(2)); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  } else if (process.argv[2] === '--socket-relay') run({ shellRoute: true }).catch(err => fail(err.message));
  else if (process.argv[2] === 'turbo') {
    try { process.exitCode = (await import('./direct-browser/turbo-setup.mjs')).turboCommand(process.argv.slice(3)); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  } else if (process.argv[2] === 'hand') {
    try { process.exitCode = (await import('./hand/command.mjs')).handCommand(process.argv.slice(3)); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  } else if (process.argv[2] === 'turbo-state') {
    const { readInstalledConfig } = await import('./direct-browser/installed-config.mjs');
    process.stdout.write(JSON.stringify(turboState(readInstalledConfig)) + '\n');
  } else if (process.argv[2] === 'permissions') {
    try { process.exitCode = (await import('./permissions-command.mjs')).permissionsCommand(process.argv.slice(3), { out: text => process.stdout.write(text) }); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  } else if (process.argv[2] === 'stats') {
    try { process.exitCode = await (await import('./action-stats.mjs')).statsCommand(process.argv.slice(3)); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  } else if (process.argv[2] === 'allow') {
    try { process.exitCode = allowCommand(process.argv.slice(2)); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  } else if (process.argv[2] === 'setup') {
    try { process.exitCode = await setup({ doctor, resolveServer, dryRun: process.argv.includes('--dry-run') }); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  } else if (process.argv.includes('--doctor')) process.exitCode = await doctor();
  else if (process.argv[2] === 'routine') {
    try { process.exitCode = await (await import('./routines.mjs')).routineCommand(process.argv.slice(3)); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  }
  else if (process.argv[2] === 'watch') {
    try { process.exitCode = await (await import('./watches.mjs')).watchCommand(process.argv.slice(3)); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  }
  else if (['record', 'replay'].includes(process.argv[2])) {
    try { process.exitCode = await replayCommand(process.argv.slice(2)); }
    catch (err) { process.stderr.write(`sleight: ${err.message}\n`); process.exitCode = 1; }
  } else run({ ensureTurbo: true }).catch(err => fail(err.message));
}
