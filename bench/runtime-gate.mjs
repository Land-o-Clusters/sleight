// Offline evidence rules shared by both runtime steps. No app or engine is loaded here.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validOwnExecution, validEngineExecution } from './runtime-evidence.mjs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const PARITY_MANIFEST = freeze(read('./runtime-parity.json'));
export const RELEASE_POLICY = freeze(read('./runtime-release-policy.json'));
export const canonicalProbePlan = () => read('./runtime-probe-plan.json').cells;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const verifiedProofs = new WeakMap();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function proofFile(base, relative) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw Error('PROOF_PATH_INVALID');
  const file = resolve(base, relative), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 ||
      realpathSync(file) !== resolve(realpathSync(base), relative)) throw Error('PROOF_FILE_INVALID');
  return readFileSync(file);
}
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const sameIdentity = (a, b) => a != null && b != null && stable(a) === stable(b);
export const engineIdentity = read => ({ version: read?.version ?? read?.engineVersion,
  build: read?.chatgptBuild ?? read?.engineBuild ?? read?.build });
export const validEngine = value => typeof value?.version === 'string' && !!value.version &&
  typeof value.build === 'string' && !!value.build;
export const driverIdentity = receipt => ({ version: receipt?.driverVersion, build: receipt?.driverBuild });
export const validDriver = identity => typeof identity?.version === 'string' && !!identity.version &&
  /^[a-f0-9]{64}$/.test(identity?.build ?? '');
export const lowerMedian = xs => { const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null; };

// A selector label or a separate health client is not a receipt. RT8 must export the
// serving driver's ping and counters from the same child that executed this run.
// The harness supplies runNonce; the driver must echo it in ping's result.
export function validRuntimeReceipt(receipt, { nonce, build, processEvidence } = {}) {
  return receipt?.schema === 'sleight.runtime-receipt/1' && receipt.runtime === 'own' &&
    typeof nonce === 'string' && nonce.length >= 16 && receipt.runNonce === nonce &&
    build?.kind === 'own' && /^[a-f0-9]{64}$/.test(build.sourceSha256 ?? '') && sameIdentity(receipt.runtimeBuild, build) &&
    typeof receipt.driverVersion === 'string' && !!receipt.driverVersion &&
    /^[a-f0-9]{64}$/.test(receipt.driverBuild ?? '') &&
    receipt.ping?.runNonce === nonce && Number.isSafeInteger(receipt.ping.apiVersion) && receipt.ping.apiVersion > 0 &&
    String(receipt.ping.apiVersion) === receipt.driverVersion &&
    /^[a-f0-9]{64}$/.test(receipt.driverSourceBuild ?? '') && receipt.ping.build === receipt.driverSourceBuild &&
    Number.isSafeInteger(receipt.driverRequests) && receipt.driverRequests > 0 && validOwnExecution(receipt, processEvidence);
}

