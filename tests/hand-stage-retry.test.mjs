import { passingPhase, passingPacing, withPairedControls } from './fixtures/stage-cost-evidence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { collectStageEvidence, stageEnvironmentCheck, recordPacingMotion, stageRunGuard, runLiveStage, jsonChild, liveStageCapture } from '../bench/hand/stage-live.mjs';
import { stageUnitFailure, stageUnitOrder, stageIdentity, stageUnitData, stageUnitDigest, validateStageResume,
  sealStageEvidence, STAGE_FAILURE_BUDGET } from '../bench/hand/stage-progress.mjs';
import { stageVerdict, reportMarkdown, parseArgs } from '../bench/hand/stage-cost.mjs';

const machine = { mac: 'offline', macOS: 'offline', maximumHz: 120, machineId: 'offline' };
const sizes = ['stage'], identity = stageIdentity('a'.repeat(40), { sha256: 'b'.repeat(64) }, machine);
const options = { identity, sizes }, order = stageUnitOrder(sizes);
const phaseId = 'round/1/phase/stage/quiet';
// External negative runs leave the mutation's AssertionError uncaught for an exit-1 receipt.
const rejectBroken = promise => process.env.ST9F_BROKEN === '1' ? promise : assert.rejects(promise, { name: 'AssertionError' });
const pacingIds = ['character/hash', 'numbered/hash', 'character/timestamps', 'numbered/timestamps']
  .map(arm => `round/1/pacing/stage/60/600/${arm}`);
const scenarios = [
  ['pacing-recorder', pacingIds[0]], ['fixture-seat', phaseId], ['capture', 'capture/edge-lie'],
  ['visibility', 'round/1/phase/stage/changing'], ['child', 'round/1/baseline/quiet/before'],
];
function harness({ failures = {}, stop, load = 2, cleanupError, globalStop } = {}) {
  const calls = [], cleanups = [], snapshots = [], summaries = []; let current, closed = 0, tick = 0;
  const perform = async value => {
    calls.push(current);
    if (current === stop) throw Object.assign(Error('offline global stop'), { runStop: true });
    if (failures[current]) throw stageUnitFailure(failures[current], `offline ${failures[current]}`, { partial: current, samples: [99] });
    return value;
  };
  const observe = () => ({ loadAverageMax: typeof load === 'function' ? load(current) : load, puddleWindowHeld: false });
  const deps = {
    machine: async () => machine, behavior: () => perform({ placements: [{ id: 'partial-safe-observation' }] }),
    baseline: surface => perform({ surface, activeS: 62, wsAvgPct: 1, wsPeakPct: 2 }),
    phase: (size, surface) => perform({ figures: passingPhase(size, surface),
      dump: { installMs: [1], installsPerPlan: [1], unplannedInstalls: 0, startupMs: 1,
        firstStripDecoded: true, cacheBytes: 1, resident2xStrips: 4, decodeMs: [1], drawBlocked: false,
        panels: [{ panel: [0, 0, 10, 10], seat: [0, 0, 10, 10], move: [0, 0, 10, 10] }] } }),
    pacing: (_size, hz, ms, metadata) => perform(passingPacing(hz, ms, metadata)),
    capture: seat => perform({ seat }), qualification: () => perform(observe()), observeQualification: observe,
    checkRun: () => { if (globalStop && current === globalStop.id) throw Object.assign(Error(globalStop.message), { runStop: true }); },
    cleanupUnit: async id => { cleanups.push(id); if (cleanupError) throw Error('unit cleanup unproved'); },
    summary: row => summaries.push(row), checkpoint: async evidence => {
      current = evidence.collection.inProgress?.id;
      snapshots[0] = JSON.parse(JSON.stringify(evidence));
    }, close: async () => { closed++; },
  };
  return { deps, calls, cleanups, snapshots, summaries, get closed() { return closed; },
    run: (collector = collectStageEvidence, extra = {}) => collector(deps, { ...options,
      now: () => new Date(Date.UTC(2026, 0, 1) + tick++).toISOString(), ...extra }) };
}
const variantUrls = new WeakMap();
async function broken(t, module, mutate) {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-stage-isolation-variant-')));
  const url = new URL('../bench/hand/' + module, import.meta.url), source = readFileSync(url, 'utf8');
  const changed = mutate(source); assert.notEqual(changed, source, 'mutation must match');
  const text = changed.replace(/from '(\.\.?\/[^']+)'/g, (_, relative) => `from '${new URL(relative, url).href}'`)
    .replace(/import\('(\.\.?\/[^']+)'\)/g, (_, relative) => `import('${new URL(relative, url).href}')`);
  const file = join(dir, module); writeFileSync(file, text);
  const urlString = pathToFileURL(file).href, result = await import(urlString); variantUrls.set(result, urlString); return result;
}
const brokenCollector = async (t, mutate) => (await broken(t, 'stage-live.mjs', mutate)).collectStageEvidence;

function bar(evidence, name = 'layer install') {
  return stageVerdict(evidence).runs[0].sizes.stage.checks.find(c => c.name === name);
}
async function successfulRetry(collector = collectStageEvidence) {
  const first = harness({ failures: { [phaseId]: 'fixture-seat' } }), partial = await first.run(collector);
  const next = harness(), evidence = await next.run(collector, { resumeEvidence: partial, retryFailed: true });
  assert.deepEqual(next.calls, [phaseId]);
  assert.equal(bar(evidence).verdict, 'pass');
  assert.equal(evidence.collection.attempts.filter(a => a.status === 'failed').length, 1);
  assert.equal(evidence.collection.units.find(u => u.id === phaseId).evidence, undefined);
  validateStageResume(evidence, options); return evidence;
}
test('CHV2W successful harness retry measures its phase and hidden control', () => successfulRetry());
test('CHV2W product failures cannot be retried into measurements', async () => {
  for (const kind of ['visibility', 'host-crash', 'prepare-refusal', 'microphone-active']) {
    const first = harness({ failures: { [phaseId]: kind } }), evidence = await first.run();
    const next = harness(), result = await next.run(collectStageEvidence, { resumeEvidence: evidence, retryFailed: true });
    assert.deepEqual(next.calls, []); assert.equal(bar(result).verdict, 'not-measured');
  }
});
test('CHV2W retry window must be independently quiet', async () => {
  const first = harness({ failures: { [phaseId]: 'fixture-seat' } }), partial = await first.run();
  const next = harness({ load: 14 }), evidence = await next.run(collectStageEvidence, { resumeEvidence: partial, retryFailed: true });
  assert.equal(bar(evidence).verdict, 'not-measured');
});
test('CHV2W attempts are capped at three across invocations', async () => {
  let evidence;
  for (let i = 0; i < 4; i++) {
    const h = harness({ failures: { [phaseId]: 'fixture-seat' } });
    evidence = await h.run(collectStageEvidence, { resumeEvidence: evidence, retryFailed: true });
    assert.equal(h.calls.includes(phaseId), i < 3);
  }
  assert.equal(evidence.collection.units.find(u => u.id === phaseId).attempt, 3);
});
test('CHV2W resume validates history, including successful retry history', async () => {
  const complete = await successfulRetry();
  for (const mutate of [e => e.collection.attempts.splice(0, 1),
    e => e.collection.attempts[0].id = 'round/99/nope', e => e.collection.attempts[0].kind = 'mystery',
    e => e.collection.attempts[0].attempt = 0, e => e.collection.attempts[0].segment = 99,
    e => e.collection.attempts.push(structuredClone(e.collection.attempts[0])),
    e => e.collection.segments[0].failureStreak = { kind: 'child', count: '3' }]) {
    const changed = structuredClone(complete); mutate(changed); sealStageEvidence(changed);
    assert.throws(() => validateStageResume(changed, options), /resume refused/);
  }
});
test('CHV2W judge refuses missing retry history without throwing', async () => {
  const e = await successfulRetry(); e.collection.attempts = [];
  assert.equal(bar(e).verdict, 'not-measured');
});
test('CHV2W a concurrent run stop retains the local kind', async () => {
  const h = harness({ failures: { [phaseId]: 'visibility' } });
  h.deps.checkRun = () => { if (h.calls.at(-1) === phaseId) throw Error('stop'); };
  await assert.rejects(h.run(), /stop/);
  assert.equal(h.snapshots.at(-1).collection.inProgress.kind, 'visibility');
});
test('CHV2W one pacing trial consumes one same-kind budget slot', async () => {
  const h = harness({ failures: Object.fromEntries(pacingIds.map(id => [id, 'pacing-recorder'])) });
  const e = await h.run(); assert.equal(e.collection.units.filter(u => u.status === 'failed').length, 4);
});
test('CHV2W failures are stored once in attempt history', async () => {
  const h = harness({ failures: { [phaseId]: 'fixture-seat' } }), e = await h.run();
  assert.equal(e.collection.units.find(u => u.id === phaseId).evidence, undefined);
  assert.deepEqual(e.collection.attempts[0].evidence.samples, [99]);
});
test('CHV2W pacing retries collect all four arms in one segment', async () => {
  const first = harness({ failures: { [pacingIds[0]]: 'pacing-recorder' } }), partial = await first.run();
  const next = harness(), e = await next.run(collectStageEvidence, { resumeEvidence: partial, retryFailed: true });
  assert.deepEqual(next.calls, pacingIds);
  assert.equal(new Set(pacingIds.map(id => e.collection.units.find(u => u.id === id).segment)).size, 1);
});
test('CHV2W a surviving measured fail remains fail', async () => {
  const h = harness({ failures: { [phaseId]: 'fixture-seat' } }), phase = h.deps.phase;
  h.deps.phase = async (...args) => { const p = await phase(...args); p.dump.installMs = [99]; return p; };
  const e = await h.run(); assert.equal(bar(e).verdict, 'fail'); assert.equal(bar(e).value, 99);
});

