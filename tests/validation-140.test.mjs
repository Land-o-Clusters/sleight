import { commandSkip } from './requirements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
const fixtureData = new URL('./fixtures/validation-140/', import.meta.url).pathname;
const moduleURL = new URL('../bench/validation/validation-140.mjs', import.meta.url);

// Removing the driver-only admission or dropping a recorded build must break these cases.
async function driverFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vp6-driver-'));
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  for (const path of ['plugins/sleight', 'bench/validation', 'tests']) mkdirSync(join(dir, path), { recursive: true });
  for (const path of ['plugins/sleight/product.mjs', 'bench/task.mjs', 'bench/validation/driver.mjs', 'tests/validation-140.test.mjs'])
    writeFileSync(join(dir, path), 'original');
  git('add', '.'); git('commit', '-qm', 'Product');
  const aBuild = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'plugins/sleight/product.mjs'), 'B product');
  git('commit', '-qam', 'B product');
  const product = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'bench/validation/driver.mjs'), 'new driver');
  git('commit', '-qam', 'Driver');
  const driver = git('rev-parse', 'HEAD');
  return { dir, git, aBuild, product, driver };
}

test('driver-only commits resume legacy evidence while rounds retain both product builds', async () => {
  const m = await import(moduleURL);
  assert.equal(typeof m.driverCompatibility, 'function');
  const f = await driverFixture(), out = join(f.dir, 'output'); mkdirSync(out);
  try {
    const compatibility = m.driverCompatibility(f.product, f.driver, f.dir);
    assert.deepEqual(compatibility.changed, ['bench/validation/driver.mjs']);
    const plan = { root: f.dir, out, aBuild: f.aBuild, bBuild: f.product, engine: 'e',
      harnessHash: m.buildHarnessEvidence({ root: f.dir, aBuild: f.aBuild, bBuild: f.product }, f.dir).hash,
      blockers: [], groups: [{ id: 'native' }], deferredGroups: [],
      rounds: ['A', 'B'].map(side => ({ id: `native-${side}-r1`, group: 'native', side, runner: 'native', tasks: ['one'], model: 'haiku' })) };
    writeFileSync(join(out, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(out, 'harness.json'), JSON.stringify(m.buildHarnessEvidence(plan, f.dir)));
    writeFileSync(join(out, 'full-check.receipt.json'), JSON.stringify({ code: 0, signal: null, build: f.product }));
    writeFileSync(join(out, 'full-check.log'), 'completed original check');
    writeFileSync(join(out, 'validate-140.log'), `2026-10-20T12:11:00Z full-check-start ${JSON.stringify({ build: f.product })}\n2026-10-20T12:19:00Z full-check-exit {"code":0,"signal":null}\n`);
    const candidate = { ...plan, root: join(f.dir, 'driver-checkout'), bBuild: f.driver,
      harnessHash: m.buildHarnessEvidence({ ...plan, bBuild: f.driver }, f.dir).hash };
    const select = () => m.selectRun(candidate, undefined, { resume: true, repository: f.dir, driverBuild: f.driver });
    for (const file of ['harness.json', 'full-check.receipt.json', 'validate-140.log']) {
      const original = readFileSync(join(out, file));
      const changed = file === 'harness.json' ? JSON.stringify({ ...JSON.parse(original), bPluginTree: 'changed' })
        : file === 'full-check.receipt.json' ? JSON.stringify({ ...JSON.parse(original), signal: 'changed' })
          : original.toString().replace('"code":0', '"code":1');
      writeFileSync(join(out, file), changed);
      assert.throws(select, /changed|identity|receipt/i);
      assert.equal(existsSync(join(out, 'run-identity.json')), false);
      writeFileSync(join(out, file), original);
    }
    const selection = select();
    assert.equal(selection.plan.bBuild, f.product);
    assert.equal(selection.driverBuild, f.driver);
    assert.equal(existsSync(join(out, 'run-identity.json')), false, 'selection is read only');
    const roots = { A: join(f.dir, 'A'), B: join(f.dir, 'B') };
    f.git('worktree', 'add', '--detach', roots.A, f.aBuild);
    f.git('worktree', 'add', '--detach', roots.B, f.product);
    for (const round of selection.rounds) {
      const invocation = m.roundInvocation(round, selection.plan, roots, '/output/round');
      assert.equal(invocation.build, round.side === 'A' ? f.aBuild : f.product);
      assert.equal(invocation.cwd, roots[round.side]);
    }
    assert.throws(() => m.roundInvocation(plan.rounds[1], plan, { ...roots, B: f.dir }, '/output/round'), /recorded build/);
    m.archiveAborted(selection);
    assert.equal(existsSync(join(out, 'run-identity.json')), true);
    const log = readFileSync(join(out, 'validate-140.log'), 'utf8');
    assert.match(log, /resume-start/); assert.ok(log.includes(f.driver)); assert.match(log, /legacy-identity/);
    assert.equal(select().rounds.length, 2);
    for (const file of ['full-check.receipt.json', 'full-check.log', 'harness.json', 'plan.json']) {
      const original = readFileSync(join(out, file));
      writeFileSync(join(out, file), file.endsWith('.log') ? 'changed' : JSON.stringify({ changed: true }));
      assert.throws(select, /changed|differs|full check|missing/i);
      writeFileSync(join(out, file), original);
    }
    assert.throws(() => m.selectRun({ ...candidate, engine: 'other' }, undefined,
      { resume: true, repository: f.dir, driverBuild: f.driver }), /engine/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('driver compatibility refuses product, task harness, unrelated tests and dirty product paths', async () => {
  const m = await import(moduleURL);
  assert.equal(typeof m.driverCompatibility, 'function');
  const f = await driverFixture();
  try {
    m.verifyProductWindow(f.product, f.dir);
    writeFileSync(join(f.dir, 'bench/validation/driver.mjs'), 'driver edit');
    m.verifyProductWindow(f.product, f.dir);
    writeFileSync(join(f.dir, 'plugins/sleight/product.mjs'), 'changed');
    assert.throws(() => m.verifyProductWindow(f.product, f.dir), /Build changed/);
    f.git('restore', '.');
    for (const path of ['plugins/sleight/product.mjs', 'bench/task.mjs', 'tests/other.test.mjs']) {
      writeFileSync(join(f.dir, path), 'changed'); f.git('add', path); f.git('commit', '-qm', 'Disallowed');
      assert.throws(() => m.driverCompatibility(f.product, f.git('rev-parse', 'HEAD'), f.dir), /driver.only|product|harness/i);
      f.git('reset', '--hard', f.driver);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('full check retries only the named heap file and then finishes the remaining check phases', async () => {
  const m = await import(moduleURL);
  assert.equal(typeof m.fullCheck, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'vp6-check-'));
  const name = '400 actions on a 3,000-line tree retain less than 12 MiB of extra heap';
  try {
    for (const recovery of [1, 2, 3]) {
      const calls = [], records = []; let retries = 0;
      const result = await m.fullCheck(dir, dir, (id, data) => records.push([id, data]), async (cmd, args, cwd, log) => {
        calls.push([cmd, args]);
        if (args.join(' ') === 'run check') {
          writeFileSync(log, `> test\n✖ ${name} (123ms)\nℹ fail 1\nℹ cancelled 0\n\n✖ failing tests:\n\ntest at tests/verified-results-lifetime.test.mjs:14:1\n✖ ${name} (123ms)\n  AssertionError: heap limit\n`);
          return { code: 1, signal: null };
        }
        if (cmd === 'node') { retries++; return { code: retries >= recovery ? 0 : 1, signal: null }; }
        return { code: 0, signal: null };
      });
      assert.equal(retries, Math.min(recovery, 2));
      assert.equal(result.code, recovery <= 2 ? 0 : 1);
      assert.deepEqual(calls.filter(([cmd]) => cmd === 'node').map(([, args]) => args),
        Array.from({ length: Math.min(recovery, 2) }, () => ['--test', 'tests/verified-results-lifetime.test.mjs']));
      assert.deepEqual(calls.filter(([, args]) => ['validate', 'test:mod'].includes(args[1])).map(([, args]) => args[1]), recovery <= 2 ? ['validate', 'test:mod'] : []);
      assert.equal(records.filter(([id]) => id === 'full-check-retry-exit').length, Math.min(recovery, 2));
      assert.equal(result.initial.code, 1);
    }
    for (const failure of [`✖ unrelated (1ms)\nℹ fail 1`, `✖ ${name} (1ms)\n✖ unrelated (1ms)\nℹ fail 2`, `✖ ${name} (1ms)`, `✖ ${name} extra (1ms)\nℹ fail 1`, `✖ ${name} (1ms)\nℹ fail 1\nℹ cancelled 1`]) {
      let count = 0;
      const result = await m.fullCheck(dir, dir, () => {}, async (cmd, args, cwd, log) => {
        count++; writeFileSync(log, `> test\n${failure}\n${failure.includes('cancelled') ? '' : 'ℹ cancelled 0\n'}`); return { code: 1, signal: null };
      });
      assert.equal(result.code, 1); assert.equal(count, 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('heap retry accepts TAP but retains interruptions and failures in later check phases', async () => {
  const { fullCheck } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp6-check-tail-'));
  const name = '400 actions on a 3,000-line tree retain less than 12 MiB of extra heap';
  try {
    let calls = 0;
    const passed = await fullCheck(dir, dir, () => assert.fail('passing check has no retry'), async () => {
      calls++; return { code: 0, signal: null };
    });
    assert.equal(passed.code, 0); assert.equal(calls, 1);
    for (const phase of ['validate', 'test:mod', 'signal']) {
      const phases = [];
      const result = await fullCheck(dir, dir, () => {}, async (cmd, args, cwd, log) => {
        if (args[1] === 'check') { writeFileSync(log, `> test\nnot ok 1 - ${name}\n# fail 1\n# cancelled 0\n`); return { code: 1, signal: null }; }
        if (cmd === 'node') return phase === 'signal' ? { code: null, signal: 'SIGINT' } : { code: 0, signal: null };
        phases.push(args[1]); return { code: args[1] === phase ? 2 : 0, signal: null };
      });
      assert.deepEqual(phases, phase === 'signal' ? [] : phase === 'validate' ? ['validate'] : ['validate', 'test:mod']);
      assert.equal(result.code, phase === 'signal' ? null : 2);
      assert.equal(result.retries.length, 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing or changed provenance schedules both sides', async () => {
  assert.ok(existsSync(moduleURL), 'validation planner is missing');
  const { reuseProblems } = await import(moduleURL);
  const a = { promptHash: 'p', harnessHash: 'h', model: 'haiku', effort: 'high', engine: 'e', tasks: ['one'], clean: true };
  assert.deepEqual(reuseProblems(a, a), []);
  for (const key of ['promptHash', 'harnessHash', 'model', 'effort', 'engine']) {
    assert.ok(reuseProblems(a, { ...a, [key]: 'different' }).some(p => p.includes(key)));
    assert.ok(reuseProblems({ ...a, [key]: null }, a).some(p => p.includes(key)));
  }
  assert.ok(reuseProblems({ ...a, clean: false }, a).length);
  assert.ok(reuseProblems(a, { ...a, tasks: ['one', 'two'] }).length);
});

test('plan preserves named A rounds and adds A only for changed tasks', async () => {
  assert.ok(existsSync(moduleURL), 'validation planner is missing');
  const { planGroups } = await import(moduleURL);
  const groups = [{ id: 'native', rounds: 3, tasks: ['one', 'two'], a: ['old-1', 'old-2', 'old-3'],
    both: ['two'], seconds: 30, runner: 'native', model: 'haiku' }];
  const plan = planGroups(groups);
  assert.equal(plan.rounds.length, 6);
  assert.equal(plan.rounds.filter(r => r.side === 'A').length, 3);
  assert.deepEqual(plan.rounds.find(r => r.side === 'A').tasks, ['two']);
  assert.deepEqual(plan.rounds.find(r => r.side === 'B').tasks, ['one', 'two']);
  assert.deepEqual(plan.groups[0].a, ['old-1', 'old-2', 'old-3']);
});

test('scoring counts failures, names A evidence, and refuses incomplete comparisons', async () => {
  assert.ok(existsSync(moduleURL), 'validation planner is missing');
  const { compareRows } = await import(moduleURL);
  const rows = [
    { side: 'A', task: 'one', seconds: 10, passed: true, round: 'old-1' },
    { side: 'A', task: 'one', seconds: 30, passed: false, round: 'old-2' },
    { side: 'B', task: 'one', seconds: 15, passed: true, round: 'new-1' },
    { side: 'B', task: 'one', seconds: 15, passed: true, round: 'new-2' },
  ];
  const got = compareRows(rows, ['one'], 2);
  assert.equal(got.complete, true);
  assert.equal(got.table.A.one.expected, 40);
  assert.equal(got.table.B.one.expected, 15);
  assert.deepEqual(got.aRounds, ['old-1', 'old-2']);
  assert.equal(compareRows(rows.slice(0, 3), ['one'], 2).complete, false);
  assert.equal(compareRows([...rows, rows[0]], ['one'], 2).complete, false);
});

test('cleanup, engine or model uncertainty refuses continuation', async () => {
  const { safeResult } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp1-receipt-'));
  const path = join(dir, 'result.json');
  const raw = { model: 'haiku', effort: 'high', engine: { version: 'e', changed: false },
    results: [{ task: 'one', seconds: 10, groupClean: true, models: ['haiku'] }], leftWindows: [], hygiene: { errors: [], trackingErrors: [] } };
  try {
    writeFileSync(path, JSON.stringify(raw));
    assert.equal(safeResult(path, 'native', ['one'], 'e', 'haiku'), true);
    for (const bad of [
      { ...raw, leftWindows: ['unclosed'] }, { ...raw, engine: { version: 'other', changed: false } },
      { ...raw, model: 'opus' }, { ...raw, results: [{ ...raw.results[0], groupClean: false }] },
      { ...raw, results: [] },
    ]) {
      writeFileSync(path, JSON.stringify(bad));
      assert.equal(safeResult(path, 'native', ['one'], 'e', 'haiku'), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('both builds use explicit current task catalogs, including the changed demoid prompt', async () => {
  const { roundCommand } = await import(moduleURL);
  assert.equal(typeof roundCommand, 'function', 'round command builder is missing');
  const root = '/owned/A', stem = '/owned/out/round';
  const r = { runner: 'browser', group: 'race-safari', browser: 'safari', model: 'haiku', tasks: ['demoid'] };
  const got = roundCommand(r, root, stem);
  assert.equal(got.command, '/bin/sh');
  assert.equal(got.args[got.args.indexOf('--tasks') + 1], '/owned/A/bench/world/tasks/fowlbrowser.json');
  const as3 = roundCommand({ ...r, group: 'as3-safari' }, root, stem);
  assert.equal(as3.args[as3.args.indexOf('--tasks') + 1], '/owned/A/bench/world/tasks/browser-open-heldout.json');
});

test('shared harness imports B helpers while leaving the A server path intact', async () => {
  const { sharedHarnessSource } = await import(moduleURL);
  assert.equal(typeof sharedHarnessSource, 'function', 'shared helper import staging is missing');
  const dir = mkdtempSync(join(tmpdir(), 'vp1-import-'));
  try {
    for (const d of ['A/bench', 'A/plugins', 'B/plugins']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'A/plugins/helper.mjs'), "export const value = 'old helper';\n");
    writeFileSync(join(dir, 'B/plugins/helper.mjs'), "export const value = 'shared helper';\n");
    const source = "import { value } from '../plugins/helper.mjs'; export { value }; export const server = '../plugins/server.mjs';\n";
    const got = sharedHarnessSource(source, 'bench/load.mjs', join(dir, 'B'));
    const file = join(dir, 'A/bench/load.mjs'); writeFileSync(file, got.source);
    const loaded = await import(pathToFileURL(file));
    assert.equal(loaded.value, 'shared helper');
    assert.equal(loaded.server, '../plugins/server.mjs');
    assert.deepEqual(got.imports, ['plugins/helper.mjs']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline scorer checks actual model evidence, not just the driver receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vp1-score-'));
  try {
    const rounds = ['A', 'B'].map(side => ({ id: side, side, group: 'native', runner: 'native', model: 'haiku', tasks: ['one'] }));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ aBuild: 'a', bBuild: 'b', engine: 'e', harnessHash: 'hh', rounds,
      groups: [{ id: 'native', tasks: ['one'], both: ['one'], a: [], rounds: 1 }] }));
    for (const side of ['A', 'B']) {
      const result = join(dir, `${side}.json`), build = side.toLowerCase();
      writeFileSync(result, JSON.stringify({ sleight: { commit: build }, model: 'haiku', effort: 'high', engine: { version: 'e', changed: false },
        results: [{ task: 'one', arm: 'sleight', seconds: 10, passed: true, groupClean: true, models: ['haiku'] }],
        leftWindows: [], hygiene: { errors: [], trackingErrors: [] } }));
      writeFileSync(join(dir, `${side}.receipt.json`), JSON.stringify({ safe: true, build, harnessHash: 'hh', engine: 'e', result }));
    }
    writeFileSync(join(dir, 'full-check.receipt.json'), JSON.stringify({ build: 'b', code: 0 }));
    let got = spawnSync(process.execPath, [moduleURL.pathname, '--score', '--out', dir], { encoding: 'utf8' });
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /A rounds: .*A\.json/);
    const changed = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'B.json')));
    changed.results[0].models = ['opus'];
    writeFileSync(join(dir, 'B.json'), JSON.stringify(changed));
    got = spawnSync(process.execPath, [moduleURL.pathname, '--score', '--out', dir], { encoding: 'utf8' });
    assert.notEqual(got.status, 0, 'edited model evidence was counted as a complete comparison');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('zsh plan and invalid invocation never create output or run a child benchmark', { skip: commandSkip('zsh', '/bin') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vp1-plan-'));
  try {
    const command = new URL('../bench/validation/validate-140.command', import.meta.url).pathname;
    assert.ok(existsSync(command), 'validation command is missing');
    const got = spawnSync('/bin/zsh', [command, '--plan', '--data', fixtureData, '--out', dir], { encoding: 'utf8' });
    assert.equal(got.status, 0, got.stderr);
    const plan = JSON.parse(got.stdout);
    assert.ok(plan.rounds.length >= 30);
    assert.equal(plan.live, false);
    assert.deepEqual(plan.groups.find(g => g.id === 'as3-safari').tasks,
      ['smoke-red', 'survey-p09', 'survey-p10', 'ao-moss-color', 'ao-cheapest-mug']);
    assert.deepEqual(plan.groups.find(g => g.id === 'race-safari').both.filter(t => t === 'demoid'), ['demoid']);
    assert.deepEqual(readdirSync(dir), []);
    const bad = spawnSync('/bin/zsh', [command, '--b-build'], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validation data precedence is explicit argument, environment, then the external default', async () => {
  const { validationDataDir } = await import('../bench/validation/data.mjs');
  assert.equal(validationDataDir('/fixture/explicit', { SLEIGHT_VALIDATION_DATA: '/fixture/env' }), '/fixture/explicit');
  assert.equal(validationDataDir(undefined, { SLEIGHT_VALIDATION_DATA: '/fixture/env' }), '/fixture/env');
  assert.equal(validationDataDir(undefined, {}), join(homedir(), 'Projects/sleight-wt/race-1017/validation-140'));
  assert.equal(validationDataDir('~/fixture', {}), join(homedir(), 'fixture'));
});

test('planner reads only the selected data directory and refuses missing data or stale build pins', () => {
  const env = { ...process.env, SLEIGHT_VALIDATION_DATA: fixtureData };
  let got = spawnSync(process.execPath, [moduleURL.pathname, '--plan'], { encoding: 'utf8', env });
  assert.equal(got.status, 0, got.stderr);
  const plan = JSON.parse(got.stdout);
  assert.equal(plan.groups.find(g => g.id === 'native').a[0], '~/fixture/native-r1.json');
  assert.equal(plan.out, join(homedir(), 'Projects/sleight-wt/race-1017/validation-140-runs'));
  got = spawnSync(process.execPath, [moduleURL.pathname, '--plan', '--data', fixtureData], {
    encoding: 'utf8', env: { ...env, SLEIGHT_VALIDATION_DATA: '/fixture/missing' },
  });
  assert.equal(got.status, 0, got.stderr);
  got = spawnSync(process.execPath, [moduleURL.pathname, '--plan', '--data', '/fixture/missing'], { encoding: 'utf8', env });
  assert.notEqual(got.status, 0, 'Missing selected data fell back to the private default');
  got = spawnSync(process.execPath, [moduleURL.pathname, '--plan', '--b-build', 'stale'], { encoding: 'utf8', env });
  assert.notEqual(got.status, 0);
  assert.match(got.stderr, /Audit B build differs/);
  got = spawnSync(process.execPath, [moduleURL.pathname, '--data'], { encoding: 'utf8', env });
  assert.notEqual(got.status, 0);
});

test('classification imports without reading private data and its CLI honors the selected directory', async () => {
  const classifier = new URL('../bench/validation/classify-140.mjs', import.meta.url);
  assert.equal(typeof (await import(classifier)).classify, 'function');
  const got = spawnSync(process.execPath, [classifier.pathname, '--data', '/fixture/classification-missing'], {
    encoding: 'utf8', env: { ...process.env, SLEIGHT_VALIDATION_DATA: fixtureData },
  });
  assert.notEqual(got.status, 0);
  assert.match(got.stderr, /fixture\/classification-missing\/validation-140-a\.json/);
});

test('task-path classifications allow B-only rounds and reject incomplete or stale proof', async () => {
  const { classifiedReuseProblems } = await import(moduleURL);
  assert.equal(typeof classifiedReuseProblems, 'function', 'classification validation is missing');
  const a = { bBuild: 'HEAD', bHarness: { hash: 'bh' } };
  const round = { name: 'old-r1', fileHash: 'file', harnessCommit: 'old', clean: true, engineChanged: false,
    engine: 'e', changedHarnessFiles: ['bench/unused.mjs'], tasks: [{ task: 'one', models: ['haiku'], effort: 'high' }] };
  const proof = { bBuild: 'b', bHarnessHash: 'bh', bPromptSources: {}, profiles: { entry: { files: {
    'bench/unused.mjs': { classification: 'NOT', trace: ['bench/run.mjs'], reason: 'No edge in the recorded closure.' } } } },
    rounds: [{ name: 'old-r1', fileHash: 'file', harnessCommit: 'old', profile: 'entry',
      prompts: [{ task: 'one', aRenderedHash: 'p', bRenderedHash: 'p' }] }] };
  const check = (r = round, c = proof) => classifiedReuseProblems(r, a, c, { tasks: ['one'], model: 'haiku', engine: 'e' });
  assert.deepEqual(check(), []);
  for (const c of [null, { ...proof, bHarnessHash: 'stale' }, { ...proof, bPromptSources: null },
    { ...proof, bPromptSources: { 'plugins/sleight/skills/drive-mac-apps/SKILL.md': 'stale' } }, { ...proof, rounds: [] },
    { ...proof, profiles: { entry: { files: {} } } },
    { ...proof, profiles: { entry: { files: { 'bench/unused.mjs': { classification: 'RUNS-THE-TASK', trace: ['bench/run.mjs'] } } } } },
    { ...proof, rounds: [{ ...proof.rounds[0], fileHash: 'edited' }] },
    { ...proof, rounds: [{ ...proof.rounds[0], prompts: [{ task: 'one', aRenderedHash: null, bRenderedHash: 'p' }] }] },
  ]) assert.ok(check(round, c).length, 'invalid proof allowed A reuse');
  assert.ok(check({ ...round, clean: false }).length);
  assert.ok(check({ ...round, engineChanged: true }).length);
  assert.ok(check({ ...round, tasks: [{ ...round.tasks[0], models: ['opus'] }] }).length);
});

test('mixed historical eligibility reruns A only for the disqualified round', async () => {
  const { planGroups } = await import(moduleURL);
  const plan = planGroups([{ id: 'native', tasks: ['one'], rounds: 3, both: ['one'],
    freshA: [[], ['one'], []], seconds: 10, runner: 'native', model: 'haiku' }]);
  assert.deepEqual(plan.rounds.filter(r => r.side === 'A').map(r => r.n), [2]);
  assert.equal(plan.rounds.filter(r => r.side === 'B').length, 3);
  assert.equal(plan.measuredEstimateSeconds, 40);
});

test('CC estimates use recorded task durations including failures and leave missing evidence unknown', async () => {
  const { estimateCC } = await import(moduleURL);
  assert.equal(typeof estimateCC, 'function', 'CC measured estimate is missing');
  const samples = [{ task: 'cc-one', seconds: 10, passed: true, model: 'haiku', effort: 'high' },
    { task: 'cc-one', seconds: 30, passed: false, model: 'haiku', effort: 'high' },
    { task: 'cc-one', seconds: 999, model: 'opus', effort: 'high' }];
  assert.equal(estimateCC(['cc-one'], samples, 'haiku').seconds, 120);
  assert.equal(estimateCC(['cc-one'], [], 'haiku').seconds, null);
  assert.deepEqual(estimateCC(['cc-one', 'cc-two'], samples, 'haiku').missing, ['cc-two']);
});

test('makePlan uses classifications for individual historical rounds', async () => {
  const { makePlan } = await import(moduleURL);
  const { readFileSync } = await import('node:fs');
  const real = JSON.parse(readFileSync(new URL('./fixtures/validation-140/validation-140-a.json', import.meta.url)));
  const rounds = [1, 2, 3].map(n => ({ name: `native-${n}`, kind: 'native', flags: { SLEIGHT_FS: '0' }, path: `old-${n}.json`,
    fileHash: `f${n}`, build: 'a', harnessCommit: 'old', engine: 'e', engineChanged: false, clean: true, durationSeconds: 10,
    changedHarnessFiles: ['unused'], tasks: [{ task: 'one', seconds: 10, models: ['claude-haiku-5-5'], effort: 'high' }] }));
  const audit = { ...real, rounds, problems: [], bHarness: { hash: 'bh' } };
  const classification = { bHarnessHash: 'bh', bPromptSources: {}, profiles: { offline: { files: { unused: { classification: 'NOT', trace: ['entry'], reason: 'closed path' } } } },
    rounds: rounds.map(r => ({ ...r, profile: 'offline', prompts: [{ task: 'one', aRenderedHash: 'p', bRenderedHash: r.name === 'native-2' ? 'changed' : 'p' }] })) };
  const plan = makePlan(audit, { engine: 'e', classification });
  assert.deepEqual(plan.rounds.filter(r => r.group === 'native' && r.side === 'A').map(r => r.n), [2]);
  assert.deepEqual(plan.groups.find(g => g.id === 'native').reuse.map(r => r.name), ['native-1', 'native-3']);
  assert.equal(plan.estimate.cc.seconds, null);
  assert.equal(plan.estimate.totalSeconds, null);
});

test('scorer loads only qualified historical rounds and refuses edited evidence', async () => {
  const { scoreOutput } = await import(moduleURL);
  const { sha } = await import('../bench/validation/audit-140.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'vp2-reuse-score-'));
  try {
    const raw = build => ({ sleight: { commit: build }, model: 'haiku', effort: 'high', engine: { version: 'e', changed: false },
      results: [{ task: 'one', arm: 'sleight', seconds: 10, passed: true, models: ['haiku'], groupClean: true }],
      leftWindows: [], hygiene: { errors: [], trackingErrors: [] } });
    const historical = join(dir, 'old.json'), result = join(dir, 'B.json');
    const bytes = JSON.stringify(raw('old-build')); writeFileSync(historical, bytes); writeFileSync(result, JSON.stringify(raw('b')));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ aBuild: 'a', bBuild: 'b', engine: 'e', harnessHash: 'h',
      groups: [{ id: 'native', runner: 'native', model: 'haiku', tasks: ['one'], both: [], rounds: 1, a: [historical],
        reuse: [{ path: historical, build: 'old-build', tasks: ['one'], fileHash: sha(bytes) }] }],
      rounds: [{ id: 'B', side: 'B', group: 'native', runner: 'native', model: 'haiku', tasks: ['one'] }] }));
    writeFileSync(join(dir, 'B.receipt.json'), JSON.stringify({ safe: true, build: 'b', engine: 'e', harnessHash: 'h', result }));
    writeFileSync(join(dir, 'full-check.receipt.json'), JSON.stringify({ code: 0, build: 'b' }));
    assert.equal(scoreOutput(dir).complete, true);
    writeFileSync(historical, JSON.stringify({ ...raw('old-build'), model: 'opus' }));
    assert.equal(scoreOutput(dir).complete, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Chrome counts as running only while a Google Chrome process exists, and nothing here quits it', async () => {
  const { chromeRunning } = await import('../bench/validation/validation-140.mjs');
  const calls = [];
  assert.equal(chromeRunning((cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; }), true);
  assert.equal(chromeRunning(() => ({ status: 1 })), false);
  assert.deepEqual(calls, [['/usr/bin/pgrep', '-x', 'Google Chrome']]);
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../bench/validation/validation-140.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /pkill|killall|osascript[^\n]*quit|terminate\(\)/);
  assert.match(source, /\.\.\.plan\.rounds\.filter\(r => r\.browser !== 'chrome'\), \.\.\.plan\.rounds\.filter\(r => r\.browser === 'chrome'\)/);
});

test('deferred plan keeps every group and round, names deferrals, and estimates only active rounds', async () => {
  const { planGroups } = await import(moduleURL);
  const groups = ['native', 'release-opus'].map(id => ({ id, rounds: 1, tasks: ['one'], both: ['one'],
    a: [], seconds: 10, runner: 'native', model: 'haiku' }));
  const plan = planGroups(groups, { deferGroups: ['release-opus'] });
  assert.deepEqual(plan.deferredGroups, ['release-opus']);
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.rounds.length, 4);
  assert.equal(plan.groups.find(g => g.id === 'release-opus').deferred, true);
  assert.ok(plan.rounds.filter(r => r.group === 'release-opus').every(r => r.deferred));
  assert.equal(plan.measuredEstimateSeconds, 20);
  assert.throws(() => planGroups(groups, { deferGroups: ['typo'] }), /Unknown group/);
  assert.throws(() => planGroups(groups, { deferGroups: ['native', 'native'] }), /Duplicate group/);
});

test('plan CLI accepts explicit deferral and rejects empty, unknown, or conflicting selections', () => {
  const args = [moduleURL.pathname, '--plan', '--data', fixtureData];
  const got = spawnSync(process.execPath, [...args, '--defer-groups', 'release-opus'], { encoding: 'utf8' });
  assert.equal(got.status, 0, got.stderr);
  const plan = JSON.parse(got.stdout);
  assert.deepEqual(plan.deferredGroups, ['release-opus']);
  assert.equal(plan.rounds.filter(r => r.group === 'release-opus').length, 2);
  for (const flags of [['--defer-groups', 'typo'], ['--defer-groups', ','], ['--defer-groups', 'native,'],
    ['--only-groups', 'release-opus'], ['--defer-groups', 'native', '--only-groups', 'release-opus']]) {
    const bad = spawnSync(process.execPath, [...args, ...flags], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0, flags.join(' '));
  }
});

function completionFixture(dir, planGroups) {
  const plan = { aBuild: 'a', bBuild: 'b', engine: 'e', harnessHash: 'h', out: dir, blockers: [],
    ...planGroups(['native', 'release-opus'].map(id => ({ id, runner: 'native', model: 'haiku', tasks: ['one'],
      both: ['one'], rounds: 1, a: [], seconds: 10 })), { deferGroups: ['release-opus'] }) };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'full-check.receipt.json'), JSON.stringify({ code: 0, build: 'b' }));
  const save = round => {
    const build = round.side === 'A' ? 'a' : 'b', result = join(dir, `${round.id}.json`);
    writeFileSync(result, JSON.stringify({ sleight: { commit: build }, model: 'haiku', effort: 'high',
      engine: { version: 'e', changed: false }, results: [{ task: 'one', arm: 'sleight', seconds: 10,
        passed: true, groupClean: true, models: ['haiku'] }], leftWindows: [], hygiene: { errors: [], trackingErrors: [] } }));
    writeFileSync(join(dir, `${round.id}.receipt.json`), JSON.stringify({ safe: true, build, engine: 'e', harnessHash: 'h', result }));
  };
  return { plan, save };
}

test('run selection excludes deferred rounds and refuses accidental overwrite or nondeferred completion', async () => {
  const { planGroups, selectRun } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp4-selection-'));
  try {
    const out = join(dir, 'new');
    const plan = { ...planGroups(['native', 'release-opus'].map(id => ({ id, rounds: 1, tasks: ['one'], both: ['one'], seconds: 10 })),
      { deferGroups: ['release-opus'] }), out };
    assert.equal(selectRun(plan).rounds.length, 2);
    assert.ok(selectRun(plan).rounds.every(r => r.group === 'native'));
    assert.throws(() => selectRun(plan, ['release-opus']), /existing output/);
    mkdirSync(out);
    assert.throws(() => selectRun(plan), /Output already exists/);
    const fixture = completionFixture(dir, planGroups);
    fixture.plan.rounds.filter(r => r.group === 'native').forEach(fixture.save);
    assert.throws(() => selectRun(fixture.plan, ['native']), /not deferred/);
    assert.throws(() => selectRun(fixture.plan, ['typo']), /Unknown group/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('partial scoring names deferred groups and completion appends evidence against the original plan', async () => {
  const { planGroups, selectRun, scoreOutput, saveScore } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp4-completion-'));
  try {
    const { plan, save } = completionFixture(dir, planGroups);
    plan.rounds.filter(r => r.group === 'native').forEach(save);
    const original = Object.fromEntries(readdirSync(dir).map(file => [file, readFileSync(join(dir, file), 'utf8')]));
    const partial = scoreOutput(dir);
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.deferredGroups, ['release-opus']);
    assert.deepEqual(partial.incompleteGroups, ['release-opus']);
    assert.equal(partial.groups.find(g => g.id === 'release-opus').complete, false);
    assert.match(partial.groups.find(g => g.id === 'release-opus').errors.join(' '), /DEFERRED release-opus/);
    const firstScore = saveScore(dir, partial);
    for (const key of ['aBuild', 'bBuild', 'engine', 'harnessHash'])
      assert.throws(() => selectRun({ ...plan, [key]: 'changed' }, ['release-opus']), /differs from.*plan/);
    const completion = selectRun({ ...plan, rounds: [] }, ['release-opus']);
    assert.equal(completion.completion, true);
    assert.equal(completion.rounds.length, 2);
    assert.ok(completion.rounds.every(r => r.group === 'release-opus'));
    completion.rounds.forEach(save);
    const complete = scoreOutput(dir);
    assert.equal(complete.complete, true);
    assert.deepEqual(complete.deferredGroups, []);
    assert.deepEqual(complete.incompleteGroups, []);
    assert.notEqual(saveScore(dir, complete), firstScore);
    assert.deepEqual(JSON.parse(readFileSync(firstScore)), partial);
    for (const [file, bytes] of Object.entries(original)) assert.equal(readFileSync(join(dir, file), 'utf8'), bytes);
    assert.throws(() => selectRun(plan, ['release-opus']), /already complete/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completion refuses unsafe existing evidence and partial round artifacts before selecting work', async () => {
  const { planGroups, selectRun } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp4-refuse-'));
  try {
    const { plan, save } = completionFixture(dir, planGroups);
    assert.throws(() => selectRun(plan, ['release-opus']), /nondeferred round is incomplete/);
    plan.rounds.filter(r => r.group === 'native').forEach(save);
    const check = join(dir, 'full-check.receipt.json');
    writeFileSync(check, JSON.stringify({ code: 1, build: 'b' }));
    assert.throws(() => selectRun(plan, ['release-opus']), /full check failed/);
    writeFileSync(check, JSON.stringify({ code: 0, build: 'b' }));
    const round = plan.rounds.find(r => r.group === 'release-opus');
    writeFileSync(join(dir, `${round.id}.log`), 'unfinished');
    assert.throws(() => selectRun(plan, ['release-opus']), /partial artifacts/);
    rmSync(join(dir, `${round.id}.log`));
    save(round);
    const selected = selectRun(plan, ['release-opus']);
    assert.equal(selected.rounds.length, 1);
    const result = join(dir, `${round.id}.json`), raw = JSON.parse(readFileSync(result));
    raw.results[0].groupClean = false; writeFileSync(result, JSON.stringify(raw));
    assert.throws(() => selectRun(plan, ['release-opus']), /cleanup/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function resumeFixture(dir) {
  const { planGroups, pinRun } = await import(moduleURL);
  assert.equal(typeof pinRun, 'function', 'original run integrity pins are missing');
  const fixture = completionFixture(dir, planGroups);
  writeFileSync(join(dir, 'harness.json'), 'shared harness');
  pinRun(fixture.plan);
  return fixture;
}

test('resume retains safe rounds, archives a stopped round without deletion, and scores its replacement once', async () => {
  const { selectRun, archiveAborted, scoreOutput } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp5-resume-'));
  try {
    const { plan, save } = await resumeFixture(dir);
    const [finished, stopped] = plan.rounds;
    save(finished);
    save(stopped);
    const receipt = join(dir, `${stopped.id}.receipt.json`);
    writeFileSync(receipt, JSON.stringify({ ...JSON.parse(readFileSync(receipt)), safe: false }));
    writeFileSync(join(dir, `${stopped.id}.log`), 'readiness -2700');
    mkdirSync(join(dir, stopped.id));
    writeFileSync(join(dir, stopped.id, 'partial.json'), 'partial');
    const before = Object.fromEntries(readdirSync(dir).filter(f => f.startsWith(`${finished.id}.`)).map(f => [f, readFileSync(join(dir, f), 'utf8')]));
    const selection = selectRun(plan, undefined, { resume: true });
    assert.equal(selection.resume, true);
    assert.deepEqual(selection.rounds.map(r => r.id), [stopped.id]);
    assert.equal(existsSync(receipt), true, 'selection must be read only');
    const archives = archiveAborted(selection);
    assert.equal(archives.length, 1);
    assert.equal(archives[0].to, join(dir, 'aborted', `${stopped.id}-1`));
    assert.equal(readFileSync(join(archives[0].to, `${stopped.id}.log`), 'utf8'), 'readiness -2700');
    assert.equal(readFileSync(join(archives[0].to, stopped.id, 'partial.json'), 'utf8'), 'partial');
    assert.equal(existsSync(receipt), false);
    save(stopped);
    assert.equal(scoreOutput(dir).groups.find(g => g.id === 'native').complete, true);
    for (const [file, bytes] of Object.entries(before)) assert.equal(readFileSync(join(dir, file), 'utf8'), bytes);
    writeFileSync(receipt, JSON.stringify({ ...JSON.parse(readFileSync(receipt)), safe: false }));
    const again = archiveAborted(selectRun(plan, undefined, { resume: true }));
    assert.equal(again[0].to, join(dir, 'aborted', `${stopped.id}-2`));
    assert.equal(existsSync(archives[0].to), true);
    const log = readFileSync(join(dir, 'validate-140.log'), 'utf8');
    assert.equal(log.split('\n').filter(line => line.includes(' resume-start ')).length, 2);
    assert.equal(log.split('\n').filter(line => line.includes(' resume-archive ')).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resume refuses changed plan, pins, safe evidence, full-check receipt, or staged harness before moving files', async () => {
  const { selectRun } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp5-pins-'));
  try {
    const { plan, save } = await resumeFixture(dir);
    const select = candidate => selectRun(candidate ?? plan, undefined, { resume: true });
    for (const key of ['aBuild', 'bBuild', 'engine', 'harnessHash'])
      assert.throws(() => select({ ...plan, [key]: 'changed' }), /differs|changed/);
    assert.throws(() => select({ ...plan, rounds: [] }), /plan.*changed|plan.*differs/i);
    const planFile = join(dir, 'plan.json'), bytes = readFileSync(planFile);
    writeFileSync(planFile, JSON.stringify({ ...plan, rounds: [] }));
    assert.throws(() => select(), /plan.*changed|plan.*differs/i);
    writeFileSync(planFile, bytes);
    for (const file of ['full-check.receipt.json', 'harness.json']) {
      const original = readFileSync(join(dir, file));
      writeFileSync(join(dir, file), file.startsWith('full') ? JSON.stringify({ code: 0, build: 'b', signal: 'changed' }) : 'changed');
      assert.throws(() => select(), /changed/);
      writeFileSync(join(dir, file), original);
    }
    save(plan.rounds[0]);
    const result = join(dir, `${plan.rounds[0].id}.json`), raw = JSON.parse(readFileSync(result));
    raw.results[0].groupClean = false;
    writeFileSync(result, JSON.stringify(raw));
    assert.throws(() => select(), /cleanup/);
    assert.equal(existsSync(join(dir, 'aborted')), false);
    rmSync(join(dir, 'run-identity.json'));
    assert.throws(() => select(), /integrity|identity/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resume handles missing and malformed receipts, leaves later safe rounds, and respects deferred selections', async () => {
  const { selectRun, archiveAborted } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp5-partial-'));
  try {
    const { plan, save } = await resumeFixture(dir);
    const [first, second] = plan.rounds;
    save(second);
    writeFileSync(join(dir, `${first.id}.receipt.json`), '{interrupted');
    const selected = selectRun(plan, undefined, { resume: true });
    assert.deepEqual(selected.rounds.map(r => r.id), [first.id]);
    archiveAborted(selected);
    save(first);
    assert.throws(() => selectRun(plan, undefined, { resume: true }), /already complete/);
    const completion = selectRun(plan, ['release-opus'], { resume: true });
    assert.deepEqual(completion.rounds.map(r => r.id), ['release-opus-A-r1', 'release-opus-B-r1']);
    assert.throws(() => selectRun(plan, ['native'], { resume: true }), /not deferred/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resume archive refuses symlink banks and never moves finished evidence', async () => {
  const { selectRun, archiveAborted } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp5-archive-'));
  try {
    const { plan } = await resumeFixture(dir);
    writeFileSync(join(dir, `${plan.rounds[0].id}.log`), 'partial');
    mkdirSync(join(dir, 'outside'));
    symlinkSync(join(dir, 'outside'), join(dir, 'aborted'));
    assert.throws(() => archiveAborted(selectRun(plan, undefined, { resume: true })), /symlink|ordinary/);
    assert.equal(readFileSync(join(dir, `${plan.rounds[0].id}.log`), 'utf8'), 'partial');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resume CLI rejects ambiguous or incomplete requests without starting validation', () => {
  for (const flags of [['--resume'], ['--plan', '--resume'], ['--score', '--resume'], ['--resume', '--out', '/fixture/missing']]) {
    const got = spawnSync(process.execPath, [moduleURL.pathname, ...flags], { encoding: 'utf8' });
    assert.notEqual(got.status, 0);
    assert.match(got.stderr, /--resume requires|--run requires/);
  }
});

test('round app requirements come from fixture metadata, including CC browser tasks and Finder windows', async () => {
  const { roundApps } = await import(moduleURL);
  assert.equal(typeof roundApps, 'function', 'fixture app admission is missing');
  assert.deepEqual(roundApps({ runner: 'native', tasks: ['textedit-edit', 'word-memo', 'excel-edit', 'finder-rename', 'vscode-edit'] }),
    ['TextEdit', 'Microsoft Word', 'Microsoft Excel', 'Finder', 'Visual Studio Code']);
  assert.deepEqual(roundApps({ runner: 'native', tasks: ['cc-list-firefox', 'cc-list-safari', 'cc-list-native'] }), ['Firefox', 'Safari', 'Finder']);
  assert.deepEqual(roundApps({ runner: 'browser', browser: 'chrome', tasks: ['demoid'] }), ['Google Chrome']);
  assert.throws(() => roundApps({ runner: 'native', tasks: ['unknown-task'] }), /Unknown task/);
});

test('app wait polls all round apps every 60 seconds, records each once, and waits for windowless TextEdit', async () => {
  const { waitForRoundApps } = await import(moduleURL);
  assert.equal(typeof waitForRoundApps, 'function', 'app wait is missing');
  const records = [], waits = [], probes = [];
  const states = [['TextEdit'], ['TextEdit', 'Finder'], []];
  let pass = 0;
  await waitForRoundApps({ id: 'native-A-r1', runner: 'native', tasks: ['textedit-edit', 'finder-rename'] }, (id, data) => records.push([id, data]), {
    running: app => { probes.push(app); return states[pass].includes(app); },
    sleep: async ms => { waits.push(ms); pass++; },
  });
  assert.deepEqual(waits, [60000, 60000]);
  assert.deepEqual(probes, ['TextEdit', 'Finder', 'TextEdit', 'Finder', 'TextEdit', 'Finder']);
  assert.deepEqual(records.map(([id]) => id), ['waiting-for-app-quit TextEdit', 'waiting-for-app-quit Finder']);
});

test('process admission fails closed on inspection errors, and Finder checks windows rather than its permanent process', async () => {
  const { appRunning } = await import(moduleURL);
  assert.equal(typeof appRunning, 'function', 'app state inspection is missing');
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return { status: 0, stdout: '0' }; };
  assert.equal(appRunning('TextEdit', run), true);
  assert.equal(appRunning('TextEdit', () => ({ status: 1 })), false);
  assert.throws(() => appRunning('TextEdit', () => ({ status: 2 })), /inspect/);
  assert.throws(() => appRunning('TextEdit', () => ({ status: null, error: Error('timeout') })), /inspect/);
  assert.equal(appRunning('Finder', run), false);
  assert.equal(appRunning('Finder', () => ({ status: 0, stdout: '2' })), true);
  assert.throws(() => appRunning('Finder', () => ({ status: 0, stdout: 'unknown' })), /inspect/);
  assert.deepEqual(calls[0], ['/usr/bin/pgrep', ['-x', 'TextEdit']]);
  assert.equal(calls[1][0], '/usr/bin/osascript');
  assert.ok(calls[1][1].at(-1).endsWith('/bench/validation/app-count.js'));
  // VS Code's main executable is not guaranteed to be named Code, so use its bundle, including benchmark instances.
  const codeCalls = [];
  assert.equal(appRunning('Visual Studio Code', (cmd, args) => { codeCalls.push([cmd, args]); return { status: 0, stdout: '1' }; }), true);
  assert.equal(codeCalls[0][0], '/usr/bin/osascript');
});

test('Finder inspector counts minimized windows without Apple events and fails closed without existing AX permission', () => {
  const source = readFileSync(new URL('../bench/validation/app-count.js', import.meta.url), 'utf8');
  const native = value => value;
  let trusted = true, axCode = 0;
  Object.assign(native, {
    AXIsProcessTrusted: () => trusted,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: bundle => {
      assert.equal(bundle, 'com.apple.finder');
      return { count: 1, objectAtIndex: () => ({ processIdentifier: 42 }) };
    } },
    AXUIElementCreateApplication: pid => { assert.equal(pid, 42); return 'finder'; },
    AXUIElementSetMessagingTimeout: () => {},
    AXUIElementCopyAttributeValue: (element, attribute, ref) => {
      if (attribute === 'AXRole') { ref[0] = element.role; return 0; }
      assert.equal(element, 'finder'); assert.equal(attribute, 'AXWindows');
      // The desktop is listed beside real windows as an AXScrollArea and must not count.
      const items = [{ role: 'AXWindow' }, { role: 'AXScrollArea' }, { role: 'AXWindow' }];
      ref[0] = { count: items.length, objectAtIndex: i => items[i] }; return axCode;
    },
  });
  const context = vm.createContext({ $: native, ObjC: { import() {}, castRefToObject: value => value, unwrap: value => value }, Ref: () => [] });
  vm.runInContext(source, context);
  assert.equal(context.run(), '2');
  axCode = -25204;
  assert.throws(() => context.run(), /inspection failed/);
  trusted = false;
  assert.throws(() => context.run(), /existing Accessibility/);
  native.NSRunningApplication.runningApplicationsWithBundleIdentifier = bundle => {
    assert.equal(bundle, 'com.microsoft.VSCode'); return { count: 1 };
  };
  assert.equal(context.run(['vscode']), '1');
});

test('engine admission rejects a changed or missing installed engine before a resumed round', async () => {
  const { verifyEngine } = await import(moduleURL);
  assert.equal(typeof verifyEngine, 'function');
  assert.doesNotThrow(() => verifyEngine({ engine: 'e' }, () => ({ version: 'e' })));
  assert.throws(() => verifyEngine({ engine: 'e' }, () => ({ version: 'different' })), /engine changed/);
  assert.throws(() => verifyEngine({ engine: 'e' }, () => ({ version: null })), /engine changed/);
});

test('operator interruption stops admission, cancels app polling, and releases signal handlers after cleanup', async () => {
  const { stopGuard, waitForRoundApps } = await import(moduleURL);
  assert.equal(typeof stopGuard, 'function', 'interrupted drivers must unwind their writer lock');
  const events = new EventEmitter(), guard = stopGuard(events);
  assert.doesNotThrow(guard.check);
  let polls = 0;
  await assert.rejects(waitForRoundApps({ id: 'native-A-r1', runner: 'native', tasks: ['textedit-edit'] }, () => {}, {
    running: () => { polls++; return true; }, signal: guard.signal,
    sleep: async () => { events.emit('SIGINT'); },
  }), /stopped/);
  assert.equal(polls, 1);
  assert.throws(guard.check, /stopped/);
  guard.close();
  assert.equal(events.listenerCount('SIGINT'), 0);
  assert.equal(events.listenerCount('SIGTERM'), 0);
});
