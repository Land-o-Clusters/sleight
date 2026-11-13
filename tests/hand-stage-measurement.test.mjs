import { stageSurfaceObservation } from '../bench/hand/stage-surface.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { createCostSampler as defaultCostSampler } from '../bench/hand/cost-sampler.mjs';
import { stageSequence } from '../bench/hand/stage-cost.mjs';
import { cursorWire } from '../bench/hand/cursor-sequence.mjs';
import { stageIdentity, sealStageEvidence, validateStageResume } from '../bench/hand/stage-progress.mjs';
import { stageSurfaceFixture, stageSurfaceChecksFixture, recordedActions, stageScriptFixture } from './fixtures/stage-surface.mjs';

// Each mutation is run separately by the lane to show that the corresponding regression fails.
const variant = process.env.CHV2U_BROKEN_VARIANT;
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
const live = await load('stage-live.mjs', {
  'cover-behind': ['windows.indexOf(w) < index', 'true'],
  'ignore-cover': ['valid: index >= 0 && interfering.length === 0', 'valid: index >= 0'],
  'wrong-root': ['root: character.root });', "root: 'wrong-root' });"],
  'drop-owner-marker': ["['--owner-away-file', ownerAwayFile]", '[]'],
});
const meter = await load('stage-measurement.mjs', {
  'poll-parked': ["session.request({ bench: 'tree' })", "session.request({ bench: 'status' })"],
  'ignore-hidden-control': ["s.status?.characterHiddenControl === true && s.status.shown === false", 'true'],
  'wrong-rss': ['peakMiB - fixtureMiB', 'peakMiB'],
  'ignore-parked-visibility': ['if (!stable) throw', 'if (false) throw'],
});
const judge = await load('stage-cost.mjs', {
  'ignore-control-surface': ['phase.control.surface !== surface', 'false'],
  'ignore-control-size': ['phase.control.size !== requestedSize', 'false'],
  'ignore-control-changing': ['phase.control.changing !== phase.changing', 'false'],
  'old-baseline': ['return phase[key] - control[key]', 'return phase[key] - mean(base.map(b => b[key]))'],
  'ignore-script': ['phase.control.scriptDigest !== phase.scriptDigest', 'false'],
  'ignore-parked-reset': ['s.hosts[hostPid].cpu >= inside[i - 1].hosts?.[hostPid]?.cpu', 'true'],
  'accept-late-install': ['t.transactionSubmittedHostMs < r.scheduledStartHostMs', 'true'],
});
const createCostSampler = variant === 'keep-parked-timer' ? (await load('cost-sampler.mjs', {
  'keep-parked-timer': ['pause() { clearInterval(timer); return chain; }', 'pause() { return chain; }'],
})).createCostSampler : defaultCostSampler;

const windows = [{ pid: 42, id: 7, bounds: { x: 30, y: 592, width: 666, height: 350 } },
  { pid: 42, id: 8, bounds: { x: 816, y: 592, width: 666, height: 350 } }];
const sequence = stageSequence(windows);
const digest = meter.stageScriptDigest(recordedActions(windows), windows);
const control = () => ({ pid: 42, start: 0, end: 61000, ...stageScriptFixture('quiet', 'stage'),
  samples: Array.from({ length: 62 }, (_, i) => ({ t: i * 1000, ws: i * 0.3, hosts: {},
    status: { pid: 42, shown: false, characterHiddenControl: true } })) });

test('CHV2U item 5 observes possible floating and normal window orders', () => {
  const panel = { x: 1013, y: 406, width: 192, height: 208 };
  const owned = { pid: 42, id: 77, bounds: panel, alpha: 1, layer: 3 };
  const foreign = [0, 1, 2].map(id => ({ id: 100 + id, pid: 99, layer: 0, alpha: 1, bounds: panel }));
  const observe = windows => stageSurfaceObservation({ panel, pid: 42, panelID: 77 },
    { windows, observedAtMs: 100 }, { surface: 'quiet', startedAtMs: 99, completedAtMs: 101 });
  const behind = observe([owned, ...foreign]);
  assert.equal(behind.valid, true); assert.deepEqual(behind.overlapping, foreign);
  for (const layer of [3, 4]) {
    const cover = { ...foreign[0], layer };
    assert.equal(observe([cover, owned, ...foreign.slice(1)]).valid, false);
  }
  const normal = { ...owned, layer: 0 };
  assert.equal(observe([foreign[0], normal]).valid, false);
  assert.equal(observe(foreign).valid, false);
});

