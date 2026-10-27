// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { BENCH_APPS, REAL_APPS, getTasks } from '../bench/tasks.mjs';
import { selectSuiteTasks, assertShopSmokeRuns } from '../bench/shop.mjs';
import { privateMailResult, publicPrivateMailRow, publicPrivateMailRows } from '../bench/private-mail.mjs';
import { privateDriverEnvironment } from '../bench/driver.mjs';
import { guardGenericOperation } from '../bench/generic-approval.mjs';
import { genericSettings } from '../bench/plugin-arm.mjs';
import { sleightPluginLaunch } from '../bench/sleight-plugin-launch.mjs';
import { cpuSplit } from '../bench/footprint.mjs';
import { webBrowsers } from '../bench/tasks-web.mjs';
import { WORLD_APPS, worldPassApps } from '../bench/world/tasks.mjs';
import { isNativeArm, nativeArmPlan } from '../bench/world/native-arms.mjs';
import { worldCLI, worldArm, worldSettings, assertWorldCLI } from '../bench/world/native-world.mjs';
import { LOGIN_ARMS, loginTarget } from '../bench/world/login-readiness.mjs';
import { packageSkip } from './requirements.mjs';
import { cleanupContained as realCleanupContained, releaseFixtureLock } from '../bench/real-run.mjs';
import { mergeArmHooks as realMergeArmHooks } from '../bench/arm-hooks.mjs';
import { codexSleightRunConfig, assertOnlyServers } from '../bench/codex-sleight.mjs';
import { codexExecPlan } from '../bench/codex-arm.mjs';
import { engineSpan } from '../bench/engine-version.mjs';
import { benchHand } from '../bench/hand/bench-hand.mjs';
import { evidenceRoots } from '../bench/evidence.mjs';
const parserSkip = packageSkip('typescript');
const { dragMethodAudit } = parserSkip ? {} : await import('../bench/world/method-check.mjs');

test('native driver and image retention use the durable benchmark evidence home', async () => {
  const armHome = join(tmpdir(), 'bench-durable-home');
  const result = await runner({ suite: 'world', arm: 'sleight', drive: true, base: { BENCH_ARM_HOME: armHome }, extraArgs: ['--owner-away'] });
  assert.equal(result.error, undefined);
  assert.equal(result.driverOptions.length, 3);
  for (const options of result.driverOptions) assert.ok(options.evidenceDir.startsWith(join(armHome, 'evidence') + '/'), options.evidenceDir);
  const retention = result.calls.find(call => call[0] === 'image retention')[1];
  assert.ok(retention.roots.includes(join(armHome, 'evidence')));
  assert.ok(retention.roots.includes(join(armHome, 'runs-archive')));
  assert.ok(retention.roots.some(root => root.endsWith('/sleight-real-evidence')));
});

test('Mail-to-sheet footprint and window watching cover both apps for Claude and Codex', async () => {
  const task = getTasks('world').find(task => task.id === 'mail-to-sheet');
  for (const arm of ['sleight', 'codex']) {
    const result = await runner({ suite: 'world', arm, tasks: [task], drive: true, extraArgs: ['--owner-present', '--tasks', 'mail-to-sheet'] });
    assert.equal(result.error, undefined);
    const footprints = result.calls.filter(call => call[0] === 'footprint apps');
    assert.equal(footprints.length, 3);
    for (const call of footprints) assert.deepEqual(Array.from(call[1]), ['Numbers', 'Mail']);
    assert.equal(result.calls.filter(call => call[0] === 'watch app' && call[1] === 'Mail').length, 3);
    const row = result.saved.at(-1).results[0];
    assert.equal(row.appWindowsByApp.Mail.offScreenOnly, 1);
    assert.equal(row.appWindowsByApp.Numbers.onScreen, 1);
    assert.deepEqual(row.appWindows, row.appWindowsByApp.Numbers);
  }
});

test('owner presence cannot admit ordinary world tasks or a mixed world pass', async () => {
  for (const tasks of [[{ id: 'ordinary', app: 'Preview' }],
    [getTasks('world').find(task => task.id === 'mail-to-sheet'), { id: 'ordinary', app: 'Preview' }]]) {
    const result = await runner({ suite: 'world', tasks, extraArgs: ['--owner-present', '--tasks', tasks.map(task => task.id).join(',')] });
    assert.match(result.error?.message ?? '', /world live fixtures require --owner-away/);
    assert.equal(result.calls.includes('lock'), false);
    assert.equal(result.commands.length, 0);
    assert.equal(result.directories.length, 0);
    assert.equal(result.saved.length, 0);
  }
});

test('the full world dry run prints one complete JSON document for every arm', async () => {
  const arms = ['sleight', 'lcu', 'cua', 'peekaboo', 'claude-cu', 'codex'];
  const result = await runner({ suite: 'world', arm: arms.join(','), dryRun: true,
    tasks: [{ id: 'first' }, { id: 'second' }] });
  assert.equal(result.error, undefined);
  const documents = result.logs.filter(text => typeof text === 'string' && text.startsWith('{'));
  assert.equal(documents.length, 1, 'dry runs must print the final plan once, not every growing prefix');
  const plan = JSON.parse(documents[0]);
  assert.deepEqual(Array.from(plan.arms), arms);
  assert.equal(plan.results.length, 36);
  assert.equal(result.commands.length, 0);
  assert.equal(result.directories.length, 0);
  assert.equal(result.saved.length, 0);
});

test('world engine approvals include selected org bundles and omit unselected browsers', async () => {
  for (const allowedApps of [['Firefox', 'org.mozilla.firefox'], ['Calculator', 'com.apple.calculator']]) {
    const tasks = [{ id: 'selected-fixture', app: allowedApps[0], allowedApps }];
    const result = await runner({ suite: 'world', arm: 'codex', tasks, extraArgs: ['--owner-away', '--real-profile', 'fresh'] });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.calls.find(call => Array.isArray(call) && call[0] === 'approve'), ['approve', allowedApps[1]]);
  }
});

test('profile selection refuses a held-out browser pass before engine approvals or fixtures', async () => {
  const tasks = [{ id: 'cc-list-firefox', app: 'Firefox', allowedApps: ['Firefox', 'org.mozilla.firefox'], requiredProfile: 'fresh' }];
  for (const profile of [[], ['--real-profile', 'default']]) {
    const result = await runner({ suite: 'world', arm: 'codex', tasks, extraArgs: ['--owner-away', ...profile] });
    assert.match(result.error?.message ?? '', /CC_ISOLATED_PROFILE_REQUIRED/);
    assert.ok(!result.calls.includes('lock'));
    assert.ok(!result.calls.includes('real run'));
    assert.ok(!result.calls.some(call => Array.isArray(call) && call[0] === 'approve'));
  }
});

test('world selection reaches Claude hooks and the Codex sleight proxy', async () => {
  const tasks = [{ id: 'cc-calendar-safari', app: 'Safari', allowedApps: ['Safari', 'com.apple.Safari'] }];
  const claude = await runner({ suite: 'world', arm: 'sleight', tasks, drive: true, extraArgs: ['--owner-away'] });
  assert.equal(claude.error, undefined);
  assert.ok(claude.envs.length > 0);
  assert.ok(claude.envs.every(env => env.BENCH_WORLD_TASKS === '["cc-calendar-safari"]'));
  const codex = await runner({ suite: 'world', arm: 'codex-sleight', tasks, extraArgs: ['--owner-away'] });
  assert.equal(codex.error, undefined);
  assert.ok(codex.codexConfigs.length > 0);
  assert.ok(codex.codexConfigs.every(toml => toml.includes('BENCH_WORLD_TASKS = "[\\"cc-calendar-safari\\"]"')));
});

test('a refused dry run prints one JSON document with its configuration errors', async () => {
  const result = await runner({ suite: 'world', arm: 'mcp:rival', dryRun: true, preparationError: 'fixture refusal' });
  assert.equal(result.exitCode, 1);
  const documents = result.logs.filter(text => typeof text === 'string' && text.startsWith('{'));
  assert.equal(documents.length, 1);
  assert.equal(JSON.parse(documents[0]).results[0].reason, 'fixture refusal');
});

