// ST9B collection orchestration. Importing this module opens nothing. The live entry is owner-away only.
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPriority, loadavg } from 'node:os';
import { cursorWire, playSequence } from './cursor-sequence.mjs';
import { encodePng, syntheticSheet, characterEnv } from './synthetic-character.mjs';
import { loadCharacter, resolveCharacterStates, checkBuiltinCharacter, builtinCharactersDirectory, installCharacter, prepareCharacterImport } from '../../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../../plugins/sleight/lib/hand/character-frame.mjs';
import { compileArgs, compileSwift, helperClient, HOST_SOURCE, ROOT } from './vc7-live.mjs';
import { PrioritySpawner } from './c10-priority.mjs';
import { createCostSampler, summarize } from './cost-sampler.mjs';
import { collectHiddenControl, collectBracketedPhase, collectParkedInterval, stageScriptReceipt, stageMemoryFigures, STAGE_CONTROL_LAYOUT } from './stage-measurement.mjs';
import { stageSequence, stagePhaseFigures, stageRunTiming, SIZES, SURFACES, placementFixtures } from './stage-cost.mjs';
import { collectSurfaceCheck } from './stage-surface.mjs';
import { stageReplayReceipt, stageReplayLines, compareStageReplay, stageTraceFigures } from './stage-trace.mjs';
import { rendererWindowTimeline, replayObservations } from './stage-diagnostics.mjs';
import { helperCompileArgs } from '../../plugins/sleight/lib/direct-browser/host-cache.mjs';
import { privateStageHome } from './private-stage-home.mjs';
import { STAGE_FAILURE_BUDGET, STAGE_MAX_ATTEMPTS, STAGE_TOTAL_FAILURE_BUDGET, excludeStageInterruptedUnits, stageRetryable, stageFailureGroup, stageAttemptNumber, stageFailureAttempts, archiveStageUnits, stageUnitFailure, stageFailureKind, stageCollectionSummary, stageSummaryLine, stageUnitOrder, stageUnitDigest, stageMachineDigest, mergeDumps, discardUnfinishedBehavior, discardInterruptedUnit, discardUnobservedRound, roundQualification, sealStageEvidence, stageIdentity, validateStageResume, readStagePartial, writeStagePartial } from './stage-progress.mjs';

const execute = promisify(execFile), sleep = ms => new Promise(r => setTimeout(r, ms));
export const STAGE_WATCHDOG_MS = stageRunTiming().watchdogMs;

