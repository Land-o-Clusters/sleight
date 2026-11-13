import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { collectWorkflow, makeWorkflowPlan, productionGate, runWorkflow, workflowEnvironment, workflowSummary } from '../bench/validation/workflow-docs-ab.mjs';
import { realGatePlan } from '../bench/fowl/real-gate.mjs';
import { runErrorClass, harnessFailure } from '../bench/fowl/real-gate-grade.mjs';
import { outsideGit } from '../bench/world/arms/browser.mjs';
import { roundCommand } from '../bench/validation/validation-140.mjs';

const build = 'a'.repeat(40), engine = '26.1013.40934';
const pins = { build, pluginTree: 'b'.repeat(40), harnessHash: 'c'.repeat(64) };
const plan = out => makeWorkflowPlan({ build, engine, out, pins });
const sandbox = t => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-docs-ab-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(realpathSync(dir), 'out');
};
const runtime = (p, overrides = {}) => ({
  now: () => new Date('2026-10-21T15:00:00Z'), verifyPins: () => {},
  readEngine: () => ({ version: engine }), gate: () => {},
  run: async () => ({ code: 0, signal: null }),
  collect: round => ({ safe: true, rows: round.tasks.map(task => ({ task, passed: true, seconds: 2 })) }),
  ...overrides,
});

test('WF3 selects existing identities, 3 rounds per side and 42 task executions', () => {
  const p = plan();
  assert.equal(p.rounds.length, 42);
  assert.ok(p.rounds.every(r => r.tasks.length === 1));
  assert.equal(new Set(p.rounds.map(r => r.id)).size, 42);
  assert.equal(p.rounds.reduce((n, r) => n + r.tasks.length, 0), 42);
  assert.deepEqual(p.groups.map(g => g.id), ['as3-safari', 'as3-firefox', 'cc-dropdown-slow-firefox',
    'cc-dropdown-slow-safari', 'cc-calendar-ambiguous-firefox']);
  for (const group of p.groups) {
    for (const task of group.tasks) {
      const rounds = p.rounds.filter(r => r.group === group.id && r.tasks.includes(task));
      assert.deepEqual(rounds.map(r => r.side), ['docs0', 'default', 'default', 'docs0', 'docs0', 'default']);
      for (const side of ['docs0', 'default']) assert.equal(rounds.filter(r => r.side === side).length, 3);
    }
  }
  assert.equal(p.model, 'claude-haiku-5-5');
  assert.equal(p.effort, 'high');
  assert.ok(p.groups.every(g => Object.values(g.taskPins).every(t => t.prompt && /^[a-f0-9]{64}$/.test(t.hash))));
});

test('only the requested flag differs; host experiment flags and credentials do not leak', () => {
  const host = { PATH: '/bin', HOME: '/home/test', SLEIGHT_WORKFLOW_DOCS: '0', SLEIGHT_RS: '0',
    ANTHROPIC_API_KEY: 'never-copy', CLAUDE_CONFIG_DIR: 'old', NODE_OPTIONS: '--inspect' };
  const a = workflowEnvironment('docs0', host), b = workflowEnvironment('default', host);
  assert.equal(a.SLEIGHT_WORKFLOW_DOCS, '0');
  assert.ok(!Object.hasOwn(b, 'SLEIGHT_WORKFLOW_DOCS'));
  delete a.SLEIGHT_WORKFLOW_DOCS;
  assert.deepEqual(a, b);
  for (const key of ['SLEIGHT_RS', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS']) assert.ok(!(key in b));
});

test('quota refusal precedes every callback and output write', async t => {
  const out = sandbox(t), p = plan(out);
  let calls = 0;
  await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
    now: () => new Date('2026-10-21T14:59:59.999Z'), gate: () => calls++, verifyPins: () => calls++,
  }) }), /quota reset/);
  assert.equal(calls, 0); assert.equal(existsSync(out), false);
});

test('owner-away refusal precedes engine, hold, lock and output access', async t => {
  const out = sandbox(t), p = plan(out);
  let calls = 0;
  await assert.rejects(runWorkflow(p, { runtime: runtime(p, { gate: () => calls++, readEngine: () => calls++ }) }), /owner-away/);
  assert.equal(calls, 0); assert.equal(existsSync(out), false);
});

