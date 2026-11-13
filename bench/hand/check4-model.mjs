// One benchmark child per task. The sampler runs through setup and cleanup; figures use only run timestamps.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadavg } from 'node:os';
import { modelBenchCommand } from './check4.mjs';
import { taskResult, touches, smokeResult } from './check4-measurement.mjs';
import { parseCell, walk, memberCall } from '../../plugins/sleight/lib/code-ast.mjs';
import { auditStageTrace } from '../../tests/fixtures/stage-stateful-fuzz.mjs';
import { defaultArmHome, loginTarget } from '../world/login-readiness.mjs';
import { parseRecording } from '../replay/recording.mjs';
import { protocolFigures, turnEndReceipt } from './check4-reporting.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const unmeasured = reason => ({ measured: false, visibleShare: null, visibleMs: null, verdict: 'unmeasured', reason });
const actionMethods = new Set(['pressKey', 'typeText', 'paste', 'click', 'doubleClick', 'rightClick', 'scroll', 'drag', 'setValue', 'selectText', 'performSecondaryAction', 'performAction']);
export function actionKinds(call) {
  if (call.msg?.params?.name === 'drag') return ['drag'];
  if (call.msg?.params?.name !== 'js') return [];
  const code = call.msg.params.code ?? call.msg.params.arguments?.code, { ast } = parseCell(code);
  return ast ? [...new Set([...walk(ast)].filter(n => n.type === 'CallExpression').map(memberCall)
    .filter(c => c && actionMethods.has(c.method)).map(c => c.method))] : [];
}
export function scrollOrdinal(calls, scrollEpochMs) {
  const open = calls.findIndex(c => c.msg.params.name === 'open_file');
  if (open < 0 || !Number.isFinite(scrollEpochMs)) return null;
  const preceding = calls.findLastIndex(c => Date.parse(c.t) <= scrollEpochMs);
  if (preceding <= open || !actionKinds(calls[preceding]).includes('scroll')) return null;
  return calls.slice(open + 1, preceding + 1).filter(c => actionKinds(c).length > 0).length;
}