// One deadline covers compilation, behavior, cost phases, pacing, capture and cleanup.
export function stageRunGuard({ timeoutMs = STAGE_WATCHDOG_MS, spawnChild = spawn } = {}) {
  const controller = new AbortController(), children = new Map(); let closing;
  const cleanups = new Set(), cleanupTasks = new Map();
  const startCleanup = fn => {
    if (!cleanupTasks.has(fn)) {
      const task = Promise.resolve().then(fn); cleanupTasks.set(fn, task); task.catch(() => {});
    }
    return cleanupTasks.get(fn);
  };
  const track = child => {
    const collected = new Promise(resolve => { child.once('close', resolve); child.once('error', () => {}); });
    children.set(child, collected); collected.then(() => children.delete(child));
    return collected;
  };
  const stop = child => {
    child.stdin?.end();
    const gentle = setTimeout(() => child.kill('SIGTERM'), 3000);
    const force = setTimeout(() => child.kill('SIGKILL'), 6000);
    children.get(child)?.finally(() => { clearTimeout(gentle); clearTimeout(force); });
  };
  controller.signal.addEventListener('abort', () => {
    for (const child of children.keys()) stop(child);
    for (const fn of cleanups) startCleanup(fn);
  }, { once: true });
  const timer = setTimeout(() => controller.abort(Error('stage run exceeded global watchdog')), timeoutMs);
  return {
    signal: controller.signal,
    abort: error => controller.abort(error),
    onClose(fn) {
      cleanups.add(fn); if (controller.signal.aborted) startCleanup(fn);
      return () => cleanups.delete(fn);
    },
    spawn(command, args, options, launch = spawnChild) {
      controller.signal.throwIfAborted();
      const child = launch(command, args, options);
      track(child);
      return child;
    },
    async execute(file, args, options = {}) {
      controller.signal.throwIfAborted();
      let child;
      const pending = new Promise(resolve => {
        // Wait for close after a watchdog signal. execFile's AbortSignal callback alone is not collection proof.
        child = execFile(file, args, { ...options, signal: undefined }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      });
      const collected = track(child), result = await pending;
      await collected; controller.signal.throwIfAborted();
      if (result.error) throw Object.assign(result.error, { stdout: result.stdout, stderr: result.stderr });
      return { stdout: result.stdout, stderr: result.stderr };
    },
    close() { return closing ??= (async () => {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(Error('stage run closed'));
      await Promise.all([...children.values()]);
      await Promise.all([...cleanupTasks.values()]);
    })(); },
  };
}

export async function startStagePriority({ priority = getPriority(), createSpawner = () => new PrioritySpawner(process.env) } = {}) {
  if (priority !== 0) throw Error('ST9 needs a nice 0 launcher; the harness lowers its own priority after starting the host spawn service');
  const service = createSpawner();
  try { await service.niceRunner(); return service; }
  catch (error) { await service.close(); throw error; }
}

export function stageSleepArgs(pid) { return ['-di', '-w', String(pid)]; }
export function holdStageAwake({ pid = process.pid, spawnChild = spawn, onUnexpectedExit = () => {} } = {}) {
  const child = spawnChild('/usr/bin/caffeinate', stageSleepArgs(pid), { stdio: 'ignore' });
  let ended = false, closing;
  const ready = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const collected = new Promise(resolve => child.once('close', () => {
    ended = true; if (!closing) onUnexpectedExit(); resolve();
  }));
  return { ready, get ended() { return ended; }, close() {
    return closing ??= (async () => {
      if (ended) return;
      child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await collected; clearTimeout(timer);
    })();
  } };
}
export function visibilitySample(status, size, t = Date.now()) {
  return { ...status, t, requestedSize: size, valid: status.shown === true && status.size === size };
}
export function phaseVisibilityValid(samples) { return samples.length > 0 && samples.every(s => s.valid === true); }
export function recordPhaseVisibility(samples, status, size, t = Date.now()) {
  const sample = visibilitySample(status, size, t); samples.push(sample);
  if (!sample.valid) throw Object.assign(stageUnitFailure('visibility', 'invalid phase visibility'), {
    invalidVisibility: { reason: 'requested size not visible during measured phase', sample },
  });
  return sample;
}
export function stageWire(nonce = randomBytes(32).toString('hex'), { size = 'stage', frontSit = false } = {}) {
  const base = cursorWire(nonce);
  return { ...base, character(frame) {
    // Reserve the shared counter through the existing builder, then bind the real v1.1 frame.
    const sequence = JSON.parse(base.aim({ kind: 'click', pid: 1, windowId: 1, at: [0, 0] })).seq;
    return JSON.stringify({ ...frame, nonce, seq: sequence, size, stageAttention: false, stageFrontSit: frontSit }) + '\n';
  } };
}

// Keep each arm as raw evidence, including failed controls. Diagnostic captures cannot qualify a character.
export async function collectPacingTrial(capture, size, hz, ms, checkpoint = async () => {}) {
  let result;
  const arm = async (source, recorderMode, save) => {
    try { save(await capture(size, hz, ms, { source, recorderMode })); }
    catch (error) {
      if (error.pacingEvidence) { save(error.pacingEvidence); await checkpoint(result); }
      throw error;
    }
    await checkpoint(result);
  };
  await arm('character', 'hash', row => { result = row; });
  await arm('numbered', 'hash', row => { result.calibration = row; });
  await arm('character', 'timestamps', row => { result.timestampsOnly = row; });
  await arm('numbered', 'timestamps', row => { result.calibration.timestampsOnly = row; });
  return result;
}

// A re-shown panel is insufficient: every cumulative hide counter and generation must stay unchanged.
export function pacingVisibilityContinuous(before, after) {
  const counts = value => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every(n => Number.isSafeInteger(n) && n >= 0);
  return before?.shown === true && after?.shown === true && Number.isSafeInteger(before.panelID) && before.panelID > 0 &&
    before.panelID === after.panelID && Number.isSafeInteger(before.panelGenerations) &&
    before.panelGenerations === after.panelGenerations && counts(before.hideReasonCounts) && counts(after.hideReasonCounts) &&
    [...new Set([...Object.keys(before.hideReasonCounts), ...Object.keys(after.hideReasonCounts)])]
      .every(key => (before.hideReasonCounts[key] ?? 0) === (after.hideReasonCounts[key] ?? 0));
}
export async function pacingPanelWindows(session, snapshot, helper) {
  const windows = (await helper(['windows'])).windows.filter(w => w.pid === session.pid && w.id === snapshot.panelID);
  if (windows.length !== 1) {
    let failureQuery;
    try { failureQuery = await session.request({ bench: 'query' }); }
    catch (error) { if (!stageRetryable(stageFailureKind(error))) throw error; }
    throw stageUnitFailure(pacingVisibilityContinuous(snapshot, failureQuery) ? 'fixture-seat' : 'visibility',
      'pacing needs exactly one owned panel', { windows, snapshot, failureQuery });
  }
  return windows;
}
export async function stageMeasurementBoundary(kind, collect) {
  try { return await collect(); }
  catch (error) {
    if (stageFailureKind(error) || error.runStop || error.name !== 'Error') throw error;
    if (error.invalidVisibility) throw Object.assign(stageUnitFailure('visibility', error.message, error.invalidVisibility), { invalidVisibility: error.invalidVisibility });
    throw stageUnitFailure(kind, error.message, error.unitEvidence);
  }
}
export async function stageMeasuredSurface(options) {
  return stageMeasurementBoundary('fixture-seat', async () => {
    const check = await collectSurfaceCheck(options);
    if (!check.valid) throw stageUnitFailure('fixture-seat', 'surface boundary refused', check);
    return check;
  });
}

// The live closure and offline protocol tests share the complete recorder handshake and failure boundary.
export async function recordPacingMotion(session, recorder, metadata, { helper } = {}) {
  let record;
  try {
    const ready = await recorder.wait(r => r.ready === true || r.ok === false);
    if (ready.ok === false) { record = ready; throw stageUnitFailure('pacing-recorder', `pacing recorder failed: ${ready.error ?? 'unknown'}`); }
    const query = await session.request({ bench: 'query' }), startAtHostMs = query.hostTimeMs + 500;
    recorder.write(JSON.stringify({ start: true, startAtHostMs }) + '\n');
    const started = await session.request({ bench: 'start', startAtHostMs });
    if (started.ok === false) throw stageUnitFailure('fixture-seat',
      `pacing scheduling failed: ${started.reason ?? started.error}`, started);
    record = await recorder.wait(r => Array.isArray(r.frames) || r.ok === false, 15000);
    const exit = await recorder.close();
    const completedInvalid = record.started === true && Array.isArray(record.frames) &&
      (record.invalidFrames > 0 || record.changedDimensions === true);
    if (record.error || record.overflow === true || exit.code !== 0 || record.ok !== true && !completedInvalid) {
      throw stageUnitFailure('pacing-recorder', `pacing recorder failed: ${record.error ?? exit.signal ?? exit.code}`);
    }
    const completed = await session.request({ bench: 'query' });
    return { ...metadata, ...record, motionTiming: completed.motionTiming };
  } catch (error) {
    const sessionError = session.rows?.findLast(row => row.ok === false && row.error)?.error;
    const partial = { ...metadata, ...record, ok: false,
      error: record?.error ?? sessionError ?? error.message, recorderRows: recorder.rows, sessionRows: session.rows ?? [],
      recorderFailureKind: stageFailureKind(error) };
    // One final observation distinguishes a broken recorder from the product losing its captured panel.
    if (stageFailureKind(error) && session.request) {
      const diagnostics = [
        ['failureQuery', () => session.request({ bench: 'query' })],
        ...helper ? [['failureWindows', async () => (await helper(['windows'])).windows]] : [],
      ];
      for (const [name, collect] of diagnostics) try { partial[name] = await collect(); }
      catch (diagnosticError) {
        if (!stageFailureKind(diagnosticError)) throw diagnosticError;
        (partial.diagnosticErrors ??= []).push({ kind: stageFailureKind(diagnosticError), error: diagnosticError.message });
        if (!stageRetryable(stageFailureKind(diagnosticError))) error = diagnosticError;
      }
    }
    if (stageRetryable(stageFailureKind(error)) && !pacingVisibilityContinuous(metadata, partial.failureQuery))
      error = stageUnitFailure('visibility', 'pacing character lost visibility', partial);
    error.pacingEvidence = partial;
    throw error;
  }
}

export async function collectStageEvidence(deps, { sizes = SIZES, identity = null, resumeEvidence, targetStress = false,
  retryFailed = false, controlLayout = 'single/1', now = () => new Date().toISOString() } = {}) {
  let evidence, progress, segment, activeRound, activeBehavior = false, activeCapture;
  const order = stageUnitOrder(sizes);
  const sortUnits = () => progress.units.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  let retryIds = new Set(), retriedBehavior = false, streak = { kind: null, count: 0 };
  const observe = () => {
    const row = activeBehavior ? segment.behavior : activeCapture ? segment.captures[activeCapture] : segment?.rounds[activeRound];
    if (!row || !deps.observeQualification) return;
    const observed = deps.observeQualification();
    row.loadLost ||= !Number.isFinite(observed.loadAverageMax) || observed.loadAverageMax < 0;
    row.loadAverageMax = row.loadLost ? null : Math.max(row.loadAverageMax ?? 0, observed.loadAverageMax);
    row.puddleWindowHeld = row.puddleWindowHeld === true || observed.puddleWindowHeld === true ? true : observed.puddleWindowHeld;
  };
  const checkpoint = async () => { observe(); sealStageEvidence(evidence); await deps.checkpoint?.(evidence); };
  const unit = async (id, collect, save) => {
    if (progress.excluded?.some(row => row.unit === id)) return;
    const previous = progress.units.find(row => row.id === id);
    if (previous && !retryIds.delete(id)) return;
    deps.checkRun?.();
    const attempt = stageAttemptNumber(progress, id) + 1;
    if (stageFailureAttempts(progress, id) >= STAGE_MAX_ATTEMPTS) throw Object.assign(Error(`stage attempt cap reached: ${id}`), { runStop: true });
    progress.inProgress = { id, segment: segment.id, startedAt: now(), attempt };
    await checkpoint();
    let value;
    try { value = await collect(); }
    catch (error) {
      // Global stops may coincide with a failed recorder or phase. Preserve that partial payload too.
      progress.inProgress.evidence = error.pacingEvidence ?? error.unitEvidence;
      progress.inProgress.kind = stageFailureKind(error) ?? undefined;
      deps.checkRun?.(); // A simultaneous global stop always takes precedence over a local error.
      const kind = stageFailureKind(error);
      if (kind) {
        await deps.cleanupUnit?.(id);
        const failed = { ...progress.inProgress, status: 'failed', kind, error: error.message,
          attempt: progress.inProgress.attempt ?? 1, endedAt: now(),
          evidence: error.pacingEvidence ?? error.unitEvidence,
          dataDigest: stageUnitDigest(evidence, id) };
        const { evidence: payload, ...failedUnit } = failed;
        if (previous) progress.units[progress.units.indexOf(previous)] = failedUnit; else { progress.units.push(failedUnit); sortUnits(); }
        progress.attempts.push({ ...failedUnit, evidence: payload }); delete progress.inProgress;
        if (activeBehavior) { observe(); segment.behavior.endedAt = now(); }
        const group = stageFailureGroup(id);
        if (streak.group !== group) streak = { kind, count: streak.kind === kind ? Math.min(STAGE_FAILURE_BUDGET, streak.count + 1) : 1, group };
        segment.failureStreak = streak;
        await checkpoint();
        if (streak.count >= STAGE_FAILURE_BUDGET) throw Object.assign(
          Error(`stage failure budget reached: ${kind} in ${streak.count} consecutive units`), { runStop: true });
        const total = new Set(progress.attempts.filter(a => a.status === 'failed').map(a => `${a.segment}:${stageFailureGroup(a.id)}`)).size;
        if (total >= STAGE_TOTAL_FAILURE_BUDGET) throw Object.assign(
          Error(`stage total failure budget reached: ${total} failed units or trials`), { runStop: true });
        return;
      }
      // Recorder failures remain evidence, but are incomplete arms. Keep the failed attempt when retrying it.
      if (error.pacingEvidence) { if (!previous) save(error.pacingEvidence); progress.inProgress.evidence = error.pacingEvidence; await checkpoint(); }
      throw error;
    }
    deps.checkRun?.();
    save(value);
    const completed = { ...progress.inProgress, endedAt: now(), dataDigest: stageUnitDigest(evidence, id) };
    if (previous) progress.units[progress.units.indexOf(previous)] = completed; else { progress.units.push(completed); sortUnits(); }
    delete progress.inProgress;
    if (!id.includes('/pacing/') || streak.group !== stageFailureGroup(id)) streak = { kind: null, count: 0 }; segment.failureStreak = streak;
    await checkpoint();
  };
  try {
    const machine = await deps.machine();
    if (resumeEvidence !== undefined) {
      validateStageResume(resumeEvidence, { identity, sizes, targetStress, controlLayout });
      evidence = structuredClone(resumeEvidence);
    } else evidence = { schema: 'sleight.stage-cost/1', machine, runs: [], behavior: {}, captures: [],
      collection: { schema: 'sleight.stage-progress/1', identity, machineDigest: stageMachineDigest(machine), sizes, targetStress, controlLayout, segments: [], units: [], attempts: [] } };
    progress = evidence.collection;
    const lifetimeFailures = new Set(progress.attempts.filter(a => a.status === 'failed')
      .map(a => `${a.segment}:${stageFailureGroup(a.id)}`)).size;
    if (lifetimeFailures >= STAGE_TOTAL_FAILURE_BUDGET) throw Object.assign(
      Error(`stage total failure budget reached: ${lifetimeFailures} failed units or trials`), { runStop: true });
    discardUnfinishedBehavior(evidence);
    discardUnobservedRound(evidence);
    discardInterruptedUnit(evidence);
    excludeStageInterruptedUnits(evidence);
    retryIds = new Set(retryFailed ? progress.units.filter(unit => unit.status === 'failed' && stageRetryable(unit.kind) &&
      !progress.attempts.some(a => a.id === unit.id && a.kind && !stageRetryable(a.kind)) &&
      stageFailureAttempts(progress, unit.id) < STAGE_MAX_ATTEMPTS).map(unit => unit.id) : []);
    // A phase owns its hidden control. Recollect every arm of an interrupted or retried pacing trial.
    const retrySeeds = [...retryIds, ...progress.attempts.filter(a => a.interrupted && !a.discarded &&
      !progress.excluded?.some(row => row.unit === a.id) &&
      !progress.units.some(u => u.id === a.id && u.attempt > a.attempt)).map(a => a.id)];
    for (const id of retrySeeds) {
      const parts = id.split('/');
      const group = parts[2] === 'pacing' ? order.filter(other => stageFailureGroup(other) === stageFailureGroup(id)) :
        [];
      if (!group.length) continue;
      if (group.some(member => progress.excluded?.some(row => row.unit === member) || stageFailureAttempts(progress, member) >= STAGE_MAX_ATTEMPTS ||
          progress.attempts.some(a => a.id === member && a.kind && !stageRetryable(a.kind)))) {
        for (const member of group) retryIds.delete(member);
        continue;
      }
      archiveStageUnits(evidence, group, 'whole pacing trial retry');
      for (const member of group) retryIds.add(member);
    }
    retriedBehavior = retryIds.has('behavior');
    streak = progress.segments.at(-1)?.failureStreak ?? streak;
    delete evidence.error;
    segment = { id: progress.segments.length + 1, startedAt: now(), endedAt: null, rounds: {}, failureStreak: streak };
    progress.segments.push(segment); await checkpoint();
    if (!progress.excluded?.some(row => row.unit === 'behavior') &&
        (!progress.units.some(unit => unit.id === 'behavior') || retryIds.has('behavior'))) {
      activeBehavior = true;
      segment.behavior = { startedAt: now(), endedAt: null, loadAverageMax: null, puddleWindowHeld: null };
      await unit('behavior', deps.behavior, value => {
        evidence.behavior = value; observe(); segment.behavior.endedAt = now();
      });
      activeBehavior = false;
    }
    for (let round = 1; round <= 3; round++) {
      if (progress.units.some(row => row.id === `round/${round}/qualification`) &&
          !(round === 1 && retriedBehavior) && ![...retryIds].some(id => id.startsWith(`round/${round}/`))) continue;
      activeRound = round;
      segment.rounds[round] = { startedAt: now(), endedAt: null, loadAverageMax: null, puddleWindowHeld: null };
      let run = evidence.runs.find(run => run.round === round);
      if (!run) { run = { round, baselines: {}, sizes: Object.fromEntries(sizes.map(size => [size, { phases: {}, dump: {}, pacing: [] }])) };
        evidence.runs.push(run); evidence.runs.sort((a, b) => a.round - b.round); }
      deps.roundStart?.(round);
      const prefix = `round/${round}`;
      for (const surface of SURFACES) {
        await unit(`${prefix}/baseline/${surface}/before`, () => deps.baseline(surface), value => {
          const after = run.baselines[surface]?.[1]; run.baselines[surface] = after === undefined ? [value] : [value, after];
        });
        for (const size of sizes) {
          await unit(`${prefix}/phase/${size}/${surface}`, () => deps.phase(size, surface), phase => {
            if ((phase.figures?.control?.layout ?? 'single/1') !== controlLayout)
              throw Error('ST9 control layout differs from bank');
            run.sizes[size].phases[surface] = phase.figures;
            if (phase.samples) (run.sizes[size].samples ??= {})[surface] = phase.samples;
            if (phase.replay) (run.sizes[size].replays ??= {})[surface] = phase.replay;
            if (phase.marks) (run.sizes[size].marks ??= {})[surface] = phase.marks;
            if (phase.queueProbe) (run.sizes[size].queueProbes ??= {})[surface] = phase.queueProbe;
            if (phase.visibility) (run.sizes[size].visibility ??= {})[surface] = phase.visibility;
            if (phase.surfaceCheck) (run.sizes[size].surfaceChecks ??= {})[surface] = phase.surfaceCheck;
            if (phase.rendererWindows) (run.sizes[size].rendererWindows ??= {})[surface] = phase.rendererWindows;
            if (phase.invalidVisibility) (run.sizes[size].invalidVisibility ??= {})[surface] = phase.invalidVisibility;
            (run.sizes[size].rendererDiagnostics ??= {})[surface] = phase.dump ?? {};
            run.sizes[size].dump = Object.values(run.sizes[size].rendererDiagnostics).reduce(mergeDumps, {});
          });
        }
        await unit(`${prefix}/baseline/${surface}/after`, () => deps.baseline(surface), value => { (run.baselines[surface] ??= [null])[1] = value; });
      }
      for (const size of sizes) for (const hz of [60, 120]) for (const ms of [600, 400]) {
        const rows = run.sizes[size].pacing;
        let result = rows.find(row => row.requestedHz === hz && row.durationMs === ms);
        for (const [source, recorderMode] of [['character', 'hash'], ['numbered', 'hash'], ['character', 'timestamps'], ['numbered', 'timestamps']]) {
          await unit(`${prefix}/pacing/${size}/${hz}/${ms}/${source}/${recorderMode}`,
            () => deps.pacing(size, hz, ms, { source, recorderMode }), value => {
              if (source === 'character' && recorderMode === 'hash') {
                const next = { ...value, ...result?.calibration ? { calibration: result.calibration } : {},
                  ...result?.timestampsOnly ? { timestampsOnly: result.timestampsOnly } : {} };
                if (result) rows[rows.indexOf(result)] = next; else rows.push(next);
                result = next;
              } else {
                if (!result) { result = { requestedHz: hz, durationMs: ms, unitPlaceholder: true }; rows.push(result); }
                if (source === 'numbered' && recorderMode === 'hash') result.calibration = { ...value,
                  ...result.calibration?.timestampsOnly ? { timestampsOnly: result.calibration.timestampsOnly } : {} };
                else if (source === 'character') result.timestampsOnly = value;
                else (result.calibration ??= { unitPlaceholder: true }).timestampsOnly = value;
              }
            });
        }
        const trialUnits = progress.units.filter(u => stageFailureGroup(u.id) === `${prefix}/pacing/${size}/${hz}/${ms}`);
        if (trialUnits.length === 4 && trialUnits.every(u => u.status !== 'failed' && u.segment === segment.id)) {
          streak = { kind: null, count: 0 }; segment.failureStreak = streak;
          await checkpoint();
        }
      }
      await unit(`${prefix}/qualification`, deps.qualification, value => {
        observe();
        if (!deps.observeQualification) Object.assign(segment.rounds[round], value);
        segment.rounds[round].endedAt = now();
        Object.assign(run, roundQualification(progress.segments, round));
      });
      // Retried units add a load window even when this round already had a qualification unit.
      observe(); segment.rounds[round].endedAt = now();
      Object.assign(run, roundQualification(progress.segments, round));
      const qualified = progress.units.find(unit => unit.id === `${prefix}/qualification`);
      if (qualified) qualified.dataDigest = stageUnitDigest(evidence, qualified.id);
      await checkpoint();
      activeRound = undefined;
    }
    // H5 qualifies full-stage seats. A small- or medium-only cost pass leaves capture exclusion unmeasured.
    // An H5 unit is one complete seat: its baselines, both modes, all samples and drift check share one fixture.
    for (const seat of sizes.includes('stage') ? ['edge-lie', 'front-sit'] : []) {
      if (progress.units.some(u => u.id === `capture/${seat}`) && !retryIds.has(`capture/${seat}`)) continue;
      activeCapture = seat; deps.roundStart?.();
      (segment.captures ??= {})[seat] = { startedAt: now(), endedAt: null, loadAverageMax: null, puddleWindowHeld: null };
      await unit(`capture/${seat}`, () => deps.capture(seat), value => { evidence.captures.push(value); });
      observe(); segment.captures[seat].endedAt = now(); activeCapture = undefined;
      await checkpoint();
    }
    await deps.finished?.();
    segment.endedAt = now(); await checkpoint();
    deps.summary?.(stageCollectionSummary(evidence));
    return evidence;
  } catch (error) {
    if (segment) {
      observe();
      if (activeBehavior) segment.behavior.endedAt = now();
      if (activeCapture) segment.captures[activeCapture].endedAt = now();
      if (activeRound) {
        if (!deps.observeQualification) {
          try { Object.assign(segment.rounds[activeRound], await deps.qualification()); }
          catch { /* Preserve the collection error and leave unknown qualification unqualified. */ }
        }
        segment.rounds[activeRound].endedAt = now();
      }
      if (progress.inProgress) Object.assign(progress.inProgress, { endedAt: now(), error: error.message });
      segment.endedAt = now(); segment.error = error.message;
      excludeStageInterruptedUnits(evidence);
      evidence.error = error.message; await checkpoint();
      error.stageSummary = stageCollectionSummary(evidence); deps.summary?.(error.stageSummary);
    }
    throw error;
  } finally { await deps.close(); }
}
// Four distinct 2x strips, 6 cells each (14.625 MiB decoded together). Every stage state resolves through the real loader.
export function installStageCharacter(base) {
  const root = realpathSync(mkdtempSync(join(base, 'stage-characters-'))), folder = join(root, 'stage-fixture');
  mkdirSync(join(folder, 'stage'), { recursive: true, mode: 0o700 });
  const sheet = syntheticSheet({ cell: { width: 192, height: 208 } });
  writeFileSync(join(folder, 'sheet.png'), encodePng(sheet.width, sheet.height, sheet.data), { mode: 0o600 });
  const strip = syntheticSheet({ cell: { width: 384, height: 416 }, frames: 6 });
  // The encoder uses eight columns; a stage strip has exactly the declared six.
  const pixels = new Uint8Array(384 * 6 * 416 * 4);
  for (let y = 0; y < 416; y++) pixels.set(strip.data.subarray(y * strip.width * 4, (y * strip.width + 384 * 6) * 4), y * 384 * 6 * 4);
  for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(folder, 'stage', `${name}.png`), encodePng(2304, 416, pixels), { mode: 0o600 });
  const names = ['lie', 'lie-reach', 'lie-peek', 'sleep', 'sit', 'sit-notes', 'wait', 'cheer', 'hang', 'hang-peek', 'climb', 'stand', 'point', 'carry', 'wince', 'handoff', 'paused', 'leap', 'run', 'startle', 'think'];
  const manifest = { format: 'sleight-character', version: 1, id: 'stage-fixture', name: 'Stage fixture', description: '', author: 'sleight', license: 'MIT',
    sheet: 'sheet.png', frame: { w: 192, h: 208 }, grid: { cols: 8, rows: 1 }, anchor: { x: 96, y: 208 }, hotspot: { x: 96, y: 104 },
    states: { idle: { row: 0, frames: 8, ms: 100, loop: true } },
    stage: { cell: { w: 384, h: 416 }, anchor: { x: 192, y: 416 }, states: Object.fromEntries(names.map((name, i) =>
      [`stage-${name}`, { file: `stage/${['a', 'b', 'c', 'd'][i % 4]}.png`, frames: 6, ms: 100, loop: true, next: [] }])) } };
  writeFileSync(join(folder, 'character.json'), JSON.stringify(manifest), { mode: 0o600 });
  const pack = loadCharacter(folder);
  return { root, folder, frame: characterFrame(pack, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates }) };
}