async function seatCase(seed, replies) {
  let elapsed = 0, calls = 0;
  const session = { ready: { windows: [{ pid: 1, id: 2, bounds: { x: 0, y: 0, width: 20, height: 20 } }] },
    wire: { aim: () => '' }, write() {}, size: 'stage', rows: [],
    request: async () => { calls++; return replies(Math.min(calls, 400), elapsed); } };
  return { session, calls: () => calls, run: () => seed(session, { helper: async () => ({ windows: [{ id: 77 }] }),
    wait: async ms => { elapsed += ms; }, clock: () => elapsed }) };
}
test('CHV2W seating waits for pending and timeout then preserves the final query and windows', async () => {
  const { seedFixture } = await import('../bench/hand/stage-live.mjs');
  const h = await seatCase(seedFixture, (_, elapsed) => ({ hideReason: 'call', callMonitor: { state: elapsed < 5000 ? 'pending' : 'timeout' } }));
  await assert.rejects(h.run(), error => {
    assert.equal(error.unitEvidence.waitedMs, 3000); assert.equal(error.unitEvidence.lastQuery.callMonitor.state, 'pending');
    assert.deepEqual(error.unitEvidence.helperWindows, [{ id: 77 }]); assert.match(error.message, /3000.*pending/); return true;
  });
  const pending = await seatCase(seedFixture, (_, elapsed) => elapsed < 3500 ?
    { panelID: 4, shown: true, size: 'stage', callMonitor: { state: 'pending' } } :
    { panelID: 4, shown: true, size: 'stage', callMonitor: { state: 'quiet' } });
  assert.equal((await pending.run()).panelID, 4); assert.equal(pending.calls(), 1);
});
test('CHV2W active microphone fails immediately as a product reason', async () => {
  const { seedFixture } = await import('../bench/hand/stage-live.mjs');
  const h = await seatCase(seedFixture, () => ({ callMonitor: { state: 'timeout', active: true, lastSuccessfulState: 'input-active' } }));
  await assert.rejects(h.run(), error => error.unitFailureKind === 'microphone-active' && /microphone input active/.test(error.message));
  assert.equal(h.calls(), 1);
});
test('CHV2W recorder failure takes one final query and window list and detects product visibility loss', async () => {
  let queries = 0, windows = 0;
  const session = { rows: [], request: async () => { queries++; return { panelID: 44, shown: false, hideReason: 'call' }; } };
  const recorder = { rows: [{ ok: false, error: 'stream-stopped' }], wait: async () => recorder.rows[0] };
  await assert.rejects(recordPacingMotion(session, recorder, {}, { helper: async () => { windows++; return { windows: [{ id: 44 }] }; } }), error => {
    assert.equal(error.unitFailureKind, 'visibility'); assert.equal(error.pacingEvidence.failureQuery.panelID, 44);
    assert.equal(error.pacingEvidence.failureQuery.hideReason, 'call'); assert.deepEqual(error.pacingEvidence.failureWindows, [{ id: 44 }]); return true;
  });
  assert.equal(queries, 1); assert.equal(windows, 1);
});

test('CHV2W H5 unknown setup exception stops and keeps cleanup', async () => {
  let closed = 0;
  await assert.rejects(liveStageCapture({ seat: 'edge-lie', character: {},
    own: async () => ({ rows: [], request: async () => { throw TypeError('H5 programmer error'); }, close: async () => { closed++; } }) }),
  error => error instanceof TypeError && error.unitFailureKind === undefined);
  assert.equal(closed, 1);
});

