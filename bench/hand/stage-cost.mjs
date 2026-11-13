#!/usr/bin/env node
// ST9, ST1 section 5. Dry-run and evidence judging open nothing. Only --owner-away enters the live adapter.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageTraceFigures } from './stage-trace.mjs';
import { autoSequence, stressSequence } from './cursor-sequence.mjs';
import { attributeStageCosts } from './stage-diagnostics.mjs';
import { phaseFigures } from './cursor-cost.mjs';
import { summarize } from './cost-sampler.mjs';
import { stageControlFigures, stageScriptDigest, stageMemoryFigures } from './stage-measurement.mjs';
import { SOURCES } from './pixels.mjs';
import { stageCollectionSummary, stageSummaryLine, stageUnitFailure, stageRetryable, stageHistoryError, stageInterruptionCeilings, STAGE_MAX_INTERRUPTED_ATTEMPTS } from './stage-progress.mjs';
import { stageSurfaceChecksValid, stageRecurringWindows } from './stage-surface.mjs';

export { SOURCES as CAPTURE_SOURCES } from './pixels.mjs';
export const SIZES = Object.freeze(['small', 'medium', 'stage']);
export const SURFACES = Object.freeze(['quiet', 'changing']);
// Owner decision 10. One reversible constant, no change to the product's defaults.
export const STAGE_BUDGET = Object.freeze({ hostAvgPct: 2.5, idleHostCpuS: 0.05, wsAvgPct: 3, wsPeakPct: 8,
  rssMiB: 160, cacheBytes: 24 * 1024 ** 2, installMs: 4, startupMs: 400, decodeMs: 40, panelPaddingPt: 48,
  uniqueFraction: 0.95, activeS: 60, idleS: 60, runs: 3, loadAverage: 10 });
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const list = a => Array.isArray(a) ? a : [];
const nonempty = a => Array.isArray(a) && a.length > 0;
const all = (a, predicate) => nonempty(a) && a.every(predicate);
const max = a => all(a, finite) ? Math.max(...a) : null;
const rounded = n => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
const check = (name, value, limit, pass, measured = value !== null && value !== undefined) =>
  ({ name, value: value ?? null, limit, verdict: !measured ? 'not-measured' : pass ? 'pass' : 'fail' });
const outcome = checks => checks.some(c => c.verdict === 'fail') ? 'fail'
  : checks.some(c => c.verdict === 'not-measured') || !checks.length ? 'not-measured' : 'pass';
const controlRecords = control => control?.layout === 'bracketed/1' ? [control.before, control.after] :
  control?.layout === undefined ? [control] : [];
const rect = r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > 0 && r[3] > 0;
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const overlaps = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const distance = (a, b) => Math.hypot(Math.max(a[0] - b[0] - b[2], b[0] - a[0] - a[2], 0),
  Math.max(a[1] - b[1] - b[3], b[1] - a[1] - a[3], 0));
const encloses = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[0] + a[2] >= b[0] + b[2] && a[1] + a[3] >= b[1] + b[3];

/** Reuses VC7's script and phase sampler. Alternating targets requires between-window moves, not just in-place cells. */
export function stageSequence(windows, { stress = false } = {}) {
  if (!Array.isArray(windows) || windows.length !== 2 || windows[0].id === windows[1].id)
    throw stageUnitFailure('fixture-seat', 'two distinct fixture windows required', { windows });
  const sequences = windows.map(w => (stress ? stressSequence : autoSequence)({ pid: w.pid, windowId: w.id, rect: w.bounds, count: 40, spacingMs: 1500 }));
  const steps = sequences[0].steps.map(step => {
    const i = Math.min(39, Math.floor(step.atMs / 1500));
    return sequences[i % 2].steps.find(s => s.atMs === step.atMs && s.type === step.type);
  });
  return { steps, lengthMs: 60000, scenario: stress ? 'full-window-scroll-stress' : 'small-target-turn-lifecycle',
    scrollRectPt: stress ? windows.map(w => [w.bounds.width, w.bounds.height]) : [60, 30],
    ...(stress ? { expected: sequences[0].expected } : {}) };
}
export function stagePhaseFigures(samples, marks, hostPid) {
  const measured = list(samples).slice(marks.startSample ?? 0), figures = phaseFigures(measured, marks);
  const active = summarize(measured, { from: marks.start, to: marks.activeEnd, peakSamplePeriodMs: 1000 });
  const parked = summarize(measured, { from: marks.parkedStart ?? marks.activeEnd + 6000, to: marks.idleEnd });
  const inside = measured.filter(s => s.t >= marks.start && s.t <= marks.idleEnd);
  const endpoints = inside.filter(s => s.t >= marks.parkedStart);
  const endpointMode = finite(marks.parkedStart);
  const parkedValid = !endpointMode || endpoints.length === 2 && endpoints[0].t === marks.parkedStart && endpoints[1].t === marks.idleEnd &&
    marks.parkedStart >= marks.activeEnd + 6000 && marks.idleEnd - marks.parkedStart >= 60000 &&
    endpoints.every(s => s.processTreeMeasured === true && s.status?.reply === 'tree' && typeof s.hosts?.[hostPid]?.tree?.startID === 'string') &&
    endpoints[0].hosts[hostPid].tree.startID === endpoints[1].hosts[hostPid].tree.startID;
  const continuous = parkedValid && inside.length >= (endpointMode ? 62 : 120) && inside.every((s, i) => s.hosts?.[hostPid] && Object.keys(s.hosts).length === 1 &&
    finite(s.ws) && finite(s.hosts[hostPid].cpu) && finite(s.hosts[hostPid].rssKb) &&
    (!i || s.t > inside[i - 1].t && (s.t - inside[i - 1].t <= 1500 || endpointMode &&
      (s.t === marks.parkedStart && inside[i - 1].t === marks.activeEnd || s.t === marks.idleEnd && inside[i - 1].t === marks.parkedStart)) && s.ws >= inside[i - 1].ws &&
      s.hosts[hostPid].cpu >= inside[i - 1].hosts?.[hostPid]?.cpu));
  return { ...figures, wsPeakPct: active.windowServer?.peakPct ?? null, ...(endpointMode ? { idleS: parked.wallS, idleHostCpuS: parked.hand?.cpuS ?? null,
    parkedObservation: 'two tree endpoints, no polling', processTree: { ...figures.processTree, parked: parked.hand?.processTree ?? null } } : {}),
    idleWsAvgPct: parked.windowServer?.avgPct ?? null,
    idleWsPeakPct: endpointMode ? null : parked.windowServer?.peakPct ?? null, hostAliveThroughout: continuous,
    attribution: attributeStageCosts(samples, hostPid) };
}

/** Reproducible ST4 input worlds. This generates inputs only; the runtime under test must produce the boxes. */
export function placementFixtures({ seed = 1, count = 1000 } = {}) {
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff || !Number.isInteger(count) || count < 1 || count > 10000) throw Error('invalid fuzz seed or count');
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const integer = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  return Array.from({ length: count }, (_, id) => {
    const target = [integer(80, 700), integer(100, 500), integer(300, 1700), integer(200, 800)];
    const aim = [integer(target[0], target[0] + target[2]), integer(target[1], target[1] + target[3])];
    const personIsTarget = random() < 0.25;
    return { id, target, aim, aimRect: random() < 0.5 ? null : [aim[0] - 20, aim[1] - 10, integer(20, 100), integer(10, 60)],
      pointer: [integer(0, 2560), integer(0, 1440)], personIsTarget,
      person: personIsTarget ? [...target] : [integer(0, 1800), integer(0, 900), integer(300, 700), integer(200, 500)],
      above: Array.from({ length: integer(0, 3) }, () => [integer(0, 2000), integer(0, 1000), integer(100, 500), integer(100, 400)]),
      display: [0, 0, 2560, 1440] };
  });
}

/** Frames use presentation timestamps relative to the motion's start, not callback arrival times. A capture incapable
 * of the requested rate is unmeasured, never a quiet pass. Two consecutive equal hashes mid-motion fail even at 95%. */