export function prepareStageCharacter(work, source) {
  if (!source) {
    const character = installStageCharacter(work);
    return { ...character, identity: stageCharacterIdentity(loadCharacter(character.folder), 'synthetic') };
  }
  const pack = loadCharacter(source);
  if (!pack.manifest.stage) throw Error('--character requires a pack with stage art');
  const files = new Map(pack.files), identity = stageCharacterIdentity(pack, 'supplied pack');
  // A private benchmark id permits testing built-in art without bypassing or changing the installed built-in pins.
  files.set('character.json', Buffer.from(JSON.stringify({ ...JSON.parse(files.get('character.json')), id: 'stage-bench-art' })));
  const root = realpathSync(mkdtempSync(join(work, 'stage-art-'))), folder = installCharacter({ files }, { root });
  const copied = loadCharacter(folder);
  return { root, folder, identity, frame: characterFrame(copied, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates }) };
}
export function stageCharacterIdentity(pack, kind) {
  const hash = createHash('sha256');
  for (const [name, bytes] of [...pack.files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name + '\0').update(bytes);
  return { kind, id: pack.manifest.id, sha256: hash.digest('hex') };
}
export async function stageMachineId({ executeFile = execute } = {}) {
  const { stdout } = await executeFile('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
    { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1 << 20 });
  const uuid = /"IOPlatformUUID"\s*=\s*"([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})"/i.exec(stdout)?.[1];
  if (!uuid) throw Error('ST9 cannot establish this machine identity');
  return createHash('sha256').update(uuid.toLowerCase()).digest('hex');
}

export function stageCostSource(source) {
  const marker = '    let tracked = spriteTrack(pid)';
  if (source.split(marker).length !== 2) throw Error('Stage microphone spawn observation seam changed');
  const snapshot = 'CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]';
  if (source.split(snapshot).length !== 9) throw Error('Stage fixture window snapshot seam changed');
  const badge = 'host?.showCharacterBadge(body, after: plan.duration,';
  if (source.split(badge).length !== 2) throw Error('Stage badge delay seam changed');
  return source.replace(marker, '    stageBenchRecordQuerySpawn(pid)\n' + marker)
    .replaceAll(snapshot, `stageBenchWorldSnapshot(${snapshot})`)
    .replace(badge, 'host?.showCharacterBadge(body, after: stageBenchBadgeDelay(plan.duration),');
}
export async function buildStageBench(work, { executeFile = execute } = {}) {
  const main = join(work, 'main.swift'), bundle = join(work, 'StageCost.app'), binary = join(bundle, 'Contents/MacOS/consent-host');
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>consent-host</string><key>CFBundleIdentifier</key><string>dev.sleight.stage-cost</string><key>CFBundleName</key><string>sleight stage fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
  writeFileSync(main, privateStageHome(stageCostSource(readFileSync(HOST_SOURCE, 'utf8')), work), { mode: 0o600 });
  const { swiftModuleCache } = await import('../swift-cache.mjs');
  await executeFile('/usr/bin/xcrun', helperCompileArgs('consent-host', {
    sources: [main, join(ROOT, 'bench/hand/stage-fixture.swift')], binary, moduleCache: swiftModuleCache(),
    settingsFlags: ['-D', 'SLEIGHT_STAGE_BENCH'],
  }), { timeout: 300000, maxBuffer: 4 << 20 });
  return binary;
}

// A bounded JSON-lines child. Every owner is awaited on close, including startup and protocol errors.
export function jsonChild(binary, args, env = {}, { spawnChild = spawn, failureKind = 'child' } = {}) {
  const child = spawnChild(binary, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const rows = [], waiters = new Set(); let buffer = '', stderr = '', ended, launchError;
  child.stdin.on('error', () => {});
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  const exited = new Promise(resolve => {
    child.once('error', error => { launchError = error; ended = stageUnitFailure(failureKind, error.message, { rows, stderr }); for (const w of waiters) w(); });
    child.once('close', (code, signal) => { ended = stageUnitFailure(failureKind, `child closed ${code ?? signal}: ${stderr}`, { rows, stderr }); for (const w of waiters) w(); resolve({ code, signal, ...launchError ? { error: launchError } : {} }); });
  });
  child.stdout.on('data', b => {
    buffer += b;
    if (buffer.length > 4 << 20) {
      ended = stageUnitFailure(failureKind, 'child response exceeded buffer', { rows, stderr });
      child.stdin.end(); for (const w of waiters) w(); return;
    }
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try { rows.push(JSON.parse(line)); } catch { ended = stageUnitFailure(failureKind, 'invalid child JSON', { rows, stderr }); child.stdin.end(); }
    }
    for (const w of waiters) w();
  });
  const wait = (predicate, timeoutMs = 20000, from = 0) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(stageUnitFailure(failureKind, 'child response timed out', { rows, stderr })), timeoutMs);
    const scan = () => { const found = rows.slice(from).find(predicate); if (found) finish(null, found); else if (ended) finish(ended); };
    function finish(error, value) { clearTimeout(timer); waiters.delete(scan); error ? reject(error) : resolve(value); }
    waiters.add(scan); scan();
  });
  let closing;
  return { child, get pid() { return child.pid; }, get alive() { return !ended && child.exitCode == null && child.signalCode == null; },
    rows, wait, write: line => child.stdin.write(line),
    async request(value) { const from = rows.length; child.stdin.write(JSON.stringify(value) + '\n'); return wait(r => r.reply === value.bench, 20000, from); },
    close() { return closing ??= (async () => { child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); const result = await exited; clearTimeout(timer); return result; })(); } };
}