async function liveHarness(t, { closeCode = 0, onSurface, collect, runner = runLiveStage, helperError, openSession } = {}) {
  const { EventEmitter } = await import('node:events');
  const out = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-retry-live-')));
  const work = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-retry-work-')));
  const events = [], controller = new AbortController(); let opened = 0, held = false, realDeps;
  const runtime = {
    platform: 'darwin', createWork: () => work, signalTarget: new EventEmitter(), moduleCache: () => out,
    pause: async () => {}, isHeld: () => held, readLoad: () => 2, checkEnvironment: () => events.push('environment'),
    createGuard: () => ({ signal: controller.signal, abort: e => controller.abort(e), onClose: () => () => {},
      execute: async (_file, args) => ({ stdout: args.includes('rev-parse') ? identity.sourceCommit : '' }),
      close: async () => { events.push('guard-close'); } }),
    startPriority: async () => ({ close: async () => events.push('priority-close') }),
    holdAwake: () => ({ ready: Promise.resolve(), ended: false, close: async () => events.push('awake-close') }),
    prepareCharacter: () => ({ identity: identity.character }), machineIdentity: async () => machine.machineId,
    buildBench: async () => 'offline-binary',
    makeHelper: () => async () => { if (helperError) throw helperError; return { screenRecording: true }; },
    openFixture: async () => {
      const n = ++opened; events.push(`open:${n}`);
      if (n > 1 && openSession) return openSession({ n, events, controller, hold: () => { held = true; } });
      return { ready: { machine }, rows: [], pid: n,
        request: async () => { events.push(`surface:${n}`); return onSurface?.({ n, controller, hold: () => { held = true; } }); },
        sampler: { samples: [], stop: async () => events.push(`sample-stop:${n}`) },
        close: async () => { events.push(`close:${n}`); return { code: n === 2 ? closeCode : 0, signal: null }; } };
    },
    collectEvidence: async (deps, opts) => { realDeps = deps; return collect(deps, opts, events); },
  };
  return { events, deps: () => realDeps, run: () => runner({ ownerAway: true, size: 'stage', out }, {
    runtime, signal: controller.signal, acquireLock: async () => async () => events.push('unlock'),
  }) };
}
async function releaseCheck(t, runner = runLiveStage) {
  const h = harness(); let count = 0;
  const live = await liveHarness(t, { runner, closeCode: 7, collect: (deps, opts) => collectStageEvidence({ ...h.deps,
    phase: async (...args) => withPairedControls(await h.deps.phase(...args)),
    baseline: surface => ++count === 1 ? deps.baseline(surface) : h.deps.baseline(surface),
    checkRun: deps.checkRun, cleanupUnit: deps.cleanupUnit, roundStart: deps.roundStart,
    observeQualification: deps.observeQualification, qualification: deps.qualification }, { ...opts, now: () => new Date().toISOString() }) });
  const evidence = await live.run(), failed = evidence.collection.units.find(u => u.status === 'failed');
  assert.equal(failed.id, 'round/1/baseline/quiet/before'); assert.equal(failed.kind, 'host-crash');
  assert.equal(evidence.collection.attempts[0].evidence.exit.code, 7);
  assert.ok(live.events.indexOf('close:2') > live.events.indexOf('surface:2'));
  assert.equal(live.events.filter(e => e === 'close:2').length, 1);
  return evidence;
}
test('CHV2W real release records a nonzero fixture exit as a product failure', t => releaseCheck(t));
for (const stop of ['hold', 'abort']) test(`CHV2W real qualify stops a child failure coincident with ${stop}`, async t => {
  const h = harness();
  const live = await liveHarness(t, { onSurface: ({ hold, controller }) => {
    if (stop === 'hold') hold(); else controller.abort(Error('offline abort'));
    throw stageUnitFailure('child', 'offline child failure');
  }, collect: (deps, opts) => collectStageEvidence({ ...h.deps, baseline: deps.baseline,
    checkRun: deps.checkRun, cleanupUnit: deps.cleanupUnit, roundStart: deps.roundStart,
    observeQualification: deps.observeQualification, qualification: deps.qualification }, opts) });
  await assert.rejects(live.run(), stop === 'hold' ? /quiet window ended/ : /offline abort/);
  assert.equal(h.snapshots.at(-1).collection.inProgress.kind, 'child');
  assert.ok(live.events.includes('close:2')); assert.equal(live.events.includes('open:3'), false);
});
test('CHV2W real cleanupUnit collects an owned failing child before another own', async t => {
  let entered, fail;
  const started = new Promise(resolve => { entered = resolve; });
  const live = await liveHarness(t, { onSurface: () => { entered(); return new Promise((_, reject) => { fail = reject; }); },
    collect: async deps => {
      const pending = deps.baseline('quiet'); await started;
      // The fixture is owned while its child request is unresolved. The real cleanup closes it.
      await deps.cleanupUnit(); fail(stageUnitFailure('child', 'closed child'));
      await assert.rejects(pending, /closed child/);
      return {};
    } });
  await live.run(); assert.equal(live.events.filter(e => e === 'close:2').length, 2);
});
test('CHV2W helper wrapper stops unknown errors and classifies known child exits', async t => {
  const unknown = await liveHarness(t, { helperError: TypeError('helper programmer error') });
  await assert.rejects(unknown.run(), e => e instanceof TypeError && !e.unitFailureKind);
  const known = await liveHarness(t, { helperError: Object.assign(Error('helper died'), { code: 2 }) });
  await assert.rejects(known.run(), e => e.unitFailureKind === 'capture');
});
test('CHV2W real ENOENT spawn emits close and is collected', async () => {
  const owned = jsonChild(join(tmpdir(), 'sleight-never-created-binary-chv2w'), []);
  await assert.rejects(owned.wait(() => false), /ENOENT/);
  const exit = await owned.close(); assert.equal(exit.error.code, 'ENOENT');
});

async function totalBudget(collector = collectStageEvidence) {
  const groups = new Set(), ids = order.filter(id => {
    const group = id.includes('/pacing/') ? id.split('/').slice(0, 6).join('/') : id;
    if (id.endsWith('/qualification') || groups.has(group)) return false;
    groups.add(group); return true;
  }).slice(0, 12);
  const h = harness({ failures: Object.fromEntries(ids.map((id, i) => [id, i % 2 ? 'capture' : 'child'])) });
  await assert.rejects(h.run(collector), /total failure budget reached: 12/);
  assert.equal(h.calls.at(-1), ids.at(-1));
  validateStageResume(h.snapshots.at(-1), options);
}
test('CHV2W total budget stops twelve alternating-kind failures', () => totalBudget());
async function pacingGroup(collector = collectStageEvidence) {
  const h = harness({ failures: Object.fromEntries(pacingIds.map(id => [id, 'pacing-recorder'])) });
  await assert.doesNotReject(h.run(collector));
}
async function trialRetry(collector = collectStageEvidence) {
  const first = harness({ failures: { [pacingIds[0]]: 'pacing-recorder' } }), partial = await first.run();
  const next = harness(); await next.run(collector, { resumeEvidence: partial, retryFailed: true });
  assert.deepEqual(next.calls, pacingIds);
}
async function productRetry(collector = collectStageEvidence) {
  const first = harness({ failures: { [phaseId]: 'visibility' } }), partial = await first.run();
  const next = harness(); await next.run(collector, { resumeEvidence: partial, retryFailed: true });
  assert.deepEqual(next.calls, []);
}
async function capped(collector = collectStageEvidence) {
  let evidence;
  for (let i = 0; i < 4; i++) {
    const h = harness({ failures: { [phaseId]: 'fixture-seat' } });
    evidence = await h.run(collector, { resumeEvidence: evidence, retryFailed: true });
    assert.equal(h.calls.includes(phaseId), i < 3);
  }
}
const collectorVariants = [
  ['whole pacing trial', s => s.replace("parts[2] === 'pacing' ? order.filter(other => stageFailureGroup(other) === stageFailureGroup(id))", "false ? []"), trialRetry],
  ['product retry refusal', s => s.replace('&& stageRetryable(unit.kind)', '').replaceAll('!stageRetryable(a.kind)', 'false'), productRetry],
  ['three attempt cap', s => s.replaceAll('stageFailureAttempts(progress, unit.id) < STAGE_MAX_ATTEMPTS', 'true')
    .replaceAll('stageFailureAttempts(progress, member) >= STAGE_MAX_ATTEMPTS', 'false')
    .replace('if (stageFailureAttempts(progress, id) >= STAGE_MAX_ATTEMPTS)', 'if (false)'), capped],
  ['trial budget deduplication', s => s.replace('if (streak.group !== group)', 'if (true)'), pacingGroup],
  ['total budget', s => s.replace('total >= STAGE_TOTAL_FAILURE_BUDGET', 'false'), totalBudget],
];
for (const [name, mutate, assertion] of collectorVariants) test(`CHV2W broken variant: ${name}`, async t => {
  const collector = await brokenCollector(t, mutate);
  await assert.rejects(assertion(collector));
});
async function judgeRetryWindow(judge = stageVerdict) {
  const first = harness({ failures: { [phaseId]: 'fixture-seat' } }), partial = await first.run();
  const next = harness(), e = await next.run(collectStageEvidence, { resumeEvidence: partial, retryFailed: true });
  // Keep the overall round quiet to test the retry row independently of derived qualification.
  e.collection.segments.at(-1).rounds[1].loadAverageMax = 14;
  assert.equal(judge(e).runs[0].sizes.stage.checks.find(c => c.name === 'layer install').verdict, 'not-measured');
}
async function preserveFail(judge = stageVerdict) {
  const h = harness({ failures: { [phaseId]: 'fixture-seat' } }), phase = h.deps.phase;
  h.deps.phase = async (...args) => { const p = await phase(...args); p.dump.installMs = [99]; return p; };
  assert.equal(judge(await h.run()).runs[0].sizes.stage.checks.find(c => c.name === 'layer install').verdict, 'fail');
}
async function missingHistory(judge = stageVerdict) {
  const e = await successfulRetry(); e.collection.attempts = [];
  assert.equal(judge(e).runs[0].sizes.stage.checks.find(c => c.name === 'layer install').verdict, 'not-measured');
}
async function discardedRound(judge = stageVerdict) {
  const h = harness({ failures: { [phaseId]: 'visibility' } }), partial = await h.run();
  partial.collection.segments[0].rounds[1].loadAverageMax = null; sealStageEvidence(partial);
  const next = harness(), e = await next.run(collectStageEvidence, { resumeEvidence: partial });
  assert.equal(judge(e).runs[0].sizes.stage.checks.find(c => c.name === 'layer install').verdict, 'not-measured');
  assert.equal(e.collection.units.find(u => u.id === phaseId).attempt, 2);
  assert.ok(e.collection.attempts.find(a => a.id === phaseId).discarded);
  validateStageResume(e, options);
}
const judgeVariants = [
  ['own retry load window', s => s.replace('!ownWindowQuiet(unit)', 'false'), judgeRetryWindow],
  ['missing retry history', s => s.replace('const historyError = progress ? stageHistoryError(progress) : null;', 'const historyError = null;'), missingHistory],
  ['measured fail retained', s => s.replace("if (c.verdict === 'pass')", 'if (true)'), preserveFail],
  ['discarded product failure persists', s => s.replace('unit.kind && !stageRetryable(unit.kind)', '!unit.discarded && unit.kind && !stageRetryable(unit.kind)'), discardedRound],
];
for (const [name, mutate, assertion] of judgeVariants) test(`CHV2W broken variant: ${name}`, async t => {
  await assertion();
  const module = await broken(t, 'stage-cost.mjs', mutate);
  await assert.rejects(assertion(module.stageVerdict), { name: 'AssertionError' });
});
for (const [name, mutate] of [
  ['attempt schema', s => s.replace('if (!provenance(row) || !Number.isSafeInteger(row.attempt)', 'if (false && (!provenance(row) || !Number.isSafeInteger(row.attempt)').replace("typeof row.interrupted !== 'boolean') return", "typeof row.interrupted !== 'boolean')) return")],
  ['complete numbering', s => s.replace("if (prior.length !== (row.attempt ?? 1) - 1)", 'if (false)').replace("if (rows.some((a, i) =>", "if (false && rows.some((a, i) =>")
],
]) test(`CHV2W broken variant: history ${name}`, async t => {
  const module = await broken(t, 'stage-progress.mjs', mutate), e = await successfulRetry();
  if (name === 'attempt schema') e.collection.attempts[0].kind = 'mystery'; else e.collection.attempts = [];
  sealStageEvidence(e);
  assert.throws(() => validateStageResume(e, options), /resume refused/);
  assert.doesNotThrow(() => module.validateStageResume(e, options));
});