test('CHV2U item 2 verifies a small replay using the character root and keeps mismatches', async t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'stage-small-replay-')));
  const trace = { schema: 'sleight.stage-trace/1', complete: true, records: [{ order: 0,
    input: { op: 'observe', now: 0 }, output: { shown: true, turnTargets: 1, draw: { rung: 'small' } } }] };
  const receipt = { frame: { hand: 'character', size: 'small' }, trace, scenario: 'small-target-turn-lifecycle' };
  for (const broken of [false, true]) {
    const result = await live.verifyCharacterStageReceipt('offline-host', { root }, receipt, { spawnChild(binary, args, options) {
      assert.equal(binary, 'offline-host'); assert.deepEqual(args, ['--stage-dump']);
      assert.equal(options.env.SLEIGHT_CURSOR_CHARACTERS_ROOT, root);
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on('finish', () => queueMicrotask(() => {
        const replayed = structuredClone(trace); if (broken) replayed.records[0].output.shown = false;
        child.stdout.write(JSON.stringify({ effect: 'stage-trace', ...replayed }) + '\n');
        child.stdout.write('{"effect":"end"}\n'); child.emit('close', 0, null);
      }));
      return child;
    } });
    assert.equal(result.exactReplay.reproduced, !broken, result.refusal);
  }
});

test('CHV2U item 8 subtracts matching hidden-script control for each size and surface', () => {
  const c = control(); assert.deepEqual(meter.stageControlFigures(c), { activeS: 61, wsAvgPct: 30, wsPeakPct: 30, wsRunnerUpPct: 30,
    hostAvgPct: null, hostCpuS: null });
  const evidence = { runs: [{ round: 1, baselines: {},
    sizes: Object.fromEntries(['small', 'medium', 'stage'].map(size => [size, { phases:
      Object.fromEntries(['quiet', 'changing'].map(surface => [surface, { ...stageScriptFixture(surface, size),
        control: { ...control(), ...stageScriptFixture(surface, size), surfaceChecks: stageSurfaceChecksFixture(surface, false) },
        surfaceChecks: stageSurfaceChecksFixture(surface), activeS: 61, idleS: 61, hosts: 1, hostAliveThroughout: true,
        hostAvgPct: 2, idleHostCpuS: 0, wsAvgPct: 32.99, wsPeakPct: 37.99 }])) }])) }] };
  const checks = e => judge.stageVerdict(e).runs[0].sizes.stage.checks.filter(c => /WindowServer/.test(c.name));
  assert.ok(checks(evidence).every(c => c.verdict === 'pass'));
  assert.deepEqual(checks(evidence).map(c => c.limit), [3, 8]);
  for (const mutate of [p => { p.control = undefined; }, p => { p.scriptDigest = 'b'.repeat(64); },
    p => { p.wsAvgPct = 33.01; }, p => { p.wsPeakPct = 38.01; },
    p => { p.control.samples[10].status.shown = true; }, p => { p.control.samples.splice(10, 2); },
    p => { p.control.samples[12].ws = 0; }, p => { p.control.surface = 'quiet'; },
    p => { p.control.size = 'small'; }, p => { p.control.changing = false; },
    p => { p.actions[1].frame.at[0]++; }, p => { p.control.actions[1].frame.at[0]++; }]) {
    const bad = structuredClone(evidence); mutate(bad.runs[0].sizes.stage.phases.changing);
    assert.ok(checks(bad).some(c => c.verdict !== 'pass'));
  }
  const report = judge.reportMarkdown(judge.stageVerdict(evidence));
  assert.match(report, /hidden-character scripted control: 30% WindowServer average; 30% busiest second/);
});