export async function dumpRows(binary, frame, lines, { root, reduced = false, throughRing = false, spawnChild } = {}) {
  // Use the same owned protocol child for headless and live paths.
  const child = jsonChild(binary, ['--stage-dump', ...reduced ? ['--reduce-motion'] : [], ...throughRing ? ['--through-ring'] : []], root ? characterEnv(root) : {}, { spawnChild, failureKind: 'host-crash' });
  try {
    const done = child.wait(r => r.effect === 'end', 90000);
    for (const row of [frame, ...lines]) child.write(JSON.stringify(row) + '\n');
    child.child.stdin.end(); await done;
    return child.rows;
  } finally {
    const exit = await child.close();
    if (exit.code !== 0) throw stageUnitFailure('host-crash', `stage dump exited ${exit.code ?? exit.signal}`, { rows: child.rows, exit });
  }
}

// Hide rows read the panel state after production hide dispatch. Missing state stays unmeasured.
// A hide with no visible panel beforehand proves nothing, so that receipt stays unmeasured.
export function pointerScenarioReceipt(rows, initial) {
  const hide = rows.filter(r => r.effect === 'stage-hide').at(-1);
  if (hide) {
    const recorded = typeof hide.panelOnScreen === 'boolean' ? hide.panelOnScreen : 'unmeasured';
    const panelOnScreen = initial?.panelOnScreen === true ? recorded : 'unmeasured';
    return [{ elapsedMs: Number(hide.duration) * 1000, distancePt: 0, outcome: 'hidden', panelOnScreen, reason: hide.reason ?? null }];
  }
  const p = rows.filter(r => r.effect === 'stage').at(-1);
  const distancePt = Math.abs(p.box[0] - initial.box[0]);
  return [{ elapsedMs: p.dodgeMs, distancePt, outcome: distancePt >= 120 ? 'move' : 'fade', opacity: p.opacity.at(-1)[1] }];
}

// One owned on-screen row is the panel. None means it is gone. Two rows, another pid, or a bad read stay unmeasured.
export function ownedPanelOnScreen(windows, { pid, panelID } = {}) {
  if (!Array.isArray(windows) || !Number.isSafeInteger(pid) || !Number.isSafeInteger(panelID)) return 'unmeasured';
  const sameId = [];
  for (const row of windows) if (row && row.id === panelID) sameId.push(row);
  if (sameId.length === 0) return false;
  if (sameId.length !== 1 || sameId[0].pid !== pid) return 'unmeasured';
  return true;
}

function pointerWindowState(sample, identity) {
  if (!sample || sample.error === true || sample.alive !== true || !Array.isArray(sample.windows)) return 'unmeasured';
  return ownedPanelOnScreen(sample.windows, identity);
}
function pointerBounds(sample, identity) {
  if (pointerWindowState(sample, identity) !== true) return null;
  const bounds = sample.windows.find(w => w.id === identity.panelID).bounds;
  return bounds && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(bounds[k])) &&
    bounds.width > 0 && bounds.height > 0 ? bounds : null;
}
function pointerReceiptValid(samples) {
  const receipt = samples?.receipt, input = samples?.input;
  return receipt?.reply === 'pointer' && receipt.source === 'stage-pointer-input/1' &&
    receipt.pid === samples.pid && receipt.panelID === samples.panelID &&
    typeof input?.inputID === 'string' && receipt.inputID === input.inputID &&
    Number.isSafeInteger(input.inputSeq) && input.inputSeq > 0 && receipt.inputSeq === input.inputSeq &&
    Array.isArray(input.position) && input.position.length === 2 && input.position.every(Number.isFinite) &&
    Array.isArray(receipt.position) && receipt.position.length === 2 && receipt.position.every((n, i) => n === input.position[i]) &&
    Number.isFinite(receipt.inputHostMs) && Number.isFinite(receipt.completedHostMs) &&
    receipt.inputHostMs >= samples.before?.hostTimeMs && receipt.completedHostMs >= receipt.inputHostMs &&
    samples.after?.hostTimeMs >= receipt.completedHostMs &&
    Array.isArray(receipt.effects) && receipt.effects.length === 1;
}

// A live pointer row belongs to exactly one fixture input and its production decision. Dump rows never supply it.
export function livePointerBehavior(behavior, samples) {
  const receipt = samples?.receipt;
  const evidence = samples ?? {}, identity = { pid: samples?.pid, panelID: samples?.panelID };
  const unmeasured = () => ({ ...behavior, pointer: [{ panelOnScreen: 'unmeasured', evidence }] });
  if (!pointerReceiptValid(samples) || pointerWindowState(samples.before, identity) !== true ||
    pointerWindowState(samples.after, identity) === 'unmeasured') return unmeasured();
  const effect = receipt.effects[0], duration = effect.durationMs;
  if (!Number.isFinite(duration) || duration < 0 || duration > 20000) return unmeasured();
  const row = { outcome: effect.outcome, reason: effect.reason ?? null,
    inputSeq: receipt.inputSeq, elapsedMs: receipt.completedHostMs - receipt.inputHostMs,
    windowQueryMs: samples.after.windowQueryMs, evidence };
  if (effect.outcome === 'hidden') {
    if (effect.reason !== 'pointer-covered' || duration !== 0) return unmeasured();
    row.panelOnScreen = pointerWindowState(samples.after, identity);
  } else if (effect.outcome === 'move') {
    const before = pointerBounds(samples.before, identity), after = pointerBounds(samples.after, identity),
      settled = pointerBounds(samples.settled, identity);
    if (effect.reason !== 'pointer-near' || effect.inputSeq !== receipt.inputSeq) return unmeasured();
    if (!before || !after || before.x === after.x && before.y === after.y ||
      !settled || settled.x !== after.x || settled.y !== after.y ||
      samples.settled.hostTimeMs - receipt.completedHostMs < duration) return unmeasured();
    row.distancePt = Math.hypot(after.x - before.x, after.y - before.y);
    row.panelOnScreen = pointerWindowState(samples.after, identity);
  } else if (effect.outcome === 'fade') {
    // Production pointer-covered hides are immediate. A draw fade has no pointer cause and stays listed.
    return { ...unmeasured(), pointer: [{ panelOnScreen: 'unmeasured', evidence,
      notApplicable: 'A draw fade with null reason does not measure the pointer decision bar.' }] };
  } else return unmeasured();
  return { ...behavior, pointer: [row] };
}

// capture.swift supplies only on-screen windows. Observer timings never replace the host decision interval.
export async function readLivePointerSamples({ helper, snapshot, session, input, between, wait = sleep, clock = () => performance.now() } = {}) {
  if (typeof between !== 'function') throw Error('live pointer samples require between to drive the pointer input');
  const read = async () => {
    try {
      const queryStarted = clock(), result = await helper(['windows']), windowQueryMs = clock() - queryStarted;
      const status = await session.request({ bench: 'query' });
      if (!result || !Array.isArray(result.windows) || session.alive !== true || status.pid !== session.pid ||
        status.reply !== 'query' || !Number.isFinite(status.hostTimeMs)) return { error: true, alive: false };
      return { windows: result.windows, alive: true, hostTimeMs: status.hostTimeMs, windowQueryMs };
    } catch { return { error: true, alive: false }; }
  };
  const samples = { pid: session?.pid, panelID: snapshot?.panelID, input, before: await read() };
  if (pointerWindowState(samples.before, samples) !== true) return samples;
  try { samples.receipt = await between(); }
  catch (error) { return { ...samples, error: String(error.message) }; }
  const effect = samples.receipt?.effects?.[0];
  // A dodge pops to its new origin at dispatch. Check it before waiting for the opacity animation.
  samples.after = await read();
  if (effect?.outcome === 'move' && Number.isFinite(effect.durationMs) && effect.durationMs >= 0 && effect.durationMs <= 20000) {
    await wait(effect.durationMs);
    samples.settled = await read();
  }
  return samples;
}

const pointerInputSequences = new WeakMap();
export async function collectLivePointerBehavior(behavior, { helper, session, snapshot, wait = sleep, clock }) {
  const inputSeq = (pointerInputSequences.get(session) ?? 0) + 1;
  pointerInputSequences.set(session, inputSeq);
  const input = { bench: 'pointer', inputID: randomBytes(16).toString('hex'), inputSeq, position: snapshot.pointerTarget };
  const samples = await readLivePointerSamples({ helper, session, snapshot, input, wait, clock,
    between: () => session.request(input) });
  return livePointerBehavior(behavior, samples);
}