async function unknownCapture(run = liveStageCapture) {
  let closed = 0;
  await assert.rejects(run({ seat: 'edge-lie', character: {}, own: async () => ({ rows: [],
    request: async () => { throw TypeError('H5 programmer error'); }, close: async () => { closed++; } }) }),
  error => error instanceof TypeError && !error.unitFailureKind);
  assert.equal(closed, 1);
}
test('CHV2W broken variant: H5 unknown exceptions stay fatal', async t => {
  const module = await broken(t, 'stage-live.mjs', s => s.replace('error.unitEvidence ??= { rows: session.rows, captureReceipts };',
    "if (!stageFailureKind(error)) throw stageUnitFailure('capture', error.message); error.unitEvidence ??= { rows: session.rows, captureReceipts };"));
  await assert.rejects(unknownCapture(module.liveStageCapture), { name: 'AssertionError' });
});
test('CHV2W broken variant: helper unknown exceptions stay fatal', async t => {
  const module = await broken(t, 'stage-live.mjs', s => s.replaceAll('if (!knownChildError(error)) throw error;', '/* broken: wrap all exceptions */'));
  const live = await liveHarness(t, { runner: module.runLiveStage, helperError: TypeError('helper programmer error') });
  await assert.rejects(assert.rejects(live.run(), error => error instanceof TypeError && !error.unitFailureKind), { name: 'AssertionError' });
});
test('CHV2W broken variant: fixture exit remains a product failure', async t => {
  const module = await broken(t, 'stage-live.mjs', s => s.replace("throw stageUnitFailure('host-crash', `stage fixture exited", "throw stageUnitFailure('child', `stage fixture exited"));
  await assert.rejects(releaseCheck(t, module.runLiveStage), { name: 'AssertionError' });
});
async function stopKind(collector = collectStageEvidence) {
  const h = harness({ failures: { [phaseId]: 'visibility' } });
  h.deps.checkRun = () => { if (h.calls.at(-1) === phaseId) throw Error('stop'); };
  await assert.rejects(h.run(collector), /stop/);
  assert.equal(h.snapshots.at(-1).collection.inProgress.kind, 'visibility');
}
test('CHV2W broken variant: coincident stop retains local kind', async t => {
  const collector = await brokenCollector(t, s => s.replace('progress.inProgress.kind = stageFailureKind(error) ?? undefined;', ''));
  await assert.rejects(stopKind(collector), { name: 'AssertionError' });
});
test('CHV2W broken variant: failed payload has one owner', async t => {
  const collector = await brokenCollector(t, s => s.replace('const { evidence: payload, ...failedUnit } = failed;', 'const payload = failed.evidence, failedUnit = failed;'));
  const h = harness({ failures: { [phaseId]: 'fixture-seat' } }), e = await h.run(collector);
  assert.throws(() => assert.equal(e.collection.units.find(u => u.id === phaseId).evidence, undefined), { name: 'AssertionError' });
});
async function seatEvidence(seed) {
  const h = await seatCase(seed, () => ({ hideReason: 'call', callMonitor: { state: 'unavailable' } }));
  await assert.rejects(h.run(), error => {
    assert.equal(error.unitEvidence.waitedMs, 3000); assert.equal(error.unitEvidence.lastQuery?.hideReason, 'call');
    assert.deepEqual(error.unitEvidence.helperWindows, [{ id: 77 }]); return true;
  });
}
for (const [name, mutate, check] of [
  ['seat query evidence', s => s.replace('const evidence = { lastQuery, helperWindows,', 'const evidence = { helperWindows,'), seatEvidence],
  ['seat window evidence', s => s.replace('const evidence = { lastQuery, helperWindows,', 'const evidence = { lastQuery,'), seatEvidence],
  ['three second seat window', s => s.replace('const ceiling = 3000;', 'const ceiling = 30000;'), seatEvidence],
  ['active microphone', s => s.replace("return failure('microphone-active', 'microphone input active');", "return failure('fixture-seat', 'seating failed');"), async seed => {
    const h = await seatCase(seed, () => ({ callMonitor: { active: true, lastSuccessfulState: 'input-active' } }));
    await assert.rejects(h.run(), error => { assert.equal(error.unitFailureKind, 'microphone-active'); return true; });
  }],
  ['pending monitor', s => s.replace('lastQuery.size === session.size)', "lastQuery.size === session.size && state === 'quiet')"), async seed => {
    const h = await seatCase(seed, (_, elapsed) => ({ panelID: 4, shown: true, size: 'stage', callMonitor: { state: elapsed < 3500 ? 'pending' : 'quiet' } }));
    await assert.doesNotReject(h.run()); assert.equal(h.calls(), 1);
  }],
]) test(`CHV2W broken variant: ${name}`, async t => {
  const live = await import('../bench/hand/stage-live.mjs'); await check(live.seedFixture);
  const module = await broken(t, 'stage-live.mjs', mutate);
  await assert.rejects(check(module.seedFixture), { name: 'AssertionError' });
});
async function recorderEvidence(record) {
  let queries = 0, windows = 0;
  const session = { rows: [], request: async () => { queries++; return { panelID: 44, shown: false, hideReason: 'call' }; } };
  const recorder = { rows: [], wait: async () => ({ ok: false, error: 'stream-stopped' }) };
  await assert.rejects(record(session, recorder, {}, { helper: async () => { windows++; return { windows: [{ id: 44 }] }; } }), error => {
    assert.equal(error.unitFailureKind, 'visibility'); assert.equal(error.pacingEvidence.failureQuery?.panelID, 44);
    assert.deepEqual(error.pacingEvidence.failureWindows, [{ id: 44 }]); return true;
  });
  assert.equal(queries, 1); assert.equal(windows, 1);
}
for (const [name, mutate] of [
  ['post-failure query', s => s.replace("['failureQuery', () => session.request({ bench: 'query' })]", "['failureQuery', async () => undefined]")],
  ['post-failure windows', s => s.replace("['failureWindows', async () => (await helper(['windows'])).windows]", "['failureWindows', async () => undefined]")],
  ['recorder product attribution', s => s.replace("error = stageUnitFailure('visibility', 'pacing character lost visibility', partial);", '/* broken: ignore visibility loss */;')],
]) test(`CHV2W broken variant: ${name}`, async t => {
  await recorderEvidence(recordPacingMotion);
  const module = await broken(t, 'stage-live.mjs', mutate);
  await assert.rejects(recorderEvidence(module.recordPacingMotion), { name: 'AssertionError' });
});