test('hold and lock refuse without output or runner invocation', async t => {
  for (const message of ['Benchmark hold is active', 'Live lock is held']) {
    const out = sandbox(t), p = plan(out);
    await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
      gate: () => { throw Error(message); }, run: () => assert.fail('runner reached'),
    }) }), new RegExp(message));
    assert.equal(existsSync(out), false);
  }
});

test('an injected offline run preserves failed rounds, pins and exact command receipts', async t => {
  const out = sandbox(t), p = plan(out), calls = [];
  const result = await runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
    run: async (round, invocation) => { calls.push({ round, invocation }); return { code: 1, signal: null }; },
    collect: round => ({ safe: true, rows: round.tasks.map(task => ({ task, passed: false, seconds: 7 })) }),
  }) });
  assert.equal(calls.length, 42); assert.equal(result.rows.length, 42);
  assert.equal(lstatSync(out).mode & 0o777, 0o700);
  assert.equal(result.complete, true); assert.equal(result.passes, 0);
  const first = JSON.parse(readFileSync(join(out, `${p.rounds[0].id}.receipt.json`)));
  assert.equal(first.code, 1); assert.equal(first.build, build); assert.equal(first.engine, engine);
  assert.ok(first.invocation.args.includes('--only'));
  assert.ok(calls.filter(c => c.round.runner === 'native').every(c => c.invocation.args.includes('--owner-away')));
  for (const { round, invocation } of calls.filter(c => c.round.runner === 'browser')) {
    assert.ok(invocation.args.includes('sleight'));
    assert.equal(invocation.args[invocation.args.indexOf('--only') + 1], round.tasks[0]);
  }
  assert.ok(existsSync(join(out, 'summary.json')));
  await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p) }), /already exists/);
});

test('unsafe or missing evidence stops after one child and retains failure/receipt', async t => {
  const out = sandbox(t), p = plan(out);
  let calls = 0;
  await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
    run: async () => { calls++; return { code: 1, signal: null }; },
    collect: () => { throw Error('missing cleanup receipt'); },
  }) }), /missing cleanup/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(join(out, `${p.rounds[0].id}.receipt.json`))).safe, false);
  assert.ok(existsSync(join(out, 'failure.json')));
  assert.equal(existsSync(join(out, 'summary.json')), false);
});

test('build or engine drift and a newly held lock stop before the next child', async t => {
  for (const kind of ['pins', 'engine', 'gate']) {
    const out = sandbox(t), p = plan(out); let calls = 0;
    const rt = runtime(p, { run: async () => { calls++; return { code: 0, signal: null }; } });
    if (kind === 'pins') rt.verifyPins = () => { if (calls) throw Error('build changed'); };
    if (kind === 'engine') rt.readEngine = () => ({ version: calls ? '99.1' : engine });
    if (kind === 'gate') rt.gate = () => { if (calls) throw Error('Live lock is held'); };
    await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: rt }), /changed|lock/);
    assert.equal(calls, 1); assert.ok(existsSync(join(out, 'failure.json')));
  }
});

test('bad exit and signal cannot be rescued by otherwise safe artifacts', async t => {
  for (const exit of [{ code: 2, signal: null }, { code: null, signal: 'SIGINT' }]) {
    const out = sandbox(t), p = plan(out); let calls = 0;
    await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
      run: async () => { calls++; return exit; },
    }) }), /exit|signal/);
    assert.equal(calls, 1);
  }
});

test('production gate checks hold, lock and local pause without manipulating them', () => {
  for (const [path, message] of [['/tmp/sleight-hold', /hold/], ['/tmp/sleight-live.lock', /lock/], ['/output/pause', /pause/]])
    assert.throws(() => productionGate('/output', candidate => candidate === path), message);
  productionGate('/output', () => false);
});

