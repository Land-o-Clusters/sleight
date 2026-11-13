// Offline checkpoint format for ST9. A completed unit is an indivisible observation.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const invalid = reason => { throw Error(`ST9 resume refused: ${reason}`); };
export const STAGE_FAILURE_BUDGET = 4;
export const STAGE_MAX_ATTEMPTS = 3;
export const STAGE_TOTAL_FAILURE_BUDGET = 12;
// Five continuations may recover a stopped unit; a sixth interruption excludes only that unit.
export const STAGE_MAX_INTERRUPTED_ATTEMPTS = 6;
export const STAGE_INTERRUPTION_CODE = 'STAGE_INTERRUPTION_CEILING';
// Only harness faults may become measurements after a qualified retry. Product failures persist.
export const STAGE_FAILURE_POLICY = Object.freeze({
  'pacing-recorder': 'harness', 'fixture-seat': 'harness', capture: 'harness', child: 'harness',
  visibility: 'product', 'host-crash': 'product', 'prepare-refusal': 'product', 'microphone-active': 'product',
});
export const STAGE_FAILURE_KINDS = Object.keys(STAGE_FAILURE_POLICY);
export const stageRetryable = kind => STAGE_FAILURE_POLICY[kind] === 'harness';
export const stageFailureGroup = id => id.includes('/pacing/') ? id.split('/').slice(0, 6).join('/') : id;
export const stageAttemptNumber = (progress, id) => Math.max(0,
  ...[...progress.units, ...progress.attempts, ...progress.inProgress ? [progress.inProgress] : []]
    .filter(row => row.id === id).map(row => row.attempt ?? 1));

// Stops and discarded rounds keep their sequence numbers but spend no unit-local retry budget.
export const stageFailureAttempts = (progress, id) => progress.attempts.filter(row => row.id === id &&
  row.status === 'failed' && !row.discarded && !row.interrupted).length;

// Discarding a round never erases its stops. The last unfinished attempt also spends a slot.
export function stageInterruptionCeilings(progress) {
  const rows = [...progress?.attempts ?? [], ...progress?.inProgress ? [{ ...progress.inProgress, interrupted: true }] : []];
  const byUnit = new Map();
  for (const row of rows.filter(row => row.interrupted === true)) {
    const attempts = byUnit.get(row.id) ?? new Map();
    attempts.set(row.attempt ?? 1, row); byUnit.set(row.id, attempts);
  }
  return [...byUnit].filter(([, attempts]) => attempts.size >= STAGE_MAX_INTERRUPTED_ATTEMPTS)
    .map(([unit, attempts]) => ({ code: STAGE_INTERRUPTION_CODE, unit, interruptions: attempts.size,
      limit: STAGE_MAX_INTERRUPTED_ATTEMPTS,
      reason: [...attempts.values()].at(-1).error ?? 'abrupt stop, no terminal observation' }));
}
export function excludeStageInterruptedUnits(evidence) {
  const excluded = stageInterruptionCeilings(evidence.collection);
  if (JSON.stringify(evidence.collection.excluded ?? []) === JSON.stringify(excluded)) return false;
  evidence.collection.excluded = excluded;
  sealStageEvidence(evidence);
  return true;
}