async function failingSession(t, { n, events, controller, hold }, { stop, pending = false } = {}) {
  const script = `import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin });
    console.log(JSON.stringify({ ready: true }));
    input.on('line', () => { console.log(JSON.stringify({ waiting: true })); ${pending ? '' : 'process.exit(7);'} });
    input.on('close', () => process.exit(7));`;
  const owned = jsonChild(process.execPath, ['--input-type=module', '-e', script], {}, { failureKind: 'host-crash' });
  t.after(() => owned.close());
  owned.child.once('close', () => {
    events.push(`exited:${n}`);
    if (stop === 'hold') hold();
    if (stop === 'abort') controller.abort(Error('actual child abort'));
  });
  owned.ready = { machine };
  owned.sampler = { samples: [], stop: async () => {} };
  await owned.wait(row => row.ready === true);
  return owned;
}
async function actualCleanup(t, runner = runLiveStage) {
  let child;
  const live = await liveHarness(t, { runner, openSession: async coordinates => {
    child = await failingSession(t, coordinates, { pending: true }); return child;
  }, collect: async deps => {
    const waiting = deps.baseline('quiet'); waiting.catch(() => {});
    while (!child) await new Promise(resolve => setImmediate(resolve));
    await child.wait(row => row.waiting === true);
    await assert.rejects(deps.cleanupUnit(), error => error.unitFailureKind === 'host-crash');
    assert.equal(child.alive, false);
    await assert.rejects(waiting, error => error.unitFailureKind === 'host-crash');
    assert.ok(live.events.includes('exited:2')); return {};
  } });
  await live.run();
}
test('CHV2W real cleanupUnit collects an actual Node child that exits seven on EOF', t => actualCleanup(t));
test('CHV2W broken variant: real cleanupUnit cannot skip owned children', async t => {
  const module = await broken(t, 'stage-live.mjs', s => s.replace(
    'cleanupUnit: async () => { for (const session of [...sessions]) await release(session); },', 'cleanupUnit: async () => {},'));
  await assert.rejects(actualCleanup(t, module.runLiveStage), { name: 'AssertionError' });
});
for (const stop of ['hold', 'abort']) test(`CHV2W real qualify handles actual child exit coincident with ${stop}`, async t => {
  const h = harness();
  const live = await liveHarness(t, { openSession: coordinates => failingSession(t, coordinates, { stop }),
    collect: (deps, opts) => collectStageEvidence({ ...h.deps, baseline: deps.baseline,
      checkRun: deps.checkRun, cleanupUnit: deps.cleanupUnit, roundStart: deps.roundStart,
      observeQualification: deps.observeQualification, qualification: deps.qualification }, opts) });
  await assert.rejects(live.run(), stop === 'hold' ? /quiet window ended/ : /actual child abort/);
  assert.equal(h.snapshots.at(-1).collection.inProgress.kind, 'host-crash');
  assert.equal(h.snapshots.at(-1).collection.inProgress.id, 'round/1/baseline/quiet/before');
  assert.ok(live.events.includes('exited:2')); assert.equal(live.events.includes('open:3'), false);
});

test('CHV2W a whole successful pacing retry resets its inherited failure streak', async () => {
  const first = harness({ failures: { [pacingIds[0]]: 'pacing-recorder' } }), partial = await first.run();
  // A stop immediately after this trial can preserve its streak across invocations.
  partial.collection.segments[0].failureStreak = { kind: 'pacing-recorder', count: 1,
    group: pacingIds[0].split('/').slice(0, 6).join('/') }; sealStageEvidence(partial);
  const next = harness(), e = await next.run(collectStageEvidence, { resumeEvidence: partial, retryFailed: true });
  assert.equal(e.collection.segments.at(-1).failureStreak.count, 0);
});
test('CHV2W helper protocol distinguishes malformed output from unknown adapter errors', async () => {
  const { stageCaptureHelper } = await import('../bench/hand/stage-live.mjs');
  for (const stdout of ['not-json', '{"ok":false,"error":"capture failed"}', 'null'])
    await assert.rejects(stageCaptureHelper('unused', async () => ({ stdout }))(['windows']), e => e.unitFailureKind === 'capture');
  await assert.rejects(stageCaptureHelper('unused', async () => { throw TypeError('adapter error'); })(['windows']), TypeError);
  assert.deepEqual(await stageCaptureHelper('unused', async () => ({ stdout: '{"ok":false}' }))(['hit']), { ok: false });
});
test('CHV2W known post-failure query death still collects windows and remains a product crash', async () => {
  let windows = 0;
  await assert.rejects(recordPacingMotion({ rows: [], request: async () => { throw stageUnitFailure('host-crash', 'fixture died'); } },
    { rows: [], wait: async () => ({ ok: false, error: 'stream-stopped' }) }, {},
    { helper: async () => { windows++; return { windows: [{ id: 4 }] }; } }), error => {
      assert.equal(error.unitFailureKind, 'host-crash'); assert.deepEqual(error.pacingEvidence.failureWindows, [{ id: 4 }]); return true;
    });
  assert.equal(windows, 1);
});
test('CHV2W resume rejects invented status and future provenance in attempt history', async () => {
  const base = await successfulRetry();
  for (const mutate of [e => e.collection.attempts[0].status = 'invented',
    e => { e.collection.segments.push({ ...structuredClone(e.collection.segments.at(-1)), id: 3 }); e.collection.attempts[0].segment = 3; }]) {
    const e = structuredClone(base); mutate(e); sealStageEvidence(e);
    assert.throws(() => validateStageResume(e, options), /resume refused/);
  }
});

test('CHV2W a capture failure cannot hide simultaneous product visibility loss', async () => {
  const { stageCaptureResult } = await import('../bench/hand/stage-live.mjs');
  assert.throws(() => stageCaptureResult({ modes: { hidden: { samples: [{ error: 'decode failed', result: 'error', handUp: false }] } } }),
    error => error.unitFailureKind === 'visibility');
});
test('CHV2W a quiet monitor with a persistent wrong size is a product refusal', async () => {
  const { seedFixture } = await import('../bench/hand/stage-live.mjs');
  const h = await seatCase(seedFixture, () => ({ panelID: 2, shown: true, size: 'medium', callMonitor: { state: 'quiet' } }));
  await assert.rejects(h.run(), error => error.unitFailureKind === 'prepare-refusal');
});
async function h5SampleUnknown(run, { failure = TypeError('sample programmer error'), expected = TypeError } = {}) {
  const target = { pid: 5, id: 9, bounds: { x: 100, y: 200, width: 800, height: 600 } };
  const panel = { x: 300, y: 100, width: 300, height: 350 };
  const base = { width: 10, height: 10, data: new Uint8Array(400).fill(255) };
  let up = false, closed = 0, captures = 0;
  const deps = {
    windows: async () => ({ front: 5, windows: [{ ...target, alpha: 1 }, ...(up ? [{ id: 11, pid: 44, alpha: 1, bounds: panel }] : [])] }),
    capture: async () => { if (++captures > 10) throw failure; return base; },
    sleep: async () => {}, hit: async () => 5,
    startHost: async () => { up = true; return { pid: 44, write() {}, close: async () => { up = false; closed++; } }; },
    configureStage: async ({ seat, size }) => ({ seat, size, panel, stageArt: true }),
    observeStage: async () => ({ seat: 'edge-lie', size: 'stage', panel, stageArt: true }),
    stageWire: () => ({ character: () => '', act: () => '', hide: () => '' }),
  };
  await assert.rejects(run(deps, { target, seat: 'edge-lie', panel, character: {} }), expected);
  assert.equal(closed, 1);
}
test('CHV2W H5 sample exceptions keep their type and close the host', async () => {
  const { runStageCaptureTest } = await import('../bench/hand/h5-capture.mjs'); await h5SampleUnknown(runStageCaptureTest);
});
test('CHV2W broken variant: H5 sample errors cannot swallow unknown exceptions', async t => {
  const module = await broken(t, 'h5-capture.mjs', s => s.replace('if (stageCase && (!stageFailureKind(e) || !stageRetryable(stageFailureKind(e)))) throw e;', ''));
  await assert.rejects(h5SampleUnknown(module.runStageCaptureTest), { name: 'AssertionError' });
});