export function framePacing(record = {}, budget = STAGE_BUDGET) {
  const { requestedHz, maximumHz, durationMs } = record;
  if (requestedHz === 120 && finite(maximumHz) && maximumHz >= 60 && maximumHz < 120) {
    return { verdict: 'skipped', reason: 'display maximum below 120 Hz', requestedHz, maximumHz, achievedHz: null };
  }
  const frames = list(record.frames), expected = requestedHz * durationMs / 1000;
  const validCapture = record.ok !== false && record.changedDimensions !== true && record.overflow !== true && (!('invalidFrames' in record) || record.invalidFrames === 0) &&
    [60, 120].includes(requestedHz) && finite(maximumHz) && maximumHz >= requestedHz &&
    [400, 600].includes(durationMs) && record.started === true && Array.isArray(record.frames) && frames.every((f, i) =>
      finite(f.tMs) && f.tMs < durationMs && typeof f.hash === 'string' && f.hash.length > 0 &&
      (i === 0 || f.tMs > frames[i - 1].tMs));
  const valid = validCapture && frames.length >= 2;
  const achievedHz = valid ? (frames.length - 1) * 1000 / (frames.at(-1).tMs - frames[0].tMs) : null;
  const unique = valid ? new Set(frames.map(f => f.hash)).size : 0;
  const gaps = valid ? frames.slice(1).map((f, i) => f.tMs - frames[i].tMs) : [];
  const coverage = valid && frames[0].tMs <= 1000 / requestedHz && durationMs - frames.at(-1).tMs <= 1.5 * 1000 / requestedHz;
  const repeated = valid ? frames.slice(1).filter((f, i) => f.hash === frames[i].hash).length : 0;
  const delivered = valid && coverage && frames.length >= Math.ceil(expected * budget.uniqueFraction) && achievedHz >= requestedHz * budget.uniqueFraction;
  const hashVerdict = !delivered ? 'not-measured' : unique >= Math.ceil(expected * budget.uniqueFraction) && !repeated &&
    max(gaps) <= 1.5 * 1000 / requestedHz ? 'pass' : 'fail';
  return { requestedHz, maximumHz, durationMs, expected, validCapture, captured: frames.length, unique, uniqueFraction: rounded(unique / expected),
    scheduledStartHostMs: record.scheduledStartHostMs ?? null, motionTiming: record.motionTiming ?? null,
    onsetMs: frames[0]?.tMs ?? null,
    onsetFromCABeginMs: Number.isFinite(frames[0]?.ptsHostMs) && Number.isFinite(record.motionTiming?.caBeginHostMs) ?
      rounded(frames[0].ptsHostMs - record.motionTiming.caBeginHostMs) : null,
    installDelayMs: Number.isFinite(record.motionTiming?.installStartHostMs) && finite(record.scheduledStartHostMs) ?
      rounded(record.motionTiming.installStartHostMs - record.scheduledStartHostMs) : null,
    // Phase is diagnostic only. One number per vsync can duplicate at a boundary even on a capable display.
    cadencePhaseMs: record.motionTiming?.source === 'numbered' ? frames.map(f =>
      Number.isFinite(f.ptsHostMs) && finite(record.motionTiming.caBeginHostMs) ?
        rounded(((f.ptsHostMs - record.motionTiming.caBeginHostMs) % (1000 / requestedHz) + 1000 / requestedHz) % (1000 / requestedHz)) : null) : null,
    callbackDelayMs: frames.map(f => f.arrivalDelayMs ?? null),
    completeFrames: record.completeFrames ?? null, idleFrames: record.idleFrames ?? null, rejectedFrames: record.rejectedFrames ?? null,
    invalidFrames: record.invalidFrames ?? null, changedDimensions: record.changedDimensions ?? null,
    hashMs: list(record.frames).map(f => f.hashMs ?? null), recorderMode: record.recorderMode ?? 'hash',
    achievedHz: rounded(achievedHz), longestGapMs: rounded(max(gaps)), consecutiveDuplicates: repeated,
    verdict: record.recorderMode === 'timestamps' ? 'not-measured' : hashVerdict,
    ...(record.recorderMode === 'timestamps' ? { reason: 'timestamps only cannot prove unique content',
      delivery: timestampDelivery(record, budget) } : {}) };
}

/** Counts delivery without inventing pixel identity. Never adjusts the interval to the first observed frame. */
export function timestampDelivery(record, budget = STAGE_BUDGET) {
  const { requestedHz: hz, durationMs: ms } = record, frames = list(record.frames), expected = hz * ms / 1000;
  const valid = [60, 120].includes(hz) && [400, 600].includes(ms) && record.maximumHz >= hz &&
    record.started === true && record.ok === true && record.overflow === false && record.changedDimensions === false && record.invalidFrames === 0 &&
    frames.length >= 2 && frames.every((f, i) => finite(f.tMs) && f.tMs < ms && (!i || f.tMs > frames[i - 1].tMs));
  const achievedHz = valid ? (frames.length - 1) * 1000 / (frames.at(-1).tMs - frames[0].tMs) : null;
  const covered = valid && frames[0].tMs <= 1000 / hz && ms - frames.at(-1).tMs <= 1.5 * 1000 / hz;
  return { expected, captured: frames.length, onsetMs: frames[0]?.tMs ?? null, achievedHz: rounded(achievedHz),
    verdict: valid ? covered && frames.length >= Math.ceil(expected * budget.uniqueFraction) && achievedHz >= hz * budget.uniqueFraction ? 'pass' : 'fail' : 'not-measured' };
}

/** The whole-motion character result stands separately from whether its recorder control qualified. */
export function calibratedPacing(record, budget = STAGE_BUDGET) {
  const raw = framePacing(record, budget), control = record.calibration;
  if (raw.verdict === 'skipped') return raw;
  const stationary = control?.motionTiming?.stationary, installed = control?.motionTiming?.layerState;
  const bareLayer = state => state?.sublayerCount === 0 && state.siblingCount === 0 && state.opacity === 1 &&
    Array.isArray(state.parentAnimationKeys) && state.parentAnimationKeys.length === 0;
  const sameTrial = control?.source === 'numbered' && control.recorderMode === 'hash' && control.requestedHz === record.requestedHz &&
    control.durationMs === record.durationMs && control.maximumHz === record.maximumHz &&
    control.motionTiming?.source === 'numbered' && control.motionTiming.numberedFrames === record.requestedHz * record.durationMs / 1000 &&
    control.motionTiming.cadenceInstalled === true && bareLayer(stationary) &&
    Array.isArray(stationary.animationKeys) && stationary.animationKeys.length === 0 && bareLayer(installed) &&
    Array.isArray(installed.animationKeys) && installed.animationKeys.length === 1 && installed.animationKeys[0] === 'contents';
  const timingValid = r => {
    const t = r?.motionTiming;
    const schedule = t?.scheduleMode === 'preinstalled' ? t.productionTimersUnchanged === true && t.installStartHostMs < r.scheduledStartHostMs &&
      t.caBeginHostMs === r.scheduledStartHostMs && t.transactionSubmittedHostMs < r.scheduledStartHostMs :
      t?.installStartHostMs >= r?.scheduledStartHostMs && t?.caBeginHostMs >= t?.installStartHostMs;
    return finite(r?.scheduledStartHostMs) && finite(t?.scheduledStartHostMs) && Math.abs(t.scheduledStartHostMs - r.scheduledStartHostMs) <= 1e-6 &&
      finite(t.installStartHostMs) && finite(t.caBeginHostMs) && schedule &&
      finite(t.installEndHostMs) && t.installEndHostMs >= t.installStartHostMs &&
      (t.scheduleMode === 'preinstalled' ? t.installEndHostMs < t.caBeginHostMs : t.installEndHostMs >= t.caBeginHostMs) &&
      finite(t.transactionSubmittedHostMs) && t.transactionSubmittedHostMs >= t.installEndHostMs;
  };
  const calibration = sameTrial ? framePacing(control, budget) : { verdict: 'not-measured', reason: 'missing matching numbered control' };
  const qualified = calibration.verdict === 'pass' && timingValid(control) && timingValid(record) && record.source === 'character' && record.recorderMode === 'hash';
  return { ...raw, rawVerdict: raw.verdict, calibration, qualification: qualified ? 'qualified' : 'unqualified',
    verdict: raw.verdict === 'fail' || qualified && raw.validCapture && raw.verdict !== 'pass' ? 'fail'
      : qualified ? raw.verdict : 'not-measured',
    timestampsOnly: record.timestampsOnly ? framePacing(record.timestampsOnly, budget) : null,
    calibrationTimestampsOnly: control?.timestampsOnly ? framePacing(control.timestampsOnly, budget) : null };
}