export async function collectDumpBehavior(binary, character, { root, spawnChild } = {}) {
  let seq = 1;
  const frame = { ...character, nonce: 'a'.repeat(64), seq: 0, size: 'stage', stageAttention: true };
  // Geometry-only ST4 mode deliberately uses medium A2 art, exactly as its own fuzz does. No image decode is claimed.
  delete frame.stage;
  const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false, hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
  const keys = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
  frame.perch = { anchor: [96, 208], table: Object.fromEntries(keys.map(k => [k, entry])) };
  const win = (bounds = [200, 500, 900, 350], more = {}) => ({ id: 7, pid: 42, frame: bounds, ...more });
  const world = (windows = [win()], more = {}) => ({ dumpWorld: { windows,
    displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
    pointer: [1750, 1150], inputAge: 20, pointerAway: 10, person: [1450, 700, 300, 300], cards: [], ...more } });
  const aim = (at = [650, 700], more = {}) => ({ hand: 'aim', nonce: frame.nonce, seq: seq++, kind: 'click', pid: 42, windowId: 7, at, ...more });
  const run = (lines, extra = {}, reduced = false) => dumpRows(binary, { ...frame, ...extra }, [{ dumpStageArt: true }, ...lines], { root, reduced, spawnChild });
  const lastDraw = rows => rows.filter(r => r.effect === 'stage').at(-1);
  const fixtures = placementFixtures(), aims = fixtures.map(f => aim(f.aim, f.aimRect ? { rect: f.aimRect } : {}));
  const rows = await run(fixtures.flatMap((f, i) => [{ dumpReset: true }, world([
    ...f.above.map((r, j) => ({ id: j + 8, pid: 55, frame: r })), win(f.target)], {
    pointer: f.pointer, person: f.person, displays: [{ frame: f.display, visible: f.display }],
  }), aims[i]]));
  const bySeq = new Map(rows.filter(r => r.effect === 'stage').map(r => [r.seq, r]));
  const placements = fixtures.map((f, i) => placementObservation(f, bySeq.get(aims[i].seq)));
  const initial = lastDraw(await run([world(), aim()], { stageAttention: false }));
  const pointerRows = await run([world(), aim(), { dumpClock: 1 }, world([win()], {
    pointer: [initial.box[0] + 1, initial.box[1] + 80], inputAge: 0 })], { stageAttention: false });
  const pointer = pointerScenarioReceipt(pointerRows, initial);
  const hides = [];
  for (const [event, change] of [['move', world([win([210, 500, 900, 350])])], ['space', world([win(undefined, { onScreen: false })])],
    ['minimized', world([win(undefined, { minimized: true })])], ['gone', world([])], ['full-screen', world([win([0, 0, 1800, 1200], { fullScreen: true })])]]) {
    const rows = await run([world(), aim(), { dumpClock: 1 }, change, { dumpStats: true }]);
    const hidden = rows.filter(r => r.effect === 'stage-hide').at(-1);
    const stats = rows.findLast(r => r.effect === 'stage-stats');
    const expanded = r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96];
    hides.push({ event, hidden: !!hidden, elapsedMs: hidden ? hidden.duration * 1000 : ['move', 'space', 'minimized', 'gone'].includes(event) && stats?.shown ? Math.max(0, (stats.time - 1) * 1000) : null,
      ...['move', 'space', 'minimized', 'gone'].includes(event) && stats?.shown ? { protection: { window: { pid: 42, id: 7 }, wideWindows: stats.wideWindows,
        required: [expanded(event === 'move' ? [210, 500, 900, 350] : [200, 500, 900, 350]), expanded([650, 700, 0, 0])],
        forbidden: stats.forbidden, panel: stats.presented?.panel ?? null } } : {} });
  }
  const tight = win([300, 30, 900, 1000]);
  const blocked = more => world([tight], { person: [1500, 100, 200, 600], cards: [[0, 30, 300, 1140], [1200, 30, 600, 1140]], ...more });
  const frontSit = [];
  for (const event of ['person-window', 'pointer-near', 'pointer-recent', 'asleep', 'locked']) {
    const change = event === 'person-window' ? blocked({ person: tight.frame }) : event === 'pointer-near' ? blocked({ pointer: [500, 100] }) :
      event === 'pointer-recent' ? blocked({ pointerAway: 0 }) : { dumpActivity: { [event === 'asleep' ? 'sleeping' : 'locked']: true } };
    const rows = await run([blocked(), aim([350, 200]), { dumpClock: 1 }, change], { stageFrontSit: true });
    const start = rows.find(r => r.effect === 'stage');
    const end = rows.at(-1), draw = lastDraw(rows);
    frontSit.push({ event, started: start?.seat.kind, seat: end.shown ? draw?.seat.kind : 'hidden',
      elapsedMs: end.shown ? Math.max(...draw.opacity.map(p => p[0])) * 1000 : (rows.filter(r => r.effect === 'stage-hide').at(-1)?.duration ?? 0) * 1000 });
  }
  const reduced = (await run([world(), aim(), { dumpClock: 1 }, aim([1000, 700])], {}, true)).filter(r => r.effect === 'stage').map(r => ({ positionValues: r.positions.length }));
  const ladder = [];
  for (const [width, freeWidth] of [[700, 400], [500, 250], [300, 200], [150, 120], [40, 40]]) {
    const left = 300 + width / 2 - freeWidth / 2, right = left + freeWidth;
    const draw = lastDraw(await run([world([win([300, 400, width, 350])], { person: [300, 400, width, 350],
      cards: [[0, 25, left, 800], [right, 25, 1440 - right, 800]],
      displays: [{ frame: [0, 0, 1440, 900], visible: [0, 25, 1440, 800] }] }), aim([350, 700])]));
    ladder.push({ width, level: draw?.rung === 'three-quarter' ? 'stage-0.75' : draw?.rung ?? 'hidden' });
  }
  const attentionRows = await run([world(), aim(), { dumpClock: 1 }, world([win()], { inputAge: 0 }), { dumpClock: 9 }]);
  const attention = attentionRows.filter(r => r.effect === 'stage').slice(-2).map((r, i) => ({ inputAgeS: i ? 8 : 0, size: r.rung }));
  const sleepLock = [];
  for (const [event, flag] of [['sleep', 'sleeping'], ['lock', 'locked']]) {
    const rows = await run([world(), aim(), { dumpActivity: { [flag]: true } }]);
    sleepLock.push({ event, animations: rows.at(-1).animations });
  }
  return { placements, pointer, hides, frontSit, reduced, ladder, attention, sleepLock,
    turnReplay: await replayStageSequence(binary, character, { root, spawnChild }),
    targetStressReplay: await replayStageSequence(binary, character, { root, spawnChild, stress: true }) };
}

export async function replayStageSequence(binary, character, { root, spawnChild, stress = false } = {}) {
  const windows = [{ pid: 42, id: 7, bounds: { x: 30, y: 592, width: 967.68, height: 350 } },
    { pid: 42, id: 8, bounds: { x: 1010, y: 592, width: 470, height: 350 } }];
  const sequence = stageSequence(windows, { stress }), wire = stageWire('a'.repeat(64));
  const frame = JSON.parse(wire.character(character));
  const rows = await dumpRows(binary, frame, [{ dumpStageArt: true }, { dumpWorld: {
    windows: windows.map(w => ({ id: w.id, pid: w.pid, frame: [w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height] })),
    displays: [{ frame: [0, 0, 1512, 982], visible: [0, 33, 1512, 949] }],
    person: [1272, 33, 220, 122], pointer: [1508, 975], inputAge: 20, pointerAway: 10, cards: [],
  } }, ...sequence.steps.flatMap(step => [{ dumpClock: step.atMs / 1000 }, JSON.parse(wire[step.type](step.args)), { dumpStats: true }]),
  { dumpClock: 66 }, { dumpStats: true }], { root, spawnChild, throughRing: true });
  return { scenario: sequence.scenario, scrollRectPt: sequence.scrollRectPt, expected: sequence.expected ?? null,
    actions: sequence.steps.filter(s => s.type === 'act').length, throughRing: true, geometryOnly: true, callActive: false,
    samples: replayObservations(rows) };
}

export async function replayStageTrace(binary, receipt, { root, spawnChild } = {}) {
  const [frame, ...lines] = stageReplayLines(receipt);
  const rows = await dumpRows(binary, frame, lines, { root, spawnChild });
  const trace = rows.find(r => r.effect === 'stage-trace');
  if (!trace) throw Error('headless replay omitted transaction trace');
  return { ...compareStageReplay(receipt.trace, trace), figures: stageTraceFigures(trace, receipt.marks?.host ?? {}), trace, geometryOnly: true };
}

export async function verifyStageReceipt(binary, receipt, options = {}) {
  try {
    const exactReplay = await replayStageTrace(binary, receipt, options);
    return { ...receipt, exactReplay: { reproduced: exactReplay.reproduced, transactions: exactReplay.transactions,
      mismatches: exactReplay.mismatches }, ...exactReplay.reproduced ? {} : { refusal: 'exact headless replay mismatch' } };
  } catch (error) {
    return { ...receipt, exactReplay: { reproduced: false, transactions: 0, mismatches: [] }, refusal: error.message };
  }
}
export function verifyCharacterStageReceipt(binary, character, receipt, options = {}) {
  return verifyStageReceipt(binary, receipt, { ...options, root: character.root });
}

export function placementObservation(fixture, draw) {
  if (!draw) return { ...fixture, box: null, legs: null };
  const { box, legSpread, metricAnchor, metricSize } = draw;
  const valid = a => Array.isArray(a) && a.every(Number.isFinite);
  // The whole cell height conservatively encloses the legs. Never infer an empty spread from absent dump fields.
  const legs = valid(box) && box.length === 4 && valid(legSpread) && legSpread.length === 2 &&
    legSpread.every(n => n >= 0) && valid(metricAnchor) && metricAnchor.length === 2 &&
    valid(metricSize) && metricSize.length === 2 && metricSize.every(n => n > 0) ?
    [box[0] + metricAnchor[0] - legSpread[0], box[1], legSpread[0] + legSpread[1], metricSize[1]] : undefined;
  return { ...fixture, box, legs, legSpread, metricAnchor, metricSize };
}

export function rendererDump(snapshot) {
  return { cacheBytes: snapshot.peakBytes, resident2xStrips: snapshot.resident2xStrips,
    installMs: snapshot.installMs, installsPerPlan: snapshot.installsPerPlan, unplannedInstalls: snapshot.unplannedInstalls,
    planIDs: snapshot.planIDs, doubleInstalls: snapshot.doubleInstalls, installCauses: snapshot.installCauses, startupMs: snapshot.startupMs,
    firstStripDecoded: snapshot.firstStripDecoded, panels: snapshot.panels,
    decodeMs: [snapshot.maxDecodeMs],
    firstDecodeMs: snapshot.firstDecodeMs, maxDecodeMs: snapshot.maxDecodeMs, decodeSpans: snapshot.decodeSpans,
    startupTimeline: { ...snapshot.startupTimeline, firstStripReadyAtMs: snapshot.firstStripReadyAtMs },
    callMonitor: snapshot.callMonitor, hideReason: snapshot.hideReason,
    hideReasonCounts: snapshot.hideReasonCounts, maxWindowBoundsDifferencePt: snapshot.maxWindowBoundsDifferencePt,
    // Selection is nonblocking by contract; the cold/faulted queue probe supplies the observation, below.
    drawBlocked: snapshot.drawBlocked };
}

export async function startFixture(binary, character, size = 'stage', spawnChild, sampleCosts = false, control = false,
  { samplerFactory = createCostSampler, ownerAwayFile = process.env.SLEIGHT_OWNER_AWAY_FILE } = {}) {
  const args = ['--stage-bench', '--hand', ...ownerAwayFile ? ['--owner-away-file', ownerAwayFile] : []];
  const session = jsonChild(binary, args, characterEnv(character.root), { spawnChild, failureKind: 'host-crash' });
  try {
    session.ready = await session.wait(r => r.ready === true);
    if (session.ready.machine.hostNice !== 0) throw Error('measured host is not at nice 0');
    session.wire = stageWire(undefined, { size }); session.size = size;
    if (sampleCosts) {
      session.sampler = samplerFactory({ rootPid: session.pid, includeChildren: true, observe: () => session.request({ bench: 'status' }) });
      await session.sampler.start();
      session.fixtureBaseline = structuredClone(session.sampler.samples[0]);
    }
    if (control) await session.request({ bench: 'control' });
    else {
      session.write(session.wire.character(character.frame));
      await session.wait(r => r.characterReady === true, 60000);
    }
    await session.sampler?.sample();
    return session;
  } catch (error) {
    try { await session.sampler?.stop(); } finally { await session.close(); }
    throw error;
  }
}
export async function seedFixture(session, { helper, wait = sleep, clock = () => performance.now() } = {}) {
  const target = session.ready.windows[0], b = target.bounds, started = clock();
  const monitorStates = new Set(); let lastQuery; const ceiling = 3000;
  session.write(session.wire.aim({ kind: 'click', pid: target.pid, windowId: target.id, at: [b.x + b.width * 0.7, b.y + b.height * 0.7] }));
  const failure = async (kind, reason) => {
    let helperWindows, windowError;
    try { if (helper) helperWindows = (await helper(['windows'])).windows; }
    catch (error) {
      if (!stageFailureKind(error)) throw error;
      windowError = { kind: stageFailureKind(error), error: error.message };
    }
    const evidence = { lastQuery, helperWindows, windowError, monitorStates: [...monitorStates].map(JSON.parse), waitedMs: clock() - started, rows: session.rows?.filter(row => row.reply === 'query').slice(-20), queryRowCount: session.rows?.filter(row => row.reply === 'query').length ?? 0, sessionRowCount: session.rows?.length ?? 0 };
    throw stageUnitFailure(kind, `${reason}; waited ${evidence.waitedMs} ms; monitor ${lastQuery?.callMonitor?.state ?? 'unknown'}`, evidence);
  };
  for (;;) {
    lastQuery = await session.request({ bench: 'query' });
    const monitor = lastQuery.callMonitor, state = monitor?.state;
    if (state) monitorStates.add(JSON.stringify({ state, active: monitor.active, lastSuccessfulState: monitor.lastSuccessfulState, lastSuccessAgeMs: monitor.lastSuccessAgeMs }));
    if (lastQuery.shown !== true && (monitor?.active === true || monitor?.lastSuccessfulState === 'input-active'))
      return failure('microphone-active', 'microphone input active');
    if (lastQuery.panelID && lastQuery.shown === true && lastQuery.size === session.size) return lastQuery;
    if (clock() - started >= ceiling) {
      return failure('prepare-refusal', `owned fixture could not seat the requested ${session.size} character`);
    }
    await wait(Math.min(100, ceiling - (clock() - started)));
  }
}