test('CHV2W H5 capture callbacks preserve typed product failures', async () => {
  const { runStageCaptureTest } = await import('../bench/hand/h5-capture.mjs');
  await h5SampleUnknown(runStageCaptureTest, { failure: stageUnitFailure('host-crash', 'fixture died'),
    expected: error => error.unitFailureKind === 'host-crash' });
});

test('CHV2W broken variant: successful whole-trial retry clears its streak', async t => {
  const collector = await brokenCollector(t, s => s.replace("if (trialUnits.length === 4 && trialUnits.every(u => u.status !== 'failed' && u.segment === segment.id))", 'if (false)'));
  const first = harness({ failures: { [pacingIds[0]]: 'pacing-recorder' } }), partial = await first.run();
  partial.collection.segments[0].failureStreak = { kind: 'pacing-recorder', count: 1,
    group: pacingIds[0].split('/').slice(0, 6).join('/') }; sealStageEvidence(partial);
  const next = harness(), e = await next.run(collector, { resumeEvidence: partial, retryFailed: true });
  assert.throws(() => assert.equal(e.collection.segments.at(-1).failureStreak.count, 0), { name: 'AssertionError' });
});

async function beforeRecorderVisibility(t, runner = runLiveStage) {
  let queries = 0;
  const live = await liveHarness(t, { runner, openSession: async () => ({ rows: [], size: 'stage',
    ready: { windows: [{ pid: 3, id: 4, bounds: { x: 0, y: 0, width: 400, height: 300 } }] },
    wire: { aim: () => '' }, write() {}, close: async () => ({ code: 0 }),
    request: async request => request.bench === 'prepare' ? { ok: true } : ++queries === 1 ?
      { shown: true, size: 'stage', panelID: 44, callMonitor: { state: 'quiet' } } :
      { shown: false, panelID: null, hideReason: 'call' },
  }), collect: async deps => {
    await assert.rejects(deps.pacing('stage', 60, 600, { source: 'character', recorderMode: 'hash' }),
      error => error.unitFailureKind === 'visibility');
    return {};
  } });
  await live.run(); assert.equal(queries, 2);
}
test('CHV2W visibility lost before recorder startup remains a product failure', t => beforeRecorderVisibility(t));
test('CHV2W product failures precede harness failures in the report', async () => {
  const h = harness({ failures: { [phaseId]: 'fixture-seat', 'round/1/phase/stage/changing': 'visibility',
    [pacingIds[0]]: 'pacing-recorder' } }), result = stageVerdict(await h.run());
  assert.equal(result.attempts[0].kind, 'visibility');
  const report = reportMarkdown(result);
  assert.ok(report.indexOf('kind visibility') < report.indexOf('kind fixture-seat'));
});

test('CHV2W broken variant: pre-recorder visibility cannot become a helper fault', async t => {
  const module = await broken(t, 'stage-live.mjs', s => s.replace("if (snapshot.shown !== true || snapshot.size !== size || !snapshot.panelID)", 'if (false)'));
  await assert.rejects(beforeRecorderVisibility(t, module.runLiveStage), { name: 'AssertionError' });
});

async function stoppedAttemptReport(judge = stageVerdict) {
  const h = harness({ failures: { [phaseId]: 'visibility' } });
  h.deps.checkRun = () => { if (h.calls.at(-1) === phaseId) throw Error('owner returned'); };
  await assert.rejects(h.run(), /owner returned/);
  const report = reportMarkdown(judge(h.snapshots.at(-1)));
  assert.match(report, /kind visibility; attempt 1/); assert.match(report, /interrupted/);
}
test('CHV2W a stopped attempt reports its local kind before resume', () => stoppedAttemptReport());
test('CHV2W behavior and capture verdict rows carry attempt counts', async () => {
  const first = harness({ failures: { behavior: 'child', 'capture/edge-lie': 'capture' } }), partial = await first.run();
  const next = harness(), e = await next.run(collectStageEvidence, { resumeEvidence: partial, retryFailed: true });
  const report = reportMarkdown(stageVerdict(e)), rows = report.split('\n');
  assert.match(rows.find(row => row.startsWith('| H5 stage capture |')), /attempts 2/);
  assert.match(rows.find(row => row.startsWith('| never cover target')), /attempts 2/);
});

test('CHV2W broken variant: stopped attempt cannot disappear from the report', async t => {
  const module = await broken(t, 'stage-cost.mjs', s => s.replace('if (progress?.inProgress) attemptRows.push', 'if (false) attemptRows.push'));
  await assert.rejects(stoppedAttemptReport(module.stageVerdict), { name: 'AssertionError' });
});

async function stoppedThird(judge = stageVerdict) {
  const first = harness({ failures: { [pacingIds[0]]: 'pacing-recorder' } }); let e = await first.run();
  for (let attempt = 2; attempt <= 3; attempt++) {
    const next = harness({ stop: pacingIds[0] });
    await assert.rejects(next.run(collectStageEvidence, { resumeEvidence: e, retryFailed: true }), /offline global stop/);
    e = next.snapshots.at(-1);
  }
  assert.equal(e.collection.inProgress.attempt, 3);
  const row = reportMarkdown(judge(e)).split('\n').find(line => line.startsWith('| stage | frame pacing'));
  assert.match(row, /attempts 3/);
}
test('CHV2W a stopped third pacing attempt prints three beside its verdict', () => stoppedThird());
test('CHV2W broken variant: stopped attempt count must reach the verdict row', async t => {
  const module = await broken(t, 'stage-cost.mjs', s => s.replace('const latestUnits = [...units, ...progress?.inProgress ? [progress.inProgress] : []];', 'const latestUnits = units;'));
  await assert.rejects(stoppedThird(module.stageVerdict), { name: 'AssertionError' });
});

async function rejectStitch(judge, pacing) {
  const h = harness();
  if (pacing) {
    const original = h.deps.pacing;
    h.deps.pacing = async (...args) => {
      const row = await original(...args), { requestedHz: hz, durationMs: ms, source } = row;
      const bare = { sublayerCount: 0, siblingCount: 0, opacity: 1, parentAnimationKeys: [] };
      return { ...row, scheduledStartHostMs: 1000, frames: Array.from({ length: hz * ms / 1000 }, (_, i) =>
        ({ tMs: i * 1000 / hz, hash: `frame-${i}` })),
      motionTiming: { source, scheduledStartHostMs: 1000, installStartHostMs: 1000, caBeginHostMs: 1000,
        installEndHostMs: 1000, transactionSubmittedHostMs: 1000, numberedFrames: hz * ms / 1000,
        cadenceInstalled: true, stationary: { ...bare, animationKeys: [] }, layerState: { ...bare, animationKeys: ['contents'] } } };
    };
  }
  const e = await h.run(), name = pacing ? 'frame pacing, 60 and 120 Hz' : 'WindowServer added, average';
  assert.equal(stageVerdict(e).runs[0].sizes.stage.checks.find(c => c.name === name).verdict, 'pass');
  e.collection.segments.push({ ...structuredClone(e.collection.segments[0]), id: 2 });
  const id = pacing ? pacingIds[1] : 'round/1/baseline/quiet/before';
  e.collection.units.find(u => u.id === id).segment = 2;
  assert.equal(judge(e).runs[0].sizes.stage.checks.find(c => c.name === name).verdict, 'not-measured');
}
for (const pacing of [true]) test(`CHV2W broken variant: judge rejects stitched ${pacing ? 'pacing trial' : 'baseline bracket'}`, async t => {
  await rejectStitch(stageVerdict, pacing);
  const module = await broken(t, 'stage-cost.mjs', s => s.replace('new Set(ids.map(id => units.find(u => u.id === id)?.segment)).size === 1', 'true'));
  await assert.rejects(rejectStitch(module.stageVerdict, pacing), { name: 'AssertionError' });
});