test('CHV2U item 8 control rejects shown or unproved hidden content and script changes', () => {
  for (const mutate of [c => { c.samples[10].status.shown = true; }, c => { delete c.samples[10].status.characterHiddenControl; },
    c => { c.samples[10].status.pid++; }, c => { c.end = 59000; }, c => { c.samples[5].ws = -1; }]) {
    const c = control(); mutate(c); assert.equal(meter.stageControlFigures(c), null);
  }
  const other = windows.map(w => ({ ...w, pid: 99, id: w.id + 100 }));
  assert.equal(meter.stageScriptDigest(recordedActions(other), other), digest, 'process identities do not change the script');
  assert.notEqual(meter.stageScriptDigest(recordedActions(windows, true), windows), digest);
});

test('CHV2U item 8 hidden control plays every original frame at its original scripted time', async () => {
  let clock = 0, stopped = 0, nextSample = 1000, paused = false;
  const sent = [], samples = [];
  const sample = t => samples.push({ t, ws: t * 0.0003, hosts: {}, status: { pid: 42, shown: false, characterHiddenControl: true } });
  const session = { pid: 42, ready: { windows }, wire: cursorWire(), write: line => sent.push(JSON.parse(line)),
    sampler: { samples, sample: async () => sample(clock), pause: async () => { paused = true; }, stop: async () => { stopped++; sample(clock); } } };
  const control = await meter.collectHiddenControl({ session, sequence, surface: 'quiet', size: 'stage', now: () => clock, wait: async ms => {
    const end = clock + ms;
    while (!paused && nextSample <= end) { sample(nextSample); nextSample += 1000; }
    clock = end;
  } });
  assert.equal(stopped, 1); assert.equal(sent.length, sequence.steps.length);
  assert.deepEqual(control.actions.map(a => a.scheduledMs), sequence.steps.map(a => a.atMs));
  assert.deepEqual(control.actions.map(a => a.dispatchedMs), sequence.steps.map(a => a.atMs));
  assert.equal(control.scriptDigest, digest); assert.equal(control.end - control.start, 61002);
  assert.ok(meter.stageControlFigures(control));
});

const tree = (cpu, more = {}) => ({ cpuS: cpu, selfCpuS: cpu, childrenCpuS: 0, rssKb: 100 * 1024,
  packageWakeups: 1, interruptWakeups: 1, childrenPackageWakeups: 0, childrenInterruptWakeups: 0,
  querySpawns: 0, liveChildren: 0, startID: 'fixture-start', ...more });
test('CHV2U items 8 and 10 fixture protocol samples RSS before loading and controls never load the character', async () => {
  for (const control of [false, true]) {
    let loaded = false, hiddenControl = false;
    const child = new EventEmitter(); child.pid = 42;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('data', line => {
      const row = JSON.parse(String(line));
      if (row.hand === 'character') { loaded = true; child.stdout.write('{"characterReady":true}\n'); }
      if (row.bench === 'control') hiddenControl = true;
      if (row.bench) child.stdout.write(JSON.stringify({ reply: row.bench, pid: 42, shown: false,
        characterHiddenControl: hiddenControl, processTree: tree(1, { rssKb: (loaded ? 150 : 92) * 1024 }) }) + '\n');
    });
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
    const marker = join(tmpdir(), 'offline-owner-away');
    const session = await live.startFixture('offline-host', { root: tmpdir(), frame: { hand: 'character' } }, 'small', (binary, args) => {
      assert.deepEqual(args, ['--stage-bench', '--hand', '--owner-away-file', marker]);
      queueMicrotask(() => child.stdout.write(JSON.stringify({ ready: true, machine: { hostNice: 0 }, windows }) + '\n'));
      return child;
    }, true, control, { ownerAwayFile: marker, samplerFactory: options => createCostSampler({ ...options,
      ps: async () => `42 1 0:01.00 ${(loaded ? 150 : 92) * 1024} /fixture/consent-host --hand` }) });
    try {
      assert.equal(session.fixtureBaseline.hosts[42].rssKb, 92 * 1024);
      assert.equal(session.sampler.samples.at(-1).hosts[42].rssKb, (control ? 92 : 150) * 1024);
      assert.equal(loaded, !control); assert.equal(hiddenControl, control);
    } finally { await session.sampler.stop(); await session.close(); }
  }
});