// Used both by resume (refusal) and the judge (not measured). Checks are independent of checksums.
export function stageHistoryError(progress) {
  if (!object(progress) || !Array.isArray(progress.units) || !Array.isArray(progress.attempts) ||
      !Array.isArray(progress.segments) || !Array.isArray(progress.sizes)) return 'missing history schema';
  if (!progress.segments.every(object)) return 'invalid segment schema';
  const order = stageUnitOrder(progress.sizes), seen = new Set();
  const provenance = row => object(row) && order.includes(row.id) && Number.isSafeInteger(row.segment) &&
    progress.segments[row.segment - 1]?.id === row.segment && time(row.startedAt) &&
    (row.endedAt == null || time(row.endedAt) && row.endedAt >= row.startedAt) &&
    Number.isSafeInteger(row.attempt ?? 1) && (row.attempt ?? 1) >= 1 &&
    (row.kind === undefined || STAGE_FAILURE_KINDS.includes(row.kind));
  for (const row of progress.attempts) {
    if (!provenance(row) || !Number.isSafeInteger(row.attempt) ||
        !(row.status === 'failed' || row.interrupted === true || row.discarded === true) ||
        row.status !== undefined && row.status !== 'failed' ||
        row.error !== undefined && typeof row.error !== 'string' ||
        row.discardReason !== undefined && typeof row.discardReason !== 'string' ||
        row.status === 'failed' && (!STAGE_FAILURE_KINDS.includes(row.kind) || typeof row.error !== 'string' || !time(row.endedAt)) ||
        row.discarded !== undefined && typeof row.discarded !== 'boolean' ||
        row.interrupted !== undefined && typeof row.interrupted !== 'boolean') return 'invalid attempt schema';
    const key = `${row.id}:${row.attempt}`;
    if (seen.has(key)) return 'duplicate attempt';
    seen.add(key);
  }
  for (const row of [...progress.units, ...progress.inProgress ? [progress.inProgress] : []]) {
    if (!provenance(row)) return 'invalid current attempt';
    const prior = progress.attempts.filter(a => a.id === row.id && a.attempt < (row.attempt ?? 1));
    if (prior.length !== (row.attempt ?? 1) - 1) return 'missing retry history';
    if (prior.some(a => a.segment > row.segment)) return 'retry history is in the future';
    const matching = progress.attempts.filter(a => a.id === row.id && a.attempt === (row.attempt ?? 1));
    if (row.status === 'failed' && (matching.length !== 1 || matching[0].kind !== row.kind || matching[0].segment !== row.segment) ||
        row.status !== 'failed' && matching.length) return 'current attempt disagrees with history';
  }
  for (const id of new Set(progress.attempts.map(a => a.id))) {
    const rows = progress.attempts.filter(a => a.id === id).sort((a, b) => a.attempt - b.attempt);
    if (rows.some((a, i) => a.attempt !== i + 1 || i && a.segment < rows[i - 1].segment)) return 'attempt numbering gap';
  }
  for (const segment of progress.segments) if (segment.failureStreak !== undefined) {
    const streak = segment.failureStreak;
    if (!object(streak) || !Number.isSafeInteger(streak.count) || streak.count < 0 || streak.count > STAGE_FAILURE_BUDGET ||
        !(streak.kind === null && streak.count === 0 || STAGE_FAILURE_KINDS.includes(streak.kind) && streak.count > 0) ||
        streak.group !== undefined && !order.some(id => stageFailureGroup(id) === streak.group)) return 'invalid failure streak';
  }
  return null;
}

// Remove a whole bracket or trial before recollecting. Each payload has one archival owner.
export function archiveStageUnits(evidence, ids, reason) {
  const progress = evidence.collection;
  const payloads = new Map(ids.map(id => [id, structuredClone(stageUnitData(evidence, id))]));
  for (const unit of progress.units.filter(row => ids.includes(row.id))) {
    if (unit.status !== 'failed') progress.attempts.push({ ...unit, attempt: unit.attempt ?? 1,
      discarded: true, discardReason: reason, evidence: payloads.get(unit.id) });
    const parts = unit.id.split('/'), run = evidence.runs.find(r => r.round === Number(parts[1]));
    if (parts[2] === 'baseline') { const rows = run.baselines[parts[3]]; if (rows) rows[parts[4] === 'before' ? 0 : 1] = null; }
    if (parts[2] === 'phase') {
      const size = run.sizes[parts[3]];
      for (const key of ['phases', 'samples', 'replays', 'marks', 'queueProbes', 'visibility', 'surfaceChecks',
        'rendererWindows', 'invalidVisibility', 'rendererDiagnostics']) if (size[key]) delete size[key][parts[4]];
      size.dump = Object.values(size.rendererDiagnostics ?? {}).reduce(mergeDumps, {});
    }
    if (parts[2] === 'pacing') run.sizes[parts[3]].pacing = run.sizes[parts[3]].pacing.filter(row =>
      row.requestedHz !== Number(parts[4]) || row.durationMs !== Number(parts[5]));
  }
  progress.units = progress.units.filter(row => !ids.includes(row.id));
}

