import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realBrowserPlan, launchRealBrowser, resetRealBrowser, observeRealBrowser, checkBrowserOwner, browserVersion, profileSourceProblems, watchNavigations } from './real-browser.mjs';
import { REAL_SURFACES, realAgentSetup, withClaudeManifest } from './real-gate-setup.mjs';
import { benchmarkProfile } from '../world/arms/chrome.mjs';
import { executableProblem } from '../../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { runCodex, codexConfigServers, approveOnly } from '../codex-arm.mjs';
import { execFileSync } from 'node:child_process';
import { cuaDaemonPlan, ensureCuaDaemon, nativeArmPlan } from '../world/native-arms.mjs';
import { runOwned } from '../preapproved-process.mjs';
import { assertLogin } from '../preflight.mjs';
import { assertWorldCLI } from '../world/native-world.mjs';
import { startHostMonitor, gradeHostMonitor } from './host-monitor.mjs';
import { startGateForms } from './real-gate-sites.mjs';
import { startRoundAllow, allowPlan } from './chrome-allow.mjs';
import { watchCover, windowCover } from './window-cover.mjs';
import { guardBrowserGroup } from './group-cover.mjs';
import { gradeGateTask, browserEvidence, runErrorClass, harnessFailure, coverEvidence, coverText, withAnswerGraders, currentAnswerGraders } from './real-gate-grade.mjs';
import { taskSupport, raceBundles, isCodexSurface, isCodexSleightSurface, runsCodexExec, sleightKind, codexModelFor } from './support.mjs';
import { CODEX_SLEIGHT_HOME, ensureCodexSleightHome, writeCodexSleightConfig, approvalSummary, PROXY, SLEIGHT_MCP } from '../codex-sleight.mjs';
import { engineSpan, readEngine } from '../engine-version.mjs';
import { runDesktop as runCursorDesktop } from '../world/arms/cursor-cu/run.mjs';
import { DesktopDriver as CursorDesktopDriver } from '../world/arms/cursor-cu/desktop.mjs';
import { armPaths, assertDesktopReady as assertCursorDesktopReady } from '../world/arms/cursor-cu/contract.mjs';
import { inspectBundle as inspectCursorBundle, readLoginReadiness as cursorReadiness } from '../world/arms/cursor-cu/setup.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const runCursorPlan = (plan, options) => runCursorDesktop(plan, { driver: new CursorDesktopDriver(), ...options });
const codexHome = () => join(homedir(), '.codex-bench');
const defaultArmHome = () => join(homedir(), 'Library/Caches/sleight-bench');

// What a competitor arm needs from the Mac before its first task, as its native claim setup has it.
// Codex: headless Codex cancels the engine's app prompts, so the engine's own "Always allow" list holds the round's apps
// for the round and then goes back (bench/run.mjs does the same for the claim; first Firefox round, 2026-10-17: 12 of 12
// "Computer Use was not approved to use Firefox"). Cua: its daemon must listen before the MCP proxy starts.
export function roundArmPrep(plan, { armHome = defaultArmHome() } = {}) {
  if (isCodexSurface(plan.surface)) return { approvals: raceBundles(plan.browser.browser) };
  // sleight inside Codex: no engine list change at all. The proxy answers sleight's approval forms from the race's allowlist, so
  // the engine's Always allow list and sleight's preapproved.json stay as the owner has them. The step is the arm's Codex home.
  if (isCodexSleightSurface(plan.surface)) return { codexSleightHome: CODEX_SLEIGHT_HOME, approvalPath: 'proxy: race allowlist (origin-hook.mjs)' };
  if (plan.surface === 'cua') return { cuaDaemon: cuaDaemonPlan(nativeArmPlan('cua', { armHome }).cwd).start };
  if (plan.surface === 'peekaboo') return { host: 'Terminal.app (Peekaboo\'s grants)' };
  return {};
}
export async function prepareRoundArms(plan, { armHome = defaultArmHome(), approve = approveOnly, daemon = ensureCuaDaemon,
  logs = join(homedir(), 'Library/Logs/sleight'), codexHome = ensureCodexSleightHome } = {}) {
  const prep = roundArmPrep(plan, { armHome }), receipt = {}, undo = [];
  if (prep.codexSleightHome) {
    const home = codexHome({ home: prep.codexSleightHome });
    if (!home.ok) throw Error(home.problem);
    Object.assign(receipt, { codexSleightHome: home.home, setup: home.did, approvalPath: prep.approvalPath });
  }
  if (prep.approvals) {
    mkdirSync(logs, { recursive: true });
    const backup = join(logs, `ComputerUseAppApprovals.before-${plan.out.split('/').pop()}.json`);
    undo.push(approve(prep.approvals, backup));
    Object.assign(receipt, { approvals: prep.approvals, approvalsBackup: backup });
  }
  if (prep.cuaDaemon) {
    const started = await daemon(nativeArmPlan('cua', { armHome }).cwd);
    undo.push(started.stop);
    receipt.cuaDaemon = { started: started.started, socket: started.socket, ...(started.pids ? { pids: started.pids } : {}) };
  }
  return { receipt, release: async () => {
    for (const step of undo.reverse()) {
      try { await step(); }
      catch (error) { console.error(`Round arm cleanup failed (${error.message})${receipt.approvalsBackup ? `; restore the app approvals from ${receipt.approvalsBackup}` : ''}`); }
    }
  } };
}