function panelFits(p, padding) {
  if (![p?.panel, p?.seat, p?.move].every(rect)) return false;
  const left = Math.min(p.seat[0], p.move[0]), top = Math.min(p.seat[1], p.move[1]);
  const right = Math.max(p.seat[0] + p.seat[2], p.move[0] + p.move[2]), bottom = Math.max(p.seat[1] + p.seat[3], p.move[1] + p.move[3]);
  return p.panel[2] <= right - left + padding && p.panel[3] <= bottom - top + padding &&
    encloses(p.panel, [left, top, right - left, bottom - top]);
}
function drawingPanelFits(p) {
  const d = p?.drawing;
  if (!rect(p?.panel) || ![d?.inkUnion, d?.filterUnion, d?.clip, d?.required].every(rect) ||
      !Number.isSafeInteger(d.positions) || d.positions < 1 || !Number.isSafeInteger(d.geometries) || d.geometries < 1 ||
      typeof d.hasExtras !== 'boolean' || !encloses(d.filterUnion, d.inkUnion)) return false;
  const left = Math.max(d.filterUnion[0], d.clip[0]), top = Math.max(d.filterUnion[1], d.clip[1]);
  const right = Math.min(d.filterUnion[0] + d.filterUnion[2], d.clip[0] + d.clip[2]);
  const bottom = Math.min(d.filterUnion[1] + d.filterUnion[3], d.clip[1] + d.clip[3]);
  const expected = d.hasExtras ? d.clip : [left, top, right - left, bottom - top];
  // No whole-point slack: a physical panel one point short on any side fails.
  return rect(expected) && expected.every((n, i) => Math.abs(n - d.required[i]) < 1e-7) && encloses(p.panel, d.required);
}
function sizeChecks(size = {}, baselines = {}, maximumHz, budget, requestedSize) {
  const phases = SURFACES.map(s => size.phases?.[s]);
  const surfaceValid = SURFACES.every(surface => {
    const phase = size.phases?.[surface];
    return stageSurfaceChecksValid(phase?.surfaceChecks, ['active-start', 'active-end', 'parked-start', 'parked-end'], surface) &&
      all(controlRecords(phase?.control), control => stageSurfaceChecksValid(control?.surfaceChecks, ['active-start', 'active-end'], surface, false));
  });
  const durations = surfaceValid && phases.every(p => p && p.visibilityValid !== false && finite(p.activeS) && p.activeS >= budget.activeS &&
    finite(p.idleS) && p.idleS >= budget.idleS && p.hosts === 1 && p.hostAliveThroughout === true);
  const metric = key => max(phases.map(p => p?.[key]));
  const added = key => {
    const deltas = SURFACES.map(surface => {
      const original = size.phases?.[surface], control = stageControlFigures(original?.control);
      if (!control || !all(controlRecords(original.control), record => {
        const phase = { ...original, control: record };
        return record && !(phase.control.scriptDigest !== phase.scriptDigest || phase.scriptDigest !== stageScriptDigest(phase.actions, phase.windows) ||
          phase.size !== requestedSize || phase.control.size !== requestedSize || phase.surface !== surface || phase.control.surface !== surface ||
          phase.changing !== (surface === 'changing') || phase.control.changing !== phase.changing);
      }) || !finite(control[key]) || !finite(original[key])) return null;
      const phase = original;
      return phase[key] - control[key];
    });
    return deltas.every(Number.isFinite) ? Math.max(...deltas) : null;
  };
  const d = size.dump ?? {}, pacing = [60, 120].flatMap(hz => [600, 400].map(duration => {
    const matches = list(size.pacing).filter(p => p.requestedHz === hz && p.durationMs === duration);
    return matches.length === 1 && matches[0].maximumHz === maximumHz ? calibratedPacing(matches[0], budget) :
      hz === 120 && finite(maximumHz) && maximumHz >= 60 && maximumHz < 120 ?
        framePacing({ requestedHz: hz, maximumHz, durationMs: duration }, budget) : { verdict: 'not-measured', requestedHz: hz, durationMs: duration };
  }));
  const numeric = (name, value, limit, strict = false, extra = true) => check(name, value, limit,
    finite(value) && (strict ? value < limit : value <= limit) && extra, finite(value) && durations);
  const checks = [
    check('surface composition at measured boundaries', surfaceValid, true, surfaceValid),
    { ...check('host CPU, animating', added('hostAvgPct'), budget.hostAvgPct,
      added('hostAvgPct') <= budget.hostAvgPct, durations && added('hostAvgPct') !== null),
      wholeHostPct: metric('hostAvgPct') },
    numeric('host CPU, parked', metric('idleHostCpuS'), budget.idleHostCpuS),
    check('WindowServer added, average', added('wsAvgPct'), budget.wsAvgPct, added('wsAvgPct') <= budget.wsAvgPct,
      durations && added('wsAvgPct') !== null),
    check('WindowServer added, busiest second', added('wsPeakPct'), budget.wsPeakPct, added('wsPeakPct') <= budget.wsPeakPct,
      durations && added('wsPeakPct') !== null),
    { ...numeric('RSS and strip cache', metric('peakRssMiB'), budget.rssMiB, false,
      finite(d.cacheBytes) && d.cacheBytes <= budget.cacheBytes && d.resident2xStrips >= 4),
      memoryDiagnostics: Object.fromEntries(SURFACES.map(surface => {
        const phase = size.phases?.[surface], samples = size.samples?.[surface];
        const baseline = phase?.memory?.fixtureSample, pid = baseline?.status?.pid;
        return [surface, Array.isArray(samples) && pid ? stageMemoryFigures(samples, baseline, pid) : phase?.memory];
      })) },
    check('frame pacing, 60 and 120 Hz', pacing, '95% unique, no consecutive duplicates', pacing.every(p => ['pass', 'skipped'].includes(p.verdict)),
      pacing.some(p => p.verdict === 'fail') || pacing.every(p => p.verdict !== 'not-measured')),
    check('layer install', max(d.installMs), `< ${budget.installMs} ms, one per plan`, max(d.installMs) !== null && max(d.installMs) < budget.installMs &&
      all(d.installsPerPlan, n => n === 1) && d.installsPerPlan.length === d.installMs?.length && d.unplannedInstalls === 0),
    check('startup', d.startupMs, `< ${budget.startupMs} ms`, finite(d.startupMs) && d.startupMs < budget.startupMs && d.firstStripDecoded === true),
    { ...check('panel size', nonempty(d.panels) ? d.panels.length : null, 'drawn ink union plus filter support', all(d.panels, drawingPanelFits),
      nonempty(d.panels) && (d.panels.every(p => p?.drawing != null) || d.panels.some(p => p?.drawing != null && !drawingPanelFits(p)))),
      legacyPanelFits: all(d.panels, p => panelFits(p, budget.panelPaddingPt)) },
    check('decode', max(d.decodeMs), `< ${budget.decodeMs} ms`, max(d.decodeMs) !== null && max(d.decodeMs) < budget.decodeMs),
    check('draw never blocks on decode', d.drawBlocked, false, d.drawBlocked === false),
  ];
  return { verdict: outcome(checks), checks, pacing,
    medianPrerequisites: { 'RSS and strip cache': finite(d.cacheBytes) && d.cacheBytes <= budget.cacheBytes && d.resident2xStrips >= 4,
      'layer install': all(d.installsPerPlan, n => n === 1) && d.installsPerPlan.length === d.installMs?.length && d.unplannedInstalls === 0,
      startup: d.firstStripDecoded === true },
    replays: Object.fromEntries(Object.entries(size.replays ?? {}).map(([surface, receipt]) => [surface,
      { scenario: receipt.scenario, figures: stageTraceFigures(receipt.trace, receipt.marks?.host ?? {}),
        refusal: receipt.refusal ?? null, exactReplayVerified: receipt.exactReplay?.reproduced === true }])), observations: { phases: size.phases ?? null,
    cacheBytes: d.cacheBytes ?? null, resident2xStrips: d.resident2xStrips ?? null, panels: d.panels ?? null,
    decodeSpans: list(d.decodeSpans) } };
}

/** Evaluate observations from the host dump, not a second implementation of its placement algorithm. Null box means
 * fail-closed hide, which is safe. Fixtures must still report the targets and person's window. */