export function stageUnitFailure(kind, message, evidence) {
  if (!STAGE_FAILURE_KINDS.includes(kind)) throw Error('unknown stage failure kind');
  return Object.assign(Error(message), { unitFailureKind: kind, unitEvidence: evidence });
}
export function stageFailureKind(error) {
  // Unknown exceptions and cleanup uncertainty are run stops, even inside a unit.
  if (error.runStop || /cleanup unproved/.test(error.message)) return null;
  return STAGE_FAILURE_KINDS.includes(error.unitFailureKind) ? error.unitFailureKind : null;
}
export function stageCollectionSummary(evidence) {
  const excluded = stageInterruptionCeilings(evidence.collection);
  const allUnits = evidence.collection?.units ?? [];
  const units = allUnits.filter(unit => !excluded.some(row => row.unit === unit.id)), failed = units.filter(unit => unit.status === 'failed');
  return { completed: units.length - failed.length, failed: failed.length,
    retried: units.filter(unit => (unit.attempt ?? 1) > 1).length,
    failedByKind: Object.fromEntries(STAGE_FAILURE_KINDS.map(kind => [kind, failed.filter(unit => unit.kind === kind).length]).filter(([, n]) => n)),
    ...excluded.length ? { excluded: excluded.length } : {},
    notRun: stageUnitOrder(evidence.collection?.sizes ?? ['small', 'medium', 'stage']).length - units.length - excluded.length };
}
export const stageSummaryLine = summary => `Units: ${summary.completed} completed; ${summary.failed} failed ${JSON.stringify(summary.failedByKind)}; ${summary.notRun} not run; retried ${summary.retried}.` +
  (summary.excluded ? ` Excluded: ${summary.excluded}.` : '');

export function stageUnitOrder(sizes) {
  const units = ['behavior'];
  for (let round = 1; round <= 3; round++) {
    const prefix = `round/${round}`;
    for (const surface of ['quiet', 'changing']) units.push(`${prefix}/baseline/${surface}/before`,
      ...sizes.map(size => `${prefix}/phase/${size}/${surface}`), `${prefix}/baseline/${surface}/after`);
    for (const size of sizes) for (const hz of [60, 120]) for (const ms of [600, 400])
      for (const arm of ['character/hash', 'numbered/hash', 'character/timestamps', 'numbered/timestamps'])
        units.push(`${prefix}/pacing/${size}/${hz}/${ms}/${arm}`);
    units.push(`${prefix}/qualification`);
  }
  return sizes.includes('stage') ? [...units, 'capture/edge-lie', 'capture/front-sit'] : units;
}

export function stageIdentity(sourceCommit, character, machine) {
  const identity = { sourceCommit, character, machine: Object.fromEntries(
    ['machineId', 'mac', 'macOS', 'maximumHz'].map(key => [key, machine[key]])) };
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(character?.sha256 ?? '') ||
      !['machineId', 'mac', 'macOS'].every(key => typeof identity.machine[key] === 'string' && identity.machine[key].length > 0) ||
      !Number.isFinite(machine.maximumHz) || machine.maximumHz < 60) invalid('missing source, character, machine or display identity');
  return identity;
}

export function sealStageEvidence(evidence) {
  delete evidence.collection.checksum;
  evidence.collection.checksum = digest(evidence);
  return evidence;
}

