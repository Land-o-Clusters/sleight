import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { probePlan, sittingPlan, latencySummary, validateTrial, probeVerdict, assertProbeSafety, runProbePlan, probeMarkdown, parseProbeOptions, probeExitCode } from '../bench/runtime-probe.mjs';
import { receipt, metadata, OWN_BUILD, processEvidence, engineReceipt } from './runtime-gate-fixtures.mjs';
import { assertStep1, engineIdentity } from '../bench/runtime-gate.mjs';
import { driverProbeAdapter, engineProbeAdapter, observeSittingAttempt, createLiveProbe, assertProbeFixtureLease } from '../bench/runtime-probe-live.mjs';

const plan = probePlan();
const evidence = cell => {
  const hid = Object.fromEntries(['click', 'key', 'type'].map(k => [k, { beforeMs: 1000, afterMs: 1100, elapsedMs: 100 }]));
  return { observed: true, background: true, posted: true, covered: true, windowClosed: true, fileMatches: true,
    saveSheetBefore: true, goToFolderAfter: true, caretConfirmed: true, textMatches: true,
    singleReply: true, treePresent: true, imagePresent: true, imageMatchesWindow: true, hid,
    sheetBefore: true, sheetGoneInNextRead: true, menuAbsentBefore: true, menuInNextRead: true,
    elapsedMs: 10, correct: true };
};
function fakeBackend({ fail, cleanup = true, running = [], prepareError, trialError, runtime = 'own' } = {}) {
  const calls = [];
  return { calls, metadata: async (side = runtime) => metadata(side),
    inventory: async () => { calls.push('inventory'); return running; },
    prepare: async cell => { calls.push('prepare:' + cell.id); if (prepareError) throw Error(prepareError); return { id: cell.id }; },
    trial: async (cell, fixture, index, run) => { calls.push('trial:' + index); if (trialError) throw Error(trialError);
      return { ...(fail?.(cell, index, run) ?? evidence(cell)), processEvidence: processEvidence(run.runtime), ...(run.runtime === 'own' ? { runtimeReceipt: receipt(run.runNonce) } : { engineReceipt: engineReceipt() }) }; },
    closeFixture: async () => { calls.push('closeFixture'); return { confirmed: cleanup }; },
    close: async () => { calls.push('close'); return { confirmed: cleanup }; } };
}
async function sitting(options = {}, deps = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt13-unit-'));
  const published = [], events = [];
  const backend = deps.backend ?? fakeBackend();
  try {
    const report = await runProbePlan({ ownerAway: true, env: { SLEIGHT_RUNTIME: 'own' }, out: join(dir, 'gate'), ...options }, { backend,
      platform: 'darwin', held: () => false, load: () => [1, 2, 3], log: () => {},
      takeLock: async () => { events.push('lock'); return async () => { events.push('unlock'); }; },
      publish: (stem, report, md) => published.push({ stem, report, md }), ...deps });
    return { report, published, events, backend };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('canonical RT1 plan has seven groups, 29 own cells, 470 own trials and no historical limits', () => {
  assert.deepEqual([...new Set(plan.map(p => p.group))], [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(plan.length, 29); assert.equal(plan.reduce((s, p) => s + p.trials, 0), 470);
  for (const p of plan) assert.equal(p.trials, p.group <= 3 ? 10 : 20);
  assert.equal(plan.filter(p => p.group === 6).length, 10);
  assert.ok(plan.every(p => !Object.hasOwn(p, 'p50LimitMs')));
  assert.equal(plan.filter(p => p.group === 4).length, 5);
  for (const p of plan) assert.equal(p.requiredPasses, p.trials);
});

test('sitting CLI dry run prints exactly six read cells and engine/wait/own blocks without a backend', () => {
  const result = spawnSync(process.execPath, ['bench/runtime-probe-live.mjs', '--sitting', '--dry-run'], { killSignal: 'SIGKILL', timeout: 10000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runtime, 'own');
  assert.equal(report.sitting, true); assert.equal(report.totalTrials, 120); assert.equal(report.engineLatencyTrials, 120);
  assert.equal(report.plan.length, 6);
  assert.deepEqual([...new Set(report.plan.map(cell => cell.app))], ['calculator', 'textedit']);
  assert.deepEqual([...new Set(report.plan.map(cell => cell.metric))], ['idleRead', 'combinedRead', 'acquisition']);
  assert.deepEqual(report.blockOrder, ['engine:20', 'helper-idle-wait:1', 'own:20']);
  for (const row of report.schedules) {
    assert.deepEqual(row.attempts.map(attempt => attempt.runtime ?? attempt.wait),
      [...Array(20).fill('engine'), 'engine-idle', ...Array(20).fill('own')]);
    assert.deepEqual(row.attempts.slice(21).map(attempt => attempt.index), Array.from({ length: 20 }, (_, i) => i));
  }
  assert.equal(parseProbeOptions(['--sitting']).sitting, true);
});

for (const entry of ['runtime-probe.mjs', 'runtime-probe-live.mjs']) {
  for (const args of [['--owner-away'], ['--sitting', '--owner-away'], ['--sitting']]) {
    const ownerSitting = entry === 'runtime-probe-live.mjs' && args.includes('--sitting') && args.includes('--owner-away');
    test(`${entry} non-dry ${args.join(' ')} ${ownerSitting ? 'requires prebuilt tools' : 'reaches a fake driver'} and exits 1, never 13`, () => {
      const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt30-cli-unit-'));
      try {
        const result = spawnSync(process.execPath, ['--import', './tests/fixtures/runtime-probe-cli-guard.mjs',
          'bench/' + entry, ...args, '--out', join(dir, 'probe')], {
          killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000, env: { ...process.env, SLEIGHT_RUNTIME: 'own', RT30_CLI_SCENARIO: '' },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, ownerSitting ? /TOOLS_AND_OUTPUT_REQUIRED/ : /FAKE_DRIVER_REFUSED/);
        assert.doesNotMatch(result.stderr, /unsettled top-level await/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
  for (const scenario of ['win', 'loss', 'incomplete', 'fault', 'cleanup', 'stopped']) {
    test(`${entry} non-dry sitting CLI publishes ${scenario} with the expected exit code`, () => {
      const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt30-cli-result-unit-')), stem = join(dir, 'probe');
      try {
        const completed = ['win', 'loss'].includes(scenario);
        const result = spawnSync(process.execPath, ['--import', './tests/fixtures/runtime-probe-cli-guard.mjs',
          'bench/' + entry, '--sitting', '--out', stem], {
          killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000, env: { ...process.env, RT30_CLI_SCENARIO: scenario },
        });
        assert.equal(result.error, undefined); assert.equal(result.signal, null);
        assert.equal(result.status, completed ? 0 : 1, result.stderr);
        const saved = JSON.parse(readFileSync(stem + '.json', 'utf8'));
        assert.equal(saved.sitting, true); assert.equal(saved.sittingSummary.completed, completed);
        assert.equal(saved.sittingSummary.passed, scenario === 'win');
        assert.equal(saved.verdict.passed, false); assert.equal(saved.gate.passed, false);
        assert.equal(saved.cells.length, scenario === 'stopped' ? 1 : 6);
        if (scenario === 'loss') assert.ok(saved.cells.every(row => row.scored && !row.passed && row.ownOverEngine === 200 / 44));
        if (scenario === 'fault') assert.equal(saved.sittingSummary.harnessFaults.length, 6);
        assert.match(readFileSync(stem + '.md', 'utf8'), /Exit 0: all sitting cells scored/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test('sitting permits an owner-present run while retaining platform, hold and inventory checks', async () => {
  const safe = { sitting: true, ownerAway: false, platform: 'darwin', held: false, running: [] };
  assert.doesNotThrow(() => assertProbeSafety(safe, sittingPlan()));
  for (const [change, error] of [[{ platform: 'linux' }, 'MACOS_REQUIRED'], [{ held: true }, 'HOLD'],
    [{ running: null }, 'APP_INVENTORY_UNAVAILABLE'], [{ running: [{ bundle: 'com.apple.TextEdit' }] }, 'APP_ALREADY_RUNNING']]) {
    assert.throws(() => assertProbeSafety({ ...safe, ...change }, sittingPlan()), new RegExp(error));
  }
  const { backend } = readSittingBackend({ idleMs: 35 });
  const { report } = await sitting({ sitting: true, ownerAway: false }, { backend });
  assert.equal(report.stop, undefined); assert.equal(report.sittingSummary.scoredCells, 6);
});

function readSittingBackend({ processes = true, idleMs = 44 } = {}) {
  const backend = fakeBackend(), events = [];
  backend.waitForEngineIdle = async () => { events.push('wait'); return { outcome: 'idle', elapsedMs: 25 }; };
  backend.prepare = async cell => { const fixture = { id: cell.id }; events.push(fixture); return fixture; };
  backend.trial = async (cell, fixture, index, run) => {
    assert.equal(run.sitting, true); assert.equal(fixture.id, cell.id);
    events.push({ fixture, runtime: run.runtime, index });
    const elapsedMs = run.runtime === 'engine' ? idleMs + index : 30 + index;
    return { ...evidence(cell), elapsedMs, ...(processes && { processEvidence: processEvidence(run.runtime) }),
      ...(run.runtime === 'own' && { runtimeReceipt: receipt(run.runNonce) }) };
  };
  return { backend, events };
}

test('sitting fake drivers retain one fixture per cell, wait once and publish both arms p50 and IQR', async () => {
  const { backend, events } = readSittingBackend({ idleMs: 35 });
  const { report, published } = await sitting({ sitting: true }, { backend });
  assert.equal(report.sitting, true); assert.equal(report.stop, undefined);
  assert.equal(report.cells.length, 6); assert.equal(events.length, 252);
  assert.equal(report.cells.reduce((n, row) => n + row.attempted, 0), 120);
  assert.equal(report.cells.reduce((n, row) => n + row.baselineData.length, 0), 120);
  assert.equal(report.verdict.passed, false); assert.equal(report.verdict.complete, false);
  assert.equal(report.verdict.verdict, 'step1: sitting-not-qualification');
  assert.equal(report.gate.passed, false); assert.equal(report.gate.verdict, 'incomplete');
  assert.equal(report.sittingSummary.passed, true); assert.equal(report.sittingSummary.scoredCells, 6);
  for (const [index, row] of report.cells.entries()) {
    const block = events.slice(index * 42, (index + 1) * 42), fixture = block[0];
    assert.deepEqual(block.slice(1, 21).map(event => event.runtime), Array(20).fill('engine'));
    assert.equal(block[21], 'wait');
    assert.deepEqual(block.slice(22).map(event => event.runtime), Array(20).fill('own'));
    assert.ok(block.filter(event => event?.fixture).every(event => event.fixture === fixture));
    assert.deepEqual(row.order, [...Array(20).fill('engine'), 'engine-idle', ...Array(20).fill('own')]);
    assert.deepEqual(row.latencies.own, { count: 20, p50Ms: 39, q1Ms: 34, q3Ms: 44, iqrMs: 10 });
    assert.equal(row.latencies.engine.p50Ms, 44);
    assert.equal(row.latencies.engine.iqrMs, 10);
    assert.equal(row.ownOverEngine, 39 / row.engineP50Ms);
    assert.equal(row.idleWait.elapsedMs, 25);
    assert.deepEqual(row.loadStart, [1, 2, 3]); assert.deepEqual(row.loadEnd, [1, 2, 3]);
    assert.equal(row.trialsData[0].processEvidence.schema, 'sleight.runtime-process-evidence/1');
  }
  assert.equal(published[0].report.sitting, true);
  assert.match(published[0].md, /Sitting: true/); assert.match(published[0].md, /Own IQR ms.*Engine IQR ms/);
});

test('sitting records a helper wait timeout without requiring process qualification', async () => {
  const { backend } = readSittingBackend({ idleMs: 35 });
  backend.waitForEngineIdle = async () => ({ outcome: 'timeout', elapsedMs: 30000, error: 'ENGINE_HELPER_PRESENT' });
  const { report } = await sitting({ sitting: true }, { backend });
  assert.equal(report.stop, undefined); assert.equal(report.sittingSummary.scoredCells, 6);
  assert.ok(report.cells.every(row => row.idleWait.error === 'ENGINE_HELPER_PRESENT'));
});

test('sitting reports an own latency loss and keeps failed samples without scoring an incomplete cell', async () => {
  for (const incomplete of [false, true]) {
    const { backend } = readSittingBackend({ idleMs: 35 }), trial = backend.trial;
    backend.trial = async (cell, fixture, index, run) => ({ ...await trial(cell, fixture, index, run),
      ...(run.runtime === 'own' && { elapsedMs: 200, correct: !incomplete || index !== 19 }) });
    const { report } = await sitting({ sitting: true }, { backend });
    assert.equal(report.sittingSummary.passed, false);
    for (const row of report.cells) {
      assert.equal(row.trialsData.length, 20); assert.equal(row.passed, false);
      assert.equal(row.scored, !incomplete); assert.ok(row.ownOverEngine > 1);
      if (incomplete) assert.equal(row.trialsData.at(-1).passed, false);
    }
  }
});

test('sitting process evidence is optional while a serving nonce receipt remains required', async () => {
  const { backend } = readSittingBackend({ processes: false, idleMs: 35 });
  let { report } = await sitting({ sitting: true }, { backend });
  assert.equal(report.stop, undefined); assert.equal(report.sittingSummary.scoredCells, 6);
  assert.equal(report.cells[0].trialsData[0].processEvidence, undefined);
  const trial = backend.trial;
  backend.trial = async (...args) => { const reply = await trial(...args); delete reply.runtimeReceipt; return reply; };
  ({ report } = await sitting({ sitting: true }, { backend }));
  assert.equal(report.stop, 'RUNTIME_RECEIPT_INVALID'); assert.equal(report.sitting, true);
  assert.equal(report.sittingSummary.passed, false);
});

test('each sitting cell enforces the inclusive 43 to 48 ms harness check independently', async () => {
  for (const target of sittingPlan()) {
    for (const [engineMs, fault] of [[42, true], [43, false], [48, false], [49, true]]) {
      const { backend } = readSittingBackend({ idleMs: 35 }), trial = backend.trial;
      backend.trial = async (cell, fixture, index, run) => ({ ...await trial(cell, fixture, index, run),
        ...(run.runtime === 'engine' && cell.id === target.id && { elapsedMs: engineMs }) });
      const { report } = await sitting({ sitting: true }, { backend });
      assert.deepEqual(report.sittingSummary.harnessFaults, fault ? [target.id] : [], `${target.id} at ${engineMs}`);
      assert.equal(report.sittingSummary.scoredCells, fault ? 5 : 6);
      const row = report.cells.find(row => row.id === target.id);
      assert.equal(row.harnessFault, fault); assert.equal(row.scored, !fault);
      assert.equal(row.passed, !fault);
    }
  }
});

test('sitting exits 0 for a scored own loss and 1 for incomplete or faulty harness results', async () => {
  for (const kind of ['win', 'loss', 'incomplete', 'fault', 'cleanup', 'stopped']) {
    const { backend } = readSittingBackend({ idleMs: 35 }), trial = backend.trial;
    backend.trial = async (cell, fixture, index, run) => ({ ...await trial(cell, fixture, index, run),
      ...(run.runtime === 'own' && { elapsedMs: kind === 'loss' ? 200 : 30, correct: kind !== 'incomplete' || index !== 19 }),
      ...(run.runtime === 'engine' && kind === 'fault' && { elapsedMs: 49 }) });
    if (kind === 'cleanup') backend.close = async () => ({ confirmed: false });
    if (kind === 'stopped') backend.prepare = async () => { throw Error('FIXTURE_FAILED'); };
    const { report, published } = await sitting({ sitting: true }, { backend });
    const completed = ['win', 'loss'].includes(kind);
    assert.equal(report.sittingSummary.completed, completed, kind);
    assert.equal(report.sittingSummary.passed, kind === 'win', kind);
    assert.equal(probeExitCode(report), completed ? 0 : 1, kind);
    assert.match(published[0].md, /Exit 0: all sitting cells scored.*own latency losses/);
    assert.match(published[0].md, /Engine block runs first/);
  }
  assert.equal(probeExitCode({ verdict: { passed: true } }), 0);
  assert.equal(probeExitCode({ verdict: { passed: false } }), 1);
});

test('nearest-rank summaries handle unsorted duplicates and an outlier without mutating samples', () => {
  const samples = [1000, 4, 1, 4, 7, 2, 4, 9];
  assert.deepEqual(latencySummary(samples), { count: 8, p50Ms: 4, q1Ms: 2, q3Ms: 7, iqrMs: 5 });
  assert.deepEqual(samples, [1000, 4, 1, 4, 7, 2, 4, 9]);
});

test('sitting rejects injected action cells or changed trial counts before host access', async () => {
  for (const changed of [[plan[0]], sittingPlan().map(cell => ({ ...cell, trials: 1 }))]) {
    await assert.rejects(runProbePlan({ sitting: true, dryRun: true, env: {} }, { plan: changed }), /SITTING_PLAN_REQUIRED/);
  }
  assert.deepEqual(latencySummary([]), { count: 0, p50Ms: null, q1Ms: null, q3Ms: null, iqrMs: null });
  assert.equal(probeVerdict(plan, { sitting: true }).complete, false);
});

test('sitting adapter accepts read-only drivers and refuses input before sending a request', async () => {
  const calls = [];
  const adapter = driverProbeAdapter({ request: async (method, params) => {
    calls.push(method);
    if (method === 'ping') return { methods: ['getApp', 'getAXState', 'getAXStateAndScreenshot'],
      runNonce: params.runNonce, apiVersion: 1, build: '2'.repeat(64) };
    if (method === 'health') return { accessibility: true, screenRecording: true };
    return { window: { windowId: '123', processStart: 'start' }, readId: 1 };
  } }, { sitting: true });
  await adapter.preflight(); await adapter.beginRun('sitting-synthetic-nonce'); await adapter.acquire('fake');
  const result = await adapter.receipt(OWN_BUILD);
  assert.equal(result.ping.runNonce, 'sitting-synthetic-nonce'); assert.equal(result.driverBuild, undefined);
  for (const method of ['click', 'pressKey', 'typeText']) await assert.rejects(adapter.act(method), /SITTING_READ_ONLY/);
  assert.equal(calls.some(method => ['click', 'pressKey', 'typeText', 'settle'].includes(method)), false);
  const backend = await createLiveProbe({ runtime: 'engine', sitting: true });
  await assert.rejects(backend.performTrial(plan[0], {}, 0, { runtime: 'engine' }), /SITTING_READ_ONLY/);
});

test('sitting observer retains scanner faults and never skips or repeats the operation', async () => {
  let operations = 0;
  for (const inventory of [async () => { throw Error('PROCESS_INVENTORY_UNAVAILABLE'); }, async () => ({ helpers: null })]) {
    const result = await observeSittingAttempt(async () => { operations++; return 7; }, { inventory });
    assert.equal(result.value, 7); assert.equal(result.processEvidence.required, false);
    assert.equal(result.processEvidence.observationErrors.length, 3);
  }
  const result = await observeSittingAttempt(async () => { operations++; return 8; }, {
    inventory: async () => ({ helpers: [], drivers: [{ pid: 1, started: 'now', path: '/synthetic/driver' }] }),
    hash: () => { throw Error('HELPER_BINARY_INVALID'); } });
  assert.equal(result.value, 8); assert.ok(result.processEvidence.observationErrors.includes('HELPER_BINARY_INVALID'));
  assert.equal(operations, 3);
  await assert.rejects(observeSittingAttempt(async () => { throw Error('FOCUS_CHANGED'); }, {
    inventory: async () => { throw Error('PROCESS_INVENTORY_UNAVAILABLE'); } }), /FOCUS_CHANGED/);
});

test('sitting writes JSON and Markdown markers even after an early preparation failure', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt30-json-unit-')), stem = join(dir, 'sitting');
  try {
    const report = await runProbePlan({ sitting: true, ownerAway: true, env: { SLEIGHT_RUNTIME: 'own' }, out: stem }, {
      backend: fakeBackend({ prepareError: 'FIXTURE_FAILED' }), platform: 'darwin', held: () => false,
      load: () => [1, 2, 3], log: () => {}, takeLock: async () => async () => {} });
    const saved = JSON.parse(readFileSync(stem + '.json', 'utf8'));
    assert.equal(saved.sitting, true); assert.equal(saved.stop, 'FIXTURE_FAILED'); assert.equal(report.gate.passed, false);
    assert.match(readFileSync(stem + '.md', 'utf8'), /Sitting: true/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a saved fake-driver sitting has six arm summaries and is rejected by the qualification loader', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt30-saved-unit-')), stem = join(dir, 'sitting');
  try {
    const { backend } = readSittingBackend({ idleMs: 35 });
    await runProbePlan({ sitting: true, ownerAway: true, out: stem, env: {} }, {
      backend, platform: 'darwin', held: () => false, load: () => [1, 2, 3], log: () => {}, takeLock: async () => async () => {} });
    const saved = JSON.parse(readFileSync(stem + '.json', 'utf8'));
    assert.equal(saved.sitting, true); assert.equal(saved.runtime, 'own'); assert.equal(saved.sittingSummary.passed, true);
    assert.equal(saved.cells.length, 6);
    assert.ok(saved.cells.every(row => row.latencies.own.count === 20 && row.latencies.engine.count === 20));
    assert.throws(() => assertStep1(saved, { build: saved.build.runtimeBuild, engine: engineIdentity(saved.build),
      sleightCommit: saved.build.sleightCommit }), /STEP1_REQUIRED/);
    assert.match(readFileSync(stem + '.md', 'utf8'), /Sitting: true/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('each mechanism requires positive observations, not an action acknowledgement', () => {
  for (const p of plan) {
    assert.equal(validateTrial(p, evidence(p)), true, p.id);
    for (const missing of ['observed', 'background']) assert.equal(validateTrial(p, { ...evidence(p), [missing]: false }), false);
    assert.equal(validateTrial(p, { ok: true }), false, p.id);
  }
  for (const [mechanism, key] of [['covered-click', 'windowClosed'], ['save-chord', 'fileMatches'], ['go-to-folder-chord', 'saveSheetBefore'],
    ['type-at-caret', 'caretConfirmed'], ['covered-capture', 'singleReply'], ['covered-capture', 'imageMatchesWindow'],
    ['sheet-settle', 'sheetGoneInNextRead'], ['menu-settle', 'menuAbsentBefore']]) {
    const p = plan.find(p => p.mechanism === mechanism);
    assert.equal(validateTrial(p, { ...evidence(p), [key]: false }), false, key);
  }
});
test('HID compares inferred last event time and checks click, key and typing separately', () => {
  const p = plan.find(p => p.group === 5);
  const good = evidence(p); assert.equal(validateTrial(p, good), true);
  for (const kind of ['click', 'key', 'type']) {
    const bad = structuredClone(good); bad.hid[kind].afterMs = 0;
    assert.equal(validateTrial(p, bad), false, kind);
  }
  const unchanged = structuredClone(good); unchanged.hid.click.afterMs = 1000;
  assert.equal(validateTrial(p, unchanged), false, 'raw equality is a reset relative to elapsed time');
});
test('no host access during dry run; default runtime is engine', async () => {
  const report = await runProbePlan({ dryRun: true, env: {} }, { backend: new Proxy({}, { get() { assert.fail('host access'); } }) });
  assert.equal(report.runtime, 'engine'); assert.equal(report.totalTrials, 470);
  assert.equal((await runProbePlan({ dryRun: true, env: { SLEIGHT_RUNTIME: 'own' } })).runtime, 'own');
  await assert.rejects(runProbePlan({ dryRun: true, env: { SLEIGHT_RUNTIME: 'bogus' } }), /INVALID_RUNTIME/);
});
test('owner-away, platform, hold, and inventory refusals', () => {
  const safe = { ownerAway: true, platform: 'darwin', held: false, running: [] };
  assert.doesNotThrow(() => assertProbeSafety(safe));
  for (const [change, code] of [[{ ownerAway: false }, 'OWNER_AWAY_REQUIRED'], [{ platform: 'linux' }, 'MACOS_REQUIRED'],
    [{ held: true }, 'HOLD'], [{ running: null }, 'APP_INVENTORY_UNAVAILABLE'],
    [{ running: [{ bundle: 'com.apple.TextEdit', pid: 9 }] }, 'APP_ALREADY_RUNNING']]) {
    assert.throws(() => assertProbeSafety({ ...safe, ...change }), new RegExp(code));
  }
});
test('470 passing fake trials, load pairs, versions, cleanup and Markdown shape', async () => {
  const { report, events, published } = await sitting();
  assert.equal(report.verdict.passed, true); assert.equal(report.cleanupConfirmed, true);
  assert.equal(report.cells.reduce((n, row) => n + row.passes, 0), 470);
  assert.deepEqual(events, ['lock', 'unlock']); assert.equal(published.length, 1);
  assert.equal(report.build.engineVersion, '1.2.3');
  for (const cell of report.cells) { assert.deepEqual(cell.loadStart, [1, 2, 3]); assert.deepEqual(cell.loadEnd, [1, 2, 3]); }
  assert.match(probeMarkdown(report), /Combined verdict: incomplete/); assert.match(published[0].md, /Runtime: own/);
});
test('latency equality passes, over budget or any missing trial fails', async () => {
  const cell = plan.find(p => p.group === 6);
  let result = await sitting({}, { plan: [cell] }); assert.equal(result.report.cells[0].passed, true);
  assert.equal(result.report.verdict.complete, false); assert.equal(result.report.gate.verdict, 'incomplete');
  result = await sitting({}, { plan: [cell], backend: fakeBackend({ fail: (p, i, run) => ({ ...evidence(p), elapsedMs: run.runtime === 'own' ? 11 : 10 }) }) });
  assert.equal(result.report.cells[0].passes, 20); assert.equal(result.report.cells[0].passed, false);
  result = await sitting({}, { plan: [cell], backend: fakeBackend({ fail: (p, n) => ({ ...evidence(p), correct: n !== 19 }) }) });
  assert.equal(result.report.cells[0].passed, false); assert.equal(result.report.cells[0].passes, 19);
});
test('first zero needs diagnosis; zero after one fix stops program; no automatic retries', async () => {
  const cell = plan[0], backend = fakeBackend({ fail: p => ({ ...evidence(p), windowClosed: false }) });
  const { report } = await sitting({ fixRound: 1 }, { plan: [cell], backend });
  assert.equal(report.gate.verdict, 'fail'); assert.equal(report.verdict.verdict, 'step1: stop-program'); assert.equal(report.verdict.automaticRetries, 0);
  assert.equal(backend.calls.filter(c => c.startsWith('trial:')).length, 10);
  assert.equal(probeVerdict(report.cells, { expected: [cell] }).verdict, 'step1: diagnose-and-fix');
  assert.equal(probeVerdict([], { fixRound: 1 }).verdict, 'step1: diagnose-and-fix');
});
test('all apps are inspected before first fixture; a running app releases lock', async () => {
  const backend = fakeBackend({ running: [{ bundle: 'com.apple.TextEdit' }] });
  const { report, events } = await sitting({}, { backend });
  assert.equal(report.stop, 'APP_ALREADY_RUNNING'); assert.deepEqual(events, ['lock', 'unlock']);
  assert.deepEqual(backend.calls, ['inventory', 'close']);
});
test('hold arriving in a trial stops next trial and cleans before unlocking', async () => {
  let held = false;
  const backend = fakeBackend({ fail: p => { held = true; return evidence(p); } });
  const { report, events } = await sitting({}, { backend, held: () => held });
  assert.equal(report.stop, 'HOLD'); assert.equal(report.cells[0].attempted, 1);
  assert.deepEqual(events, ['lock', 'unlock']);
});
test('uncertain fixture or backend cleanup retains lock; failure report is still published', async () => {
  const { report, events, published } = await sitting({}, { plan: [plan[0]], backend: fakeBackend({ cleanup: false }) });
  assert.equal(report.cleanupConfirmed, false); assert.equal(report.verdict.passed, false);
  assert.deepEqual(events, ['lock']); assert.equal(published.length, 1);
});
test('prepare and fatal input failures publish a stopped report and collect backend', async () => {
  for (const options of [{ prepareError: 'FIXTURE_FAILED' }, { trialError: 'PERSON_TOOK_OVER' }]) {
    const backend = fakeBackend(options), { report } = await sitting({}, { backend, plan: [plan[0]] });
    assert.equal(report.verdict.passed, false); assert.equal(backend.calls.at(-1), 'close');
  }
});
test('options reject missing values, unknown arguments and invented fix rounds', () => {
  assert.equal(parseProbeOptions(['--owner-away', '--out', '/tmp/gate', '--fix-round', '1']).fixRound, 1);
  for (const args of [['--out'], ['--out', '--dry-run'], ['--fix-round', '2'], ['--live']]) assert.throws(() => parseProbeOptions(args));
});
test('RT2 adapter binds exact window/start/readId, retains latest map, and refuses missing capabilities', async () => {
  const calls = [], window = { windowId: '123', processStart: 'opaque-start' };
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'ping') return { methods: ['getApp', 'getAXState', 'getAXStateAndScreenshot', 'click', 'pressKey', 'typeText', 'settle'] };
    if (method === 'health') return { accessibility: true, screenRecording: true };
    return { window, readId: method === 'getAXState' ? 2 : 1, text: 'Window: fake', delivery: 'sent-unverified', settled: true };
  }, close: async () => {} };
  const adapter = driverProbeAdapter(client); await adapter.preflight(); await adapter.acquire('com.apple.TextEdit'); await adapter.read();
  await adapter.act('click', [12, 20]);
  assert.deepEqual(calls.find(c => c.method === 'click').params, { ...window, readId: 2, args: [[12, 20]] });
  assert.deepEqual(calls.find(c => c.method === 'getApp').params, { selector: 'com.apple.TextEdit', launch: false });
  await assert.rejects(driverProbeAdapter({ request: async () => ({ methods: [] }) }).preflight(), /RUNTIME_ABSENT/);
});
test('RT2 adapter rejects identity drift, takeover, unknown delivery and unbound input', async () => {
  const window = { windowId: '123', processStart: 'start' };
  for (const reply of [{ window: { ...window, processStart: 'replacement' } }, { personTookOver: true }, { delivery: 'unknown' }]) {
    const adapter = driverProbeAdapter({ request: async method => method === 'getApp' ? { window, readId: 1 } : reply });
    await adapter.acquire('fake'); await assert.rejects(adapter.act('pressKey', 'super+s'));
  }
  await assert.rejects(driverProbeAdapter({ request: async () => assert.fail() }).act('click', [1, 2]), /NO_BOUND_READ/);
});
test('engine adapter requests one combined read and rejects tool failures', async () => {
  const calls = [];
  const adapter = engineProbeAdapter({ call: async (name, args) => { calls.push({ name, args });
    return { engineReceipt: engineReceipt(), content: [{ type: 'text', text: 'RT13JSON:{"text":"Window: fake","screenshot":{"data":"a"}}' }] }; } });
  assert.equal((await adapter.read(true)).text, 'Window: fake');
  assert.deepEqual(adapter.engineReceipt(), engineReceipt());
  assert.equal(engineProbeAdapter({}).engineReceipt(), undefined, 'no identity is invented before a relay reports one');
  assert.match(calls[0].args.code, /getAXStateAndScreenshot/);
  await assert.rejects(engineProbeAdapter({ call: async () => ({ isError: true }) }).read(), /ENGINE_CALL_FAILED/);
});

test('runtime identity mismatch refuses before lock and collects backend', async () => {
  const backend = fakeBackend({ runtime: 'engine' });
  const { report, events } = await sitting({ env: { SLEIGHT_RUNTIME: 'own' } }, { backend });
  assert.equal(report.stop, 'RUNTIME_IDENTITY_UNAVAILABLE'); assert.deepEqual(events, []);
  assert.deepEqual(backend.calls, ['close']);
});
test('engine or runtime source drift across a probe stops qualification', async () => {
  let reads = 0;
  const backend = fakeBackend();
  backend.metadata = async () => ({ ...metadata(), runtimeBuild: { ...OWN_BUILD, sourceSha256: ++reads < 3 ? 'one' : 'two' } });
  const { report } = await sitting({}, { backend, plan: [plan[0]] });
  assert.equal(report.stop, 'RUNTIME_BUILD_CHANGED'); assert.equal(report.verdict.passed, false);
});
test('zero after the fix round stops before the next mechanism', async () => {
  const backend = fakeBackend({ fail: p => ({ ...evidence(p), windowClosed: false }) });
  const { report } = await sitting({ fixRound: 1 }, { backend, plan: plan.slice(0, 2) });
  assert.equal(report.cells.length, 1); assert.equal(report.verdict.verdict, 'step1: stop-program');
  assert.equal(backend.calls.filter(c => c.startsWith('prepare:')).length, 1);
});


test('fake mechanism sitting writes both report files with load, threshold and build receipts', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt13-json-unit-')), stem = join(dir, 'mechanisms');
  try {
    const report = await runProbePlan({ ownerAway: true, env: { SLEIGHT_RUNTIME: 'own' }, out: stem }, { backend: fakeBackend(), plan: [plan[0]],
      platform: 'darwin', held: () => false, load: () => [1, 2, 3], log: () => {}, takeLock: async () => async () => {} });
    const saved = JSON.parse(readFileSync(stem + '.json', 'utf8'));
    assert.equal(saved.verdict.passed, false); assert.equal(saved.cells[0].trialsData.length, 10);
    assert.deepEqual(saved.cells[0].loadEnd, [1, 2, 3]); assert.equal(saved.cells[0].buildStart.engineVersion, '1.2.3');
    assert.equal(saved.cells[0].requiredPasses, 10); assert.equal(saved.runtime, report.runtime);
    assert.match(readFileSync(stem + '.md', 'utf8'), /10\/10/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an injected subset or altered trial count cannot complete the canonical plan', async () => {
  const { report } = await sitting({}, { plan: plan.slice(0, -1) });
  assert.equal(report.executedPlanSize, 28); assert.equal(report.canonicalPlanSize, 29);
  assert.equal(report.verdict.complete, false); assert.equal(report.gate.verdict, 'incomplete');
  assert.match(probeMarkdown(report), /^# Runtime gate\n\nCombined verdict: incomplete/);
  const changed = report.cells.map(row => ({ ...row, trials: 1, attempted: 1 }));
  assert.equal(probeVerdict(changed, { expected: changed }).complete, false);
});
test('latency limits come from same-session engine samples in ABBA order', async () => {
  const { report } = await sitting({}, { backend: fakeBackend({ fail: (cell, i, run) => ({ ...evidence(cell),
    elapsedMs: run.runtime === 'own' ? 500 : 501 }) }) });
  assert.equal(report.verdict.verdict, 'step1: mechanisms-pass');
  assert.equal(report.gate.verdict, 'incomplete');
  assert.equal(report.cells.reduce((n, row) => n + row.baselineData.length, 0), 200);
  for (const row of report.cells.filter(row => row.group === 6)) {
    assert.equal(row.p50LimitMs, 501); assert.equal(row.p50Ms, 500);
    assert.deepEqual(row.order.slice(0, 4), ['engine', 'own', 'own', 'engine']);
    assert.ok([...row.trialsData, ...row.baselineData].every(trial => trial.sessionId === report.sessionId));
  }
});
test('a missing own-runtime receipt invalidates a trial and stops before further input', async () => {
  const backend = fakeBackend(), original = backend.trial;
  backend.trial = async (...args) => { const value = await original(...args); delete value.runtimeReceipt; return value; };
  const { report } = await sitting({}, { backend });
  assert.equal(report.stop, 'RUNTIME_RECEIPT_INVALID'); assert.equal(report.cells[0].passes, 0);
  assert.equal(report.cells[0].attempted, 1); assert.equal(report.verdict.passed, false);
});
test('a helper-idle timeout stops before any mechanism attempt, including the last trial of a fix round', async () => {
  for (const stopIndex of [0, plan[0].trials - 1]) {
    const backend = fakeBackend({ fail: p => ({ ...evidence(p), windowClosed: false }) }), trial = backend.trial;
    const idleWait = { schema: 'sleight.runtime-idle-wait/1', timeoutMs: 30000, elapsedMs: 30000,
      outcome: 'timeout', samples: [{ at: 0, helpers: processEvidence('engine').samples[1].helpers }] };
    backend.trial = async (...args) => {
      if (args[2] === stopIndex) throw Object.assign(Error('ENGINE_HELPER_PRESENT'), { idleWait });
      return trial(...args);
    };
    const { report, events } = await sitting({ fixRound: 1 }, { backend, plan: plan.slice(0, 2) });
    const cell = report.cells[0];
    assert.equal(report.stop, 'ENGINE_HELPER_PRESENT'); assert.equal(report.cells.length, 1);
    assert.equal(cell.attempted, stopIndex); assert.equal(cell.trialsData.length, stopIndex);
    assert.equal(cell.order.length, stopIndex); assert.equal(cell.stoppedAttempt.attemptStarted, false);
    assert.deepEqual(cell.stoppedAttempt.idleWait, idleWait);
    assert.equal(report.verdict.verdict, 'step1: stopped'); assert.deepEqual(report.verdict.zeroMechanisms, []);
    assert.equal(report.gate.verdict, 'incomplete'); assert.deepEqual(events, ['lock', 'unlock']);
  }
});
test('a successful helper-idle wait is retained with its mechanism attempt', async () => {
  const backend = fakeBackend(), trial = backend.trial;
  backend.trial = async (...args) => ({ ...await trial(...args), idleWait: { outcome: 'idle', elapsedMs: 700, timeoutMs: 30000 } });
  const { report } = await sitting({}, { backend, plan: [plan[0]] });
  assert.equal(report.cells[0].passes, 10);
  assert.equal(report.cells[0].trialsData[0].idleWait.elapsedMs, 700);
});
test('the serving driver echoes a per-run nonce and supplies its version and build', async () => {
  const calls = [], adapter = driverProbeAdapter({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'ping') return { runNonce: params.runNonce, apiVersion: 1, build: '2'.repeat(64) };
    return { window: { windowId: '123', processStart: 'start' }, readId: 1 };
  } }, { processIdentity: () => ({ pid: 123, path: receipt('').driverPath }) });
  await adapter.beginRun('unique-synthetic-nonce'); await adapter.acquire('com.apple.TextEdit');
  const result = await adapter.receipt(OWN_BUILD, processEvidence());
  assert.equal(result.driverVersion, '1'); assert.equal(result.driverRequests, 1);
  assert.deepEqual(calls.at(-1), { method: 'ping', params: { runNonce: 'unique-synthetic-nonce' } });
  const bad = driverProbeAdapter({ request: async () => ({ apiVersion: 1, build: '2'.repeat(64) }) });
  await assert.rejects(bad.beginRun('unique-synthetic-nonce'), /RUNTIME_RECEIPT_INVALID/);
  const unsupported = driverProbeAdapter({ request: async () => { throw Error('INVALID_PARAMS'); } });
  await assert.rejects(unsupported.beginRun('unique-synthetic-nonce'), /RUNTIME_RECEIPT_INVALID/);
});
test('Finder is allowed only through the already-running retained-window release fixture', () => {
  assert.doesNotThrow(() => assertProbeSafety({ ownerAway: true, platform: 'darwin', held: false,
    running: [{ bundle: 'com.apple.finder', pid: 9 }] }));
  const cell = plan.find(cell => cell.app === 'finder');
  const lease = { bundle: 'com.apple.finder', pid: 9, running: true, launched: false, setupCase: 'already-running' };
  assert.doesNotThrow(() => assertProbeFixtureLease(cell, lease));
  for (const change of [{ launched: true }, { running: false }, { pid: 0 }, { setupCase: 'cold-launch' }, { bundle: 'other' }]) {
    assert.throws(() => assertProbeFixtureLease(cell, { ...lease, ...change }), /FINDER_FIXTURE_UNCONFIRMED/);
  }
});