// The caller supplies the private marker path. No private ledger path belongs in repository code.
export function stageEnvironmentCheck({ ownerAwayFile, lockIdentity, readLock = () => lstatSync('/tmp/sleight-live.lock'),
  ownerAway = () => existsSync(ownerAwayFile) }) {
  return () => {
    if (!ownerAwayFile || !ownerAway()) throw Object.assign(Error('stage owner-away marker is absent'), { runStop: true });
    let current;
    try { current = readLock(); } catch { throw Object.assign(Error('stage live-lock identity lost'), { runStop: true }); }
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino)
      throw Object.assign(Error('stage live-lock identity lost'), { runStop: true });
  };
}

// The live adapter uses this tracker; offline tests supply observations without touching the host.
export function makeStageLoadTracker({ readLoad = () => loadavg()[0], isHeld = () => existsSync('/tmp/sleight-hold'), check = () => {} } = {}) {
  let loadAverageMax = 0, puddleWindowHeld = false;
  const observe = () => ({ loadAverageMax, puddleWindowHeld });
  const qualify = () => {
    check();
    const load = readLoad();
    loadAverageMax = Number.isFinite(load) && load >= 0 && Number.isFinite(loadAverageMax) ? Math.max(loadAverageMax, load) : NaN;
    puddleWindowHeld ||= isHeld();
    if (puddleWindowHeld) throw Error('quiet window ended: /tmp/sleight-hold exists');
    return observe();
  };
  return { observe, qualify, roundStart() { loadAverageMax = 0; puddleWindowHeld = false; qualify(); } };
}
export function qualifyStageLoad(tracker) {
  const observed = tracker.qualify();
  if (!Number.isFinite(observed.loadAverageMax)) throw Object.assign(Error('stage load observations lost'), { runStop: true });
  return observed;
}

const knownChildError = error => typeof error.code === 'number' ||
  ['ENOENT', 'EACCES', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code) ||
  error.killed === true && ['SIGTERM', 'SIGKILL'].includes(error.signal);

// Parse only the capture helper's own protocol. Exceptions in the adapter remain run stops.
export function stageCaptureHelper(binary, run = execute) {
  return async args => {
    let stdout;
    try { ({ stdout } = await run(binary, args, { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 << 20 })); }
    catch (error) {
      if (!knownChildError(error)) throw error;
      throw stageUnitFailure('capture', `capture helper ${args[0]} exited: ${error.message}`, { operation: args[0], code: error.code });
    }
    let answer;
    try { answer = JSON.parse(String(stdout).trim().split('\n').at(-1) || '{}'); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error;
      throw stageUnitFailure('capture', `capture helper ${args[0]} returned invalid JSON`, { operation: args[0] }); }
    if (!answer?.ok && args[0] !== 'hit') throw stageUnitFailure('capture', `capture helper ${args[0]}: ${answer?.error ?? 'no answer'}`, answer);
    return answer;
  };
}