async function repeatedStops(collector = collectStageEvidence) {
  let evidence;
  for (let i = 0; i < 5; i++) {
    const h = harness({ stop: phaseId });
    await assert.rejects(h.run(collector, { resumeEvidence: evidence }), /offline global stop/);
    evidence = h.snapshots.at(-1);
    assert.equal(evidence.collection.inProgress.attempt, i + 1);
  }
  const h = harness(), result = await h.run(collector, { resumeEvidence: evidence });
  assert.equal(result.collection.units.find(u => u.id === phaseId).attempt, 6);
  assert.equal(bar(result, 'WindowServer added, average').verdict, 'pass');
  validateStageResume(result, options);
}
test('INT26 five run-level interruptions spend no unit-local retry slots', () => repeatedStops());
test('INT26 broken cap counts interrupted attempts', async t => {
  const collector = await brokenCollector(t, s => s.replace('if (stageFailureAttempts(progress, id) >= STAGE_MAX_ATTEMPTS)', 'if (attempt > STAGE_MAX_ATTEMPTS)'));
  await assert.rejects(repeatedStops(collector), { name: 'AssertionError' });
});

async function sixStopBank(id = phaseId, controlLayout = 'single/1') {
  let evidence;
  for (let i = 0; i < 6; i++) {
    const h = harness({ stop: id });
    await assert.rejects(h.run(collectStageEvidence, { resumeEvidence: evidence, controlLayout }), /offline global stop/);
    evidence = h.snapshots.at(-1);
    assert.equal(evidence.collection.inProgress.attempt, i + 1);
  }
  return evidence;
}
async function interruptionCeiling(collector = collectStageEvidence, id = phaseId, report = reportMarkdown) {
  const evidence = await sixStopBank(id), before = structuredClone(evidence), next = harness();
  const result = await next.run(collector, { resumeEvidence: evidence, retryFailed: true });
  assert.ok(!next.calls.includes(id), 'excluded unit must never run again');
  assert.equal(next.calls[0], order[order.indexOf(id) + 1], 'continue with the next unit');
  assert.deepEqual(result.collection.excluded, [{ code: 'STAGE_INTERRUPTION_CEILING', unit: id,
    interruptions: 6, limit: 6, reason: 'offline global stop' }]);
  assert.equal(result.collection.units.length, order.length - 1);
  assert.equal(result.collection.attempts.filter(a => a.id === id && a.interrupted).length, 6);
  assert.deepEqual(evidence, before);
  validateStageResume(result, options);
  const verdict = stageVerdict(result);
  assert.equal(verdict.units.excluded, 1); assert.equal(verdict.units.completed, order.length - 1);
  assert.equal(verdict.units.notRun, 0);
  const lines = report(verdict).split('\n').filter(line => line.startsWith('STAGE_INTERRUPTION_CEILING: excluded unit'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(JSON.stringify(id)) && lines[0].includes('6/6') && lines[0].includes('offline global stop'));
  const again = harness();
  await again.run(collector, { resumeEvidence: result, retryFailed: true });
  assert.deepEqual(again.calls, [], 'excluded unit remains skipped on subsequent resumes');
  return result;
}
for (const id of ['behavior', phaseId, pacingIds[2], 'round/1/qualification', 'capture/edge-lie',
  'round/1/baseline/quiet/before']) test(`ST9F six interruptions exclude and continue: ${id}`, () => interruptionCeiling(collectStageEvidence, id));
test('ST9F broken collector retries an excluded unit', async t => {
  const collector = await brokenCollector(t, s => s.replace('    if (progress.excluded?.some(row => row.unit === id)) return;', ''));
  await rejectBroken(interruptionCeiling(collector));
});
test('ST9F broken report omits excluded unit lines', async t => {
  const module = await broken(t, 'stage-cost.mjs', s => s.replace('for (const stop of result.interruptionCeilings ?? [])', 'for (const stop of [])'));
  await rejectBroken(interruptionCeiling(collectStageEvidence, phaseId, module.reportMarkdown));
});
async function stopAfterExclusion(validate = validateStageResume) {
  const evidence = await sixStopBank(), nextId = order[order.indexOf(phaseId) + 1];
  const h = harness({ stop: nextId });
  await assert.rejects(h.run(collectStageEvidence, { resumeEvidence: evidence }), /offline global stop/);
  const stopped = h.snapshots.at(-1);
  assert.equal(stopped.collection.inProgress.id, nextId);
  assert.doesNotThrow(() => validate(stopped, options));
  const next = harness(); await next.run(collectStageEvidence, { resumeEvidence: stopped });
  assert.equal(next.calls[0], nextId); assert.ok(!next.calls.includes(phaseId));
}
test('ST9F a stop after an exclusion resumes the same bank at the next unit', () => stopAfterExclusion());
test('ST9F broken validator demands an excluded gap be collected', async t => {
  const module = await broken(t, 'stage-progress.mjs', s => s.replace(
    '!stageInterruptionCeilings(progress).some(row => row.unit === id)) &&', 'true) &&'));
  await rejectBroken(stopAfterExclusion(module.validateStageResume));
});
async function earlyExclusion(t, runner = runLiveStage) {
  const evidence = await sixStopBank(phaseId, 'bracketed/1');
  // A crash may leave the sixth stop without an exclusion record. Derive it before the lock boundary.
  delete evidence.collection.excluded; sealStageEvidence(evidence);
  const out = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-st9f-prelock-')));
  const file = join(out, 'stage-cost.partial.json'); writeFileSync(file, JSON.stringify(evidence));
  let lockCalls = 0, built = 0, opened = 0;
  const sentinel = Error('offline lock boundary');
  await assert.rejects(runner({ resume: true, ownerAway: true, size: 'stage', out }, {
    runtime: { platform: 'darwin', isHeld: () => false, readPartial: () => evidence, buildBench: async () => { built++; },
      openFixture: async () => { opened++; } },
    acquireLock: async () => {
      lockCalls++;
      assert.equal(evidence.collection.excluded?.[0]?.unit, phaseId, 'ceiling decision must precede the lock');
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).collection.excluded, undefined, 'checkpoint writes need the lock');
      validateStageResume(evidence, options);
      throw sentinel;
    },
  }), error => { assert.equal(error, sentinel); return true; });
  assert.equal(lockCalls, 1); assert.equal(built, 0); assert.equal(opened, 0);
}
test('ST9F live entry records the exclusion before lock acquisition and host build', t => earlyExclusion(t));
test('ST9F broken live entry moves the ceiling decision after the lock', async t => {
  const line = '  const resumeExclusionsChanged = resumeEvidence && excludeStageInterruptedUnits(resumeEvidence);';
  const module = await broken(t, 'stage-live.mjs', s => s.replace(line, '').replace('  const work = createWork();', line + '\n  const work = createWork();'));
  await rejectBroken(earlyExclusion(t, module.runLiveStage));
});
async function persistExclusion(t, runner = runLiveStage) {
  const evidence = await sixStopBank(phaseId, 'bracketed/1'); delete evidence.collection.excluded; sealStageEvidence(evidence);
  const out = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-st9f-persist-')));
  const work = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-st9f-work-')));
  const file = join(out, 'stage-cost.partial.json'); writeFileSync(file, JSON.stringify(evidence));
  const controller = new AbortController(), sentinel = Error('offline preparation boundary');
  let held = false, unlocked = 0;
  await assert.rejects(runner({ resume: true, ownerAway: true, size: 'stage', out }, {
    signal: controller.signal, acquireLock: async () => { held = true; return async () => { unlocked++; }; },
    runtime: { platform: 'darwin', isHeld: () => false, createWork: () => work,
      createGuard: () => ({ signal: controller.signal, close: async () => {} }), checkEnvironment: () => {},
      startPriority: async () => {
        assert.equal(held, true);
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(saved.collection.excluded?.[0]?.unit, phaseId, 'persist exclusion before preparation');
        validateStageResume(saved, options); throw sentinel;
      } },
  }), error => { assert.equal(error, sentinel); return true; });
  assert.equal(unlocked, 1);
}
test('ST9F acquired lock protects the exclusion checkpoint before preparation', t => persistExclusion(t));
test('ST9F broken live entry delays exclusion persistence until after preparation', async t => {
  const line = '    if (resumeExclusionsChanged) writeStagePartial(opts.out, resumeEvidence);';
  const module = await broken(t, 'stage-live.mjs', s => s.replace(line, '').replace(
    '    priority = await startPriority();', '    priority = await startPriority();\n' + line));
  await rejectBroken(persistExclusion(t, module.runLiveStage));
});
async function excludedBars(judge = stageVerdict) {
  const e = await harness().run();
  const ids = [phaseId, pacingIds[0], 'behavior', 'capture/edge-lie', 'round/2/qualification'];
  // Retain old passing payloads deliberately: history alone must disqualify their bars.
  for (const id of ids) {
    const unit = e.collection.units.find(u => u.id === id);
    e.collection.attempts.push(...Array.from({ length: 6 }, (_, i) => ({ ...unit, id, attempt: i + 1,
      interrupted: true, error: `watchdog ${i + 1}` })));
    unit.attempt = 7;
  }
  sealStageEvidence(e); validateStageResume(e, options);
  const result = judge(e);
  assert.ok(result.runs[0].sizes.stage.checks.every(c => c.verdict === 'not-measured'));
  assert.ok(Object.values(result.runs[1].sizes).every(s => s.checks.every(c => c.verdict === 'not-measured')));
  assert.ok(result.runs[0].sizes.stage.pacing.every(c => c.verdict === 'not-measured'));
  assert.ok(result.behavior.every(c => c.verdict === 'not-measured'));
  assert.notEqual(result.verdict, 'pass');
  assert.equal(reportMarkdown(result).split('\n').filter(line => line.startsWith('STAGE_INTERRUPTION_CEILING: excluded unit')).length, ids.length);
}
test('ST9F excluded units cannot pass phase, pacing, behavior, capture or qualification bars', () => excludedBars());
test('ST9F broken judge retains excluded measurement bars', async t => {
  const module = await broken(t, 'stage-cost.mjs', s => s.replace("    c.verdict = 'not-measured'; c.value = null;", '    return;'));
  await rejectBroken(excludedBars(module.stageVerdict));
});
async function forgedExclusion(validate = validateStageResume) {
  const e = await harness().run();
  e.collection.excluded = [{ code: 'STAGE_INTERRUPTION_CEILING', unit: phaseId, interruptions: 6, limit: 6, reason: 'forged' }];
  sealStageEvidence(e);
  assert.throws(() => validate(e, options), /exclusions disagree/);
}
test('ST9F recorded exclusions must agree with interruption history', () => forgedExclusion());
test('ST9F broken validator accepts a fabricated exclusion', async t => {
  const module = await broken(t, 'stage-progress.mjs', s => s.replace('if (progress.excluded !== undefined &&', 'if (false &&'));
  await rejectBroken(forgedExclusion(module.validateStageResume));
});
async function laggingExclusion(validate = validateStageResume) {
  let evidence = await sixStopBank();
  const nextId = order[order.indexOf(phaseId) + 1];
  for (let i = 0; i < 6; i++) {
    const h = harness({ stop: nextId });
    await assert.rejects(h.run(collectStageEvidence, { resumeEvidence: evidence }), /offline global stop/);
    evidence = h.snapshots.at(-1);
  }
  // Simulate a process death after the sixth start checkpoint, before the catch block updated exclusions.
  evidence.collection.excluded = evidence.collection.excluded.filter(row => row.unit !== nextId);
  delete evidence.collection.inProgress.endedAt; delete evidence.collection.inProgress.error;
  sealStageEvidence(evidence);
  assert.doesNotThrow(() => validate(evidence, options));
  const next = harness(), result = await next.run(collectStageEvidence, { resumeEvidence: evidence });
  assert.deepEqual(result.collection.excluded.map(row => row.unit), [phaseId, nextId]);
  assert.equal(result.collection.excluded[1].reason, 'abrupt stop, no terminal observation');
  assert.equal(next.calls[0], order[order.indexOf(nextId) + 1]);
  assert.equal(result.collection.units.length, order.length - 2);
  validateStageResume(result, options);
}
test('ST9F an abrupt stop may leave saved exclusions behind the interruption history', () => laggingExclusion());
test('ST9F broken validator rejects lagging exclusions after an abrupt stop', async t => {
  const module = await broken(t, 'stage-progress.mjs', s => s.replace(
    'progress.excluded.some(row => !stageInterruptionCeilings(progress).some(actual => digest(actual) === digest(row)))',
    'JSON.stringify(progress.excluded) !== JSON.stringify(stageInterruptionCeilings(progress))'));
  await rejectBroken(laggingExclusion(module.validateStageResume));
});

