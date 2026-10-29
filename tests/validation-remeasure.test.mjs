import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { makeRemeasurePlan, runRemeasure, compareRemeasure, verifyFinalBuild } from '../bench/validation/remeasure.mjs';
import { buildHarnessEvidence, pinRun } from '../bench/validation/validation-140.mjs';
import { sha } from '../bench/validation/audit-140.mjs';

const MODEL = 'claude-haiku-5-5', ENGINE = 'fixture-engine';
// This file uses fake runners. The real-page suite's inherited opt-in is not a
// benchmark override for these offline fixtures or their CLI children.
delete process.env.SLEIGHT_LIVE_DOM_TEST;
const put = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
const snapshot = dir => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => { const file = join(e.parentPath, e.name); return [file, sha(readFileSync(file))]; }));

function native(build, tasks, seconds = 34, passed = true) {
  return { sleight: { commit: build }, engine: { version: ENGINE, changed: false }, model: MODEL, effort: 'high',
    results: tasks.map(task => ({ task, arm: 'sleight', seconds, passed, models: [MODEL], groupClean: true })),
    leftWindows: [], hygiene: { errors: [], trackingErrors: [] } };
}

function fixture({ runner = 'native', count = 3, reuse = false, legacy = false, external = false, nativeResult = native } = {}) {
  const bank = mkdtempSync(join(tmpdir(), 'remeasure-test-')), root = join(bank, 'repo'), baseline = join(bank, 'baseline'), out = join(bank, 'final');
  mkdirSync(root); mkdirSync(baseline);
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const paths = ['plugins/sleight/product.mjs', 'bench/run.mjs', 'bench/validation/driver.mjs'];
  for (const path of paths) put(join(root, path), 'original');
  git('add', '--', ...paths);
  git('commit', '-qm', 'A fixture\n\nCo-Authored-By: GPT-6.1-sol (Codex lane) <noreply@openai.com>', '--', ...paths);
  const aBuild = git('rev-parse', 'HEAD');
  put(join(root, paths[0]), 'B product');
  git('commit', '-qm', 'B fixture\n\nCo-Authored-By: GPT-6.1-sol (Codex lane) <noreply@openai.com>', '--', paths[0]);
  const bBuild = git('rev-parse', 'HEAD');
  put(join(root, paths[0]), 'final integrated product'); put(join(root, paths[2]), 'new driver');
  git('commit', '-qm', 'Final fixture\n\nCo-Authored-By: GPT-6.1-sol (Codex lane) <noreply@openai.com>', '--', paths[0], paths[2]);
  const build = git('rev-parse', 'HEAD'), tasks = ['wheel', 'other'];
  const group = { id: 'native', runner, ...(runner === 'browser' ? { browser: 'firefox' } : {}), model: MODEL, tasks, rounds: count, reuse: [] };
  const rounds = Array.from({ length: count }, (_, i) => ({ id: `native-A-r${i + 1}`, group: group.id, side: 'A', n: i + 1,
    runner, browser: group.browser, model: MODEL, tasks }));
  const plan = { schema: 1, root, out: baseline, aBuild, bBuild, engine: ENGINE,
    harnessHash: buildHarnessEvidence({ root, aBuild, bBuild }, root).hash, blockers: [], groups: [group], rounds: reuse ? [] : rounds };
  function browser(dir, pin, seconds = 34, pass = true) {
    mkdirSync(dir, { recursive: true });
    put(join(dir, 'results.json'), tasks.map(name => ({ task: { name, prompt: `Original ${name}` }, surface: 'sleight', wallMs: seconds * 1000,
      outcome: { ok: pass, problems: pass ? [] : ['fixture task failed'] }, successfulBrowserCalls: 1,
      run: { groupClean: true, result: { modelUsage: { [MODEL]: {} } } } })));
    put(join(dir, 'cleanup.json'), { browserClosed: true }); put(join(dir, 'engine.json'), { version: ENGINE, changed: false });
    put(join(dir, 'commits.json'), { build: { commit: pin }, harness: { commit: pin }, fowlbrowser: { commit: 'f'.repeat(40), dirty: 1 } });
    return dir;
  }
  for (const round of rounds) {
    const evidence = external ? join(bank, 'historical') : baseline;
    const result = runner === 'native' ? join(evidence, `${round.id}.json`) : join(evidence, round.id);
    if (runner === 'native') put(result, nativeResult(aBuild, tasks)); else browser(result, aBuild);
    if (reuse) group.reuse.push({ n: round.n, name: round.id, path: runner === 'native' ? result : join(result, 'results.json'),
      fileHash: sha(readFileSync(runner === 'native' ? result : join(result, 'results.json'))), build: aBuild, tasks });
    else put(join(baseline, `${round.id}.receipt.json`), { ...round, code: 0, signal: null, safe: true, result,
      harnessHash: plan.harnessHash, build: aBuild, engine: ENGINE });
  }
  put(join(baseline, 'plan.json'), plan); put(join(baseline, 'harness.json'), buildHarnessEvidence(plan, root));
  put(join(baseline, 'full-check.receipt.json'), { code: 0, signal: null, build: bBuild });
  put(join(baseline, 'full-check.log'), 'fixture passed');
  put(join(baseline, 'validate-140.log'), `2026-10-20T00:00:00Z full-check-start ${JSON.stringify({ build: bBuild })}\n2026-10-20T00:01:00Z full-check-exit {"code":0,"signal":null}\n`);
  if (!legacy) pinRun(plan);
  const opts = { baseline, tasks: 'native:wheel', build, engine: ENGINE, out, repository: root };
  return { bank, root, baseline, out, git, opts, plan, build, aBuild, browser,
    make: changes => makeRemeasurePlan({ ...opts, ...changes }), close: () => rmSync(bank, { recursive: true, force: true }) };
}