const put = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
function browserFixture(t, side = 'docs0') {
  const out = sandbox(t), p = plan(out), round = p.rounds.find(r => r.runner === 'browser' && r.side === side);
  const stem = join(out, round.id), group = p.groups.find(g => g.id === round.group);
  put(join(stem, 'cleanup.json'), { browserClosed: true });
  put(join(stem, 'engine.json'), { version: engine, changed: false });
  put(join(stem, 'commits.json'), { build: { commit: build, dirty: 0 }, harness: { commit: build, dirty: 0 }, fowlbrowser: { commit: p.upstream } });
  const rows = round.tasks.map(task => ({ task: { name: task, browser: round.browser, prompt: group.taskPins[task].prompt },
    run: { groupClean: true, result: { modelUsage: { [p.model]: {} }, duration_api_ms: 200, num_turns: 4 } },
    outcome: { ok: true }, errorClass: null, wallMs: 7000 }));
  put(join(stem, 'results.json'), rows);
  for (const task of round.tasks) put(join(stem, task, 'mcp.json'), { mcpServers: {
    'plugin:sleight:computer': { env: { SLEIGHT_TURBO: '0', ...(side === 'docs0' ? { SLEIGHT_WORKFLOW_DOCS: '0' } : {}) } },
  } });
  for (const task of round.tasks) writeFileSync(join(stem, task, 'events.jsonl'), '');
  return { p, round, stem, rows };
}

test('production collector accepts both browser modes using actual artifact schemas', t => {
  for (const side of ['docs0', 'default']) {
    const { p, round } = browserFixture(t, side);
    const result = collectWorkflow(round, p);
    assert.equal(result.safe, true); assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].apiMs, 200);
  }
});

test('browser collection rejects missing cleanup, wrong model, engine, build, flag and prompt', t => {
  for (const kind of ['cleanup', 'model', 'engine', 'build', 'flag', 'prompt', 'permission', 'harness']) {
    const { p, round, stem, rows } = browserFixture(t);
    if (kind === 'cleanup') rmSync(join(stem, 'cleanup.json'));
    if (kind === 'model') { rows[0].run.result.modelUsage = { other: {} }; put(join(stem, 'results.json'), rows); }
    if (kind === 'engine') put(join(stem, 'engine.json'), { version: engine, changed: true });
    if (kind === 'build') put(join(stem, 'commits.json'), { build: { commit: 'd'.repeat(40) } });
    if (kind === 'flag') put(join(stem, round.tasks[0], 'mcp.json'), { mcpServers: {} });
    if (kind === 'prompt') { rows[0].task.prompt += ' changed'; put(join(stem, 'results.json'), rows); }
    if (kind === 'permission') { rows[0].errorClass = { class: 'approval refused', example: 'Computer Use was not approved to use Safari' }; put(join(stem, 'results.json'), rows); }
    if (kind === 'harness') put(join(stem, 'harness-failure.json'), { reason: 'stop' });
    assert.throws(() => collectWorkflow(round, p), undefined, kind);
  }
});

function nativeFixture(t) {
  const out = sandbox(t), p = plan(out), round = p.rounds.find(r => r.runner === 'native');
  const source = join(out, 'source.json'), log = join(out, 'round.log');
  const raw = { sleight: { commit: build, dirty: 0 }, engine: { version: engine, changed: false },
    model: p.model, effort: 'high', ownerAway: true, leftWindows: [], hygiene: { errors: [], trackingErrors: [] },
    results: [{ task: round.tasks[0], arm: 'sleight', models: [p.model], groupClean: true, passed: false, seconds: 8,
      timing: { modelMs: 6000, toolWallMs: 1500, engineMs: 1200 } }] };
  put(source, raw); writeFileSync(log, `results: ${source}\n`);
  return { p, round, source, log, raw };
}

test('native collector preserves failed tasks and copies the production result without requiring an absent prompt', t => {
  const { p, round, source, log } = nativeFixture(t);
  const result = collectWorkflow(round, p, log);
  assert.equal(result.rows[0].passed, false); assert.equal(result.safe, true);
  assert.equal(result.rows[0].apiMs, 6000); assert.equal(result.rows[0].toolMs, 1500);
  assert.equal(readFileSync(join(p.out, `${round.id}.json`), 'utf8'), readFileSync(source, 'utf8'));
});