function validReleaseRun(run, context, nonces) {
  const { build, engine, sleightCommit, driverIdentity: qualifiedDriver } = context;
  const start = run?.buildStart, end = run?.buildEnd;
  const valid = validEngine(engine) && validDriver(qualifiedDriver) && !!sleightCommit &&
    typeof run?.runNonce === 'string' && run.runNonce.length >= 16 && !nonces.has(run.runNonce) &&
    sameIdentity(start, end) && start?.runtime === run.runtime && start.sleightDirty === false &&
    start.sleightCommit === sleightCommit && sameIdentity(engineIdentity(start), engine) &&
    (run.runtime === 'own' ? sameIdentity(start.runtimeBuild, build) &&
      sameIdentity(driverIdentity(run.runtimeReceipt), qualifiedDriver) &&
      validRuntimeReceipt(run.runtimeReceipt, { nonce: run.runNonce, build, processEvidence: run.processEvidence })
      : run.runtime === 'engine' && validEngineExecution(run.engineReceipt, run.processEvidence, engine, run.runtimeReceipt));
  nonces.add(run?.runNonce);
  return valid;
}
function validReleaseEvidence(groups, context) {
  const nonces = new Set();
  return Array.isArray(groups) && groups.length > 0 && groups.every(group => Array.isArray(group?.runs) &&
    group.runs.length > 0 && group.runs.every(run => validReleaseRun(run, context, nonces)));
}
export function scoreReleaseGroups(groups = [], context = {}) {
  const reasons = [], scored = [];
  if (!Array.isArray(groups)) return { passed: false, reasons: ['release groups incomplete'] };
  if (groups.length !== Object.keys(RELEASE_POLICY.limits).length) reasons.push('release groups incomplete');
  const sessions = new Set(), nonces = new Set();
  for (const [id, limit] of Object.entries(RELEASE_POLICY.limits)) {
    const matches = groups.filter(group => group?.id === id), group = matches[0], runs = group?.runs;
    if (matches.length !== 1 || !Array.isArray(runs) || !runs.length || runs.some((run, i) => !run ||
      !Number.isSafeInteger(run.sequence) || run.sequence < 1 || i > 0 && run.sequence <= runs[i - 1].sequence ||
      !Number.isSafeInteger(run.round) || run.round < 1 || !['engine', 'own'].includes(run.runtime) ||
      typeof run.task !== 'string' || !run.task || typeof run.sessionId !== 'string' || !run.sessionId ||
      typeof run.passed !== 'boolean' || !Number.isFinite(run.seconds) || run.seconds <= 0)) {
      reasons.push(`${id}: release proof incomplete`); continue;
    }
    if (!runs.every(run => validReleaseRun(run, context, nonces))) {
      reasons.push(`${id}: per-run runtime evidence incomplete`); continue;
    }
    runs.forEach(run => sessions.add(run.sessionId));
    const result = { id, engineSeconds: 0, ownSeconds: 0, enginePasses: 0, ownPasses: 0 };
    for (const task of new Set(runs.map(run => run.task))) {
      const trials = runs.filter(run => run.task === task), rounds = trials.length / 2;
      const orderValid = Number.isInteger(rounds) && rounds >= 1 && trials.every((run, i) =>
        run.round === Math.floor(i / 2) + 1 && run.runtime === (Math.floor(i / 2) % 2 ? ['own', 'engine'] : ['engine', 'own'])[i % 2]);
      if (!orderValid) reasons.push(`${id}/${task}: recorded ABBA order incomplete`);
      for (const side of ['engine', 'own']) {
        const passes = trials.filter(run => run.runtime === side && run.passed);
        if (passes.length < RELEASE_POLICY.minimumPassingRuns) reasons.push(`${id}/${task}: ${side} has no passing median`);
        result[side + 'Passes'] += passes.length;
        result[side + 'Seconds'] += lowerMedian(passes.map(run => run.seconds)) ?? 0;
      }
    }
    // Summaries are optional, but a contradictory supplied value is never accepted.
    for (const key of ['engineSeconds', 'ownSeconds', 'enginePasses', 'ownPasses']) {
      if (Object.hasOwn(group, key) && group[key] !== result[key]) reasons.push(`${id}: ${key} differs from recorded runs`);
    }
    if (result.ownSeconds > result.engineSeconds * (1 + limit)) reasons.push(`${id}: exceeds ${limit * 100}% detectable limit`);
    if (result.enginePasses - result.ownPasses >= RELEASE_POLICY.passDrop) reasons.push(`${id}: loses at least 2 passes`);
    scored.push(result);
  }
  if (sessions.size !== 1) reasons.push('same release session unproved');
  if (!reasons.length && RELEASE_POLICY.aggregate === 'sum-of-task-passing-medians' &&
      scored.reduce((n, group) => n + group.ownSeconds, 0) > scored.reduce((n, group) => n + group.engineSeconds, 0)) reasons.push('release total exceeds engine');
  return { passed: !reasons.length, reasons, groups: scored };
}