function movedWindowProtected(p) {
  const proof = p.protection, window = proof?.window;
  return ['move', 'space', 'minimized', 'gone'].includes(p.event) && finite(p.elapsedMs) && p.elapsedMs <= 120 && Number.isSafeInteger(window?.pid) && window.pid > 0 && Number.isSafeInteger(window?.id) && window.id > 0 &&
    list(proof.wideWindows).some(w => w.pid === window.pid && w.id === window.id) &&
    Array.isArray(proof.required) && proof.required.length === 2 && proof.required.every(rect) && rect(proof.panel) &&
    nonempty(proof.forbidden) && proof.forbidden.every(rect) &&
    proof.required.every(r => proof.forbidden.some(f => encloses(f, r))) &&
    proof.forbidden.every(r => !overlaps(proof.panel, [r[0] - 1e-6, r[1] - 1e-6, r[2] + 2e-6, r[3] + 2e-6]));
}
export function behaviorChecks(b = {}) {
  const placementSafe = p => point(p?.aim) && point(p.pointer) && rect(p.person) && rect(p.target) && p.target[2] >= 300 && p.target[2] <= 1700 &&
    Array.isArray(p.above) && p.above.every(rect) && (p.aimRect === null || rect(p.aimRect)) &&
    (p.box === null || rect(p.box) && distance(p.box, [...p.aim, 0, 0]) >= 48 &&
      (p.aimRect === null || distance(p.box, p.aimRect) >= 48) && !overlaps(p.box, p.person) && p.above.every(r => !overlaps(p.box, r))) &&
    (p.box === null ? p.legs === null : rect(p.legs) && !overlaps(p.legs, p.aimRect ?? [...p.aim, 1, 1]));
  const events = (rows, required, predicate) => required.every(event => list(rows).some(r => r.event === event)) && all(rows, predicate);
  const count = rows => nonempty(rows) ? rows.length : null;
  return [
    check('never cover target, ring or person (1000 placements)', count(b.placements), 1000,
      list(b.placements).length >= 1000 && new Set(list(b.placements).map(p => p?.id)).size === list(b.placements).length &&
      new Set(list(b.placements).map(p => p?.target?.[2])).size >= 500 && b.placements.every(placementSafe)),
    check('pointer dodge or fade', count(b.pointer), '200 ms, 120 pt or 35%', all(b.pointer, p => p.panelOnScreen !== 'unmeasured' && finite(p.elapsedMs) && p.elapsedMs <= 200 &&
      (p.outcome === 'move' && finite(p.distancePt) && p.distancePt >= 120 || p.outcome === 'fade' && p.opacity === 0.35 || p.outcome === 'hidden' && p.reason === 'pointer-covered' && p.panelOnScreen === false))),
    check('protection on window change', count(b.hides), 'widen or hide within 120 ms', events(b.hides, ['move', 'space', 'minimized', 'gone', 'full-screen'],
      p => p.hidden === true && finite(p.elapsedMs) && p.elapsedMs <= 120 || movedWindowProtected(p))),
    check('front-sit retreats when watched', count(b.frontSit), '200 ms', events(b.frontSit,
      ['person-window', 'pointer-near', 'pointer-recent', 'asleep', 'locked'], p => (p.started === undefined || p.started === 'front-sit') &&
      ['edge-lie', 'edge-sit', 'corner-hang', 'side-climb', 'desk-stand', 'edge-hang', 'floor-stand', 'hidden'].includes(p.seat) && finite(p.elapsedMs) && p.elapsedMs <= 200)),
    check('badge is the only hit area', count(b.hits), '200 per size', SIZES.every(size => {
      const rows = list(b.hits).filter(p => p.size === size); return rows.length >= 200 && rows.every(p => p.outsideBadge === true && p.hit === false);
    })),
    check('never answers a card', b.consent ?? null, 'no answer, bad nonce drops state', b.consent?.syntheticMouseUpAnswered === false && b.consent?.badNonceDropped === true),
    check('reduced motion', count(b.reduced), 'at most 2 position values', all(b.reduced, p => Number.isInteger(p.positionValues) && p.positionValues >= 0 && p.positionValues <= 2)),
    check('size ladder', count(b.ladder), 'stage, 0.75 stage, medium, small, hidden', [700, 500, 300, 150, 40].every((w, i) =>
      list(b.ladder).some(p => p.width === w && p.level === ['stage', 'stage-0.75', 'medium', 'small', 'hidden'][i]))),
    check('attention at 8 s', count(b.attention), 'medium then stage', list(b.attention).some(p => finite(p.inputAgeS) && p.inputAgeS < 8 && p.size === 'medium') &&
      list(b.attention).some(p => finite(p.inputAgeS) && p.inputAgeS >= 8 && p.size === 'stage')),
    check('sleep and lock stop animations', count(b.sleepLock), 0, events(b.sleepLock, ['sleep', 'lock'], p => p.animations === 0)),
    check('packs without stage art', count(b.fallbacks), '9 packs at medium, one expected warning',
      ['tsugi', 'shizu', 'bit', 'kit', 'yori', 'tab', 'codex-v1', 'codex-v2', 'bit-nearest'].every(id => {
        const rows = list(b.fallbacks).filter(p => p.id === id); return rows.length === 1 && rows[0].stageArtAvailable === false && rows[0].loaded === true &&
          (id !== 'bit-nearest' || rows[0].stageFilter === 'nearest') &&
          rows[0].size === 'medium' && Array.isArray(rows[0].warnings) && rows[0].warnings.every(w => w === 'shown at medium');
      })),
    check('H5 stage capture', null, 'six sources, five samples, two seats', false),
  ];
}

export function stageCaptureCheck(captures) {
  const ok = ['edge-lie', 'front-sit'].every(seat => {
    const matching = list(captures).filter(c => c.seat === seat && c.size === 'stage');
    if (matching.length !== 1) return false;
    const c = matching[0];
    const samples = mode => list(c.modes?.[mode]?.samples);
    const complete = (rows, source, predicate) => {
      const s = rows.filter(r => r.source === source);
      return s.length >= 5 && new Set(s.map(r => r.sample)).size === s.length && s.every(predicate);
    };
    return Object.keys(SOURCES).every(source => complete(samples('hidden'), source,
      r => r.handUp === true && r.result === 'excluded' && r.handLike === 0)) &&
      ['region', 'composite'].every(source => complete(samples('visible'), source,
        r => r.handUp === true && r.result === 'shown' && finite(r.handLike) && r.handLike >= 40));
  });
  return check('H5 stage capture', nonempty(captures) ? captures.length : null, 'six sources, five samples, two seats', ok);
}