test('native collection refuses unsafe cleanup, wrong effort, model, dirty build and unexpected prompt', t => {
  for (const kind of ['cleanup', 'effort', 'model', 'dirty', 'prompt', 'permission']) {
    const { p, round, source, log, raw } = nativeFixture(t);
    if (kind === 'cleanup') raw.leftWindows.push({ id: 1 });
    if (kind === 'effort') raw.effort = 'low';
    if (kind === 'model') raw.results[0].models = ['other'];
    if (kind === 'dirty') raw.sleight.dirty = 1;
    if (kind === 'prompt') raw.results[0].prompt = 'changed';
    if (kind === 'permission') raw.results[0].permissionPrompt = true;
    put(source, raw);
    assert.throws(() => collectWorkflow(round, p, log), undefined, kind);
  }
});

test('CC prompt normalization accepts only the fixture URL substitution', t => {
  const { p, round, source, log, raw } = nativeFixture(t);
  raw.results[0].prompt = p.groups.find(g => g.id === round.group).taskPins[round.tasks[0]].prompt
    .replace('{url}', 'http://127.0.0.1:8123/held-out/dropdown-slow/test_nonce/');
  put(source, raw);
  assert.equal(collectWorkflow(round, p, log).safe, true);
});

test('CLI dry plan is offline before reset and does not create output', t => {
  const out = sandbox(t), script = new URL('../bench/validation/workflow-docs-ab.mjs', import.meta.url);
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const result = spawnSync(process.execPath, [script.pathname, '--plan', '--build', head, '--engine', engine, '--out', out],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rounds.length, 42);
  assert.equal(existsSync(out), false);
});

test('malformed pins and altered study plans refuse', async t => {
  for (const [badBuild, badEngine] of [['HEAD', engine], [build, 'unknown']])
    assert.throws(() => makeWorkflowPlan({ build: badBuild, engine: badEngine, pins }), /requires/);
  const out = sandbox(t), p = plan(out);
  p.rounds[0].tasks = ['invented-task'];
  await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p) }), /plan changed/);
  assert.equal(existsSync(out), false);
});

// Call the production plan and setup, supplying only an inert browser identity.
// dryRun does not launch, inspect, authenticate or connect to anything.
function dryBrowser(p, round, out = join(p.out, round.id)) {
  const invocation = roundCommand(round, p.root, out);
  const args = Object.fromEntries(['--real-browser', '--surface', '--model', '--effort', '--only', '--out']
    .map(key => [key.slice(2), invocation.args[invocation.args.indexOf(key) + 1]]));
  const previous = process.env;
  try {
    process.env = workflowEnvironment(round.side, previous);
    return realGatePlan({ args, repo: p.root, dryRun: true,
      tasks: JSON.parse(readFileSync(join(p.root, 'bench/world/tasks/browser-open-heldout.json'))),
      realBrowser: { browser: round.browser, marker: 'Sleight Gate offline-wf3', pid: 4321,
        profileMode: 'fresh', profileRoot: join(p.out, 'offline-profile') } });
  } finally { process.env = previous; }
}

test('fresh default output passes the real dry browser plan and setup without writes', () => {
  const p = plan(), other = plan();
  assert.equal(existsSync(p.out), false);
  outsideGit(p.out);
  for (const round of p.rounds.filter(r => r.runner === 'browser')) {
    const dry = dryBrowser(p, round);
    assert.equal(dry.arms.length, 1);
    const arm = dry.arms[0];
    assert.equal(arm.task.name, round.tasks[0]);
    assert.equal(arm.task.browser, round.browser);
    assert.equal(arm.dir, join(p.out, round.id, round.tasks[0]));
    assert.equal(arm.args[arm.args.indexOf('--model') + 1], p.model);
    assert.equal(arm.args[arm.args.indexOf('--effort') + 1], 'high');
    assert.equal(arm.mcpConfig.mcpServers['plugin:sleight:computer'].env.SLEIGHT_TURBO, '0');
    assert.equal(arm.mcpConfig.mcpServers['plugin:sleight:computer'].env.SLEIGHT_WORKFLOW_DOCS,
      round.side === 'docs0' ? '0' : undefined);
    outsideGit(arm.env.CLAUDE_CONFIG_DIR);
    assert.equal(existsSync(arm.dir), false);
  }
  assert.notEqual(p.out, other.out);
  assert.equal(existsSync(p.out), false);
});

