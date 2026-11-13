import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { passingPhase } from './fixtures/stage-cost-evidence.mjs';
import { stageIdentity, sealStageEvidence, stageUnitDigest } from '../bench/hand/stage-progress.mjs';

const variant = process.env.CHV4E_BROKEN_VARIANT;
async function load(file, changes = {}) {
  const url = new URL('../bench/hand/' + file, import.meta.url);
  let source = readFileSync(url, 'utf8');
  if (!changes[variant]) return import(url.href);
  const [before, after] = changes[variant];
  assert.ok(source.includes(before), 'mutation site for ' + variant);
  source = source.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, quote, path) => 'from ' + quote + new URL(path, url).href + quote);
  source = source.replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const meter = await load('stage-measurement.mjs', {
  'host-zero': ['hostCpuS: hostValid ? result.hand.cpuS : null', 'hostCpuS: hostValid ? 0 : null'],
  'first-control': ['(before[key] + after[key]) / 2', 'before[key]'],
  'no-bracket-order': ['before.end <= control.phaseStart', 'true'],
  'omit-after': ['after = await collectControl()', 'after = before'],
  'continue-stop': ['error.runStop || !stageFailureKind(error)', 'false'],
  'lose-control-failure': ['controlFailure: {', 'ignoredControlFailure: {'],
});
const judge = await load('stage-cost.mjs', {
  'whole-host': ["added('hostAvgPct'), budget.hostAvgPct", "metric('hostAvgPct'), budget.hostAvgPct"],
  'median-max': ['values[1]', 'values[2]'],
  'median-incomplete': ['rounds.length === 3 && new Set(rounds.map(r => r.round)).size === 3',
    'rounds.length >= 2 && new Set(rounds.map(r => r.round)).size === rounds.length'],
  'short-watchdog': ['129 + 2 * 61', '129 + 61'],
  'no-host-report': ["'| Size | Surface | Control host CPU %", "'| Size | Surface | Hidden CPU %"],
  'no-failed-report': ['if (result.phaseDiagnostics?.length)', 'if (false)'],
});
const progress = await load('stage-progress.mjs', {
  'mix-layouts': ['actualLayout !== controlLayout', 'false'],
  'mixed-phase': ["if (layout !== actualLayout)", 'if (false)'],
});
const live = await import('../bench/hand/stage-live.mjs');

function control(surface = 'quiet', size = 'stage', { start = 0, ws = 10, host = 1 } = {}) {
  const result = structuredClone(passingPhase(size, surface).control);
  result.start = start; result.end = start + 61000;
  result.samples = result.samples.map((row, i) => ({ ...row, t: start + i * 1000,
    ws: i * ws / 100, hosts: { 42: { cpu: i * host / 100, rssKb: 1024 } } }));
  return result;
}
function bracket(surface = 'quiet', size = 'stage') {
  return { layout: 'bracketed/1', phaseStart: 62000, phaseEnd: 190000,
    before: control(surface, size), after: control(surface, size, { start: 191000, ws: 14, host: 2 }) };
}
function evidence() {
  return { schema: 'sleight.stage-cost/1', machine: { mac: 'offline', macOS: 'offline', maximumHz: 120 },
    runs: [1, 2, 3].map(round => ({ round, loadAverageMax: 1, puddleWindowHeld: false,
      sizes: { stage: { phases: Object.fromEntries(['quiet', 'changing'].map(surface => [surface,
        { ...passingPhase('stage', surface), control: control(surface), hostAvgPct: round === 3 ? 9 : 2 }])) } } })) };
}
const bar = (result, name) => result.runs[0].sizes.stage.checks.find(c => c.name === name);

test('CHV4H reserves the extra control minute for every phase in the global deadline', () => {
  const timing = judge.stageRunTiming();
  assert.equal(timing.estimateMinutes, 112); assert.equal(timing.watchdogMs, 155 * 60000);
});

test('CHV4E accounts for hidden host CPU and rejects missing or reset host counters as unmeasured', () => {
  const c = control(), figures = meter.stageControlFigures(c);
  assert.equal(figures.hostAvgPct, 1); assert.equal(figures.hostCpuS, 0.61);
  for (const mutate of [c => { c.samples[10].hosts = {}; }, c => { c.samples[10].hosts[42].cpu = -1; },
    c => { c.samples[30].hosts[42].cpu = 0; }, c => { c.samples[10].hosts[99] = c.samples[10].hosts[42]; },
    c => { delete c.samples[10].hosts; }]) {
    const bad = structuredClone(c); mutate(bad);
    assert.equal(meter.stageControlFigures(bad).hostAvgPct, null);
  }
});