test('CHV2U item 9 parks for 61 seconds with two ps/tree reads and zero periodic/status requests', async () => {
  let t = 0, psReads = 0, polls = 0;
  const commands = [], waits = [];
  const session = { request: async ({ bench }) => {
    commands.push(bench); return { reply: bench, pid: 42, shown: true, size: 'small', panelID: 77, installCount: 10,
      hideReasonCounts: { call: 1 }, processTree: tree(t ? 1.04 : 1) };
  } };
  session.sampler = createCostSampler({ rootPid: 42, includeChildren: true, intervalMs: 5, now: () => t,
    ps: async () => { psReads++; return '42 1 0:01.00 102400 /fixture/consent-host --hand\n1 0 0:20.00 1024 /System/WindowServer'; },
    observe: async () => { polls++; return session.request({ bench: 'status' }); } });
  await session.sampler.start();
  const initialReads = psReads, initialPolls = polls; commands.length = 0;
  const visibility = [];
  const result = await meter.collectParkedInterval({ session, size: 'small', wait: async ms => {
    waits.push(ms); t += ms; await new Promise(resolve => setTimeout(resolve, 15));
  }, recordVisibility: (status, size, t) => live.recordPhaseVisibility(visibility, status, size, t) });
  assert.deepEqual(waits, [6000, 61000]); assert.equal(psReads - initialReads, 2); assert.equal(polls - initialPolls, 0);
  assert.deepEqual(commands, ['tree', 'tree']); assert.deepEqual(result, { parkedStart: 6000, idleEnd: 67000 });
  assert.equal(visibility.length, 2);
});

test('CHV2U item 8 completed controls survive resume and altered control evidence refuses after resealing', async () => {
  const machine = { mac: 'offline', macOS: 'offline', machineId: 'offline', maximumHz: 120 };
  const identity = stageIdentity('a'.repeat(40), { sha256: 'b'.repeat(64) }, machine), sizes = ['small'];
  let partial;
  function harness(stop = false) {
    let unit, ticking = 0;
    const calls = [];
    return { calls, now: () => new Date(Date.UTC(2026, 0, 1) + ticking++).toISOString(), deps: {
      machine: async () => machine, behavior: async () => ({ placements: [{ seed: 1 }] }),
      baseline: async () => { if (stop && unit === 'round/1/baseline/quiet/after') throw Error('offline stop'); return { activeS: 61 }; },
      phase: async (size, surface) => { calls.push(surface); return { figures: { control: control(), scriptDigest: digest }, dump: {} }; },
      pacing: async (size, requestedHz, durationMs, metadata) => ({ requestedHz, durationMs, ...metadata }),
      capture: async seat => ({ seat }), qualification: async () => ({ loadAverageMax: 2, puddleWindowHeld: false }),
      observeQualification: () => ({ loadAverageMax: 2, puddleWindowHeld: false }), close: async () => {},
      checkpoint: async evidence => { unit = evidence.collection.inProgress?.id; partial = structuredClone(evidence); },
    } };
  }
  const first = harness(true);
  await assert.rejects(live.collectStageEvidence(first.deps, { identity, sizes, now: first.now }), /offline stop/);
  const saved = structuredClone(partial), completed = saved.runs[0].sizes.small.phases.quiet;
  const bad = structuredClone(saved); bad.runs[0].sizes.small.phases.quiet.control.samples[10].ws++;
  sealStageEvidence(bad);
  assert.throws(() => validateStageResume(bad, { identity, sizes }), /unit data disagrees/);
  const next = harness();
  const final = await live.collectStageEvidence(next.deps, { identity, sizes, now: next.now, resumeEvidence: saved });
  assert.deepEqual(final.runs[0].sizes.small.phases.quiet, completed);
  assert.equal(next.calls[0], 'changing'); assert.equal(next.calls.length, 5);
  validateStageResume(final, { identity, sizes });
});