export function modelTaskResult({ task, row, trace = [], rows = [], audit, hostTrace, recordedCalls, cleanupConfirmed, reseated = false }) {
  const base = { benchmarkPassed: row?.passed ?? null, benchmarkReason: row?.reason ?? null, cleanupConfirmed: cleanupConfirmed === true,
    fixtureFailure: !row?.stamps, actualTask: task.id,
    benchmark: row ? { task: row.task, run: row.run, passed: row.passed, reason: row.reason, models: row.models,
      engineVersion: row.engineVersion, finishedAt: row.finishedAt, stamps: row.stamps, exitCode: row.exitCode } : null };
  if (row?.arm !== 'sleight' || row?.task !== task.id || row?.run !== 1 || typeof row.passed !== 'boolean' || row.groupClean !== true)
    return { ...base, ...unmeasured('Benchmark row absent, mismatched or not collected') };
  const received = trace.filter(e => e.direction === 'call-received' && e.msg?.params?.name && e.msg.params.name !== 'turn_ended')
    .map(e => Date.parse(e.t)).filter(Number.isFinite);
  const startEpochMs = received.length ? Math.min(...received) : NaN, exitEpochMs = row.stamps?.exitAt;
  const terminal = turnEndReceipt(trace, startEpochMs, exitEpochMs);
  const endEpochMs = terminal ? Date.parse(terminal.t) : exitEpochMs;
  const clockRows = rows.filter(r => Number.isFinite(r.epochMs) && Number.isFinite(r.t));
  const offsets = clockRows.map(r => r.t - r.epochMs);
  if (!Number.isFinite(startEpochMs) || !Number.isFinite(endEpochMs) || endEpochMs <= startEpochMs ||
      !clockRows.some(r => r.epochMs <= startEpochMs) || !clockRows.some(r => r.epochMs >= endEpochMs) ||
      Math.max(...offsets) - Math.min(...offsets) > 100)
    return { ...base, ...unmeasured('Run timestamps or sampler clock coverage missing or unstable') };
  const offset = at => { const nearest = clockRows.reduce((a, b) => Math.abs(a.epochMs - at) <= Math.abs(b.epochMs - at) ? a : b);
    return nearest.t - nearest.epochMs; };
  const start = startEpochMs + offset(startEpochMs), end = endEpochMs + offset(endEpochMs);
  const protocol = protocolFigures({ trace, recordedCalls, hostTrace, rows, start, end: exitEpochMs + offset(exitEpochMs),
    startEpochMs, endEpochMs: exitEpochMs, epochToHost: t => t + offset(t) });
  const drivingEvents = hostTrace?.records?.filter(r => r.input?.event && r.input.now * 1000 >= start && r.input.now * 1000 <= end) ?? [];
  const requiresWide = drivingEvents.some(r => ['drag', 'scroll'].includes(r.input.event.state) || ['drag', 'scroll'].includes(r.input.event.wideReason));
  const figures = taskResult({ taskId: task.id, replay: { verdict: 'pass', lifecycle: { passed: true }, cleanupConfirmed },
    rows, start, end, audit, reseated, requiresWide });
  // Task correctness is independent of character measurement. Wrong answers still consume driving time.
  const result = { ...figures, ...base,
    ...protocol,
    fixtureFailure: false, driving: { start, end, startEpochMs, endEpochMs,
    startSource: 'relay first call-received', endSource: protocol.turnEndedDriving.endSource,
    processExitEpochMs: exitEpochMs, processExitEnd: protocol.exitDriving.end,
    processExitDurationMs: protocol.exitDriving.durationMs, processExitVisibleShare: protocol.exitDriving.visibleShare },
    verdict: figures.measured && !row.passed ? 'fail' : figures.verdict };
  result.micUnknownShownSamples = rows.filter(r => r.t >= start && r.t <= end && r.valid && r.status?.shown === true &&
    r.panel?.onScreen && r.status.callMonitor?.active === true).length;
  const scroll = hostTrace?.records?.find(r => r.input?.event && r.input.now * 1000 >= start && r.input.now * 1000 <= protocol.exitDriving.end &&
    (r.input.event.state === 'scroll' || r.input.event.area && r.input.event.wideReason === 'scroll'))?.input.now;
  // Retain the old exit-based time fraction beside the ordinal for one release.
  result.firstScrollFractionOfDrivingTime = Number.isFinite(scroll) ? (scroll * 1000 - start) / (protocol.exitDriving.end - start) : null;
  if (!result.characterNeverShown && task.earlyScroll && result.earlyScrollWitness.withinFirstTwoActions !== true)
    Object.assign(result, unmeasured('No correlated scroll among the first two action-bearing calls after open_file'));
  if (task.crossWindowDrag) {
    const targets = hostTrace?.records?.filter(r => r.input?.event?.state === 'drag' && r.input.now * 1000 >= start && r.input.now * 1000 <= end) ?? [];
    result.crossWindowDragObserved = row.methodAudit?.complete === true && row.methodAudit.drag === true && row.methodAudit.replacement === false &&
      targets.some(r => {
        const e = r.input.event;
        if (!Array.isArray(e.at) || !Array.isArray(e.end)) return false;
        const nearest = rows.reduce((a, b) => Math.abs(a.t - r.input.now * 1000) <= Math.abs(b.t - r.input.now * 1000) ? a : b);
        if (Math.abs(nearest.t - r.input.now * 1000) > 100) return false;
        const observed = nearest.windows ?? [];
        // CGWindowList order is front to back. Covered older documents do not make the top fixture ambiguous.
        const at = observed.find(w => w.layer === 0 && w.alpha > 0 && touches(w.frame, [...e.at, 0.001, 0.001]));
        const end = observed.find(w => w.layer === 0 && w.alpha > 0 && touches(w.frame, [...e.end, 0.001, 0.001]));
        return at && end && (at.pid !== end.pid || at.id !== end.id) &&
          [at, end].some(w => w.pid === e.pid && w.id === e.window);
      });
    if (!result.characterNeverShown && !result.crossWindowDragObserved) Object.assign(result, unmeasured('No real cross-window drag frame during driving'));
  }
  return result;
}