test('CHV6 reports control, phase and signed difference while the animating bar judges the addition', () => {
  const e = evidence(); e.runs[0].sizes.stage.phases.quiet.hostAvgPct = 2.6;
  const result = judge.stageVerdict(e), report = judge.reportMarkdown(result);
  assert.equal(bar(result, 'host CPU, animating').verdict, 'pass');
  assert.equal(bar(result, 'host CPU, animating').value, 1.6);
  assert.match(report, /\| Size \| Surface \| Control host CPU %/);
  assert.match(report, /\| stage \| quiet \| 1 \| 0.61 \| 2.6 \| 1.6 \|/);
  e.runs[0].sizes.stage.phases.quiet.hostAvgPct = 0.5;
  assert.match(judge.reportMarkdown(judge.stageVerdict(e)), /\| stage \| quiet \| 1 \| 0.61 \| 0.5 \| -0.5 \|/);
});

test('CHV4H subtracts the mean of two matching controls and exposes their spread', () => {
  const e = evidence(), phase = e.runs[0].sizes.stage.phases.quiet;
  phase.control = bracket(); phase.wsAvgPct = 14.9; phase.wsPeakPct = 19.9;
  const figures = meter.stageControlFigures(phase.control);
  assert.equal(figures.wsAvgPct, 12); assert.equal(figures.hostAvgPct, 1.5);
  assert.deepEqual(figures.spread, { wsAvgPct: 4, wsPeakPct: 4, hostAvgPct: 1 });
  assert.equal(bar(judge.stageVerdict(e), 'WindowServer added, average').verdict, 'pass');
  assert.match(judge.reportMarkdown(judge.stageVerdict(e)), /before 10%; after 14%; mean 12%; spread 4 pp/);
  for (const mutate of [c => { delete c.after; }, c => { c.after.size = 'small'; },
    c => { c.after.surface = 'changing'; }, c => { c.after.scriptDigest = 'f'.repeat(64); },
    c => { c.after.samples[5].status.shown = true; }, c => { c.phaseStart = 60000; },
    c => { c.phaseEnd = c.after.start + 1; }, c => { c.layout = 'unknown'; }]) {
    const bad = structuredClone(e); mutate(bad.runs[0].sizes.stage.phases.quiet.control);
    assert.equal(meter.stageControlFigures(bad.runs[0].sizes.stage.phases.quiet.control), null);
    assert.notEqual(bar(judge.stageVerdict(bad), 'WindowServer added, average').verdict, 'pass');
  }
});

test('CHV4H collects before, phase, after in order and retains a failed phase with its pair', async () => {
  for (const failed of [false, true]) {
    const events = []; let count = 0;
    const phase = { figures: { ...passingPhase('stage', 'quiet') }, marks: { start: 62000, idleEnd: 190000 } };
    const collect = () => meter.collectBracketedPhase({ collectControl: async () => {
      events.push('control'); return bracket()[++count === 1 ? 'before' : 'after'];
    }, collectPhase: async () => { events.push('phase'); if (failed) throw Object.assign(Error('visibility'),
      { unitFailureKind: 'visibility', unitEvidence: phase }); return phase; } });
    if (failed) await assert.rejects(collect(), error => {
      assert.equal(error.unitEvidence.figures.control.after.start, 191000); return true;
    });
    else assert.equal((await collect()).figures.control.layout, 'bracketed/1');
    assert.deepEqual(events, ['control', 'phase', 'control']);
  }
});

test('CHV4H global and unknown phase errors stop before another control', async () => {
  for (const error of [Object.assign(Error('owner returned'), { runStop: true }), TypeError('programmer error')]) {
    let controls = 0;
    await assert.rejects(meter.collectBracketedPhase({ collectControl: async () => { controls++; return control(); },
      collectPhase: async () => { throw error; } }), e => e === error);
    assert.equal(controls, 1);
  }
});

test('CHV4H an after-control failure keeps both the product failure and raw control evidence', async () => {
  const phaseError = Object.assign(Error('bad visibility'), { unitFailureKind: 'visibility',
    unitEvidence: { figures: passingPhase('stage', 'quiet'), marks: { start: 62000, idleEnd: 190000 } } });
  let calls = 0;
  await assert.rejects(meter.collectBracketedPhase({ collectControl: async () => {
    if (++calls === 1) return control();
    throw Object.assign(Error('control stopped'), { unitFailureKind: 'fixture-seat', unitEvidence: { rows: ['raw control'] } });
  }, collectPhase: async () => { throw phaseError; } }), error => {
    assert.equal(error.unitFailureKind, 'visibility');
    assert.deepEqual(error.unitEvidence.controlFailure.evidence.rows, ['raw control']);
    assert.equal(error.unitEvidence.control.before.pid, 42);
    return true;
  });
});