// A JSON status label cannot substitute for the named runtime test's recorded TAP,
// nonce receipt, binary hash and independent process witness. RT19 supplies tests.
export function verifyParityResult(artifact, { expected, parity, baseDirectory, root = ROOT } = {}) {
  if (expected?.proofStatus !== 'runtime-proof' || artifact?.schema !== 'sleight.runtime-parity-result/2' ||
      artifact.runtime !== 'own' || !sameIdentity(artifact.build, parity.build) || !sameIdentity(artifact.engine, parity.engine) ||
      artifact.sleightCommit !== parity.sleightCommit || artifact.id !== expected.id || artifact.check !== expected.check ||
      artifact.producer?.file !== expected.testFile || artifact.output?.file !== expected.resultFile.replace(/\.json$/, '.tap') ||
      artifact.exitCode !== 0 || !Number.isSafeInteger(artifact.tests) || artifact.tests < 1 || artifact.failures !== 0 ||
      !validDriver(parity.driverIdentity) || !sameIdentity(driverIdentity(artifact.runtimeReceipt), parity.driverIdentity) ||
      artifact.id === 'laws-release-ab' && !validReleaseEvidence(artifact.groups, parity) ||
      !validRuntimeReceipt(artifact.runtimeReceipt, { nonce: artifact.runNonce, build: parity.build, processEvidence: artifact.processEvidence })) return false;
  const source = proofFile(root, expected.testFile), output = proofFile(baseDirectory, artifact.output.file);
  if (sha256(source) !== artifact.producer.sha256 || sha256(output) !== artifact.output.sha256) return false;
  const tap = output.toString('utf8');
  const receipts = tap.split('\n').filter(line => line.startsWith('# runtime-evidence '));
  if (receipts.length !== 1) return false;
  let recorded;
  try { recorded = JSON.parse(receipts[0].slice('# runtime-evidence '.length)); } catch { return false; }
  if (!['runNonce', 'build', 'engine', 'sleightCommit', 'runtimeReceipt', 'processEvidence', 'producer',
    ...(artifact.id === 'laws-release-ab' ? ['groups'] : [])].every(key =>
    sameIdentity(recorded[key], artifact[key]))) return false;
  return /^TAP version 13$/m.test(tap) && new RegExp(`^# tests ${artifact.tests}$`, 'm').test(tap) &&
    new RegExp(`^# pass ${artifact.tests}$`, 'm').test(tap) && /^# fail 0$/m.test(tap) &&
    /^# skipped 0$/m.test(tap) && /^# cancelled 0$/m.test(tap) && !/^not ok\b/m.test(tap);
}
export function verifyParityProof(parity, baseDirectory) {
  if (!parity) return undefined;
  return { ...parity, rows: (Array.isArray(parity.rows) ? parity.rows : []).map(row => {
    const recorded = { ...row, verified: false };
    try {
      const expected = PARITY_MANIFEST.rows.find(required => required.id === row.id);
      if (!expected || row.reference !== expected.resultFile || row.check !== expected.check || row.status !== 'pass') throw Error('PROOF_REFERENCE_REQUIRED');
      const bytes = proofFile(baseDirectory, row.reference), artifact = JSON.parse(bytes);
      recorded.artifactSha256 = sha256(bytes);
      recorded.verified = recorded.artifactSha256 === row.resultSha256 && verifyParityResult(artifact, { expected, parity, baseDirectory });
      if (recorded.verified) verifiedProofs.set(recorded, structuredClone({ build: parity.build,
        engine: parity.engine, sleightCommit: parity.sleightCommit, driverIdentity: parity.driverIdentity }));
      // Release statistics come from the result artifact, never the manifest's summary.
      if (row.id === 'laws-release-ab') recorded.groups = artifact.groups;
      if (!recorded.verified) recorded.proofError = 'PROOF_CHECK_OR_BUILD_MISMATCH';
    } catch { recorded.proofError = 'PROOF_ARTIFACT_UNAVAILABLE'; }
    return freeze(recorded);
  }) };
}
export function loadParityProof(path) {
  return verifyParityProof(JSON.parse(readFileSync(path, 'utf8')), dirname(resolve(path)));
}

