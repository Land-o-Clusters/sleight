// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { prepareAnalytics, analyticsArm, releaseAnalytics, writeAnalyticsMcp, parseStats, checkPrivacy, validateAnalytics, checkLocalFile } from '../bench/analytics-validation.mjs';
import { ActionLog } from '../plugins/sleight/lib/action-outcomes.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

function armHome(t) {
  const parent = registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-arm-home-')));
  const previous = process.env.BENCH_ARM_HOME;
  process.env.BENCH_ARM_HOME = parent;
  t.after(() => {
    if (previous === undefined) delete process.env.BENCH_ARM_HOME;
    else process.env.BENCH_ARM_HOME = previous;
  });
  return parent;
}

const row = (changes = {}) => ({ time: '2026-10-19T12:00:02.000Z', pid: 41, call: 1, tool: 'js', app: 'Calculator',
  kind: 'click', result: 'ok', outcome: 'no visible change', ms: 2000, ...changes });
const summary = () => ({ log: '~/Library/Logs/sleight/bench-analytics-fixture.jsonl', files: 1, skipped: 0, days: 1,
  from: '2026-10-19T12:00:02.000Z', to: '2026-10-19T12:00:02.000Z', calls: 1, actions: 2, timed: 2, untimed: 0,
  paths: { native: { actions: 2, timed: 2, median: 1, p90: 1 }, turbo: { actions: 0, timed: 0, median: null, p90: null },
    engine: { actions: 0, timed: 0, median: null, p90: null } }, readsSaved: 1,
  refused: { count: 0, reasons: {} }, failed: { count: 0, reasons: {} }, notRun: 0 });
const event = (ms, direction, msg) => ({ t: new Date(Date.UTC(2026, 9, 19, 12, 0, 0, ms)).toISOString(), direction, msg });
const trace = () => [{ pid: 41, events: [
  event(0, 'call-received', { id: 1, params: { name: 'js' } }),
  event(0, 'to-server', { id: 1, method: 'tools/call' }),
  event(2000, 'to-client', { id: 1, result: {} }),
] }];
const validate = (changes = {}) => validateAnalytics({ rows: [row({ saved: 1 }), row()], stats: summary(), traces: trace(), ...changes });

