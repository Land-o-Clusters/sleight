import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { BENCH_APPS, REAL_APPS } from '../bench/tasks.mjs';
import { selectSuiteTasks, assertShopSmokeRuns } from '../bench/shop.mjs';
import { privateMailResult, publicPrivateMailRow } from '../bench/private-mail.mjs';
import { privateDriverEnvironment } from '../bench/driver.mjs';
import { guardGenericOperation } from '../bench/generic-approval.mjs';
import { genericSettings } from '../bench/plugin-arm.mjs';
import { cpuSplit } from '../bench/footprint.mjs';

// Execute the actual runner body with inert dependencies. No app, CLI, approval
// file, live lock, compiler or filesystem operation reaches the host.
async function runner({ extraArgs = [], suite = 'real', arm = 'sleight', outcome = {}, taps = [], throws = false, base = {}, drive = false, leases = [], setupOnly = false, privateMail = false, fixtureLifecycle = false, ownerName = '', auth = { mode: 'login', env: {}, unset: [] }, keySource = 'none', spend = () => 0, holdAfterPreflight = false, dryRun = false, preparationError, extraServer, driverOut = {}, calculatorGate = false, calculatorFailureAt, cleanArms = false, footprint = { cpuSeconds: 0, group: {}, outside: {} }, codexServers, tasks } = {}) {
  const calls = [], saved = [], envs = [], tailScopes = [], directories = [];
  const logs = [], driverOptions = [], codexRuns = [], files = new Map();
  let preflightDone = false, calculatorObservations = 0;
  const source = readFileSync(new URL('../bench/run.mjs', import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', '"file:///fixture/bench/run.mjs"');
  const task = { id: 'fixture', app: 'Safari', setup() {}, prompt: () => 'task', check: () => true, cleanup: () => calls.push('task cleanup') };
  if (fixtureLifecycle) Object.assign(task, { id: 'simulator-form', app: 'Simulator', fixtureLifecycle: true });
  if (calculatorGate) Object.assign(task, { id: 'calculator-click', app: 'Calculator' });
  if (privateMail) Object.assign(task, { id: 'mimestream-label', app: 'Mimestream', privateMail: true,
    privateExpected: () => 'private answer', privateTerms: () => ['private label'] });
  const sandbox = {
    process: { argv: ['node', 'run', '--suite', suite, '--arm', arm, '--runs', '3', ...(setupOnly ? ['--setup-only'] : []), ...(dryRun ? ['--dry-run'] : []), ...(calculatorGate ? ['--calculator-gate'] : []), ...(cleanArms ? ['--clean-arms'] : []), ...extraArgs], env: base, on() {}, once() {} },
    console: { log: text => logs.push(text), error: text => logs.push(text) }, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    dirname, join, fileURLToPath: () => '/fixture/bench/run.mjs', homedir: () => '/owner', tmpdir: () => '/private/tmp/unit',
    existsSync: path => path === '/tmp/sleight-hold' ? holdAfterPreflight && preflightDone : true, realpathSync: path => path, mkdirSync: path => directories.push(path), rmdirSync() {}, statSync: () => ({ dev: 1, ino: 1 }),
    writeFileSync: (path, value) => { files.set(path, JSON.parse(value)); saved.push(JSON.parse(value)); }, randomBytes: () => ({ toString: () => 'nonce' }),
    privateMailResult, publicPrivateMailRow,
    privateDriverEnvironment, assertPrivateClaudePolicy: () => calls.push('policy audit'),
    DEFAULT_CAP_USD: 200, runCost: out => out?.total_cost_usd, archiveOldRuns: () => [], benchAuth: () => auth, addSpend: usd => { calls.push(['spend', usd]); return spend(usd); },
    prepareGenericArm: () => {
      if (preparationError) throw new Error(preparationError);
      return { generic: true, cwd: '/private/tmp/own-arm', args: ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '--disable-slash-commands', '--permission-prompts', 'none', '--no-session-persistence'], env: {}, identity: {}, servers: ['rival'] };
    },
    genericSettings, acceptGenericCatalog() {},
    guardGenericOperation: (operation, options) => guardGenericOperation(operation, { ...options, stopFile: undefined, held: () => false }),
    genericTask: task => { calls.push('retained setup'); return task; },
    publishPrivateMailResults: (_path, value, options) => { calls.push('private audit'); assert.ok(options.terms.every(term => term === 'private label')); saved.push(JSON.parse(value)); },
    execFileSync(command, args) {
      if (command === '/usr/bin/git') throw new Error('outside repo');
      if (command === 'id') return privateMail ? 'Owner Example' : ownerName;
      calls.push('tap check'); return JSON.stringify(taps);
    },
    getTasks: () => tasks ?? [task], BENCH_APPS, REAL_APPS,
    selectSuiteTasks, assertShopSmokeRuns,
    closeBenchTextEdit: options => { calls.push('TextEdit tail'); tailScopes.push(options); },
    quitChess: options => { calls.push('Chess tail'); tailScopes.push(options); },
    quitSimApp: options => { calls.push('Simulator tail'); tailScopes.push(options); },
    approveOnly: ids => { calls.push(['approve', ...ids]); return () => {}; }, codexReady: () => true,
    codexConfigServers: () => codexServers ?? [],
    cpuSplit,
    startFootprint: () => async () => footprint,
    runCodex: async (prompt, options) => { codexRuns.push({ prompt, options }); options.onSpawn?.(4321); return { code: 0, out: {}, forbidden: [] }; }, watchAppWindows: () => async () => [],
    acquireLiveLock: async () => { calls.push('lock'); return async () => calls.push('unlock'); },
    runTiming: () => ({}), traceTiming: () => ({}), observePermission: () => { if (dryRun) assert.fail('no host permission observation in initialization-only discovery'); return false; },
    assertCalculatorReady: async () => {
      assert.ok(calls.includes('lock'), 'Calculator observation requires the shared lock');
      calls.push('Calculator observation');
      if (++calculatorObservations === calculatorFailureAt) throw new Error('Calculator has no visible window on the current Space');
      return { load: [1, 2, 3], calculatorPid: 123, onScreenWindows: 1 };
    },
    runOwned: async (_command, _args, options) => {
      envs.push(options.env); options.onStdout(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: keySource, mcp_servers: [{ name: 'plugin:sleight:computer', status: 'connected' }, ...(extraServer ? [{ name: extraServer, status: 'connected' }] : [])] }) + '\n');
      preflightDone = true;
      return { groupClean: true };
    },
    runDriver: async (_command, args, options) => { calls.push(['driver', ...args]); envs.push(options.env); driverOptions.push(options); options.onSpawn?.(1234); return { code: 0, out: { total_cost_usd: 0.25, ...driverOut }, groupClean: true }; },
    executeRealTask: async (_task, ctx, options) => {
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
  return { calls, saved, envs, tailScopes, directories, error, logs, driverOptions, codexRuns, files, exitCode: sandbox.process.exitCode };
}

test('generic default comparisons use the guarded lifecycle for every arm and propagate failures', async () => {
  const result = await runner({ suite: 'default', arm: 'sleight,mcp:rival', drive: true, outcome: { passed: false, code: 1 } });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => call === 'real run').length, 6);
  assert.equal(result.exitCode, 1);
  assert.ok(result.tailScopes.every(scope => scope.ownedOnly));
  assert.ok(result.calls.filter(Array.isArray).filter(call => call[0] === 'driver').every(args => args.includes('--disallowedTools')));
});

