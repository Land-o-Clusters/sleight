import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { BENCH_APPS, REAL_APPS } from '../bench/tasks.mjs';
import { privateMailResult, publicPrivateMailRow } from '../bench/private-mail.mjs';
import { privateDriverEnvironment } from '../bench/driver.mjs';

// Execute the actual runner body with inert dependencies. No app, CLI, approval
// file, live lock, compiler or filesystem operation reaches the host.
async function runner({ suite = 'real', arm = 'sleight', outcome = {}, taps = [], throws = false, base = {}, drive = false, leases = [], setupOnly = false, privateMail = false } = {}) {
  const calls = [], saved = [], envs = [], tailScopes = [], directories = [];
  const logs = [], driverOptions = [], codexRuns = [];
  const source = readFileSync(new URL('../bench/run.mjs', import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', '"file:///fixture/bench/run.mjs"');
  const task = { id: 'fixture', app: 'Safari', setup() {}, prompt: () => 'task', check: () => true, cleanup: () => calls.push('task cleanup') };
  if (privateMail) Object.assign(task, { id: 'mimestream-label', app: 'Mimestream', privateMail: true,
    privateExpected: () => 'private answer', privateTerms: () => ['private label'] });
  const sandbox = {
    process: { argv: ['node', 'run', '--suite', suite, '--arm', arm, '--runs', '3', ...(setupOnly ? ['--setup-only'] : [])], env: base, on() {}, once() {} },
    console: { log: text => logs.push(text), error: text => logs.push(text) }, AbortController, AbortSignal, setTimeout, clearTimeout,
    dirname, join, fileURLToPath: () => '/fixture/bench/run.mjs', homedir: () => '/owner', tmpdir: () => '/private/tmp/unit',
    existsSync: () => true, realpathSync: path => path, mkdirSync: path => directories.push(path), rmdirSync() {}, statSync: () => ({ dev: 1, ino: 1 }),
    writeFileSync: (_path, value) => saved.push(JSON.parse(value)), randomBytes: () => ({ toString: () => 'nonce' }),
    privateMailResult, publicPrivateMailRow,
    privateDriverEnvironment, assertPrivateClaudePolicy: () => calls.push('policy audit'),
    publishPrivateMailResults: (_path, value, options) => { calls.push('private audit'); assert.ok(options.terms.every(term => term === 'private label')); saved.push(JSON.parse(value)); },
    execFileSync(command, args) {
      if (command === '/usr/bin/git') throw new Error('outside repo');
      if (command === 'id') return privateMail ? 'Owner Example' : '';
      calls.push('tap check'); return JSON.stringify(taps);
    },
    getTasks: () => [task], BENCH_APPS, REAL_APPS,
    closeBenchTextEdit: options => { calls.push('TextEdit tail'); tailScopes.push(options); },
    quitChess: options => { calls.push('Chess tail'); tailScopes.push(options); },
    quitSimApp: options => { calls.push('Simulator tail'); tailScopes.push(options); },
    approveOnly: ids => { calls.push(['approve', ...ids]); return () => {}; }, codexReady: () => true,
    startFootprint: () => async () => ({ cpuSeconds: 0, group: {}, outside: {} }),
    runCodex: async (prompt, options) => { codexRuns.push({ prompt, options }); return { code: 0, out: {}, forbidden: [] }; }, watchAppWindows: () => async () => [],
    acquireLiveLock: async () => { calls.push('lock'); return async () => calls.push('unlock'); },
    runTiming: () => ({}), traceTiming: () => ({}), observePermission: () => false,
    runOwned: async (_command, _args, options) => {
      envs.push(options.env); options.onStdout('{"type":"system","subtype":"init","mcp_servers":[{"name":"plugin:sleight:computer","status":"connected"}]}\n');
      return { groupClean: true };
    },
    runDriver: async (_command, args, options) => { calls.push(['driver', ...args]); envs.push(options.env); driverOptions.push(options); return { code: 0, out: {}, groupClean: true }; },
    executeRealTask: async (_task, ctx, options) => {
      ctx.windowLeases = leases;
      if (setupOnly) assert.equal(options.setupOnly, true);
      calls.push('real run'); if (throws) throw new Error('unexpected run failure');
      if (drive) await options.drive('task', ctx, {});
      return { passed: false, groupClean: true, ...outcome };
    },
  };
  let error;
  try { await runInNewContext(`(async () => { ${source}\n})()`, sandbox); } catch (caught) { error = caught; }
  return { calls, saved, envs, tailScopes, directories, error, logs, driverOptions, codexRuns };
}

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
  for (const env of real.envs) { assert.equal(env.BENCH_SUITE, 'real'); assert.equal(env.SLEIGHT_SURFACES, 'computer'); }
  const standard = await runner({ suite: 'default', base: { BENCH_SUITE: 'real', SLEIGHT_SURFACES: 'browser' } });
  assert.equal(standard.error, undefined);
  for (const env of standard.envs) { assert.equal(env.BENCH_SUITE, 'default'); assert.equal(env.SLEIGHT_SURFACES, 'browser'); }
});

test('Codex default approvals contain only the five core benchmark bundle IDs', async () => {
  const result = await runner({ suite: 'default', arm: 'codex' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls.find(c => Array.isArray(c) && c[0] === 'approve'),
    ['approve', 'com.apple.calculator', 'com.apple.TextEdit', 'com.apple.Chess', 'com.apple.iphonesimulator', 'com.apple.dt.Devices']);
  assert.deepEqual(result.tailScopes, [undefined, undefined, undefined]);
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
  assert.match(result.error?.message ?? '', /Mimestream requires a separate sleight-only pass/);
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