// Execute the actual runner body with inert dependencies. Runner filesystem and
// process operations stay fake; the harness owns only its temporary path bank.
async function runner({ hygieneResult = { leftWindows: [], errors: [] }, hygieneError, hygieneReceiptsOnly = false, hygieneBoundaryError, hygieneTracking, extraArgs = [], suite = 'real', arm = 'sleight', outcome = {}, taps = [], throws = false, base = {}, drive = false, leases = [], fixtureStates = [], unlockError, setupOnly = false, privateMail = false, fixtureLifecycle = false, ownerName = '', auth, keySource = 'none', spend = () => 0, holdAfterPreflight = false, dryRun = false, preparationError, extraServer, driverOut = {}, calculatorGate = false, calculatorFailureAt, cleanArms = false, footprint = { cpuSeconds: 0, group: {}, outside: {} }, codexServers, tasks, worldVersion = '2.1.289', loginError, socketError, daemonError, daemonStopError, declinedPrompts = [], sleightHomeServers = ['plugin_sleight_computer'], codexResult = {}, engineReads = ['26.1013.40934'] } = {}) {
  if (!auth) {
    auth = { mode: suite === 'world' ? 'api' : 'login', env: {}, unset: [], spent: 0, capUsd: 200 };
    if (suite === 'world') keySource = 'ANTHROPIC_API_KEY';
  }
  const calls = [], saved = [], envs = [], tailScopes = [], directories = [], hubRefreshes = [];
  const logs = [], driverOptions = [], codexRuns = [], files = new Map(), commands = [], codexConfigs = [], contexts = [];
  const temp = mkdtempSync(join(tmpdir(), 'bench-run-test-'));
  const lockPath = join(temp, 'live.lock'), holdPath = join(temp, 'sleight-hold');
  let preflightDone = false, calculatorObservations = 0, engineReadCount = 0;
  const source = readFileSync(new URL('../bench/run.mjs', import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', '"file:///fixture/bench/run.mjs"')
    // Give the pass and each lifecycle context an isolated path before execution.
    .replaceAll('/tmp/sleight-live.lock', lockPath).replaceAll('/tmp/sleight-hold', holdPath)
    .replace('const ctx = { dir, nonce,', 'const ctx = { lockPath, dir, nonce,');
  const task = { id: 'fixture', app: 'Safari', setup() {}, prompt: () => 'task', check: () => true, cleanup: () => calls.push('task cleanup') };
  if (fixtureLifecycle) Object.assign(task, { id: 'simulator-form', app: 'Simulator', fixtureLifecycle: true });
  if (calculatorGate) Object.assign(task, { id: 'calculator-click', app: 'Calculator' });
  if (privateMail) Object.assign(task, { id: 'mimestream-label', app: 'Mimestream', privateMail: true,
    privateExpected: () => 'private answer', privateTerms: () => ['private label'] });
  const sandbox = {
    process: { argv: ['node', 'run', '--suite', suite, '--arm', arm, '--runs', '3', ...(setupOnly ? ['--setup-only'] : []), ...(dryRun ? ['--dry-run'] : []), ...(calculatorGate ? ['--calculator-gate'] : []), ...(cleanArms ? ['--clean-arms'] : []), ...extraArgs], env: base, on() {}, once() {} },
    console: { log: text => logs.push(text), error: text => logs.push(text) }, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    lockPath,
    basename: path => path.split('/').at(-1), dirname, join, fileURLToPath: () => '/fixture/bench/run.mjs', homedir: () => '/owner', tmpdir: () => `${MAC_TMP}/unit`,
    existsSync: path => path === holdPath ? holdAfterPreflight && preflightDone : true, realpathSync: path => path, mkdirSync: path => directories.push(path), rmdirSync(path) { assert.equal(path, lockPath); }, statSync: path => { assert.equal(path, lockPath); return { dev: 1, ino: 1 }; },
    writeFileSync: (path, value) => { files.set(path, JSON.parse(value)); saved.push(JSON.parse(value)); }, randomBytes: () => ({ toString: () => 'nonce' }),
    readFileSync: path => {
      assert.ok(['/fixture/bench/settings.json', '/fixture/bench/private-settings.json'].includes(path));
      return readFileSync(new URL('../bench/' + path.split('/').at(-1), import.meta.url), 'utf8');
    },
    privateMailResult, publicPrivateMailRow, publicPrivateMailRows,
    readEngine: () => { engineReadCount++; return { version: engineReads.length > 1 ? engineReads.shift() : engineReads[0], at: 'fixture' }; }, engineSpan,
    privateDriverEnvironment, assertPrivateClaudePolicy: () => calls.push('policy audit'),
    DEFAULT_CAP_USD: 200, runCost: out => out?.total_cost_usd, archiveOldRuns: () => [], benchAuth: options => { calls.push(['auth mode', options.mode]); return auth; }, addSpend: usd => { calls.push(['spend', usd]); return spend(usd); },
    CONFIG_DIR: '/isolated/claude',
    sweepTemp: options => calls.push(['temp sweep', options]),
    pruneRunImages: options => calls.push(['image retention', options]), evidenceRoots,
    beginPassHygiene: async () => {
      calls.push('window baseline');
      const handle = { get hygieneError() { return hygieneTracking; }, betweenTasks: async () => { calls.push('hygiene boundary'); if (hygieneBoundaryError) throw new Error(hygieneBoundaryError); }, trackLaunch: async (apps, operation) => { calls.push(['tracked setup', apps]); return operation(); }, finish: async options => { calls.push(['window hygiene', options]); return hygieneResult; } };
      if (hygieneError) throw Object.assign(new Error(hygieneError), hygieneReceiptsOnly && { receiptsOnly: handle });
      return handle;
    },
    assertLogin: plan => { calls.push(['login preflight', plan]); const message = typeof loginError === 'function' ? loginError(plan) : loginError; if (message) throw new Error(message); },
    assertEngineSockets: async () => { calls.push('socket preflight'); if (socketError) throw new Error(socketError); },
    prepareGenericArm: () => {
      if (preparationError) throw new Error(preparationError);
      return { generic: true, cwd: `${MAC_TMP}/own-arm`, args: ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '--disable-slash-commands', '--permission-prompts', 'none', '--no-session-persistence'], env: {}, identity: {}, servers: ['rival'] };
    },
    genericSettings, sleightPluginLaunch, acceptGenericCatalog() {}, worldCLI, worldArm, worldSettings, assertWorldCLI,
    isNativeArm, nativeArmPlan,
    ensureCuaDaemon: async dir => {
      calls.push(['cua daemon', dir]);
      if (daemonError) throw new Error(daemonError);
      return { started: true, stop: async () => { calls.push('cua daemon stop'); if (daemonStopError) throw new Error(daemonStopError); } };
    },
    prepareNativeArm: (name, options) => {
      const plan = nativeArmPlan(name, options);
      if (options.dryRun || plan.unsupported) return plan;
      return { ...sandbox.prepareGenericArm(), ...plan, identity: plan.identity };
    },
    dragMethodAudit,
    interactivePlan: options => ({ ...options, cwd: options.armDir, command: 'fake-claude', env: { CLAUDE_CONFIG_DIR: join(options.armDir, 'claude') } }),
    verifyInteractiveCLI: () => { calls.push('interactive version'); },
    runInteractive: async (plan, options) => {
      assert.ok(calls.includes('lock'), 'interactive tasks require the runner lock');
      calls.push(['interactive driver', plan]); envs.push(plan.env); options.onSpawn?.(1234);
      options.onEvent?.({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'drag', name: 'mcp__computer-use__drag', input: {} }] } });
      options.onEvent?.({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'drag', content: 'done' }] } });
      return { type: 'result', is_error: false, result: 'RESULT fixture', groupClean: true, num_turns: 1, ...driverOut };
    },
    guardGenericOperation: (operation, options) => guardGenericOperation(operation, { ...options, stopFile: undefined, held: () => false }),
    genericTask: task => { calls.push('retained setup'); return task; },
    publishPrivateMailResults: (_path, value, options) => { calls.push('private audit'); assert.ok(options.terms.every(term => term === 'private label')); saved.push(JSON.parse(value)); },
    execFileSync(command, args) {
      if (args?.[0] === '--version') return worldVersion + ' (Claude Code)';
      if (command === '/usr/bin/git' && args.includes('HEAD')) return 'c0ffee1234\n';
      if (command === '/usr/bin/git' && args.includes('status')) return ' M bench/run.mjs\n';
      if (command === '/usr/bin/git') throw new Error('outside repo');
      if (command === 'id') return privateMail ? 'Owner Example' : ownerName;
      calls.push('tap check'); return JSON.stringify(taps);
    },
    refreshHub: options => { hubRefreshes.push(options); return { line: 'hub: fixture' }; },
    getTasks: () => tasks ?? [task], BENCH_APPS, REAL_APPS, WORLD_APPS, worldPassApps,
    selectSuiteTasks, assertShopSmokeRuns,
    closeBenchTextEdit: options => { calls.push('TextEdit tail'); tailScopes.push(options); },
    quitChess: options => { calls.push('Chess tail'); tailScopes.push(options); },
    quitSimApp: options => { calls.push('Simulator tail'); tailScopes.push(options); },
    approveOnly: ids => { calls.push(['approve', ...ids]); return () => {}; }, codexReady: () => true, CODEX_HOME: '/owner/.codex-bench', codexExecPlan, assertOnlyServers,
    CODEX_SLEIGHT_HOME: '/owner/.codex-bench-sleight', ensureCodexSleightHome: () => { calls.push('codex sleight home'); return { ok: true, home: '/owner/.codex-bench-sleight', did: [] }; },
    writeCodexSleightConfig: (toml, home, copy) => { calls.push(['codex sleight config', home, copy]); codexConfigs.push(toml); },
    codexSleightRunConfig, approvalSummary: () => ({ accepted: 1, declined: declinedPrompts, toolsRefused: [], log: [{ kind: 'elicitation', message: 'Allow Computer Use to use "TextEdit"?', action: 'accept' }] }),
    codexConfigServers: home => home === '/owner/.codex-bench-sleight' ? sleightHomeServers : codexServers ?? [],
    cpuSplit, benchHand,
    startFootprint: options => { calls.push(['footprint apps', options.apps]); return async () => footprint; },
    runCodex: async (prompt, options) => { codexRuns.push({ prompt, options }); options.onSpawn?.(4321); return { code: 0, out: {}, forbidden: [], ...codexResult }; },
    watchAppWindows: app => { calls.push(['watch app', app]); return async () => ({ samples: 1, onScreen: app === 'Mail' ? 0 : 1, offScreenOnly: app === 'Mail' ? 1 : 0, none: 0 }); },
    acquireLiveLock: async () => { calls.push('lock'); return async () => { calls.push('unlock'); if (unlockError) throw new Error(unlockError); }; },
    runTiming: () => ({}), traceTiming: () => ({}), withStamps: timing => timing, observePermission: () => { if (dryRun) assert.fail('no host permission observation in initialization-only discovery'); return false; },
    assertCalculatorReady: async () => {
      assert.ok(calls.includes('lock'), 'Calculator observation requires the shared lock');
      calls.push('Calculator observation');
      if (++calculatorObservations === calculatorFailureAt) throw new Error('Calculator has no visible window on the current Space');
      return { load: [1, 2, 3], calculatorPid: 123, onScreenWindows: 1 };
    },
    runOwned: async (_command, _args, options) => {
      commands.push(_command); calls.push('arm discovery');
      envs.push(options.env); options.onStdout(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: keySource, mcp_servers: [{ name: arm === 'lcu' || /\/lcu-arm$/.test(options.cwd ?? '') ? 'lcu' : 'plugin:sleight:computer', status: 'connected' }, ...(extraServer ? [{ name: extraServer, status: 'connected' }] : [])] }) + '\n');
      preflightDone = true;
      return { groupClean: true };
    },
    runDriver: async (_command, args, options) => { commands.push(_command); calls.push(['driver', ...args]); envs.push(options.env); driverOptions.push(options); options.onSpawn?.(1234); return { code: 0, out: { total_cost_usd: 0.25, ...driverOut }, groupClean: true }; },
    cleanupContained: realCleanupContained,
    releaseFixtureLock,
    mergeArmHooks: realMergeArmHooks,
    executeRealTask: async (_task, ctx, options) => {
      assert.equal(ctx.lockPath, lockPath);
      Object.assign(ctx, fixtureStates[contexts.length]);
      contexts.push(ctx);
      ctx.windowLeases = leases;
      if (setupOnly) assert.equal(options.setupOnly, true);
      if (dryRun) assert.equal(options.dryRun, true);
      calls.push('real run'); if (throws) throw new Error('unexpected run failure');
      if (holdAfterPreflight) {
        try { await options.permissionCheck(); } catch (error) { options.stop(); return { passed: false, observerError: error.message, reason: error.message }; }
      }
      const response = drive ? await options.drive('task', ctx, {}) : {};
      return { passed: false, groupClean: true, ...response, ...outcome };
    },
  };
  let error;
  try { await runInNewContext(`(async () => { ${source}\n})()`, sandbox); } catch (caught) { error = caught; }
  finally { rmSync(temp, { recursive: true, force: true }); }
  const plan = logs.filter(text => typeof text === 'string' && text.startsWith('{')).map(text => JSON.parse(text)).at(-1);
  return { hubRefreshes, calls, saved, plan, envs, tailScopes, directories, error, logs, driverOptions, codexRuns, codexConfigs, files, commands, contexts, lockPath, exitCode: sandbox.process.exitCode, engineReadCount };
}

test('confirmed fixtures release the outer lock exactly once after cleanup tails and daemon stop', async () => {
  const result = await runner({ arm: 'cua', drive: true, outcome: { passed: true },
    fixtureStates: [{ fixtureLockUnconfirmed: false, pendingAcquisitions: new Set() }] });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, undefined);
  assert.equal(result.contexts.length, 3);
  assert.ok(result.contexts.every(ctx => ctx.lockPath === result.lockPath));
  assert.ok(result.saved.at(-1).results.every(row => row.passed === true));
  assert.equal(result.calls.filter(call => call === 'lock').length, 1);
  assert.equal(result.calls.filter(call => call === 'unlock').length, 1);
  assert.deepEqual(result.calls.slice(-5), ['TextEdit tail', 'Chess tail', 'Simulator tail', 'cua daemon stop', 'unlock']);
  assert.ok(!result.logs.some(line => /Live lock:|live lock kept/.test(line)));
});

for (const [reason, state] of [
  ['fixture cleanup', { fixtureLockUnconfirmed: true }],
  ['pending acquisition', { pendingAcquisitions: new Set(['browser']) }],
  ['exit disagreement', { exitDisagreements: [{ app: 'Fixture', pid: 123, step: 'window cleanup' }] }],
]) test(`unconfirmed ${reason} in an earlier fixture retains the outer lock after later fixtures finish`, async () => {
  const result = await runner({ arm: 'cua', drive: true, outcome: { passed: true }, fixtureStates: [state] });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 1);
  assert.equal(result.contexts.length, 3);
  assert.equal(result.calls.filter(call => call === 'lock').length, 1);
  assert.equal(result.calls.includes('unlock'), false);
  assert.deepEqual(result.calls.slice(-4), ['TextEdit tail', 'Chess tail', 'Simulator tail', 'cua daemon stop']);
  assert.ok(result.logs.some(line => /STOP: fixture setup, window cleanup or helper collection unconfirmed; live lock kept/.test(line)));
  assert.ok(!result.logs.some(line => /Live lock:/.test(line)), 'retention must come from fixture evidence, not a missing VM import');
  if (reason === 'fixture cleanup') {
    assert.equal(result.calls.find(call => Array.isArray(call) && call[0] === 'window hygiene')[1].blocked, true);
  }
});

test('an outer lock release failure remains visible after the daemon and cleanup tails finish', async () => {
  const result = await runner({ arm: 'cua', outcome: { passed: true }, unlockError: 'fake unlock failed' });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.filter(call => call === 'unlock').length, 1);
  assert.deepEqual(result.calls.slice(-5), ['TextEdit tail', 'Chess tail', 'Simulator tail', 'cua daemon stop', 'unlock']);
  assert.ok(result.logs.includes('Live lock: fake unlock failed'));
});