test('in-worktree output is rejected by production dry setup and WF3 before writes', async t => {
  const p = plan(sandbox(t)), out = join(p.root, 'bench/results/wf3-rejected-offline', 'out');
  const round = p.rounds[0];
  assert.throws(() => dryBrowser(p, round, join(out, round.id)), /outside any git repository/);
  assert.throws(() => plan(out), /outside any git repository/);
  let calls = 0;
  await assert.rejects(runWorkflow({ ...p, out }, { ownerAway: true, runtime: runtime(p, {
    verifyPins: () => calls++, readEngine: () => { calls++; return { version: engine }; },
    gate: () => calls++, run: () => assert.fail('runner reached'),
  }) }), /outside any git repository/);
  assert.equal(calls, 0);
  assert.equal(existsSync(dirname(out)), false);
});

test('output preflight rechecks Git ancestors after planning, including linked-worktree files', async t => {
  for (const marker of ['directory', 'file']) {
    const out = sandbox(t), p = plan(out), dotgit = join(dirname(out), '.git');
    if (marker === 'directory') mkdirSync(dotgit);
    else writeFileSync(dotgit, 'gitdir: /offline/linked-worktree');
    let calls = 0;
    await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
      verifyPins: () => calls++, gate: () => calls++, run: () => assert.fail('runner reached'),
    }) }), /outside any git repository/);
    assert.equal(calls, 0);
    assert.equal(existsSync(out), false);
  }
});

const refusalEvents = content => JSON.stringify({ type: 'user', message: { role: 'user', content: [
  { type: 'tool_result', tool_use_id: 'toolu_offline', is_error: true, content },
] } }) + '\n';
const refusal = 'Computer Use was not approved to use Safari';
const nativeRefusals = [
  "Computer Use is not allowed to use the app 'Terminal' for safety reasons.",
  refusal,
  "The user didn't allow dragging in Safari. Stop and tell them; don't work around it.",
  'The user did not allow this action',
  'The user did not approve this document',
  'approval declined', 'permission denied', 'not approved',
  'Browser Use could not complete this action. Reason: The permission request was dismissed before a decision was made.',
  'Browser Use could not complete this action. Reason: The permission request was denied.',
];

test('a production refusal beside a success stops even below the batch harness threshold', t => {
  const { p, round, stem, rows } = browserFixture(t);
  const group = p.groups.find(g => g.id === round.group), task = group.tasks[1];
  // This old two-task shape proves the review trigger independently of the new task boundary.
  const batch = { ...round, tasks: [...group.tasks] };
  rows.splice(1);
  rows.push({ ...structuredClone(rows[0]), task: { name: task, browser: round.browser, prompt: group.taskPins[task].prompt } });
  rows[0].outcome.ok = false;
  rows[0].errorClass = runErrorClass({ eventsText: refusalEvents(refusal) });
  assert.equal(rows[0].errorClass.class, 'approval refused');
  assert.equal(harnessFailure(rows.map(row => ({ task: row.task.name, ok: row.outcome.ok, errorClass: row.errorClass }))), null);
  put(join(stem, task, 'mcp.json'), { mcpServers: { 'plugin:sleight:computer': { env: { SLEIGHT_TURBO: '0', SLEIGHT_WORKFLOW_DOCS: '0' } } } });
  writeFileSync(join(stem, task, 'events.jsonl'), '');
  put(join(stem, 'results.json'), rows);
  assert.throws(() => collectWorkflow(batch, p), /permission|safety/i);
});