test('CHV2U item 9 endpoint continuity rejects resets, interior polls, lifetime change and a short minute', () => {
  const sample = (t, cpu, endpoint = false) => ({ t, ws: t / 10000, processTreeMeasured: true,
    status: { reply: endpoint ? 'tree' : 'status' }, hosts: { 42: { cpu, rssKb: 102400, tree: tree(cpu) } } });
  const samples = [...Array.from({ length: 62 }, (_, i) => sample(i * 1000, i / 1000)),
    sample(67000, 0.061, true), sample(128000, 0.101, true)];
  const marks = { start: 0, activeEnd: 61000, parkedStart: 67000, idleEnd: 128000 };
  const good = judge.stagePhaseFigures(samples, marks, 42);
  assert.equal(good.hostAliveThroughout, true); assert.equal(good.idleS, 61); assert.equal(good.idleHostCpuS, 0.04);
  assert.equal(good.idleWsPeakPct, null, 'a minute bracket cannot measure the busiest second');
  for (const mutate of [a => { a.at(-1).hosts[42].cpu = 0; }, a => { a.at(-1).hosts[42].tree.startID = 'replacement'; },
    a => { a.splice(-1, 0, sample(100000, 0.07)); }, a => { a[20].hosts = {}; }, a => { a.splice(20, 2); },
    a => { a.at(-1).status.reply = 'status'; }]) {
    const bad = structuredClone(samples); mutate(bad); assert.equal(judge.stagePhaseFigures(bad, marks, 42).hostAliveThroughout, false);
  }
  assert.equal(judge.stagePhaseFigures(samples, { ...marks, parkedStart: 68001 }, 42).hostAliveThroughout, false);
});

test('CHV2U item 9 parked endpoint witnesses reject a blink, reinstall or replaced process', async () => {
  for (const change of [s => { s.panelID++; }, s => { s.installCount++; }, s => { s.hideReasonCounts.call++; },
    s => { s.processTree.startID = 'replacement'; }, s => { s.shown = false; }]) {
    let clock = 0, reads = 0;
    const session = { request: async ({ bench }) => {
      const status = { reply: bench, pid: 42, shown: true, size: 'small', panelID: 77, installCount: 10,
        hideReasonCounts: { call: 1 }, processTree: tree(1) };
      if (reads++) change(status); return status;
    } };
    session.sampler = createCostSampler({ rootPid: 42, includeChildren: true, now: () => clock,
      ps: async () => '42 1 0:01.00 102400 /fixture/consent-host --hand\n1 0 0:20.00 1024 /System/WindowServer' });
    try {
      await assert.rejects(meter.collectParkedInterval({ session, size: 'small', wait: async ms => { clock += ms; },
        recordVisibility: (s, size, t) => live.recordPhaseVisibility([], s, size, t) }), /invalid parked visibility|invalid phase visibility/);
    } finally { await session.sampler.stop({ finalSample: false }); }
  }
});

test('CHV2U item 10 reports fixture increment and both live-child tree peaks without changing RSS bar', () => {
  const row = (rss, liveChildren) => ({ hosts: { 42: { rssKb: rss * 1024, tree: { liveChildren } } } });
  const memory = meter.stageMemoryFigures([row(103, 0), row(148, 0), row(159, 1)], row(92, 0), 42);
  assert.equal(memory.fixtureMiB, 92); assert.equal(memory.treePeakMiB, 159); assert.equal(memory.incrementMiB, 67);
  assert.equal(memory.treePeakWithLiveChildrenMiB, 159); assert.equal(memory.treePeakWithoutLiveChildrenMiB, 148);
  assert.equal(memory.rendererOnlyMeasured, false);
  assert.equal(meter.stageMemoryFigures([row(103, 0)], row(92, 1), 42).incrementMiB, null);
  assert.equal(meter.stageMemoryFigures([row(103, 0)], undefined, 42).fixtureMiB, null);
  assert.equal(judge.STAGE_BUDGET.rssMiB, 160);
  const report = judge.reportMarkdown(judge.stageVerdict({ runs: [{ round: 1, sizes: { small: { phases: { quiet: {
    memory, statusReplyCost: { cpuS: 0.001, wallMs: 0.5 }, parkedObservation: 'two tree endpoints, no polling' } } } } }] }));
  assert.match(report, /fixture 92 MiB; character increment 67 MiB; tree peak 159 MiB; with live children 159 MiB; without live children 148 MiB/);
  assert.match(report, /one status reply: 0\.001 self CPU s; 0\.5 ms wall time/);
});

