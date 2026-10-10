#!/usr/bin/env node
// Runs the sleight benchmark: each task through headless `claude -p` with the
// plugin loaded, checked outside the agent. Writes bench/results/<stamp>.json
// and prints a table.
//
//   node bench/run.mjs [--arm sleight|lcu|codex|all|a,b] [--suite default|real] [--tasks id,id] [--runs N] [--model M] [--effort E]
//     [--codex-model M] [--codex-effort E] [--dry-run] [--setup-only] [--owner-away] [--clean-arms]
//
// --clean-arms publishes the CPU comparison without the owner's setup (LAWS, 2026-10-10): the
// sleight arm runs with strict MCP configuration and empty setting sources, so only sleight's
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
import { existsSync, mkdirSync, realpathSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_APPS, REAL_APPS, closeBenchTextEdit, quitChess, quitSimApp, getTasks } from './tasks.mjs';
import { approveOnly, codexReady, codexConfigServers, runCodex } from './codex-arm.mjs';
import { startFootprint, cpuSplit } from './footprint.mjs';
import { watchAppWindows } from './app-windows.mjs';
import { runTiming, traceTiming } from './timing.mjs';
import { executeRealTask } from './real-run.mjs';
import { observePermission } from './real-permission.mjs';
import { runOwned } from './preapproved-process.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { runDriver, privateDriverEnvironment } from './driver.mjs';
import { privateMailResult, publicPrivateMailRow, publishPrivateMailResults } from './private-mail.mjs';
import { assertPrivateClaudePolicy } from './private-policy.mjs';
import { DEFAULT_CAP_USD, addSpend, benchAuth, runCost } from './api-auth.mjs';
import { archiveOldRuns } from './run-archive.mjs';
import { prepareGenericArm, acceptGenericCatalog, genericSettings } from './plugin-arm.mjs';
import { genericTask } from './generic-task.mjs';
import { guardGenericOperation } from './generic-approval.mjs';
import { assertCalculatorReady } from './plugin-live.mjs';

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
const isSetupOnly = process.argv.includes('--setup-only');
const ownerAway = process.argv.includes('--owner-away');
const calculatorGate = process.argv.includes('--calculator-gate');
const cleanArms = process.argv.includes('--clean-arms');
const suite = option('suite', 'default');
if (isSetupOnly && (suite !== 'real' || isDryRun)) throw new Error('--setup-only requires --suite real without --dry-run');
const suiteTasks = getTasks(suite);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort(new Error('run interrupted')));
process.on('SIGTERM', () => controller.abort(new Error('run interrupted')));
const armOption = option('arm', 'sleight');
const ARM_HOME = process.env.BENCH_ARM_HOME || join(homedir(), 'Library', 'Caches', 'sleight-bench');
const ARMS = {
  // Each arm runs from its own empty folder outside any git repo, so neither
  // gets this repo's CLAUDE.md or project memory. Until 2026-10-03 the sleight
  // arm ran here, and until 2026-10-05 in .dev/, which is still inside the repo:
  // Claude Code loads CLAUDE.md from parent folders and keys project memory by
  // the git root, so both arms got them.
  sleight: {
    cwd: (() => {
      const dir = process.env.SLEIGHT_ARM_DIR || join(ARM_HOME, 'sleight-arm');
      mkdirSync(dir, { recursive: true });
      return dir;
    })(),
    args: ['--plugin-dir', join(ROOT, 'plugins', 'sleight'), // Every sleight tool, as a user who approves its prompts would have. Without
    // them Claude lost 8 turns to refused select_window and menu_bar calls (2026-10-07).
    '--allowedTools', ['js', 'js_reset', 'drag', 'hover', 'menu_bar', 'notifications', 'select_window', 'blocked_app', 'open_file'].map(t => `mcp__plugin_sleight_computer__${t}`).join(',')],
    env: {},
    server: 'plugin:sleight:computer',
  },
  // Native Codex computer use, for the head-to-head (owner, 2026-10-08). See codex-arm.mjs.
  codex: {
    cwd: (() => { const dir = join(ARM_HOME, 'codex-arm'); mkdirSync(dir, { recursive: true }); return dir; })(),
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
      check: () => existsSync(join(dir, '.mcp.json')) || `no LCU registration in ${dir}`,
    };
  })(),
};
const armNames = armOption === 'all' ? ['sleight', 'lcu'] : armOption.split(',');
const guardedPass = armNames.some(name => /^(plugin|mcp):/.test(name));
const preparationErrors = [];
let codexCleanConfig;
for (const name of armNames.filter(name => /^(plugin|mcp):/.test(name))) {
  try {
    ARMS[name] = prepareGenericArm(name, { root: ROOT, armHome: ARM_HOME });
  } catch (error) {
    ARMS[name] = { generic: true, rejected: true, identity: { rejected: true } };
    preparationErrors.push({ arm: name, phase: 'configuration', passed: false, reason: error.message });
  }
}
for (const name of armNames) {
  if (!ARMS[name]) throw new Error(`unknown arm ${name}`);
  if (ARMS[name].rejected) continue;
  const arm = ARMS[name];
  if (guardedPass && !arm.codex) {
    arm.guarded = true;
    arm.servers ??= [arm.server];
    if (!arm.generic) {
      if (name === 'sleight') {
        // Strict mode suppresses plugin MCP registration; retain the same server identity.
        const mcp = join(arm.cwd, 'bench-mcp.json');
        writeFileSync(mcp, JSON.stringify({ mcpServers: { [arm.server]: { command: join(ROOT, 'plugins/sleight/bin/sleight-mcp') } } }), { mode: 0o600 });
        arm.args.push('--mcp-config', mcp);
      }
      arm.args.push('--strict-mcp-config', '--setting-sources', '', '--tools', '', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts', 'none');
    }
    arm.stopFile = join(arm.cwd, `approval-stop-${randomBytes(8).toString('hex')}`);
    arm.env.BENCH_ARM_SERVERS = JSON.stringify(arm.servers);
    arm.env.BENCH_APPROVAL_STOP = arm.stopFile;
    arm.settings = join(arm.cwd, 'bench-settings.json');
    writeFileSync(arm.settings, JSON.stringify(genericSettings(arm, ROOT)), { mode: 0o600 });
  }
  if (cleanArms && name === 'sleight' && !guardedPass) {
    // Clean arms keep the owner's user plugins, settings and MCP servers out of the CPU comparison:
    // strict MCP with only sleight's server, the mod still loaded through --plugin-dir.
    const mcp = join(arm.cwd, 'bench-mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { [arm.server]: { command: join(ROOT, 'plugins/sleight/bin/sleight-mcp') } } }), { mode: 0o600 });
    arm.args.push('--mcp-config', mcp, '--strict-mcp-config', '--setting-sources', '');
  }
  const ok = ARMS[name].check?.() ?? true;
  if (ok !== true) throw new Error(ok);
  if (cleanArms && arm.codex) {
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
const codexModel = option('codex-model', 'gpt-6.1-sol');
const codexEffort = option('codex-effort', effort);
const wanted = option('tasks', undefined)?.split(',');
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const selected = wanted ? suiteTasks.filter(t => wanted.includes(t.id)) : suiteTasks;
if (!selected.length) throw new Error(`no tasks match ${wanted}`);
if (wanted?.some(id => !suiteTasks.some(task => task.id === id))) throw new Error('unknown task in selected suite');
if (calculatorGate && (isDryRun || selected.some(task => task.id !== 'calculator-click'))) throw new Error('--calculator-gate requires a live calculator-click pass');
const privatePass = selected.some(task => task.privateMail);
if (privatePass && (selected.some(task => !task.privateMail) || armNames.some(name => name !== 'sleight'))) {
  throw new Error('Mimestream requires a separate sleight-only pass selected with --tasks');
}

// SLEIGHT_APPROVAL_PROMPT=client keeps approvals going to approve.mjs, even
// when the benchmark runs from a desktop app session.
// No claude.ai connectors: an arm loads only its own tool, and each connector listing is one more
// account request on the owner's login, which shares a rate limit with their usage meter (2026-10-10).
// Claude arms run on the owner's API key when ~/.config/sleight-bench/anthropic-api-key exists
// (--auth api|login|auto), up to a monthly cap (bench/api-auth.mjs).
const auth = !preparationErrors.length && armNames.some(name => !ARMS[name].codex)
  ? benchAuth({ mode: option('auth', 'auto'), capUsd: Number(process.env.SLEIGHT_BENCH_API_CAP_USD || DEFAULT_CAP_USD) })
  : { mode: 'login', env: {}, unset: [] };
if (auth.mode === 'api') console.log(`Claude arms run on the API key: $${auth.spent.toFixed(2)} of the $${auth.capUsd} monthly cap spent.`);
const armEnv = (arm, extra = {}) => {
  const env = { ...process.env, BENCH_ROOT: ROOT, SLEIGHT_APPROVAL_PROMPT: 'client',
    ...arm.env, ...extra, BENCH_SUITE: suite, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ...auth.env,
    ...(suite === 'real' ? { SLEIGHT_SURFACES: realSurfaces } : {}) };
  for (const key of auth.unset) delete env[key];
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
if (calculatorGate) await calculatorReady('preflight');
for (const name of armNames.filter(n => !ARMS[n].codex && !isSetupOnly)) {
  if (guardedPass && !isDryRun) assertNoHold();
  const arm = ARMS[name];
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
  return { onSpawn: pgid => { stop = startFootprint({ pgid, apps: apps.filter(Boolean) }); },
    finish: async () => { const used = await stop?.(); return used && { ...used, split: cpuSplit(used, { client }) }; } };
}

async function runClaude(prompt, arm, env = {}, { signal, evidenceDir, onPermissionRefusal, privateMail = false, onSpawn, fixtureLifecycle = false } = {}) {
  if (privateMail) assertPrivateClaudePolicy();
  const args = [
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
  const drive = (driverSignal, stop) => runDriver(claudeBin, args, { cwd: arm.cwd, env: armEnv(arm, env), timeoutMs: TIMEOUT_MS, onSpawn,
      signal: driverSignal,
      evidenceDir, privateMail, privatePolicyCheck: privateMail ? assertPrivateClaudePolicy : undefined,
      onPermissionRefusal: arm.guarded ? () => stop('unsupported approval: permission refused') : onPermissionRefusal,
      format: suite === 'real' || guardedPass || fixtureLifecycle ? 'stream-json' : 'json' });
  const response = arm.guarded ? await guardGenericOperation(drive, { signal: signal ?? controller.signal,
    stopFile: arm.stopFile, onStop: onPermissionRefusal }) : await drive(signal ?? controller.signal);
  const approvalStop = response.approvalStop ?? (arm.guarded && response.out?.permission_denials?.length
    ? 'unsupported approval: arm requested a non-elicitation permission' : undefined);
  return { ...response, ...(approvalStop && { approvalStop }) };
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
if (!isDryRun) for (const base of new Set([tmpdir(), realpathSync(tmpdir())])) archiveOldRuns(join(base, 'sleight-bench'), join(ARM_HOME, 'runs-archive'));
const results = [];
const liveConditions = [];
async function calculatorReady(stage) {
  try { liveConditions.push({ stage, ...await assertCalculatorReady({ signal: controller.signal }) }); }
  catch (error) { controller.abort(error); throw error; }
}
const realContexts = [], passCleanupErrors = [];
const resultsDir = join(ROOT, 'bench', 'results');
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${stamp}${isDryRun ? '-dry' : isSetupOnly ? '-setup' : ''}.json`);
// Written after every run, so a run cut short keeps what it finished.
const save = () => {
  if (privatePass) {
    if (!fullName) throw new Error('PRIVATE_MAIL_OWNER_AUDIT_UNAVAILABLE');
    const json = JSON.stringify({ results: results.map(publicPrivateMailRow) }, null, 2);
    publishPrivateMailResults(file, json, { ownerName: fullName,
      terms: realContexts.flatMap(ctx => ctx.privateTask.privateTerms(ctx)) });
    return;
  }
  const json = JSON.stringify({ stamp, ...(suite === 'real' ? { suite, surfaces: realSurfaces, ownerAway } : {}),
    ...(guardedPass && { fixturePolicy: 'retained app observers for every arm', ownerAway }),
    arms: armNames, armMetadata: Object.fromEntries(armNames.filter(name => ARMS[name].generic).map(name => [name, ARMS[name].identity])), model, effort, claude: claudeBin, auth: auth.mode,
    armSetup: cleanArms ? 'clean' : 'normal', ...(codexCleanConfig && { codexConfig: codexCleanConfig }), results,
    ...(calculatorGate && { liveConditions }), ...(passCleanupErrors.length && { passCleanupErrors }) }, null, 2);
  writeFileSync(file, scrub(json) + '\n');
};
// The runner owns the pass lock. Real tasks reuse it, so they cannot wait on
// themselves. This extends main's pass lock through driver collection.
let unlock, lockIdentity;
function finishRun(result) {
  if (isDryRun) return;
  if (auth.mode === 'api' && Number.isFinite(result.costUsd)) {
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
if (!controller.signal.aborted && !isDryRun) {
  save();
  console.error('Acquiring /tmp/sleight-live.lock.');
  unlock = await acquireLiveLock(undefined, { wait: !guardedPass, signal: controller.signal, interval: 2000 });
  lockIdentity = statSync('/tmp/sleight-live.lock');
  // Codex can't answer app prompts headless, so the engine's "Always allow" list holds exactly the
  // benchmark apps for the pass, then goes back to what it was (exit handler below).
  if (armNames.some(n => ARMS[n].codex)) {
    const backup = join(homedir(), 'Library', 'Logs', 'sleight', `ComputerUseAppApprovals.before-${stamp}.json`);
    mkdirSync(dirname(backup), { recursive: true });
    const apps = [...BENCH_APPS, ...(suite === 'real' ? REAL_APPS : [])];
    const restore = approveOnly(apps.filter(a => /^(com\.|net\.)/.test(a)), backup);
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
  results.push({ phase: 'preflight', passed: false, reason: scrub(error.message) });
  controller.abort(error); process.exitCode = 1; save();
}
// Arms alternate task by task, so both see the same conditions over time.
pass: for (let run = 1; run <= runs; run++) {
  for (const originalTask of selected) {
    const task = guardedPass && suite === 'default' ? genericTask(originalTask) : originalTask;
    for (const armName of armNames) {
      if (controller.signal.aborted) break pass;
      const nonce = randomBytes(4).toString('hex');
      const dir = join(suite === 'real' ? realpathSync(tmpdir()) : tmpdir(), 'sleight-bench', stamp, `${armName}-${task.id}-${run}`);
      mkdirSync(dir, { recursive: true });
      const ctx = { dir, nonce, ownerAway, ...(guardedPass && { stopOnAppDialog: true }) };
      if (suite === 'real' || task.fixtureLifecycle || guardedPass) {
        if (task.privateMail) assertPrivateClaudePolicy();
        if (task.privateMail) ctx.privateTask = task;
        realContexts.push(ctx);
        const evidenceDir = task.privateMail ? undefined : join(tmpdir(), 'sleight-real-evidence', stamp, `${armName}-${task.id}-${run}`);
        if (evidenceDir) mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
        let result;
        try { result = await executeRealTask(task, ctx, { dryRun: isDryRun, setupOnly: isSetupOnly, signal: controller.signal,
          lockHeld: !isDryRun,
          stop: () => controller.abort(new Error('macOS permission prompt')),
          permissionCheck: guardedPass ? guardedPermissionCheck : observePermission,
          drive: async (prompt, _ctx, callbacks) => {
            if (calculatorGate) await calculatorReady(armName);
            const cpu = footprint(task.privateMail ? [] : [ctx.sim?.app ?? task.app], ARMS[armName].codex ? 'codex' : 'claude');
            const stopWatching = guardedPass ? watchAppWindows(ctx.sim?.app ?? task.app) : undefined;
            if (ARMS[armName].codex) {
              const response = await runCodex(prompt, { cwd: ARMS[armName].cwd, model: codexModel, effort: codexEffort, timeoutMs: TIMEOUT_MS, signal: controller.signal, onSpawn: cpu.onSpawn });
              response.timing = runTiming(response.out);
              response.footprint = await cpu.finish();
              if (stopWatching) response.appWindows = await stopWatching();
              return response;
            }
            const response = await runClaude(prompt, ARMS[armName], !task.privateMail && armName === 'sleight' ? { SLEIGHT_TRACE: evidenceDir } : {},
              { signal: controller.signal, evidenceDir, ...callbacks, privateMail: task.privateMail,
                fixtureLifecycle: true, onSpawn: task.privateMail ? undefined : cpu.onSpawn });
            if (!task.privateMail) response.footprint = await cpu.finish();
            if (stopWatching) response.appWindows = await stopWatching();
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
        const { out, code, forbidden: _forbidden, ...rest } = result;
        results.push(task.privateMail ? privateMailResult(task, ctx, result, { arm: armName, run }) : { arm: armName, task: task.id, run, ...rest,
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
        console.error(`${recorded.passed ? 'PASS' : isDryRun ? 'DRY' : 'FAIL'} ${armName} ${task.id} #${run} ${recorded.seconds ?? 0}s${recorded.reason ? ` (${recorded.reason})` : ''}`);
        if (result.cleanupError || result.permissionPrompt || result.permissionRefusal || result.observerError || result.appDialog || result.groupClean === false) {
          console.error(task.privateMail ? 'STOP: private mail safety check failed.' : `STOP: ${scrub(result.cleanupError ?? result.reason ?? 'permission stop')}`);
          controller.abort(new Error('live safety stop'));
          process.exitCode = 1;
        }
        if (!result.passed && !isDryRun) process.exitCode = 1;
        continue;
      }
      // A setup this Mac can't do (no iOS runtime for the simulator task) skips
      // the run rather than ending the pass; skipped runs stay out of the table.
      try { await task.setup?.(ctx); } catch (err) {
        results.push({ arm: armName, task: task.id, run, skipped: true, reason: `setup: ${err.message}` });
        finishRun(results.at(-1));
        save();
        console.error(`SKIP ${armName} ${task.id} #${run} (setup: ${err.message})`);
        continue;
      }
      const prompt = task.prompt(ctx);

      if (isDryRun) {
        results.push({ arm: armName, task: task.id, run, prompt, dryRun: true, check: String(task.check({ ...ctx, answer: '' })),
          ...(ARMS[armName].generic && { command: [claudeBin, ...ARMS[armName].args, '--disallowedTools', OUTSIDE_TOOLS.join(','), '--settings', ARMS[armName].settings] }) });
        continue;
      }

      const started = Date.now();
      const stopWatching = watchAppWindows(ctx.sim?.app ?? task.app);
      // sleight traces into the run's scratch folder, so its timing comes from this run alone.
      const arm = ARMS[armName];
      const cpu = footprint([ctx.sim?.app ?? task.app], arm.codex ? 'codex' : 'claude');
      const codexRun = arm.codex ? await runCodex(prompt, { cwd: arm.cwd, model: codexModel, effort: codexEffort, timeoutMs: TIMEOUT_MS, signal: controller.signal, onSpawn: cpu.onSpawn }) : undefined;
      const { code, out, stderr, groupClean = true, cancelled } = codexRun ?? await runClaude(prompt, arm, armName === 'sleight' ? { SLEIGHT_TRACE: dir } : {}, { onSpawn: cpu.onSpawn });
      const cpuUsed = await cpu.finish();
      const appWindows = await stopWatching();
      const answer = out?.result ?? '';
      let verdict;
      try { verdict = groupClean ? task.check({ ...ctx, answer }) : 'Driver process group cleanup unconfirmed'; } catch (err) { verdict = err.message; }
      // A shell or file edit could pass a check without the app, so it fails the run.
      if (codexRun?.forbidden.length) verdict = `used ${[...new Set(codexRun.forbidden)].join(' and ')}`;
      if (groupClean) try { await task.cleanup?.(ctx); } catch {} // leaving an app open doesn't change the verdict
      else { controller.abort(new Error('Driver cleanup unconfirmed')); process.exitCode = 1; }
      results.push({
        arm: armName,
        task: task.id,
        run,
        passed: verdict === true,
        reason: verdict === true ? undefined : scrub(verdict),
        seconds: Math.round((Date.now() - started) / 100) / 10,
        turns: out?.num_turns,
        costUsd: runCost(out), reportedCostUsd: out?.total_cost_usd,
        // Input, cached and output tokens: what a smaller result would save.
        usage: out?.usage && { input: out.usage.input_tokens, cacheRead: out.usage.cache_read_input_tokens,
          cacheWrite: out.usage.cache_creation_input_tokens, output: out.usage.output_tokens },
        timing: runTiming(out, armName === 'sleight' ? traceTiming(dir) : undefined),
        footprint: cpuUsed,
        // Samples every 5 s of the app's windows: on the current Space, only off it, or none.
        appWindows,
        exitCode: code,
        groupClean, cancelled,
        answer: scrub(answer.slice(0, 300)),
        // What Claude Code reports it used, to catch a model setting that didn't apply.
        models: Object.keys(out?.modelUsage ?? {}),
        ...(codexRun && { toolCalls: codexRun.toolCalls, engineMs: codexRun.engineMs }),
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
    if (!isDryRun) for (const ctx of realContexts) for (const lease of ctx.windowLeases ?? []) {
      if (lease.running !== false || !lease.launched) continue;
      try { await lease.quit({ final: true }); }
      catch (error) {
        const message = privatePass ? 'PRIVATE_MAIL_CLEANUP_UNCONFIRMED' : scrub(error.message);
        if (!privatePass) passCleanupErrors.push({ app: lease.app, error: message });
        if (ctx.result) {
          ctx.result.passed = false;
          if (!privatePass) ctx.result.cleanupError = [...new Set([ctx.result.cleanupError, message].filter(Boolean))].join('; ');
        }
        console.error(`Pass cleanup failed: ${message}`); process.exitCode = 1;
      }
    }
    if (!isDryRun && unlock) for (const cleanup of [closeBenchTextEdit, quitChess, quitSimApp]) {
      try { await cleanup(suite === 'real' || cleanup === quitSimApp || armNames.some(name => ARMS[name].generic) ? { ownedOnly: true } : undefined); }
      catch (error) { console.error(privatePass ? 'Pass cleanup failed: PRIVATE_MAIL_CLEANUP_UNCONFIRMED' : `Pass cleanup failed: ${error.message}`); process.exitCode = 1; }
    }
    save();
  } finally { await unlock?.(); unlock = undefined; }
}
if (controller.signal.aborted && !process.exitCode) process.exitCode = 130;

if (!isDryRun && privatePass) {
  console.log('\n| Arm | Task | Run | Passed | Seconds | Turns | Expected hash | Actual hash |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const row of results) console.log(`| ${row.arm} | ${row.task} | ${row.run} | ${row.passed} | ${row.seconds} | ${row.turns ?? '–'} | ${row.expectedHash ?? '–'} | ${row.actualHash ?? '–'} |`);
}
if (!isDryRun && !privatePass) {
  console.log('\n| Arm | Task | Passed | Median s | Model s | Engine s | Local tools s | Relay ms | Median turns | CPU sleight s | CPU engine s | CPU client s | CPU other s | API-price cost |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : '–'; };
  for (const task of selected) {
    for (const armName of armNames) {
      const rs = results.filter(r => r.task === task.id && r.arm === armName && !r.skipped);
      const cost = rs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const ms = (key, scale) => { const m = median(rs.map(r => r.timing?.[key])); return m === '–' ? m : Math.round(m / scale * 10) / 10; };
      // Each arm's own CPU (footprint split): sleight's processes, the engine, the client, other
      // group processes. The driven app and the shared totals stay in the results file.
      const own = key => median(rs.map(r => r.footprint?.split?.[key]));
      console.log(`| ${armName} | ${task.id} | ${rs.filter(r => r.passed).length}/${rs.length} | ${median(rs.map(r => r.seconds))} | ${ms('modelMs', 1000)} | ${ms('engineMs', 1000)} | ${ms('localMs', 1000)} | ${ms('relayMs', 1)} | ${median(rs.map(r => r.turns))} | ${own('sleight')} | ${own('engine')} | ${own('client')} | ${own('other')} | $${cost.toFixed(2)} |`);
    }
  }
}
console.log(`\nresults: ${privatePass ? scrub(file) : file}`);