// Peekaboo's Accessibility and Screen Recording grants are on Terminal.app (owner's pick), so macOS applies them only
// when the round's process tree starts in a Terminal window.
const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
export function terminalAncestor(pid = process.pid, ps = id => execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(id)], { encoding: 'utf8' })) {
  for (let hops = 0; pid > 1 && hops < 64; hops++) {
    let line;
    try { line = ps(pid).trim(); } catch { return false; }
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) return false;
    if (m[2] === TERMINAL) return true;
    pid = Number(m[1]);
  }
  return false;
}
export function realGatePlan({ args, tasks, repo = repoRoot, mcpRoot, armHome, round, realBrowser, dryRun = true }) {
  if (args.remote || args.gui || args.swap || args.serve || args['keep-tabs']) throw Error('real-browser gate owns its local window, browser order, sites and cleanup; omit remote/gui/swap/serve/keep-tabs');
  if (tasks.some(task => task.surface && task.surface !== args.surface)) throw Error('real-browser gate runs one surface per round');
  const surface = args.surface || (['firefox', 'safari'].includes(args['real-browser']) ? 'sleight' : 'sleight-turbo');
  if (!REAL_SURFACES.includes(surface)) throw Error(`real-browser surfaces: ${REAL_SURFACES.join(', ')}`);
  round ??= realBrowser?.marker?.slice('Sleight Gate '.length) ?? randomUUID();
  // Chrome's extension arms need the benchmark profile; every other arm can ask for it so all arms share one setup.
  const profile = args['real-profile'] ?? (['fowlbrowser', 'claude-in-chrome'].includes(surface) && args['real-browser'] === 'chrome' ? 'benchmark' : 'fresh');
  const browser = realBrowser ?? realBrowserPlan({ browser: args['real-browser'], round, profile, surface });
  const out = resolve(args.out || `/tmp/fb-rounds/real-${round}-${surface}`);
  const candidates = tasks.filter(task => !args.only || args.only.split(',').includes(task.name));
  if (!candidates.length) throw Error('No gate tasks selected');
  if (['firefox', 'safari'].includes(browser.browser) && surface === 'sleight-turbo') throw Error('Firefox/Safari have no turbo surface; use sleight');
  if (!['firefox', 'safari'].includes(browser.browser) && surface === 'sleight') throw Error('Chrome/Helium use sleight-turbo');
  const unsupported = candidates.flatMap(task => {
    const reason = task.takeover ? 'Takeover requires the separate user-takeover test protocol'
      : taskSupport(task, surface, { realBrowser: browser.browser });
    return reason ? [{ task, status: 'not-supported', reason }] : [];
  });
  const selected = candidates.filter(task => !unsupported.some(row => row.task === task));
  if (selected.some(task => !/^[a-zA-Z0-9_-]+$/.test(task.name) || !['chrome', 'helium', 'firefox', 'safari'].includes(task.browser))) throw Error('Invalid browser task');
  if (new Set(selected.map(task => task.name)).size !== selected.length) throw Error('Duplicate gate task names');
  const arms = selected.map(original => {
    const task = { ...original, browser: browser.browser };
    const dir = join(out, task.name);
    // After launch the pin is the device ID read from the round's own profile copy.
    const deviceFile = browser.claudeDeviceFile ?? args['chrome-device-file'];
    const chromeFiles = { ...(deviceFile ? { deviceFile } : {}),
      ...(args['chrome-local-state'] ? { localState: args['chrome-local-state'] } : {}) };
    const setup = realAgentSetup({ task, surface, dir, realBrowser: browser, repo, armHome, dryRun, mcpRoot, chromeFiles,
      model: args.model || 'haiku', effort: args.effort || 'high', allowBenchmarkAppPrompts: args['allow-benchmark-app-prompts'] === true });
    return { ...setup, args: runsCodexExec(surface) ? setup.args : [...setup.args, setup.prompt],
      task, surface, dir };
  });
  return { mode: 'real-browser', out, browser, arms, unsupported, mcpRoot, surface };
}