// Bind a unit ID to the observation at its canonical location, excluding later pacing arms.
export function stageUnitData(evidence, id) {
  if (id === 'behavior') return Object.keys(evidence.behavior).length ? evidence.behavior : undefined;
  const parts = id.split('/');
  if (parts[0] === 'capture') return evidence.captures.find(row => row.seat === parts[1]);
  const run = evidence.runs.find(row => row.round === Number(parts[1]));
  if (!run) return undefined;
  if (parts[2] === 'baseline') return run.baselines[parts[3]]?.[parts[4] === 'before' ? 0 : 1] ?? undefined;
  if (parts[2] === 'qualification') return Object.hasOwn(run, 'loadAverageMax') ?
    { loadAverageMax: run.loadAverageMax, puddleWindowHeld: run.puddleWindowHeld } : undefined;
  const size = run.sizes[parts[3]];
  if (parts[2] === 'phase') {
    if (!size?.phases[parts[4]]) return undefined;
    return Object.fromEntries(['phases', 'samples', 'replays', 'marks', 'queueProbes', 'visibility', 'surfaceChecks',
      'rendererWindows', 'invalidVisibility', 'rendererDiagnostics'].filter(key => size[key]?.[parts[4]] !== undefined)
      .map(key => [key, size[key][parts[4]]]));
  }
  const trial = size?.pacing.find(row => row.requestedHz === Number(parts[4]) && row.durationMs === Number(parts[5]));
  const arm = parts[6] === 'numbered' ? trial?.calibration : trial;
  const value = parts[7] === 'timestamps' ? arm?.timestampsOnly : arm;
  if (!value || value.unitPlaceholder) return undefined;
  const { calibration, timestampsOnly, ...own } = value;
  return own;
}
export const stageUnitDigest = (evidence, id) => digest(stageUnitData(evidence, id));
export const stageMachineDigest = machine => digest(machine);

export function mergeDumps(a, b = {}) {
  const result = { ...a, ...b };
  for (const key of ['installMs', 'installsPerPlan', 'planIDs', 'decodeMs', 'decodeSpans', 'panels']) result[key] = [...a[key] ?? [], ...b[key] ?? []];
  const count = n => Number.isSafeInteger(n) && n >= 0;
  result.unplannedInstalls = !('unplannedInstalls' in a) ? b.unplannedInstalls :
    count(a.unplannedInstalls) && count(b.unplannedInstalls) ? a.unplannedInstalls + b.unplannedInstalls : undefined;
  for (const key of ['cacheBytes', 'startupMs', 'resident2xStrips']) {
    const values = [a[key], b[key]].filter(Number.isFinite);
    result[key] = values.length ? (key === 'resident2xStrips' ? Math.min(...values) : Math.max(...values)) : undefined;
  }
  result.drawBlocked = !('drawBlocked' in a) ? b.drawBlocked : a.drawBlocked === true || b.drawBlocked === true ? true :
    a.drawBlocked === false && b.drawBlocked === false ? false : undefined;
  if ('firstStripDecoded' in a) result.firstStripDecoded = a.firstStripDecoded === true && b.firstStripDecoded === true;
  return result;
}

function discardedLoad(rows) {
  const loadObservations = rows.map(({ segment, row }) => ({ segment, ...structuredClone(row) }));
  const known = loadObservations.map(row => row.loadAverageMax).filter(value => Number.isFinite(value) && value >= 0);
  return { loadObservations, observedLoadAverageMax: known.length ? Math.max(...known) : null,
    observedHeld: loadObservations.some(row => row.puddleWindowHeld === true) ? true :
      loadObservations.length && loadObservations.every(row => row.puddleWindowHeld === false) ? false : null };
}

// An unfinished behavior unit starts over, including its load window. Keep the lost rows as attempts.
export function discardUnfinishedBehavior(evidence) {
  const progress = evidence.collection;
  if (progress.units.some(unit => unit.id === 'behavior')) return;
  for (const segment of progress.segments) {
    const row = segment.behavior;
    if (!row || row.discarded) continue;
    const error = 'discarded unfinished behavior: collect again from its start';
    progress.attempts.push({ ...progress.inProgress, attempt: progress.inProgress?.attempt ?? 1, id: 'behavior', segment: segment.id,
      startedAt: row.startedAt, endedAt: row.endedAt, discarded: true, interrupted: true,
      error: progress.inProgress?.error ?? error, discardReason: error, evidence: structuredClone(evidence.behavior),
      ...discardedLoad([{ segment: segment.id, row }]) });
    Object.assign(row, { discarded: true, error });
  }
  evidence.behavior = {};
  if (progress.inProgress?.id === 'behavior') delete progress.inProgress;
}