async function diagnosticBaselines(judge = stageVerdict) {
  const id = 'round/1/baseline/quiet/before', h = harness({ failures: { [id]: 'child' } });
  const evidence = await h.run();
  assert.equal(judge(evidence).runs[0].sizes.stage.checks.find(c => c.name === 'WindowServer added, average').verdict, 'pass');
}
test('INT26 failed no-host diagnostic baseline does not mask a phase control', () => diagnosticBaselines());
test('INT26 broken baseline masking', async t => {
  const module = await broken(t, 'stage-cost.mjs', s => s.replace("          parts[2] === 'phase' &&", "          parts[2] === 'baseline' && c.name.startsWith('WindowServer') ||\n          parts[2] === 'phase' &&"));
  await assert.rejects(diagnosticBaselines(module.stageVerdict), { name: 'AssertionError' });
});

async function lifetimeCeiling(collector = collectStageEvidence) {
  const groups = new Set(), ids = order.filter(id => {
    const group = id.includes('/pacing/') ? id.split('/').slice(0, 6).join('/') : id;
    if (id.endsWith('/qualification') || groups.has(group)) return false;
    groups.add(group); return true;
  }).slice(0, 12);
  const first = harness({ failures: Object.fromEntries(ids.map((id, i) => [id, i % 2 ? 'capture' : 'child'])) });
  await assert.rejects(first.run(), /total failure budget reached: 12/);
  const next = harness();
  await assert.rejects(next.run(collector, { resumeEvidence: first.snapshots.at(-1), retryFailed: true }), /total failure budget reached: 12/);
  assert.deepEqual(next.calls, []);
}
test('INT26 lifetime ceiling refuses a thirteenth failure opportunity on resume', () => lifetimeCeiling());
test('INT26 broken lifetime ceiling across invocations', async t => {
  const collector = await brokenCollector(t, s => s.replace('if (lifetimeFailures >= STAGE_TOTAL_FAILURE_BUDGET)', 'if (false)'));
  await assert.rejects(lifetimeCeiling(collector), { name: 'AssertionError' });
});