test('production refusal classes and tool-result events stop before another task or side', async t => {
  const cases = [{ kind: 'class', text: refusal, passed: false }];
  for (const text of nativeRefusals) for (const blocks of [false, true]) for (const passed of [false, true])
    cases.push({ kind: `${text}, ${blocks ? 'blocks' : 'string'}, ${passed ? 'recovered' : 'failed'}`, text, blocks, passed });
  // The scorer chooses one class, so a daemon error in the same event must not hide a refusal.
  cases.push({ kind: 'scorer precedence', text: refusal, passed: true, daemon: true });
  for (const { kind, text, blocks, passed, daemon } of cases) await t.test(kind, async t => {
    const { p, round, stem, rows } = browserFixture(t);
    // Keep plan output fresh for runWorkflow. The injected child publishes the fixture at its task boundary.
    const artifacts = JSON.parse(readFileSync(join(stem, 'commits.json')));
    rmSync(p.out, { recursive: true });
    let calls = 0;
    await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
      collect: collectWorkflow,
      run: async current => {
        calls++;
        assert.equal(current.id, round.id);
        rows[0].outcome.ok = passed;
        rows[0].errorClass = kind === 'class' ? { class: 'approval refused', example: refusal } : null;
        put(join(stem, 'cleanup.json'), { browserClosed: true });
        put(join(stem, 'engine.json'), { version: engine, changed: false });
        put(join(stem, 'commits.json'), artifacts);
        put(join(stem, 'results.json'), rows);
        for (const task of round.tasks) {
          put(join(stem, task, 'mcp.json'), { mcpServers: { 'plugin:sleight:computer': { env: { SLEIGHT_TURBO: '0', SLEIGHT_WORKFLOW_DOCS: '0' } } } });
          writeFileSync(join(stem, task, 'events.jsonl'), '');
        }
        const event = JSON.parse(refusalEvents(blocks ? [{ type: 'text', text }] : text));
        if (daemon) {
          event.message.content.unshift({ type: 'tool_result', is_error: true, content: 'daemon is not running' });
          rows[0].errorClass = runErrorClass({ eventsText: JSON.stringify(event) });
          assert.equal(rows[0].errorClass.class, 'no daemon');
          put(join(stem, 'results.json'), rows);
        }
        writeFileSync(join(stem, round.tasks[0], 'events.jsonl'), kind === 'class' ? '' : JSON.stringify(event) + '\n');
        return { code: rows[0].outcome.ok ? 0 : 1, signal: null };
      },
    }) }), /permission|safety/i);
    assert.equal(calls, 1, kind);
    assert.equal(JSON.parse(readFileSync(join(p.out, `${round.id}.receipt.json`))).safe, false);
    assert.equal(JSON.parse(readFileSync(join(p.out, 'failure.json'))).completedTasks, 0);
    assert.equal(existsSync(join(p.out, 'summary.json')), false);
  });
});

test('survey collection continues on ordinary AX errors and successful refusal wording', t => {
  const ordinary = ['AX fixture read failed: -25204', 'Permission denied: enable Accessibility in System Settings',
    'Authorization required. Open the app to grant access.', 'Approval declined by user'];
  for (const text of [...ordinary, ...nativeRefusals]) for (const blocks of [false, true]) {
    const { p, round, stem } = browserFixture(t);
    const event = JSON.parse(refusalEvents(blocks ? [{ type: 'text', text }] : text));
    event.message.content[0].is_error = ordinary.includes(text);
    writeFileSync(join(stem, round.tasks[0], 'events.jsonl'), JSON.stringify(event) + '\n' +
      JSON.stringify({ type: 'result', result: refusal }) + '\n');
    assert.equal(collectWorkflow(round, p).safe, true, `${text}, blocks=${blocks}`);
  }
});

test('summary uses passing lower median and range while expected time counts failures', () => {
  const p = plan(), group = p.groups[0], task = group.tasks[0];
  const rows = [
    { seconds: 2, passed: true }, { seconds: 100, passed: false }, { seconds: 4, passed: true },
  ].map(row => ({ ...row, group: group.id, task, side: 'docs0' }));
  const cell = workflowSummary(p, rows).cells[0];
  assert.equal(cell.runs, 3); assert.equal(cell.passes, 2);
  assert.equal(cell.medianSeconds, 2); assert.deepEqual(cell.rangeSeconds, [2, 4]);
  assert.equal(cell.expectedSeconds, 53);
  for (const sample of [[], rows.map(row => ({ ...row, passed: false }))]) {
    const empty = workflowSummary(p, sample).cells[0];
    assert.equal(empty.medianSeconds, null); assert.equal(empty.rangeSeconds, null);
    assert.equal(empty.expectedSeconds, null);
  }
});