// Proofs are records from RT19 or live qualification, never inferred from a test
// filename. Each record names a runtime-side result artifact and its check.
export function gateVerdict({ step1, step2, parity, build, engine, sleightCommit } = {}) {
  const qualifiedDriver = step1?.driverIdentity;
  const context = { build, engine, sleightCommit, driverIdentity: qualifiedDriver };
  const proofs = Array.isArray(parity?.rows) ? parity.rows : [];
  const rows = PARITY_MANIFEST.rows.map(row => {
    const matches = proofs.filter(proof => proof?.id === row.id), proof = matches[0];
    const bound = parity?.schema === 'sleight.runtime-parity-proof/1' && parity.runtime === 'own' &&
      sameIdentity(parity.build, build) && validEngine(engine) && sameIdentity(parity.engine, engine) &&
      !!sleightCommit && parity.sleightCommit === sleightCommit && validDriver(qualifiedDriver) &&
      sameIdentity(parity.driverIdentity, qualifiedDriver);
    const releaseScore = row.id === 'laws-release-ab' ? scoreReleaseGroups(proof?.groups, context) : undefined;
    const release = !releaseScore || releaseScore.passed;
    const proven = matches.length === 1 && bound && proof.status === 'pass' &&
      sameIdentity(verifiedProofs.get(proof), context) &&
      typeof proof.reference === 'string' && proof.reference.trim().length > 0 &&
      proof.check === row.check && row.proofStatus === 'runtime-proof' && release;
    const releaseFailed = releaseScore?.reasons.some(reason => /exceeds|loses|no passing median/.test(reason));
    return { ...row, status: matches.some(p => p.status === 'fail') || bound && releaseFailed ? 'fail' : proven ? 'proven' : 'unproven',
      ...(proof && { proof }) };
  });
  const steps = [step1, step2];
  const failed = rows.some(row => row.status === 'fail') || steps.some(step => step?.passed === false &&
    (step?.complete === true || step?.verdict === 'step1: stop-program' && step?.zeroMechanisms?.length > 0));
  const complete = step1?.passed === true && step1?.complete === true && step1?.verdict === 'step1: mechanisms-pass' &&
    validDriver(qualifiedDriver) && sameIdentity(step2?.driverIdentity, qualifiedDriver) &&
    step2?.passed === true && step2?.complete === true && step2?.verdict === 'step2: speed-pass' && rows.every(row => row.status === 'proven');
  return { verdict: failed ? 'fail' : complete ? 'pass' : 'incomplete', passed: !failed && complete,
    rows, unproven: rows.filter(row => row.status === 'unproven').map(row => row.id),
    failed: rows.filter(row => row.status === 'fail').map(row => row.id) };
}
export function gateMarkdown(gate) {
  return [`Combined verdict: ${gate.verdict}.`, '',
    `Parity: ${gate.rows.filter(row => row.status === 'proven').length}/${gate.rows.length} proven.`, '',
    ...gate.rows.filter(row => row.status !== 'proven').map(row => `- ${row.id} (${row.status}): ${row.capability}. ${row.proofStatus}. Required check: ${row.check}. Test: ${row.testFile}. Result: ${row.resultFile}. Prior evidence: ${row.proofRequired}.`), ''];
}

export function validateTrial(cell, value) {
  if (!value || value.observed !== true || value.background !== true) return false;
  switch (cell.mechanism) {
    case 'covered-click': return value.covered === true && value.windowClosed === true && value.posted === true;
    case 'save-chord': return value.posted === true && value.fileMatches === true;
    case 'go-to-folder-chord': return value.posted === true && value.saveSheetBefore === true && value.goToFolderAfter === true;
    case 'type-at-caret': return value.caretConfirmed === true && value.textMatches === true && value.posted === true;
    case 'covered-capture': return value.covered === true && value.singleReply === true && value.treePresent === true &&
      value.imagePresent === true && value.imageMatchesWindow === true;
    case 'hid-idle': return value.posted === true && ['click', 'key', 'type'].every(kind => {
      const sample = value.hid?.[kind];
      // Idle time grows with wall time. Compare the inferred last-HID-event time, never raw equality.
      return sample && [sample.beforeMs, sample.afterMs, sample.elapsedMs].every(n => Number.isFinite(n) && n >= 0) &&
        sample.beforeMs >= 1000 &&
        sample.afterMs + 50 >= sample.beforeMs + sample.elapsedMs;
    });
    case 'sheet-settle': return value.sheetBefore === true && value.sheetGoneInNextRead === true && value.fileMatches === true;
    case 'menu-settle': return value.menuAbsentBefore === true && value.menuInNextRead === true && value.posted === true;
    default: return cell.group === 6 && value.correct === true && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0;
  }
}