export async function runModelBench(task, { dir, repo, config, startSampler, spawnChild = spawn, signal, smoke = false,
  command = process.execPath, benchEntry = join(repo, 'bench/run.mjs'), env = {}, auditTrace = auditStageTrace }) {
  const loadBefore = loadavg();
  const privateConfig = { ...config, schema: 'sleight.check4-bench/1', dir, task: task.id, worktree: repo,
    loginConfig: loginTarget('sleight', { armHome: defaultArmHome(), env: process.env }).config,
    result: join(dir, 'bench-result.json'), evidence: join(dir, 'evidence'), transcript: join(dir, 'evidence/transcript.jsonl'),
    collections: join(dir, 'collections'), armDir: join(dir, 'arm'), pids: join(dir, 'task-pids.json'),
    status: join(dir, 'host-status.json'), trace: join(dir, 'host-trace.json') };
  for (const path of [privateConfig.evidence, privateConfig.collections, privateConfig.armDir, join(dir, 'claude')]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(privateConfig.pids, '{"pids":[]}', { mode: 0o600 });
  const configPath = join(dir, 'bench-config.json'); writeFileSync(configPath, JSON.stringify(privateConfig), { mode: 0o600 });
  let sampler, exit, failure;
  try {
    signal?.throwIfAborted();
    sampler = await startSampler(privateConfig);
    const child = spawnChild(command, [benchEntry, ...modelBenchCommand(task.id, configPath).slice(2)], {
      cwd: repo, env: { ...process.env, ...env, SLEIGHT_BENCH_HAND: '1',
        CLAUDE_CONFIG_DIR: join(dir, 'claude') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const collected = new Promise(resolve => child.once('close', (code, childSignal) => resolve({ code, signal: childSignal })));
    child.once('error', error => { failure = error.message; });
    child.stdout.on('data', chunk => appendFileSync(join(dir, 'bench.stdout.log'), chunk, { mode: 0o600 }));
    child.stderr.on('data', chunk => appendFileSync(join(dir, 'bench.stderr.log'), chunk, { mode: 0o600 }));
    // Notify bench's own controller immediately on owner return. The run guard supplies bounded escalation and collection.
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    try { exit = await collected; }
    finally { signal?.removeEventListener('abort', stop); }
  } catch (error) { failure = error.message; }
  finally {
    if (sampler) { const ended = await sampler.close(); if (ended.code !== 0) failure = `Sampler collection failed: ${ended.signal ?? ended.code}`; }
  }
  let receipt, hostTrace, audit, recordedCalls, traces = [], hostCollections = [];
  try {
    receipt = json(privateConfig.result);
    hostCollections = readdirSync(privateConfig.collections).map(name => json(join(privateConfig.collections, name)));
    hostTrace = existsSync(privateConfig.trace) ? json(privateConfig.trace) : undefined;
    if (hostTrace?.complete === true) audit = { ...auditTrace(hostTrace), complete: true };
    traces = readdirSync(privateConfig.evidence).filter(name => /^trace-\d+\.jsonl$/.test(name)).flatMap(name =>
      readFileSync(join(privateConfig.evidence, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  } catch (error) { failure ??= `Benchmark evidence incomplete: ${error.message}`; }
  // Missing action input leaves the ordinal unknown and the early-scroll task unmeasured.
  try { recordedCalls = parseRecording(readFileSync(privateConfig.transcript, 'utf8')); } catch { /* Unknown ordinal is reported. */ }
  const cleanupConfirmed = !failure && receipt?.cleanupConfirmed === true && hostCollections.every(r => r.collected === true) &&
    exit?.signal == null && [0, 1].includes(exit?.code);
  const rows = sampler?.rows?.filter(r => r.source === 'CGWindowListCopyWindowInfo') ?? [];
  const final = rows.findLast(r => r.valid)?.status;
  const result = modelTaskResult({ task, row: receipt?.row, trace: traces, rows, audit, hostTrace, recordedCalls, cleanupConfirmed,
    reseated: final?.size === 'stage' && final?.shown === true && final?.turnTargets <= 1 && ['done', 'handback'].includes(final?.eventState) });
  return { ...(smoke ? smokeResult(result, rows) : result), dir, benchExit: exit ?? null, ...(failure ? { reason: failure } : {}),
    stopped: signal?.aborted === true, transcript: privateConfig.transcript,
    hostLoad: { before: loadBefore, after: loadavg(), intervalsMinutes: [1, 5, 15] } };
}
