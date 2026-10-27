#!/usr/bin/env node
// Runs the sleight benchmark: each task through headless `claude -p` with the
// plugin loaded, checked outside the agent. Writes bench/results/<stamp>.json
// and prints a table.
//
//   node bench/run.mjs [--arm sleight|lcu|codex|all|a,b] [--suite default|real] [--tasks id,id] [--runs N] [--model M] [--effort E]
//     [--codex-model M] [--codex-effort E] [--dry-run] [--setup-only] [--owner-away] [--owner-present] [--clean-arms] [--analytics-config BANK]
//
// --clean-arms publishes the CPU comparison without the owner's setup (LAWS, 2026-10-10): the
// sleight arm runs with an MCP allowlist and empty setting sources, so only sleight's
// server and mod load, and the pass confirms the Codex home configures only the engine server.
// The results record armSetup: clean or normal, and the summary table splits each arm's own CPU.
//
// Model and effort default to Haiku 5.5 at high (owner, 2026-10-10), and before that to Sonnet 5.5
// at medium (2026-10-03 to 2026-10-10). Runs before 2026-10-03 used Claude Code's default, Opus 5.5.
//
// Arms: `sleight` loads this repo's plugin. `lcu` runs from a folder where LCU
// (github.com/amontlabs/lcu) was registered for Claude Code at project scope:
//   lcu setup --agent claude-code --scope project --project <dir> --no-chrome --no-audio --yes
// The folder is LCU_ARM_DIR (default ~/Library/Caches/sleight-bench/lcu-arm), and LCU needs Python 3.12+
// first on PATH (LCU_PATH_PREFIX, default .dev/py). BENCH_ROOT tells the
// approval hook where this repo is, since an arm may run from another folder.
//
// A live run AUTO-APPROVES BENCH_APPS for either arm (approve.mjs), because -p
// can't show approval prompts. Run it only when you're fine with Claude
// driving the selected task's apps unattended. --dry-run sets up and checks
// tasks without a model call. Every run first checks that each arm loads its
// own tool and not the other's.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_APPS, REAL_APPS, closeBenchTextEdit, quitChess, quitSimApp, getTasks } from './tasks.mjs';
import { selectSuiteTasks, assertShopSmokeRuns } from './shop.mjs';
import { CODEX_HOME, approveOnly, codexReady, codexConfigServers, codexExecPlan, runCodex } from './codex-arm.mjs';
import { CODEX_SLEIGHT_HOME, ensureCodexSleightHome, writeCodexSleightConfig, codexSleightRunConfig, approvalSummary, assertOnlyServers } from './codex-sleight.mjs';
import { startFootprint, cpuSplit } from './footprint.mjs';
import { watchAppWindows } from './app-windows.mjs';
import { runTiming, traceTiming, withStamps } from './timing.mjs';
import { executeRealTask, cleanupContained, releaseFixtureLock } from './real-run.mjs';
import { mergeArmHooks } from './arm-hooks.mjs';
import { observePermission } from './real-permission.mjs';
import { runOwned } from './preapproved-process.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { runDriver, privateDriverEnvironment } from './driver.mjs';
import { privateMailResult, publicPrivateMailRows, publishPrivateMailResults } from './private-mail.mjs';
import { assertPrivateClaudePolicy } from './private-policy.mjs';
import { CONFIG_DIR, LEDGER_FILE, DEFAULT_CAP_USD, addSpend, benchAuth, runCost } from './api-auth.mjs';
import { assertLogin, assertEngineSockets, quote } from './preflight.mjs';
import { archiveOldRuns, pruneRunImages } from './run-archive.mjs';
import { evidenceRoots } from './evidence.mjs';
import { sweepTemp } from '../scripts/temp-sweep.mjs';
import { beginPassHygiene } from './pass-hygiene.mjs';
import { prepareGenericArm, acceptGenericCatalog, genericSettings } from './plugin-arm.mjs';
import { genericTask } from './generic-task.mjs';
import { guardGenericOperation } from './generic-approval.mjs';
import { assertCalculatorReady } from './plugin-live.mjs';
import { worldPassApps } from './world/tasks.mjs';
import { engineSpan, readEngine } from './engine-version.mjs';
import { ensureCuaDaemon, isNativeArm, nativeArmPlan, prepareNativeArm } from './world/native-arms.mjs';
import { worldCLI, worldArm, worldSettings, assertWorldCLI } from './world/native-world.mjs';
import { interactivePlan, runInteractive, verifyInteractiveCLI } from './world/arms/claude-cu/interactive.mjs';
import { dragMethodAudit } from './world/method-check.mjs';
import { benchHand } from './hand/bench-hand.mjs';
import { analyticsArm, writeAnalyticsMcp } from './analytics-validation.mjs';
import { actionLogPath } from '../plugins/sleight/lib/action-outcomes.mjs';
import { refreshHub } from './hub-refresh.mjs';
import { sleightPluginLaunch } from './sleight-plugin-launch.mjs';