test('CHV2U item 11 scheduled installation can qualify only on the original interval and content bar', () => {
  const make = source => ({ source, recorderMode: 'hash', ok: true, started: true, requestedHz: 60, maximumHz: 120,
    durationMs: 600, scheduledStartHostMs: 1000,
    frames: Array.from({ length: 36 }, (_, i) => ({ tMs: i * 1000 / 60, hash: String(i) })),
    motionTiming: { source, scheduleMode: 'preinstalled', productionTimersUnchanged: true, scheduledStartHostMs: 1000, installStartHostMs: 500,
      installEndHostMs: 505, transactionSubmittedHostMs: 506, caBeginHostMs: 1000, cadenceInstalled: true, numberedFrames: 36,
      stationary: { animationKeys: [], sublayerCount: 0, siblingCount: 0, parentAnimationKeys: [], opacity: 1 },
      layerState: { animationKeys: ['contents'], sublayerCount: 0, siblingCount: 0, parentAnimationKeys: [], opacity: 1 } } });
  const good = { ...make('character'), calibration: make('numbered') };
  assert.equal(judge.calibratedPacing(good).verdict, 'pass');
  for (const mutate of [r => { delete r.motionTiming.productionTimersUnchanged; }, r => { r.calibration.motionTiming.productionTimersUnchanged = false; },
    r => { r.motionTiming.transactionSubmittedHostMs = 1001; },
    r => { r.calibration.motionTiming.caBeginHostMs = 1028; }, r => { r.frames.splice(0, 4); },
    r => { r.frames[10].hash = r.frames[9].hash; }, r => { r.calibration.frames.splice(0, 4); }]) {
    const bad = structuredClone(good); mutate(bad); assert.notEqual(judge.calibratedPacing(bad).verdict, 'pass');
  }
  assert.equal(judge.STAGE_BUDGET.uniqueFraction, 0.95);
});