test('CHV4H companion median needs three distinct quiet measured rounds and never replaces current verdict', () => {
  const e = evidence(), plain = judge.stageVerdict(e);
  assert.equal(plain.medianOfThree, undefined);
  const result = judge.stageVerdict(e, judge.STAGE_BUDGET, { medianOfThree: true });
  assert.deepEqual(result.runs, plain.runs); assert.equal(result.verdict, plain.verdict);
  const cpu = r => r.medianOfThree.sizes.stage.checks.find(c => c.name === 'host CPU, animating');
  assert.equal(cpu(result).value, 1); assert.equal(cpu(result).verdict, 'pass');
  assert.deepEqual(cpu(result).roundValues, [1, 1, 8]);
  assert.match(judge.reportMarkdown(result), /Experimental median of three rounds/);
  assert.equal(judge.parseArgs(['--evidence', 'bank.json', '--median-of-three']).medianOfThree, true);
  for (const mutate of [e => { e.runs.pop(); }, e => { e.runs[2].round = 2; },
    e => { e.runs[1].loadAverageMax = 10; }, e => { delete e.runs[1].sizes.stage.phases.quiet; }]) {
    const bad = structuredClone(e); mutate(bad);
    assert.equal(cpu(judge.stageVerdict(bad, judge.STAGE_BUDGET, { medianOfThree: true })).verdict, 'not-measured');
  }
});

test('CHV4H legacy resume stays compatible but a runner refuses a different layout before collecting', async () => {
  const machine = { mac: 'offline', macOS: 'offline', machineId: 'offline', maximumHz: 120 };
  const identity = stageIdentity('a'.repeat(40), { sha256: 'b'.repeat(64) }, machine);
  let saved, calls = 0;
  const deps = { machine: async () => machine, behavior: async () => ({ placements: [{ seed: 1 }] }),
    observeQualification: () => ({ loadAverageMax: 1, puddleWindowHeld: false }),
    baseline: async () => { throw Error('offline stop'); }, close: async () => {},
    checkpoint: async e => { saved = structuredClone(e); } };
  await assert.rejects(live.collectStageEvidence(deps, { identity, sizes: ['stage'] }), /offline stop/);
  delete saved.collection.controlLayout; sealStageEvidence(saved);
  assert.doesNotThrow(() => progress.validateStageResume(saved, { identity, sizes: ['stage'] }));
  assert.throws(() => progress.validateStageResume(saved, { identity, sizes: ['stage'], controlLayout: 'bracketed/1' }), /control layout/);
  await assert.rejects(live.collectStageEvidence({ ...deps, behavior: async () => { calls++; } },
    { identity, sizes: ['stage'], resumeEvidence: saved, controlLayout: 'bracketed/1' }), /control layout/);
  assert.equal(calls, 0);
});

test('CHV4H completed paired phases survive resume and mixed layouts refuse even after digest renewal', async () => {
  const machine = { mac: 'offline', macOS: 'offline', machineId: 'offline', maximumHz: 120 };
  const identity = stageIdentity('a'.repeat(40), { sha256: 'b'.repeat(64) }, machine), sizes = ['stage'];
  let saved, phases = 0, stop = true;
  const deps = { machine: async () => machine, behavior: async () => ({ placements: [{ seed: 1 }] }),
    baseline: async () => { if (stop && phases === 1) throw Error('offline stop'); return {}; },
    phase: async (size, surface) => { phases++; return { figures: { ...passingPhase(size, surface), control: bracket(surface, size) } }; },
    pacing: async (size, requestedHz, durationMs, meta) => ({ requestedHz, durationMs, ...meta }),
    qualification: async () => ({ loadAverageMax: 1, puddleWindowHeld: false }),
    observeQualification: () => ({ loadAverageMax: 1, puddleWindowHeld: false }), capture: async seat => ({ seat }),
    close: async () => {}, checkpoint: async e => { saved = structuredClone(e); } };
  const options = { identity, sizes, controlLayout: 'bracketed/1' };
  await assert.rejects(live.collectStageEvidence(deps, options), /offline stop/);
  const partial = structuredClone(saved), original = structuredClone(saved.runs[0].sizes.stage.phases.quiet);
  const bad = structuredClone(saved); bad.runs[0].sizes.stage.phases.quiet.control = control();
  for (const unit of bad.collection.units) unit.dataDigest = stageUnitDigest(bad, unit.id);
  sealStageEvidence(bad);
  assert.throws(() => progress.validateStageResume(bad, options), /mixed control layouts/);
  phases = 0; stop = false;
  const final = await live.collectStageEvidence(deps, { ...options, resumeEvidence: partial });
  assert.equal(phases, 5); assert.deepEqual(final.runs[0].sizes.stage.phases.quiet, original);
  progress.validateStageResume(final, options);
});

test('CHV4E failed phase diagnostics stay out of canonical checks and retain CPU columns', () => {
  const e = evidence(), phase = e.runs[0].sizes.stage.phases.quiet;
  phase.hostAvgPct = 2.6;
  delete e.runs[0].sizes.stage.phases.quiet;
  e.collection = { units: [], attempts: [{ id: 'round/1/phase/stage/quiet', kind: 'visibility', attempt: 1,
    error: 'fixture visibility', evidence: { figures: phase } }] };
  const result = judge.stageVerdict(e), report = judge.reportMarkdown(result);
  assert.equal(bar(result, 'host CPU, animating').verdict, 'not-measured');
  assert.match(report, /Failed and discarded phase diagnostics/);
  assert.match(report, /\| stage \| quiet \| 1 \| 0.61 \| 2.6 \| 1.6 \|/);
});