test('pass snapshots under the lock before discovery; temp and image cleanup run before tasks', async () => {
  const result = await runner({ drive: true });
  assert.equal(result.error, undefined);
  assert.ok(result.calls.indexOf('window baseline') > result.calls.indexOf('lock'));
  assert.ok(result.calls.indexOf('window baseline') < result.calls.findIndex(call => Array.isArray(call) && call[0] === 'login preflight'));
  for (const name of ['temp sweep', 'image retention']) assert.ok(result.calls.findIndex(call => Array.isArray(call) && call[0] === name) < result.calls.indexOf('real run'));
});
test('a pass names the engine it ran on and the UTC time per row, and flags a change by its last save', async () => {
  const same = await runner({ suite: 'default', drive: true });
  assert.equal(same.error, undefined);
  const pass = same.saved.at(-1);
  assert.deepEqual([pass.engine.version, pass.engine.changed], ['26.1013.40934', false]);
  assert.ok(pass.results.length && pass.results.every(row => row.engineVersion === '26.1013.40934' && !Number.isNaN(Date.parse(row.finishedAt))));
  assert.equal(pass.engine.startedAt, 'fixture');
  // The pass reads the engine at load, again once it holds the live lock, then per row and at its last save.
  assert.equal(same.engineReadCount, 2 + pass.results.length + 1);
  const moved = (await runner({ suite: 'default', drive: true, engineReads: ['26.1007.71326', '26.1007.71326', '26.1007.71326', '26.1013.40934'] })).saved.at(-1);
  assert.deepEqual([moved.engine.version, moved.engine.changed, moved.engine.start.version, moved.engine.end.version], [null, true, '26.1007.71326', '26.1013.40934']);
  assert.deepEqual(moved.results.map(row => row.engineVersion), ['26.1007.71326', '26.1013.40934', '26.1013.40934']);
  const dry = await runner({ dryRun: true });
  assert.equal(dry.plan.engine.version, '26.1013.40934');
});
test('window baseline failure is logged without skipping or losing timed runs', async () => {
  const result = await runner({ suite: 'default', drive: true, hygieneError: 'CGWindowList unavailable' });
  assert.equal(result.error, undefined);
  assert.equal(result.saved.at(-1).results.length, 3);
  assert.ok(result.saved.at(-1).results.every(row => !row.skipped && typeof row.seconds === 'number'));
  assert.match(JSON.stringify(result.saved.at(-1).hygieneError), /CGWindowList unavailable/);
  assert.ok(result.logs.some(line => /hygiene.*CGWindowList unavailable/i.test(line)));
  assert.equal(result.calls.at(-1), 'unlock');
});
test('a failed baseline still hands exact launch receipts to the gentle Quit path', async () => {
  const result = await runner({ hygieneError: 'AX timeout', hygieneReceiptsOnly: true,
    hygieneResult: { leftWindows: [{ pid: 42, bundle: 'org.fixture', reason: 'still running after Quit' }], errors: [] }, leases: [
      { app: 'fixture', bundle: 'org.fixture', pid: 42, processStartedAtMs: 12000, running: false, launched: true },
      { app: 'owner', bundle: 'org.owner', pid: 43, processStartedAtMs: 13000, running: true, launched: false },
    ] });
  assert.equal(result.error, undefined);
  const options = result.calls.find(call => Array.isArray(call) && call[0] === 'window hygiene')?.[1];
  // Every run shares the fake lease list; the warm owner app never appears.
  assert.deepEqual([...new Set(options.launched.map(item => JSON.stringify(item)))], [JSON.stringify({ pid: 42, start: 12, bundle: 'org.fixture' })]);
  assert.match(JSON.stringify(result.saved.at(-1).hygieneError), /AX timeout/);
  assert.deepEqual(result.saved.at(-1).leftWindows, [{ pid: 42, bundle: 'org.fixture', reason: 'still running after Quit' }]);
});
test('between-task snapshot failures preserve timed runs and fixture attribution reaches cleanup', async () => {
  const task = { id: 'fixture', app: 'Fixture', setup(ctx) { ctx.document = join(ctx.dir, 'Owned.txt'); }, prompt: () => 'task', check: () => true };
  const result = await runner({ suite: 'default', tasks: [task], hygieneBoundaryError: 'snapshot timed out' });
  assert.equal(result.error, undefined);
  assert.ok(result.saved.at(-1).results.every(row => !row.skipped && typeof row.seconds === 'number'));
  assert.match(JSON.stringify(result.saved.at(-1).hygieneError), /snapshot timed out/);
  const options = result.calls.find(call => Array.isArray(call) && call[0] === 'window hygiene')[1];
  assert.ok(options.fixturePaths.some(path => path.endsWith('/Owned.txt')));
  assert.ok(options.fixtureNames.includes('Owned.txt'));
});
test('left windows are published and hygiene dry run reaches every deletion and window planner', async () => {
  const result = await runner({ extraArgs: ['--hygiene-dry-run'], hygieneResult: { leftWindows: [{ pid: 42, id: 7 }], errors: [] } });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.saved.at(-1).leftWindows, [{ pid: 42, id: 7 }]);
  for (const name of ['temp sweep', 'image retention', 'window hygiene']) assert.equal(result.calls.find(call => Array.isArray(call) && call[0] === name)?.[1].dryRun, true);
});
test('a pass interrupted by a driver or dialog keeps new windows; planning dry run does no hygiene inventory', async () => {
  for (const outcome of [{ groupClean: false }, { appDialog: { category: 'save' } }]) {
    const result = await runner({ outcome });
    assert.equal(result.calls.find(call => Array.isArray(call) && call[0] === 'window hygiene')?.[1].blocked, true);
  }
  const dry = await runner({ dryRun: true });
  assert.equal(dry.calls.includes('window baseline'), false);
  assert.ok(!dry.calls.some(call => Array.isArray(call) && ['temp sweep', 'image retention'].includes(call[0])));
});
test('owner-present cleanup is report-only and private results carry only leftover IDs', async () => {
  const result = await runner({ privateMail: true, extraArgs: ['--owner-present'],
    hygieneResult: { leftWindows: [{ pid: 42, id: 7, bundle: 'fixture', reason: 'invented private label' }], errors: [] } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.find(call => Array.isArray(call) && call[0] === 'window hygiene')?.[1].blocked, true);
  assert.deepEqual(result.saved.at(-1).leftWindows, [{ pid: 42, id: 7 }]);
  assert.equal(JSON.stringify(result.saved).includes('invented private label'), false);
});

test('missing isolated login stops before tool discovery or the first task', async () => {
  const result = await runner({ loginError: 'Not logged in. Fix: isolated auth login', drive: true });
  assert.equal(result.exitCode, 1);
  assert.ok(result.logs.some(line => /Not logged in.*Fix: isolated auth login/.test(line)));
  assert.equal(result.commands.length, 0);
  assert.equal(result.calls.includes('real run'), false);
});
test('extension tasks check socket readiness before tool discovery or task setup', async () => {
  const result = await runner({ socketError: 'stale extension socket', tasks: [{ id: 'extension', surface: 'extension' }],
    extraArgs: ['--surfaces', 'browser,computer', '--extension-sites-allowed'] });
  assert.equal(result.exitCode, 1);
  assert.ok(result.calls.includes('socket preflight'));
  assert.equal(result.commands.length, 0);
  assert.equal(result.calls.includes('real run'), false);
});
test('login readiness receives the exact config the arm will run with', async () => {
  const result = await runner({ base: { CLAUDE_CONFIG_DIR: '/caller/throwaway' }, drive: true });
  assert.equal(result.error, undefined);
  const login = result.calls.find(c => Array.isArray(c) && c[0] === 'login preflight');
  assert.ok(login);
  assert.equal(login[1].env.CLAUDE_CONFIG_DIR, '/isolated/claude');
  assert.ok(result.driverOptions.every(options => options.env.CLAUDE_CONFIG_DIR === login[1].env.CLAUDE_CONFIG_DIR));
});

test('claude-cu drives the retained native fixture through an isolated interactive session', async () => {
  const result = await runner({ arm: 'claude-cu', suite: 'world', extraArgs: ['--owner-away'], drive: true, outcome: { passed: true },
    auth: { mode: 'api', env: { ANTHROPIC_API_KEY: 'unrelated-api-key' }, unset: [] } });
  assert.equal(result.error, undefined);
  const drives = result.calls.filter(c => Array.isArray(c) && c[0] === 'interactive driver');
  assert.equal(drives.length, 3);
  assert.ok(drives.every(c => c[1].prompt === 'task' && c[1].model === 'claude-haiku-5-5' && c[1].effort === 'high'));
  assert.equal(result.driverOptions.length, 0);
  assert.ok(result.envs.every(env => env.ANTHROPIC_API_KEY === undefined));
  assert.equal(result.saved.at(-1).armMetadata['claude-cu'].auth, 'isolated direct-plan login');
});

test('claude-cu approval refusal fails the native result and stops remaining runs', async () => {
  const result = await runner({ arm: 'claude-cu', suite: 'world', extraArgs: ['--owner-away'], drive: true,
    driverOut: { is_error: true, reason: 'approval required', gateBlocked: true, groupClean: true } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(c => Array.isArray(c) && c[0] === 'interactive driver').length, 1);
  assert.equal(result.saved.at(-1).results[0].passed, false);
  assert.match(result.saved.at(-1).results[0].reason, /approval/);
});

test('claude-cu receives only the current task fixture identities and grants and saves approval blocks', async () => {
  const result = await runner({ arm: 'claude-cu', suite: 'world', drive: true, extraArgs: ['--owner-away'], ownerName: 'Owner Example',
    tasks: [{ id: 'fixture', app: 'Fixture Editor', allowedApps: ['Fixture Editor', 'com.fixture.Editor'], allowedGrants: ['clipboardRead'] }],
    driverOut: { is_error: true, gateBlocked: true, reason: 'unsupported computer-use approval card',
      approvalBlock: { reason: 'unsupported computer-use approval card', cardText: `Computer Use wants to control these apps\n  Terminal\nOwner Example ${MAC_TMP}/unit/private.txt` } } });
  assert.equal(result.error, undefined);
  const plan = result.calls.find(call => Array.isArray(call) && call[0] === 'interactive driver')[1];
  assert.deepEqual(Array.from(plan.allowedApps ?? []), ['Fixture Editor', 'com.fixture.Editor']);
  assert.deepEqual(Array.from(plan.allowedGrants ?? []), ['clipboardRead']);
  const block = [...result.files].find(([path]) => path.endsWith('/approval-block.json'));
  assert.ok(block, 'block evidence is saved in the run evidence directory');
  assert.equal(block[1].reason, 'unsupported computer-use approval card');
  assert.match(block[1].cardText, /Terminal/);
  assert.doesNotMatch(block[1].cardText, /Owner Example|\/private\/tmp\/unit/);
  assert.match(block[1].cardText, /<user> <temp>\/private.txt/);
});

test('claude-cu unconfirmed cleanup stops the pass even without a permission gate', async () => {
  const result = await runner({ arm: 'claude-cu', suite: 'world', extraArgs: ['--owner-away'], drive: true,
    driverOut: { is_error: true, reason: 'interactive task timeout', groupClean: false } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(c => Array.isArray(c) && c[0] === 'interactive driver').length, 1);
  assert.match(result.saved.at(-1).results[0].reason, /cleanup unverified/);
});

test('interactive login stays separate from a mixed API cohort and contributes no API spend', async () => {
  const result = await runner({ arm: 'sleight,claude-cu', suite: 'world', drive: true, outcome: { passed: true },
    extraArgs: ['--owner-away', '--auth', 'api'], keySource: 'ANTHROPIC_API_KEY',
    auth: { mode: 'api', env: { ANTHROPIC_API_KEY: 'fixture', CLAUDE_CONFIG_DIR: '/shared' }, unset: [], spent: 0, capUsd: 200 },
    driverOut: { total_cost_usd: 0.25 } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(c => Array.isArray(c) && c[0] === 'spend').length, 3);
  const interactive = result.calls.filter(c => Array.isArray(c) && c[0] === 'interactive driver');
  assert.equal(interactive.length, 3);
  assert.ok(interactive.every(c => !c[1].env.ANTHROPIC_API_KEY));
  assert.ok(result.driverOptions.every(o => o.env.ANTHROPIC_API_KEY === 'fixture'));
});

for (const cause of ['interactive task timeout', 'session exited before confirmed RESULT and idle prompt']) {
  test(`confirmed interactive cleanup continues the pass after ${cause}`, async () => {
    const result = await runner({ arm: 'claude-cu', suite: 'world', drive: true, extraArgs: ['--owner-away'],
      driverOut: { is_error: true, reason: cause, groupClean: true, timedOut: cause.includes('timeout') } });
    assert.equal(result.error, undefined);
    assert.equal(result.calls.filter(c => Array.isArray(c) && c[0] === 'interactive driver').length, 3);
    assert.ok(result.saved.at(-1).results.every(row => row.reason === cause && row.passed === false && !row.approvalStop));
  });
}

test('claude-cu provides executed drag receipts to the retained method grader', { skip: parserSkip }, async () => {
  const result = await runner({ arm: 'claude-cu', suite: 'world', extraArgs: ['--owner-away'], drive: true,
    tasks: [{ id: 'textedit-window-drag', app: 'TextEdit', prompt: () => 'drag', timeoutMs: 17000 }] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.saved.at(-1).results[0].methodAudit, { drag: true, replacement: false, complete: true });
});

test('world suite uses retained fixtures, world approvals and each task deadline', async () => {
  const result = await runner({ suite: 'world', arm: 'sleight,codex', drive: true, outcome: { passed: true },
    extraArgs: ['--owner-away'],
    tasks: [{ id: 'world-fixture', app: 'Preview', allowedApps: ['Preview', 'com.apple.Preview'], prompt: () => 'fixture', timeoutMs: 17000 }] });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => call === 'real run').length, 6);
  const approved = result.calls.find(call => Array.isArray(call) && call[0] === 'approve');
  assert.ok(approved.includes('com.apple.Preview'));
  assert.equal(approved.includes('com.apple.mail'), false);
  assert.equal(approved.includes('com.apple.Notes'), false);
  assert.ok(result.driverOptions.every(options => options.timeoutMs === 17000));
  assert.ok(result.codexRuns.every(run => run.options.timeoutMs === 17000));
});

test('world live fixtures require an explicit owner-away boundary before CLI startup', async () => {
  const result = await runner({ suite: 'world', arm: 'sleight' });
  assert.match(result.error?.message ?? '', /world.*--owner-away/);
  assert.equal(result.calls.includes('lock'), false);
  assert.equal(result.envs.length, 0);
});

const loginTargets = () => LOGIN_ARMS.map(name => loginTarget(name, { armHome: '/owner/Library/Caches/sleight-bench', env: {} }));
const WORLD_ARMS = 'sleight,lcu,cua,peekaboo,claude-cu,codex';
const LOGIN = { mode: 'login', env: {}, unset: [] };
const HOME = '/owner/Library/Caches/sleight-bench';

test('world defaults to the account login and keeps the API path behind --auth api', async () => {
  const modeOf = result => result.calls.find(call => Array.isArray(call) && call[0] === 'auth mode')?.[1];
  assert.equal(modeOf(await runner({ suite: 'world', arm: 'sleight', auth: LOGIN, extraArgs: ['--owner-away'] })), 'login');
  assert.equal(modeOf(await runner({ suite: 'world', arm: 'sleight', extraArgs: ['--owner-away', '--auth', 'api'] })), 'api');
  // Every suite defaults to the login since an import of run.mjs started an API-key pass (2026-10-25).
  assert.equal(modeOf(await runner({ suite: 'default', arm: 'sleight' })), 'login');
  assert.equal(modeOf(await runner({ suite: 'default', arm: 'sleight', extraArgs: ['--auth', 'auto'] })), 'auto');
});

test('world login checks every Claude arm against its own isolated config and skips Codex', async () => {
  const result = await runner({ suite: 'world', arm: WORLD_ARMS, auth: LOGIN, drive: true, outcome: { passed: true },
    base: { CLAUDE_CONFIG_DIR: '/caller/throwaway' }, extraArgs: ['--owner-away', '--auth', 'login'],
    tasks: [{ id: 'world-fixture', app: 'Preview', prompt: () => 'fixture', timeoutMs: 17000 }] });
  assert.equal(result.error, undefined, result.logs.join('\n'));
  assert.ok(result.calls.includes('real run'), result.logs.join('\n'));
  const plans = result.calls.filter(call => Array.isArray(call) && call[0] === 'login preflight').map(call => call[1]);
  assert.equal(plans.length, 5);
  const configs = plans.map(plan => plan.env.CLAUDE_CONFIG_DIR);
  assert.equal(new Set(configs).size, 5);
  assert.deepEqual(configs.sort(), loginTargets().map(target => target.config).sort());
  for (const config of configs) assert.ok(!['/caller/throwaway', '/owner/.claude'].includes(config));
  for (const plan of plans.filter(plan => plan.env.CLAUDE_CONFIG_DIR !== `${HOME}/claude-cu/claude`)) assert.equal(plan.command, worldCLI(HOME));
  assert.equal(result.calls.filter(call => call === 'real run').length, 18);
});

test('world login arms start with no host Claude identity or credential and one config each', async () => {
  const base = { CLAUDE_CONFIG_DIR: '/caller/throwaway', CLAUDE_CODE_ENTRYPOINT: 'desktop', CLAUDE_SESSION_ID: 'host', CLAUDE_CUSTOM: 'host',
    ANTHROPIC_API_KEY: 'sk-ant-host', ANTHROPIC_AUTH_TOKEN: 'host', CLAUDE_CODE_OAUTH_TOKEN: 'host' };
  const result = await runner({ suite: 'world', arm: WORLD_ARMS, auth: LOGIN, drive: true, outcome: { passed: true }, base,
    extraArgs: ['--owner-away', '--auth', 'login'], tasks: [{ id: 'world-fixture', app: 'Preview', prompt: () => 'fixture', timeoutMs: 17000 }] });
  assert.equal(result.error, undefined);
  assert.ok(result.envs.length >= 10);
  const allowed = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY']);
  for (const env of result.envs) {
    assert.deepEqual(Object.keys(env).filter(key => /^CLAUDE/.test(key) && !allowed.has(key)), []);
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(env[key], undefined);
    assert.ok(loginTargets().some(target => target.config === env.CLAUDE_CONFIG_DIR), env.CLAUDE_CONFIG_DIR);
  }
  assert.equal(new Set(result.envs.map(env => env.CLAUDE_CONFIG_DIR)).size, 5);
});

test('world login refuses before any server or task and names every arm that is not logged in with its command', async () => {
  const result = await runner({ suite: 'world', arm: WORLD_ARMS, auth: LOGIN, drive: true, extraArgs: ['--owner-away', '--auth', 'login'],
    loginError: plan => /\/(lcu-arm|mcp-peekaboo-arm)\//.test(plan.env.CLAUDE_CONFIG_DIR)
      ? `Not logged in to the arm's isolated Claude account (${plan.env.CLAUDE_CONFIG_DIR}).\nFix: login ${plan.env.CLAUDE_CONFIG_DIR}` : undefined });
  assert.equal(result.exitCode, 1);
  const text = result.logs.join('\n');
  assert.match(text, /lcu: Not logged in.*\nFix: login ~\/Library\/Caches\/sleight-bench\/lcu-arm\/claude/);
  assert.match(text, /peekaboo: Not logged in.*\nFix: login ~\/Library\/Caches\/sleight-bench\/mcp-peekaboo-arm\/claude/);
  assert.doesNotMatch(text, /sleight: Not logged in|cua: Not logged in|claude-cu: Not logged in/);
  assert.equal(result.commands.length, 0);
  assert.equal(result.envs.length, 0);
  assert.equal(result.calls.includes('real run'), false);
});

test('world login refuses a discovery that used an API key instead of the account login', async () => {
  const result = await runner({ suite: 'world', arm: 'sleight', auth: LOGIN, keySource: 'ANTHROPIC_API_KEY', extraArgs: ['--owner-away', '--auth', 'login'] });
  assert.equal(result.exitCode, 1);
  assert.ok(result.logs.some(line => /API key, not the account login/.test(line)));
  assert.equal(result.calls.includes('real run'), false);
});

test('only world runs widen the Claude environment filter', async () => {
  const base = { CLAUDE_CUSTOM_FEATURE: 'keep-outside-world' };
  const normal = await runner({ suite: 'default', base });
  assert.ok(normal.envs.length);
  assert.ok(normal.envs.every(env => env.CLAUDE_CUSTOM_FEATURE === base.CLAUDE_CUSTOM_FEATURE));
  const world = await runner({ suite: 'world', base, extraArgs: ['--owner-away'] });
  assert.ok(world.envs.length);
  assert.ok(world.envs.every(env => !('CLAUDE_CUSTOM_FEATURE' in env)));
});

test('world paired-window drag requests the method audit for both drivers', { skip: parserSkip }, async () => {
  const result = await runner({ suite: 'world', arm: 'sleight,codex', drive: true, extraArgs: ['--owner-away'],
    tasks: [{ id: 'textedit-window-drag', app: 'TextEdit', prompt: () => 'drag', timeoutMs: 17000 }] });
  assert.equal(result.error, undefined);
  assert.ok(result.driverOptions.every(options => options.auditDrag === true));
  assert.ok(result.codexRuns.every(run => run.options.auditDrag === true));
});

for (const arm of ['cua', 'peekaboo', 'claude-cu']) test(`${arm} dry run starts no CLI, fixture, observer or live lock`, async () => {
  const result = await runner({ arm, dryRun: true });
  assert.equal(result.error, undefined);
  assert.equal(result.envs.length, 0);
  assert.equal(result.driverOptions.length, 0);
  assert.equal(result.calls.includes('lock'), false);
  assert.equal(result.calls.includes('real run'), false);
  const rows = result.plan.results;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.arm, arm);
    assert.equal(row.task, 'fixture');
    assert.equal(row.passed, undefined);
    if (arm === 'claude-cu') {
      assert.equal(row.dryRun, true);
      assert.equal(row.runner, 'runInteractive');
      assert.equal(row.command, undefined);
    } else {
      assert.equal(row.dryRun, true);
      assert.equal(row.command[1], '-p');
      assert.ok(row.command.includes('--strict-mcp-config'));
      assert.ok(row.command.includes('--no-chrome'));
      assert.deepEqual(Object.keys(row.mcp.mcpServers), [arm]);
    }
  }
});

for (const arm of ['sleight', 'codex', 'lcu', 'cua', 'peekaboo', 'claude-cu', 'mcp:rival']) test(`${arm} dry run creates no directories or result files`, async () => {
  const result = await runner({ arm, dryRun: true });
  assert.equal(result.error, undefined);
  assert.equal(result.directories.length, 0);
  assert.equal(result.files.size, 0);
  assert.equal(result.plan.results.length, 3);
  assert.doesNotMatch(result.logs.join('\n'), /results:/);
  for (const row of result.plan.results) if (row.command && row.runner !== 'runCodex') assert.ok(row.command.includes('--no-chrome'));
});

for (const arm of ['sleight', 'lcu', 'cua', 'peekaboo']) test(`${arm} world dry plan matches the live driver flags`, async () => {
  const dry = await runner({ suite: 'world', arm, dryRun: true });
  const live = await runner({ suite: 'world', arm, drive: true, extraArgs: ['--owner-away'] });
  assert.equal(dry.error, undefined);
  assert.equal(live.error, undefined);
  const planned = [...dry.plan.results[0].command.slice(1)];
  const actual = [...live.calls.find(call => Array.isArray(call) && call[0] === 'driver').slice(1)];
  planned[1] = actual[1];
  assert.deepEqual(planned, actual);
  assert.equal(dry.files.size, 0);
  assert.equal(dry.directories.length, 0);
});

test('world API authentication cannot replace the isolated arm config with a shared directory', async () => {
  const result = await runner({ suite: 'world', arm: 'sleight,cua', drive: true, extraArgs: ['--owner-away'], keySource: 'ANTHROPIC_API_KEY',
    auth: { mode: 'api', env: { ANTHROPIC_API_KEY: 'fixture', CLAUDE_CONFIG_DIR: '/shared/api' }, unset: [], spent: 0, capUsd: 100 } });
  assert.equal(result.error, undefined);
  assert.ok(result.envs.every(env => env.CLAUDE_CONFIG_DIR.endsWith('/claude') && env.ANTHROPIC_API_KEY === 'fixture'));
});

test('ordinary Claude arms also force the requested do-not-track setting', async () => {
  const result = await runner({ arm: 'sleight', drive: true, base: { DO_NOT_TRACK: '0' } });
  assert.equal(result.error, undefined);
  assert.ok(result.envs.every(env => env.DO_NOT_TRACK === '1'));
});

test('a world CLI version mismatch publishes its preflight failure without a model or fixture', async () => {
  const result = await runner({ suite: 'world', arm: 'sleight', extraArgs: ['--owner-away'], worldVersion: '2.1.288' });
  assert.equal(result.error, undefined);
  assert.equal(result.envs.length, 0);
  assert.equal(result.calls.includes('real run'), false);
  assert.equal(result.saved.at(-1).results[0].passed, false);
  assert.match(result.saved.at(-1).results[0].reason, /requires Claude Code 2\.1\.289/);
});

test('world mode isolates sleight and the native rivals with the same pinned CLI', async () => {
  const result = await runner({ suite: 'world', arm: 'sleight,cua,peekaboo', drive: true, extraArgs: ['--owner-away'],
    base: { CLAUDE_CONFIG_DIR: '/owner/config', CLAUDE_OWNER: 'owner', PATH: '/bin' } });
  assert.equal(result.error, undefined);
  for (const env of result.envs) {
    assert.notEqual(env.CLAUDE_CONFIG_DIR, '/owner/config');
    assert.match(env.CLAUDE_CONFIG_DIR, /\/claude$/);
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(env.DISABLE_TELEMETRY, '1');
  }
  for (const args of result.calls.filter(call => Array.isArray(call) && call[0] === 'driver')) {
    assert.ok(args.includes('--setting-sources'));
    assert.ok(args.includes('--no-chrome'));
  }
  assert.ok([...result.files.values()].some(value => value.autoMemoryEnabled === false && value.claudeMdExcludes?.includes('**')));
  assert.equal(new Set(result.commands).size, 1);
  assert.match(result.commands[0], /world-cli\/node_modules\/\.bin\/claude$/);
});

test('interactive-only world login skips pinned print CLI checks and discovery', async () => {
  const result = await runner({ arm: 'claude-cu', suite: 'world', drive: true, extraArgs: ['--owner-away', '--auth', 'login'],
    worldVersion: '2.1.288', auth: { mode: 'login', env: {}, unset: [] }, outcome: { passed: true } });
  assert.equal(result.error, undefined);
  assert.equal(result.driverOptions.length, 0);
  assert.equal(result.commands.length, 0);
  assert.equal(result.calls.filter(c => c === 'interactive version').length, 1);
});

for (const arm of ['sleight', 'codex', 'claude-cu']) test(`${arm} world dry plan never resolves login or launches a CLI`, async () => {
  const result = await runner({ arm, suite: 'world', dryRun: true });
  assert.equal(result.error, undefined);
  assert.equal(result.commands.length, 0);
  assert.equal(result.directories.length, 0);
  assert.equal(result.calls.includes('lock'), false);
});

test('native arms retain task prompts and checks, strip every inherited CLAUDE variable', async () => {
  const result = await runner({ suite: 'world', arm: 'cua,peekaboo', drive: true, extraArgs: ['--owner-away'], outcome: { passed: true },
    base: { CLAUDE_CONFIG_DIR: '/owner/config', CLAUDE_CUSTOM: 'owner', CLAUDE_BIN: 'claude', PATH: '/bin' } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => call === 'real run').length, 6);
  assert.ok(result.saved.at(-1).results.every(row => row.passed));
  for (const env of result.envs) {
    assert.equal(env.CLAUDE_CUSTOM, undefined);
    assert.equal(env.CLAUDE_BIN, undefined);
    assert.match(env.CLAUDE_CONFIG_DIR, /mcp-(cua|peekaboo)-arm\/claude$/);
  }
});

test('native API arms keep their own config directory while using the benchmark key', async () => {
  const result = await runner({ arm: 'cua', drive: true, outcome: { passed: true }, keySource: 'ANTHROPIC_API_KEY',
    auth: { mode: 'api', env: { ANTHROPIC_API_KEY: 'fixture', CLAUDE_CONFIG_DIR: '/shared-api-config' }, unset: [], spent: 0, capUsd: 100 } });
  assert.equal(result.error, undefined);
  for (const env of result.envs) {
    assert.match(env.CLAUDE_CONFIG_DIR, /mcp-cua-arm\/claude$/);
    assert.equal(env.ANTHROPIC_API_KEY, 'fixture');
  }
});

test('the cua arm gets its daemon before preflight and stops it when the pass ends', async () => {
  const result = await runner({ arm: 'cua', drive: true, outcome: { passed: true }, keySource: 'ANTHROPIC_API_KEY',
    auth: { mode: 'api', env: { ANTHROPIC_API_KEY: 'fixture' }, unset: [], spent: 0, capUsd: 100 } });
  assert.equal(result.error, undefined);
  const names = result.calls.map(call => Array.isArray(call) ? call[0] : call);
  assert.equal(names.filter(name => name === 'cua daemon').length, 1);
  assert.equal(result.calls.find(call => call[0] === 'cua daemon')[1], '/owner/Library/Caches/sleight-bench/mcp-cua-arm');
  assert.ok(names.indexOf('cua daemon') > names.indexOf('lock'));
  assert.ok(names.indexOf('cua daemon') < names.indexOf('arm discovery'));
  assert.ok(names.indexOf('cua daemon') < names.indexOf('real run'));
  assert.deepEqual(names.filter(name => name === 'cua daemon stop'), ['cua daemon stop']);
  assert.ok(names.indexOf('cua daemon stop') > names.lastIndexOf('real run'));
  assert.ok(names.indexOf('cua daemon stop') < names.indexOf('unlock'));
});

test('a refused login never starts the cua daemon and one that will not listen stops the pass before discovery', async () => {
  const result = await runner({ arm: 'cua', loginError: 'Not logged in',
    auth: { mode: 'login', env: {}, unset: [], spent: 0, capUsd: 100 } });
  assert.equal(result.calls.some(call => call[0] === 'cua daemon'), false, 'a refused login never starts the daemon');
  const failing = await runner({ arm: 'cua', daemonError: 'Cua daemon did not listen' });
  assert.equal(failing.exitCode, 1);
  assert.ok(failing.logs.some(line => /Cua daemon did not listen/.test(line)));
  assert.equal(failing.commands.length, 0);
  assert.equal(failing.calls.includes('real run'), false);
  assert.equal(failing.calls.includes('unlock'), true);
});

test('a task that throws still stops the cua daemon it started', async () => {
  const result = await runner({ arm: 'cua', throws: true });
  assert.ok(result.calls.includes('cua daemon stop'));
  assert.ok(result.calls.indexOf('cua daemon stop') < result.calls.indexOf('unlock'));
});

test('a failing daemon stop is reported and the live lock is still released', async () => {
  const result = await runner({ arm: 'cua', daemonStopError: 'stuck', drive: true });
  assert.equal(result.exitCode, 1);
  assert.ok(result.logs.some(line => /Cua daemon: stuck/.test(line)));
  assert.equal(result.calls.at(-1), 'unlock');
});

test('the cua daemon is neither started for other arms nor in a dry run', async () => {
  for (const options of [{ arm: 'sleight', drive: true }, { arm: 'peekaboo', drive: true }, { arm: 'cua', suite: 'world', dryRun: true },
    { arm: 'cua', setupOnly: true }]) {
    const result = await runner(options);
    assert.equal(result.calls.some(call => Array.isArray(call) && call[0] === 'cua daemon'), false, JSON.stringify(options));
    assert.equal(result.calls.includes('cua daemon stop'), false);
  }
});

test('the superseded world flag refuses before any setup or driver', async () => {
  const result = await runner({ extraArgs: ['--world'] });
  assert.match(result.error?.message ?? '', /--suite world/);
  assert.equal(result.envs.length, 0);
  assert.equal(result.directories.length, 0);
});

test('extension tasks require both surfaces before any live lock or fixture', async () => {
  const task = { id: 'chrome-validation-extension', app: 'Google Chrome', surface: 'extension' };
  const result = await runner({ tasks: [task], extraArgs: ['--tasks', task.id] });
  assert.match(String(result.error?.message), /extension tasks require --surfaces browser,computer/);
  assert.equal(result.calls.includes('lock'), false);
  assert.equal(result.calls.includes('real run'), false);
});

for (const explicit of [false, true]) test(`extension site permission is required before starting ${explicit ? 'selected' : 'default'} extension tasks`, async () => {
  const task = { id: 'helium-validation-extension', app: 'Helium', surface: 'extension' };
  const result = await runner({ tasks: [task], extraArgs: ['--surfaces', 'browser,computer', ...(explicit ? ['--tasks', task.id] : [])] });
  assert.match(result.error?.message ?? '', /--extension-sites-allowed/);
  assert.match(result.error.message, /owner.*allow 127\.0\.0\.1.*extension.*site settings/i);
  assert.equal(result.calls.includes('lock'), false);
  assert.equal(result.calls.includes('real run'), false);
  assert.equal(result.envs.length, 0, 'refuse before any driver or engine preflight');
});

test('default computer-only selection omits extension variants', async () => {
  const result = await runner({ tasks: [
    { id: 'chrome-validation', app: 'Google Chrome', surface: 'native' },
    { id: 'chrome-validation-extension', app: 'Google Chrome', surface: 'extension' },
  ] });
  assert.equal(result.error, undefined);
  assert.deepEqual([...new Set(result.saved.at(-1).results.map(row => row.task))], ['chrome-validation']);
});

test('every native and extension result records its surface on both arms, including failures', async () => {
  const result = await runner({ arm: 'sleight,codex', extraArgs: ['--surfaces', 'browser,computer', '--extension-sites-allowed'], tasks: [
    { id: 'chrome-validation', app: 'Google Chrome', surface: 'native' },
    { id: 'chrome-validation-extension', app: 'Google Chrome', surface: 'extension' },
  ] });
  assert.equal(result.error, undefined);
  const rows = result.saved.at(-1).results;
  assert.equal(rows.length, 12);
  for (const row of rows) assert.equal(row.surface, row.task.endsWith('-extension') ? 'extension' : 'native');
});

test('generic default comparisons use the guarded lifecycle for every arm and propagate failures', async () => {
  const result = await runner({ suite: 'default', arm: 'sleight,mcp:rival', drive: true, outcome: { passed: false, code: 1 } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => call === 'real run').length, 6);
  assert.equal(result.exitCode, 1);
  assert.ok(result.tailScopes.every(scope => scope.ownedOnly));
  assert.ok(result.calls.filter(Array.isArray).filter(call => call[0] === 'driver').every(args => args.includes('--disallowedTools')));
});

test('generic comparisons isolate MCP while allowing the sleight mod connection', async () => {
  const result = await runner({ suite: 'default', arm: 'sleight,mcp:rival', drive: true, outcome: { passed: true } });
  assert.equal(result.error, undefined);
  const commands = result.calls.filter(call => Array.isArray(call) && call[0] === 'driver');
  assert.equal(commands.length, 6);
  for (const args of commands) {
    for (const flag of ['--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
    assert.equal(args.includes('--strict-mcp-config'), !args.includes('--plugin-dir'));
    for (const flag of ['--setting-sources', '--tools']) { assert.ok(args.includes(flag)); assert.equal(args[args.indexOf(flag) + 1], ''); }
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(args.includes('--append-system-prompt'), false);
    assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5');
    assert.equal(args[args.indexOf('--effort') + 1], 'high');
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    const settings = result.files.get(args[args.indexOf('--settings') + 1]);
    assert.match(settings.hooks.PermissionRequest[0].hooks[0].command, /deny-approval.mjs/);
    if (args.includes('--plugin-dir')) {
      const config = result.files.get(args[args.indexOf('--mcp-config') + 1]);
      assert.equal(config.mcpServers['plugin:sleight:computer'].command, '/fixture/plugins/sleight/bin/sleight-mcp');
      assert.deepEqual(settings.allowedMcpServers, [{ serverName: 'plugin:sleight:computer' }]);
      assert.equal(settings.hooks.Elicitation[0].matcher, '^plugin:sleight:computer$');
    }
  }
  assert.ok(result.driverOptions.every(options => options.format === 'stream-json'));
  assert.ok(result.envs.every(env => env.BENCH_APPROVAL_STOP && env.BENCH_ARM_SERVERS));
});

test('clean arms isolate sleight with a connection allowlist and record the setup', async () => {
  const clean = await runner({ suite: 'real', arm: 'sleight', cleanArms: true, drive: true, outcome: { passed: true } });
  assert.equal(clean.error, undefined);
  assert.equal(clean.saved.at(-1).armSetup, 'clean');
  const args = clean.calls.filter(call => Array.isArray(call) && call[0] === 'driver').at(-1).slice(1);
  assert.equal(args.includes('--strict-mcp-config'), false);
  assert.deepEqual(clean.files.get(args[args.indexOf('--settings') + 1]).allowedMcpServers, [{ serverName: 'plugin:sleight:computer' }]);
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  const config = clean.files.get(args[args.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ['plugin:sleight:computer']);
  assert.equal(config.mcpServers['plugin:sleight:computer'].command, '/fixture/plugins/sleight/bin/sleight-mcp');
  const normal = await runner({ suite: 'real', arm: 'sleight', drive: true, outcome: { passed: true } });
  assert.equal(normal.saved.at(-1).armSetup, 'normal');
  assert.equal(normal.calls.filter(call => Array.isArray(call) && call[0] === 'driver').at(-1).includes('--strict-mcp-config'), false);
});

test('clean private-mail launches retain the private trace and telemetry settings', async () => {
  const result = await runner({ privateMail: true, cleanArms: true, drive: true, outcome: { passed: true } });
  assert.equal(result.error, undefined);
  const args = result.calls.filter(call => Array.isArray(call) && call[0] === 'driver').at(-1);
  const settings = result.files.get(args[args.indexOf('--settings') + 1]);
  assert.equal(settings.env?.SLEIGHT_TRACE, '');
  assert.equal(settings.env.OTEL_LOG_TOOL_CONTENT, '0');
  assert.deepEqual(settings.allowedMcpServers, [{ serverName: 'plugin:sleight:computer' }]);
});

test('clean arms confirm the codex bench home configures only the engine server', async () => {
  const clean = await runner({ suite: 'real', arm: 'codex', cleanArms: true, drive: true, outcome: { passed: true }, codexServers: ['cua_repl'] });
  assert.equal(clean.error, undefined);
  assert.equal(clean.saved.at(-1).armSetup, 'clean');
  assert.deepEqual(clean.saved.at(-1).codexConfig, ['cua_repl']);
  const extra = await runner({ suite: 'real', arm: 'codex', cleanArms: true, codexServers: ['cua_repl', 'notes'] });
  assert.equal(extra.exitCode, 1);
  assert.match(extra.saved.at(-1).results[0].reason, /engine server/);
});

test('the summary table splits each arm\'s own CPU into sleight, the engine, the client and other', async () => {
  const footprint = { cpuSeconds: 6.41, group: { claude: 1, 'engine node': 2, node: 0.5, osascript: 0.25, 'mcp@latest': 0.4 },
    outside: { 'engine helper': 1.5, Calculator: 0.75 } };
  const result = await runner({ suite: 'default', arm: 'sleight,codex', footprint });
  assert.equal(result.error, undefined);
  assert.match(result.logs.join('\n'), /\| CPU sleight s \| CPU engine s \| CPU client s \| CPU other s \|/);
  const rows = result.logs.filter(log => /^\| (sleight|codex) \| fixture \|/.test(log));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /\| 0\.75 \| 3\.5 \| 1 \| 0\.4 \|/);
  assert.match(rows[1], /\| 0 \| 3\.5 \| 0 \| 2\.15 \|/);
});

test('sleight preflight refuses servers belonging to a generic comparison arm', async () => {
  const result = await runner({ arm: 'sleight,mcp:rival', drive: true, extraServer: 'rival' });
  assert.equal(result.driverOptions.length, 0);
  assert.equal(result.exitCode, 1);
  assert.match(result.saved.at(-1).results[0].reason, /also loads/);
});

for (const surface of ['hooks', 'LSP servers', 'agents']) test(`${surface} rejection is recorded before any preflight, fixture or live lock`, async () => {
  const result = await runner({ arm: 'plugin:rival', preparationError: `plugin ${surface} are unsupported in benchmark arms` });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 1);
  assert.equal(result.envs.length, 0);
  assert.equal(result.calls.includes('lock'), false);
  assert.equal(result.calls.includes('real run'), false);
  assert.ok(result.saved.at(-1).results[0].reason.includes(`plugin ${surface}`));
});

test('final answer wording does not override checks while structured approval denials stop', async () => {
  const normal = await runner({ arm: 'mcp:rival', drive: true, outcome: { passed: true }, driverOut: { result: '391. No permission dialog was required.' } });
  assert.equal(normal.error, undefined);
  assert.equal(normal.driverOptions.length, 3);
  assert.ok(normal.saved.at(-1).results.every(row => row.passed));
  for (const arm of ['mcp:rival,sleight', 'sleight,mcp:rival']) {
    const denial = await runner({ arm, drive: true, outcome: { passed: true }, driverOut: { permission_denials: [{ tool_name: 'fixture' }] } });
    assert.equal(denial.driverOptions.length, 1);
    assert.equal(denial.exitCode, 1);
    assert.match(denial.saved.at(-1).results[0].reason, /approval/);
  }
});

test('API credential preflight applies to generic and sleight arms alike', async () => {
  for (const arm of ['sleight', 'mcp:rival']) {
    const rejected = await runner({ arm, auth: apiAuth, keySource: 'oauth', drive: true });
    assert.equal(rejected.driverOptions.length, 0);
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.saved.at(-1).results[0].reason, /not the benchmark API key/);
    const accepted = await runner({ arm, auth: apiAuth, keySource: 'ANTHROPIC_API_KEY', drive: true });
    assert.equal(accepted.error, undefined);
    assert.ok(accepted.envs.every(env => env.ANTHROPIC_API_KEY === 'sk-ant-test' && env.ENABLE_CLAUDEAI_MCP_SERVERS === 'false'));
  }
});

test('a hold appearing during preflight stops before a task driver', async () => {
  const result = await runner({ suite: 'default', arm: 'mcp:rival', holdAfterPreflight: true });
  assert.equal(result.error, undefined); assert.equal(result.exitCode, 1);
  assert.equal(result.driverOptions.length, 0);
  assert.match(result.saved.at(-1).results[0].reason, /sleight-hold/);
});

test('generic dry discovery records commands without a model, live lock or host fixture', async () => {
  const result = await runner({ suite: 'default', arm: 'mcp:rival', dryRun: true, outcome: { dryRun: true } });
  assert.equal(result.error, undefined); assert.equal(result.driverOptions.length, 0);
  assert.equal(result.calls.includes('lock'), false);
  assert.ok(result.plan.results.every(row => row.dryRun && row.command.includes('--disallowedTools')));
  assert.equal(result.files.size, 0);
  assert.equal(result.directories.length, 0);
});

test('Calculator live conditions are checked under the lock before preflight and every arm driver', async () => {
  const result = await runner({ suite: 'default', arm: 'mcp:rival,sleight', calculatorGate: true, drive: true, outcome: { passed: true } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => call === 'Calculator observation').length, 7);
  assert.equal(result.saved.at(-1).liveConditions.length, 7);
  assert.equal(result.saved.at(-1).liveConditions[0].stage, 'preflight');
  assert.equal(result.calls.at(-1), 'unlock');
  const refusal = await runner({ arm: 'mcp:rival,sleight', calculatorGate: true, calculatorFailureAt: 1, drive: true });
  assert.equal(refusal.error, undefined);
  assert.equal(refusal.driverOptions.length, 0);
  assert.equal(refusal.envs.length, 0);
  assert.equal(refusal.exitCode, 1);
  assert.match(refusal.saved.at(-1).results[0].reason, /current Space/);
  assert.equal(refusal.calls.at(-1), 'unlock');
});

test('private mail runner publishes only hashed rows and keeps the driver ephemeral', async () => {
  const result = await runner({ privateMail: true, drive: true, base: { SLEIGHT_TRACE: '/private/trace' },
    outcome: { passed: true, prompt: 'private subject', reason: 'private label', stderr: 'private@example.test',
      out: { result: '{"answer":"private answer"}', num_turns: 2 } } });
  assert.equal(result.error, undefined);
  assert.equal(result.saved.at(-1).results.length, 3);
  for (const row of result.saved.at(-1).results) assert.deepEqual(Object.keys(row), ['arm', 'task', 'run', 'passed', 'seconds', 'turns', 'expectedHash', 'actualHash']);
  assert.equal(JSON.stringify(result.saved).includes('private answer'), false);
  assert.equal(result.logs.join().includes('private label'), false);
  for (const options of result.driverOptions) { assert.equal(options.privateMail, true); assert.equal(options.evidenceDir, undefined); }
  for (const args of result.calls.filter(call => Array.isArray(call) && call[0] === 'driver')) {
    assert.ok(args.includes('--no-session-persistence'));
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.equal(args[args.indexOf('--settings') + 1], '/fixture/bench/private-settings.json');
  }
  assert.equal(result.directories.some(dir => dir.includes('sleight-real-evidence')), false);
});

test('private mail preflight and chat setup-failure rows save without crashing the pass', async () => {
  const preflight = await runner({ privateMail: true, extraServer: 'lcu' });
  assert.equal(preflight.error, undefined);
  assert.equal(preflight.exitCode, 1);
  assert.equal(preflight.calls.includes('real run'), false);
  assert.ok(preflight.saved.length);
  assert.ok(preflight.saved.at(-1).results.length);
  for (const file of preflight.saved) {
    for (const row of file.results) assert.deepEqual(Object.keys(row).filter(key => !['arm', 'phase', 'passed'].includes(key)), []);
    assert.ok(file.results.every(row => row.passed === false));
  }
  assert.equal(JSON.stringify(preflight.saved).includes('lcu'), false);
  const slack = { id: 'slack-read', app: 'Slack', privateMail: true,
    privateExpected: () => 'Invented Author', privateTerms: () => ['private label'] };
  const setup = await runner({ privateMail: true, tasks: [slack], extraArgs: ['--tasks', 'slack-read'],
    outcome: { passed: false, reason: 'CHAT_NOT_RUNNING', fixtureDiagnostics: [{ app: 'Slack' }] } });
  assert.equal(setup.error, undefined);
  assert.equal(setup.exitCode, 1);
  assert.equal(setup.saved.at(-1).results.length, 3);
  for (const row of setup.saved.at(-1).results) {
    assert.equal(row.task, 'slack-read');
    assert.ok(Number.isSafeInteger(row.run) && row.run >= 1);
    assert.equal(row.passed, false);
    assert.deepEqual(Object.keys(row), ['arm', 'task', 'run', 'passed', 'seconds', 'turns', 'expectedHash', 'actualHash']);
  }
  assert.equal(JSON.stringify(setup.saved).includes('Invented'), false);
  assert.equal(JSON.stringify(setup.saved).includes('CHAT_NOT_RUNNING'), false);
});

test('private mail safety and keyboard stops suppress raw diagnostics', async () => {
  for (const extras of [{ outcome: { cleanupError: 'private label' } }, { taps: [{ app: 'Mimestream', pid: 123, error: 'private label' }] }, { throws: true }]) {
    const result = await runner({ privateMail: true, ...extras });
    assert.equal(result.error, undefined);
    assert.equal(result.saved.at(-1).results.length, 1);
    assert.equal(result.saved.at(-1).results[0].passed, false);
    assert.equal(JSON.stringify(result.saved).includes('private label'), false);
    assert.equal(result.logs.join().includes('private label'), false);
  }
});

test('fixture-only runner skips Claude initialization and retains the live pass lock', async () => {
  const result = await runner({ setupOnly: true, outcome: { passed: true } });
  assert.equal(result.error, undefined);
  assert.equal(result.envs.length, 0);
  assert.equal(result.calls.filter(call => call === 'lock').length, 1);
  assert.equal(result.calls.at(-1), 'unlock');
});

test('real and default preflight create the sleight arm directory before spawning', async () => {
  for (const suite of ['real', 'default']) {
    const result = await runner({ suite, base: { SLEIGHT_ARM_DIR: `${MAC_TMP}/new-sleight-arm` } });
    assert.equal(result.error, undefined);
    assert.ok(result.directories.includes(`${MAC_TMP}/new-sleight-arm`));
  }
});

test('failed real runs continue through keyboard checks and the common cleanup tail', async () => {
  const result = await runner({ outcome: { stopAfterAction: true } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(c => c === 'real run').length, 3);
  assert.equal(result.calls.filter(c => c === 'tap check').length, 3);
  assert.deepEqual(result.calls.slice(-4), ['TextEdit tail', 'Chess tail', 'Simulator tail', 'unlock']);
  assert.deepEqual(result.tailScopes.map(scope => scope?.ownedOnly), [true, true, true]);
});

test('real safety errors stop after one run but still execute the common cleanup tail', async () => {
  for (const outcome of [{ cleanupError: 'close failed' }, { permissionPrompt: true }, { permissionRefusal: true },
    { observerError: 'observer failed' }, { groupClean: false }, { appDialog: { app: 'Mail', category: 'first-run' } }]) {
    const result = await runner({ outcome });
    assert.equal(result.calls.filter(c => c === 'real run').length, 1);
    assert.deepEqual(result.calls.slice(-4), ['TextEdit tail', 'Chess tail', 'Simulator tail', 'unlock']);
  }
});

test('permission and driver stops never retry the legacy force-quit path', async () => {
  for (const outcome of [{ permissionPrompt: true }, { groupClean: false }]) {
    let quits = 0;
    const lease = { app: 'DeviceHub', running: false, launched: true, quit: async options => {
      assert.equal(options.final, true); quits++;
    } };
    const result = await runner({ outcome, leases: [lease] });
    assert.equal(result.error, undefined);
    assert.equal(quits, 0);
    assert.equal(result.calls.at(-1), 'unlock');
  }
});

test('the default simulator uses streaming permission detection and publishes scrubbed fixture diagnostics', async () => {
  const result = await runner({ suite: 'default', fixtureLifecycle: true, drive: true, ownerName: 'Owner Example',
    outcome: { fixtureDiagnostics: [{ readiness: { title: 'Owner Example iPhone', path: '/owner/fixture' }, pids: [42, 43] }] } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => call === 'real run').length, 3);
  for (const options of result.driverOptions) assert.equal(options.format, 'stream-json');
  for (const args of result.calls.filter(call => Array.isArray(call) && call[0] === 'driver')) {
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(args.includes('--verbose'));
  }
  assert.equal(JSON.stringify(result.saved).includes('Owner Example'), false);
  assert.equal(JSON.stringify(result.saved).includes('/owner/'), false);
  assert.deepEqual(result.saved.at(-1).results[0].fixtureDiagnostics[0].pids, [42, 43]);
  assert.equal(result.tailScopes[2]?.ownedOnly, true);
});

test('a default simulator cleanup failure stops the pass without retrying force quit', async () => {
  let quits = 0;
  const result = await runner({ suite: 'default', fixtureLifecycle: true, outcome: { cleanupError: 'close failed' },
    leases: [{ app: 'DeviceHub', running: false, launched: true, quit: async () => { quits++; } }] });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => call === 'real run').length, 1);
  assert.equal(quits, 0);
  assert.equal(result.saved.at(-1).results[0].passed, false);
});