export function assertStep1(report, { build, engine, sleightCommit } = {}) {
  const plan = canonicalProbePlan();
  const nonces = new Set();
  const validTrial = (trial, runtime, index) => {
    const start = trial.buildStart, end = trial.buildEnd;
    const valid = trial.passed === true && !trial.error && trial.trial === index + 1 &&
      trial.runtime === runtime && trial.sessionId === report.sessionId &&
      !nonces.has(trial.runNonce) && typeof trial.runNonce === 'string' && trial.runNonce.length >= 16 &&
      sameIdentity(start, end) && start?.runtime === runtime &&
      sameIdentity(engineIdentity(start), engine) && start.sleightCommit === sleightCommit && start.sleightDirty === false &&
      (runtime !== 'own' || sameIdentity(start.runtimeBuild, build) &&
        validRuntimeReceipt(trial.runtimeReceipt, { nonce: trial.runNonce, build, processEvidence: trial.processEvidence }) &&
        sameIdentity(report.driverIdentity, { version: trial.runtimeReceipt.driverVersion, build: trial.runtimeReceipt.driverBuild }));
    nonces.add(trial.runNonce);
    return valid && (runtime !== 'engine' || validEngineExecution(trial.engineReceipt, trial.processEvidence, engine, trial.runtimeReceipt));
  };
  if (report?.sitting === true || report?.schema !== 'sleight.runtime-probe/2' || report.runtime !== 'own' ||
      report.verdict?.verdict !== 'step1: mechanisms-pass' || report.verdict?.passed !== true ||
      report.verdict?.complete !== true || report.stop || report.cleanupConfirmed !== true ||
      !sameIdentity(report.build?.runtimeBuild, build) || !validEngine(engine) ||
      !sameIdentity(engineIdentity(report.build), engine) || report.build?.sleightCommit !== sleightCommit ||
      report.build?.sleightDirty !== false || report.cells?.length !== plan.length ||
      !sameIdentity(report.plan, plan) || !report.sessionId ||
      !plan.every(cell => {
        const rows = report.cells.filter(row => row.id === cell.id), row = rows[0];
        return rows.length === 1 && row.passed === true && row.attempted === cell.trials && row.passes === cell.requiredPasses &&
          row.trials === cell.trials && row.requiredPasses === cell.requiredPasses &&
          row.trialsData?.length === cell.trials && row.trialsData.every((trial, i) => validTrial(trial, 'own', i) && validateTrial(cell, trial.evidence)) &&
          (cell.group !== 6 || row.baselineData?.length === cell.trials && row.baselineData.every((trial, i) => validTrial(trial, 'engine', i) && validateTrial(cell, trial.evidence)) &&
            sameIdentity(row.order, Array.from({ length: cell.trials }, (_, i) => i % 2 ? ['own', 'engine'] : ['engine', 'own']).flat()) &&
            row.p50Ms === lowerMedian(row.trialsData.map(trial => trial.evidence.elapsedMs)) &&
            row.engineP50Ms === lowerMedian(row.baselineData.map(trial => trial.evidence.elapsedMs)) &&
            Number.isFinite(row.p50Ms) && Number.isFinite(row.engineP50Ms) && row.p50Ms <= row.engineP50Ms);
      })) throw Error('STEP1_REQUIRED: complete own-runtime proof for this build, commit and engine version/build');
  return report;
}