test('preparation writes only a fresh temporary arm config and cannot select the owner config', t => {
  const parent = registerTemp(t, mkdtempSync('/tmp/x3-fixture-'));
  const bank = prepareAnalytics({ tempRoot: parent });
  const arm = analyticsArm(bank, { root: '/fixture/repo' });
  assert.equal(arm.cwd, join(bank, 'arm'));
  assert.equal(arm.env.CLAUDE_CONFIG_DIR, join(bank, 'claude'));
  assert.equal(arm.server.env.SLEIGHT_ACTION_LOG.startsWith('bench-analytics-'), true);
  assert.equal(arm.server.env.SLEIGHT_TRACE, join(bank, 'traces'));
  assert.equal(existsSync(join(bank, 'claude/settings.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(bank, 'plan.json'))).version, 1);
  assert.throws(() => analyticsArm(`${MAC_USERS}fixture/.claude`, { root: '/fixture/repo' }), /ANALYTICS_BANK/);
  const alias = join(parent, 'alias'); symlinkSync(bank, alias);
  assert.throws(() => analyticsArm(alias, { root: '/fixture/repo' }), /ANALYTICS_BANK/);
});

test('MCP config writes cannot follow a link or truncate an owner file', t => {
  const parent = registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-config-')));
  const bank = prepareAnalytics({ tempRoot: parent });
  const owner = join(parent, 'owner-settings.json'); writeFileSync(owner, '{"owner":true}', { mode: 0o600 });
  const descriptor = join(bank, 'arm/bench-mcp.json'); symlinkSync(owner, descriptor);
  assert.throws(() => writeAnalyticsMcp(bank), /ANALYTICS_CONFIG/);
  assert.equal(readFileSync(owner, 'utf8'), '{"owner":true}');
  const linked = prepareAnalytics({ tempRoot: parent }); linkSync(owner, join(linked, 'arm/bench-mcp.json'));
  assert.throws(() => writeAnalyticsMcp(linked), /ANALYTICS_CONFIG/);
  assert.equal(readFileSync(owner, 'utf8'), '{"owner":true}');
  const fresh = prepareAnalytics({ tempRoot: parent });
  const path = writeAnalyticsMcp(fresh);
  assert.equal(JSON.parse(readFileSync(path)).mcpServers['plugin:sleight:computer'].env.SLEIGHT_ACTION_LOG, analyticsArm(fresh).log);
  assert.equal(writeAnalyticsMcp(fresh), path, 'an unused bank can retry after login preflight');
});

test('passes reserve a login config until release, then reuse it with separate artifacts', t => {
  const parent = armHome(t);
  const claudeConfig = join(parent, 'arm/claude');
  mkdirSync(claudeConfig, { recursive: true, mode: 0o700 });
  const settings = join(claudeConfig, 'settings.json');
  writeFileSync(settings, '{"loginFixture":true}', { mode: 0o600 });
  const first = prepareAnalytics({ tempRoot: parent, claudeConfig });
  const firstArm = analyticsArm(first);
  const firstMcp = writeAnalyticsMcp(first);
  assert.throws(() => prepareAnalytics({ tempRoot: parent, claudeConfig }), /ANALYTICS_CONFIG_BUSY/);
  const blocked = spawnSync(process.execPath, ['bench/analytics-validation.mjs', 'prepare', '--claude-config', claudeConfig], {
    encoding: 'utf8', env: process.env,
  });
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(blocked.stderr.trim(), 'ANALYTICS_CONFIG_BUSY');
  assert.equal(blocked.stdout, '');
  assert.equal(analyticsArm(first).log, firstArm.log);
  releaseAnalytics(first);
  const second = prepareAnalytics({ tempRoot: parent, claudeConfig });
  const arms = [firstArm, analyticsArm(second)];
  assert.equal(arms[0].env.CLAUDE_CONFIG_DIR, claudeConfig);
  assert.equal(arms[1].env.CLAUDE_CONFIG_DIR, claudeConfig);
  assert.notEqual(arms[0].log, arms[1].log);
  assert.notEqual(arms[0].server.env.SLEIGHT_TRACE, arms[1].server.env.SLEIGHT_TRACE);
  assert.notEqual(firstMcp, writeAnalyticsMcp(second));
  assert.throws(() => analyticsArm(first), /ANALYTICS_BANK/);
  assert.throws(() => releaseAnalytics(first), /ANALYTICS_BANK/);
  assert.equal(analyticsArm(second).log, arms[1].log, 'an old bank cannot release the current reservation');
  const released = spawnSync(process.execPath, ['bench/analytics-validation.mjs', 'release', second], { encoding: 'utf8', env: process.env });
  assert.equal(released.status, 0, released.stderr);
  assert.equal(released.stdout, '');
  assert.equal(readFileSync(settings, 'utf8'), '{"loginFixture":true}');
  const cli = spawnSync(process.execPath, ['bench/analytics-validation.mjs', 'prepare', '--claude-config', claudeConfig], {
    encoding: 'utf8', env: process.env,
  });
  assert.equal(cli.status, 0, cli.stderr);
  const bank = registerTemp(t, cli.stdout.trim());
  assert.equal(analyticsArm(bank).env.CLAUDE_CONFIG_DIR, claudeConfig);
});

test('persistent configs reject owner paths, links, unsafe permissions and changed plans', t => {
  const parent = armHome(t);
  const claudeConfig = join(parent, 'claude'); mkdirSync(claudeConfig, { mode: 0o700 });
  for (const config of [homedir(), join(homedir(), '.claude'), join(homedir(), '.claude/child'), 'relative', join(parent, 'missing')]) {
    assert.throws(() => prepareAnalytics({ tempRoot: parent, claudeConfig: config }), /ANALYTICS_CONFIG/);
  }
  const alias = join(parent, 'alias'); symlinkSync(claudeConfig, alias);
  assert.throws(() => prepareAnalytics({ tempRoot: parent, claudeConfig: alias }), /ANALYTICS_CONFIG/);
  const bank = prepareAnalytics({ tempRoot: parent, claudeConfig });
  chmodSync(claudeConfig, 0o777);
  assert.throws(() => prepareAnalytics({ tempRoot: parent, claudeConfig }), /ANALYTICS_CONFIG/);
  assert.throws(() => analyticsArm(bank), /ANALYTICS_BANK/);
  chmodSync(claudeConfig, 0o700);
  const plan = JSON.parse(readFileSync(join(bank, 'plan.json')));
  writeFileSync(join(bank, 'plan.json'), JSON.stringify({ ...plan, claudeConfig: join(homedir(), '.claude') }) + '\n');
  assert.throws(() => analyticsArm(bank), /ANALYTICS_BANK/);
});

test('persistent configs must resolve strictly inside the benchmark arm home', t => {
  const parent = armHome(t);
  const outside = registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-other-project-')));
  chmodSync(outside, 0o755);
  const alias = join(parent, 'outside'); symlinkSync(outside, alias);
  const sibling = registerTemp(t, parent + '-sibling'); mkdirSync(sibling, { mode: 0o755 });
  for (const claudeConfig of [outside, parent, alias, sibling]) {
    assert.throws(() => prepareAnalytics({ tempRoot: parent, claudeConfig }), /ANALYTICS_CONFIG/);
  }
  const claudeConfig = join(parent, 'claude'); mkdirSync(claudeConfig, { mode: 0o755 });
  const bank = prepareAnalytics({ tempRoot: parent, claudeConfig });
  const plan = JSON.parse(readFileSync(join(bank, 'plan.json')));
  writeFileSync(join(bank, 'plan.json'), JSON.stringify({ ...plan, claudeConfig: outside }) + '\n');
  assert.throws(() => analyticsArm(bank), /ANALYTICS_BANK/);
});

test('the default arm home rejects an unrelated project config without changing it', t => {
  const home = registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-default-home-')));
  const claudeConfig = join(home, 'Library/Caches/sleight-bench/claude-cu/claude');
  mkdirSync(claudeConfig, { recursive: true, mode: 0o700 });
  const project = join(home, 'Projects/another-project/claude'); mkdirSync(project, { recursive: true, mode: 0o755 });
  const settings = join(project, 'settings.json'); writeFileSync(settings, '{"owner":true}', { mode: 0o600 });
  const env = { ...process.env, HOME: home }; delete env.BENCH_ARM_HOME;
  const prepare = config => spawnSync(process.execPath, ['bench/analytics-validation.mjs', 'prepare', '--claude-config', config], { encoding: 'utf8', env });
  const rejected = prepare(project);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.equal(rejected.stderr.trim(), 'ANALYTICS_CONFIG');
  assert.equal(rejected.stdout, '');
  assert.equal(readFileSync(settings, 'utf8'), '{"owner":true}');
  const accepted = prepare(claudeConfig);
  assert.equal(accepted.status, 0, accepted.stderr);
  registerTemp(t, accepted.stdout.trim());
});

test('simultaneous preparations admit only one process per config', async t => {
  const parent = armHome(t), claudeConfig = join(parent, 'claude');
  mkdirSync(claudeConfig, { mode: 0o700 });
  const prepare = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bench/analytics-validation.mjs', 'prepare', '--claude-config', claudeConfig], { env: process.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  const results = await Promise.all([prepare(), prepare()]);
  assert.deepEqual(results.map(result => result.status).sort(), [0, 1]);
  assert.equal(results.find(result => result.status === 1).stderr.trim(), 'ANALYTICS_CONFIG_BUSY');
  const bank = registerTemp(t, results.find(result => result.status === 0).stdout.trim());
  releaseAnalytics(bank);
  const next = prepareAnalytics({ tempRoot: parent, claudeConfig });
  assert.equal(analyticsArm(next).env.CLAUDE_CONFIG_DIR, claudeConfig);
});

test('missing, changed or linked reservations stop bank use and cannot be released', t => {
  const bank = prepareAnalytics({ tempRoot: registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-marker-'))) });
  const marker = join(bank, 'claude/.sleight-analytics.lock'), content = readFileSync(marker, 'utf8');
  writeFileSync(marker, '{}\n');
  assert.throws(() => analyticsArm(bank), /ANALYTICS_BANK/);
  assert.throws(() => releaseAnalytics(bank), /ANALYTICS_BANK/);
  assert.equal(readFileSync(marker, 'utf8'), '{}\n');
  unlinkSync(marker);
  assert.throws(() => analyticsArm(bank), /ANALYTICS_BANK/);
  const target = join(bank, 'target'); writeFileSync(target, content, { mode: 0o600 });
  symlinkSync(target, marker);
  assert.throws(() => releaseAnalytics(bank), /ANALYTICS_BANK/);
  assert.equal(readFileSync(target, 'utf8'), content);
});

test('stats parser rejects missing, nonfinite, negative, unknown and malformed fields', () => {
  assert.equal(parseStats(JSON.stringify(summary())).paths.native.median, 1);
  for (const bad of ['not json', '{}', JSON.stringify({ ...summary(), actions: -1 }),
    JSON.stringify({ ...summary(), calls: '1' }), JSON.stringify({ ...summary(), privateName: 'Robin' }),
    JSON.stringify({ ...summary(), paths: { ...summary().paths, native: { actions: 2, timed: 2, median: null, p90: 1 } } })]) {
    assert.throws(() => parseStats(bad), /ANALYTICS_STATS/);
  }
});

test('privacy checks reject personal data in every free text slot and unknown nested fields', () => {
  checkPrivacy([row({ target: { role: 'button', name: 'Save' }, key: 'Super+s' })]);
  for (const changes of [{ path: `${MAC_USERS}Robin/private` }, { app: 'Robin Calculator' }, { call: 'Robin' },
    { outcome: 'Window: personal.txt' }, { reason: 'Robin' }, { origin: 'https://private.example' },
    { target: { role: 'button', name: 'Robin' } }, { target: { role: 'Robin' } },
    { target: { role: 'button', windowTitle: 'Private' } }, { key: 'Robin' }]) {
    assert.throws(() => checkPrivacy([row(changes)]), /ANALYTICS_PRIVACY/);
  }
});

test('validation deduplicates call time and counts both actions and one saved read', () => {
  assert.deepEqual(validate(), { calls: 1, actions: 2, readsSaved: 1, maxTimingDeltaMs: 0, tolerance: 'max(250 ms, 10% of trace call time)' });
  assert.throws(() => validate({ stats: { ...summary(), actions: 3 } }), /ANALYTICS_STATS_MISMATCH/);
  assert.throws(() => validate({ stats: { ...summary(), readsSaved: 2 } }), /ANALYTICS_STATS_MISMATCH/);
  assert.throws(() => validate({ stats: { ...summary(), paths: { ...summary().paths, native: { actions: 2, timed: 2, median: 2, p90: 2 } } } }), /ANALYTICS_STATS_MISMATCH/);
});

test('trace matching uses pid and call id, enforces tolerance, and refuses unrelated or incomplete evidence', () => {
  assert.equal(validate({ rows: [row({ ms: 1800, saved: 1 }), row({ ms: 1800 })],
    stats: { ...summary(), paths: { ...summary().paths, native: { actions: 2, timed: 2, median: 0.9, p90: 0.9 } } } }).maxTimingDeltaMs, 200);
  assert.throws(() => validate({ rows: [row({ ms: 100 }), row({ ms: 100 })] }), /ANALYTICS_TIMING/);
  assert.throws(() => validate({ rows: [row({ pid: 42 }), row({ pid: 42 })] }), /ANALYTICS_TRACE/);
  assert.throws(() => validate({ traces: [] }), /ANALYTICS_TRACE/);
  assert.throws(() => validate({ traces: [{ pid: 41, events: trace()[0].events.slice(0, 2) }] }), /ANALYTICS_TRACE/);
  assert.throws(() => validate({ rows: [row(), row({ ms: 1999 })] }), /ANALYTICS_CALL/);
});

test('trace timing subtracts overlapping engine approval waits once', () => {
  const traces = trace();
  traces[0].events.splice(2, 0, event(100, 'from-server', { id: 9, method: 'elicitation/create' }),
    event(200, 'from-server', { id: 10, method: 'elicitation/create' }),
    event(700, 'to-server', { id: 9, result: {} }), event(1100, 'to-server', { id: 10, result: {} }));
  const stats = summary(); stats.paths.native.median = stats.paths.native.p90 = 0.5;
  assert.equal(validate({ traces, rows: [row({ ms: 1000, saved: 1 }), row({ ms: 1000 })], stats }).maxTimingDeltaMs, 0);
});

for (const answered of [true, false]) test(`approval waits stay with their call when another call starts (${answered ? 'answered' : 'open'})`, () => {
  const traces = trace();
  traces[0].events = [
    event(0, 'call-received', { id: 2, params: { name: 'js' } }),
    event(0, 'to-server', { id: 2, method: 'tools/call' }),
    event(100, 'from-server', { id: 9, method: 'elicitation/create' }),
    event(100, 'to-client', { id: 9, method: 'elicitation/create' }),
    event(200, 'call-received', { id: 1, params: { name: 'js' } }),
    event(200, 'to-server', { id: 1, method: 'tools/call' }),
    ...(answered ? [event(1500, 'to-server', { id: 9, result: {} })] : []),
    event(2200, 'to-client', { id: 1, result: {} }),
    event(2400, 'to-client', { id: 2, result: {} }),
  ];
  assert.equal(validate({ traces }).maxTimingDeltaMs, 0);
  const rows = [row({ time: event(2200).t, saved: 1 }), row({ time: event(2200).t }),
    row({ call: 2, time: event(2400).t, ms: answered ? 1000 : 100 })];
  const both = summary();
  Object.assign(both, { calls: 2, actions: 3, timed: 3, from: event(2200).t, to: event(2400).t });
  both.paths.native = { actions: 3, timed: 3, median: 1, p90: 1 };
  assert.equal(validateAnalytics({ rows, stats: both, traces }).maxTimingDeltaMs, 0);
  const stats = summary(); stats.paths.native.median = stats.paths.native.p90 = 0.35;
  assert.throws(() => validate({ traces, rows: [row({ ms: 700, saved: 1 }), row({ ms: 700 })], stats }), /ANALYTICS_TIMING/);
});

test('approval timing refuses ambiguous call ownership instead of subtracting a shared wait', () => {
  const traces = trace();
  traces[0].events.splice(2, 0,
    event(0, 'call-received', { id: 2, params: { name: 'js' } }),
    event(0, 'to-server', { id: 2, method: 'tools/call' }),
    event(100, 'from-server', { id: 9, method: 'elicitation/create' }),
    event(1500, 'to-server', { id: 9, result: {} }));
  assert.throws(() => validate({ traces }), /ANALYTICS_UNOBSERVABLE_PROMPT/);
});

test('a completed wait is clipped to its owner call and prompt IDs do not collide with call IDs', () => {
  const traces = trace();
  traces[0].events = [
    event(0, 'call-received', { id: 1, params: { name: 'js' } }),
    event(0, 'to-server', { id: 1, method: 'tools/call' }),
    event(100, 'from-server', { id: 1, method: 'elicitation/create' }),
    event(100, 'to-client', { id: 1, method: 'elicitation/create' }),
    event(2000, 'to-client', { id: 1, result: {} }),
    event(2500, 'to-server', { id: 1, result: {} }),
  ];
  const stats = summary(); stats.paths.native.median = stats.paths.native.p90 = 0.05;
  assert.equal(validate({ traces, rows: [row({ ms: 100, saved: 1 }), row({ ms: 100 })], stats }).maxTimingDeltaMs, 0);
});

test('native aggregates use weighted percentiles across calls, and preserve refusal and not-run counts', () => {
  const rows = [row({ saved: 1 }), row(), row({ call: 2, ms: 4000 }),
    row({ call: 2, ms: 4000, result: 'refused', reason: 'input lease' }),
    row({ call: 2, ms: 4000, kind: 'rest', result: 'not run', count: 3 })];
  const traces = trace();
  traces[0].events = [traces[0].events[0], traces[0].events[1],
    event(0, 'call-received', { id: 2, params: { name: 'js' } }), event(0, 'to-server', { id: 2, method: 'tools/call' }),
    event(2000, 'to-client', { id: 1, result: {} }), event(4000, 'to-client', { id: 2, result: {} })];
  const stats = summary();
  Object.assign(stats, { calls: 2, actions: 3, timed: 3, notRun: 3, refused: { count: 1, reasons: { 'input lease': 1 } } });
  stats.paths.native = { actions: 3, timed: 3, median: 1, p90: 3.4 };
  assert.equal(validateAnalytics({ rows, stats, traces }).actions, 3);
});

test('timing stops when a local consent prompt has no observable answer in the trace', () => {
  const traces = trace();
  traces[0].events.splice(2, 0, event(100, 'to-client', { id: 9, method: 'elicitation/create' }));
  assert.throws(() => validate({ traces }), /ANALYTICS_UNOBSERVABLE_PROMPT/);
});

test('locality rejects linked, shared, or public log files without modifying them', t => {
  const dir = registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-local-')));
  const file = join(dir, 'log.jsonl'); writeFileSync(file, '{}\n', { mode: 0o600 });
  assert.equal(checkLocalFile(file, dir), '{}\n');
  const alias = join(dir, 'alias'); symlinkSync(file, alias);
  assert.throws(() => checkLocalFile(alias, dir), /ANALYTICS_LOCAL/);
  const hard = join(dir, 'hard'); linkSync(file, hard);
  assert.throws(() => checkLocalFile(hard, dir), /ANALYTICS_LOCAL/);
  chmodSync(file, 0o644);
  assert.throws(() => checkLocalFile(file, dir), /ANALYTICS_LOCAL/);
  assert.equal(readFileSync(file, 'utf8'), '{}\n');
});

test('offline CLI reads real logger output and stats, and rejects personal data hidden behind a duplicate JSON key', t => {
  const parent = registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-cli-')));
  const bank = prepareAnalytics({ tempRoot: parent }), arm = analyticsArm(bank);
  const home = join(parent, 'home'), root = join(home, 'Library/Logs/sleight');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, arm.log), now = Date.now(), started = new Date(now - 2000).toISOString();
  let clock = 0;
  const log = new ActionLog({ path, root, home, names: [], pid: 41, now: () => new Date(now), clock: () => clock });
  log.request({ id: 1, method: 'tools/call', params: { name: 'js' } }); log.sent(1);
  log.outcomes(1, { app: 'Calculator', outcomes: [{ a: 'click' }, { a: 'pressKey', k: 'Return' }] });
  log.saved(1, 1); clock = 2000; log.reply({ id: 1, result: {} });
  writeFileSync(join(bank, 'traces/trace-41.jsonl'), [
    { t: started, direction: 'call-received', msg: { id: 1, params: { name: 'js' } } },
    { t: started, direction: 'to-server', msg: { id: 1, method: 'tools/call' } },
    { t: new Date(now).toISOString(), direction: 'to-client', msg: { id: 1, result: {} } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const check = () => spawnSync(process.execPath, ['bench/analytics-validation.mjs', 'check', bank], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: arm.env.CLAUDE_CONFIG_DIR },
  });
  const before = readFileSync(path, 'utf8'), good = check();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).actions, 2);
  assert.equal(JSON.parse(good.stdout).readsSaved, 1);
  assert.equal(readFileSync(path, 'utf8'), before);
  writeFileSync(path, before.replace('"app":"Calculator"', '"app":"Robin private window","app":"Calculator"'));
  const bad = check();
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim(), 'ANALYTICS_LOG_PARSE');
  assert.equal(bad.stdout, '');
});