test('pass cleanup preserves pre-existing apps and publishes refused gentle cleanup as leftWindows', async () => {
  const existing = { app: 'Safari', running: true, launched: true, quit: () => assert.fail('preserve pre-existing app') };
  const launched = { app: 'Preview', running: false, launched: true, quit: async () => { throw new Error('quit unconfirmed'); } };
  const result = await runner({ outcome: { permissionPrompt: true }, leases: [existing, launched],
    hygieneResult: { leftWindows: [{ pid: 7, id: 42 }], errors: ['quit unconfirmed'] } });
  assert.deepEqual(result.saved.at(-1).leftWindows, [{ pid: 7, id: 42 }]);
  assert.equal(result.saved.at(-1).results[0].passed, false);
});

test('runner binds suite approvals and forces real computer access in preflight and driver', async () => {
  const real = await runner({ base: { BENCH_SUITE: 'default', SLEIGHT_SURFACES: 'browser' }, drive: true });
  assert.equal(real.error, undefined);
  assert.equal(real.envs.length, 4);
  for (const env of real.envs) {
    assert.equal(env.BENCH_SUITE, 'real'); assert.equal(env.SLEIGHT_SURFACES, 'computer');
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  }
  const standard = await runner({ suite: 'default', base: { BENCH_SUITE: 'real', SLEIGHT_SURFACES: 'browser' } });
  assert.equal(standard.error, undefined);
  for (const env of standard.envs) { assert.equal(env.BENCH_SUITE, 'default'); assert.equal(env.SLEIGHT_SURFACES, 'browser'); }
});

