import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GATE_TASKS, armPlan, armCommand, scoreRuntimeArms, runtimeName, runtimeBuild, assertOwnRelay,
  outputStem, writeRuntimeReport, armMarkdown, parseArmOptions, runRuntimeArms } from '../bench/runtime-arm.mjs';

import { receipt, step1Report, build, OWN_BUILD, SOURCE, ENGINE, DRIVER, processEvidence, engineReceipt } from './runtime-gate-fixtures.mjs';

const rows = () => armPlan().map((row, i) => ({ ...row, runNonce: 'synthetic-run-nonce-' + i, runtimeBuild: build(null, row.runtime),
  processEvidence: processEvidence(row.runtime), ...(row.runtime === 'own' ? { runtimeReceipt: receipt('synthetic-run-nonce-' + i) } : { engineReceipt: engineReceipt() }), engineBuild: ENGINE.build, engineChanged: false, passed: true, seconds: 10, turns: 3, engineVersion: '1.2.3',
  sleightCommit: 'same-sha', sleightDirty: false, model: 'claude-haiku-5-5', effort: 'high', claudeVersion: 'fake-1', models: ['claude-haiku-5-5'], finishedAt: '2026-10-30T13:00:00Z' }));
const fakeObserve = async operation => { const value = await operation(); return { value, processEvidence: value.processEvidence ?? processEvidence('engine') }; };
const fakeObserver = { observe: fakeObserve, inventory: async () => ({ helpers: [], drivers: [] }),
  prepare: async () => ({ status: 'ready', compileMs: 12, elapsedMs: 15 }) };