export function stageVerdict(evidence = {}, budget = STAGE_BUDGET, { medianOfThree = false } = {}) {
  const progress = evidence.collection, units = list(progress?.units), attempts = list(progress?.attempts);
  const historyError = progress ? stageHistoryError(progress) : null;
  const excluded = stageInterruptionCeilings(progress);
  const exclude = (c, row) => {
    c.rawVerdict ??= c.verdict;
    c.verdict = 'not-measured'; c.value = null;
    c.reason = `${row.code}: excluded ${row.unit}; ${row.interruptions}/${row.limit}; last stop: ${row.reason}`;
  };
  const latestUnits = [...units, ...progress?.inProgress ? [progress.inProgress] : []];
  const observedAttempts = [...attempts, ...progress?.inProgress ? [{ ...progress.inProgress, interrupted: true }] : []];
  const productFirst = (a, b) => Number(Boolean(b.kind) && !stageRetryable(b.kind)) - Number(Boolean(a.kind) && !stageRetryable(a.kind));
  const failureLabels = rows => [...rows].sort(productFirst).map(a => `${a.kind} #${a.attempt}${a.discarded ? ' discarded' : ''}`);
  const ownWindowQuiet = unit => {
    const segment = progress.segments.find(row => row.id === unit.segment);
    const row = unit.id === 'behavior' ? segment?.behavior : unit.id.startsWith('capture/') ? segment?.captures?.[unit.id.split('/')[1]] :
      segment?.rounds?.[unit.id.split('/')[1]];
    return row && Number.isFinite(Date.parse(row.endedAt)) && finite(row.loadAverageMax) &&
      row.loadAverageMax < budget.loadAverage && row.puddleWindowHeld === false;
  };
  const failures = [
    ...units.filter(unit => unit.status === 'failed'),
    ...observedAttempts.filter(unit => unit.kind && !stageRetryable(unit.kind)),
    ...units.filter(unit => (unit.attempt ?? 1) > 1 && (historyError || !ownWindowQuiet(unit)))
      .map(unit => ({ ...unit, kind: 'retry-unqualified', error: historyError ?? 'retry window not quiet' })),
  ];
  const unavailable = (c, reason) => {
    if (c.verdict !== 'fail' && reason) c.reason = reason;
    if (c.verdict === 'pass') { c.verdict = 'not-measured'; c.value = null; }
  };
  const runRows = list(evidence.runs), machine = evidence.machine ?? {};
  const identity = !evidence.error && evidence.schema === 'sleight.stage-cost/1' && typeof machine.mac === 'string' && machine.mac.trim().length > 0 &&
    typeof machine.macOS === 'string' && machine.macOS.length > 0 && finite(machine.maximumHz) && machine.maximumHz >= 60;
  const runs = runRows.map(r => {
    const quiet = finite(r.loadAverageMax) && r.loadAverageMax < budget.loadAverage && r.puddleWindowHeld === false;
    const sizes = Object.fromEntries(SIZES.map(size => [size, sizeChecks(r.sizes?.[size], r.baselines, machine.maximumHz, budget, size)]));
    // Time-separated baseline brackets and pacing controls cannot qualify one another.
    const sameSegment = ids => ids.every(id => units.some(u => u.id === id && u.status !== 'failed')) &&
      new Set(ids.map(id => units.find(u => u.id === id)?.segment)).size === 1;
    if (progress) for (const [size, result] of Object.entries(sizes)) {
      for (const hz of [60, 120]) for (const ms of [600, 400]) if (!sameSegment(
        ['character/hash', 'numbered/hash', 'character/timestamps', 'numbered/timestamps'].map(arm => `round/${r.round}/pacing/${size}/${hz}/${ms}/${arm}`))) {
        for (const c of result.checks.filter(c => c.name.startsWith('frame pacing'))) unavailable(c, 'pacing trial spans segments or is incomplete');
        for (const row of result.pacing) if (row.verdict === 'pass') row.verdict = 'not-measured';
      }
      result.attemptCount = Math.max(1, ...latestUnits.filter(u => u.id.startsWith(`round/${r.round}/`) &&
        (u.id.includes(`/${size}/`) || u.id.includes('/baseline/'))).map(u => u.attempt ?? 1));
      result.failures = failureLabels(observedAttempts.filter(a => a.kind && a.id.startsWith(`round/${r.round}/`) &&
        (a.id.includes(`/${size}/`) || a.id.includes('/baseline/'))));
      result.verdict = outcome(result.checks);
    }
    for (const failure of failures.filter(unit => unit.id.startsWith(`round/${r.round}/`))) {
      const parts = failure.id.split('/');
      for (const [size, result] of Object.entries(sizes)) {
        for (const c of result.checks) if (
          parts[2] === 'phase' && parts[3] === size && !c.name.startsWith('frame pacing') ||
          parts[2] === 'pacing' && parts[3] === size && c.name.startsWith('frame pacing')) unavailable(c, failure.kind + ": " + (failure.error ?? "failed unit"));
        if (parts[2] === 'pacing' && parts[3] === size) for (const row of result.pacing) if (row.verdict === 'pass') row.verdict = 'not-measured';
        result.verdict = outcome(result.checks);
      }
    }
    for (const row of excluded.filter(row => row.unit.startsWith(`round/${r.round}/`))) {
      const parts = row.unit.split('/');
      for (const [size, result] of Object.entries(sizes)) {
        for (const c of result.checks) if (parts[2] === 'qualification' ||
            parts[2] === 'phase' && parts[3] === size && !c.name.startsWith('frame pacing') ||
            parts[2] === 'pacing' && parts[3] === size && c.name.startsWith('frame pacing')) exclude(c, row);
        if (parts[2] === 'pacing' && parts[3] === size) for (const trial of result.pacing) exclude(trial, row);
        result.verdict = outcome(result.checks);
      }
    }
    const measured = outcome(Object.values(sizes));
    const baselineSurfaceChecks = Object.entries(r.baselines ?? {}).flatMap(([surface, rows]) => list(rows).flatMap((b, i) =>
      list(b?.surfaceChecks).map(check => ({ surface, position: i === 0 ? 'before' : 'after', check }))));
    return { round: r.round, quiet, verdict: measured === 'fail' ? 'fail' : !quiet ? 'not-measured' : measured, sizes, baselineSurfaceChecks };
  });
  const behavior = behaviorChecks(evidence.behavior); behavior[behavior.length - 1] = stageCaptureCheck(evidence.captures);
  for (const c of behavior) {
    const relevant = unit => c.name === 'H5 stage capture' ? unit.id.startsWith('capture/') : unit.id === 'behavior';
    const failed = failures.filter(relevant);
    if (failed.length) unavailable(c, failed.map(unit => `${unit.kind}: ${unit.error ?? 'failed unit'}`).join('; '));
    if (progress) {
      c.attemptCount = Math.max(1, ...latestUnits.filter(relevant).map(u => u.attempt ?? 1));
      c.failures = failureLabels(observedAttempts.filter(a => a.kind && relevant(a)));
    }
    for (const row of excluded.filter(row => relevant({ id: row.unit }))) exclude(c, row);
  }
  const complete = identity && runs.length === budget.runs && new Set(runs.map(r => r.round)).size === budget.runs &&
    runs.every(r => Number.isInteger(r.round) && r.round >= 1 && r.round <= budget.runs);
  const captures = list(evidence.captures).map(c => ({ seat: c.seat, sources: Object.keys(SOURCES).map(source => {
    const stats = mode => {
      const rows = list(c.modes?.[mode]?.samples).filter(s => s.source === source);
      return { taken: rows.length, counted: rows.filter(s => s.handUp === true).length,
        characterPixels: rows.length && rows.every(r => finite(r.handLike)) ? rows.reduce((sum, r) => sum + r.handLike, 0) : null };
    };
    return { source, hidden: stats('hidden'), visible: stats('visible') };
  }) }));
  const measured = outcome([...runs, ...behavior]);
  const summarizeAttempt = attempt => ({
    unit: attempt.id, segment: attempt.segment, discarded: attempt.discarded === true, interrupted: attempt.interrupted === true,
    ...Number.isSafeInteger(attempt.attempt) ? { attempt: attempt.attempt } : {},
    ...attempt.kind ? { kind: attempt.kind,
      retried: list(evidence.collection?.units).some(unit => unit.id === attempt.id && (unit.attempt ?? 1) > attempt.attempt) } : {},
    failure: attempt.error ?? attempt.discardReason ?? 'abrupt stop, no terminal observation',
    observedLoadAverageMax: attempt.observedLoadAverageMax ?? null, observedHeld: attempt.observedHeld ?? null,
  });
  const attemptRows = list(evidence.collection?.attempts).map(summarizeAttempt);
  if (progress?.inProgress) attemptRows.push(summarizeAttempt({ ...progress.inProgress, interrupted: true }));
  attemptRows.sort(productFirst);
  const result = { schema: 'sleight.stage-cost-verdict/1', machine, budget, runs, behavior, captures, attempts: attemptRows,
    phaseDiagnostics: observedAttempts.filter(a => a.id?.includes('/phase/') && a.evidence?.figures).map(a =>
      ({ unit: a.id, attempt: a.attempt, discarded: a.discarded === true, phase: a.evidence.figures })),
    recurringWindows: stageRecurringWindows(evidence), interruptionCeilings: excluded,
    rendererRSS: evidence.rendererRSS ?? null,
    units: evidence.collection ? stageCollectionSummary(evidence) : null,
    attemptCount: attemptRows.length, retryCount: attemptRows.filter(attempt => !attempt.discarded && attempt.retried !== false).length,
    discardedCount: attemptRows.filter(attempt => attempt.discarded).length, error: evidence.error ?? null,
    verdict: measured === 'fail' ? 'fail' : !complete || excluded.length ? 'not-measured' : measured };
  if (medianOfThree) result.medianOfThree = medianStageVerdict(result, identity);
  return result;
}

// Experimental scalar cost summary. Structural, visibility and pacing checks still require all three rounds.
function medianStageVerdict(result, identity) {
  const limits = { 'host CPU, animating': result.budget.hostAvgPct, 'host CPU, parked': result.budget.idleHostCpuS,
    'WindowServer added, average': result.budget.wsAvgPct, 'WindowServer added, busiest second': result.budget.wsPeakPct,
    'RSS and strip cache': result.budget.rssMiB, 'layer install': result.budget.installMs, startup: result.budget.startupMs, decode: result.budget.decodeMs };
  const rounds = result.runs;
  const complete = rounds.length === 3 && new Set(rounds.map(r => r.round)).size === 3 &&
    rounds.every(r => [1, 2, 3].includes(r.round) && r.quiet);
  const sizes = Object.fromEntries(SIZES.map(size => {
    const checks = (rounds[0]?.sizes[size].checks ?? []).map(template => {
      const rows = rounds.map(r => r.sizes[size].checks.find(c => c.name === template.name));
      const measured = complete && rows.every(c => c && c.verdict !== 'not-measured' && !c.reason);
      const roundValues = rows.map(c => c?.value ?? null), scalar = Object.hasOwn(limits, template.name);
      if (!scalar) return { ...check(template.name, null, template.limit, rows.every(c => c?.verdict === 'pass'), measured), roundValues };
      const values = [...roundValues].sort((a, b) => a - b), value = measured && values.every(Number.isFinite) ? values[1] : null;
      const prerequisites = rounds.every(r => r.sizes[size].medianPrerequisites?.[template.name] !== false);
      const strict = ['layer install', 'startup', 'decode'].includes(template.name);
      return { ...check(template.name, value, template.limit, prerequisites &&
        (strict ? value < limits[template.name] : value <= limits[template.name]), value !== null), roundValues };
    });
    return [size, { checks, verdict: outcome(checks) }];
  }));
  const measured = outcome([...Object.values(sizes), ...result.behavior]);
  return { mode: 'experimental-median-of-three', sizes,
    verdict: measured === 'fail' ? 'fail' : !identity || !complete || result.interruptionCeilings.length ? 'not-measured' : measured };
}