test('every arm runs with the ghost hand off, even when the host env turns it on', async () => {
  for (const suite of ['real', 'default']) {
    const result = await runner({ suite, base: { SLEIGHT_HAND: '1' }, drive: true });
    assert.equal(result.error, undefined);
    assert.ok(result.envs.length > 0);
    for (const env of result.envs) assert.equal(env.SLEIGHT_HAND, '0', suite);
  }
});

test('SLEIGHT_BENCH_HAND=1 turns the hand on in every arm and marks the pass; any other value stops it', async () => {
  for (const suite of ['real', 'default']) {
    const result = await runner({ suite, base: { SLEIGHT_BENCH_HAND: '1' }, drive: true });
    assert.equal(result.error, undefined);
    assert.ok(result.envs.length > 0);
    for (const env of result.envs) assert.equal(env.SLEIGHT_HAND, '1', suite);
    assert.equal(result.saved.at(-1).ghostHand, 'on', suite);
    assert.ok(result.saved.at(-1).results.length && result.saved.at(-1).results.every(row => row.ghostHand === 'on'), suite);
    assert.ok(result.logs.some(line => /Ghost hand on/.test(line)), suite);
  }
  const off = await runner({ suite: 'real', base: { SLEIGHT_BENCH_HAND: '0' }, drive: true });
  assert.equal(off.saved.at(-1).ghostHand, 'off');
  assert.ok(off.saved.at(-1).results.every(row => !('ghostHand' in row)));
  for (const env of off.envs) assert.equal(env.SLEIGHT_HAND, '0');
  const bad = await runner({ suite: 'real', base: { SLEIGHT_BENCH_HAND: 'yes' } });
  assert.match(String(bad.error?.message), /SLEIGHT_BENCH_HAND must be 0 or 1/);
});