async function freePort(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
export async function startGateSites(mcpRoot) {
  for (const port of [5413, 5414, 5420, 5421]) await freePort(port);
  const shop = await import(pathToFileURL(join(mcpRoot, 'test/demo/server.mjs')));
  const a = await startGateForms(join(mcpRoot, 'test/forms'));
  let b;
  try { b = shop.startServer(); } catch (error) { await a.close(); throw error; }
  return { close: async () => { await Promise.all([a.close(), b.close()]); } };
}
const getJson = async url => {
  if (!url) return null;
  try { const res = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (!res.ok) throw Error(`HTTP ${res.status}`); return await res.json(); }
  catch (error) { return { error: error.message }; }
};

export async function runGateAgent(plan, { signal, runClaude = runOwned, runNativeCodex = runCodex, runCursor = runCursorPlan, guardChrome = withClaudeManifest } = {}) {
  mkdirSync(plan.dir, { mode: 0o700 });
  let result;
  const collect = async operation => {
    try { return await operation(); }
    catch (thrown) {
      const error = thrown instanceof Error ? thrown : Error(String(thrown), { cause: thrown });
      error.collectionError = true; throw error;
    }
  };
  const started = Date.now(), events = join(plan.dir, 'events.jsonl');
  writeFileSync(events, '');
  let groupClean;
  try {
    if (plan.surface === 'cursor-cu') {
      const out = await collect(() => runCursor(plan.cursorPlan, { signal,
        onEvent: event => appendFileSync(events, JSON.stringify(event) + '\n') }));
      groupClean = out.groupClean;
      result = { exitCode: out.is_error ? 1 : 0, result: out, groupClean, toolCalls: out.calls, toolErrors: null,
        qualificationOnly: true, timingBoundary: 'harness-submit to persisted clientSettleTime',
        ...(Number.isFinite(out.duration_ms) ? { started: out.submittedAt, finished: out.recordedEndAt } : {}) };
      writeFileSync(join(plan.dir, 'stderr.txt'), out.reason ?? '');
    } else if (runsCodexExec(plan.surface)) {
      // sleight's arms: this run's servers go into the arm's own Codex home first (a copy sits in the run's folder as evidence).
      if (plan.codexConfig) {
        writeCodexSleightConfig(plan.codexConfig.toml, plan.codexConfig.home, join(plan.dir, 'codex-config.toml'));
      }
      const run = await collect(() => runNativeCodex(plan.prompt, { cwd: plan.dir, model: codexModelFor(plan.surface), effort: 'high',
        home: plan.codexConfig?.home ?? codexHome(), signal, timeoutMs: (plan.task.budgetSeconds || 600) * 4000,
        onEvent: event => appendFileSync(events, JSON.stringify({ t: Date.now(), ...event }) + '\n') }));
      groupClean = run.groupClean;
      // A failed engine call (an app approval refused, a script error) is the Codex counterpart of a Claude tool error.
      const toolErrors = readFileSync(events, 'utf8').split('\n').filter(line => {
        try { const e = JSON.parse(line); return e.type === 'item.completed' && e.item?.type === 'mcp_tool_call' && e.item.status === 'failed'; }
        catch { return false; }
      }).length;
      result = { exitCode: run.code, result: run.out, timedOut: run.timedOut, groupClean: run.groupClean,
        forbidden: run.forbidden, toolCalls: run.toolCalls, toolErrors, engineMs: run.engineMs,
        // The model id Codex ran (its rollout's turn_context), beside the one the arm asked for.
        modelRequested: run.modelRequested, modelsRan: run.modelsRan,
        ...(plan.codexConfig ? { approvals: approvalSummary(join(plan.dir, 'approvals.jsonl')) } : {}) };
      if (run.forbidden.length) result.result = { ...run.out, is_error: true };
      writeFileSync(join(plan.dir, 'stderr.txt'), run.stderr);
    } else {
      writeFileSync(join(plan.dir, 'mcp.json'), JSON.stringify(plan.mcpConfig, null, 2), { mode: 0o600 });
      writeFileSync(join(plan.dir, 'settings.json'), JSON.stringify(plan.settingsOverrides, null, 2), { mode: 0o600 });
      const agent = () => runClaude(plan.command, plan.args, { cwd: plan.dir, env: plan.env, signal,
        timeoutMs: (plan.task.budgetSeconds || 600) * 4000 });
      const run = await collect(() => plan.surface === 'claude-in-chrome' ? guardChrome(plan, agent) : agent());
      groupClean = run.groupClean;
      writeFileSync(events, run.stdout); writeFileSync(join(plan.dir, 'stderr.txt'), run.stderr);
      const messages = run.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      result = { exitCode: run.exit.code, result: messages.findLast(event => event.type === 'result'),
        timedOut: run.timedOut, groupClean: run.groupClean,
        toolCalls: messages.reduce((count, event) => count + (event.message?.content || []).filter(item => item.type === 'tool_use').length, 0),
        toolErrors: messages.reduce((count, event) => count + (event.message?.content || []).filter(item => item.type === 'tool_result' && item.is_error).length, 0) };
    }
    // Graders require a successful browser call (and for lookups a visit), so an answer from memory fails.
    const evidence = browserEvidence(readFileSync(events, 'utf8'));
    const receipt = { started, finished: Date.now(), ...result, evidence, name: plan.task.name,
      ...(plan.surface === 'cursor-cu' && { outerStarted: started, outerFinished: Date.now() }), agentConfig: plan.metadata };
    writeFileSync(join(plan.dir, 'run.json'), JSON.stringify(receipt, null, 2));
    if (!groupClean) throw Object.assign(Error('BENCH_AGENT_CLEANUP_UNPROVED'), { groupClean: false });
    return receipt;
  } catch (error) {
    if (groupClean === false) error.groupClean = false;
    throw error;
  }
}

// The commits a round ran: the build whose plugin the arms load (repo), the bench code running the round (harness) and
// FowlBrowser's runner (mcpRoot). dirty counts modified tracked files, so a result can be traced to code that existed.
export function gitHead(dir) {
  try {
    const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const changed = git(['status', '--porcelain', '--untracked-files=no']);
    return { commit: git(['rev-parse', 'HEAD']), dirty: changed ? changed.split('\n').length : 0 };
  } catch (error) { return { commit: null, error: error.message.split('\n')[0] }; }
}
export function roundCommits({ repo, mcpRoot, harness = repoRoot, head = gitHead }) {
  return { build: { repo, ...head(repo) }, harness: { repo: harness, ...head(harness) }, ...(mcpRoot ? { fowlbrowser: { repo: mcpRoot, ...head(mcpRoot) } } : {}) };
}

// Writes harness-failure.json when one error class failed 10 or more of the round's 12 tasks; scorers drop the round.
// The report's cell for a task's start: the covering apps with the share of the browser window each covers.
export function coverCell(cover) {
  if (!cover) return 'not measured';
  if (cover.error) return `unread (${cover.error})`;
  if (!cover.covering.length) return 'none';
  const share = new Map();
  for (const { owner, fraction } of cover.covering) share.set(owner, Math.max(share.get(owner) ?? 0, fraction));
  return [...share].map(([owner, fraction]) => `${owner} ${Math.round(fraction * 100)}%`).join(', ');
}

// The report's engine line: one version, or both reads when the engine changed during the round, and the round's UTC times.
export function engineLine(span) {
  if (!span) return 'Engine: not recorded.';
  const app = read => (read?.chatgptApp ? ` (ChatGPT ${read.chatgptApp}${read.chatgptBuild ? `, build ${read.chatgptBuild}` : ''})` : '');
  const when = ` Round from ${span.startedAt ?? 'unknown'} to ${span.endedAt ?? 'unknown'} UTC.`;
  if (span.changed) return `Engine: ${span.start.version ?? 'unknown'}${app(span.start)} at the start and ${span.end.version ?? 'unknown'}${app(span.end)} at the end (changed during the round).${when}`;
  return `Engine: ${span.start.version ?? `unknown (${span.start.error ?? 'no read'})`}${app(span.start)}.${when}`;
}

export function markHarnessFailure(out, rows, total) {
  const verdict = harnessFailure(rows.map(row => ({ task: row.task.name, ok: row.outcome?.ok === true, errorClass: row.errorClass })), total);
  if (verdict) writeFileSync(join(out, 'harness-failure.json'), JSON.stringify({ ...verdict, decided: 'automatic', at: new Date().toISOString() }, null, 2));
  return verdict;
}

// What would stop a live round before it starts, read without launching anything.
export function gatePreflight(plan, { executable = executableProblem } = {}) {
  const problems = profileSourceProblems(plan.browser);
  // The product refuses a browser binary others can write unless it is a signed browser whose signature checks
  // (executable-trust.mjs). Before that relaxation a turbo round on this Mac's mode-775 Chrome answered from memory
  // (live smoke 2026-10-17: every call "Turbo bench unavailable").
  const reason = sleightKind(plan.surface, plan.browser.browser) === 'sleight-turbo' && executable(plan.browser.executable);
  if (reason) problems.push(`Turbo refuses ${plan.browser.executable} (${reason}); the owner can run: chmod go-w "${plan.browser.executable}"`);
  return problems;
}

export async function admitRealGate(plan, { terminal = terminalAncestor } = {}) {
  if (existsSync('/Library/Application Support/ClaudeCode/CLAUDE.md')) throw Error('Managed Claude policy cannot be excluded');
  if (existsSync(plan.out)) throw Error('Gate output already exists');
  const problems = gatePreflight(plan);
  if (problems.length) throw Error(problems.join('; '));
  const setups = plan.arms;
  if (plan.surface === 'peekaboo' && !terminal()) throw Error('Peekaboo\'s grants are on Terminal.app, so its rounds run from a Terminal window: ' +
    'put the rounds.sh command in a .command file and run: open -a Terminal <file>.command');
  if (plan.surface === 'cursor-cu') {
    assertCursorDesktopReady();
    inspectCursorBundle(armPaths().app);
    if (!(await cursorReadiness()).authStored) throw Error('Cursor desktop needs login in its isolated profile; run node bench/world/arms/cursor-cu/setup.mjs');
  } else if (isCodexSurface(plan.surface)) {
    if (codexConfigServers(codexHome()).length !== 1 || !existsSync(join(codexHome(), 'auth.json'))) throw Error('Codex benchmark home needs its isolated engine server and login');
  } else if (isCodexSleightSurface(plan.surface)) {
    // The arm's Codex home holds sleight's servers alone (never the engine's own computer-use server), and its login is the
    // codex arm's. The home itself is created by the round's arm prep (or `node bench/codex-sleight.mjs setup`).
    const allowed = ['plugin_sleight_computer', 'sleight-turbo'];
    for (const setup of setups) if (!setup.codexConfig || !setup.codexConfig.servers.includes('plugin_sleight_computer') ||
        setup.codexConfig.servers.some(name => !allowed.includes(name))) throw Error('sleight-in-Codex arms may configure only sleight\'s servers');
    if (!existsSync(PROXY) || setups.some(setup => !existsSync(setup.codexConfig.sleightMcp ?? SLEIGHT_MCP))) throw Error('sleight-in-Codex arms need the approval proxy and the race build\'s sleight-mcp');
    if (!existsSync(join(CODEX_SLEIGHT_HOME, 'auth.json')) && !existsSync(join(codexHome(), 'auth.json'))) throw Error(`no Codex login to use: run CODEX_HOME=${CODEX_SLEIGHT_HOME} codex login`);
  } else {
    assertWorldCLI(setups[0].command);
    assertLogin({ command: setups[0].command, env: setups[0].env });
  }
}

// Dry planning happens before admission, locks, sites, observers, helpers or browsers.
// Runtime injection is only for offline lifecycle tests, never CLI/environment input.
export async function runRealGate({ args, repo = repoRoot, mcpRoot, runner, tasks,
  runtime = {} }) {
  // The answer patterns come from sleight's task file (real-gate-grade.mjs ANSWER_GRADER_FILE); each row saves the task it ran with.
  if (!tasks) {
    const graders = currentAnswerGraders();
    tasks = JSON.parse(readFileSync(resolve(mcpRoot, args.tasks || 'tools/agents/codex-h2h.json'), 'utf8')).map(task => withAnswerGraders(task, graders));
  }
  let plan = realGatePlan({ args, tasks, repo, mcpRoot });
  if (args['dry-run']) {
    // Read-only previews of what launch records: the app version and the benchmark profile's folder.
    let profileFolder;
    if (plan.browser.profileMode === 'benchmark-copy') {
      try { profileFolder = benchmarkProfile(join(plan.browser.profileSource.userDataDir, 'Local State')); } catch (error) { profileFolder = { error: error.message }; }
    }
    const printable = { ...plan, engine: (runtime.readEngine || readEngine)(), armPrep: roundArmPrep(plan, { armHome: runtime.armHome }), allowWatcher: allowPlan(plan), browser: { ...plan.browser, version: (runtime.readVersion || browserVersion)(plan.browser.executable) ?? plan.browser.version ?? null,
      ...(profileFolder ? { profileFolder } : {}), preflight: (runtime.preflight || gatePreflight)(plan) },
      arms: plan.arms.map(({ env, ...arm }) => ({ ...arm,
      environment: { ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}),
        ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
        ...Object.fromEntries(['SLEIGHT_TURBO', 'FOWL_GATE_WINDOW', 'BENCH_SUITE', 'BENCH_RACE_APPS'].filter(key => env[key] !== undefined).map(key => [key, env[key]])) } })) };
    (runtime.print || console.log)(JSON.stringify(printable, null, 2)); return printable;
  }
  if (!plan.arms.length) throw Error('No runnable gate tasks: ' + plan.unsupported.map(row => row.reason).join('; '));
  // The live copy always reads Chrome's own profile list, so a substitute list would pin a different folder.
  if (args['chrome-local-state']) throw Error('--chrome-local-state is for dry runs only');
  await (runtime.admit || admitRealGate)(plan);
  const lockPath = runtime.lockPath || '/tmp/sleight-live.lock';
  if (existsSync('/tmp/sleight-hold')) throw Error('Benchmark hold is active');
  mkdirSync(lockPath);
  const controller = new AbortController(), abort = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, abort);
  let browser, sites, monitor, armPrep, allow, cleanupProven = true, engineStart, engine;
  const rows = [];
  try {
    mkdirSync(plan.out, { recursive: true, mode: 0o700 });
    writeFileSync(join(plan.out, 'commits.json'), JSON.stringify((runtime.commits || roundCommits)({ repo, mcpRoot }), null, 2));
    // The ChatGPT engine version, read again at the end: every published result names it (LAWS, owner 2026-10-19).
    engineStart = (runtime.readEngine || readEngine)();
    writeFileSync(join(plan.out, 'engine.json'), JSON.stringify(engineSpan(engineStart), null, 2));
    // Resolve pinned native receipts before the first browser launch.
    realGatePlan({ args, tasks, repo, mcpRoot, realBrowser: plan.browser, dryRun: false });
    // An offline test that injects admission never touches the Mac's approvals or daemons unless it injects prep too.
    armPrep = await (runtime.prepareArms || (runtime.admit ? async () => ({ receipt: {}, release: async () => {} }) : prepareRoundArms))(plan);
    writeFileSync(join(plan.out, 'arm-prep.json'), JSON.stringify(armPrep.receipt, null, 2));
    sites = await (runtime.startSites || startGateSites)(mcpRoot);
    browser = await (runtime.launchBrowser || launchRealBrowser)(plan.browser).catch(error => {
      if (error.message === 'BENCH_BROWSER_CLEANUP_UNPROVED') cleanupProven = false;
      if (error.browserReceipt || error.ownerCheck) writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(error.browserReceipt || { ...plan.browser, ownerCheck: error.ownerCheck }, null, 2));
      throw error;
    });
    const identity = () => { const { stop, reset, observe, ...value } = browser; return value; };
    plan = realGatePlan({ args, tasks, repo, mcpRoot, realBrowser: identity(), dryRun: false });
    writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
    writeFileSync(join(plan.out, 'unsupported.json'), JSON.stringify(plan.unsupported, null, 2));
    if (sleightKind(plan.surface, plan.browser.browser) === 'sleight-turbo') { monitor = await (runtime.startMonitor || startHostMonitor)(join(plan.out, 'monitor.jsonl')); await monitor.ready?.(); }
    // Claude in Chrome rounds only: press Allow on the extension's own permission prompt for the round's sites (LAWS, 2026-10-18).
    // It returns null for every other surface and browser, and approvals.jsonl in the round's folder records each decision.
    allow = await (runtime.startAllow || startRoundAllow)(plan, browser);
    // Claude in Chrome reaches Anthropic's browser bridge about 6 s after launch (smoke 2026-10-17: launch 20:17:53,
    // connected 20:17:59). Starting sooner costs the first task a failed select_browser that other arms never pay.
    if (plan.surface === 'claude-in-chrome') await (runtime.settle || (ms => new Promise(resolve => setTimeout(resolve, ms))))(10000);
    let coverLogged = 0;
    const coverWaits = new Map();
    for (let arm of plan.arms) {
      if (controller.signal.aborted) throw Error('Gate interrupted');
      const census = async () => {
        const ownerCheck = await (runtime.checkOwner || checkBrowserOwner)(browser, { ownedPid: browser.pid }).catch(error => {
          if (error.ownerCheck) {
            browser.ownerCheck = error.ownerCheck;
            writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
          }
          throw error;
        });
        browser.ownerCheck = ownerCheck;
        writeFileSync(join(plan.out, 'browser.json'), JSON.stringify({ ...identity(), ownerCheck }, null, 2));
      };
      if (browser.browser !== 'firefox') await census();
      const start = await (runtime.resetBrowser || resetRealBrowser)(browser).catch(error => {
        if (error.ownerCheck) browser.ownerCheck = error.ownerCheck;
        writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
        throw error;
      });
      if (browser.browser === 'firefox') await census();
      const startKeys = new Set(Object.keys(start));
      // Firefox and Safari launch a browser per task, so each task's prompt names that task's browser PID.
      if (['firefox', 'safari'].includes(browser.browser)) {
        arm = realGatePlan({ args, tasks: [arm.task], repo, mcpRoot, realBrowser: identity(), dryRun: false }).arms[0];
        writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
      }
      if (controller.signal.aborted) throw Error('Gate interrupted');
      // The browser's own window goes where the fewest other windows overlap it, and what still covers it is recorded beside the
      // task's outcome. An offline test that injects the browser never reads or moves the Mac's windows.
      const readCover = runtime.windowCover || (runtime.launchBrowser ? async () => null : windowCover);
      await readCover(browser.pid, { place: true });
      // Check the actual owned browser frame before any agent starts. Safari and Firefox relaunch on reset,
      // so every task checks again. Only proven Finder fixture covers may close; each owner cover gets three minutes per round.
      await (runtime.guardBrowserGroup || (runtime.launchBrowser ? async () => {} : guardBrowserGroup))(browser.pid, {
        signal: controller.signal,
        coverWaits,
        log: event => appendFileSync(join(plan.out, 'group-cover.jsonl'), JSON.stringify(event) + '\n'),
      });
      const cover = await readCover(browser.pid, {});
      // Windows can come over it while the agent runs, so the cover is read again every 5 s and at the end (read only).
      const coverWatch = (runtime.watchCover || (runtime.launchBrowser ? null : watchCover))?.(browser.pid) ?? null;
      // Chrome and Helium report every page URL while the agent runs; the lookup graders need that visit.
      let watch = null, navigation, coverRun = null;
      if (!['firefox', 'safari'].includes(browser.browser)) {
        try { watch = await (runtime.watchBrowser || watchNavigations)(browser); }
        catch (error) { navigation = { observed: false, reason: error.message }; }
      }
      const run = await (runtime.runAgent || runGateAgent)(arm, { signal: controller.signal }).catch(error => {
        if (error.groupClean === false || error.collectionError) cleanupProven = false;
        throw error;
      }).finally(async () => {
        coverRun = await coverWatch?.stop().catch(error => ({ error: error.message })) ?? null;
        if (!watch) return;
        navigation = { observed: true, urls: watch.urls() };
        await watch.close().catch(() => {});
      });
      if (!run.groupClean) { cleanupProven = false; throw Error('BENCH_AGENT_CLEANUP_UNPROVED'); }
      const snapshot = await (runtime.observeBrowser || observeRealBrowser)(browser);
      const observation = ['firefox', 'safari'].includes(browser.browser) ? snapshot : { observed: true, tabs: snapshot };
      const after = observation.tabs;
      if (browser.browser === 'firefox') {
        // Positions can move or be reused; the first history entry identifies the start tab.
        startKeys.clear();
        for (const [key, tab] of Object.entries(after)) if (tab.initialUrl === browser.args.at(-1) || tab.url === browser.args.at(-1)) startKeys.add(key);
        if (observation.ownerCheck) browser.ownerCheck = observation.ownerCheck;
        writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
      }
      run.afterExit = after;
      run.tabs = new Set(Object.keys(after));
      const grade = await getJson(arm.task.grade);
      const site = await getJson(arm.task.name === 'form-checkout' ? 'http://127.0.0.1:5413/gate-log/p04' : arm.task.site?.log);
      const evidence = run.evidence;
      // A failed navigation log on Chrome or Helium proves no visit; only Firefox and Safari fall back to tool text.
      const visits = navigation ? (navigation.observed ? navigation.urls : []) : null;
      const outcome = gradeGateTask({ task: arm.task, run, grade, site, runner, after, startKeys,
        observed: observation.observed, observationReason: observation.reason, ownerCheck: observation.ownerCheck, evidence, visits });
      const text = name => { try { return readFileSync(join(arm.dir, name), 'utf8'); } catch { return ''; } };
      const errorClass = outcome.ok ? null : runErrorClass({ eventsText: text('events.jsonl'), stderr: text('stderr.txt') });
      // Cover evidence on every row, pass or fail; race-score --exclude-covered decides over all rounds which rows to leave out.
      const covered = coverEvidence({ eventsText: text('events.jsonl'), readings: [cover, coverRun] });
      // The first watched tasks name every window owner the watch saw, overlays included, so a new overlay owner shows up early.
      if (coverRun?.seen?.length && coverLogged++ < 3) console.error(`cover watch ${arm.task.name}: ${coverRun.seen.map(w =>
        `${w.owner} ${Math.round(w.fraction * 100)}% layer ${w.layer ?? '?'}${w.counted ? '' : ' (overlay, not counted)'}`).join('; ')}`);
      const row = { task: arm.task, surface: arm.surface, status: 'ran', wallMs: run.finished - run.started, toolCalls: run.toolCalls, toolErrors: run.toolErrors,
        successfulBrowserCalls: evidence?.successfulCalls ?? null, run: { ...run, tabs: [...run.tabs] }, start, observation, navigation: navigation ?? null,
        agentConfig: arm.metadata, grade, site, outcome, errorClass, cover, coverRun, ...(covered ? { coverEvidence: covered } : {}) };
      rows.push(row);
      writeFileSync(join(arm.dir, 'run.json'), JSON.stringify(row, null, 2));
      writeFileSync(join(plan.out, 'results.json'), JSON.stringify(rows, null, 2));
    }
  } catch (error) {
    if (existsSync(plan.out)) {
      writeFileSync(join(plan.out, 'failure.json'), JSON.stringify({ error: error.message, completed: rows.length }));
      markHarnessFailure(plan.out, rows, plan.arms.length);
    }
    throw error;
  } finally {
    try { await allow?.stop(); } catch (error) { console.error(`Claude in Chrome prompt watcher did not stop cleanly (${error.message})`); }
    await armPrep?.release();
    try { await monitor?.stop(); } catch { cleanupProven = false; }
    try { await sites?.close(); } catch { cleanupProven = false; }
    // A leaked agent may still drive this window. Retain both profile and lock.
    if (cleanupProven) try {
      if (browser) {
        try { writeFileSync(join(plan.out, 'cleanup.json'), JSON.stringify(await browser.stop())); }
        finally {
          const { stop, reset, observe, ...receipt } = browser;
          writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(receipt, null, 2));
        }
      }
    }
    catch { cleanupProven = false; }
    if (engineStart) try {
      engine = engineSpan(engineStart, (runtime.readEngine || readEngine)());
      writeFileSync(join(plan.out, 'engine.json'), JSON.stringify(engine, null, 2));
    } catch (error) { console.error(`Engine version at the end not recorded (${error.message})`); }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, abort);
    if (cleanupProven) rmdirSync(lockPath);
    else console.error(`Cleanup unproved; retained ${lockPath} and ${plan.browser.profileRoot}`);
  }
  for (const row of rows) row.focusGrade = sleightKind(row.surface, row.task.browser) === 'sleight-turbo' ? gradeHostMonitor(monitor?.log || [], row.run, rows.map(row => row.run))
    : { ok: null, cell: 'not measured', events: [], problems: [] };
  writeFileSync(join(plan.out, 'results.json'), JSON.stringify(rows, null, 2));
  const harness = markHarnessFailure(plan.out, rows, plan.arms.length);
  const used = browser ? (({ stop, reset, observe, ...value }) => value)(browser) : plan.browser;
  const profileText = used.profileMode === 'benchmark-copy' ? `a copy of Chrome's "sleight benchmark" (${used.profileFolder ?? 'folder unknown'})`
    : `fresh at ${used.profileRoot}`;
  const lines = [`Browser: ${used.browser} ${used.version ?? '(version unknown)'}, profile ${profileText}` +
    `${used.loadedExtensions?.length ? `, loaded ${used.loadedExtensions.join(', ')}` : ''}.`, engineLine(engine), '',
    '| task | arm | outcome | focus | covered by | ms | calls | errors |', '|---|---|---|---|---|---:|---:|---:|',
    ...rows.map(row => `| ${row.task.name} | ${row.surface} | ${row.outcome.cell} | ${row.focusGrade.cell} | ${coverCell(row.cover)}${row.coverRun?.covering?.length ? `; during: ${coverCell(row.coverRun)}` : ''} | ${row.wallMs} | ${row.toolCalls ?? 'unknown'} | ${row.toolErrors ?? 'unknown'} |`),
    ...(harness ? ['', `Harness failure, excluded from scoring: ${harness.reason}.`] : []),
    ...(rows.some(row => row.coverEvidence) ? ['', ...rows.filter(row => row.coverEvidence).map(row => `Cover evidence: ${row.task.name} ${row.outcome.ok ? 'passed' : 'failed'}, ${coverText(row.coverEvidence)}. Scored as run; \`race-score.mjs --exclude-covered\` decides whether it is left out.`)] : [])];
  writeFileSync(join(plan.out, 'report.md'), lines.join('\n') + '\n');
  if (harness) console.error(`Harness failure: ${harness.reason}; rerun this round`);
  if (!cleanupProven || rows.some(row => !row.outcome.ok || row.focusGrade.ok === false)) process.exitCode = 1;
  return rows;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const values = process.argv.slice(2), args = {};
  for (let i = 0; i < values.length; i++) {
    const key = values[i].slice(2);
    args[key] = ['dry-run', 'world'].includes(key) ? true : values[++i];
  }
  if (!args['dry-run']) throw Error('Use bench/fowl/rounds.sh for live rounds');
  await runRealGate({ args, mcpRoot: join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser') });
}