const temp = () => mkdtempSync(join(realpathSync(tmpdir()), 'rt13-arm-unit-'));
test('five tasks, five attempts per side, ABBA for every task', () => {
  const plan = armPlan(); assert.equal(plan.length, 50);
  for (const task of GATE_TASKS) {
    const order = plan.filter(row => row.task === task);
    assert.deepEqual(order.slice(0, 4).map(row => row.arm), ['sleight', 'sleight-own', 'sleight-own', 'sleight']);
    assert.equal(order.filter(row => row.runtime === 'own').length, 5);
  }
  for (const opts of [{ runs: 3 }, { tasks: GATE_TASKS.slice(1) }, { arms: ['sleight-own'] }, { tasks: Array(5).fill(GATE_TASKS[0]) }]) assert.throws(() => armPlan(opts));
});
test('arms invoke same claim runner, tasks, model and effort with isolated runtime env', () => {
  const [a, b] = armPlan();
  const ca = armCommand(a, { env: { CLAUDE_CONFIG_DIR: '/tmp/private', SLEIGHT_RUNTIME: 'own' } });
  const cb = armCommand(b, { env: { CLAUDE_CONFIG_DIR: '/tmp/private' } });
  assert.deepEqual(ca.args, cb.args); assert.equal(ca.env.SLEIGHT_RUNTIME, 'engine'); assert.equal(cb.env.SLEIGHT_RUNTIME, 'own');
  assert.ok(ca.args.includes('claude-haiku-5-5')); assert.ok(ca.args.includes('high')); assert.ok(ca.args.includes('--clean-arms'));
  assert.equal(ca.env.CLAUDE_CONFIG_DIR, '/tmp/private');
  assert.ok(ca.args.includes('world'), 'world contains preview-read and textedit-calculator');
});
test('defaults remain engine and invalid runtime is refused', () => {
  assert.equal(runtimeName({}), 'engine'); assert.equal(runtimeName({ SLEIGHT_RUNTIME: 'own' }), 'own');
  assert.throws(() => runtimeName({ SLEIGHT_RUNTIME: 'oops' }), /INVALID_RUNTIME/);
});
test('absent own driver and absent RT8 relay switch fail clearly without a fallback', () => {
  const root = temp();
  try {
    assert.throws(() => runtimeBuild(root, 'own'), /RUNTIME_ABSENT/);
    assert.throws(() => assertOwnRelay(root), /RUNTIME_ABSENT/);
    assert.deepEqual(runtimeBuild(root, 'engine', '1.2.3'), { kind: 'engine', version: '1.2.3' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('source build changes with source content; binary identity requires a runtime receipt', () => {
  const root = temp(), base = join(root, 'plugins/sleight/lib/mac-driver'); mkdirSync(base, { recursive: true });
  try {
    writeFileSync(join(base, 'client.mjs'), 'first'); const a = runtimeBuild(root, 'own');
    writeFileSync(join(base, 'client.mjs'), 'second'); const b = runtimeBuild(root, 'own');
    assert.notEqual(a.sourceSha256, b.sourceSha256); assert.equal(a.sourceSha256.length, 64);
    assert.equal(a.binary, undefined, 'source identity does not pretend to hash the serving binary');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('gate scores lower passing median, expected time over all attempts and turns', () => {
  const data = rows(), samples = data.filter(r => r.task === 'calculator-click' && r.arm === 'sleight');
  samples[0].seconds = 1; samples[1].seconds = 3; samples[2].seconds = 5; samples[3].seconds = 7; samples[4].seconds = 9;
  samples[4].passed = false;
  const score = scoreRuntimeArms(data);
  assert.equal(score.byArm.sleight['calculator-click'].medianSeconds, 3);
  assert.equal(score.byArm.sleight['calculator-click'].expectedSeconds, 25 / 4);
  assert.equal(score.byArm.sleight['calculator-click'].medianTurns, 3);
});
test('flat total passes; 20% per-task limit inclusive; two lost passes fail', () => {
  assert.equal(scoreRuntimeArms(rows()).passed, true);
  let data = rows();
  for (const row of data.filter(r => r.arm === 'sleight-own')) row.seconds = row.task === 'calculator-click' ? 12 : 9.5;
  assert.equal(scoreRuntimeArms(data).passed, true);
  data.find(r => r.arm === 'sleight-own' && r.task === 'calculator-click').seconds = 12.1;
  assert.equal(scoreRuntimeArms(data).passed, false);
  data = rows(); data.filter(r => r.arm === 'sleight-own' && r.task === 'calculator-click').slice(0, 2).forEach(r => { r.passed = false; });
  assert.match(scoreRuntimeArms(data).reasons.join(','), /loses at least 2 passes/);
});
test('incomplete, duplicate, zero-pass, drifted and dirty evidence cannot pass', () => {
  for (const change of [d => d.pop(), d => { d[0].run = d[2].run; d[2].task = d[0].task; d[2].arm = d[0].arm; },
    d => { d[0].engineVersion = '9'; }, d => { d[0].engineBuild = 'different'; },
    d => { d[0].sleightCommit = 'other'; }, d => { d[0].sleightDirty = true; },
    d => { d.filter(r => r.arm === 'sleight-own').forEach(r => { r.passed = false; }); }]) {
    const data = rows(); change(data); assert.equal(scoreRuntimeArms(data).passed, false);
    assert.equal(scoreRuntimeArms(data, { fixRound: 1 }).verdict, 'step2: stop-program');
  }
});
test('output refuses existing and symlinked stems; reports name runtime builds', () => {
  const dir = temp();
  try {
    const stem = outputStem(join(dir, 'fresh'));
    writeRuntimeReport(stem, { hello: true }, '# Report\n');
    assert.throws(() => outputStem(stem), /OUTPUT_EXISTS/);
    symlinkSync(dir, join(dir, 'alias')); assert.throws(() => outputStem(join(dir, 'alias/report')), /OUTPUT_SYMLINK/);
    const score = scoreRuntimeArms(rows());
    const md = armMarkdown({ score, results: rows(), builds: { sleight: { version: '1.2.3' }, 'sleight-own': { sourceSha256: 'hash' } } });
    assert.match(md, /sleight-own/); assert.match(md, /hash/); assert.match(md, /50\/50/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('dry run prints both arms without readiness, files, children or live lock', async () => {
  const logs = [];
  assert.equal(await runRuntimeArms({ dryRun: true }, { log: line => logs.push(line),
    ownReady: () => assert.fail(), execute: () => assert.fail(), publish: () => assert.fail() }), 0);
  const output = JSON.parse(logs[0]); assert.equal(output.plan.length, 50);
  assert.deepEqual(output.arms, { sleight: 'engine', 'sleight-own': 'own' });
});
test('owner and hold gates precede runtime readiness', async () => {
  await assert.rejects(runRuntimeArms({}, { ownReady: () => assert.fail() }), /OWNER_AWAY_REQUIRED/);
  await assert.rejects(runRuntimeArms({ ownerAway: true }, { held: () => true, ownReady: () => assert.fail() }), /HOLD/);
});
test('fake claim children compile once before attempts and preserve driver load pairs', async () => {
  const root = temp(); mkdirSync(join(root, 'bench/results'), { recursive: true });
  const publications = [], calls = [], configs = [];
  let preparations = 0;
  try {
    writeFileSync(join(root, 'step1.json'), JSON.stringify(step1Report()));
    const code = await runRuntimeArms({ ownerAway: true, out: join(root, 'summary'), step1: join(root, 'step1.json') }, { ...fakeObserver, root, held: () => false, liveLockHeld: () => false,
      source: () => SOURCE, engine: () => ({ version: ENGINE.version, chatgptBuild: ENGINE.build, at: '2026-10-30T13:00:00Z' }), ownReady: () => {}, load: () => [1, 2, 3],
      build, publish: (stem, report) => publications.push(structuredClone(report)),
      prepare: async ({ signal }) => { assert.equal(signal.aborted, false); preparations++; return { status: 'ready', compileMs: 12, elapsedMs: 15 }; },
      execute: async command => {
        assert.equal(preparations, 1);
        calls.push(command); configs.push(command.env.CLAUDE_CONFIG_DIR);
        const path = join(root, 'bench/results', String(calls.length) + '.json');
        const task = command.args[command.args.indexOf('--tasks') + 1];
        const row = { ...rows()[0], arm: 'sleight', task, run: 1,
          loadStart: [11, 2, 3], loadEnd: [5, 2, 3], loadCores: 10, loadExceededCores: true };
        writeFileSync(path, JSON.stringify({ ...(command.env.SLEIGHT_RUNTIME === 'own' ? { runtimeReceipt: receipt(command.env.SLEIGHT_RUNTIME_RUN_NONCE) } : { engineReceipt: engineReceipt() }), engine: { changed: false, start: { version: ENGINE.version, chatgptBuild: ENGINE.build }, end: { version: ENGINE.version, chatgptBuild: ENGINE.build } }, model: row.model, effort: row.effort, armMetadata: { sleight: { claudeVersion: row.claudeVersion } }, results: [row] }));
        return { stdout: 'results: ' + path, groupClean: true, exit: { code: 0 }, processEvidence: processEvidence(command.env.SLEIGHT_RUNTIME) };
      } });
    assert.equal(code, 1, 'parity is still unproven'); assert.equal(calls.length, 50);
    const report = publications.at(-1); assert.equal(report.results.length, 50);
    assert.equal(report.results[1].runtime, 'own'); assert.deepEqual(report.results[1].runtimeBuild, OWN_BUILD);
    assert.equal(report.score.verdict, 'step2: speed-pass'); assert.equal(report.gate.verdict, 'incomplete');
    assert.deepEqual(report.score.driverIdentity, DRIVER);
    assert.equal(report.results[1].idleWait.outcome, 'idle');
    const rawOwn = JSON.parse(readFileSync(join(root, 'bench/results/2.json'), 'utf8'));
    assert.equal(rawOwn.results[0].arm, 'sleight-own'); assert.equal(rawOwn.runtime, 'own');
    assert.deepEqual(rawOwn.results[0].runtimeBuild, OWN_BUILD);
    assert.deepEqual(report.results[0].loadEnd, [5, 2, 3]);
    assert.deepEqual(report.results[0].harnessLoadEnd, [1, 2, 3]);
    assert.deepEqual(report.glidePreparation, { status: 'ready', compileMs: 12, elapsedMs: 15 });
    assert.equal(preparations, 1);
    assert.match(armMarkdown(report), /LOAD: sleight\/calculator-click #1/);
    assert.equal(new Set(configs).size, 50); configs.forEach(path => assert.ok(existsSync(path)));
  } finally { configs.forEach(path => rmSync(path, { recursive: true, force: true })); rmSync(root, { recursive: true, force: true }); }
});
test('step-2 scoring requires the qualified step-1 driver version and binary digest', () => {
  assert.equal(scoreRuntimeArms(rows(), { driverIdentity: DRIVER }).passed, true);
  for (const driverIdentity of [{ ...DRIVER, version: '2' }, { ...DRIVER, build: '9'.repeat(64) }]) {
    const score = scoreRuntimeArms(rows(), { driverIdentity });
    assert.equal(score.passed, false); assert.ok(score.reasons.includes('step-1 driver build/version differs'));
  }
});
test('step-2 retains an interrupted idle wait without starting the own child', async () => {
  const root = temp(); mkdirSync(join(root, 'bench/results'), { recursive: true });
  const configs = [], reports = [];
  let held = false;
  try {
    writeFileSync(join(root, 'step1.json'), JSON.stringify(step1Report()));
    const code = await runRuntimeArms({ ownerAway: true, out: join(root, 'summary'), step1: join(root, 'step1.json') }, {
      ...fakeObserver, root, held: () => held, liveLockHeld: () => false, ownReady: () => {}, build, source: () => SOURCE,
      engine: () => ({ version: ENGINE.version, chatgptBuild: ENGINE.build }), publish: (_, report) => reports.push(structuredClone(report)),
      inventory: async () => { held = true; return { helpers: processEvidence('engine').samples[1].helpers, drivers: [] }; },
      execute: async command => {
        configs.push(command.env.CLAUDE_CONFIG_DIR);
        const path = join(root, 'bench/results/engine.json');
        writeFileSync(path, JSON.stringify({ results: [rows()[0]], model: 'claude-haiku-5-5', effort: 'high',
          armMetadata: { sleight: { claudeVersion: 'fake-1' } }, engine: { changed: false,
            start: { version: ENGINE.version, chatgptBuild: ENGINE.build }, end: { version: ENGINE.version, chatgptBuild: ENGINE.build } } }));
        return { stdout: 'results: ' + path, groupClean: true, exit: { code: 0 }, processEvidence: processEvidence('engine') };
      },
    });
    assert.equal(code, 1); assert.equal(configs.length, 1);
    const report = reports.at(-1); assert.equal(report.stop, 'HOLD'); assert.equal(report.results.length, 1);
    assert.equal(report.failedAttempt.runtime, 'own'); assert.equal(report.failedAttempt.idleWait.outcome, 'stopped');
    assert.equal(report.failedAttempt.idleWait.samples.length, 1); assert.equal(report.score.complete, false);
  } finally { configs.forEach(path => rmSync(path, { recursive: true, force: true })); rmSync(root, { recursive: true, force: true }); }
});
test('runner seam is a static source check only; tests never import bench/run.mjs', () => {
  const source = readFileSync(new URL('../bench/run.mjs', import.meta.url), 'utf8');
  assert.match(source, /await routeRuntimeArms\(process.argv.slice\(2\)\)/);
  assert.ok(source.indexOf('await routeRuntimeArms') < source.indexOf('const isDryRun'));
});
test('arm options reject unknown and missing values', () => {
  assert.deepEqual(parseArmOptions(['--arm', 'sleight,sleight-own', '--dry-run']).arms, ['sleight', 'sleight-own']);
  for (const args of [['--out'], ['--fix-round', '2'], ['--no-such-option']]) assert.throws(() => parseArmOptions(args));
});

test('speed map forwards runtime selection, refuses unknown names and names builds in Markdown', async () => {
  const { speedEnvironment } = await import('../bench/app-speed-map-live.mjs');
  const { speedMarkdown } = await import('../bench/app-speed-map.mjs');
  assert.equal(speedEnvironment({}).SLEIGHT_RUNTIME, 'engine');
  assert.equal(speedEnvironment({ SLEIGHT_RUNTIME: 'own' }).SLEIGHT_RUNTIME, 'own');
  assert.throws(() => speedEnvironment({ SLEIGHT_RUNTIME: 'bad' }), /INVALID_RUNTIME/);
  assert.match(speedMarkdown({ rows: [], runtime: 'own', runtimeBuild: { sourceSha256: 'abc123' } }), /Runtime: own. Build: abc123/);
});

test('a retained child live lock stops the A/B before another child', async () => {
  const root = temp(); mkdirSync(join(root, 'bench/results'), { recursive: true });
  const configs = [], publications = [];
  try {
    writeFileSync(join(root, 'step1.json'), JSON.stringify(step1Report()));
    const code = await runRuntimeArms({ ownerAway: true, out: join(root, 'summary'), step1: join(root, 'step1.json') }, { ...fakeObserver, root, held: () => false,
      liveLockHeld: () => true, ownReady: () => {}, source: () => SOURCE, engine: () => ({ version: ENGINE.version, chatgptBuild: ENGINE.build, at: '2026-10-30T13:00:00Z' }),
      build, publish: (_, report) => publications.push(structuredClone(report)),
      execute: async command => {
        configs.push(command.env.CLAUDE_CONFIG_DIR);
        const path = join(root, 'bench/results/one.json'); writeFileSync(path, JSON.stringify({ engine: { changed: false, start: { version: ENGINE.version, chatgptBuild: ENGINE.build }, end: { version: ENGINE.version, chatgptBuild: ENGINE.build } }, model: 'claude-haiku-5-5', effort: 'high', armMetadata: { sleight: { claudeVersion: 'fake-1' } }, results: [rows()[0]] }));
        return { stdout: 'results: ' + path, groupClean: true, exit: { code: 0 }, processEvidence: processEvidence(command.env.SLEIGHT_RUNTIME) };
      } });
    assert.equal(code, 1); assert.equal(configs.length, 1); assert.equal(publications.at(-1).stop, 'CLAIM_SAFETY_STOP');
  } finally { configs.forEach(path => rmSync(path, { recursive: true, force: true })); rmSync(root, { recursive: true, force: true }); }
});

test('crossing UTC midnight is valid; engine or own driver build drift is invalid', () => {
  const data = rows();
  data.slice(20).forEach(row => { row.finishedAt = '2026-10-31T00:01:00Z'; });
  assert.equal(scoreRuntimeArms(data).verdict, 'step2: speed-pass');
  for (const change of [d => { d[0].engineBuild = 'other'; }, d => { d[0].engineChanged = true; },
    d => { d[1].runtimeBuild = { ...OWN_BUILD, sourceSha256: '3'.repeat(64) }; },
    d => { d[1].runtimeReceipt.driverBuild = '3'.repeat(64); d[1].runtimeReceipt.ping.build = '3'.repeat(64); },
    d => { d[1].runNonce = d[3].runNonce; }]) {
    const altered = rows(); change(altered); assert.equal(scoreRuntimeArms(altered).passed, false);
  }
});
test('a missing own receipt contributes zero scored runs and zero passing time', () => {
  const data = rows(); delete data[1].runtimeReceipt;
  const score = scoreRuntimeArms(data);
  assert.equal(score.passed, false); assert.equal(score.byArm['sleight-own']['calculator-click'].scoredRuns, 4);
  assert.equal(score.byArm['sleight-own']['calculator-click'].passes, 4);
  assert.equal(score.byArm['sleight-own']['calculator-click'].expectedSeconds, null);
  data.filter(row => row.arm === 'sleight-own').forEach(row => { delete row.runtimeReceipt; });
  assert.equal(scoreRuntimeArms(data).totals['sleight-own'], null);
});
test('engine labels cannot score an own-driver child or a missing, stale or different engine helper', () => {
  for (const change of [r => { delete r.engineReceipt; }, r => { r.engineReceipt.engineVersion = 'other'; },
    r => { r.engineReceipt.helperPath = '/other/SkyComputerUseService'; },
    r => { r.runtimeReceipt = receipt(r.runNonce); }, r => { r.processEvidence = processEvidence('own'); }]) {
    const data = rows(); change(data[0]);
    const score = scoreRuntimeArms(data);
    assert.equal(score.passed, false); assert.equal(score.byArm.sleight['calculator-click'].scoredRuns, 4);
  }
});

test('an engine child carrying an own receipt stops before the own arm and keeps its evidence', async () => {
  const root = temp(); mkdirSync(join(root, 'bench/results'), { recursive: true });
  const configs = [], reports = [];
  try {
    writeFileSync(join(root, 'step1.json'), JSON.stringify(step1Report()));
    const code = await runRuntimeArms({ ownerAway: true, out: join(root, 'summary'), step1: join(root, 'step1.json') }, {
      ...fakeObserver, root, held: () => false, liveLockHeld: () => false, ownReady: () => {}, build, source: () => SOURCE,
      engine: () => ({ version: ENGINE.version, chatgptBuild: ENGINE.build }), publish: (_, report) => reports.push(structuredClone(report)),
      execute: async command => {
        configs.push(command.env.CLAUDE_CONFIG_DIR);
        const path = join(root, 'bench/results/own-in-engine.json');
        writeFileSync(path, JSON.stringify({ runtimeReceipt: receipt(command.env.SLEIGHT_RUNTIME_RUN_NONCE),
          results: [rows()[0]], model: 'claude-haiku-5-5', effort: 'high', armMetadata: { sleight: { claudeVersion: 'fake-1' } },
          engine: { changed: false, start: { version: ENGINE.version, chatgptBuild: ENGINE.build },
            end: { version: ENGINE.version, chatgptBuild: ENGINE.build } } }));
        return { stdout: 'results: ' + path, groupClean: true, exit: { code: 0 }, processEvidence: processEvidence('own') };
      } });
    assert.equal(code, 1); assert.equal(configs.length, 1);
    const report = reports.at(-1); assert.equal(report.stop, 'ENGINE_RECEIPT_INVALID');
    assert.equal(report.results[0].runtime, 'unproven'); assert.equal(report.results[0].valid, false);
    assert.equal(report.score.byArm.sleight['calculator-click'].scoredRuns, 0);
    assert.equal(report.results[0].processEvidence.samples.length, 3);
  } finally { configs.forEach(path => rmSync(path, { recursive: true, force: true })); rmSync(root, { recursive: true, force: true }); }
});
test('step-1 omission or stale engine/build proof refuses before a model child runs', async () => {
  const root = temp();
  const deps = { ...fakeObserver, root, held: () => false, ownReady: () => {}, build, source: () => SOURCE,
    engine: () => ({ version: ENGINE.version, chatgptBuild: ENGINE.build }), execute: () => assert.fail('child must not start') };
  try {
    const options = { ownerAway: true, out: join(root, 'summary') };
    await assert.rejects(runRuntimeArms(options, deps), /STEP1_REQUIRED/);
    const stale = step1Report(); stale.build.engineBuild = 'old';
    writeFileSync(join(root, 'step1.json'), JSON.stringify(stale));
    await assert.rejects(runRuntimeArms({ ...options, step1: join(root, 'step1.json') }, deps), /STEP1_REQUIRED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('own-arm child without a runtime receipt is invalid and stops the run set', async () => {
  const root = temp(); mkdirSync(join(root, 'bench/results'), { recursive: true });
  const configs = [], reports = [];
  try {
    writeFileSync(join(root, 'step1.json'), JSON.stringify(step1Report()));
    const code = await runRuntimeArms({ ownerAway: true, out: join(root, 'summary'), step1: join(root, 'step1.json') }, {
      ...fakeObserver, root, held: () => false, liveLockHeld: () => false, ownReady: () => {}, build, source: () => SOURCE,
      engine: () => ({ version: ENGINE.version, chatgptBuild: ENGINE.build }), publish: (_, r) => reports.push(structuredClone(r)),
      execute: async command => {
        configs.push(command.env.CLAUDE_CONFIG_DIR);
        const path = join(root, 'bench/results', configs.length + '.json');
        const row = rows()[0];
        writeFileSync(path, JSON.stringify({ model: row.model, effort: row.effort,
          armMetadata: { sleight: { claudeVersion: row.claudeVersion } }, results: [row],
          engine: { changed: false, start: { version: ENGINE.version, chatgptBuild: ENGINE.build },
            end: { version: ENGINE.version, chatgptBuild: ENGINE.build } } }));
        return { stdout: 'results: ' + path, groupClean: true, exit: { code: 0 }, processEvidence: processEvidence(command.env.SLEIGHT_RUNTIME) };
      } });
    assert.equal(code, 1); assert.equal(configs.length, 2);
    const report = reports.at(-1);
    assert.equal(report.stop, 'RUNTIME_RECEIPT_INVALID'); assert.equal(report.results[1].valid, false);
    assert.equal(report.score.byArm['sleight-own']['calculator-click'].scoredRuns, 0);
    assert.equal(report.score.byArm['sleight-own']['calculator-click'].medianSeconds, null);
  } finally { configs.forEach(path => rmSync(path, { recursive: true, force: true })); rmSync(root, { recursive: true, force: true }); }
});