test('--surfaces browser,computer reaches every real-suite run and the results; anything else is refused', async () => {
  const both = await runner({ drive: true, extraArgs: ['--surfaces', 'browser,computer'] });
  assert.equal(both.error, undefined);
  for (const env of both.envs) assert.equal(env.SLEIGHT_SURFACES, 'browser,computer');
  assert.equal(both.saved.at(-1).surfaces, 'browser,computer');
  const bad = await runner({ extraArgs: ['--surfaces', 'browser'] });
  assert.match(String(bad.error?.message), /--surfaces must be/);
});

test('codex-no-write skips rewriting ChatGPT\'s Always allow list', async () => {
  const result = await runner({ suite: 'default', arm: 'codex', extraArgs: ['--codex-no-write'] });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.some(c => Array.isArray(c) && c[0] === 'approve'), false);
});

test('Codex default approvals contain only the five core benchmark bundle IDs', async () => {
  const result = await runner({ suite: 'default', arm: 'codex' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls.find(c => Array.isArray(c) && c[0] === 'approve'),
    ['approve', 'com.apple.calculator', 'com.apple.TextEdit', 'com.apple.Chess', 'com.apple.iphonesimulator', 'com.apple.dt.Devices']);
  assert.deepEqual(result.tailScopes.map(scope => scope?.ownedOnly), [true, true, true]);
  // The snapshot planner replaces unscoped cleanup; legacy tails require owned references.
  assert.equal(result.tailScopes[0]?.quit, undefined);
});

test('a Codex real run drives through Codex with the real apps approved and the pass signal', async () => {
  const result = await runner({ arm: 'codex', drive: true });
  assert.equal(result.error, undefined);
  const approved = result.calls.find(c => Array.isArray(c) && c[0] === 'approve');
  assert.ok(approved.includes('com.apple.Safari') && approved.includes('com.apple.calculator'));
  assert.ok(result.codexRuns.length > 0);
  for (const run of result.codexRuns) { assert.equal(run.prompt, 'task'); assert.ok(run.options.signal, 'an abort reaches Codex'); }
  assert.ok(!result.calls.some(c => Array.isArray(c) && c[0] === 'driver'), 'Claude never runs for the Codex arm');
});

for (const [label, arm, extraArgs, armLabel, model] of [
  ['codex defaults to gpt-6-luna', 'codex', [], 'codex', 'gpt-6-luna'],
  ['codex with gpt-6.1-sol is recorded as the codex-sol arm', 'codex', ['--codex-model', 'gpt-6.1-sol'], 'codex-sol', 'gpt-6.1-sol'],
  ['the codex-sol arm runs gpt-6.1-sol', 'codex-sol', [], 'codex-sol', 'gpt-6.1-sol'],
]) test(`${label}, and rows say which`, async () => {
  const result = await runner({ arm, drive: true, extraArgs, outcome: { passed: true } });
  assert.equal(result.error, undefined);
  assert.ok(result.codexRuns.length > 0);
  for (const run of result.codexRuns) assert.equal(run.options.model, model);
  const file = result.saved.at(-1);
  assert.deepEqual(file.arms, [armLabel]);
  assert.deepEqual(file.codexModels, { [armLabel]: model });
  assert.ok(file.results.length > 0);
  for (const row of file.results) { assert.equal(row.arm, armLabel); assert.equal(row.codexModel, model); }
});

test('the codex-sol arm refuses another model, and luna and sol sit side by side as two arms', async () => {
  const bad = await runner({ arm: 'codex-sol', extraArgs: ['--codex-model', 'gpt-6-luna'] });
  assert.match(String(bad.error?.message), /codex-sol arm runs gpt-6\.1-sol/);
  const both = await runner({ arm: 'codex,codex-sol', drive: true, outcome: { passed: true } });
  assert.equal(both.error, undefined);
  assert.deepEqual(both.saved.at(-1).codexModels, { codex: 'gpt-6-luna', 'codex-sol': 'gpt-6.1-sol' });
  assert.deepEqual([...new Set(both.codexRuns.map(run => run.options.model))].sort(), ['gpt-6-luna', 'gpt-6.1-sol']);
});

// sleight inside Codex as its MCP plugin (LAWS, 2026-10-18): codex-sleight on gpt-6-luna, codex-sleight-sol on gpt-6.1-sol.
for (const [label, arm, extraArgs, armLabel, model] of [
  ['codex-sleight defaults to gpt-6-luna', 'codex-sleight', [], 'codex-sleight', 'gpt-6-luna'],
  ['codex-sleight with gpt-6.1-sol is recorded as codex-sleight-sol', 'codex-sleight', ['--codex-model', 'gpt-6.1-sol'], 'codex-sleight-sol', 'gpt-6.1-sol'],
  ['the codex-sleight-sol arm runs gpt-6.1-sol', 'codex-sleight-sol', [], 'codex-sleight-sol', 'gpt-6.1-sol'],
]) test(`${label}, from its own Codex home with only sleight's server and the engine's list untouched`, async () => {
  const result = await runner({ arm, drive: true, extraArgs, outcome: { passed: true } });
  assert.equal(result.error, undefined);
  assert.ok(result.codexRuns.length > 0);
  for (const run of result.codexRuns) { assert.equal(run.options.model, model); assert.equal(run.options.home, '/owner/.codex-bench-sleight'); }
  const file = result.saved.at(-1);
  assert.deepEqual(file.arms, [armLabel]);
  assert.deepEqual(file.codexModels, { [armLabel]: model });
  assert.equal(file.armMetadata[armLabel].codexHome, '~/.codex-bench-sleight');
  for (const row of file.results) { assert.equal(row.arm, armLabel); assert.equal(row.codexModel, model); }
  assert.ok(!result.calls.some(call => Array.isArray(call) && call[0] === 'approve'), 'the engine\'s Always allow list is not touched');
  assert.ok(result.calls.includes('codex sleight home'));
  assert.equal(result.codexConfigs.length, result.codexRuns.length, 'each run writes its own servers first');
  for (const toml of result.codexConfigs) {
    assert.deepEqual(toml.match(/^\[mcp_servers\.[^\].]+\]/gm), ['[mcp_servers.plugin_sleight_computer]']);
    assert.ok(toml.includes(`model = "${model}"`) && toml.includes('--policy", "bench"') && toml.includes('SLEIGHT_APPROVAL_PROMPT = "client"'));
  }
});