// Only pacing saves incomplete data at a canonical location. Quarantine it before the next checkpoint.
export function discardInterruptedUnit(evidence) {
  const progress = evidence.collection, unit = progress.inProgress;
  if (!unit) return;
  progress.attempts.push({ ...unit, attempt: unit.attempt ?? 1, interrupted: true });
  const parts = unit.id.split('/');
  if (parts[2] === 'pacing') {
    const rows = evidence.runs.find(run => run.round === Number(parts[1])).sizes[parts[3]].pacing;
    const index = rows.findIndex(row => row.requestedHz === Number(parts[4]) && row.durationMs === Number(parts[5]));
    const trial = rows[index];
    if (parts[7] === 'timestamps') {
      const arm = parts[6] === 'numbered' ? trial?.calibration : trial;
      if (arm) delete arm.timestampsOnly;
    } else if (parts[6] === 'numbered') {
      if (trial?.calibration?.timestampsOnly) trial.calibration = { unitPlaceholder: true, timestampsOnly: trial.calibration.timestampsOnly };
      else if (trial) delete trial.calibration;
    } else if (trial?.calibration || trial?.timestampsOnly) rows[index] = { requestedHz: trial.requestedHz,
      durationMs: trial.durationMs, unitPlaceholder: true, ...trial.calibration ? { calibration: trial.calibration } : {},
      ...trial.timestampsOnly ? { timestampsOnly: trial.timestampsOnly } : {} };
    else if (index >= 0) rows.splice(index, 1);
  }
  delete progress.inProgress;
}

// A quiet, fully observed split round may continue. Unknown load or a hold discards the whole round.
export function discardUnobservedRound(evidence) {
  const progress = evidence.collection;
  const round = evidence.runs.find(run => progress.segments.some(segment => {
      const row = segment.rounds[run.round];
      return row && !row.discarded && (!time(row.endedAt) || !Number.isFinite(row.loadAverageMax) ||
        row.loadAverageMax < 0 || row.puddleWindowHeld !== false);
    }))?.round;
  if (!round) return;
  const prefix = `round/${round}/`, error = 'discarded partial round: missing load observations or quiet window lost';
  const load = discardedLoad(progress.segments.filter(segment => segment.rounds[round] && !segment.rounds[round].discarded)
    .map(segment => ({ segment: segment.id, row: segment.rounds[round] })));
  for (const attempt of progress.attempts.filter(a => a.id.startsWith(prefix) && !a.discarded)) Object.assign(attempt, { discarded: true, discardReason: error, ...load });
  for (const unit of progress.units.filter(unit => unit.id.startsWith(prefix) && unit.status !== 'failed')) progress.attempts.push({
    ...unit, attempt: unit.attempt ?? 1, discarded: true, error, evidence: structuredClone(stageUnitData(evidence, unit.id)), ...load });
  if (progress.inProgress?.id.startsWith(prefix)) {
    progress.attempts.push({ ...progress.inProgress, attempt: progress.inProgress.attempt ?? 1, discarded: true, interrupted: true,
      error: progress.inProgress.error ?? error, discardReason: error, ...load });
    delete progress.inProgress;
  }
  progress.units = progress.units.filter(unit => !unit.id.startsWith(prefix));
  evidence.runs = evidence.runs.filter(run => run.round !== round);
  for (const segment of progress.segments) if (segment.rounds[round]) Object.assign(segment.rounds[round], { discarded: true, error });
}