// The desktop arm owns no Claude CLI, MCP config or engine approval list.
// Dispatch before the ordinary runner prepares any of those resources.
if (process.argv[process.argv.indexOf('--arm') + 1]?.split(',').includes('cursor-cu')) {
  try { await (await import('./world/arms/cursor-cu/suite.mjs')).nativeMain(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 5 * 60 * 1000;

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
// The git repo a folder belongs to, if any.
function gitRoot(dir) {
  try { return execFileSync('/usr/bin/git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}
const isDryRun = process.argv.includes('--dry-run');
const hygieneDryRun = process.argv.includes('--hygiene-dry-run');
if (process.argv.includes('--world')) throw new Error('use --suite world for world isolation');
const isSetupOnly = process.argv.includes('--setup-only');
const ownerAway = process.argv.includes('--owner-away');
const ownerPresent = process.argv.includes('--owner-present');
if (ownerAway && ownerPresent) throw new Error('--owner-present is the opposite of --owner-away; pass only one');
const calculatorGate = process.argv.includes('--calculator-gate');
// The ghost hand stays off in every arm unless SLEIGHT_BENCH_HAND=1 (the H6 cost pass); a bad value stops here.
const ghostHand = benchHand(process.env);
if (ghostHand === '1') console.error('Ghost hand on in the sleight arms (SLEIGHT_BENCH_HAND=1): timing is comparable only with other hand-on rows.');
const cleanArms = process.argv.includes('--clean-arms');
const suite = option('suite', 'default');
const world = suite === 'world';
if (suite === 'battery') {
  try { process.exitCode = await (await import('./battery/run.mjs')).main(); }
  catch (error) { console.error(`Battery stopped: ${/^[A-Z][A-Z0-9_]+\b/.exec(error.message)?.[0] ?? 'BATTERY_STOP'}. Check options, fixture seeds and private prerequisites.`); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
if (isSetupOnly && (suite !== 'real' || isDryRun)) throw new Error('--setup-only requires --suite real without --dry-run');
const suiteTasks = getTasks(suite);
if (world && !isDryRun && !ownerAway) {
  const ids = option('tasks', undefined)?.split(',');
  const supervised = ids && selectSuiteTasks(suiteTasks, ids);
  if (!ownerPresent || !supervised?.length || supervised.some(task => !task.ownerPresent)) {
    throw new Error('world live fixtures require --owner-away except a separate owner-present task pass');
  }
}
const controller = new AbortController();
process.on('SIGINT', () => controller.abort(new Error('run interrupted')));
process.on('SIGTERM', () => controller.abort(new Error('run interrupted')));
const armOption = option('arm', 'sleight');
// The world suite runs its Claude arms on the owner's account login by default (LAWS, 2026-10-15): each arm
// has its own isolated config dir and its own login, checked before any task. --auth api stays available.
// All testing runs on the owner's account login (LAWS, 2026-10-15). The API key needs an explicit --auth api or auto.
const authMode = option('auth', 'login');
// X3 is a short native validation pass, with the switch only in this bank's MCP descriptor.
const analyticsBank = option('analytics-config', undefined);
if (process.argv.includes('--analytics-config') && (!analyticsBank || analyticsBank.startsWith('--'))) throw new Error('--analytics-config needs a prepared bank');
if (analyticsBank && (suite !== 'default' || armOption !== 'sleight' || !cleanArms || authMode !== 'login' ||
    option('tasks', '') !== 'calculator-click' || option('runs', '1') !== '1' || isSetupOnly)) {
  throw new Error('--analytics-config requires --suite default --arm sleight --clean-arms --auth login --tasks calculator-click --runs 1');
}
const analytics = analyticsBank ? analyticsArm(analyticsBank, { root: ROOT }) : undefined;
if (analytics && ['', '.1', '.2', '.lock'].some(suffix => existsSync(actionLogPath(analytics.log) + suffix))) {
  throw new Error('ANALYTICS_BANK_USED: prepare a fresh bank for each pass');
}
const ARM_HOME = process.env.BENCH_ARM_HOME || join(homedir(), 'Library', 'Caches', 'sleight-bench');
const ARMS = {
  // Each arm runs from its own empty folder outside any git repo, so neither
  // gets this repo's CLAUDE.md or project memory. Until 2026-10-03 the sleight
  // arm ran here, and until 2026-10-05 in .dev/, which is still inside the repo:
  // Claude Code loads CLAUDE.md from parent folders and keys project memory by
  // the git root, so both arms got them.
  sleight: {
    cwd: (() => {
      const dir = analytics?.cwd ?? process.env.SLEIGHT_ARM_DIR ?? join(ARM_HOME, 'sleight-arm');
      if (!isDryRun) mkdirSync(dir, { recursive: true });
      return dir;
    })(),
    args: ['--plugin-dir', join(ROOT, 'plugins', 'sleight'), // Every sleight tool, as a user who approves its prompts would have. Without
    // them Claude lost 8 turns to refused select_window and menu_bar calls (2026-10-07).
    '--allowedTools', ['js', 'js_reset', 'drag', 'hover', 'menu_bar', 'notifications', 'select_window', 'open_file'].map(t => `mcp__plugin_sleight_computer__${t}`).join(',')],
    env: analytics?.env ?? {},
    server: 'plugin:sleight:computer',
  },
  // Native Codex computer use, for the head-to-head (owner, 2026-10-08). See codex-arm.mjs.
  codex: {
    cwd: (() => { const dir = join(ARM_HOME, 'codex-arm'); if (!isDryRun) mkdirSync(dir, { recursive: true }); return dir; })(),
    codex: true,
    check: codexReady,
  },
  lcu: (() => {
    const dir = process.env.LCU_ARM_DIR || join(ARM_HOME, 'lcu-arm');
    const prefix = process.env.LCU_PATH_PREFIX || join(ROOT, '.dev', 'py');
    return {
      cwd: dir,
      args: ['--mcp-config', join(dir, '.mcp.json'), '--allowedTools', 'mcp__lcu__js'],
      env: { PATH: `${prefix}:${process.env.PATH}` },
      server: 'lcu',
      ownHooks: join(dir, '.claude', 'settings.local.json'),
      check: () => existsSync(join(dir, '.mcp.json')) || `no LCU registration in ${dir}`,
    };
  })(),
};
// The Codex arm matches Haiku's class: gpt-6-luna at Claude's effort (owner, 2026-10-11). A second Codex arm runs gpt-6.1-sol
// (LAWS, 2026-10-18). Each model scores as its own arm: `--arm codex --codex-model gpt-6.1-sol` is recorded as codex-sol, so the
// claim scorer (it keys on the arm name) never mixes the two.
const CODEX_SOL = 'gpt-6.1-sol';
const codexModelOption = option('codex-model', undefined);
const armNames = (armOption === 'all' ? ['sleight', 'lcu'] : armOption.split(','))
  .map(name => name === 'codex' && codexModelOption === CODEX_SOL ? 'codex-sol' : name === 'codex-sleight' && codexModelOption === CODEX_SOL ? 'codex-sleight-sol' : name);
if (armNames.includes('codex-sol') && codexModelOption && codexModelOption !== CODEX_SOL) throw new Error(`the codex-sol arm runs ${CODEX_SOL}, not ${codexModelOption}`);
if (armNames.includes('codex-sleight-sol') && codexModelOption && codexModelOption !== CODEX_SOL) throw new Error(`the codex-sleight-sol arm runs ${CODEX_SOL}, not ${codexModelOption}`);
ARMS.codex.codexModel = codexModelOption ?? 'gpt-6-luna';
ARMS['codex-sol'] = { ...ARMS.codex, codexModel: CODEX_SOL };
// sleight itself inside Codex as its MCP plugin, on the same two models (LAWS, 2026-10-18): bench/codex-sleight.mjs. Own Codex home,
// own login copy, and no change to the engine's Always allow list: the approval proxy answers sleight's forms from approve.mjs.
const sleightHostArm = (name, codexModel) => ({ cwd: (() => { const dir = join(ARM_HOME, 'codex-sleight-arm'); if (!isDryRun) mkdirSync(dir, { recursive: true }); return dir; })(),
  codex: true, sleightHost: true, codexModel, codexHome: CODEX_SLEIGHT_HOME,
  check: () => { const home = ensureCodexSleightHome(); return home.ok || home.problem; },
  identity: { name, host: 'codex exec', model: codexModel, effort: option('codex-effort', option('effort', 'high')), codexHome: CODEX_SLEIGHT_HOME, approvals: 'benchmark proxy (approve.mjs policy); preapproved.json and the engine list untouched' } });
ARMS['codex-sleight'] = sleightHostArm('codex-sleight', codexModelOption ?? 'gpt-6-luna');
ARMS['codex-sleight-sol'] = sleightHostArm('codex-sleight-sol', CODEX_SOL);
// A pass with a plain Codex arm sets the engine's Always allow list for its whole length, so a sleight-in-Codex arm in the same
// pass meets fewer engine prompts than it would alone. The results say which (engineAllowList); claim passes run one arm each.
const setsEngineList = armNames.some(n => ARMS[n]?.codex && !ARMS[n].sleightHost) && !process.argv.includes('--codex-no-write');
const guardedPass = world || armNames.includes('claude-cu') || armNames.some(name => /^(plugin|mcp):/.test(name) || isNativeArm(name));
const preparationErrors = [];
let codexCleanConfig;
for (const name of armNames.filter(name => /^(plugin|mcp):/.test(name) || isNativeArm(name))) {
  try {
    ARMS[name] = isNativeArm(name) ? prepareNativeArm(name, { root: ROOT, armHome: ARM_HOME, dryRun: isDryRun })
      : prepareGenericArm(name, { root: ROOT, armHome: ARM_HOME, dryRun: isDryRun });
  } catch (error) {
    ARMS[name] = { generic: true, rejected: true, identity: { rejected: true } };
    preparationErrors.push({ arm: name, phase: 'configuration', passed: false, reason: error.message });
  }
}
if (armNames.includes('claude-cu')) ARMS['claude-cu'] = { cwd: join(ARM_HOME, 'claude-cu'), interactive: true,
  args: [], env: {}, server: 'computer-use', identity: { name: 'claude-cu', interactive: true, auth: 'isolated direct-plan login', claudeVersion: '2.1.289', toolCatalog: 'unverified until interactive connection' } };
for (const name of armNames) {
  if (!ARMS[name]) throw new Error(`unknown arm ${name}`);
  if (ARMS[name].rejected || ARMS[name].unsupported) continue;
  let arm = ARMS[name];
  if (arm.interactive) continue;
  if (world && !arm.codex) {
    arm = ARMS[name] = worldArm(arm, name);
    if (!isDryRun) mkdirSync(arm.env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (!arm.codex && !arm.args.includes('--no-chrome')) arm.args.push('--no-chrome');
  if (guardedPass && !arm.codex) {
    arm.guarded = true;
    arm.servers ??= [arm.server];
    if (!arm.generic) {
      if (name === 'sleight') {
        // Retain the plugin identity for both the model and the mod's connection.
        const mcp = join(arm.cwd, 'bench-mcp.json');
        arm.mcp = { mcpServers: { [arm.server]: { command: join(ROOT, 'plugins/sleight/bin/sleight-mcp') } } };
        if (!isDryRun) writeFileSync(mcp, JSON.stringify(arm.mcp), { mode: 0o600 });
        arm.args.push('--mcp-config', mcp);
      }
      arm.args.push('--strict-mcp-config', '--setting-sources', '', '--tools', '', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts', 'none');
    }
    arm.stopFile = join(arm.cwd, `approval-stop-${randomBytes(8).toString('hex')}`);
    arm.env.BENCH_ARM_SERVERS = JSON.stringify(arm.servers);
    arm.env.BENCH_APPROVAL_STOP = arm.stopFile;
    arm.settings = join(arm.cwd, 'bench-settings.json');
    let settings = arm.ownHooks ? mergeArmHooks(genericSettings(arm, ROOT), arm.ownHooks) : genericSettings(arm, ROOT);
    if (name === 'sleight') {
      const launch = sleightPluginLaunch({ args: arm.args, env: arm.env, mcpConfig: arm.mcp, settingsOverrides: settings });
      arm.args = launch.args; arm.env = launch.env; settings = launch.settingsOverrides;
    }
    if (!isDryRun) writeFileSync(arm.settings, JSON.stringify(world ? worldSettings(settings) : settings), { mode: 0o600 });
  }
  if (cleanArms && name === 'sleight' && !guardedPass) {
    // Clean arms keep the owner's user plugins, settings and MCP servers out of the CPU comparison:
    // an MCP allowlist admits sleight's server and the mod's own connection.
    const mcp = join(arm.cwd, 'bench-mcp.json');
    arm.mcp = { mcpServers: { [arm.server]: analytics?.server ?? { command: join(ROOT, 'plugins/sleight/bin/sleight-mcp') } } };
    if (!isDryRun) {
      if (analytics) writeAnalyticsMcp(analyticsBank, { root: ROOT });
      else writeFileSync(mcp, JSON.stringify(arm.mcp), { mode: 0o600 });
    }
    arm.args.push('--mcp-config', mcp, '--strict-mcp-config', '--setting-sources', '');
    const launch = sleightPluginLaunch({ args: arm.args, env: arm.env,
      mcpConfig: arm.mcp });
    arm.args = launch.args; arm.env = launch.env;
    arm.settings = join(arm.cwd, 'bench-settings.json');
    arm.cleanSettings = launch.settingsOverrides;
  }
  if (isDryRun) continue;
  const ok = ARMS[name].check?.() ?? true;
  if (ok !== true) throw new Error(ok);
  if (cleanArms && arm.codex && !arm.sleightHost) {
    try {
      const servers = codexConfigServers();
      if (servers.length !== 1) throw new Error(`the bench Codex home must configure only the engine server for clean arms, found ${servers.length ? servers.join(', ') : 'none'}`);
      codexCleanConfig = servers;
    } catch (error) {
      preparationErrors.push({ arm: name, phase: 'configuration', passed: false, reason: error.message });
    }
  }
  const repo = gitRoot(ARMS[name].cwd);
  if (repo) throw new Error(`${name} arm folder ${ARMS[name].cwd} is inside the git repo ${repo}, so its runs would load that repo's CLAUDE.md and project memory. Use a folder outside any repo.`);
}
const runs = Number(option('runs', '1'));
// The real suite drives web pages through the accessibility tree unless --surfaces browser,computer
// asks for the extension browser surface too (the 2026-10-10 comparison).
const realSurfaces = option('surfaces', 'computer');
if (!['computer', 'browser,computer'].includes(realSurfaces)) throw new Error('--surfaces must be computer or browser,computer');
const model = option('model', 'claude-haiku-5-5');
const effort = option('effort', 'high');
const codexEffort = option('codex-effort', effort);
const wanted = option('tasks', undefined)?.split(',');
const claudeBin = world ? worldCLI(ARM_HOME) : process.env.CLAUDE_BIN || 'claude';
const selected = selectSuiteTasks(suiteTasks.filter(task => task.surface !== 'extension' || realSurfaces === 'browser,computer' || wanted?.includes(task.id)), wanted);
if (!isDryRun && selected.some(task => task.requiredProfile && task.requiredProfile !== option('real-profile', undefined))) {
  throw new Error('CC_ISOLATED_PROFILE_REQUIRED: select --real-profile fresh');
}
if (selected.some(task => task.surface === 'extension') && realSurfaces !== 'browser,computer') {
  throw new Error('extension tasks require --surfaces browser,computer');
}
if (selected.some(task => task.surface === 'extension') && !process.argv.includes('--extension-sites-allowed')) {
  throw new Error('extension tasks require --extension-sites-allowed; the owner must first allow 127.0.0.1 in the extension\'s site settings');
}
assertShopSmokeRuns(selected, runs);
// Tasks in the owner's real accounts run only with the owner at the Mac and watching (LAWS, 2026-10-11).
if (selected.some(task => task.ownerPresent) && !ownerPresent) throw new Error('owner-present tasks (iPhone Mirroring, Mail, Mimestream and chat reads) require --owner-present');
if (calculatorGate && (isDryRun || selected.some(task => task.id !== 'calculator-click'))) throw new Error('--calculator-gate requires a live calculator-click pass');
const privatePass = selected.some(task => task.privateMail);
if (privatePass && (selected.some(task => !task.privateMail) || armNames.some(name => name !== 'sleight'))) {
  throw new Error('Mimestream and chat tasks require a separate sleight-only pass selected with --tasks');
}
if (!isDryRun && ARMS.sleight.cleanSettings) {
  const settings = JSON.parse(readFileSync(join(ROOT, 'bench', privatePass ? 'private-settings.json' : 'settings.json'), 'utf8'));
  writeFileSync(ARMS.sleight.settings, JSON.stringify({ ...settings, ...ARMS.sleight.cleanSettings }), { mode: 0o600 });
}

// SLEIGHT_APPROVAL_PROMPT=client keeps approvals going to approve.mjs, even
// when the benchmark runs from a desktop app session.
// No claude.ai connectors: an arm loads only its own tool, and each connector listing is one more
// account request on the owner's login, which shares a rate limit with their usage meter (2026-10-10).
// Claude arms run on the owner's API key when ~/.config/sleight-bench/anthropic-api-key exists
// (--auth api|login|auto), up to a monthly cap (bench/api-auth.mjs).
const auth = !preparationErrors.length && !isDryRun && armNames.some(name => !ARMS[name].codex && !ARMS[name].unsupported && !ARMS[name].interactive)
  ? (() => {
    try { return benchAuth({ mode: authMode, capUsd: Number(process.env.SLEIGHT_BENCH_API_CAP_USD || DEFAULT_CAP_USD) }); }
    catch (error) {
      if (/spend|unpriced/i.test(error.message)) error.message += `\nFix: ${quote('nano')} ${quote(LEDGER_FILE)}`;
      throw error;
    }
  })()
  : { mode: 'login', env: {}, unset: [] };
if (world && auth.mode === 'login' && !isDryRun) console.log('Claude arms run on the account login, one isolated config per arm.');
if (auth.mode === 'api') console.log(`Claude arms run on the API key: $${auth.spent.toFixed(2)} of the $${auth.capUsd} monthly cap spent.`);
if (armNames.includes('claude-cu') && !isDryRun) console.log('claude-cu uses its isolated direct-plan login.');
// A pass started from a Claude session inherits that session's identity: CLAUDE_CODE_ENTRYPOINT,
// the account's IDs and email, and the desktop app's messaging socket. Arms carried all of it, so
// the API grant billed them as the desktop app's Claude Code and refused them, while the same key
// paid for claude -p from a clean environment (2026-10-11). Arms start from the host env without it.
const HOST_SESSION = suite === 'world' ? /^CLAUDE/ : /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_)/;
const hostFree = Object.fromEntries(Object.entries(process.env).filter(([key]) => !HOST_SESSION.test(key)));
const armEnv = (arm, extra = {}) => {
  // The ghost hand off, as the Firefox arms have turbo off: its panel stays out of timing. SLEIGHT_BENCH_HAND=1 (the cost
  // pass) or an arm's own env turns it on.
  const env = { ...hostFree, BENCH_ROOT: ROOT, SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_HAND: ghostHand,
    ...arm.env, ...extra, BENCH_SUITE: suite, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ...auth.env,
    ...(world ? { BENCH_WORLD_TASKS: JSON.stringify(selected.map(task => task.id)) } : {}),
    ...(ownerPresent ? { BENCH_OWNER_PRESENT: '1' } : {}),
    ...(['real', 'world'].includes(suite) ? { SLEIGHT_SURFACES: realSurfaces } : {}) };
  for (const key of auth.unset) delete env[key];
  if (auth.mode === 'login' || arm.interactive) {
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  env.DO_NOT_TRACK = '1';
  if (arm.native || arm.world) env.CLAUDE_CONFIG_DIR = arm.env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = auth.env.CLAUDE_CONFIG_DIR ?? arm.env.CLAUDE_CONFIG_DIR ?? CONFIG_DIR;
  if (analytics && arm === ARMS.sleight) env.CLAUDE_CONFIG_DIR = analytics.env.CLAUDE_CONFIG_DIR;
  return env;
};

// The MCP servers an arm's Claude Code starts, read from its init event and
// stopped before any model call.
function armServers(arm) {
  if (privatePass) assertPrivateClaudePolicy();
  const args = ['-p', 'hi', '--output-format', 'stream-json', '--verbose', ...arm.args,
    ...(privatePass ? ['--no-session-persistence', '--setting-sources', ''] : []),
    '--settings', arm.settings ?? join(ROOT, 'bench', privatePass ? 'private-settings.json' : 'settings.json')];
  {
    const initialized = new AbortController();
    let buffer = '', catalog, keySource;
    const discover = signal => runOwned(claudeBin, args, { cwd: arm.cwd, env: privatePass ? privateDriverEnvironment(armEnv(arm)) : armEnv(arm), timeoutMs: 60000,
      signal: AbortSignal.any([initialized.signal, signal]),
      onSpawn: pid => { armPids.push(pid); windowHygiene?.recordArm?.(pid); },
      onStdout: data => {
        buffer += data;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'system' && event.subtype === 'init') { catalog = { servers: event.mcp_servers, tools: event.tools }; keySource = event.apiKeySource; initialized.abort(); }
        }
      },
    });
    // Dry discovery is collected at init, before a model or task setup. Live
    // discovery additionally requires a working system permission observer.
    return (arm.guarded ? guardGenericOperation(discover, { signal: controller.signal, stopFile: arm.stopFile,
      permissionCheck: isDryRun ? undefined : observePermission }) : discover(controller.signal)).then(result => {
      if (result.approvalStop) throw new Error(result.approvalStop);
      if (!result.groupClean) throw new Error('Arm preflight process group cleanup unconfirmed');
      if (!catalog) throw new Error('Arm preflight returned no init event');
      if (auth.mode === 'api' && keySource !== 'ANTHROPIC_API_KEY') throw new Error(`Arm preflight used ${keySource ?? 'an unknown credential'}, not the benchmark API key`);
      if (world && auth.mode === 'login' && keySource === 'ANTHROPIC_API_KEY') throw new Error('Arm preflight used an API key, not the account login');
      if (privatePass) assertPrivateClaudePolicy();
      controller.signal.throwIfAborted();
      return catalog;
    });
  }
}

// Each arm must have its own tool connected and not the other's. A user-level
// install of either would otherwise leak into both arms (it did, 2026-10-03,
// until settings.json turned off the installed sleight).
const otherServers = Object.values(ARMS).flatMap(a => a.servers ?? [a.server]).filter(Boolean);
async function checkArms() {
if (world && !isDryRun && armNames.some(name => !ARMS[name].codex && !ARMS[name].interactive && !ARMS[name].unsupported && !ARMS[name].rejected)) {
  assertWorldCLI(claudeBin, execFileSync);
}
if (!isDryRun && !isSetupOnly) {
  // Admit every selected arm before discovery can start an MCP server or a fixture. Every arm that is not
  // logged in is named, each with its own login command, so one refusal covers the whole pass.
  const notLoggedIn = [];
  for (const name of armNames.filter(name => !ARMS[name].codex && !ARMS[name].unsupported && !ARMS[name].rejected)) {
    const arm = ARMS[name];
    try {
      if (arm.interactive) {
        const plan = interactivePlan({ armDir: arm.cwd, prompt: 'login preflight only', model, effort });
        assertLogin(plan);
      } else if (auth.mode === 'login') assertLogin({ command: claudeBin, cwd: arm.cwd, env: armEnv(arm) });
    } catch (error) { notLoggedIn.push(world ? `${name}: ${error.message}` : error.message); }
  }
  if (notLoggedIn.length) throw new Error(notLoggedIn.join('\n'));
  if (selected.some(task => task.surface === 'extension')) await assertEngineSockets();
}
if (calculatorGate) await calculatorReady('preflight');
for (const name of armNames.filter(n => !ARMS[n].codex && !ARMS[n].unsupported && !isSetupOnly && !isDryRun)) {
  if (guardedPass && !isDryRun) assertNoHold();
  const arm = ARMS[name];
  if (arm.interactive) {
    if (!isDryRun) verifyInteractiveCLI(interactivePlan({ armDir: arm.cwd, prompt: 'version preflight only', model, effort }));
    continue;
  }
  // Cua's MCP command is a proxy that exits unless its daemon listens, and only the race harness started one (CU1).
  if (name === 'cua') cuaDaemon = await ensureCuaDaemon(arm.cwd);
  const catalog = await armServers(arm);
  if (arm.generic) { acceptGenericCatalog(arm, catalog); continue; }
  const { servers } = catalog;
  const own = servers.find(s => s.name === arm.server);
  if (own?.status !== 'connected') throw new Error(`${name} arm: ${arm.server} is ${own?.status ?? 'missing'}`);
  const leaked = servers.filter(s => s.name !== arm.server && (arm.guarded || otherServers.includes(s.name)));
  if (leaked.length) throw new Error(`${name} arm also loads ${leaked.map(s => s.name).join(', ')}`);
}
}

function assertNoHold() {
  if (existsSync('/tmp/sleight-hold')) throw new Error('live run stopped: /tmp/sleight-hold exists');
}
async function guardedPermissionCheck() {
  assertNoHold();
  const permission = await observePermission();
  assertNoHold();
  return permission;
}

// Keyboard filter taps held by benchmark apps after a run's cleanup. Device Hub kept one after the
// simulator runs and every key on the Mac stalled (2026-10-09), so a pass stops on any.
const TAPS_BIN = join(ARM_HOME, 'keyboard-taps');
function benchKeyboardTaps() {
  try {
    if (!existsSync(TAPS_BIN)) execFileSync('swiftc', ['-O', join(ROOT, 'bench', 'keyboard-taps.swift'), '-o', TAPS_BIN], { stdio: 'ignore', timeout: 180000 });
    const names = new Set(['Calculator', 'TextEdit', 'Chess', 'Simulator', 'DeviceHub', 'Device Hub', 'Safari', 'Preview', 'Finder', 'Helium',
      'Microsoft Word', 'Word', 'Microsoft Excel', 'Excel', 'Microsoft PowerPoint', 'PowerPoint', 'Mail', 'Mimestream']);
    return JSON.parse(execFileSync(TAPS_BIN, { encoding: 'utf8', timeout: 10000 })).filter(t => names.has(t.app));
  } catch (err) { return [{ app: 'unknown', error: `keyboard tap check failed: ${err.message}` }]; }
}

// Tools that act outside the app. A user's own settings can allow them (the owner's allow Bash(*)),
// and with them a run could pass a check without touching the app: no run did, in 716 transcripts
// checked on 2026-10-09, but Claude opened task files with `open` from Bash, which the Codex arm
// (no shell) can't. Every Claude arm runs without them. Glob, Grep and Read too: in the 1.1.0 pass,
// Claude looked for its saved Chess game with Glob, which never returned, and 3 chess-drag runs that
// had saved the right game ran into the 5-minute limit (2026-10-09).
// Skill too: the user's own plugins load in a run, and one simulator run invoked another plugin's
// skill (2026-10-09). sleight's skill reaches Claude with the engine's first result instead.
const OUTSIDE_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Read', 'Skill'];

// CPU a run costs the Mac (footprint.mjs), sampled from when the driver starts until it exits.
function footprint(apps, client) {
  let stop;
  return { onSpawn: pgid => { armPids.push(pgid); windowHygiene?.recordArm?.(pgid); stop = startFootprint({ pgid, apps: apps.filter(Boolean) }); },
    finish: async () => { const used = await stop?.(); return used && { ...used, split: cpuSplit(used, { client }) }; } };
}

async function runClaude(prompt, arm, env = {}, { signal, evidenceDir, onPermissionRefusal, privateMail = false, onSpawn, fixtureLifecycle = false, auditDrag = false, timeoutMs = TIMEOUT_MS, allowedApps = [], allowedGrants = [] } = {}) {
  if (privateMail) assertPrivateClaudePolicy();
  if (arm.interactive) {
    const plan = interactivePlan({ armDir: arm.cwd, prompt, model, effort, timeoutMs, allowedApps, allowedGrants, hostEnv: armEnv(arm, env) });
    const events = [];
    const out = await runInteractive(plan, { signal: signal ?? controller.signal, onSpawn,
      onEvent: auditDrag ? event => events.push(JSON.stringify(event)) : undefined });
    if (out.approvalBlock && evidenceDir && !privateMail) writeFileSync(join(evidenceDir, 'approval-block.json'), scrub(JSON.stringify(out.approvalBlock, null, 2)) + '\n', { mode: 0o600 });
    const approvalStop = out.gateBlocked ? out.reason : !out.groupClean ? 'interactive cleanup unverified' : undefined;
    if (approvalStop) onPermissionRefusal?.();
    return { code: out.is_error ? 1 : 0, out, agentSeconds: out.agentSeconds ?? null, agentTiming: out.agentTiming, groupClean: out.groupClean, timedOut: out.timedOut,
      ...(out.is_error && { passed: false, reason: out.reason }),
      ...(auditDrag && { methodAudit: dragMethodAudit(events.join('\n')) }),
      ...(approvalStop && { approvalStop }) };
  }
  const args = claudeArgs(prompt, arm, { privateMail, fixtureLifecycle });
  const drive = (driverSignal, stop) => runDriver(claudeBin, args, { cwd: arm.cwd, env: armEnv(arm, env), timeoutMs, onSpawn,
      signal: driverSignal,
      evidenceDir, privateMail, auditDrag, privatePolicyCheck: privateMail ? assertPrivateClaudePolicy : undefined,
      onPermissionRefusal: arm.guarded ? () => stop('unsupported approval: permission refused') : onPermissionRefusal,
      format: suite === 'real' || guardedPass || fixtureLifecycle ? 'stream-json' : 'json' });
  const response = arm.guarded ? await guardGenericOperation(drive, { signal: signal ?? controller.signal,
    stopFile: arm.stopFile, onStop: onPermissionRefusal }) : await drive(signal ?? controller.signal);
  const approvalStop = response.approvalStop ?? (arm.guarded && response.out?.permission_denials?.length
    ? 'unsupported approval: arm requested a non-elicitation permission' : undefined);
  return { ...response, ...(approvalStop && { approvalStop }) };
}

// runCodex's home option for an arm. The sleight-in-Codex arms get this run's servers written into their own Codex home first
// (a copy goes in the run's folder), with the env the Claude-hosted sleight arm's server gets for the same pass. The home is
// read back before Codex starts: a server the run didn't plan stops the pass.
const sleightHostConfig = (arm, dir, evidenceDir) => codexSleightRunConfig({ model: arm.codexModel, effort: codexEffort, dir, suite, ownerPresent,
  worldTasks: world ? selected.map(task => task.id) : undefined,
  surfaces: ['real', 'world'].includes(suite) ? realSurfaces : undefined, trace: evidenceDir, repo: ROOT, home: arm.codexHome });
function codexHomeFor(arm, { dir, evidenceDir }) {
  if (!arm.sleightHost) return {};
  const config = sleightHostConfig(arm, dir, evidenceDir);
  writeCodexSleightConfig(config.toml, arm.codexHome, join(dir, 'codex-config.toml'));
  assertOnlyServers(codexConfigServers(arm.codexHome), config.servers);
  return { home: arm.codexHome, servers: config.servers };
}
// The same, before any fixture starts. A refused home is a configuration row (no seconds, so the claim scorer skips it) and
// stops the pass; undefined tells the caller to stop.
function codexRunHome(arm, armName, task, run, dirs) {
  try { return codexHomeFor(arm, dirs); }
  catch (error) {
    results.push({ arm: armName, task: task.id, run, phase: 'configuration', passed: false, reason: scrub(error.message) });
    console.error(`STOP: ${scrub(error.message)}`);
    controller.abort(error); process.exitCode = 1; save();
  }
}
// After a sleight-in-Codex run: a call to any MCP server the run didn't configure fails it, as a shell command does.
function strayServers(response, codexHome) {
  const stray = codexHome.servers ? Object.keys(response.toolServers ?? {}).filter(name => !codexHome.servers.includes(name)) : [];
  if (stray.length) response.forbidden = [...response.forbidden ?? [], ...stray.map(name => `MCP server ${name}`)];
}
// A Codex arm's dry-run row: the exact `codex exec` arguments, its home, and the servers and approval path a run would get.
const codexDryPlan = arm => ({ runner: 'runCodex', model: arm.codexModel, effort: codexEffort,
  command: ['codex', ...codexExecPlan('<fixture task prompt>', { cwd: arm.cwd, model: arm.codexModel, effort: codexEffort })],
  codexHome: arm.codexHome ?? CODEX_HOME,
  ...(arm.sleightHost ? { servers: sleightHostConfig(arm, '<run folder>').servers, approvals: 'proxy answers from approve.mjs; engine Always allow list untouched' }
    : { servers: 'the engine server configured in the home', approvals: 'engine Always allow list set to the benchmark apps for the pass, then restored' }) });
// The repo's commit (the harness for every arm, the plugin for sleight's), recorded because the 2026-10-17 claim results didn't
// say which build they measured. Read again for every row: a sleight arm starts the working tree's plugin on each run.
const sleightAt = () => {
  try {
    const git = args => execFileSync('/usr/bin/git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '' };
  } catch { return { commit: null }; }
};
const sleightBuild = sleightAt();
// The ChatGPT engine version, a pure read of the doctor's engine folder: once for the pass (again at its last save, flagging a
// change) and once per row, so a row names the engine it ran on, dated by the UTC time it finished (LAWS, owner 2026-10-19).
// The read is taken again once the pass holds the live lock, so a pass that waited for the lock starts its span then.
let engineAtStart = readEngine();
const publicRead = read => { if (!read) return read; const { error, ...rest } = read; return rest; };
const sleightRow = () => { const { commit, dirty } = sleightAt();
  return { sleightCommit: commit, sleightDirty: dirty, engineVersion: readEngine({ app: false }).version, finishedAt: new Date().toISOString(),
    // Each row says so too, so a row copied out of its pass still can't reach a claim table (claim-score.mjs excluded).
    ...(ghostHand === '1' && { ghostHand: 'on' }) }; };

function claudeArgs(prompt, arm,{ privateMail = false, fixtureLifecycle = false } = {}) {
  return [
    '-p', prompt,
    ...(privateMail ? ['--no-session-persistence'] : []),
    ...arm.args,
    '--disallowedTools', OUTSIDE_TOOLS.join(','),
    ...(privateMail ? ['--setting-sources', ''] : []),
    '--settings', arm.settings ?? join(ROOT, 'bench', privateMail ? 'private-settings.json' : 'settings.json'),
    '--output-format', suite === 'real' || guardedPass || fixtureLifecycle ? 'stream-json' : 'json',
    ...(suite === 'real' || guardedPass || fixtureLifecycle ? ['--verbose'] : []),
    '--model', model,
    '--effort', effort,
  ];
}

// Window titles can carry the user's name (Chess: "Game 1 | Name - Computer"),
// and Claude quotes them. Results are published, so answers lose it.
const fullName = (() => { try { return execFileSync('id', ['-F'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
const scrub = text => {
  if (typeof text !== 'string') return text;
  text = text.replaceAll(homedir(), '~').replaceAll(realpathSync(tmpdir()), '<temp>').replaceAll(tmpdir(), '<temp>');
  return fullName.length > 2 ? text.split(fullName).join('<user>') : text;
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const results = [];
const liveConditions = [];
async function calculatorReady(stage) {
  try { liveConditions.push({ stage, ...await assertCalculatorReady({ signal: controller.signal }) }); }
  catch (error) { controller.abort(error); throw error; }
}
const realContexts = [], passCleanupErrors = [], armPids = [], touchedApps = new Set();
let windowHygiene, hygieneResult;
const hygieneErrors = [];
let hygieneErrorCount = 0;
const recordHygieneError = error => {
  hygieneErrorCount++;
  if (hygieneErrors.length < 20) hygieneErrors.push(scrub(error.message));
  console.error(privatePass ? 'Pass hygiene: inventory unavailable; tasks continue.' : `Pass hygiene: ${scrub(error.message)}; tasks continue.`);
};
const hygieneBoundary = async () => {
  try { await windowHygiene?.betweenTasks?.(); } catch (error) { recordHygieneError(error); }
};
const fixtureContexts = [];
const resultsDir = join(ROOT, 'bench', 'results');
if (!isDryRun) mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${stamp}${isDryRun ? '-dry' : isSetupOnly ? '-setup' : ''}.json`);
// Written after every run, so a run cut short keeps what it finished.
const save = (final = false) => {
  const tracking = windowHygiene?.hygieneError;
  const finishErrors = hygieneResult?.errors.slice(0, hygieneResult.errors.length - (hygieneResult.trackingErrors?.length ?? 0)) ?? [];
  const count = hygieneErrorCount + (tracking?.count ?? 0) + finishErrors.length;
  const hygieneError = count ? { errors: [...hygieneErrors, ...finishErrors, ...(tracking?.errors ?? [])].slice(0, 20), count } : undefined;
  if (final && hygieneError) console.error(privatePass ? 'Pass hygiene: inventory unavailable; tasks continued.' : `Pass hygiene: ${scrub(hygieneError.errors.join('; '))} (${count} errors)`);
  if (isDryRun) {
    if (final) console.log(JSON.stringify({ dryRun: true, world, arms: armNames, sleight: sleightBuild, engine: engineAtStart, results }, null, 2));
    return;
  }
  if (privatePass) {
    if (!fullName) throw new Error('PRIVATE_MAIL_OWNER_AUDIT_UNAVAILABLE');
    const json = JSON.stringify({ engine: engineSpan(publicRead(engineAtStart), final ? publicRead(readEngine()) : undefined), results: publicPrivateMailRows(results),
      ...(hygieneError && { hygieneError: { count: hygieneError.count, code: 'HYGIENE_INVENTORY_UNAVAILABLE' } }),
      ...(hygieneResult && { leftWindows: hygieneResult.leftWindows.map(({ pid, id }) => ({ pid, ...(id && { id }) })) }) }, null, 2);
    publishPrivateMailResults(file, json, { ownerName: fullName,
      terms: realContexts.flatMap(ctx => ctx.privateTask.privateTerms(ctx)) });
    return;
  }
  const json = JSON.stringify({ stamp, ...(['real', 'world'].includes(suite) ? { suite, surfaces: realSurfaces, ownerAway, ownerPresent } : {}),
    ...(guardedPass && { fixturePolicy: 'retained app observers for every arm', ownerAway }),
    arms: armNames, sleight: sleightBuild, ghostHand: ghostHand === '1' ? 'on' : 'off', engine: engineSpan(engineAtStart, final ? readEngine() : undefined), ...(armNames.some(name => ARMS[name].codex) && { codexModels: Object.fromEntries(armNames.filter(name => ARMS[name].codex).map(name => [name, ARMS[name].codexModel])),
      codexEffort, codexCliVersions: [...new Set(results.map(row => row.codexCliVersion).filter(Boolean))], engineAllowList: setsEngineList ? 'benchmark apps for the pass' : 'untouched' }), ...(world ? { world: true } : {}), armMetadata: Object.fromEntries(armNames.filter(name => ARMS[name].generic || ARMS[name].world || ARMS[name].interactive || ARMS[name].sleightHost).map(name => [name, ARMS[name].identity])), model, effort, claude: claudeBin, auth: auth.mode,
    armSetup: cleanArms ? 'clean' : 'normal', ...(codexCleanConfig && { codexConfig: codexCleanConfig }), results,
    ...(hygieneError && { hygieneError }),
    ...(calculatorGate && { liveConditions }), ...(passCleanupErrors.length && { passCleanupErrors }),
    ...(hygieneResult && { hygiene: hygieneResult, leftWindows: hygieneResult.leftWindows }) }, null, 2);
  writeFileSync(file, scrub(json) + '\n');
};
// The runner owns the pass lock. Real tasks reuse it, so they cannot wait on
// themselves. This extends main's pass lock through driver collection.
let unlock, lockIdentity, cuaDaemon;
function finishRun(result) {
  if (isDryRun) return;
  // Results publish the model each arm ran (LAWS): a Codex run whose session log names another model says so.
  const asked = ARMS[result.arm]?.codex && ARMS[result.arm].codexModel;
  if (asked && result.modelsRan?.some(ran => ran !== asked)) {
    result.modelMismatch = true;
    console.error(`MODEL ${result.arm} ${result.task} #${result.run}: asked for ${asked}, Codex ran ${result.modelsRan.join(', ')}`);
  }
  if (asked && result.effortsRan?.some(ran => ran !== codexEffort)) {
    result.effortMismatch = true;
    console.error(`EFFORT ${result.arm} ${result.task} #${result.run}: asked for ${codexEffort}, Codex ran ${result.effortsRan.join(', ')}`);
  }
  if (!ARMS[result.arm]?.interactive && auth.mode === 'api' && Number.isFinite(result.costUsd)) {
    const spent = addSpend(result.costUsd);
    if (spent >= auth.capUsd) {
      controller.abort(new Error(`benchmark API spend reached the $${auth.capUsd} monthly cap`));
      process.exitCode = 1;
      console.error(`STOP: benchmark API spend this month is $${spent.toFixed(2)}, at the $${auth.capUsd} cap.`);
    }
  }
  const taps = benchKeyboardTaps();
  if (!taps.length) return;
  if (!privatePass) result.keyboardTaps = taps;
  result.passed = false;
  controller.abort(new Error('benchmark app holds a keyboard event tap'));
  process.exitCode = 1;
  console.error(privatePass ? 'STOP: private mail keyboard tap check failed.' : `STOP: ${taps.map(t => t.app).join(', ')} holds a keyboard event tap after cleanup.`);
}
try {
if (preparationErrors.length) {
  results.push(...preparationErrors);
  controller.abort(new Error('arm configuration refused')); process.exitCode = 1;
}
if (!controller.signal.aborted && guardedPass && !isDryRun && existsSync('/tmp/sleight-hold')) throw new Error('live run stopped: /tmp/sleight-hold exists');
if (!controller.signal.aborted && !isDryRun && armNames.some(name => !ARMS[name].unsupported)) {
  save();
  console.error('Acquiring /tmp/sleight-live.lock.');
  unlock = await acquireLiveLock(undefined, { wait: !guardedPass, signal: controller.signal, interval: 2000 });
  lockIdentity = statSync('/tmp/sleight-live.lock');
  engineAtStart = readEngine();
  // Without a baseline the receipts-only handle closes no window but still quits proven launches.
  try { windowHygiene = await beginPassHygiene({ cacheDir: ARM_HOME, signal: controller.signal }); }
  catch (error) { recordHygieneError(error); windowHygiene = error.receiptsOnly; }
  sweepTemp({ dryRun: hygieneDryRun });
  if (!hygieneDryRun) for (const base of new Set([tmpdir(), realpathSync(tmpdir())])) archiveOldRuns(join(base, 'sleight-bench'), join(ARM_HOME, 'runs-archive'));
  pruneRunImages({ roots: [join(ARM_HOME, 'runs-archive'), ...evidenceRoots({ armHome: ARM_HOME })],
    docsDir: join(ROOT, 'docs', 'benchmarks'), exclusionsFile: join(ROOT, 'bench', 'claim-exclusions.json'), dryRun: hygieneDryRun });
  // Codex can't answer app prompts headless, so the engine's "Always allow" list holds exactly the
  // benchmark apps for the pass, then goes back to what it was (exit handler below).
  // The sleight-in-Codex arms leave the engine's list alone: their approvals are the proxy's (bench/codex-sleight-proxy.mjs).
  if (setsEngineList) {
    const backup = join(homedir(), 'Library', 'Logs', 'sleight', `ComputerUseAppApprovals.before-${stamp}.json`);
    mkdirSync(dirname(backup), { recursive: true });
    const apps = suite === 'world' ? worldPassApps(selected) : [...BENCH_APPS, ...(suite === 'real' ? REAL_APPS : [])];
    const restore = approveOnly(apps.filter(a => /^(com|net|org)\./.test(a)), backup);
    process.once('exit', () => { try { restore(); } catch (err) { console.error(`Restore the app approvals from ${backup}: ${err.message}`); } });
    console.error(`App approvals set to the benchmark apps; saved the previous list to ${backup}.`);
  }
  process.once('exit', () => {
    if (!unlock) return;
    try {
      const current = statSync('/tmp/sleight-live.lock');
      if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) rmdirSync('/tmp/sleight-live.lock');
    } catch {}
  });
}
try { if (!controller.signal.aborted) await checkArms(); }
catch (error) {
  // The private pass's table drops the reason, so the local log carries it (2026-10-11: two preflight
  // failures said nothing).
  console.error('preflight failed: ' + scrub(error.message));
  results.push({ phase: 'preflight', passed: false, reason: scrub(error.message) });
  controller.abort(error); process.exitCode = 1; save();
}
// Arms alternate task by task, so both see the same conditions over time.
pass: for (let run = 1; run <= runs; run++) {
  for (const originalTask of selected) {
    const task = guardedPass && suite === 'default' ? genericTask(originalTask) : originalTask;
    for (const armName of armNames) {
      if (controller.signal.aborted) break pass;
      const arm = ARMS[armName];
      if (arm.unsupported || isDryRun) {
        results.push({ arm: armName, task: task.id, run,
          ...(arm.unsupported ? { unsupported: true, reason: arm.reason } : { dryRun: true,
            ...(arm.interactive ? { runner: 'runInteractive', model, effort, auth: arm.identity.auth } : arm.codex ? codexDryPlan(arm) : {
              command: [claudeBin, ...claudeArgs('<fixture task prompt>', arm)], mcp: arm.mcp }),
            check: 'same task.check after fixture setup; not executed during planning' }) });
        save();
        continue;
      }
      await hygieneBoundary();
      const nonce = randomBytes(4).toString('hex');
      const dir = join(suite === 'real' ? realpathSync(tmpdir()) : tmpdir(), 'sleight-bench', stamp, `${armName}-${task.id}-${run}`);
      mkdirSync(dir, { recursive: true });
      const ctx = { dir, nonce, fixtureRoot: join(tmpdir(), 'sleight-bench'), ownerAway, ownerPresent, realProfile: option('real-profile', undefined), ...(guardedPass && { stopOnAppDialog: true }) };
      fixtureContexts.push(ctx);
      for (const app of [task.app, ...task.allowedApps ?? []].filter(Boolean)) touchedApps.add(app);
      if (suite === 'real' || task.fixtureLifecycle || guardedPass) {
        if (task.privateMail) assertPrivateClaudePolicy();
        if (task.privateMail) ctx.privateTask = task;
        realContexts.push(ctx);
        const evidenceDir = task.privateMail || task.noScreenshot ? undefined : join(ARM_HOME, 'evidence', stamp, `${armName}-${task.id}-${run}`);
        if (evidenceDir) mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
        const codexHome = ARMS[armName].codex ? codexRunHome(ARMS[armName], armName, task, run, { dir, evidenceDir }) : {};
        if (!codexHome) break pass;
        let result;
        try { result = await executeRealTask(task, ctx, { dryRun: isDryRun, setupOnly: isSetupOnly, signal: controller.signal,
          lockHeld: !isDryRun,
          stop: () => controller.abort(new Error('macOS permission prompt')),
          permissionCheck: guardedPass ? guardedPermissionCheck : observePermission,
          drive: async (prompt, _ctx, callbacks) => {
            if (calculatorGate) await calculatorReady(armName);
            const observedApps = task.observedApps ?? [ctx.sim?.app ?? task.app];
            const cpu = footprint(task.privateMail ? [] : observedApps, ARMS[armName].codex ? 'codex' : 'claude');
            const watchers = guardedPass ? observedApps.map(app => [app, watchAppWindows(app)]) : [];
            const finishWatching = async response => {
              if (!watchers.length) return;
              const samples = Object.fromEntries(await Promise.all(watchers.map(async ([app, stop]) => [app, await stop()])));
              response.appWindows = samples[observedApps[0]];
              if (watchers.length > 1) response.appWindowsByApp = samples;
            };
            if (ARMS[armName].codex) {
              const response = await runCodex(prompt, { cwd: ARMS[armName].cwd, model: ARMS[armName].codexModel, effort: codexEffort, timeoutMs: task.timeoutMs ?? TIMEOUT_MS, signal: controller.signal, onSpawn: cpu.onSpawn, auditDrag: suite === 'world' && task.id === 'textedit-window-drag',
                ...(codexHome.home && { home: codexHome.home }) });
              strayServers(response, codexHome);
              response.timing = runTiming(response.out);
              if (ARMS[armName].sleightHost) {
                // The Claude-hosted arms stop the pass on a prompt outside the allowlist (BENCH_APPROVAL_STOP); so does this one.
                response.approvals = approvalSummary(join(dir, 'approvals.jsonl'), { log: true });
                if (response.approvals.declined.length) response.approvalStop = 'unsupported approval: elicitation is outside the benchmark app allowlist or uses an unsupported form';
              }
              response.footprint = await cpu.finish();
              await finishWatching(response);
              return response;
            }
            const response = await runClaude(prompt, ARMS[armName], !task.privateMail && !task.noScreenshot && armName === 'sleight' ? { SLEIGHT_TRACE: evidenceDir } : {},
              { signal: controller.signal, evidenceDir, ...callbacks, privateMail: task.privateMail,
                fixtureLifecycle: true, onSpawn: task.privateMail ? pid => { armPids.push(pid); windowHygiene?.recordArm?.(pid); } : cpu.onSpawn, timeoutMs: task.timeoutMs ?? TIMEOUT_MS,
                allowedApps: task.allowedApps, allowedGrants: task.allowedGrants, auditDrag: suite === 'world' && task.id === 'textedit-window-drag' });
            if (!task.privateMail) response.footprint = await cpu.finish();
            await finishWatching(response);
            if (!task.privateMail) response.timing = runTiming(response.out, armName === 'sleight' ? traceTiming(evidenceDir) : undefined);
            return response;
          },
        }); } catch (error) {
          if (!task.privateMail) throw error;
          // Unexpected lifecycle errors must not expose AX text in a stack.
          // Collect attached helpers without making further window actions.
          for (const lease of ctx.windowLeases ?? []) try { await lease.dispose(); } catch {}
          result = { passed: false, groupClean: false, reason: 'PRIVATE_MAIL_UNEXPECTED_STOP' };
        }
        // A shell or file edit could pass a check without the app, so it fails the run.
        if (result.forbidden?.length) { result.passed = false; result.reason = `used ${[...new Set(result.forbidden)].join(' and ')}`; }
        if (result.approvalStop) { result.passed = false; result.reason = result.approvalStop; controller.abort(new Error(result.approvalStop)); process.exitCode = 1; }
        const contained = !task.privateMail && cleanupContained(result);
        if (contained) { result.passed = result.taskPassed === true; result.cleanupContained = true; }
        const { out, code, forbidden: _forbidden, ...rest } = result;
        if (task.noScreenshot) { delete rest.screenshot; delete rest.cartShot; }
        results.push(task.privateMail ? privateMailResult(task, ctx, result, { arm: armName, run }) : { arm: armName, task: task.id, run, ...rest,
          ...sleightRow(), ...(ARMS[armName].codex && { codexModel: ARMS[armName].codexModel }),
          ...(suite === 'world' && { half: task.half, timeoutMs: task.timeoutMs }),
          ...((task.surface || ctx.webKind) && { surface: task.surface ?? 'native' }),
          ...(isDryRun && ARMS[armName].generic && { command: [claudeBin, ...ARMS[armName].args, '--disallowedTools', OUTSIDE_TOOLS.join(','), '--settings', ARMS[armName].settings] }),
          reason: scrub(result.reason), cleanupError: scrub(result.cleanupError), prompt: scrub(result.prompt),
          turns: out?.num_turns, costUsd: runCost(out), reportedCostUsd: out?.total_cost_usd, models: Object.keys(out?.modelUsage ?? {}),
          usage: out?.usage && { input: out.usage.input_tokens, cacheRead: out.usage.cache_read_input_tokens,
            cacheWrite: out.usage.cache_creation_input_tokens, output: out.usage.output_tokens },
          exitCode: code, answer: scrub(out?.result?.slice(0, 300)), stderr: code === 0 ? undefined : scrub(rest.stderr),
        });
        ctx.result = results.at(-1);
        finishRun(results.at(-1));
        save();
        const recorded = results.at(-1);
        // A private row has no reason; its code (CHAT_…, MIMESTREAM_…) carries no content, so the local log shows it.
        const privateCode = task.privateMail && !recorded.passed ? /^[A-Z][A-Z0-9_]+\b/.exec(String(result.reason ?? result.cleanupError ?? ''))?.[0] : undefined;
        console.error(`${recorded.passed ? 'PASS' : isDryRun ? 'DRY' : recorded.outcome ? 'STOP' : 'FAIL'} ${armName} ${task.id} #${run} ${recorded.seconds ?? 0}s${recorded.reason ? ` (${recorded.reason})` : privateCode ? ` (${privateCode})` : ''}`);
        if (contained) console.error(`CONTINUE: ${scrub(result.cleanupError)} (every app this run launched exited)`);
        else if (result.cleanupError || result.permissionPrompt || result.permissionRefusal || result.observerError || result.appDialog || result.groupClean === false) {
          // Which check and its code only (MIMESTREAM_…): codes carry no mail content.
          const privateStop = () => ['cleanupError', 'permissionPrompt', 'permissionRefusal', 'observerError', 'appDialog'].filter(key => result[key])
            .concat(result.groupClean === false ? ['groupClean'] : []).join(', ') + '; ' +
            [result.cleanupError, result.reason, result.observerError].map(v => /^[A-Z][A-Z0-9_]+\b/.exec(String(v ?? ''))?.[0]).filter(Boolean).join(', ');
          console.error(task.privateMail ? `STOP: private mail safety check failed (${privateStop()}).` : `STOP: ${scrub(result.cleanupError ?? result.reason ?? 'permission stop')}`);
          controller.abort(new Error('live safety stop'));
          process.exitCode = 1;
        }
        if (!result.passed && !isDryRun) process.exitCode = 1;
        continue;
      }
      const codexHome = arm.codex ? codexRunHome(arm, armName, task, run, { dir }) : {};
      if (!codexHome) break pass;
      // A setup this Mac can't do (no iOS runtime for the simulator task) skips
      // the run rather than ending the pass; skipped runs stay out of the table.
      try {
        if (windowHygiene) await windowHygiene.trackLaunch([task.app].filter(Boolean), () => task.setup?.(ctx));
        else await task.setup?.(ctx);
      } catch (err) {
        results.push({ arm: armName, task: task.id, run, skipped: true, reason: `setup: ${err.message}` });
        finishRun(results.at(-1));
        save();
        console.error(`SKIP ${armName} ${task.id} #${run} (setup: ${err.message})`);
        continue;
      }
      await hygieneBoundary();
      const prompt = task.prompt(ctx);

      if (isDryRun) {
        results.push({ arm: armName, task: task.id, run, prompt, dryRun: true, check: String(task.check({ ...ctx, answer: '' })),
          ...(ARMS[armName].generic && { command: [claudeBin, ...ARMS[armName].args, '--disallowedTools', OUTSIDE_TOOLS.join(','), '--settings', ARMS[armName].settings] }) });
        continue;
      }

      const started = Date.now();
      const stopWatching = watchAppWindows(ctx.sim?.app ?? task.app);
      // sleight traces into the run's scratch folder, so its timing comes from this run alone.
      const cpu = footprint([ctx.sim?.app ?? task.app], arm.codex ? 'codex' : 'claude');
      const codexRun = arm.codex ? await runCodex(prompt, { cwd: arm.cwd, model: arm.codexModel, effort: codexEffort, timeoutMs: TIMEOUT_MS, signal: controller.signal, onSpawn: cpu.onSpawn,
        ...(codexHome.home && { home: codexHome.home }) }) : undefined;
      if (codexRun) strayServers(codexRun, codexHome);
      const { code, out, stderr, groupClean = true, cancelled, stamps, agentSeconds, agentTiming } = codexRun ?? await runClaude(prompt, arm, armName === 'sleight' ? { SLEIGHT_TRACE: dir } : {}, { onSpawn: cpu.onSpawn });
      const cpuUsed = await cpu.finish();
      const appWindows = await stopWatching();
      const answer = out?.result ?? '';
      let verdict;
      try { verdict = groupClean ? task.check({ ...ctx, answer }) : 'Driver process group cleanup unconfirmed'; } catch (err) { verdict = err.message; }
      // A shell or file edit could pass a check without the app, so it fails the run.
      if (codexRun?.forbidden.length) verdict = `used ${[...new Set(codexRun.forbidden)].join(' and ')}`;
      // As in the fixture path: a prompt the proxy declined stops a sleight-in-Codex pass.
      const approvals = arm.sleightHost ? approvalSummary(join(dir, 'approvals.jsonl'), { log: true }) : undefined;
      if (approvals?.declined.length) {
        verdict = 'unsupported approval: elicitation is outside the benchmark app allowlist or uses an unsupported form';
        controller.abort(new Error(verdict)); process.exitCode = 1;
      }
      if (groupClean) try { await task.cleanup?.(ctx); } catch {} // leaving an app open doesn't change the verdict
      else { controller.abort(new Error('Driver cleanup unconfirmed')); process.exitCode = 1; }
      const elapsedMs = Date.now() - started;
      results.push({
        arm: armName,
        task: task.id,
        run,
        passed: verdict === true,
        reason: verdict === true ? undefined : scrub(verdict),
        seconds: Math.round(elapsedMs / 100) / 10,
        agentSeconds: agentSeconds ?? null,
        agentTiming,
        secondsTiming: { start: 'outer-drive', end: 'task-cleanup', startupIncluded: true },
        turns: out?.num_turns,
        costUsd: runCost(out), reportedCostUsd: out?.total_cost_usd,
        // Input, cached and output tokens: what a smaller result would save.
        usage: out?.usage && { input: out.usage.input_tokens, cacheRead: out.usage.cache_read_input_tokens,
          cacheWrite: out.usage.cache_creation_input_tokens, output: out.usage.output_tokens },
        timing: withStamps(runTiming(out, armName === 'sleight' ? traceTiming(dir) : undefined, elapsedMs), stamps, started),
        footprint: cpuUsed,
        // Samples every 5 s of the app's windows: on the current Space, only off it, or none.
        appWindows,
        exitCode: code,
        groupClean, cancelled,
        answer: scrub(answer.slice(0, 300)),
        // What Claude Code reports it used, to catch a model setting that didn't apply.
        models: Object.keys(out?.modelUsage ?? {}),
        ...sleightRow(),
        ...(codexRun && { toolCalls: codexRun.toolCalls, toolServers: codexRun.toolServers, engineMs: codexRun.engineMs, codexModel: arm.codexModel, modelsRan: codexRun.modelsRan,
          effortsRan: codexRun.effortsRan, codexCliVersion: codexRun.codexCliVersion, ...(approvals && { approvals }) }),
        stderr: code === 0 ? undefined : scrub(stderr),
      });
      finishRun(results.at(-1));
      save();
      const r = results.at(-1);
      console.error(`${r.passed ? 'PASS' : 'FAIL'} ${armName} ${task.id} #${run} ${r.seconds}s${r.reason ? ` (${r.reason})` : ''}`);
    }
  }
}

} finally {
  try {
    if (windowHygiene) {
      try {
        hygieneResult = await windowHygiene.finish({ dryRun: hygieneDryRun,
          ...(privatePass && { log: () => {} }),
          touchedApps: [...touchedApps, ...realContexts.flatMap(ctx => (ctx.windowLeases ?? []).flatMap(lease => [lease.app, lease.bundle]).filter(Boolean))],
          fixturePaths: fixtureContexts.flatMap(ctx => [ctx.dir, ctx.document, ctx.pdf, ctx.folder, ...(ctx.documents ?? [])].filter(Boolean)),
          fixtureNames: fixtureContexts.flatMap(ctx => [ctx.document, ctx.pdf, ctx.folder, ...(ctx.documents ?? [])].filter(Boolean).map(path => basename(path))),
          armPids, daemonPaths: armNames.filter(isNativeArm).flatMap(name => Object.values(nativeArmPlan(name, { armHome: ARM_HOME, dir: ARMS[name].cwd }).mcp.mcpServers).map(server => server.command)),
          // Closing and quitting are visible actions, so only a pass started with --owner-away takes them.
          blocked: !ownerAway || controller.signal.aborted || realContexts.some(ctx => ctx.fixtureLockUnconfirmed) || results.some(result => result.groupClean === false || result.cleanupError || result.appDialog || result.permissionPrompt || result.observerError || result.approvalStop),
          launched: realContexts.flatMap(ctx => (ctx.windowLeases ?? []).filter(lease => lease.launched && lease.running === false)
            .map(lease => ({ pid: lease.pid, start: lease.processStartedAtMs / 1000, bundle: lease.bundle }))),
          beforeAction: async () => {
            controller.signal.throwIfAborted(); assertNoHold();
            if (await observePermission()) throw new Error('macOS permission prompt: hygiene stopped');
          } });
      } catch (error) {
        recordHygieneError(error);
        passCleanupErrors.push({ phase: 'window hygiene', error: scrub(error.message) });
      }
    }
    if (!isDryRun && unlock) for (const cleanup of [closeBenchTextEdit, quitChess, quitSimApp]) {
      // Unscoped legacy tails could close windows that predate this pass.
      try { if (!hygieneDryRun) await cleanup({ ownedOnly: true }); }
      catch (error) { console.error(privatePass ? 'Pass cleanup failed: PRIVATE_MAIL_CLEANUP_UNCONFIRMED' : `Pass cleanup failed: ${error.message}`); process.exitCode = 1; }
    }
    save(true);
  } finally {
    // An owned app a JXA helper read as gone but the kernel still runs is still this pass's, so the lock stays (real-fixture.mjs).
    const disagreements = realContexts.flatMap(ctx => ctx.exitDisagreements ?? []);
    if (unlock && disagreements.length) {
      unlock = undefined; process.exitCode = 1;
      console.error(privatePass ? 'STOP: PRIVATE_MAIL_EXIT_DISAGREEMENT; /tmp/sleight-live.lock kept.' :
        `STOP: ${disagreements.map(item => `${item.app} pid ${item.pid} (${item.step})`).join(', ')} still running after a JXA helper read it as gone. ` +
        '/tmp/sleight-live.lock is kept: check those processes, then remove it.');
    }
    // Stops only a daemon this pass started; one already listening was the owner's and stays.
    try { await cuaDaemon?.stop(); }
    catch (error) { console.error(`Cua daemon: ${error.message}`); process.exitCode = 1; }
    try {
      if (!await releaseFixtureLock(realContexts, unlock)) {
        process.exitCode = 1;
        console.error('STOP: fixture setup, window cleanup or helper collection unconfirmed; live lock kept.');
      }
    }
    catch (error) { console.error(`Live lock: ${error.message}`); process.exitCode = 1; }
    unlock = undefined;
  }
}
if (controller.signal.aborted && !process.exitCode) process.exitCode = 130;

if (!isDryRun && privatePass) {
  console.log('\n| Arm | Task | Run | Passed | Seconds | Turns | Expected hash | Actual hash |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const row of results) console.log(`| ${row.arm} | ${row.task} | ${row.run} | ${row.passed} | ${row.seconds} | ${row.turns ?? '–'} | ${row.expectedHash ?? '–'} | ${row.actualHash ?? '–'} |`);
}
if (!isDryRun && !privatePass) {
  // Tools, outside tools and harness add up to the run's time; API time overlaps them.
  console.log('\n| Arm | Task | Passed | Median s | Tools s | Outside tools s | Harness s | API s (overlaps) | Engine s | Local tools s | Relay ms | Median turns | CPU sleight s | CPU engine s | CPU client s | CPU other s | API-price cost |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : '–'; };
  for (const task of selected) {
    for (const armName of armNames) {
      if (ARMS[armName].unsupported) {
        console.log(`| ${armName} | ${task.id} | not supported | ${Array(14).fill('–').join(' | ')} |`);
        continue;
      }
      const rs = results.filter(r => r.task === task.id && r.arm === armName && !r.skipped);
      const cost = rs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const ms = (key, scale) => { const m = median(rs.map(r => r.timing?.[key])); return m === '–' ? m : Math.round(m / scale * 10) / 10; };
      // Each arm's own CPU (footprint split): sleight's processes, the engine, the client, other
      // group processes. The driven app and the shared totals stay in the results file.
      const own = key => median(rs.map(r => r.footprint?.split?.[key]));
      console.log(`| ${armName} | ${task.id} | ${rs.filter(r => r.passed).length}/${rs.length} | ${median(rs.map(r => r.seconds))} | ${ms('toolWallMs', 1000)} | ${ms('outsideToolsMs', 1000)} | ${ms('harnessMs', 1000)} | ${ms('modelMs', 1000)} | ${ms('engineMs', 1000)} | ${ms('localMs', 1000)} | ${ms('relayMs', 1)} | ${median(rs.map(r => r.turns))} | ${own('sleight')} | ${own('engine')} | ${own('client')} | ${own('other')} | $${cost.toFixed(2)} |`);
    }
  }
}
if (!isDryRun) console.log(`\nresults: ${privatePass ? scrub(file) : file}`);
// Once, after a saved pass that succeeded: collect and render the benchmark hub (bench/hub-refresh.mjs). It skips while a live round
// holds the lock, on --no-hub or SLEIGHT_NO_HUB=1, and a hub error is one log line that never changes this exit status. The private
// mail pass is never published.
if (!isDryRun && !isSetupOnly && !hygieneDryRun && !privatePass) {
  console.log(refreshHub({ exitCode: process.exitCode ?? 0, saved: file, noHub: process.argv.includes('--no-hub') }).line);
}