test('a prompt outside the allowlist stops a sleight-in-Codex pass as it stops a Claude-hosted arm', async () => {
  const result = await runner({ arm: 'codex-sleight', drive: true, outcome: { passed: true }, declinedPrompts: ['Allow Computer Use to use "Terminal"?'] });
  const row = result.saved.at(-1).results[0];
  assert.equal(row.passed, false);
  assert.match(row.reason, /^unsupported approval/);
});

test('the engine list is set once for a native Codex arm beside a sleight-in-Codex arm', async () => {
  const result = await runner({ arm: 'codex,codex-sleight', drive: true, outcome: { passed: true } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => Array.isArray(call) && call[0] === 'approve').length, 1);
  assert.deepEqual([...new Set(result.codexRuns.map(run => run.options.home))].sort(), ['/owner/.codex-bench-sleight', undefined].sort());
});

// ROADMAP 4b: the native claim (9 tasks plus VS Code, Slack and Spotify) with GPT inside sleight against Codex out of the box.
const NATIVE_CLAIM = [...readFileSync(new URL('../bench/claim-tasks.txt', import.meta.url), 'utf8').trim().split(','), 'vscode-edit', 'slack-post', 'spotify-play'];
const GPT_ARMS = [['codex', 'gpt-6-luna', '/owner/.codex-bench'], ['codex-sol', 'gpt-6.1-sol', '/owner/.codex-bench'],
  ['codex-sleight', 'gpt-6-luna', '/owner/.codex-bench-sleight'], ['codex-sleight-sol', 'gpt-6.1-sol', '/owner/.codex-bench-sleight']];

test('native claim dry plan: a row per GPT arm, task and run, each with its codex exec command, home and servers, and nothing launched', async () => {
  const result = await runner({ suite: 'world', arm: GPT_ARMS.map(([arm]) => arm).join(','), dryRun: true, extraArgs: ['--codex-effort', 'high'],
    tasks: NATIVE_CLAIM.map(id => ({ id, app: 'TextEdit', fixtureLifecycle: true })) });
  assert.equal(result.error, undefined);
  assert.equal(NATIVE_CLAIM.length, 12);
  assert.equal(result.plan.results.length, 4 * 12 * 3);
  assert.deepEqual(result.plan.sleight, { commit: 'c0ffee1234', dirty: true });
  for (const [arm, model, home] of GPT_ARMS) {
    const rows = result.plan.results.filter(row => row.arm === arm);
    assert.deepEqual([...new Set(rows.map(row => row.task))], NATIVE_CLAIM);
    for (const row of rows) {
      assert.deepEqual([row.dryRun, row.runner, row.model, row.effort, row.codexHome], [true, 'runCodex', model, 'high', home], arm);
      assert.deepEqual(row.command, ['codex', ...codexExecPlan('<fixture task prompt>', { cwd: `/owner/Library/Caches/sleight-bench/${arm.startsWith('codex-sleight') ? 'codex-sleight-arm' : 'codex-arm'}`, model, effort: 'high' })]);
      if (home.endsWith('-sleight')) assert.deepEqual(row.servers, ['plugin_sleight_computer']);
      else assert.match(row.servers, /engine server/);
    }
  }
  assert.deepEqual([result.commands, result.directories, result.saved, result.codexConfigs, result.codexRuns], [[], [], [], [], []]);
  assert.ok(!result.calls.some(call => call === 'codex sleight home' || call === 'lock' || (Array.isArray(call) && call[0] === 'approve')));
});

test('each GPT row records the model and effort Codex ran, its CLI version, sleight\'s commit and, inside sleight, the approval log', async () => {
  const codexResult = { modelsRan: ['gpt-6.1-sol'], effortsRan: ['high'], codexCliVersion: '0.160.0', toolServers: { plugin_sleight_computer: 3 } };
  const result = await runner({ suite: 'world', arm: 'codex-sol,codex-sleight-sol', drive: true, outcome: { passed: true }, codexResult, extraArgs: ['--owner-away'] });
  assert.equal(result.error, undefined);
  const file = result.saved.at(-1);
  assert.deepEqual([file.sleight, file.codexCliVersions, file.codexEffort], [{ commit: 'c0ffee1234', dirty: true }, ['0.160.0'], 'high']);
  assert.equal(file.engineAllowList, 'benchmark apps for the pass', 'a plain Codex arm in the pass sets the engine list for all of it');
  const alone = await runner({ suite: 'world', arm: 'codex-sleight-sol', drive: true, outcome: { passed: true }, codexResult, extraArgs: ['--owner-away'] });
  assert.equal(alone.saved.at(-1).engineAllowList, 'untouched');
  assert.ok(file.results.every(row => !('modelMismatch' in row)));
  const other = await runner({ suite: 'world', arm: 'codex-sleight-sol', drive: true, outcome: { passed: true }, codexResult: { ...codexResult, modelsRan: ['gpt-6-luna'] }, extraArgs: ['--owner-away'] });
  assert.ok(other.saved.at(-1).results.every(row => row.modelMismatch === true && row.modelsRan[0] === 'gpt-6-luna'), 'a run that ran another model is published with it and flagged');
  assert.ok(other.logs.some(line => /asked for gpt-6\.1-sol, Codex ran gpt-6-luna/.test(line)));
  for (const row of file.results) {
    assert.deepEqual([row.sleightCommit, row.sleightDirty, row.codexModel, row.modelsRan, row.effortsRan, row.codexCliVersion], ['c0ffee1234', true, 'gpt-6.1-sol', ['gpt-6.1-sol'], ['high'], '0.160.0'], row.arm);
    if (row.arm === 'codex-sleight-sol') assert.deepEqual(row.approvals.log.map(entry => entry.action), ['accept']);
    else assert.equal(row.approvals, undefined);
  }
});

test('a sleight-in-Codex home that lists any server beyond the run\'s own stops the pass before the fixture or Codex starts', async () => {
  for (const suite of ['world', 'default']) {
    const result = await runner({ suite, arm: 'codex-sleight', drive: true, outcome: { passed: true }, extraArgs: ['--owner-away'],
      sleightHomeServers: ['plugin_sleight_computer', 'cua_repl'] });
    assert.equal(result.error, undefined, suite);
    const rows = result.saved.at(-1).results;
    assert.equal(rows.length, 1, 'the first run stops the pass');
    assert.deepEqual([rows[0].phase, rows[0].passed, rows[0].seconds], ['configuration', false, undefined]);
    assert.match(rows[0].reason, /configures plugin_sleight_computer, cua_repl, not only plugin_sleight_computer/);
    assert.deepEqual([result.codexRuns.length, result.calls.includes('real run'), result.exitCode], [0, false, 1]);
  }
});

test('a sleight-in-Codex run that called another MCP server fails, and a run at another effort is flagged', async () => {
  const stray = await runner({ suite: 'world', arm: 'codex-sleight', drive: true, outcome: { passed: true }, extraArgs: ['--owner-away'],
    codexResult: { toolServers: { plugin_sleight_computer: 2, cua_repl: 1 } } });
  const row = stray.saved.at(-1).results[0];
  assert.deepEqual([row.passed, row.reason], [false, 'used MCP server cua_repl']);
  const plain = await runner({ suite: 'world', arm: 'codex', drive: true, outcome: { passed: true }, extraArgs: ['--owner-away'], codexResult: { toolServers: { cua_repl: 3 } } });
  assert.equal(plain.saved.at(-1).results[0].passed, true, 'the plain arm\'s engine server is its own');
  const effort = await runner({ suite: 'world', arm: 'codex-sleight', drive: true, outcome: { passed: true }, extraArgs: ['--owner-away'], codexResult: { effortsRan: ['medium'] } });
  assert.equal(effort.saved.at(-1).results[0].effortMismatch, true);
});

