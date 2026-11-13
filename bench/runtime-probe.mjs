#!/usr/bin/env node
// Model-free RT1 section 6 gate. The live adapter is lazy; imports and dry runs are inert.
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runtimeName, outputStem, writeRuntimeReport } from './runtime-arm.mjs';
import { canonicalProbePlan, engineIdentity, validEngine, sameIdentity, validRuntimeReceipt, lowerMedian,
  gateVerdict, gateMarkdown, validateTrial, loadParityProof } from './runtime-gate.mjs';
import { validEngineExecution } from './runtime-evidence.mjs';
// Link the adapter before either CLI starts its top-level await. A dynamic
// import from main would wait on the entry module that is awaiting main.
import { createLiveProbe } from './runtime-probe-live.mjs';

export const PROBE_APPS = Object.freeze({
  calculator: { app: 'Calculator', bundle: 'com.apple.calculator' },
  textedit: { app: 'TextEdit', bundle: 'com.apple.TextEdit', format: 'txt' },
  finder: { app: 'Finder', bundle: 'com.apple.finder', format: 'folder' },
  safari: { app: 'Safari', bundle: 'com.apple.Safari', format: 'html' },
  word: { app: 'Microsoft Word', bundle: 'com.microsoft.Word', format: 'docx' },
  excel: { app: 'Microsoft Excel', bundle: 'com.microsoft.Excel', format: 'xlsx' },
});
export const probePlan = canonicalProbePlan;
export function sittingPlan() {
  const { subsets: { sitting } } = JSON.parse(readFileSync(new URL('./runtime-probe-plan.json', import.meta.url), 'utf8'));
  return probePlan().filter(cell => cell.group === sitting.group && sitting.apps.includes(cell.app) && sitting.metrics.includes(cell.metric))
    .map(cell => ({ ...cell, trials: sitting.trials, requiredPasses: sitting.trials }));
}
export function probeSchedule(cell, sitting = false) {
  if (sitting) return [
    ...Array.from({ length: cell.trials }, (_, index) => ({ runtime: 'engine', index })),
    { wait: 'engine-idle' },
    ...Array.from({ length: cell.trials }, (_, index) => ({ runtime: 'own', index })),
  ];
  return Array.from({ length: cell.trials }, (_, index) => (cell.group === 6
    ? (index % 2 ? ['own', 'engine'] : ['engine', 'own']) : ['own']).map(runtime => ({ runtime, index }))).flat();
}
// Nearest-rank quartiles (no interpolation); p50 is RT13's lower median.
export function latencySummary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  const q1Ms = quantile(0.25), q3Ms = quantile(0.75);
  return { count: sorted.length, p50Ms: quantile(0.5), q1Ms, q3Ms, iqrMs: sorted.length ? q3Ms - q1Ms : null };
}
// Sitting receipts bind the serving client's nonce and source build. Process
// attribution remains in the file, but only qualification requires it to pass.
function validSittingReceipt(receipt, nonce, build) {
  return receipt?.schema === 'sleight.runtime-receipt/1' && receipt.runtime === 'own' &&
    receipt.runNonce === nonce && sameIdentity(receipt.runtimeBuild, build) &&
    receipt.ping?.runNonce === nonce && Number.isSafeInteger(receipt.ping.apiVersion) && receipt.ping.apiVersion > 0 &&
    String(receipt.ping.apiVersion) === receipt.driverVersion &&
    /^[a-f0-9]{64}$/.test(receipt.driverSourceBuild ?? '') && receipt.ping.build === receipt.driverSourceBuild &&
    Number.isSafeInteger(receipt.driverRequests) && receipt.driverRequests > 0;
}
export { validateTrial };
export function probeVerdict(cells, { fixRound = 0, sitting = false } = {}) {
  if (sitting) return { passed: false, complete: false, sitting: true, zeroMechanisms: [],
    verdict: 'step1: sitting-not-qualification', fixRound, automaticRetries: 0 };
  const expected = probePlan();
  const complete = cells.length === expected.length && expected.every(cell => cells.filter(row => row.id === cell.id &&
    row.attempted === cell.trials && row.trials === cell.trials && row.requiredPasses === cell.requiredPasses).length === 1);
  const passed = complete && cells.every(row => row.passed);
  const zeros = cells.filter(row => row.group <= 4 && row.attempted === row.trials && row.passes === 0).map(row => row.id);
  return { passed, complete, zeroMechanisms: zeros, verdict: passed ? 'step1: mechanisms-pass' : fixRound && zeros.length ? 'step1: stop-program' : 'step1: diagnose-and-fix',
    fixRound, automaticRetries: 0 };
}
export function assertProbeSafety({ ownerAway, sitting, platform = process.platform, held, running }, plan = probePlan()) {
  if (!ownerAway && !sitting) throw Error('OWNER_AWAY_REQUIRED');
  if (platform !== 'darwin') throw Error('MACOS_REQUIRED');
  if (held) throw Error('HOLD');
  if (!Array.isArray(running)) throw Error('APP_INVENTORY_UNAVAILABLE');
  // Finder's release fixture owns a new window and retains the existing baseline.
  // Every other probe app still must be absent before fixture setup.
  const bundles = new Set(plan.filter(cell => cell.app !== 'finder').map(cell => PROBE_APPS[cell.app].bundle));
  if (running.some(app => bundles.has(app.bundle))) throw Error('APP_ALREADY_RUNNING: ' +
    [...new Set(running.filter(app => bundles.has(app.bundle)).map(app => app.bundle))].join(', '));
}
// Backend contract: metadata(), inventory(), prepare(cell), trial(cell,fixture,index), closeFixture(fixture), close().
// prepare owns fixture launch and cleanup receipts. trial must return observations above, not a generic success flag.
// The adapter translates only getApp/read/click/pressKey/typeText to RT2's driver client.
export async function runProbePlan(options, { backend, takeLock, held = () => existsSync('/tmp/sleight-hold'),
  platform = process.platform, load = loadavg, now = () => new Date().toISOString(),
  publish = writeRuntimeReport, log = line => console.error(line), plan = options.sitting ? sittingPlan() : probePlan() } = {}) {
  const selectedRuntime = runtimeName(options.env);
  const runtime = options.sitting ? 'own' : selectedRuntime;
  if (options.sitting && !sameIdentity(plan, sittingPlan())) throw Error('SITTING_PLAN_REQUIRED');
  if (options.dryRun) return { schema: 'sleight.runtime-probe/2', dryRun: true, runtime, plan,
    ...(options.sitting && { sitting: true, blockOrder: ['engine:20', 'helper-idle-wait:1', 'own:20'],
      schedules: plan.map(cell => ({ id: cell.id, attempts: probeSchedule(cell, true) })) }),
    totalTrials: plan.reduce((sum, cell) => sum + cell.trials, 0),
    engineLatencyTrials: plan.filter(cell => cell.group === 6).reduce((sum, cell) => sum + cell.trials, 0) };
  assertProbeSafety({ ...options, platform, held: held(), running: [] }, plan);
  const stem = outputStem(options.out);
  if (!backend || typeof takeLock !== 'function') throw Error('RUNTIME_ABSENT: no probe backend');
  const report = { schema: 'sleight.runtime-probe/2', runtime, sessionId: randomUUID(), startedAt: now(), plan,
    ...(options.sitting && { sitting: true }),
    canonicalPlanSize: probePlan().length, executedPlanSize: plan.length, cells: [], cleanupConfirmed: true,
    parity: options.parity ? loadParityProof(options.parity) : undefined };
  let unlock, fixture, failedCleanup = false;
  const boundary = () => { options.signal?.throwIfAborted(); if (held()) throw Error('HOLD'); };
  try {
    boundary(); report.build = await backend.metadata();
    if (runtime !== 'own' || report.build?.runtime !== runtime || !report.build.runtimeBuild ||
        !validEngine(engineIdentity(report.build)) || !report.build.sleightCommit || report.build.sleightDirty !== false) throw Error('RUNTIME_IDENTITY_UNAVAILABLE');
    unlock = await takeLock();
    boundary(); assertProbeSafety({ ...options, platform, held: held(), running: await backend.inventory() }, plan);
    for (const cell of plan) {
      boundary();
      const row = { ...cell, attempted: 0, passes: 0, trialsData: [], baselineData: [], order: [],
        startedAt: now(), loadStart: load(), buildStart: await backend.metadata() };
      report.cells.push(row);
      try {
        fixture = await backend.prepare(cell);
        for (const { runtime: side, index, wait } of probeSchedule(cell, options.sitting)) {
            if (wait) {
              boundary();
              row.idleWait = await backend.waitForEngineIdle();
              row.order.push(wait);
              continue;
            }
            boundary(); let evidence, error, trace, runtimeReceipt, processEvidence, engineReceipt, idleWait;
            const runNonce = randomUUID(), buildStart = await backend.metadata(side), loadStart = load();
            try {
              if (side !== buildStart.runtime || !sameIdentity(engineIdentity(buildStart), engineIdentity(report.build)) ||
                  side === 'own' && !sameIdentity(buildStart, report.build)) throw Error('RUNTIME_BUILD_CHANGED');
              evidence = await backend.trial(cell, fixture, index, { runtime: side, runNonce, sitting: options.sitting === true });
              idleWait = evidence.idleWait;
              runtimeReceipt = evidence.runtimeReceipt;
              processEvidence = evidence.processEvidence; engineReceipt = evidence.engineReceipt;
              if (side === 'own' && !(options.sitting ? validSittingReceipt(runtimeReceipt, runNonce, report.build.runtimeBuild)
                : validRuntimeReceipt(runtimeReceipt, { nonce: runNonce, build: report.build.runtimeBuild, processEvidence }))) throw Error('RUNTIME_RECEIPT_INVALID');
              if (!options.sitting && side === 'engine' && !validEngineExecution(engineReceipt, processEvidence, engineIdentity(report.build), runtimeReceipt)) throw Error('ENGINE_RECEIPT_INVALID');
              if (side === 'own') {
                const identity = { version: runtimeReceipt.driverVersion, build: options.sitting ? runtimeReceipt.driverSourceBuild : runtimeReceipt.driverBuild };
                report.driverIdentity ??= identity;
                if (!sameIdentity(report.driverIdentity, identity)) throw Error('RUNTIME_BUILD_CHANGED');
              }
            } catch (caught) { error = /^[A-Z][A-Z0-9_]+(?=:|$)/.exec(caught.code ?? caught.message)?.[0] ?? 'TRIAL_FAILED'; trace = caught.trace;
              processEvidence ??= caught.processEvidence; idleWait ??= caught.idleWait; }
            const buildEnd = await backend.metadata(side);
            if (!sameIdentity(buildStart, buildEnd)) error = 'RUNTIME_BUILD_CHANGED';
            const passed = !error && validateTrial(cell, evidence);
            const recorded = { trial: index + 1, runtime: side, runNonce, runtimeReceipt, processEvidence, engineReceipt, idleWait, sessionId: report.sessionId,
              passed, buildStart, buildEnd, loadStart, loadEnd: load(),
              ...(error ? { error, ...(trace && { trace }) } : { evidence }) };
            // Idle preflight failed before the mechanism started. Retain its wait
            // separately, without consuming an attempt or creating a zero-pass cell.
            if (error === 'ENGINE_HELPER_PRESENT') {
              row.stoppedAttempt = { ...recorded, attemptStarted: false };
              throw Error(error);
            }
            row.order.push(side);
            if (side === 'own') { row.attempted++; row.passes += Number(passed); row.trialsData.push(recorded); }
            else row.baselineData.push(recorded);
            // Never retry input whose outcome or serving runtime is unknown.
            if (error && ['HOLD', 'INTERRUPTED', 'PERSON_TOOK_OVER', 'IDENTITY_CHANGED', 'RUNTIME_ABSENT', 'DRIVER_UNHEALTHY',
              'CLEANUP_UNCONFIRMED', 'INPUT_DELIVERY_UNCONFIRMED', 'NEW_WINDOW_UNCONFIRMED', 'FOCUS_CHANGED', 'WITNESS_AX_BUDGET',
              'RUNTIME_RECEIPT_INVALID', 'ENGINE_RECEIPT_INVALID', 'PROCESS_INVENTORY_INVALID', 'PROCESS_INVENTORY_UNAVAILABLE',
              'HELPER_BINARY_INVALID', 'HELPER_BINARY_CHANGED', 'RUNTIME_BUILD_CHANGED'].includes(error) ||
              error && /^(PROCESS_|HELPER_)/.test(error)) throw Error(error);
        }
      } finally {
        if (fixture) {
          try { if ((await backend.closeFixture(fixture))?.confirmed !== true) throw Error('CLEANUP_UNCONFIRMED'); }
          catch { failedCleanup = true; }
          fixture = undefined;
        }
        row.loadEnd = load(); row.finishedAt = now();
        row.buildEnd = await backend.metadata();
        row.p50Ms = cell.group === 6 ? lowerMedian(row.trialsData.filter(t => t.passed).map(t => t.evidence.elapsedMs)) : undefined;
        row.engineP50Ms = cell.group === 6 ? lowerMedian(row.baselineData.filter(t => t.passed).map(t => t.evidence.elapsedMs)) : undefined;
        row.p50LimitMs = row.engineP50Ms;
        if (options.sitting) {
          row.latencies = { own: latencySummary(row.trialsData.filter(t => t.passed).map(t => t.evidence.elapsedMs)),
            engine: latencySummary(row.baselineData.filter(t => t.passed).map(t => t.evidence.elapsedMs)) };
          row.ownOverEngine = row.engineP50Ms > 0 && row.p50Ms !== null ? row.p50Ms / row.engineP50Ms : null;
          row.harnessFault = row.engineP50Ms !== null &&
            (row.engineP50Ms < 43 || row.engineP50Ms > 48);
          row.scored = !row.harnessFault && row.trialsData.length === cell.trials && row.trialsData.every(t => t.passed) &&
            row.baselineData.length === cell.trials && row.baselineData.every(t => t.passed);
        }
        row.passed = row.attempted === cell.trials && row.passes === cell.requiredPasses &&
          (cell.group !== 6 || row.baselineData.length === cell.trials && row.baselineData.every(t => t.passed) &&
            row.p50Ms !== null && row.engineP50Ms !== null && row.p50Ms <= row.engineP50Ms);
        if (options.sitting) row.passed &&= row.scored;
        log(`step1 ${row.passed ? 'cell-pass' : 'cell-fail'} ${cell.id}: ${row.passes}/${cell.trials}${row.p50Ms === undefined ? '' : ` p50=${row.p50Ms}ms engine=${row.engineP50Ms}ms`}`);
      }
      if (failedCleanup) throw Error('CLEANUP_UNCONFIRMED');
      if (!sameIdentity(row.buildStart, row.buildEnd) || !sameIdentity(report.build, row.buildStart)) throw Error('RUNTIME_BUILD_CHANGED');
      if (options.fixRound === 1 && cell.group <= 4 && row.attempted === cell.trials && row.passes === 0) break;
    }
  } catch (error) { report.stop = /^[A-Z][A-Z0-9_]+/.exec(error.message)?.[0] ?? 'PROBE_STOP'; }
  finally {
    try { const closed = await backend.close(); if (closed?.confirmed !== true) failedCleanup = true; }
    catch { failedCleanup = true; }
    report.cleanupConfirmed = !failedCleanup;
    if (unlock && !failedCleanup) { try { await unlock(); } catch { report.cleanupConfirmed = false; report.stop = 'LIVE_LOCK_UNCONFIRMED'; } }
    if (unlock && !report.cleanupConfirmed) log('CLEANUP_UNCONFIRMED: bank and /tmp/sleight-live.lock retained');
    report.finishedAt = now(); report.verdict = probeVerdict(report.cells, options);
    if (options.sitting) {
      const completed = !report.stop && report.cleanupConfirmed && report.cells.length === plan.length &&
        report.cells.every(row => row.scored);
      report.sittingSummary = { completed, passed: completed && report.cells.every(row => row.passed),
        scoredCells: report.cells.filter(row => row.scored).length,
        harnessFaults: report.cells.filter(row => row.harnessFault).map(row => row.id) };
    }
    report.latencies = Object.fromEntries(['calculator', 'textedit'].map(app => {
      const metrics = Object.fromEntries(report.cells.filter(row => row.app === app && row.group === 6).map(row => [row.metric, row.p50Ms]));
      return [app, { ...metrics, combinedOverIdleMs: Number.isFinite(metrics.combinedRead) && Number.isFinite(metrics.idleRead)
        ? metrics.combinedRead - metrics.idleRead : null }];
    }));
    if (report.stop || !report.cleanupConfirmed) { report.verdict.passed = false; report.verdict.verdict = 'step1: stopped'; }
    report.gate = gateVerdict({ step1: { ...report.verdict, driverIdentity: report.driverIdentity }, parity: report.parity, build: report.build?.runtimeBuild,
      engine: engineIdentity(report.build), sleightCommit: report.build?.sleightCommit });
    publish(stem, report, probeMarkdown(report));
  }
  return report;
}
export function probeMarkdown(report) {
  const build = report.build?.runtimeBuild;
  return ['# Runtime gate', '', ...gateMarkdown(report.gate), `Runtime: ${report.runtime}. Build: ${build?.sourceSha256 ?? build?.version ?? 'unknown'}.`,
    `Driver: ${report.driverIdentity?.version ?? 'unknown'}. Driver build: ${report.driverIdentity?.build ?? 'unknown'}.`,
    `Engine: ${report.build?.engineVersion ?? 'unknown'}. Verdict: ${report.verdict.verdict}. Cleanup confirmed: ${report.cleanupConfirmed}.`, '',
    ...(report.sitting ? ['Sitting: true. These samples cannot qualify the runtime.',
      `Sitting completed: ${report.sittingSummary.completed}. Own met every cell latency limit: ${report.sittingSummary.passed}.`,
      'Exit 0: all sitting cells scored and cleanup confirmed, including own latency losses. Exit 1: stopped, unscored cell or unconfirmed cleanup.',
      'Each cell requires its engine p50 within 43 to 48 ms, inclusive. Values outside that range are unscored harness faults.',
      'Engine block runs first, then own. Warm-up and thermal drift may favor either arm.', '',
      '| Sitting cell | Own p50 ms | Own IQR ms | Engine p50 ms | Engine IQR ms | Own / engine | Scored | Harness fault |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...report.cells.map(row => `| ${row.id} | ${row.latencies?.own.p50Ms ?? '-'} | ${row.latencies?.own.iqrMs ?? '-'} | ${row.latencies?.engine.p50Ms ?? '-'} | ${row.latencies?.engine.iqrMs ?? '-'} | ${row.ownOverEngine ?? '-'} | ${row.scored === true} | ${row.harnessFault === true} |`), ''] : []),
    '| Probe | Cell verdict | Own passes | Required | Engine passes | Own p50 ms | Engine p50 limit ms | Start load | End load |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.cells.map(row => `| ${row.id} | ${row.passed ? 'cell-pass' : 'cell-fail'} | ${row.passes}/${row.attempted} | ${row.requiredPasses}/${row.trials} | ${row.group === 6 ? `${row.baselineData.filter(t => t.passed).length}/${row.trials}` : '-'} | ${row.p50Ms ?? '-'} | ${row.p50LimitMs ?? '-'} | ${row.loadStart.join(', ')} | ${row.loadEnd.join(', ')} |`), '',
    ...(report.stop ? [`Stopped: ${report.stop}.`, ''] : []),
    'Each failed trial is retained in JSON. No automatic diagnosis, fix or retry was performed.', ''].join('\n');
}
export function parseProbeOptions(args) {
  const options = { ownerAway: false, dryRun: false, fixRound: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--owner-away') options.ownerAway = true;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--sitting') options.sitting = true;
    else if (['--out', '--fix-round', '--parity'].includes(args[i])) {
      const key = args[i], value = args[++i];
      if (!value || value.startsWith('--')) throw Error('OPTION_VALUE_REQUIRED');
      if (key === '--out') options.out = value; else if (key === '--parity') options.parity = value; else options.fixRound = Number(value);
    } else throw Error('UNKNOWN_OPTION: ' + args[i]);
  }
  if (![0, 1].includes(options.fixRound)) throw Error('INVALID_FIX_ROUND');
  return options;
}
export function probeExitCode(report) {
  return (report.sitting ? report.sittingSummary.completed : report.verdict.passed) ? 0 : 1;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseProbeOptions(args);
  if (options.dryRun) { console.log(JSON.stringify(await runProbePlan(options), null, 2)); return 0; }
  assertProbeSafety({ ...options, held: existsSync('/tmp/sleight-hold'), running: [] }, options.sitting ? sittingPlan() : probePlan());
  outputStem(options.out);
  const controller = new AbortController(), interrupt = () => controller.abort(Error('INTERRUPTED'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const { acquireLiveLock } = await import('./live-lock.mjs');
    const backend = await createLiveProbe({ runtime: options.sitting ? 'own' : runtimeName(), signal: controller.signal, sitting: options.sitting === true });
    const report = await runProbePlan({ ...options, signal: controller.signal }, { backend,
      takeLock: () => acquireLiveLock(undefined, { signal: controller.signal }) });
    return probeExitCode(report);
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