export function parseArgs(argv) {
  const opts = { size: 'all', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--target-stress') { opts.targetStress = true; continue; }
    if (arg === '--median-of-three') { opts.medianOfThree = true; continue; }
    if (arg === '--owner-away') { opts.ownerAway = true; continue; }
    if (arg === '--resume') { opts.resume = true; continue; }
    if (arg === '--retry-failed') { opts.retryFailed = true; continue; }
    if (!['--size', '--evidence', '--out', '--character', '--owner-away-file'].includes(arg)) throw Error(`unknown option ${arg}`);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw Error(`${arg} needs a value`);
    opts[arg === '--owner-away-file' ? 'ownerAwayFile' : arg.slice(2)] = value;
  }
  if (![...SIZES, 'all'].includes(opts.size)) throw Error('--size must be small, medium, stage or all');
  if (!opts.dryRun && !opts.evidence && !opts.ownerAway) throw Error('use --dry-run to plan, --evidence FILE to judge, or --owner-away --out DIR to collect');
  if (opts.ownerAway && opts.evidence) throw Error('--owner-away and --evidence are separate modes');
  if (opts.ownerAway && !opts.out) throw Error('--owner-away requires --out DIR');
  if (opts.resume && (!opts.ownerAway || !opts.out || opts.evidence)) throw Error('--resume requires --owner-away and the same --out DIR');
  if (opts.retryFailed && !opts.resume) throw Error('--retry-failed requires --resume');
  return opts;
}
export function stageRunTiming(opts = {}) {
  const sizes = opts.size && opts.size !== 'all' ? [opts.size] : SIZES;
  const pacingArms = 3 * sizes.length * 2 * 2 * 4, pacingSecondsPerArm = 5;
  const estimateMinutes = Math.ceil((3 * (2 * 2 * 62 + sizes.length * 2 * (129 + 2 * 61)) + pacingArms * pacingSecondsPerArm) / 60 + 12);
  // Three compiler invocations each have a 5 minute timeout. Reserve their full bound, even on a cold cache.
  // A 25% collection margin (at least 10 minutes) covers setup, quiet settling and bounded cleanup.
  const compilationMinutes = 15, marginMinutes = Math.max(10, Math.ceil(estimateMinutes * 0.25));
  return { estimateMinutes, compilationMinutes, marginMinutes, pacingArms, pacingSecondsPerArm,
    watchdogMs: (estimateMinutes + compilationMinutes + marginMinutes) * 60000 };
}
export function dryRunPlan(opts = {}) {
  const sizes = opts.size && opts.size !== 'all' ? [opts.size] : SIZES;
  const { estimateMinutes, compilationMinutes, marginMinutes, pacingArms, pacingSecondsPerArm, watchdogMs } = stageRunTiming(opts);
  return [
    `ST9 stage cost (dry run, no children, windows or captures): ${sizes.join(', ')}, 3 runs per size. A published pass requires all three sizes.`,
    'Live collection belongs to sleight-arch in an owner-away window: launch at nice 0; the measured host stays at nice 0 and the harness lowers itself to nice 19. Load average under 10, no Puddle live window held.',
    `Hold caffeinate -di -w on the harness pid, record hw.model, collect behavior before cost phases, and stop owned children at the ${watchdogMs / 60000}-minute global deadline: ${estimateMinutes} minutes collection + ${compilationMinutes} minutes compilation + ${marginMinutes} minutes margin (25% of collection, minimum 10 minutes). Record rung downgrades and foreign-window interference; those phases are not-measured and later phases continue.`,
    `Expected collection time: about ${estimateMinutes} minutes plus compilation, including ${pacingArms} pacing arms with a fresh session each at an estimated ${pacingSecondsPerArm} s per arm. Opens two owned nonactivating target windows, an animated backdrop in the changing-content pass, a ring panel and a character panel. No owner app is opened.`,
    'Build a temporary StageCost.app with SLEIGHT_STAGE_BENCH and the production renderer. Only this build has --stage-bench. All art and binaries stay in a private temporary directory.',
    'Default art: four synthetic 2x strips. Use --character DIR for a real stage pack; its bytes are copied into a private bank and its source id and SHA-256 are recorded. Installed art and built-in pins are unchanged.',
    'For each round and surface (quiet and changing content), record no-host baselines before and after the host phases.',
    'Each phase includes hidden-character controls before and after, with the same 60 s script across two owned fixture windows. Subtract their mean from the phase for WindowServer average and busiest second on each surface. Report both controls and their spread. Keep no-host baselines as diagnostics.',
    'Supply --owner-away-file PATH (or SLEIGHT_OWNER_AWAY_FILE). The fixture refuses to raise changing content without that marker. Kernel watches lower the backdrop and click-through targets on marker deletion or rename, folder deletion or rename, or parent exit. A one-shot deadline caps exposure at 240 s (180 s for hidden controls). Every boundary prints its interfering window list. Dispatch error over 250 ms invalidates phase/control script matching.',
    'After 60 s scripted animation, settle and measure 60 s parked with two ps/tree endpoint reads and no polling between them. Record one status reply cost outside that interval. Keep fixture RSS before loading the character, increments and tree peaks with and without live children. The fixture windows still share the renderer process.',
    'Record character CPU addition <=2.5 percentage points over hidden controls, parked <=0.05 CPU s, WindowServer added <=3% average and <=8% busiest second, RSS <=160 MiB for the whole process tree including the microphone worker, four resident 2x strips and cache <=24 MiB.',
    'Use --stage-dump for behavior and cache probes; renderer telemetry for layer install <4 ms and one per plan, startup <400 ms, decode <40 ms, and physical-panel enclosure of the drawn ink union plus filter support. The old seat plus move plus 48 pt figure remains diagnostic.',
    'Frame probes are scripted 600 ms leap and 400 ms swing paths through the production installer, with a fixed panel and scheduled common host clock. Production motion selection needs separate live qualification.',
    'For 60 and 120 Hz: frame-pacing --window ID --pid PID --hz RATE --duration-ms 600, then 400. Start in capture-visible mode. Wait for ready, trigger motion and write {"start":true} to stdin.',
    'Run character and stationary numbered-content controls, each with --mode hash and --mode timestamps. Keep scheduled start, actual install and CA begin, PTS, callback arrivals, complete/idle/rejected counts and hash durations. Unit failures preserve partial evidence, leave dependent bars not-measured and continue. Four consecutive units or pacing trials failing with the same kind, or 12 failed units or trials in total, stop the run.',
    'Keep the original scheduled interval and denominator. Require >=95% unique content and no consecutive duplicates in both hash arms. A failed or missing numbered control leaves the character unqualified with its raw verdict retained. Timestamps-only delivery cannot prove unique content. Skip 120 only when display maximum is below 120.',
    'Feed 1000 seeded random placements (windows 300 to 1700 pt, targets, aim rects, stacks, pointer and person); test 48 pt clearance, legs and person overlap.',
    'Dump pointer dodge/fade <=200 ms, hides <=120 ms, front-sit retreat <=200 ms, 200 badge-exterior hit points per size, card synthetic mouse-up and bad nonce.',
    'Dump reduced motion <=2 position values; ladder 700/500/300/150/40; attention at 8 s; sleep/lock zero animations; six built-ins without strips, Codex v1/v2 and Bit nearest at medium.',
    sizes.includes('stage') ? 'H5: stage edge-lie and front-sit, six sources x 5 samples, hidden zero character pixels, visible positive controls; preserve visible hover/region/composite leak observations.' :
      'H5: not collected in a small- or medium-only cost pass; full-stage capture exclusion remains unmeasured.',
    'Save schema sleight.stage-cost/1: machine {mac, macOS, maximumHz}; runs [{round, loadAverageMax, puddleWindowHeld, baselines:{quiet:[before,after],changing:[before,after]}, sizes:{small,medium,stage}}].',
    'Each size: phases {quiet,changing} from stagePhaseFigures (including idleWsAvgPct/idleWsPeakPct); dump {cacheBytes,resident2xStrips,installMs[],installsPerPlan[],startupMs,firstStripDecoded,decodeMs[],drawBlocked,panels:[{panel,seat,move,drawing:{inkUnion,filterUnion,clip,required,positions,geometries,hasExtras}}]}; pacing [frame-pacing JSON for both motions/rates].',
    'Top-level behavior holds raw observations under placements, pointer, hides, frontSit, hits, consent, reduced, ladder, attention, sleepLock, fallbacks. Top-level captures holds the two H5 reports.',
    'Judge without live activity: node bench/hand/stage-cost.mjs --evidence <observations.json>. Exit 0 pass, 1 failed or not measured, 2 malformed input.',
    'Collect: node bench/hand/stage-cost.mjs --owner-away --owner-away-file FILE --out <receipts>. Saves raw samples, JSON observations and stage-cost.md. ST7 badge/card checks remain not-measured until their contract exists.',
    'Continue a stopped collection with the same arguments plus --resume. Completed units are retained; an interrupted phase, pacing arm or H5 seat restarts as a whole. A round with missing load observations or a lost quiet window repeats from its start; earlier rounds and behavior stay recorded. Source commit, pack digest, machine and display rate must match. Segment times and unit provenance are saved in the JSON.',
    `Pass --owner-away-file FILE for the private owner-away marker. Its loss, a hold, lost lock identity, lost load observations, deadline or interrupt stops collection. Add --resume --retry-failed to retry each recorded failed unit once per invocation. Prior failures remain beside the verdict. A qualified harness retry measures its bars; product failures stay not-measured. Retry each phase with its hidden control and whole four-arm pacing trials. At most three unit-local failed attempts count per unit; run stops and discarded rounds spend no retry slots. After ${STAGE_MAX_INTERRUPTED_ATTEMPTS} interrupted attempts of a unit, including discarded rounds and the last unfinished attempt, record that unit as excluded with STAGE_INTERRUPTION_CEILING and continue this bank. Its bars remain not-measured.`,
  ];
}
function controlReport(phases) {
  const lines = [
    '| Size | Surface | Control host CPU % | Control CPU s | Phase host CPU % | Difference pp |',
    '|---|---|---:|---:|---:|---:|',
  ];
  for (const { size, surface, phase } of phases) {
    const control = stageControlFigures(phase.control), value = n => Number.isFinite(n) ? rounded(n) : 'unknown';
    const difference = control?.hostAvgPct !== null && Number.isFinite(control?.hostAvgPct) && Number.isFinite(phase.hostAvgPct) ?
      phase.hostAvgPct - control.hostAvgPct : null;
    lines.push(`| ${size} | ${surface} | ${value(control?.hostAvgPct)} | ${value(control?.hostCpuS)} | ${value(phase.hostAvgPct)} | ${value(difference)} |`);
  }
  lines.push('', 'Animating CPU bars use the character addition over the hidden control. The phase total is printed beside it.', '');
  for (const { size, surface, phase } of phases) {
    const control = stageControlFigures(phase.control);
    if (phase.control?.layout === 'bracketed/1') {
      for (const [metric, label, unit] of [['wsAvgPct', 'WindowServer average', 'pp'], ['wsPeakPct', 'WindowServer busiest second', 'pp'],
        ['hostAvgPct', 'host CPU average', 'pp']]) lines.push(
        `${size} ${surface} ${label} controls: before ${control?.before?.[metric] ?? 'unknown'}%; after ${control?.after?.[metric] ?? 'unknown'}%; mean ${control?.[metric] ?? 'unknown'}%; spread ${control?.spread?.[metric] ?? 'unknown'} ${unit}.`, '');
      lines.push(`${size} ${surface} control CPU s: before ${control?.before?.hostCpuS ?? 'unknown'}; after ${control?.after?.hostCpuS ?? 'unknown'}.`, '');
    }
  }
  return lines;
}
export function reportMarkdown(result) {
  const recurring = (result.recurringWindows ?? []).map(w => `recurring foreign window: owner ${JSON.stringify(w.owner)}, pid ${w.pid}, window ${w.windowId}, level ${w.level}, bounds ${JSON.stringify(w.bounds)}, first seen ${w.firstSeen}`);
  const lines = [`# ST9 stage cost: ${result.verdict}${recurring.length ? '; ' + recurring.join('; ') : ''}`, '', `Mac: ${result.machine.mac ?? 'unknown'}; macOS: ${result.machine.macOS ?? 'unknown'}; display maximum: ${result.machine.maximumHz ?? 'unknown'} Hz.`, ''];
  for (const stop of result.interruptionCeilings ?? []) lines.push(`${stop.code}: excluded unit ${JSON.stringify(stop.unit)} reached ${stop.interruptions}/${stop.limit} interrupted attempts; last stop ${JSON.stringify(stop.reason)}. Resume continues with the next unit in this bank.`, '');
  if (result.units) lines.push(`Attempt numbers include run stops and discarded rounds. The cap is 3 unit-local failed attempts per unit; stops and discarded attempts spend no slots. A separate ceiling excludes a unit after ${STAGE_MAX_INTERRUPTED_ATTEMPTS} interruptions across this bank.`, '');
  if (result.attemptCount) lines.push(`Prior attempts: ${result.attemptCount}; retried: ${result.retryCount ?? 0}; discarded: ${result.discardedCount ?? 0}.`, '');
  for (const attempt of result.attempts ?? []) lines.push(
    `Attempt: ${JSON.stringify(attempt.unit)}; segment ${attempt.segment}; ${attempt.discarded ? 'discarded' : attempt.interrupted ? 'interrupted' : attempt.retried === false ? 'failed' : 'retried'};` +
    (attempt.kind ? ` kind ${attempt.kind};` : '') + (attempt.attempt ? ` attempt ${attempt.attempt};` : '') + ` failure ${JSON.stringify(attempt.failure)}.` +
    (attempt.discarded ? ` observed load maximum ${attempt.observedLoadAverageMax ?? 'unknown'}; observed held ${attempt.observedHeld ?? 'unknown'}.` : ''), '');
  if (result.error) lines.push(`Run error: ${JSON.stringify(result.error)}.`, '');
  if (result.machine.character) lines.push(`Character: ${JSON.stringify(result.machine.character)}.`, '');
  for (const r of result.runs) {
    lines.push(`## Run ${r.round}: ${r.verdict}`, '', `Quiet-window qualification: ${r.quiet ? 'yes' : 'not measured'}.`, '', '| Size | Gate | Value | Limit | Verdict |', '|---|---|---|---|---|');
    for (const [size, s] of Object.entries(r.sizes)) {
      for (const c of s.checks) lines.push(`| ${size} | ${c.name} | ${typeof c.value === 'object' && c.value !== null ? JSON.stringify(c.value) : c.value ?? 'none'}${c.name === 'host CPU, animating' ? ` pp added; whole host ${c.wholeHostPct ?? 'unknown'}%` : ''} | ${c.limit} | ${c.verdict}${s.attemptCount ? `; attempts ${s.attemptCount}` : ""}${s.failures?.length ? `; ${s.failures.join(", ")}` : ""}${c.reason ? `; ${c.reason}` : ""} |`);
    }
    lines.push('');
    lines.push(...controlReport(Object.entries(r.sizes).flatMap(([size, s]) =>
      Object.entries(s.observations.phases ?? {}).map(([surface, phase]) => ({ size, surface, phase })))));
    for (const { surface, position, check } of r.baselineSurfaceChecks ?? [])
      lines.push(`${surface} diagnostic baseline ${position} ${check.boundary}: valid=${check.valid}; reason=${check.reason ?? 'none'}; interfering=${JSON.stringify(check.interfering ?? null)}.`, '');
    for (const [size, s] of Object.entries(r.sizes)) {
      lines.push(`${size} strip cache: ${s.observations.cacheBytes ?? 'unknown'} bytes; resident 2x strips: ${s.observations.resident2xStrips ?? 'unknown'}.`, '');
      const panels = list(s.observations.panels), legacy = panels.filter(p => panelFits(p, result.budget.panelPaddingPt)).length;
      lines.push(`${size} legacy seat plus move plus ${result.budget.panelPaddingPt} pt: ${legacy}/${panels.length}; diagnostic only.`, '');
      lines.push(panels.length && panels.every(p => p?.drawing != null) ?
        `${size} drawing bounds (all motion positions, original logical clip): ${JSON.stringify(panels)}.` : `${size} drawing bounds: not measured.`, '');
      const spans = list(s.observations.decodeSpans);
      const split = spans.length > 0 && spans.every(span =>
        ['validationMs', 'spawnMs', 'transferMs', 'reapMs', 'scanMs', 'imageMs', 'otherMs'].every(key => finite(span[key])));
      lines.push(split ? `${size} decode components, ms (pipe transfer includes child startup and decoding): ${JSON.stringify(spans)}.` :
        `${size} decode components: not measured.`, '');
      for (const [surface, phase] of Object.entries(s.observations.phases ?? {})) {
        for (const [role, checks] of [['phase', phase.surfaceChecks], ...controlRecords(phase.control).map((c, i) =>
          [phase.control?.layout ? `control ${i ? 'after' : 'before'}` : 'control', c?.surfaceChecks])])
          for (const check of checks ?? []) lines.push(`${size} ${surface} ${role} ${check.boundary}: valid=${check.valid}; reason=${check.reason ?? 'none'}; interfering=${JSON.stringify(check.interfering ?? null)}.`, '');
        lines.push(`${size} ${surface} largest dispatch error: phase ${phase.maxDispatchErrorMs ?? 'unknown'} ms; hidden control ${phase.control?.maxDispatchErrorMs ?? 'unknown'} ms.`, '');
        const control = stageControlFigures(phase.control);
        lines.push(`${size} ${surface} hidden-character scripted control: ${control?.wsAvgPct ?? 'unknown'}% WindowServer average; ${control?.wsPeakPct ?? 'unknown'}% busiest second; ${control?.wsRunnerUpPct ?? 'unknown'}% runner-up second. Phase minus control is used for both WindowServer bars.`, '');
        const memory = s.checks.find(c => c.name === 'RSS and strip cache')?.memoryDiagnostics?.[surface] ?? phase.memory;
        const renderer = result.rendererRSS?.schema === 'sleight.renderer-rss/1' ? result.rendererRSS.sizes?.[size] : null;
        const rendererNote = [renderer?.selfMiB, renderer?.treeMiB].every(n => finite(n) && n >= 0)
          ? `Renderer-only RSS from bench/hand/stage-renderer-rss.mjs: parked self ${renderer.selfMiB} MiB; parked tree ${renderer.treeMiB} MiB.`
          : 'Renderer-only RSS is not measured. Collect it with node bench/hand/stage-renderer-rss.mjs --owner-away-file FILE --character DIR --out NEW_DIR; see renderer-rss.md.';
        lines.push(`${size} ${surface} RSS: fixture ${memory?.fixtureMiB ?? 'unknown'} MiB; character increment ${memory?.incrementMiB ?? 'unknown'} MiB; tree peak ${memory?.treePeakMiB ?? 'unknown'} MiB; with live children ${memory?.treePeakWithLiveChildrenMiB ?? 'unknown'} MiB; without live children ${memory?.treePeakWithoutLiveChildrenMiB ?? 'unknown'} MiB. ${rendererNote} The ${result.budget.rssMiB} MiB limit covers the whole process tree, including the microphone worker.`, '');
        lines.push(`${size} ${surface} RSS diagnostics: raw peak ${memory?.treePeakMiB ?? 'unknown'} MiB (judged); parked endpoint tree ${memory?.parkedEndpointTreeMiB ?? 'unknown'} MiB; parked self ${memory?.parkedEndpointSelfMiB ?? 'unknown'} MiB; peak excluding transient decode-child samples ${memory?.treePeakWithoutDecodeChildMiB ?? 'unknown'} MiB (${memory?.excludedDecodeSamples ?? 'unknown'} excluded). Classification: ${memory?.decodeClassification ?? 'not measured'}.`, '');
        lines.push(`${size} ${surface} one status reply: ${phase.statusReplyCost?.cpuS ?? 'unknown'} self CPU s; ${phase.statusReplyCost?.wallMs ?? 'unknown'} ms wall time. Parked observation: ${phase.parkedObservation ?? 'legacy polling'}.`, '');
        for (const [activity, tree] of Object.entries(phase.processTree ?? {})) if (tree) lines.push(
          `${size} ${surface} ${activity} process tree: self CPU ${tree.selfCpuS} s; children CPU ${tree.childrenCpuS} s; package wakeups ${tree.packageWakeups} (children ${tree.childrenPackageWakeups}); interrupt wakeups ${tree.interruptWakeups} (children ${tree.childrenInterruptWakeups}); query spawns ${tree.querySpawns} (${tree.querySpawnsPerS}/s).`, '');
      }
    }
  }
  if (result.phaseDiagnostics?.length) {
    lines.push('## Failed and discarded phase diagnostics', '', 'These figures do not enter the judged bars.', '');
    for (const row of result.phaseDiagnostics) {
      const parts = row.unit.split('/');
      lines.push(`Unit ${JSON.stringify(row.unit)}, attempt ${row.attempt ?? 1}${row.discarded ? ', discarded' : ''}.`, '',
        ...controlReport([{ size: parts[3], surface: parts[4], phase: row.phase }]));
    }
  }
  if (result.medianOfThree) {
    lines.push(`## Experimental median of three rounds: ${result.medianOfThree.verdict}`, '',
      `Current verdict: ${result.verdict}. Limits and exit status still follow the current verdict.`, '',
      'Scalar cost bars use the median of three distinct, quiet, measured rounds. Other gates and structural prerequisites require all three rounds.', '',
      '| Size | Gate | Round values | Median | Limit | Verdict |', '|---|---|---|---|---|---|');
    for (const [size, summary] of Object.entries(result.medianOfThree.sizes)) for (const c of summary.checks)
      lines.push(`| ${size} | ${c.name} | ${JSON.stringify(c.roundValues)} | ${c.value ?? 'none'} | ${c.limit} | ${c.verdict} |`);
    lines.push('');
  }
  lines.push('## Behavior', '', '| Check | Observations | Limit | Verdict |', '|---|---|---|---|');
  for (const c of result.behavior) lines.push(`| ${c.name} | ${typeof c.value === 'object' && c.value !== null ? JSON.stringify(c.value) : c.value ?? 'none'} | ${c.limit} | ${c.verdict}${c.attemptCount ? `; attempts ${c.attemptCount}` : ''}${c.failures?.length ? `; ${c.failures.join(', ')}` : ''}${c.reason ? `; ${c.reason}` : ''} |`);
  lines.push('', '## H5 stage captures', '', '| Seat | Source | Hidden counted/taken | Hidden character pixels | Visible counted/taken | Visible character pixels |', '|---|---|---|---|---|---|');
  for (const c of result.captures) for (const s of c.sources) lines.push(`| ${c.seat} | ${s.source} | ${s.hidden.counted}/${s.hidden.taken} | ${s.hidden.characterPixels ?? 'unknown'} | ${s.visible.counted}/${s.visible.taken} | ${s.visible.characterPixels ?? 'unknown'} |`);
  if (result.units) lines.push('', stageSummaryLine(result.units));
  return lines.join('\n') + '\n';
}
export async function main(argv) {
  try {
    const opts = parseArgs(argv);
    if (opts.dryRun) { console.log(dryRunPlan(opts).join('\n')); return 0; }
    if (opts.ownerAway) {
      const { runLiveStage } = await import('./stage-live.mjs');
      const evidence = await runLiveStage(opts), result = stageVerdict(evidence, STAGE_BUDGET, opts);
      mkdirSync(opts.out, { recursive: true });
      writeFileSync(resolve(opts.out, 'stage-cost.json'), JSON.stringify(evidence, null, 2) + '\n');
      const report = reportMarkdown(result); writeFileSync(resolve(opts.out, 'stage-cost.md'), report); console.log(report);
      return result.verdict === 'pass' ? 0 : 1;
    }
    const input = readFileSync(opts.evidence, 'utf8');
    if (Buffer.byteLength(input) > 64 * 1024 ** 2) throw Error('evidence exceeds 64 MiB');
    const evidence = JSON.parse(input);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw Error('evidence must be an object');
    const result = stageVerdict(evidence, STAGE_BUDGET, opts);
    console.log(reportMarkdown(result));
    return result.verdict === 'pass' ? 0 : 1;
  } catch (e) {
    console.error(`ST9: ${e.message}`);
    if (e.stageSummary) console.error(stageSummaryLine(e.stageSummary));
    return 2;
  }
}
// Finish module evaluation before loading the live adapter, which imports the pure judge above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(code => { process.exitCode ??= code; });