test('the plain codex arm is unchanged: the bench home, the engine list set for the pass, no sleight config, the same exec flags', async () => {
  const result = await runner({ suite: 'world', arm: 'codex', drive: true, outcome: { passed: true }, extraArgs: ['--owner-away'] });
  assert.equal(result.error, undefined);
  assert.ok(result.codexRuns.length > 0);
  for (const run of result.codexRuns) { assert.equal(run.options.home, undefined, 'runCodex falls back to ~/.codex-bench'); assert.equal(run.options.model, 'gpt-6-luna'); }
  assert.equal(result.calls.filter(call => Array.isArray(call) && call[0] === 'approve').length, 1);
  assert.deepEqual(result.codexConfigs, []);
  assert.ok(!result.calls.includes('codex sleight home'));
  assert.deepEqual(codexExecPlan('p', { cwd: '/arm', model: 'gpt-6-luna', effort: 'high' }),
    ['exec', '--json', '-s', 'read-only', '--disable', 'shell_tool', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="high"', '--skip-git-repo-check', '-C', '/arm', 'p']);
});

test('a real run where Codex used a shell or edited a file fails even when its check passed', async () => {
  const result = await runner({ arm: 'codex', outcome: { passed: true, forbidden: ['command_execution', 'command_execution'] } });
  const row = result.saved.at(-1).results[0];
  assert.equal(row.passed, false); assert.equal(row.reason, 'used command_execution');
  assert.equal('forbidden' in row, false);
});

test('a private mail pass still refuses the Codex arm', async () => {
  const result = await runner({ arm: 'sleight,codex', privateMail: true });
  assert.match(result.error?.message ?? '', /Mimestream and chat tasks require a separate sleight-only pass/);
});

test('a real Safari keyboard tap stops further runs after recording the tap', async () => {
  const result = await runner({ outcome: { passed: true }, taps: [{ app: 'Safari', pid: 123 }] });
  assert.equal(result.calls.filter(c => c === 'real run').length, 1);
  assert.equal(result.saved.at(-1).results[0].keyboardTaps[0].app, 'Safari');
  assert.deepEqual(result.calls.slice(-4), ['TextEdit tail', 'Chess tail', 'Simulator tail', 'unlock']);
});

test('Office and Mail keyboard taps stop the real pass after cleanup', async () => {
  for (const app of ['Word', 'Microsoft Word', 'Excel', 'Microsoft Excel', 'PowerPoint', 'Microsoft PowerPoint', 'Mail', 'Mimestream']) {
    const result = await runner({ outcome: { passed: true }, taps: [{ app, pid: 123 }] });
    assert.equal(result.calls.filter(c => c === 'real run').length, 1, app);
    assert.equal(result.saved.at(-1).results[0].keyboardTaps[0].app, app);
  }
});

test('an unexpected real run exception still runs the cleanup tail and releases the lock', async () => {
  const result = await runner({ throws: true });
  assert.match(result.error?.message, /unexpected run failure/);
  assert.deepEqual(result.calls.slice(-4), ['TextEdit tail', 'Chess tail', 'Simulator tail', 'unlock']);
});

test('real cleanup tails never inspect unrelated apps and Simulator awaits only its retained lease', async () => {
  const source = readFileSync(new URL('../bench/tasks.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export \{.*\} from .*;\n/gm, '').replace(/^export /gm, '');
  const cleanup = runInNewContext(`${source}\n({closeBenchTextEdit, quitChess, quitSimApp})`, {
    webBrowsers,
    join, tmpdir: () => `${MAC_TMP}`, realpathSync: path => path,
    execFileSync: () => assert.fail('no host app inventory or action without an owned lease'),
  });
  cleanup.closeBenchTextEdit({ ownedOnly: true });
  cleanup.quitChess({ ownedOnly: true });
  await cleanup.quitSimApp({ ownedOnly: true });
  let quit = false;
  await cleanup.quitSimApp({ ownedOnly: true, lease: { quit: async () => { await Promise.resolve(); quit = true; } } });
  assert.equal(quit, true);
});

test('a TextEdit task refuses to start next to a document the pass did not open', () => {
  const source = readFileSync(new URL('../bench/tasks.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export \{.*\} from .*;\n/gm, '').replace(/^export /gm, '');
  for (const [docs, refused] of [[[{ name: 'Untitled 9', path: `${MAC_USERS}x/Library/Mobile Documents/Untitled 9.txt` }], true], [[], false]]) {
    const actions = [];
    const tasks = runInNewContext(`${source}\n({ freshTextEdit })`, {
      webBrowsers,
      join, tmpdir: () => `${MAC_TMP}`, realpathSync: path => path,
      execFileSync: (command, args) => {
        if (command === 'osascript' && args.some(a => String(a).includes('documents().map'))) return JSON.stringify(docs);
        actions.push(command); return '';
      },
    });
    if (refused) {
      assert.throws(() => tasks.freshTextEdit(), /1 document this pass didn't open/);
      assert.deepEqual(actions, [], 'the user\'s document is never closed and TextEdit never quit');
    } else tasks.freshTextEdit();
  }
});

function textEditHelpers(execFileSync) {
  const source = readFileSync(new URL('../bench/tasks.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export \{.*\} from .*;\n/gm, '').replace(/^export /gm, '');
  return runInNewContext(`${source}\n({ freshTextEdit, closeBenchTextEdit, launchBenchTextEdit })`, {
    webBrowsers,
    join, tmpdir: () => `${MAC_TMP}`, realpathSync: path => path, execFileSync,
  });
}

const TEXTEDIT_LAUNCH = ['-g', '-a', 'TextEdit', '--args', '-ApplePersistenceIgnoreState', 'YES',
  '-NSDocumentSaveNewDocumentsToCloud', 'NO', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO'];

test('the last TextEdit quit after a forced relaunch is retried until TextEdit is gone', () => {
  const source = readFileSync(new URL('../bench/tasks.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export \{.*\} from .*;\n/gm, '').replace(/^export /gm, '');
  // Every quit is ignored until the relaunch, and the first quit after it is dropped too.
  let running = true, relaunched = false, quitsAfter = 0;
  const tasks = runInNewContext(`${source}\n({ closeBenchTextEdit })`, {
    webBrowsers,
    join, tmpdir: () => `${MAC_TMP}`, realpathSync: path => path,
    execFileSync: (command, args) => {
      if (command === 'pgrep') { if (running) return ''; throw new Error('none'); }
      if (command === 'osascript' && args.some(a => String(a).includes('documents().map'))) return running ? JSON.stringify([{ name: 'a', path: `${MAC_TMP}/sleight-bench/a.txt` }]) : '[]';
      if (command === 'osascript' && args.some(a => String(a).includes('to quit'))) { if (relaunched && ++quitsAfter === 2) running = false; return ''; }
      if (command === 'pkill') { running = false; return ''; }
      if (command === 'open') { running = true; relaunched = true; return ''; }
      return '';
    },
  });
  assert.equal(tasks.closeBenchTextEdit({ quit: true }), true);
  assert.equal(running, false);
  assert.equal(quitsAfter, 2);
});

test('launchBenchTextEdit opens TextEdit in the background with per-launch arguments only', () => {
  const calls = [];
  const tasks = textEditHelpers((command, args) => { calls.push([command, [...args]]); return ''; });
  assert.equal(typeof tasks.launchBenchTextEdit, 'function');
  tasks.launchBenchTextEdit();
  assert.deepEqual(calls, [['open', TEXTEDIT_LAUNCH]]);
  assert.ok(!calls.some(([command]) => command === 'defaults'));
});

test('a TextEdit task launches TextEdit with persistence and iCloud flags and leaves it running', () => {
  const commands = [], opens = [];
  const tasks = textEditHelpers((command, args) => {
    commands.push([command, [...args]]);
    if (command === 'osascript' && args.some(a => String(a).includes('documents().map'))) return '[]';
    if (command === 'open') opens.push([...args]);
    if (command === 'pgrep') throw new Error('none');
    return '';
  });
  tasks.freshTextEdit();
  assert.deepEqual(opens.at(-1), TEXTEDIT_LAUNCH);
  const lastOpen = commands.findLastIndex(([command]) => command === 'open');
  assert.ok(lastOpen >= 0);
  assert.ok(!commands.slice(lastOpen + 1).some(([command, args]) => command === 'osascript' && args.some(a => String(a).includes('to quit'))));
  assert.ok(!commands.some(([command]) => command === 'defaults'));
});

test('a TextEdit task closes the launch document unsaved and leaves TextEdit running', () => {
  let launched = false, closed = [];
  const tasks = textEditHelpers((command, args) => {
    const script = args.map(String).join(' ');
    if (command === 'open') { launched = true; return ''; }
    if (command === 'osascript' && script.includes('documents().map')) return launched && !closed.length ? JSON.stringify([{ name: 'Untitled', path: null }]) : '[]';
    if (command === 'osascript' && script.includes('close({ saving: "no" })')) { closed.push(script); return ''; }
    if (command === 'osascript' && script.includes('to quit')) throw new Error('quit after launch');
    if (command === 'pgrep') throw new Error('none');
    return '';
  });
  tasks.freshTextEdit();
  assert.equal(closed.length, 1);
  assert.match(closed[0], /"Untitled"/);
});

test('the forced TextEdit relaunch after a hung quit uses the same launch flags', () => {
  let running = true, relaunched = false;
  const opens = [];
  const tasks = textEditHelpers((command, args) => {
    if (command === 'pgrep') { if (running) return ''; throw new Error('none'); }
    if (command === 'osascript' && args.some(a => String(a).includes('documents().map'))) return running ? JSON.stringify([{ name: 'a', path: `${MAC_TMP}/sleight-bench/a.txt` }]) : '[]';
    if (command === 'osascript' && args.some(a => String(a).includes('to quit'))) return '';
    if (command === 'pkill') { running = false; return ''; }
    if (command === 'open') { running = true; relaunched = true; opens.push([...args]); return ''; }
    return '';
  });
  tasks.closeBenchTextEdit({ quit: true });
  assert.equal(relaunched, true);
  assert.deepEqual(opens, [TEXTEDIT_LAUNCH]);
});

const apiAuth = { mode: 'api', env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, unset: ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], spent: 0, capUsd: 150 };

test('API mode gives every Claude run the key, drops other tokens, and checks the preflight used it', async () => {
  const result = await runner({ suite: 'default', auth: apiAuth, keySource: 'ANTHROPIC_API_KEY',
    base: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_AUTH_TOKEN: 'token' } });
  assert.equal(result.error, undefined);
  assert.ok(result.envs.length > 1);
  for (const env of result.envs) {
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env) && !('ANTHROPIC_AUTH_TOKEN' in env));
  }
  assert.equal(result.saved.at(-1).auth, 'api');
  assert.ok(result.calls.some(c => Array.isArray(c) && c[0] === 'spend' && c[1] === 0.25));
  const wrong = await runner({ suite: 'default', auth: apiAuth, keySource: 'none' });
  assert.match(wrong.saved.at(-1).results[0].reason, /not the benchmark API key/);
});

test('a run that reaches the API cap stops the pass', async () => {
  const result = await runner({ suite: 'default', auth: apiAuth, keySource: 'ANTHROPIC_API_KEY', spend: () => 150 });
  assert.ok(result.logs.some(line => /at the \$150 cap/.test(line)));
  assert.equal(result.calls.filter(c => Array.isArray(c) && c[0] === 'spend').length, 1);
});

test('login mode records no spend and passes no key', async () => {
  const result = await runner({ suite: 'default' });
  assert.equal(result.error, undefined);
  assert.ok(!result.calls.some(c => Array.isArray(c) && c[0] === 'spend'));
  for (const env of result.envs) assert.ok(!('ANTHROPIC_API_KEY' in env));
  assert.equal(result.saved.at(-1).auth, 'login');
});

test('default real selection skips shop smoke tasks, and selecting them requires --runs 1', async () => {
  const stub = id => ({ id, app: 'Safari', setup() {}, prompt: () => 'task', check: () => true, cleanup() {} });
  const shop = stub('safari-shop');
  const smoke = { ...stub('real-shop-target'), smoke: true };
  const excluded = await runner({ suite: 'real', tasks: [shop, smoke] });
  assert.equal(excluded.error, undefined);
  assert.equal(excluded.calls.filter(call => call === 'real run').length, 3);
  assert.ok(excluded.saved.at(-1).results.every(row => row.task === 'safari-shop'));
  const refused = await runner({ suite: 'real', tasks: [shop, smoke], extraArgs: ['--tasks', 'real-shop-target'] });
  assert.match(refused.error?.message ?? '', /runs 1/);
});

const OWNER_PRESENT_IDS = ['mail-folder', 'mail-message', 'mail-thread', 'mail-attachment', 'mail-search',
  'mimestream-label', 'mimestream-message', 'mimestream-thread', 'mimestream-scroll', 'mimestream-search',
  'slack-read', 'discord-read', 'whatsapp-read', 'iphone-mirroring-settings'];

test('default real selection skips iPhone Mirroring, and selecting it requires --owner-present', async () => {
  const stub = id => ({ id, app: 'Safari', setup() {}, prompt: () => 'task', check: () => true, cleanup() {} });
  const shop = stub('safari-shop');
  const iphone = { ...stub('iphone-mirroring-settings'), app: 'iPhone Mirroring', ownerPresent: true, noScreenshot: true };
  const excluded = await runner({ suite: 'real', tasks: [shop, iphone] });
  assert.equal(excluded.error, undefined);
  assert.equal(excluded.calls.filter(call => call === 'real run').length, 3);
  assert.ok(excluded.saved.at(-1).results.every(row => row.task === 'safari-shop'));
  const refused = await runner({ suite: 'real', tasks: [shop, iphone], extraArgs: ['--tasks', 'iphone-mirroring-settings'] });
  assert.match(refused.error?.message ?? '', /owner-present/);
  const both = await runner({ extraArgs: ['--owner-away', '--owner-present'] });
  assert.match(both.error?.message ?? '', /owner-present/);
});

test('the owner-account Mail, Mimestream, chat and iPhone Mirroring tasks run only with --owner-present', () => {
  const all = getTasks('real');
  for (const task of all) {
    assert.equal(task.ownerPresent === true, OWNER_PRESENT_IDS.includes(task.id),
      `${task.id} ownerPresent flag`);
  }
  const selected = selectSuiteTasks(all);
  assert.ok(selected.every(task => !task.ownerPresent));
  assert.deepEqual(selectSuiteTasks(all, OWNER_PRESENT_IDS).map(task => task.ownerPresent),
    OWNER_PRESENT_IDS.map(() => true));
});

test('an --owner-away pass refuses owner-present tasks before the live lock or any app operation', async () => {
  const stub = id => ({ id, app: 'Safari', setup() {}, prompt: () => 'task', check: () => true, cleanup() {} });
  const iphone = { ...stub('iphone-mirroring-settings'), ownerPresent: true };
  const refused = await runner({ suite: 'real', tasks: [iphone], extraArgs: ['--tasks', 'iphone-mirroring-settings', '--owner-away'] });
  assert.match(refused.error?.message ?? '', /owner-present tasks \(iPhone Mirroring, Mail, Mimestream and chat reads\)/);
  assert.ok(!refused.calls.includes('real run') && !refused.calls.includes('lock'), JSON.stringify(refused.calls));
  // Without selecting them, an --owner-away pass skips owner-present tasks instead of refusing.
  const skipped = await runner({ suite: 'real', tasks: [iphone, stub('safari-shop')], extraArgs: ['--owner-away'] });
  assert.equal(skipped.error, undefined);
  assert.ok(skipped.saved.at(-1).results.every(row => row.task === 'safari-shop'));
});

test('iPhone Mirroring published rows keep the answer and timings and omit screenshots', async () => {
  const iphone = {
    id: 'iphone-mirroring-settings', app: 'iPhone Mirroring', ownerPresent: true, noScreenshot: true,
    setup() {}, prompt: () => 'task', check: () => true, cleanup() {},
  };
  const result = await runner({
    suite: 'real', tasks: [iphone], drive: true, extraArgs: ['--owner-present', '--tasks', 'iphone-mirroring-settings'],
    outcome: { passed: true, screenshot: { bytes: Buffer.alloc(800, 1) }, timing: { modelMs: 1200 } },
    driverOut: { result: '18.6.2', num_turns: 6 },
  });
  assert.equal(result.error, undefined);
  const row = result.saved.at(-1).results[0];
  assert.equal(result.saved.at(-1).ownerPresent, true);
  assert.equal(row.task, 'iphone-mirroring-settings');
  assert.equal(row.answer, '18.6.2');
  assert.deepEqual(row.timing, { modelMs: 1200 });
  assert.equal(row.screenshot, undefined);
  assert.ok(result.envs.every(env => !env.SLEIGHT_TRACE));
});

test('arms never inherit the host Claude session that started the pass', async () => {
  // Started from a desktop session, every arm carried CLAUDE_CODE_ENTRYPOINT=claude-desktop, the
  // account's IDs and the desktop app's messaging socket. The API grant then refused the arms as
  // Claude Code traffic; with a clean environment the same key paid for claude -p (2026-10-11).
  const host = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_USER_EMAIL: 'owner@example.com', CLAUDE_AGENT_SDK_VERSION: '0.3.295',
    CLAUDE_PID: '1', CLAUDE_EFFORT: 'high', CLAUDE_PREVIEW_CLASSIFIER_FLOOR: '1', PATH: '/usr/bin' };
  const result = await runner({ suite: 'default', base: host, auth: apiAuth });
  assert.ok(result.envs.length);
  for (const env of result.envs) {
    assert.deepEqual(Object.keys(env).filter(key => /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_)/.test(key)), []);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
  }
});


test('default setup is registered as a fixture launch and its app scopes final hygiene', async () => {
  const result = await runner({ suite: 'default' });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => Array.isArray(call) && call[0] === 'tracked setup').length, 3);
  const options = result.calls.find(call => Array.isArray(call) && call[0] === 'window hygiene')[1];
  assert.ok(options.touchedApps.includes('Safari'));
  assert.ok(options.armPids.includes(1234));
});

test('blocked pass sends exact cold-launch receipts to native gentle cleanup and excludes warm apps', async () => {
  const result = await runner({ outcome: { groupClean: false }, leases: [
    { app: 'fixture', bundle: 'org.fixture', pid: 42, processStartedAtMs: 12000, running: false, launched: true },
    { app: 'owner', bundle: 'org.owner', pid: 43, processStartedAtMs: 13000, running: true, launched: false },
  ] });
  assert.equal(result.error, undefined);
  const options = result.calls.find(call => Array.isArray(call) && call[0] === 'window hygiene')[1];
  assert.equal(options.blocked, true);
  assert.deepEqual(JSON.parse(JSON.stringify(options.launched)), [{ pid: 42, start: 12, bundle: 'org.fixture' }]);
  assert.ok(options.touchedApps.includes('org.fixture'));
});


test('published hygiene errors count every failure once and log final snapshot failures', async () => {
  const errors = Array(20).fill('tracking unavailable');
  const result = await runner({ hygieneTracking: { errors, count: 25 },
    hygieneResult: { leftWindows: [], errors: ['final snapshot unavailable', ...errors], trackingErrors: errors, trackingErrorCount: 25 } });
  assert.equal(result.saved.at(-1).hygieneError.count, 26);
  assert.equal(result.saved.at(-1).hygieneError.errors.length, 20);
  assert.ok(result.logs.some(line => /hygiene.*final snapshot unavailable/i.test(line)));
});

test('private hygiene logs and saved results omit window titles and document paths', async () => {
  const result = await runner({ privateMail: true, hygieneResult: { leftWindows: [], errors: [] } });
  const options = result.calls.find(call => Array.isArray(call) && call[0] === 'window hygiene')[1];
  assert.equal(typeof options.log, 'function');
  options.log('leftWindows title=private-secret document=/private-secret');
  assert.equal(JSON.stringify(result.logs).includes('private-secret'), false);
});

test('a saved, successful pass refreshes the benchmark hub once, and --no-hub, dry runs, setup and the private mail pass do not', async () => {
  const done = await runner({ arm: 'cua', drive: true, outcome: { passed: true } });
  assert.equal(done.error, undefined);
  assert.equal(done.hubRefreshes.length, 1);
  assert.deepEqual([done.hubRefreshes[0].exitCode, done.hubRefreshes[0].noHub, typeof done.hubRefreshes[0].saved], [0, false, 'string']);
  assert.ok(done.logs.includes('hub: fixture'));
  assert.deepEqual((await runner({ arm: 'cua', drive: true, outcome: { passed: true }, extraArgs: ['--no-hub'] })).hubRefreshes.map(r => r.noHub), [true]);
  assert.equal((await runner({ suite: 'world', arm: 'sleight', dryRun: true })).hubRefreshes.length, 0);
  assert.equal((await runner({ setupOnly: true })).hubRefreshes.length, 0);
  assert.equal((await runner({ privateMail: true, drive: true, outcome: { passed: true } })).hubRefreshes.length, 0);
});