function fakeHost(f, { seconds = 33, passed = true, code = 0, mutate } = {}) {
  const calls = [], engineCalls = [];
  return { calls, engineCalls, run: async (command, args, cwd, log) => {
    calls.push({ command, args, cwd, log });
    assert.equal(cwd, f.root);
    assert.ok(args.includes(MODEL)); assert.ok(args.includes('high'));
    const result = join(f.bank, `fake-result-${calls.length}.json`);
    if (command === 'node') { put(result, native(f.build, f.plan.groups[0].tasks, seconds, passed)); put(log, `results: ${result}\n`); }
    else { f.browser(log.slice(0, -4), f.build, seconds, passed); put(log, 'fixture browser completed'); }
    mutate?.(calls.length, result);
    return { code, signal: null };
  }, gate: async () => {}, apps: async () => {}, engine: p => { assert.equal(p.engine, ENGINE); engineCalls.push(p.engine); } };
}

test('real re-measure admission still refuses the real-page test override', async () => {
  process.env.SLEIGHT_LIVE_DOM_TEST = '1';
  try { await assert.rejects(runRemeasure(), /Unset benchmark overrides first: SLEIGHT_LIVE_DOM_TEST/); }
  finally { delete process.env.SLEIGHT_LIVE_DOM_TEST; }
});

test('re-measures three final-build rounds and retains every A round and all baseline bytes', async () => {
  const f = fixture({ count: 5 });
  try {
    const before = snapshot(f.baseline), p = f.make(), host = fakeHost(f);
    assert.equal(p.rounds.length, 3); assert.equal(p.groups[0].aRounds.length, 5);
    assert.deepEqual(p.rounds[0].tasks, ['wheel', 'other'], 'keep original task selection and order');
    assert.deepEqual(p.groups[0].selectedTasks, ['wheel']);
    assert.notEqual(p.build, p.baselineBuild); assert.match(p.pluginTree, /^[a-f0-9]{40}$/);
    const got = await runRemeasure(p, host);
    assert.equal(got.passed, true); assert.equal(host.calls.length, 3); assert.equal(host.engineCalls.length, 6);
    assert.equal(got.groups[0].tasks[0].a.runs.length, 5); assert.equal(got.groups[0].tasks[0].b.runs.length, 3);
    assert.equal(JSON.parse(readFileSync(join(f.out, 'comparison.json'))).build, f.build);
    for (const call of host.calls) assert.deepEqual(call.args.slice(call.args.indexOf('--tasks'), call.args.indexOf('--tasks') + 2), ['--tasks', 'wheel,other']);
    assert.deepEqual(snapshot(f.baseline), before);
    await assert.rejects(runRemeasure(p, host), /already exists/);
  } finally { f.close(); }
});