export async function runLiveStage(opts, { acquireLock, signal, runtime = {} } = {}) {
  const { createGuard = stageRunGuard, startPriority = startStagePriority, holdAwake = holdStageAwake,
    prepareCharacter = prepareStageCharacter, buildBench = buildStageBench, makeHelper = stageCaptureHelper,
    machineIdentity = stageMachineId, openFixture = startFixture, collectEvidence = collectStageEvidence, readPartial = readStagePartial,
    moduleCache, platform = process.platform, createWork = () => realpathSync(mkdtempSync('/private/tmp/sleight-stage-cost-')),
    readLoad = () => loadavg()[0], isHeld = () => existsSync('/tmp/sleight-hold'),
    pause = sleep, signalTarget = process, setExitCode = code => { process.exitCode = code; } } = runtime;
  // Only called by the explicit owner-away CLI path, after dry-run and evidence handling.
  if (!opts.ownerAway || platform !== 'darwin') throw Error('stage collection requires macOS and --owner-away');
  const resumeEvidence = opts.resume ? readPartial(opts.out) : undefined;
  const sizes = opts.size === 'all' ? SIZES : [opts.size];
  if (resumeEvidence) validateStageResume(resumeEvidence, { identity: resumeEvidence.collection?.identity, sizes, targetStress: opts.targetStress === true,
    controlLayout: STAGE_CONTROL_LAYOUT });
  const resumeExclusionsChanged = resumeEvidence && excludeStageInterruptedUnits(resumeEvidence);
  if (!opts.resume && (existsSync(join(opts.out, 'stage-cost.partial.json')) || existsSync(join(opts.out, 'stage-cost.json'))))
    throw Error('ST9 output already contains evidence; use --resume with the same --out');
  if (isHeld()) throw Error('/tmp/sleight-hold exists');
  const marker = opts.ownerAwayFile ?? process.env.SLEIGHT_OWNER_AWAY_FILE;
  const ownerAwayFile = marker ? resolve(marker) : undefined;
  if (!acquireLock && (!ownerAwayFile || !existsSync(ownerAwayFile))) throw Error('stage collection requires --owner-away-file with a present marker');
  const { acquireLiveLock } = await import('../live-lock.mjs');
  const unlock = await (acquireLock ?? acquireLiveLock)('/tmp/sleight-live.lock', { wait: false });
  const checkEnvironment = runtime.checkEnvironment ?? (acquireLock ? () => {} : stageEnvironmentCheck({ ownerAwayFile,
    lockIdentity: lstatSync('/tmp/sleight-live.lock') }));
  const work = createWork();
  const timing = stageRunTiming(opts);
  const guard = createGuard({ timeoutMs: timing.watchdogMs }), sessions = new Set(); let closing, priority, awake, monitor;
  const parentAbort = () => guard.abort(signal.reason ?? Error('stage parent interrupted'));
  signal?.addEventListener('abort', parentAbort, { once: true });
  if (signal?.aborted) parentAbort();
  const spawnChild = (...args) => guard.spawn(...args);
  const hostSpawn = (...args) => guard.spawn(...args, priority.spawn.bind(priority));
  const close = () => closing ??= (async () => {
    clearInterval(monitor);
    try {
      let cleanupError;
      try { await guard.close(); } catch (error) { cleanupError = error; }
      for (const session of sessions) await session.close();
      if (priority) await priority.close();
      if (cleanupError) throw cleanupError; // Keep the bank and live lock when client-group cleanup is unproved.
      rmSync(work, { recursive: true, force: true }); await unlock();
    } finally { await awake?.close(); }
  })();
  let interrupted;
  const signals = new Map((signal ? [] : [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]).map(([name, code]) =>
    [name, () => { interrupted = code; guard.abort(Error(`stage run interrupted by ${name}`)); }]));
  for (const [name, handler] of signals) signalTarget.on(name, handler);
  try {
    checkEnvironment();
    if (resumeExclusionsChanged) writeStagePartial(opts.out, resumeEvidence);
    priority = await startPriority();
    awake = holdAwake({ onUnexpectedExit: () => guard.abort(Error('sleep assertion exited during stage run')) }); await awake.ready;
    const sourceCommit = (await guard.execute('/usr/bin/git', ['-C', ROOT, 'rev-parse', 'HEAD'], { timeout: 10000, killSignal: 'SIGKILL' })).stdout.trim();
    const changed = (await guard.execute('/usr/bin/git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'], { timeout: 10000, killSignal: 'SIGKILL' })).stdout.trim();
    if (changed) throw Error('ST9 needs a clean committed source for resumable evidence');
    if (resumeEvidence && resumeEvidence.collection.identity.sourceCommit !== sourceCommit) throw Error('ST9 resume refused: source commit changed');
    const character = prepareCharacter(work, opts.character);
    if (resumeEvidence && JSON.stringify(resumeEvidence.collection.identity.character) !== JSON.stringify(character.identity))
      throw Error('ST9 resume refused: character pack digest changed');
    const machineId = await machineIdentity({ executeFile: guard.execute });
    if (resumeEvidence && resumeEvidence.collection.identity.machine.machineId !== machineId) throw Error('ST9 resume refused: machine changed');
    const binary = await buildBench(work, { executeFile: guard.execute }), helperBin = join(work, 'capture-helper'), pacingBin = join(work, 'frame-pacing');
    const { swiftModuleCache } = await import('../swift-cache.mjs');
    for (const [source, output] of [['capture.swift', helperBin], ['frame-pacing.swift', pacingBin]]) {
      await guard.execute('/usr/bin/xcrun', compileArgs(join(ROOT, 'bench/hand', source), output, moduleCache ? moduleCache() : swiftModuleCache()), { timeout: 300000 });
    }
    checkEnvironment();
    const rawHelper = makeHelper(helperBin, guard.execute);
    const helper = async args => {
      try { return await rawHelper(args); }
      catch (error) {
        guard.signal.throwIfAborted();
        if (!knownChildError(error)) throw error;
        throw stageUnitFailure('capture', error.message, { operation: args[0] });
      }
    };
    if (!(await helper(['preflight'])).screenRecording) throw Error('Screen Recording is not granted to this shell');
    const own = async (size, sampleCosts = false, control = false) => { const session = await openFixture(binary, character, size, hostSpawn, sampleCosts, control,
      { ownerAwayFile }); sessions.add(session); return session; };
    const release = async (session, partial) => {
      try { await session.sampler?.stop(); }
      finally {
        let result;
        try { result = await session.close(); }
        catch (error) { throw Object.assign(Error(`stage unit cleanup unproved: ${error.message}`), { runStop: true }); }
        sessions.delete(session);
        if (result && (result.code !== undefined && result.code !== 0 || result.signal))
          throw stageUnitFailure('host-crash', `stage fixture exited ${result.code ?? result.signal}`, { rows: session.rows, exit: result, partial });
      }
    };
    const probe = await own('stage'), machine = { ...probe.ready.machine,
      machineId, harnessNice: getPriority(),
      watchdogMs: timing.watchdogMs, runTiming: timing, sleepAssertion: stageSleepArgs(process.pid), character: character.identity }; await release(probe);
    const identity = stageIdentity(sourceCommit, character.identity, machine);
    if (resumeEvidence) validateStageResume(resumeEvidence, { identity, sizes, targetStress: opts.targetStress === true, controlLayout: STAGE_CONTROL_LAYOUT });
    const loadTracker = makeStageLoadTracker({ readLoad, isHeld, check: () => {
      checkEnvironment();
      guard.signal.throwIfAborted(); if (awake.ended) throw Error('sleep assertion exited during stage run');
    } });
    const qualify = () => qualifyStageLoad(loadTracker);
    monitor = setInterval(() => { try { qualify(); } catch (error) { guard.abort(error); } }, 1000);
    monitor.unref?.();
    const wait = async ms => { for (let remaining = ms; remaining > 0; remaining -= 1000) { qualify(); await pause(Math.min(1000, remaining)); } };
    const hiddenControl = async (surface, size) => {
      qualify();
      let control;
        const hidden = await own(size, true, true);
        try {
          await hidden.request({ bench: 'surface', changing: surface === 'changing' });
          control = await stageMeasurementBoundary('fixture-seat', () => collectHiddenControl({ session: hidden,
            sequence: stageSequence(hidden.ready.windows, { stress: opts.targetStress === true }), wait, surface, size,
            checkSurface: boundary => stageMeasuredSurface({ session: hidden, helper, surface, requiresPanel: false, boundary }) }));
          return control;
        } catch (error) {
          error.unitEvidence = { ...error.unitEvidence, control: control ?? { samples: hidden.sampler.samples, rows: hidden.rows } };
          throw error;
        } finally { await release(hidden, { control, samples: hidden.sampler.samples, rows: hidden.rows }); }
    };
    const measurePhase = async (surface, size) => {
      qualify(); console.log(`ST9 ${surface} ${size ?? 'baseline'}`);
      const session = await own(size ?? 'stage', true);
      const sampler = session.sampler;
      const visibility = [];
      let invalidVisibility;
      const phaseWait = async ms => {
        for (let remaining = ms; remaining > 0; remaining -= 1000) {
          qualify();
          const status = await session.request({ bench: 'status' }); recordPhaseVisibility(visibility, status, size);
          await pause(Math.min(1000, remaining));
        }
      };
      try {
        await session.request({ bench: 'surface', changing: surface === 'changing' });
        if (!size) {
          const surfaceChecks = [await stageMeasuredSurface({ session, helper, surface, requiresPanel: false, boundary: 'active-start' })];
          const start = Date.now(); await wait(62000); await sampler.stop();
          surfaceChecks.push(await stageMeasuredSurface({ session, helper, surface, requiresPanel: false, boundary: 'active-end' }));
          const baseline = summarize(sampler.samples, { from: start, peakSamplePeriodMs: 1000 });
          return { activeS: baseline.wallS, wsAvgPct: baseline.windowServer?.avgPct, wsPeakPct: baseline.windowServer?.peakPct, surfaceChecks };
        }
        await seedFixture(session, { helper, wait });
        const surfaceChecks = [], checkSurface = async boundary => {
          const check = await stageMeasuredSurface({ session, helper, surface, requiresPanel: true, boundary });
          surfaceChecks.push(check); return check;
        };
        await checkSurface('active-start');
        await sampler.sample();
        const sequence = stageSequence(session.ready.windows, { stress: opts.targetStress === true }),
          startSample = sampler.samples.length - 1, start = sampler.samples[startSample].t;
        const actions = [];
        let activeEnd, idleEnd, parkedStart, parkedChildren;
        try {
          await playSequence(sequence, { wire: session.wire, write: session.write, sleep: phaseWait, record: row => actions.push(row) });
          await phaseWait(Math.max(0, 61000 - (Date.now() - start)));
          await sampler.pause();
          await wait(2);
          await sampler.sample(); activeEnd = sampler.samples.at(-1).t;
          // The sequence's final done has no ok, exactly as production ends a turn before parking.
          await checkSurface('active-end');
          await session.request({ bench: 'park' });
          ({ parkedStart, idleEnd, parkedChildren } = await stageMeasurementBoundary('child', () => collectParkedInterval({ session, wait, size, checkSurface,
            recordVisibility: (status, requested, t) => recordPhaseVisibility(visibility, status, requested, t) })));
        } catch (error) { if (!error.invalidVisibility) throw error; invalidVisibility = error.invalidVisibility; }
        await session.request({ bench: 'surface', changing: false });
        await sampler.stop({ finalSample: false }); idleEnd ??= sampler.samples.at(-1).t; activeEnd ??= idleEnd;
        const statusReplyCost = await session.request({ bench: 'statusCost' });
        const snapshot = await session.request({ bench: 'query' });
        const dump = rendererDump(snapshot);
        const captured = await session.request({ bench: 'trace' });
        const hostTime = t => sampler.samples.find(s => s.t === t)?.status?.hostTimeMs / 1000;
        const host = { start: hostTime(start), end: hostTime(activeEnd),
          sampleTimes: sampler.samples.filter(s => s.t >= start && s.t <= activeEnd).map(s => s.status?.hostTimeMs / 1000) };
        let replay;
        try {
          replay = await verifyCharacterStageReceipt(binary, character, stageReplayReceipt({ frame: JSON.parse(stageWire(session.wire.nonce, { size }).character(character.frame)),
            trace: captured.trace, scenario: sequence.scenario, actions, marks: { start, activeEnd, idleEnd, host } }), { spawnChild });
        } catch (error) {
          // Preserve every cost result even if a bounded journal could not supply an exact replay.
          replay = { scenario: sequence.scenario, complete: false, refusal: error.message };
        }
        // The queue probe uses the production cache with a deliberately delayed decoder, with no windows.
        const queue = await cacheProbe(binary, character, spawnChild);
        dump.drawBlocked = queue.blocked;
        const memory = stageMemoryFigures(sampler.samples, session.fixtureBaseline, session.pid);
        const phase = { figures: { ...stagePhaseFigures(sampler.samples, { start, startSample, activeEnd, parkedStart, idleEnd }, session.pid),
          surfaceChecks, surface, size, changing: surface === 'changing', actions, windows: session.ready.windows,
          ...stageScriptReceipt(actions, session.ready.windows), statusReplyCost, parkedChildren,
          memory, peakRssMiB: memory.treePeakMiB,
          scenario: sequence.scenario, scrollRectPt: sequence.scrollRectPt, visibilityValid: !invalidVisibility && phaseVisibilityValid(visibility) && surfaceChecks.every(c => c.valid), hostNice: session.ready.machine.hostNice }, dump,
          samples: sampler.samples, marks: { start, startSample, activeEnd, parkedStart, idleEnd }, queueProbe: queue.rows, visibility, surfaceChecks,
          invalidVisibility, replay, rendererWindows: rendererWindowTimeline(sampler.samples, session.pid) };
        if (phase.figures.visibilityValid !== true) throw stageUnitFailure('visibility', 'invalid phase visibility', phase);
        return phase;
      } catch (error) {
        error.unitEvidence ??= { samples: sampler.samples, visibility, invalidVisibility, rows: session.rows };
        throw error;
      } finally { await release(session, { samples: sampler.samples, visibility, invalidVisibility }); }
    };
    const measure = (surface, size) => size ? collectBracketedPhase({
      collectControl: () => hiddenControl(surface, size), collectPhase: () => measurePhase(surface, size),
    }) : measurePhase(surface);
    const pacing = async (size, hz, ms, { source, recorderMode }) => {
      qualify();
      if (hz > machine.maximumHz) return { requestedHz: hz, maximumHz: machine.maximumHz, durationMs: ms, frames: [] };
      const session = await own(size); let recorder;
      try {
        await seedFixture(session, { helper, wait });
        const prepared = await session.request({ bench: 'prepare', durationMs: ms, hz, source });
        if (prepared.ok !== true) throw stageUnitFailure('prepare-refusal', `pacing fixture could not prepare: ${prepared.reason}`, {
          requestedHz: hz, maximumHz: machine.maximumHz, durationMs: ms, preflight: prepared });
        const snapshot = await session.request({ bench: 'query' });
        if (snapshot.shown !== true || snapshot.size !== size || !snapshot.panelID)
          throw stageUnitFailure('visibility', 'pacing character lost visibility before recording', snapshot);
        const windows = await pacingPanelWindows(session, snapshot, helper);
        recorder = jsonChild(pacingBin, ['--window', String(windows[0].id), '--pid', String(session.pid), '--hz', String(hz), '--duration-ms', String(ms), '--mode', recorderMode], {}, { spawnChild });
        return await recordPacingMotion(session, recorder, { source, recorderMode, requestedHz: hz,
          maximumHz: machine.maximumHz, durationMs: ms, motionSource: snapshot.motionSource, panelID: snapshot.panelID, shown: snapshot.shown,
          hideReason: snapshot.hideReason, hideReasonCounts: snapshot.hideReasonCounts, panelGenerations: snapshot.panelGenerations }, { helper });
      } finally {
        try { if (recorder) await recorder.close(); }
        finally { await release(session, { recorderRows: recorder?.rows, sessionRows: session.rows }); }
      }
    };
    const evidence = await collectEvidence({
      machine: async () => machine, baseline: surface => measure(surface), phase: (size, surface) => measure(surface, size), pacing,
      behavior: async () => {
        const dump = await collectDumpBehavior(binary, character.frame, { root: character.root, spawnChild });
        const session = await own('stage');
        try {
          const snapshot = await seedFixture(session, { helper, wait });
          const behavior = await collectLivePointerBehavior(dump, { helper, session, snapshot, wait });
          return { ...behavior, fallbacks: await collectFallbacks(binary, work, { spawnChild }) };
        } finally { await release(session); }
      },
      capture: seat => { qualify(); return liveStageCapture({ seat, binary, character, helper, work, own, release, signal: guard.signal,
        executeFile: guard.execute, registerCleanup: guard.onClose }); },
      finished: qualify,
      checkRun: qualify,
      cleanupUnit: async () => { for (const session of [...sessions]) await release(session); },
      summary: summary => console.log(`ST9 ${stageSummaryLine(summary)}`),
      roundStart: loadTracker.roundStart,
      observeQualification: loadTracker.observe,
      qualification: async () => qualify(),
      checkpoint: async evidence => {
        mkdirSync(opts.out, { recursive: true });
        writeStagePartial(opts.out, evidence);
      },
      close: async () => {},
    }, { sizes, identity, controlLayout: STAGE_CONTROL_LAYOUT,
      resumeEvidence, retryFailed: opts.retryFailed === true, targetStress: opts.targetStress === true });
    return evidence;
  } finally {
    signal?.removeEventListener('abort', parentAbort);
    try { await close(); } finally {
      for (const [name, handler] of signals) signalTarget.removeListener(name, handler);
      if (interrupted) setExitCode(interrupted);
    }
  }
}

export async function cacheProbe(binary, character, spawnChild) {
  const child = jsonChild(binary, ['--stage-cache-dump'], { ...characterEnv(character.root), SLEIGHT_CURSOR_STAGE_DECODE_FAULT: 'slow' }, { spawnChild, failureKind: 'host-crash' });
  try {
    const done = child.wait(r => r.effect === 'end', 60000);
    child.write(JSON.stringify(character.frame) + '\n');
    child.write(JSON.stringify({ stageState: 'stage-lie' }) + '\n');
    child.write(JSON.stringify({ stageState: 'stage-lie' }) + '\n');
    child.child.stdin.end(); await done;
    const rows = child.rows.filter(r => r.effect === 'stage');
    return { blocked: rows.length !== 2 || rows.some(r => !r.medium || r.selectMs >= 40), rows };
  } finally {
    const exit = await child.close();
    if (exit.code !== 0) throw stageUnitFailure('host-crash', `stage cache probe exited ${exit.code ?? exit.signal}`, { rows: child.rows, exit });
  }
}