export function validateStageResume(evidence, { identity, sizes, targetStress = false, controlLayout = evidence?.collection?.controlLayout ?? 'single/1' }) {
  const progress = evidence?.collection;
  if (evidence?.schema !== 'sleight.stage-cost/1' || progress?.schema !== 'sleight.stage-progress/1' ||
      !Array.isArray(evidence.runs) || !Array.isArray(evidence.captures) || !object(evidence.behavior) ||
      !Array.isArray(progress.units) || !Array.isArray(progress.segments) || !progress.segments.length ||
      !Array.isArray(progress.attempts)) invalid('corrupted or unsupported partial checkpoint');
  const copy = structuredClone(evidence), checksum = copy.collection.checksum;
  delete copy.collection.checksum;
  if (checksum !== digest(copy)) invalid('corrupted checkpoint checksum');
  const actualLayout = progress.controlLayout ?? 'single/1';
  if (!['single/1', 'bracketed/1'].includes(actualLayout) || actualLayout !== controlLayout)
    invalid('control layout changed; single/1 and bracketed/1 cannot share a bank');
  if (!identity || digest(progress.identity) !== digest(identity)) invalid('source commit, character pack digest, machine or display rate changed');
  if (progress.machineDigest !== stageMachineDigest(evidence.machine)) invalid('recorded machine data changed');
  if (digest(progress.sizes) !== digest(sizes) || progress.targetStress !== targetStress) invalid('collection sizes or target-stress plan changed');
  const historyError = stageHistoryError(progress);
  if (historyError) invalid(historyError);
  const order = stageUnitOrder(sizes);
  if (progress.units.length > order.length || progress.units.some((unit, i) =>
    !object(unit) || !order.includes(unit.id) || i > 0 && order.indexOf(unit.id) <= order.indexOf(progress.units[i - 1].id) ||
    unit.status !== undefined && unit.status !== 'failed' || !Number.isSafeInteger(unit.segment) || !progress.segments[unit.segment - 1] ||
    !time(unit.startedAt) || !time(unit.endedAt) || unit.endedAt < unit.startedAt)) invalid('corrupted unit order or provenance');
  if (progress.inProgress && progress.inProgress.id !== order.find(id => !progress.units.some(unit => unit.id === id) &&
      !stageInterruptionCeilings(progress).some(row => row.unit === id)) &&
      !stageInterruptionCeilings(progress).some(row => row.unit === progress.inProgress.id) &&
      !progress.units.some(unit => unit.id === progress.inProgress.id && unit.status === 'failed')) invalid('corrupted in-progress unit');
  if (progress.segments.some((segment, i) => !object(segment) || segment.id !== i + 1 || !time(segment.startedAt) ||
    segment.endedAt !== null && !time(segment.endedAt) || !object(segment.rounds))) invalid('corrupted segment provenance');
  if (evidence.runs.some((run, i, rows) => !object(run) || ![1, 2, 3].includes(run.round) ||
      i > 0 && run.round <= rows[i - 1].round || !object(run.baselines) || !object(run.sizes)) ||
      evidence.runs.length > 3 || evidence.captures.length > 2 ||
      evidence.captures.some((row, i, rows) => !object(row) || !['edge-lie', 'front-sit'].includes(row.seat) ||
        rows.findIndex(other => other.seat === row.seat) !== i)) invalid('corrupted round or capture structure');
  for (const run of evidence.runs) {
    if (Object.keys(run.sizes).some(size => !sizes.includes(size)) || sizes.some(size => !object(run.sizes[size]) ||
        !object(run.sizes[size].phases) || !object(run.sizes[size].dump) || !Array.isArray(run.sizes[size].pacing)) ||
        Object.entries(run.baselines).some(([surface, rows]) => !['quiet', 'changing'].includes(surface) || !Array.isArray(rows) || rows.length > 2))
      invalid('corrupted baseline, phase or pacing structure');
    for (const size of Object.values(run.sizes)) {
      for (const phase of Object.values(size.phases)) {
        const layout = phase?.control?.layout ?? 'single/1';
        if (layout !== actualLayout) invalid('mixed control layouts in one bank');
      }
      const dumps = ['quiet', 'changing'].filter(surface => size.rendererDiagnostics?.[surface] !== undefined)
        .map(surface => size.rendererDiagnostics[surface]);
      if (digest(size.dump) !== digest(dumps.reduce(mergeDumps, {}))) invalid('derived dump disagrees with phase diagnostics');
      if (Object.keys(size.phases).some(surface => !['quiet', 'changing'].includes(surface)) || size.pacing.some((row, i, rows) =>
        !object(row) || ![60, 120].includes(row.requestedHz) || ![600, 400].includes(row.durationMs) ||
        rows.findIndex(other => other.requestedHz === row.requestedHz && other.durationMs === row.durationMs) !== i))
        invalid('unit data disagrees with phase or pacing IDs');
    }
  }
  const behaviorUnit = progress.units.find(unit => unit.id === 'behavior');
  if (behaviorUnit && !object(progress.segments[behaviorUnit.segment - 1].behavior)) invalid('missing behavior load observations');
  for (const id of order) {
    const unit = progress.units.find(unit => unit.id === id), data = stageUnitData(evidence, id);
    if (unit?.status === 'failed' && (!STAGE_FAILURE_KINDS.includes(unit.kind) || typeof unit.error !== 'string' ||
        !Number.isSafeInteger(unit.attempt) || unit.attempt < 1 || data !== undefined)) invalid(`corrupted failed unit: ${id}`);
    if (unit && (unit.status !== 'failed' && data === undefined || unit.dataDigest !== stageUnitDigest(evidence, id)) ||
        !unit && data !== undefined && progress.inProgress?.id !== id &&
        !(id.endsWith('/qualification') && stageInterruptionCeilings(progress).some(row => row.unit === id)))
      invalid(`unit data disagrees with ID: ${id}`);
    if (data && id.includes('/pacing/')) {
      const parts = id.split('/');
      if (data.requestedHz !== Number(parts[4]) || data.durationMs !== Number(parts[5]) ||
          data.source !== undefined && data.source !== parts[6] || data.recorderMode !== undefined && data.recorderMode !== parts[7])
        invalid(`unit data disagrees with ID: ${id}`);
    }
  }
  // A crash may leave the last saved exclusions behind the unfinished attempt. Never trust extra exclusions.
  if (progress.excluded !== undefined && (!Array.isArray(progress.excluded) ||
      new Set(progress.excluded.map(row => row?.unit)).size !== progress.excluded.length ||
      progress.excluded.some(row => !stageInterruptionCeilings(progress).some(actual => digest(actual) === digest(row)))))
    invalid('exclusions disagree with interruption history');
  return evidence;
}