test('47 seconds against recorded 34 seconds holds the final build without dropping failures', async () => {
  const f = fixture();
  try {
    const got = await runRemeasure(f.make(), fakeHost(f, { seconds: 47 }));
    assert.equal(got.passed, false); assert.equal(got.groups[0].tasks[0].speedRegression, true);
    assert.equal(got.groups[0].tasks[0].a.expected, 34); assert.equal(got.groups[0].tasks[0].b.expected, 47);
    assert.equal(existsSync(join(f.out, 'comparison.json')), true);
  } finally { f.close(); }
});

test('fast task failures count against pass rate and expected time, even with runner exit 1', async () => {
  const f = fixture();
  try {
    const got = await runRemeasure(f.make(), fakeHost(f, { seconds: 1, passed: false, code: 1 }));
    const task = got.groups[0].tasks[0];
    assert.equal(got.passed, false); assert.equal(task.b.runs.length, 3); assert.equal(task.b.passes.length, 0);
    assert.equal(task.b.expected, null); assert.equal(task.passRegression, true);
  } finally { f.close(); }
});

test('compatible reused A evidence and legacy plan verification stay read-only', async () => {
  for (const reuse of [false, true]) {
    const f = fixture({ reuse, legacy: true });
    try {
      const before = snapshot(f.baseline), got = await runRemeasure(f.make(), fakeHost(f));
      assert.equal(got.passed, true); assert.deepEqual(snapshot(f.baseline), before);
      assert.equal(existsSync(join(f.baseline, 'run-identity.json')), false);
    } finally { f.close(); }
  }
});

test('browser fake harness uses the original surface, model, tasks and provenance', async () => {
  const f = fixture({ runner: 'browser' });
  try {
    const host = fakeHost(f), got = await runRemeasure(f.make(), host);
    assert.equal(got.passed, true); assert.equal(host.calls.length, 3);
    assert.equal(host.calls[0].command, '/bin/sh');
    assert.ok(host.calls[0].args.includes('firefox')); assert.ok(host.calls[0].args.includes('sleight'));
    assert.ok(host.calls[0].args.includes('wheel,other'));
  } finally { f.close(); }
});

test('browser prompt and upstream changes refuse a final result and preserve its failure receipt', async () => {
  for (const field of ['prompt', 'upstream']) {
    const f = fixture({ runner: 'browser' });
    try {
      const host = fakeHost(f, { mutate: () => {
        const dir = host.calls[0].log.slice(0, -4), file = join(dir, field === 'prompt' ? 'results.json' : 'commits.json');
        const raw = JSON.parse(readFileSync(file));
        if (field === 'prompt') raw[0].task.prompt = 'changed prompt';
        else raw.fowlbrowser.commit = 'e'.repeat(40);
        put(file, raw);
      } });
      await assert.rejects(runRemeasure(f.make(), host), /unproved cleanup/);
      const receipt = JSON.parse(readFileSync(join(f.out, 'native-final-r1.receipt.json')));
      assert.equal(receipt.safe, false); assert.match(receipt.error, /provenance changed/); assert.equal(host.calls.length, 1);
    } finally { f.close(); }
  }
});

test('new browser grader inputs added after planning invalidate the baseline', async () => {
  const f = fixture({ runner: 'browser' });
  try {
    const host = fakeHost(f, { mutate: () => put(join(f.baseline, 'native-A-r1', 'wheel', 'events.jsonl'), 'new events') });
    await assert.rejects(runRemeasure(f.make(), host), /Baseline evidence changed/);
    assert.equal(host.calls.length, 1); assert.equal(existsSync(join(f.out, 'comparison.json')), false);
  } finally { f.close(); }
});

