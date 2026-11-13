import { passingPhase } from './fixtures/stage-cost-evidence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { collectStageEvidence, stageEnvironmentCheck, recordPacingMotion, stageRunGuard } from '../bench/hand/stage-live.mjs';
import { stageUnitFailure, stageUnitOrder, stageIdentity, stageUnitData, stageUnitDigest, validateStageResume,
  sealStageEvidence, STAGE_FAILURE_BUDGET } from '../bench/hand/stage-progress.mjs';
import { stageVerdict, reportMarkdown, parseArgs } from '../bench/hand/stage-cost.mjs';

const machine = { mac: 'offline', macOS: 'offline', maximumHz: 120, machineId: 'offline' };
const sizes = ['stage'], identity = stageIdentity('a'.repeat(40), { sha256: 'b'.repeat(64) }, machine);
const options = { identity, sizes }, order = stageUnitOrder(sizes);
const phaseId = 'round/1/phase/stage/quiet';
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
    pacing: (_size, hz, ms, metadata) => perform({ ...metadata, requestedHz: hz, durationMs: ms,
      maximumHz: 120, started: true, ok: true, frames: [] }),
    capture: seat => perform({ seat }), qualification: () => perform(observe()), observeQualification: observe,
    checkRun: () => { if (globalStop && current === globalStop.id) throw Object.assign(Error(globalStop.message), { runStop: true }); },
    cleanupUnit: async id => { cleanups.push(id); if (cleanupError) throw Error('unit cleanup unproved'); },
    summary: row => summaries.push(row), checkpoint: async evidence => {
      current = evidence.collection.inProgress?.id;
      snapshots.push(JSON.parse(JSON.stringify(evidence)));
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
async function isolation(kind, id, collector = collectStageEvidence) {
  const h = harness({ failures: { [id]: kind } }), evidence = await h.run(collector);
  assert.deepEqual(h.calls, order, 'all later units collected once');
  assert.deepEqual(h.cleanups, [id]); assert.equal(h.closed, 1);
  const failed = evidence.collection.units.find(unit => unit.id === id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.kind, kind); assert.equal(failed.attempt, 1);
  assert.deepEqual(evidence.collection.attempts.find(a => a.id === id).evidence, { partial: id, samples: [99] });
  assert.equal(stageUnitData(evidence, id), undefined, 'failed payload quarantined');
  assert.equal(evidence.collection.attempts.length, 1); assert.equal(evidence.error, undefined);
  validateStageResume(evidence, options);
  const summary = stageVerdict(evidence).units;
  assert.deepEqual(summary, { completed: order.length - 1, failed: 1, retried: 0, failedByKind: { [kind]: 1 }, notRun: 0 });
  assert.deepEqual(h.summaries, [summary]);
  assert.ok(reportMarkdown(stageVerdict(evidence)).trimEnd().endsWith(`Units: 71 completed; 1 failed {"${kind}":1}; 0 not run; retried 0.`));
  const result = stageVerdict(evidence), checks = id.startsWith('capture/') ? result.behavior.filter(c => c.name === 'H5 stage capture') :
    result.runs[0].sizes.stage.checks.filter(c => id.includes('/baseline/') ? c.name.startsWith('WindowServer') :
      id.includes('/pacing/') ? c.name.startsWith('frame pacing') : !c.name.startsWith('frame pacing'));
  assert.ok(checks.length > 0); assert.ok(checks.every(c => id.includes('/baseline/') ? c.verdict === 'pass' : c.verdict !== 'pass'));
  return evidence;
}
for (const [kind, id] of scenarios) {
  test(`CHV2T isolates ${kind}, retains evidence and measures the remaining units`, () => isolation(kind, id));
  test(`CHV2T ${kind} isolation rejects the abort-on-unit-error variant`, async t => {
    const collector = await brokenCollector(t, s => s.replace('const kind = stageFailureKind(error);', 'const kind = null;'));
    await assert.rejects(isolation(kind, id, collector));
  });
}
for (const id of pacingIds) test(`CHV2T independent pacing arms survive failed ${id.split('/').slice(-2).join('/')}`, async () => {
  const first = harness({ failures: { [id]: 'pacing-recorder' } }), evidence = await first.run();
  for (const other of pacingIds.filter(other => other !== id)) assert.ok(stageUnitData(evidence, other));
  const next = harness(), complete = await next.run(collectStageEvidence, { resumeEvidence: evidence, retryFailed: true });
  assert.deepEqual(next.calls, pacingIds); validateStageResume(complete, options);
  for (const other of pacingIds.filter(other => other !== id))
    assert.equal(stageUnitDigest(complete, other), stageUnitDigest(evidence, other));
});
async function budget(collector = collectStageEvidence) {
  const ids = order.slice(1, 5), h = harness({ failures: Object.fromEntries(ids.map(id => [id, 'pacing-recorder'])) });
  await assert.rejects(h.run(collector), /failure budget reached: pacing-recorder in 4 consecutive units/);
  const partial = h.snapshots.at(-1); validateStageResume(partial, options);
  assert.equal(partial.collection.units.filter(unit => unit.status === 'failed').length, STAGE_FAILURE_BUDGET);
  assert.equal(h.calls.at(-1), order[4]); assert.equal(h.closed, 1);
  assert.equal(h.summaries[0].failed, 4); assert.ok(h.summaries[0].notRun > 0);
}
test('CHV2T four consecutive failures of one kind stop before the fifth unit', () => budget());
test('CHV2T budget test rejects the unlimited-failures variant', async t => {
  await assert.rejects(budget(await brokenCollector(t, s => s.replace('streak.count >= STAGE_FAILURE_BUDGET', 'false'))));
});
test('CHV2T a success or different failure kind resets the consecutive budget', async () => {
  for (const failures of [Object.fromEntries(pacingIds.map((id, i) => [id, i === 2 ? 'child' : 'pacing-recorder'])),
    Object.fromEntries(pacingIds.filter((_, i) => i !== 2).map(id => [id, 'pacing-recorder']))]) {
    const h = harness({ failures }); await h.run(); assert.equal(h.calls.length, order.length);
  }
});
async function retry(collector = collectStageEvidence) {
  const failures = { [phaseId]: 'fixture-seat', [pacingIds[0]]: 'pacing-recorder', 'capture/edge-lie': 'capture' };
  const first = harness({ failures }), partial = await first.run();
  const skip = harness(), skipped = await skip.run(collector, { resumeEvidence: partial });
  assert.deepEqual(skip.calls, []); assert.deepEqual(skipped.collection.units, partial.collection.units);
  const next = harness({ load: 14 }), evidence = await next.run(collector, { resumeEvidence: partial, retryFailed: true });
  assert.deepEqual(next.calls, [phaseId, ...pacingIds, 'capture/edge-lie']);
  for (const unit of partial.collection.units) if (unit.status !== 'failed' && !unit.id.endsWith('/qualification') && !next.calls.includes(unit.id))
    assert.deepEqual(evidence.collection.units.find(row => row.id === unit.id), unit);
  assert.ok(evidence.collection.units.filter(unit => Object.hasOwn(failures, unit.id)).every(unit => unit.attempt === 2 && unit.status !== 'failed'));
  assert.equal(evidence.runs[0].loadAverageMax, 14); assert.equal(stageVerdict(evidence).runs[0].quiet, false);
  assert.equal(stageVerdict(evidence).units.failed, 0); validateStageResume(evidence, options);
  const third = harness(); await third.run(collector, { resumeEvidence: evidence, retryFailed: true }); assert.deepEqual(third.calls, []);
  return evidence;
}
test('CHV2T retry selects only failed units once and folds the added load window', () => retry());
test('CHV2T retry assertion rejects ignoring --retry-failed', async t => {
  await assert.rejects(retry(await brokenCollector(t, s => s.replace('retryFailed ? progress.units.filter', 'false ? progress.units.filter'))));
});
test('CHV2T a retry that fails again runs once per invocation and retains both attempts', async () => {
  const config = { failures: { [pacingIds[1]]: 'pacing-recorder' } };
  const first = harness(config), partial = await first.run();
  const second = harness(config), evidence = await second.run(collectStageEvidence, { resumeEvidence: partial, retryFailed: true });
  assert.deepEqual(second.calls, pacingIds); assert.equal(evidence.collection.attempts.filter(a => a.status === 'failed').length, 2);
  assert.equal(evidence.collection.units.find(u => u.id === pacingIds[1]).attempt, 2); validateStageResume(evidence, options);
});
async function noUpgrade(judge = stageVerdict) {
  const evidence = await retry(), result = judge(evidence);
  const names = ['host CPU, animating', 'layer install', 'startup', 'decode', 'frame pacing, 60 and 120 Hz'];
  for (const name of names) {
    const bar = result.runs[0].sizes.stage.checks.find(c => c.name === name);
    assert.equal(bar.verdict, 'not-measured', name); if (!name.startsWith('frame pacing')) assert.equal(bar.value, null, name);
  }
  assert.notEqual(result.behavior.find(c => c.name === 'H5 stage capture').verdict, 'pass');
}
test('CHV2T an unqualified retry cannot promote a dependent bar to pass', () => noUpgrade());
test('CHV2T no-upgrade assertion rejects the judge that forgets failed history', async t => {
  const module = await broken(t, 'stage-cost.mjs', s => s.replace("(historyError || !ownWindowQuiet(unit))", "false"));
  await assert.rejects(noUpgrade(module.stageVerdict));
});
const globalStops = ['owner-away marker gone', 'sleight-hold present', 'live-lock identity lost', 'load observations lost',
  'global deadline', 'SIGINT', 'SIGTERM'];
async function stops(message, collector = collectStageEvidence) {
  const h = harness({ globalStop: { id: phaseId, message }, failures: { [phaseId]: 'visibility' } });
  await assert.rejects(h.run(collector), new RegExp(message));
  assert.equal(h.calls.at(-1), phaseId); assert.equal(h.closed, 1);
  assert.equal(h.snapshots.at(-1).collection.units.some(unit => unit.status === 'failed'), false);
  assert.equal(h.snapshots.at(-1).error, message);
}
for (const message of globalStops) {
  test(`CHV2T ${message} stops collection even alongside a local error`, () => stops(message));
  test(`CHV2T ${message} rejects the ignored-run-check variant`, async t => {
    await assert.rejects(stops(message, await brokenCollector(t, s => s.replaceAll('deps.checkRun?.();', '/* ignored run check */'))));
  });
}
test('CHV2T flagged global stops and unproved unit cleanup remain run stops', async () => {
  const unknown = harness({ stop: phaseId }); await assert.rejects(unknown.run(), /offline global stop/);
  const cleanup = harness({ failures: { [phaseId]: 'visibility' }, cleanupError: true });
  await assert.rejects(cleanup.run(), /unit cleanup unproved/); assert.equal(cleanup.calls.at(-1), phaseId);
});
async function environment(factory = stageEnvironmentCheck) {
  let present = true, current = { dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false };
  const check = factory({ ownerAwayFile: 'offline-marker', lockIdentity: current, ownerAway: () => present, readLock: () => current });
  check(); present = false; assert.throws(check, /owner-away marker/); present = true;
  current = { ...current, ino: 3 }; assert.throws(check, /live-lock identity/);
}
test('CHV2T marker loss and lock replacement are detected by the live environment check', () => environment());
test('CHV2T environment assertion rejects a guard that never checks identity', async t => {
  const module = await broken(t, 'stage-live.mjs', s => s.replace('if (!ownerAwayFile || !ownerAway())', 'if (false)').replace('current.ino !== lockIdentity.ino', 'false'));
  await assert.rejects(environment(module.stageEnvironmentCheck));
});
test('CHV2T --retry-failed requires --resume and marker paths parse without live activity', () => {
  assert.throws(() => parseArgs(['--owner-away', '--out', 'bank', '--retry-failed']), /requires --resume/);
  const opts = parseArgs(['--owner-away', '--out', 'bank', '--resume', '--retry-failed', '--owner-away-file', 'marker']);
  assert.equal(opts.retryFailed, true); assert.equal(opts.ownerAwayFile, 'marker');
});
test('CHV2T a global watchdog aborts and collects without launching any process', async () => {
  const guard = stageRunGuard({ timeoutMs: 1 });
  await new Promise(resolve => guard.signal.addEventListener('abort', resolve, { once: true }));
  assert.match(guard.signal.reason.message, /global watchdog/); await guard.close();
});
test('CHV2T recorder early exit is a local child failure with the captured rows', async () => {
  const row = { partial: true }, visibility = { shown: true, panelID: 44, panelGenerations: 1, hideReasonCounts: {} };
  await assert.rejects(recordPacingMotion({ rows: [], request: async () => visibility }, { rows: [row], wait: async () => {
    throw stageUnitFailure('child', 'child closed SIGKILL');
  } }, { source: 'character', ...visibility }), error => {
    assert.equal(error.unitFailureKind, 'child'); assert.deepEqual(error.pacingEvidence.recorderRows, [row]); return true;
  });
});

async function resetBudget(collector = collectStageEvidence) {
  const h = harness({ failures: Object.fromEntries(order.slice(1, 6)
    .filter((_, i) => i !== 2).map(id => [id, 'pacing-recorder'])) });
  await h.run(collector); assert.equal(h.calls.length, order.length);
}
test('CHV2T success resets the budget, rejecting a lifetime failure counter', async t => {
  await resetBudget();
  const collector = await brokenCollector(t, s => s.replace("if (!id.includes('/pacing/') || streak.group !== stageFailureGroup(id)) streak = { kind: null, count: 0 }; segment.failureStreak = streak;", '/* broken: retain failures across successes */'));
  await assert.rejects(resetBudget(collector));
});
async function repeatedRetry(collector = collectStageEvidence) {
  const config = { failures: { [pacingIds[1]]: 'pacing-recorder' } };
  const first = harness(config), partial = await first.run(collector);
  const second = harness(config), evidence = await second.run(collector, { resumeEvidence: partial, retryFailed: true });
  assert.deepEqual(second.calls, pacingIds); assert.equal(evidence.collection.attempts.filter(a => a.status === 'failed').length, 2);
  assert.equal(evidence.collection.units.find(u => u.id === pacingIds[1]).attempt, 2);
}
test('CHV2T repeated retry rejects dropping attempt history', async t => {
  const collector = await brokenCollector(t, s => s.replace('progress.attempts.push({ ...failedUnit, evidence: payload });', '/* broken: drop attempt */'));
  await assert.rejects(repeatedRetry(collector));
});
async function cleanupStop(collector = collectStageEvidence) {
  const h = harness({ failures: { [phaseId]: 'visibility' }, cleanupError: true });
  await assert.rejects(h.run(collector), /unit cleanup unproved/);
  assert.equal(h.calls.at(-1), phaseId);
}
test('CHV2T cleanup stop rejects continuing without unit cleanup', async t => {
  await assert.rejects(cleanupStop(await brokenCollector(t, s => s.replace('await deps.cleanupUnit?.(id);', '/* broken: ignore unit ownership */'))));
});
async function behaviorRetry(collector = collectStageEvidence) {
  for (const [before, after] of [[14, 1], [1, 14]]) {
    const first = harness({ failures: { behavior: 'child' }, load: before }), partial = await first.run(collector);
    const next = harness({ load: after }), evidence = await next.run(collector, { resumeEvidence: partial, retryFailed: true });
    assert.deepEqual(next.calls, ['behavior']); assert.equal(evidence.runs[0].loadAverageMax, 14);
    assert.equal(stageVerdict(evidence).runs[0].quiet, false); validateStageResume(evidence, options);
  }
}
test('CHV2T retrying behavior retains its first load window', () => behaviorRetry());
test('CHV2T behavior retry rejects skipping the already-qualified round 1 load fold', async t => {
  await assert.rejects(behaviorRetry(await brokenCollector(t, s => s.replace('!(round === 1 && retriedBehavior) && ', ''))));
});
async function abruptRetry(collector = collectStageEvidence) {
  const first = harness({ failures: { [pacingIds[0]]: 'pacing-recorder' } }), partial = await first.run(collector);
  const second = harness({ stop: pacingIds[0] });
  await assert.rejects(second.run(collector, { resumeEvidence: partial, retryFailed: true }), /offline global stop/);
  // A lost final load sample during a retry discards the entire round, including its old qualification.
  const abrupt = second.snapshots.findLast(e => e.collection.inProgress?.id === pacingIds[0]);
  abrupt.collection.segments.at(-1).rounds[1].endedAt = null; sealStageEvidence(abrupt);
  const last = harness(), evidence = await last.run(collector, { resumeEvidence: abrupt });
  assert.equal(last.calls[0], 'round/1/baseline/quiet/before');
  assert.deepEqual(evidence.runs[1], partial.runs[1]); validateStageResume(evidence, options);
}
test('CHV2T interrupted retry with lost load recollects the whole round', () => abruptRetry());
test('CHV2T retry recollection rejects trusting the old qualification', async t => {
  const module = await broken(t, 'stage-progress.mjs', s => s.replace('const round = evidence.runs.find(run => progress.segments.some',
    'const round = evidence.runs.find(run => !progress.units.some(unit => unit.id === `round/${run.round}/qualification`) && progress.segments.some'));
  // The live collector imports a staged progress module for this one mutation.
  const collector = await brokenCollector(t, s => s.replace("from './stage-progress.mjs'", `from '${variantUrls.get(module)}'`));
  await assert.rejects(abruptRetry(collector));
});

async function baselineRetry(collector = collectStageEvidence) {
  const id = 'round/1/baseline/quiet/before';
  const first = harness({ failures: { [id]: 'child' } }), partial = await first.run(collector);
  const next = harness(), complete = await next.run(collector, { resumeEvidence: partial, retryFailed: true });
  assert.deepEqual(next.calls, [id]);
  assert.deepEqual(complete.runs[0].baselines.quiet[1], partial.runs[0].baselines.quiet[1]);
  validateStageResume(complete, options);
}
test('CHV2T retrying a before baseline keeps the completed after baseline', () => baselineRetry());
async function unknownStop(collector = collectStageEvidence) {
  const h = harness(); h.deps.phase = async () => { throw Error('unclassified programmer error'); };
  await assert.rejects(h.run(collector), /unclassified programmer error/);
  assert.equal(h.snapshots.at(-1).collection.units.some(unit => unit.status === 'failed'), false);
}
test('CHV2T unknown-error stop rejects treating every exception as a local failure', async t => {
  await unknownStop();
  await assert.rejects(unknownStop(await brokenCollector(t, s => s.replace('const kind = stageFailureKind(error);', "const kind = stageFailureKind(error) ?? 'child';"))));
});
async function lostLoad(qualify, trackerFactory) {
  let load = 2;
  const tracker = trackerFactory({ readLoad: () => load, isHeld: () => false }); qualify(tracker);
  load = NaN; assert.throws(() => qualify(tracker), /load observations lost/);
  load = 1; assert.throws(() => qualify(tracker), /load observations lost/);
}
test('CHV2T lost load stops immediately and stays lost until recollection', async t => {
  const live = await import('../bench/hand/stage-live.mjs');
  await lostLoad(live.qualifyStageLoad, live.makeStageLoadTracker);
  const module = await broken(t, 'stage-live.mjs', s => s.replace('if (!Number.isFinite(observed.loadAverageMax))', 'if (false)'));
  await assert.rejects(lostLoad(module.qualifyStageLoad, module.makeStageLoadTracker));
});
async function cliContract(parse) {
  assert.throws(() => parse(['--owner-away', '--out', 'bank', '--retry-failed']), /requires --resume/);
  assert.equal(parse(['--owner-away', '--out', 'bank', '--resume', '--retry-failed']).retryFailed, true);
}
test('CHV2T retry CLI contract rejects an unguarded --retry-failed', async t => {
  const module = await broken(t, 'stage-cost.mjs', s => s.replace('if (opts.retryFailed && !opts.resume)', 'if (false)'));
  await assert.rejects(cliContract(module.parseArgs));
});
async function watchdog(factory) {
  const guard = factory({ timeoutMs: 1 });
  try { await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(guard.signal.aborted, true); }
  finally { await guard.close(); }
}
test('CHV2T watchdog assertion rejects disabling the global deadline', async t => {
  await watchdog(stageRunGuard);
  const module = await broken(t, 'stage-live.mjs', s => s.replace("setTimeout(() => controller.abort(Error('stage run exceeded global watchdog')), timeoutMs)", 'setTimeout(() => {}, timeoutMs)'));
  await assert.rejects(watchdog(module.stageRunGuard));
});
async function earlyExit(record = recordPacingMotion) {
  const row = { partial: true };
  const visibility = { shown: true, panelID: 44, panelGenerations: 1, hideReasonCounts: {} };
  await assert.rejects(record({ rows: [], request: async () => visibility }, { rows: [row], wait: async () => {
    throw stageUnitFailure('child', 'child closed SIGKILL');
  } }, { source: 'character', ...visibility }), error => {
    assert.equal(error.unitFailureKind, 'child'); assert.deepEqual(error.pacingEvidence.recorderRows, [row]); return true;
  });
}
test('CHV2T early-exit evidence rejects losing the recorder rows', async t => {
  const module = await broken(t, 'stage-live.mjs', s => s.replace('recorderRows: recorder.rows,', 'recorderRows: [],'));
  await assert.rejects(earlyExit(module.recordPacingMotion));
});
async function differentKind(collector = collectStageEvidence) {
  const h = harness({ failures: Object.fromEntries(order.slice(1, 6)
    .map((id, i) => [id, i === 2 ? 'child' : 'pacing-recorder'])) });
  await h.run(collector); assert.equal(h.calls.length, order.length);
}
test('CHV2T a different kind resets the budget, rejecting a shared failure counter', async t => {
  await differentKind();
  const collector = await brokenCollector(t, s => s.replace('streak.kind === kind ? Math.min(STAGE_FAILURE_BUDGET, streak.count + 1) : 1', 'streak.count + 1'));
  await assert.rejects(differentKind(collector));
});

async function captureSamples(convert, kind, sample) {
  const h = harness(), report = { seat: 'edge-lie', modes: { hidden: { samples: [{ source: 'engine', handUp: true, result: 'excluded' }] },
    visible: { samples: [sample] } } };
  h.deps.capture = async seat => { h.calls.push(`capture/${seat}`); return seat === 'edge-lie' ? convert(report) : { seat }; };
  const evidence = await h.run();
  const failed = evidence.collection.units.find(unit => unit.id === 'capture/edge-lie');
  assert.equal(failed.status, 'failed'); assert.equal(failed.kind, kind); assert.deepEqual(evidence.collection.attempts.find(a => a.id === failed.id).evidence, report);
  assert.equal(h.calls.at(-1), 'capture/front-sit');
  assert.notEqual(stageVerdict(evidence).behavior.find(c => c.name === 'H5 stage capture').verdict, 'pass');
}
for (const [kind, sample] of [['capture', { source: 'engine', error: 'no screenshot', result: 'error', handUp: true }],
  ['visibility', { source: 'composite', result: 'excluded', handUp: false }],
  ['capture', { source: 'region', result: 'skipped', reason: 'covered', handUp: false }]]) {
  test(`CHV2T H5 ${sample.result} samples fail the seat with partial evidence`, async t => {
    const live = await import('../bench/hand/stage-live.mjs'); await captureSamples(live.stageCaptureResult, kind, sample);
    const module = await broken(t, 'stage-live.mjs', s => s.replace('export function stageCaptureResult(report) {', 'export function stageCaptureResult(report) { return report;'));
    await assert.rejects(captureSamples(module.stageCaptureResult, kind, sample));
  });
}
async function budgetAcrossResume(collector = collectStageEvidence) {
  const ids = order.slice(1, 5), failures = Object.fromEntries(ids.map(id => [id, 'pacing-recorder']));
  const first = harness({ failures, stop: ids[3] }); await assert.rejects(first.run(collector), /offline global stop/);
  const next = harness({ failures });
  await assert.rejects(next.run(collector, { resumeEvidence: first.snapshots.at(-1) }), /failure budget reached/);
  assert.deepEqual(next.calls, [order[4]]);
}
test('CHV2T a resume cannot reset three preceding failures and evade the budget', async t => {
  await budgetAcrossResume();
  const collector = await brokenCollector(t, s => s.replace('streak = progress.segments.at(-1)?.failureStreak ?? streak;', '/* broken: reset streak on resume */'));
  await assert.rejects(budgetAcrossResume(collector));
});
async function quietRetryStop(collector = collectStageEvidence) {
  for (const id of pacingIds) {
    const first = harness({ failures: { [id]: 'pacing-recorder' } }), partial = await first.run(collector);
    const second = harness({ stop: id });
    await assert.rejects(second.run(collector, { resumeEvidence: partial, retryFailed: true }), /offline global stop/);
    const stopped = second.snapshots.at(-1); validateStageResume(stopped, options);
    const last = harness(), evidence = await last.run(collector, { resumeEvidence: stopped, retryFailed: true });
    assert.deepEqual(last.calls, pacingIds); validateStageResume(evidence, options);
    for (const other of pacingIds.filter(other => other !== id))
      assert.equal(stageUnitDigest(evidence, other), stageUnitDigest(partial, other));
  }
}
test('CHV2T a second quiet stop during retry recollects the complete trial', () => quietRetryStop());

async function closeAfterSpawnError(makeChild) {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.stdin.write = () => true;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const owned = makeChild('offline-missing', [], {}, { spawnChild: () => child });
  child.emit('error', Error('offline spawn error'));
  await assert.rejects(owned.wait(() => false), /offline spawn error/);
  let collected = false;
  const closing = owned.close().then(result => { collected = true; return result; });
  try {
    await Promise.resolve(); await Promise.resolve();
    assert.equal(collected, false, 'spawn error is not proof of close');
  } finally { child.emit('close', 1, null); await closing; }
  assert.equal(collected, true);
}
test('CHV2T a spawn error waits for close before unit cleanup can continue', async t => {
  const live = await import('../bench/hand/stage-live.mjs'); await closeAfterSpawnError(live.jsonChild);
  const module = await broken(t, 'stage-live.mjs', s => s.replace("launchError = error; ended = stageUnitFailure(failureKind, error.message, { rows, stderr });", "resolve({ error }); launchError = error; ended = stageUnitFailure(failureKind, error.message, { rows, stderr });"));
  await assert.rejects(closeAfterSpawnError(module.jsonChild));
});

async function emptyResumeBudget(collector = collectStageEvidence) {
  const ids = order.slice(1, 5), failures = Object.fromEntries(ids.map(id => [id, 'pacing-recorder']));
  const first = harness({ failures, stop: ids[3] }); await assert.rejects(first.run(collector), /offline global stop/);
  const empty = harness(); empty.deps.roundStart = () => { throw Error('empty resume stop'); };
  await assert.rejects(empty.run(collector, { resumeEvidence: first.snapshots.at(-1) }), /empty resume stop/);
  const next = harness({ failures });
  await assert.rejects(next.run(collector, { resumeEvidence: empty.snapshots.at(-1) }), /failure budget reached/);
  assert.deepEqual(next.calls, [order[4]]);
}
test('CHV2T a resume that stops before collecting inherits the prior failure streak', async t => {
  await emptyResumeBudget();
  const collector = await brokenCollector(t, s => s.replace('rounds: {}, failureStreak: streak', 'rounds: {}'));
  await assert.rejects(emptyResumeBudget(collector));
});
async function attemptNumbers(collector = collectStageEvidence) {
  const id = pacingIds[1], first = harness({ failures: { [id]: 'pacing-recorder' } }), partial = await first.run(collector);
  const interrupted = harness({ stop: id });
  await assert.rejects(interrupted.run(collector, { resumeEvidence: partial, retryFailed: true }), /offline global stop/);
  const last = harness(), evidence = await last.run(collector, { resumeEvidence: interrupted.snapshots.at(-1), retryFailed: true });
  assert.equal(evidence.collection.units.find(unit => unit.id === id).attempt, 3);
  assert.deepEqual(evidence.collection.attempts.filter(attempt => attempt.id === id).map(attempt => attempt.attempt), [1, 2]);
  assert.match(reportMarkdown(stageVerdict(evidence)), /attempt 2/);
}
test('CHV2T an interrupted retry consumes its attempt number', async t => {
  await attemptNumbers();
  const collector = await brokenCollector(t, s => s.replace('stageAttemptNumber(progress, id) + 1', '(previous?.attempt ?? 0) + 1'));
  await assert.rejects(attemptNumbers(collector));
});