export function readStagePartial(out) {
  const file = join(out, 'stage-cost.partial.json');
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ** 2) invalid('invalid partial file or size');
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    if (!object(evidence)) invalid('partial checkpoint must be an object');
    return evidence;
  } catch (error) { if (error.message.startsWith('ST9 resume refused:')) throw error; invalid(`cannot read partial checkpoint (${error.message})`); }
}

export function writeStagePartial(out, evidence, { beforeRename = () => {}, sync = fsyncSync } = {}) {
  const file = join(out, 'stage-cost.partial.json'), temp = join(out, `.stage-cost-${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(sealStageEvidence(evidence), null, 2) + '\n'); sync(fd);
    closeSync(fd); fd = undefined; beforeRename(temp, file); renameSync(temp, file);
    fd = openSync(out, 'r'); sync(fd); closeSync(fd); fd = undefined;
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
}

// Discarded round attempts remain in provenance but never qualify their replacement.
export function roundQualification(segments, round) {
  const rows = segments.flatMap(segment => [
    ...(round === 1 && segment.behavior && !segment.behavior.discarded ? [segment.behavior] : []),
    ...(segment.rounds[round] && !segment.rounds[round].discarded ? [segment.rounds[round]] : []),
  ]);
  return {
    loadAverageMax: rows.length && rows.every(row => Number.isFinite(row.loadAverageMax) && row.loadAverageMax >= 0 && time(row.endedAt)) ?
      Math.max(...rows.map(row => row.loadAverageMax)) : null,
    puddleWindowHeld: rows.some(row => row.puddleWindowHeld === true) ? true :
      rows.length && rows.every(row => row.puddleWindowHeld === false && time(row.endedAt)) ? false : null,
  };
}