test('missing, invalid, ambiguous and incompatible A baselines refuse before output creation', () => {
  const cases = [
    ['missing receipt', f => rmSync(join(f.baseline, 'native-A-r2.receipt.json'))],
    ['wrong model', f => { const file = join(f.baseline, 'native-A-r1.json'), raw = JSON.parse(readFileSync(file)); raw.model = 'other'; put(file, raw); }],
    ['engine changed', f => { const file = join(f.baseline, 'native-A-r1.json'), raw = JSON.parse(readFileSync(file)); raw.engine.changed = true; put(file, raw); }],
    ['cleanup missing', f => { const file = join(f.baseline, 'native-A-r1.json'), raw = JSON.parse(readFileSync(file)); raw.results[0].groupClean = false; put(file, raw); }],
    ['duration invalid', f => { const file = join(f.baseline, 'native-A-r1.json'), raw = JSON.parse(readFileSync(file)); raw.results[0].seconds = null; put(file, raw); }],
    ['duplicate row', f => { const file = join(f.baseline, 'native-A-r1.json'), raw = JSON.parse(readFileSync(file)); raw.results[1] = raw.results[0]; put(file, raw); }],
    ['hash changed', f => put(join(f.baseline, 'harness.json'), {})],
    ['check failed', f => put(join(f.baseline, 'full-check.receipt.json'), { code: 1 })],
    ['writer active', f => mkdirSync(join(f.baseline, '.active-run'))],
    ['receipt side changed', f => { const file = join(f.baseline, 'native-A-r1.receipt.json'), raw = JSON.parse(readFileSync(file)); raw.side = 'B'; put(file, raw); }],
  ];
  for (const [name, damage] of cases) {
    const f = fixture();
    try { damage(f); assert.throws(() => f.make(), undefined, name); assert.equal(existsSync(f.out), false); }
    finally { f.close(); }
  }
  const f = fixture({ count: 1 });
  try { assert.throws(() => f.make(), /at least 3/); } finally { f.close(); }
});

test('rewritten or changed plan pins and changed task/prompt harness refuse, never rebase evidence', () => {
  const f = fixture();
  try {
    assert.throws(() => f.make({ engine: 'new-engine' }), /engine/);
    assert.throws(() => f.make({ build: 'a'.repeat(40) }));
    for (const tasks of ['', 'wheel', 'native:absent', 'absent:wheel', 'native:wheel,native:wheel']) assert.throws(() => f.make({ tasks }));
    const before = snapshot(f.baseline);
    put(join(f.root, 'bench/run.mjs'), 'changed task prompt');
    f.git('commit', '-qm', 'Harness fixture\n\nCo-Authored-By: GPT-6.1-sol (Codex lane) <noreply@openai.com>', '--', 'bench/run.mjs');
    assert.throws(() => f.make({ build: f.git('rev-parse', 'HEAD') }), /Task\/prompt\/harness changed/);
    assert.deepEqual(snapshot(f.baseline), before);
  } finally { f.close(); }
});

test('dirty final build, changed HEAD and evidence changes stop admission and later rounds', async () => {
  const f = fixture();
  try {
    const p = f.make(), host = fakeHost(f, { mutate: count => { if (count === 1) put(join(f.baseline, 'native-A-r1.json'), '{}'); } });
    put(join(f.root, '.vale', 'styles', 'local.txt'), 'local prose checker resources');
    assert.doesNotThrow(() => verifyFinalBuild(p));
    put(join(f.root, 'plugins/sleight/product.mjs'), 'dirty');
    assert.throws(() => verifyFinalBuild(p), /dirty/);
    await assert.rejects(runRemeasure(p, host), /dirty/); assert.equal(existsSync(f.out), false);
    f.git('restore', '--', 'plugins/sleight/product.mjs');
    await assert.rejects(runRemeasure(p, host), /Baseline evidence changed/);
    assert.equal(host.calls.length, 1); assert.equal(existsSync(join(f.out, 'native-final-r1.receipt.json')), true);
    assert.equal(existsSync(join(f.out, 'comparison.json')), false);
    f.git('checkout', '--detach', f.aBuild);
    assert.throws(() => verifyFinalBuild(p), /HEAD changed/);
  } finally { f.close(); }
});