export async function collectFallbacks(binary, work, { spawnChild } = {}) {
  const root = realpathSync(mkdtempSync(join(work, 'fallbacks-'))), result = [];
  const packs = ['tsugi', 'shizu', 'bit', 'kit', 'yori', 'tab', 'bit-nearest'].map(id => ({ id,
    pack: prepareFallbackPack(root, id, checkBuiltinCharacter(id === 'bit-nearest' ? 'bit' : id)) }));
  for (const version of [1, 2]) {
    const folder = join(root, `source-${version}`); mkdirSync(folder, { mode: 0o700 });
    const width = 1536, height = (version === 1 ? 9 : 11) * 208;
    const pixels = new Uint8Array(width * height * 4), counts = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
    for (let row = 0; row < height / 208; row++) for (let col = 0; col < counts[row]; col++) for (let x = 0; x < 60; x++) pixels.set([180, 90, 10, 255], ((row * 208) * width + col * 192 + x) * 4);
    writeFileSync(join(folder, 'pet.json'), JSON.stringify({ id: `pet-${version}`, displayName: 'Synthetic pet', spriteVersionNumber: version, spritesheetPath: 'spritesheet.png' }), { mode: 0o600 });
    writeFileSync(join(folder, 'spritesheet.png'), encodePng(width, height, pixels), { mode: 0o600 });
    packs.push({ id: `codex-v${version}`, pack: loadCharacter(installCharacter(prepareCharacterImport(folder), { root })) });
  }
  for (const { id, pack } of packs) {
    const frame = characterFrame(pack, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates });
    frame.size = 'stage';
    const env = { ...characterEnv(root), SLEIGHT_BUILTIN_CHARACTERS: builtinCharactersDirectory() };
    const child = jsonChild(binary, ['--stage-cache-dump'], env, { spawnChild, failureKind: 'host-crash' });
    try {
      const done = child.wait(r => r.effect === 'end', 60000);
      for (const row of [frame, ...['lie', 'sit', 'hang', 'stand', 'point', 'leap'].map(name => ({ stageState: `stage-${name}` }))]) child.write(JSON.stringify(row) + '\n');
      child.child.stdin.end(); await done;
      result.push(fallbackObservation(id, pack, child.rows));
    } finally {
      const exit = await child.close();
      if (exit.code !== 0) throw stageUnitFailure('host-crash', `stage fallback exited ${exit.code ?? exit.signal}`, { rows: child.rows, exit });
    }
  }
  return result;
}

export function prepareFallbackPack(root, id, source) {
  const files = new Map([...source.files].filter(([name]) => !name.startsWith('stage/')));
  const manifest = { ...JSON.parse(files.get('character.json')), id: `fallback-${id}` };
  delete manifest.stage;
  if (id === 'bit-nearest') manifest.stage = { cell: { w: 384, h: 416 }, anchor: { x: 192, y: 416 }, filter: 'nearest', states: {} };
  files.set('character.json', Buffer.from(JSON.stringify(manifest)));
  // Reload the actual no-strip fixture. Validation warnings and the nearest manifest survive into the observation.
  return loadCharacter(installCharacter({ files }, { root }));
}

export function fallbackObservation(id, pack, rows) {
  const stages = rows.filter(r => r.effect === 'stage');
  return { id, stageArtAvailable: pack.stage?.available, stageFilter: pack.manifest.stage?.filter ?? null,
    loaded: rows[0]?.loaded === true, size: stages.length === 6 && stages.every(r => r.medium === true) ? 'medium' : null,
    warnings: pack.warnings, raw: rows };
}

export function stageCaptureResult(report) {
  const samples = Object.values(report.modes ?? {}).flatMap(mode => mode.samples ?? []);
  if (samples.some(sample => sample.handUp === false && sample.result !== 'skipped'))
    throw stageUnitFailure('visibility', 'stage capture lost visibility', report);
  const failed = samples.find(sample => sample.error || ['error', 'skipped', 'size-changed'].includes(sample.result));
  if (failed) throw stageUnitFailure('capture', `stage capture incomplete: ${failed.error ?? failed.reason ?? failed.result}`, report);
  if (samples.some(sample => sample.handUp !== true)) throw stageUnitFailure('visibility', 'stage capture lost visibility', report);
  return report;
}

export async function liveStageCapture({ seat, binary, character, helper, work, own, release, signal, executeFile = execute, registerCleanup }) {
  signal?.throwIfAborted();
  const { runStageCaptureTest, captureCommand, readFrame, engineImage, stageCaptureRegion } = await import('./h5-capture.mjs');
  const session = own ? await own('stage') : await startFixture(binary, character, 'stage');
  let client, clientPromise, abortCleanup;
  const captureReceipts = [];
  const closeClient = async () => {
    const owned = client ?? await clientPromise?.catch(error => {
      const receipt = error.cleanupReceipt;
      if (receipt?.childCollected !== true || receipt?.groupCollected !== true) throw Error('stage capture startup cleanup unproved');
      return undefined;
    });
    if (owned && !await owned.close()) throw Error('stage capture client cleanup unproved');
  };
  const unregister = registerCleanup?.(closeClient);
  const onAbort = () => {
    abortCleanup = Promise.all([closeClient(), session.close()]);
    abortCleanup.catch(() => {}); // Awaited in finally, even if the current capture rejects first.
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await session.request({ bench: 'captureFixture' });
    await seedFixture(session, { helper });
    if (seat === 'front-sit') await sleep(5500); // The production nobody-looking rule requires five seconds.
    const observed = await session.request({ bench: 'seat', seat });
    if (observed.size !== 'stage' || !observed.stageArt || observed.seat !== seat) throw stageUnitFailure('prepare-refusal', 'H5 stage setup fell back', observed);
    const target = session.ready.windows[0], panel = observed.panel;
    session.write(session.wire.hide()); await session.request({ bench: 'query' });
    // One target window remains during H5. The protected person stand-in stays below it and outside Accessibility.
    const { openClient } = await import('../compat/client.mjs');
    clientPromise = openClient({ command: join(ROOT, 'plugins/sleight/bin/sleight-mcp'), name: 'sleight-stage-capture', timeoutMs: 60000,
      requireGroupCollection: true,
      env: { ...process.env, SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_SURFACES: 'computer', SLEIGHT_HAND: '0' },
      approve: async params => {
        const message = params?.message ?? '';
        if (!/^Allow Computer Use to use "(sleight stage fixture|dev\.sleight\.stage-cost)"\?$/.test(message)) return { action: 'decline' };
        const choices = params.requestedSchema?.properties?.choice?.enum ?? [];
        if (params.mode === 'url' || choices.length && !choices.includes('session') && !choices.includes('once') ||
          (params.requestedSchema?.required ?? []).some(key => key !== 'choice')) return { action: 'decline' };
        return { action: 'accept', content: choices.length ? { choice: choices.includes('session') ? 'session' : 'once' } : {} };
      } });
    client = await clientPromise;
    signal?.throwIfAborted();
    const acquired = await client.call('js', { code: 'var app = await cua.getApp("dev.sleight.stage-cost")', timeout_ms: 60000 });
    if (acquired?.isError) throw stageUnitFailure('capture', 'engine could not acquire the owned stage fixture', acquired);
    let mode, from;
    const deps = {
      windows: () => helper(['windows']), sleep,
      hit: async () => undefined,
      startHost: async captureMode => {
        mode = captureMode; from = session.rows.length;
        await session.request({ bench: 'capture', mode });
        return { pid: session.pid, write: session.write, close: async () => { session.write(session.wire.hide()); await session.request({ bench: 'query' }); } };
      },
      stageWire: () => ({ ...session.wire, act: args => session.wire.act({ kind: 'click', ...args }) + JSON.stringify({ bench: 'seat', seat }) + '\n' }),
      configureStage: async () => {
        await session.wait(r => r.characterReady, 60000, from);
        await seedFixture(session, { helper }); return session.request({ bench: 'seat', seat });
      },
      observeStage: () => session.request({ bench: 'query' }),
      capture: async (source, { hostPid, label, rect }) => {
        const receipt = { source, label }; captureReceipts.push(receipt);
        try {
          signal?.throwIfAborted();
          const raw = join(work, `${label}.rgba`), png = join(work, `${label}.png`);
          const command = captureCommand(source, { target, rect, hostPid, png, raw }); let size;
          if (command.tool === 'engine') {
            const image = engineImage(await client.call('js', { code: 'await app.getScreenshot()', timeout_ms: 60000 }));
            const file = join(work, `${label}.${image.extension}`); writeFileSync(file, image.bytes);
            size = await helper(['decode', file, raw]); rmSync(file);
          } else if (command.tool === 'screencapture') {
            await executeFile('/usr/sbin/screencapture', command.args, { timeout: 15000 });
            size = await helper(['decode', png, raw]); rmSync(png);
          } else size = await helper(source === 'composite' ? ['sck-composite-rect', String(target.id), String(hostPid), raw,
            ...[rect.x, rect.y, rect.width, rect.height].map(String)] : command.args);
          const frame = readFrame(raw, size); rmSync(raw);
          if (size.handWindows) frame.handWindows = size.handWindows;
          if (['region', 'composite'].includes(source)) frame.captureRect = size.captureRect ?? rect;
          Object.assign(receipt, { width: frame.width, height: frame.height, bytes: frame.data.length });
          return frame;
        } catch (error) { receipt.error = error.message;
          if (knownChildError(error)) throw stageUnitFailure('capture', error.message, { captureReceipts });
          throw error; }
      },
    };
    // Confirm the extent is safe even before runCaptureTest starts its no-panel baselines.
    const cover = stageCaptureRegion(target, panel, (await helper(['windows'])).windows, []);
    if (cover.covered) throw stageUnitFailure('capture', cover.covered, cover);
    return stageCaptureResult(await runStageCaptureTest(deps, { target, seat, panel, character: character.frame }));
  } catch (error) {
    error.unitEvidence ??= { rows: session.rows, captureReceipts };
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    let collected = false;
    try { await closeClient(); await abortCleanup; collected = true; }
    finally {
      if (collected) unregister?.();
      if (release) await release(session, { captureReceipts }); else await session.close();
    }
  }
}

export async function runLiveStageCapture(opts) {
  if (!opts.ownerAway || process.platform !== 'darwin') throw Error('stage H5 requires macOS and --owner-away');
  if (existsSync('/tmp/sleight-hold')) throw Error('/tmp/sleight-hold exists');
  const { acquireLiveLock } = await import('../live-lock.mjs');
  const unlock = await acquireLiveLock('/tmp/sleight-live.lock', { wait: false });
  const work = realpathSync(mkdtempSync('/private/tmp/sleight-stage-h5-'));
  const sessions = new Set(); let closing;
  const close = () => closing ??= (async () => {
    for (const session of sessions) await session.close();
    rmSync(work, { recursive: true, force: true }); await unlock();
  })();
  const signals = new Map([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]].map(([signal, code]) =>
    [signal, () => { close().finally(() => process.exit(code)); }]));
  for (const [name, handler] of signals) process.on(name, handler);
  try {
    const binary = await buildStageBench(work), helperBin = join(work, 'capture-helper');
    await compileSwift(join(ROOT, 'bench/hand/capture.swift'), helperBin);
    const helper = helperClient(helperBin), character = prepareStageCharacter(work, opts.character);
    if (!(await helper(['preflight'])).screenRecording) throw Error('Screen Recording is not granted to this shell');
    return await liveStageCapture({ seat: opts.stageCase, binary, character, helper, work,
      own: async size => { const session = await startFixture(binary, character, size); sessions.add(session); return session; },
      release: async session => { await session.close(); sessions.delete(session); } });
  } finally { await close(); for (const [name, handler] of signals) process.removeListener(name, handler); }
}