test('CHV2U items 1, 9 and 11 native helpers keep error shape, status cost and scheduled track, no windows',
  { skip: process.platform !== 'darwin' }, t => {
    const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'stage-measurement-')));
    const fixture = readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
    const pacing = readFileSync(new URL('../bench/hand/frame-pacing.swift', import.meta.url), 'utf8');
    const slice = (source, a, b) => { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start); return source.slice(start, end); };
    let helpers = slice(pacing, 'func streamStopped(', '// Exclude row padding.') +
      slice(fixture, 'func stageBenchReplyCost(', 'func stageBenchRect(') +
      slice(fixture, 'func stageBenchCadenceTrack(', 'func stageBenchLayerState(') +
      slice(fixture, 'func stageBenchLayerState(', '@discardableResult') +
      slice(fixture, 'enum StageBenchScheduleError:', 'final class StageBench {');
    if (variant === 'drop-error-code') helpers = helpers.replace('"code": value.code,', '');
    if (variant === 'early-badge') helpers = helpers.replace('duration + max(0, (stageBenchScheduledStart ?? now) - now)', 'duration');
    if (variant === 'ignore-production-timers') helpers = helpers.replace('guard before == timers() else', 'guard true else');
    if (variant === 'late-motion') helpers = helpers.replace('track.beginTime + shift', 'track.beginTime');
    if (variant === 'skip-status-reply') helpers = helpers.replace('    reply()\n', '');
    if (variant === 'prefill-control') helpers = helpers.replace('track.fillMode = .forwards', 'track.fillMode = .both');
    const main = join(root, 'main.swift'), binary = join(root, 'measurement');
    writeFileSync(main, `import Foundation\nimport QuartzCore\nimport Darwin\n` + helpers + `
let error = streamStopped(NSError(domain: "SCStreamErrorDomain", code: -3808, userInfo: [NSLocalizedDescriptionKey: "Owned window stopped"]))
var statusCalls = 0
let cost = stageBenchReplyCost { statusCalls += 1; var x = 0.0; for i in 1...20000 { x += sqrt(Double(i)) }; precondition(x > 0) }
let pixels = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
let numbered = stageBenchCadenceTrack([pixels], durationMs: 600, begin: 1.5)
let root = CALayer(), layer = CALayer(), mask = CALayer(), badge = CALayer()
root.addSublayer(layer); root.addSublayer(badge); layer.mask = mask
func install(_ node: CALayer, _ key: String, _ begin: Double) { let a = CABasicAnimation(keyPath: key); a.beginTime = begin; a.duration = 0.6; node.add(a, forKey: key) }
var ticks = [1000.0, 1005, 1007]
let timing = try stageBenchScheduledInstall(1500, clock: { ticks.removeFirst() }, install: {
    install(layer, "position", 1.002); install(layer, "contents", 1.002); install(mask, "bounds", 1.002); install(badge, "position", 1.002); return layer
}, control: { _, begin in ["controlBegin": begin!] })
stageBenchScheduledStart = 1.5
let badgeDelay = stageBenchBadgeDelay(0.6, clock: { 1.0 })
stageBenchScheduledStart = nil
let ordinaryBadgeDelay = stageBenchBadgeDelay(0.6, clock: { 1.0 })
var timerRefusals = 0
for active in [false, true] {
    var timers = ["phase": 2.5, "perchWake": active ? 1.0 : 0.0]
    do { _ = try stageBenchScheduledInstall(1500, clock: { 1000 }, timers: { timers }, install: {
        timers["phase"] = 2.0; return layer
    }, control: { _, _ in [:] }) } catch { timerRefusals += 1 }
}
var rejected = 0
for missing in [false, true] {
    do { _ = try stageBenchScheduledInstall(1500, clock: { 1600 }, install: { missing ? nil : layer }, control: { _, _ in [:] }) } catch { rejected += 1 }
}
let row: [String: Any] = ["badgeDelay": badgeDelay, "ordinaryBadgeDelay": ordinaryBadgeDelay, "timerRefusals": timerRefusals, "error": error, "cost": cost, "timing": timing, "rejected": rejected, "statusCalls": statusCalls, "controlFillMode": numbered.fillMode.rawValue,
    "begins": [layer.animation(forKey: "position")!.beginTime, layer.animation(forKey: "contents")!.beginTime, mask.animation(forKey: "bounds")!.beginTime, badge.animation(forKey: "position")!.beginTime], "windowsCreated": 0, "captures": 0]
let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]); print(String(data: data, encoding: .utf8)!)
`);
    const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), main, '-o', binary],
      { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
    assertChildStatus(build, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assertChildStatus(run, 0, run.stderr);
    const row = JSON.parse(run.stdout);
    assert.deepEqual(row.error, { ok: false, error: 'stream-stopped', code: -3808, description: 'Owned window stopped', domain: 'SCStreamErrorDomain' });
    assert.ok(row.cost.cpuS >= 0 && row.cost.wallMs >= 0); assert.equal(row.cost.replies, 1);
    assert.equal(row.statusCalls, 1);
    assert.equal(row.badgeDelay, 1.1); assert.equal(row.ordinaryBadgeDelay, 0.6);
    assert.equal(row.timerRefusals, 2); assert.equal(row.timing.productionTimersUnchanged, true);
    assert.equal(row.controlFillMode, 'forwards');
    assert.deepEqual(row.begins, [1.5, 1.5, 1.5, 1.5]); assert.equal(row.rejected, 2);
    assert.equal(row.timing.transactionSubmittedHostMs, 1007); assert.equal(row.timing.caBeginHostMs, 1500);
    assert.equal(row.windowsCreated, 0); assert.equal(row.captures, 0);
  });