test('unsafe child exits retain receipt and log, stop after one attempt and produce no verdict', async () => {
  const f = fixture();
  try {
    const host = fakeHost(f, { code: 2 });
    await assert.rejects(runRemeasure(f.make(), host), /unproved cleanup/);
    assert.equal(host.calls.length, 1);
    const receipt = JSON.parse(readFileSync(join(f.out, 'native-final-r1.receipt.json')));
    assert.equal(receipt.code, 2); assert.equal(receipt.safe, false);
    assert.match(readFileSync(join(f.out, 'remeasure.log'), 'utf8'), /round-exit.*"code":2/);
    assert.equal(existsSync(join(f.out, 'comparison.json')), false);
  } finally { f.close(); }
});

test('wrong final build, model, effort, engine or cleanup refuses before another round', async () => {
  for (const damage of [raw => { raw.sleight.commit = 'e'.repeat(40); }, raw => { raw.model = 'other'; },
    raw => { raw.effort = 'low'; }, raw => { raw.engine.version = 'new-engine'; },
    raw => { raw.results[0].groupClean = false; }]) {
    const f = fixture();
    try {
      const host = fakeHost(f, { mutate: (_, file) => { const raw = JSON.parse(readFileSync(file)); damage(raw); put(file, raw); } });
      await assert.rejects(runRemeasure(f.make(), host), /unproved cleanup/);
      assert.equal(host.calls.length, 1); assert.equal(existsSync(join(f.out, 'comparison.json')), false);
    } finally { f.close(); }
  }
});

test('engine admission and child launch errors retain stopped evidence with no score', async () => {
  for (const boundary of ['engine', 'run']) {
    const f = fixture();
    try {
      const host = fakeHost(f); host[boundary] = () => { throw Error(`fixture ${boundary} failed`); };
      await assert.rejects(runRemeasure(f.make(), host), new RegExp(`fixture ${boundary} failed`));
      assert.match(readFileSync(join(f.out, 'remeasure.log'), 'utf8'), /stopped/);
      assert.equal(existsSync(join(f.out, 'comparison.json')), false);
    } finally { f.close(); }
  }
});

test('incomplete final samples cannot produce a passing comparison', () => {
  const f = fixture();
  try {
    const p = f.make(); assert.throws(() => compareRemeasure(p, []), /Missing/);
    assert.throws(() => compareRemeasure(p, [1, 2, 3].map(() => ({ group: 'native', task: 'wheel', side: 'B', round: 'duplicate', seconds: 1, passed: true }))), /duplicate/);
  } finally { f.close(); }
});

test('pass-rate regression holds even when failures are fast, and speed has no tolerance override', () => {
  const f = fixture();
  try {
    const p = f.make(), rows = [1, 2, 3].map(n => ({ group: 'native', task: 'wheel', side: 'B', round: `B-${n}`, seconds: 34, passed: true }));
    assert.equal(compareRemeasure(p, rows).passed, true);
    assert.equal(compareRemeasure(p, rows.map(r => ({ ...r, seconds: 34.00001 }))).passed, false);
    const got = compareRemeasure(p, rows.map((r, i) => ({ ...r, seconds: 1, passed: i !== 2 })));
    const task = got.groups[0].tasks[0];
    assert.equal(task.b.expected, 1.5); assert.equal(task.speedRegression, false);
    assert.equal(task.passRegression, true); assert.equal(got.passed, false);
  } finally { f.close(); }
});