test('generic comparisons use the same strict Claude options and stream format for both arms', async () => {
  const result = await runner({ suite: 'default', arm: 'sleight,mcp:rival', drive: true, outcome: { passed: true } });
  assert.equal(result.error, undefined);
  const commands = result.calls.filter(call => Array.isArray(call) && call[0] === 'driver');
  assert.equal(commands.length, 6);
  for (const args of commands) {
    for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
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
      assert.equal(settings.hooks.Elicitation[0].matcher, '^plugin:sleight:computer$');
    }
  }
  assert.ok(result.driverOptions.every(options => options.format === 'stream-json'));
  assert.ok(result.envs.every(env => env.BENCH_APPROVAL_STOP && env.BENCH_ARM_SERVERS));
});

test('clean arms strip the sleight arm to strict MCP and empty setting sources and record the setup', async () => {
  const clean = await runner({ suite: 'real', arm: 'sleight', cleanArms: true, drive: true, outcome: { passed: true } });
  assert.equal(clean.error, undefined);
  assert.equal(clean.saved.at(-1).armSetup, 'clean');
  const args = clean.calls.filter(call => Array.isArray(call) && call[0] === 'driver').at(-1).slice(1);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  const config = clean.files.get(args[args.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ['plugin:sleight:computer']);
  assert.equal(config.mcpServers['plugin:sleight:computer'].command, '/fixture/plugins/sleight/bin/sleight-mcp');
  const normal = await runner({ suite: 'real', arm: 'sleight', drive: true, outcome: { passed: true } });
  assert.equal(normal.saved.at(-1).armSetup, 'normal');
  assert.equal(normal.calls.filter(call => Array.isArray(call) && call[0] === 'driver').at(-1).includes('--strict-mcp-config'), false);
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
  assert.ok(result.saved.at(-1).results.every(row => row.dryRun && row.command.includes('--disallowedTools')));
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
    const result = await runner({ suite, base: { SLEIGHT_ARM_DIR: '/private/tmp/new-sleight-arm' } });
    assert.equal(result.error, undefined);
    assert.ok(result.directories.includes('/private/tmp/new-sleight-arm'));
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

test('permission and driver stops quit a launched Device Hub lease once before unlocking', async () => {
  for (const outcome of [{ permissionPrompt: true }, { groupClean: false }]) {
    let quits = 0;
    const lease = { app: 'DeviceHub', running: false, launched: true, quit: async options => {
      assert.equal(options.final, true); quits++;
    } };
    const result = await runner({ outcome, leases: [lease] });
    assert.equal(result.error, undefined);
    assert.equal(quits, 1);
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

test('a default simulator cleanup failure stops the pass and retries only its retained launched PID', async () => {
  let quits = 0;
  const result = await runner({ suite: 'default', fixtureLifecycle: true, outcome: { cleanupError: 'close failed' },
    leases: [{ app: 'DeviceHub', running: false, launched: true, quit: async () => { quits++; } }] });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.filter(call => call === 'real run').length, 1);
  assert.equal(quits, 1);
  assert.equal(result.saved.at(-1).results[0].passed, false);
});

test('pass cleanup preserves pre-existing apps and publishes a failed owned-app quit', async () => {
  const existing = { app: 'Safari', running: true, launched: true, quit: () => assert.fail('preserve pre-existing app') };
  const launched = { app: 'Preview', running: false, launched: true, quit: async () => { throw new Error('quit unconfirmed'); } };
  const result = await runner({ outcome: { permissionPrompt: true }, leases: [existing, launched] });
  assert.match(result.saved.at(-1).results[0].cleanupError, /quit unconfirmed/);
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

test('--surfaces browser,computer reaches every real-suite run and the results; anything else is refused', async () => {
  const both = await runner({ drive: true, extraArgs: ['--surfaces', 'browser,computer'] });
  assert.equal(both.error, undefined);
  for (const env of both.envs) assert.equal(env.SLEIGHT_SURFACES, 'browser,computer');
  assert.equal(both.saved.at(-1).surfaces, 'browser,computer');
  const bad = await runner({ extraArgs: ['--surfaces', 'browser'] });
  assert.match(String(bad.error?.message), /--surfaces must be/);
});

test('Codex default approvals contain only the five core benchmark bundle IDs', async () => {
  const result = await runner({ suite: 'default', arm: 'codex' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls.find(c => Array.isArray(c) && c[0] === 'approve'),
    ['approve', 'com.apple.calculator', 'com.apple.TextEdit', 'com.apple.Chess', 'com.apple.iphonesimulator', 'com.apple.dt.Devices']);
  assert.deepEqual(result.tailScopes.map(scope => scope?.ownedOnly), [undefined, undefined, true]);
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
    join, tmpdir: () => '/private/tmp', realpathSync: path => path,
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
  for (const [docs, refused] of [[[{ name: 'Untitled 9', path: '/Users/x/Library/Mobile Documents/Untitled 9.txt' }], true], [[], false]]) {
    const actions = [];
    const tasks = runInNewContext(`${source}\n({ freshTextEdit })`, {
      join, tmpdir: () => '/private/tmp', realpathSync: path => path,
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
    join, tmpdir: () => '/private/tmp', realpathSync: path => path, execFileSync,
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
    join, tmpdir: () => '/private/tmp', realpathSync: path => path,
    execFileSync: (command, args) => {
      if (command === 'pgrep') { if (running) return ''; throw new Error('none'); }
      if (command === 'osascript' && args.some(a => String(a).includes('documents().map'))) return running ? JSON.stringify([{ name: 'a', path: '/private/tmp/sleight-bench/a.txt' }]) : '[]';
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
    if (command === 'osascript' && args.some(a => String(a).includes('documents().map'))) return running ? JSON.stringify([{ name: 'a', path: '/private/tmp/sleight-bench/a.txt' }]) : '[]';
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