test('fresh output guard rejects baseline aliases and symlinked scorer inputs', () => {
  const f = fixture();
  try {
    symlinkSync(f.baseline, join(f.bank, 'alias'));
    assert.throws(() => f.make({ out: join(f.bank, 'alias', 'child') }), /separate/);
    const file = join(f.baseline, 'native-A-r1.json'), bytes = readFileSync(file);
    put(join(f.bank, 'external.json'), bytes); rmSync(file); symlinkSync(join(f.bank, 'external.json'), file);
    assert.throws(() => f.make(), /ordinary/);
  } finally { f.close(); }
});

// beginPassHygiene can throw with a receiptsOnly handle. Its successful finish has
// empty final arrays, while run.mjs saves the failed initial inventory separately.
function missingInitialInventory(raw, errors = ['Pass hygiene snapshot unavailable or incomplete']) {
  raw.hygiene = { leftWindows: [], errors: [], trackingErrors: [], trackingErrorCount: 0 };
  raw.leftWindows = [];
  raw.hygieneError = { errors, count: 1 };
  return raw;
}

for (const reuse of [false, true]) test(`native A ${reuse ? 'reused' : 'fresh'} receipts-only inventory failure refuses before writes`, () => {
  const f = fixture({ reuse, nativeResult: (...args) => missingInitialInventory(native(...args)) });
  try {
    const before = snapshot(f.baseline), entries = readdirSync(f.bank, { recursive: true });
    assert.throws(() => f.make(), /A identity or cleanup incompatible/);
    assert.equal(existsSync(f.out), false);
    assert.deepEqual(snapshot(f.baseline), before);
    assert.deepEqual(readdirSync(f.bank, { recursive: true }), entries);
  } finally { f.close(); }
});

for (const countOnly of [false, true]) test(`native B receipts-only ${countOnly ? 'count-only' : 'recorded'} inventory failure retains a stopped receipt`, async () => {
  const f = fixture();
  try {
    const before = snapshot(f.baseline), host = fakeHost(f, { mutate: (_, file) => {
      put(file, missingInitialInventory(JSON.parse(readFileSync(file)), countOnly ? [] : undefined));
    } });
    await assert.rejects(runRemeasure(f.make(), host), /unproved cleanup/);
    assert.equal(host.calls.length, 1);
    const receipt = JSON.parse(readFileSync(join(f.out, 'native-final-r1.receipt.json')));
    assert.equal(receipt.safe, false); assert.equal(receipt.code, 0); assert.equal(receipt.signal, null);
    assert.equal(JSON.parse(readFileSync(receipt.result)).hygieneError.count, 1);
    assert.match(readFileSync(join(f.out, 'remeasure.log'), 'utf8'), /stopped/);
    assert.equal(existsSync(join(f.out, 'comparison.json')), false);
    assert.deepEqual(snapshot(f.baseline), before);
  } finally { f.close(); }
});

for (const alias of [false, true]) test(`external reused browser evidence rejects ${alias ? 'aliased' : 'direct'} output overlap before writes`, () => {
  const f = fixture({ runner: 'browser', reuse: true, external: true });
  try {
    const evidence = dirname(f.plan.groups[0].reuse[0].path);
    let parent = evidence;
    if (alias) { parent = join(f.bank, 'historical-alias'); symlinkSync(evidence, parent); }
    const out = join(parent, 'final-remeasure'), before = snapshot(f.bank), entries = readdirSync(f.bank, { recursive: true });
    assert.throws(() => f.make({ out }), /separate.*evidence/);
    assert.equal(existsSync(out), false);
    assert.deepEqual(snapshot(f.bank), before);
    assert.deepEqual(readdirSync(f.bank, { recursive: true }), entries);
  } finally { f.close(); }
});

test('CLI refuses incomplete, duplicate and unacknowledged live requests without invoking a runner', () => {
  const script = new URL('../bench/validation/remeasure.mjs', import.meta.url).pathname;
  for (const args of [['--run'], ['--tasks'], ['--run', '--run'], ['--unknown'], ['--baseline', 'missing']]) {
    const got = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(got.status, 1); assert.ok(got.stderr.length);
  }
});
