import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resultText, replayResultStop, windowDifference } from './mapping.mjs';
import { median } from './engine.mjs';
import { campaignEngine } from './engine-identity.mjs';

const selected = (spec, row) => (!spec.tool || row.name === spec.tool) &&
  (!spec.argumentPattern || new RegExp(spec.argumentPattern, 'i').test(JSON.stringify(row.recordedArguments)));

function resultDiff(A, B, path = '$') {
  if (JSON.stringify(A) === JSON.stringify(B)) return [];
  if (A && B && typeof A === 'object' && typeof B === 'object' && Array.isArray(A) === Array.isArray(B))
    return [...new Set([...Object.keys(A), ...Object.keys(B)])].flatMap(key => resultDiff(A[key], B[key], `${path}.${key}`));
  return [{ path, A, B }];
}

function compareResults(A, B, orderedWindows = false) {
  // A changed or missing document is reported separately even when only one arm's
  // copy authenticates. This classification cannot turn a mismatch into a pass.
  const header = item => item?.type === 'text' ? item.text.split('\n', 1)[0] : undefined;
  const headers = new Set([...(A?.content ?? []), ...(B?.content ?? [])].filter(item => item.documentation).map(header));
  const isDoc = item => item.documentation || headers.has(header(item));
  const task = result => result && { ...result, content: (result.content ?? []).filter(item => !isDoc(item)) };
  const docs = result => (result?.content ?? []).filter(isDoc).map(item => ({ type: item.type, text: item.text }));
  const taskA = task(A), taskB = task(B), changes = resultDiff(taskA, taskB);
  const documentationChanges = resultDiff(docs(A), docs(B));
  const reason = A && B && (replayResultStop(taskA) ?? replayResultStop(taskB) ??
    windowDifference(resultText(taskA), resultText(taskB), undefined, { ordered: orderedWindows }));
  return { A, B, changes, ...(headers.size ? { documentation: { verdict: documentationChanges.length ? 'changed' : 'equal', changes: documentationChanges } } : {}),
    ...(reason ? { reason } : documentationChanges.length ? { reason: 'engine documentation text changed' } : {}),
    verdict: A === undefined || B === undefined ? 'missing' : reason || changes.length ? 'changed' : documentationChanges.length ? 'docs-differ' : 'equal' };
}

export function campaignEvidence(runs, spec, roles = {}) {
  const engine = campaignEngine(runs);
  const comparisons = [...new Set(runs.map(r => r.iteration))].flatMap(iteration => {
    const a = runs.find(r => r.iteration === iteration && r.variant === 'A'), b = runs.find(r => r.iteration === iteration && r.variant === 'B');
    if (!roles.baseline) return [];
    const calls = Array.from({ length: Math.max(a?.calls.length ?? 0, b?.calls.length ?? 0) }, (_, index) => {
      const A = a?.calls[index]?.comparisonResult, B = b?.calls[index]?.comparisonResult;
      const selectedBySpec = Boolean(spec && a?.calls[index] && b?.calls[index] && [a, b].every(run => selected(spec, run.calls[index])));
      return { index, ...compareResults(A, B, selectedBySpec) };
    });
    return [{ iteration, calls, complete: Boolean(a && b) }];
  });
  const candidate = runs.filter(r => r.variant === (roles.candidate ?? 'A'));
  const baseline = runs.filter(r => r.variant === roles.baseline);
  const timing = [];
  if (spec?.toolRatioBelow !== undefined) {
    const indexes = [...new Set(candidate.flatMap(r => r.calls.filter(row => selected(spec, row)).map(row => row.index)))];
    for (const index of indexes) {
      const times = group => group.flatMap(r => r.calls.filter(row => row.index === index && selected(spec, row) && row.result && row.toolMs > 0).map(row => row.toolMs));
      const a = times(candidate), b = times(baseline), candidateMs = median(a), baselineMs = median(b);
      const ratio = candidateMs !== null && baselineMs > 0 ? candidateMs / baselineMs : null;
      timing.push({ index, candidateMs, baselineMs, candidateSamples: a.length, baselineSamples: b.length, ratio,
        verdict: ratio === null || a.length !== candidate.length || b.length !== baseline.length || !baseline.length ? 'inconclusive' : ratio < spec.toolRatioBelow ? 'pass' : 'fail' });
    }
    if (!indexes.length) timing.push({ verdict: 'inconclusive', reason: 'Relative timing target was not reached' });
  }
  let verdict = !runs.length || runs.some(r => r.cleanupConfirmed !== true || r.verdict !== 'pass') ? 'diverge' : 'pass';
  if (verdict === 'pass' && (spec && (candidate.some(r => r.check?.verdict !== 'pass') || baseline.some(r => !['pass', 'fail'].includes(r.check?.verdict))) ||
      timing.some(row => row.verdict !== 'pass') || roles.baseline && (candidate.length !== baseline.length || comparisons.some(pair => !pair.complete)) ||
      spec && runs.some(r => !r.calls.some(row => selected(spec, row) && row.result)))) verdict = 'check-incomplete';
  if (comparisons.some(pair => pair.calls.some(row => row.verdict === 'missing' || row.reason && row.reason !== 'engine documentation text changed' || row.verdict === 'changed' &&
      (!spec || !runs.filter(r => r.iteration === pair.iteration).every(r => selected(spec, r.calls[row.index])))))) verdict = 'diverge';
  const docsChanged = comparisons.some(pair => pair.calls.some(row => row.documentation?.verdict === 'changed'));
  if (verdict === 'pass' && docsChanged) verdict = 'docs-differ';
  if (engine.verdict === 'refuse') verdict = 'diverge';
  return { verdict, roles, comparisons, timing, engine,
    ...(engine.reason ? { reason: engine.reason } : docsChanged ? { reason: 'engine documentation text changed' } : {}) };
}

function dragOrder(events) {
  const phases = events.filter(e => e.direction === 'drag-phase').map(e => e.msg);
  if (!phases.length) return { verdict: 'skip', reason: 'Selected build lacks DP2 drag-phase events; use the DPc build with SLEIGHT_TRACE enabled' };
  const stack = [], axStarts = [], axEnds = [];
  let previous = -Infinity;
  const helperPid = phases[0]?.helperPid;
  for (const [index, event] of phases.entries()) {
    if (!event || !['ax-move', 'raise', 'settle', 'posted-press'].includes(event.phase) ||
        !['start', 'end'].includes(event.edge) || !Number.isFinite(event.monoMs) || event.monoMs < 0 || event.monoMs < previous ||
        !Number.isSafeInteger(helperPid) || helperPid < 1 || event.helperPid !== helperPid)
      return { verdict: 'fail', failures: ['Invalid or mixed-helper DP2 phase evidence'] };
    previous = event.monoMs;
    if (event.edge === 'start') stack.push(event.phase);
    else if (stack.pop() !== event.phase) return { verdict: 'fail', failures: ['Unpaired DP2 phase events'] };
    if (event.phase === 'ax-move') (event.edge === 'start' ? axStarts : axEnds).push(index);
  }
  if (stack.length || axStarts.length !== 1 || axEnds.length !== 1)
    return { verdict: 'fail', failures: ['Incomplete or ambiguous DP2 AX-move phase evidence'] };
  if (phases.some((e, i) => e.phase === 'raise' && i < axEnds[0]))
    return { verdict: 'fail', failures: ['DP2 raised the window before AX-move completed'] };
  if (phases.some(e => e.phase === 'posted-press'))
    return { verdict: 'fail', failures: ['Accessibility drag emitted posted-press evidence'] };
  return { verdict: 'pass' };
}

export function checkEvidence(spec, replay, trace = []) {
  const calls = replay.calls.filter(row => selected(spec, row));
  if (!calls.length) return { verdict: 'inconclusive', reason: 'Replay stopped before the check target, or recording has no such call' };
  const failures = [];
  const skipped = [];
  const selectedEvents = [];
  for (const row of calls) {
    const text = resultText(row.result);
    const events = trace.filter(e => e.t >= row.startedAt && e.t <= row.finishedAt);
    selectedEvents.push(...events);
    if (spec.needsInternalOrder) {
      const order = dragOrder(events);
      if (order.verdict === 'fail') failures.push(...order.failures.map(f => `call ${row.index}: ${f}`));
      if (order.verdict === 'skip') skipped.push(`call ${row.index}: ${order.reason}`);
    }
    const responses = events.filter(e => e.direction === 'from-server' || e.direction === 'guard-read');
    if (spec.resultIncludes && !new RegExp(spec.resultIncludes, 'i').test(text)) failures.push(`call ${row.index}: expected result evidence missing`);
    if (spec.alsoResultIncludes && !new RegExp(spec.alsoResultIncludes, 'i').test(text)) failures.push(`call ${row.index}: second result evidence missing`);
    if (spec.resultExcludes && new RegExp(spec.resultExcludes, 'i').test(text)) failures.push(`call ${row.index}: forbidden result`);
    if (spec.traceIncludes && !events.some(e => e.direction && e.direction !== 'to-server' && new RegExp(spec.traceIncludes, 'i').test(JSON.stringify(e)))) failures.push(`call ${row.index}: required trace evidence missing`);
    if (spec.traceDecision) {
      const { direction, expected } = spec.traceDecision;
      const decisions = events.filter(e => e.direction === direction).map(e => e.msg);
      if (!decisions.some(event => event?.decision === expected)) {
        const disabled = spec.switch && replay.env?.[spec.switch] === '0';
        const actual = decisions.map(event => `${event?.decision} (${event?.reason ?? 'no reason'})`).join(', ');
        failures.push(`call ${row.index}: ${direction}: ${actual || (disabled ? `${spec.switch}=0 disables this event` : 'no decision event in relay trace')}; expected ${expected}`);
      }
    }
    if (spec.traceExcludes && responses.some(e => new RegExp(spec.traceExcludes, 'i').test(JSON.stringify(e)))) failures.push(`call ${row.index}: forbidden trace read`);
    if (spec.tabProbeChain) {
      const probes = events.filter(e => e.direction === 'tab-probe').map(e => e.msg);
      if (probes.filter(p => p.decision === 'probe').length < 2 || !probes.some(p => p.transition === true && p.decision === 'probe'))
        failures.push(`call ${row.index}: original tab chain probe evidence missing`);
      if (probes.some(p => p.decision === 'read') || events.filter(e => e.direction === 'guard-read' && e.msg?.phase === 'before-action').length > 1)
        failures.push(`call ${row.index}: intermediate tab-chain tree read`);
    }
  }
  if (spec.traceIncludesAny && !selectedEvents.some(e => e.direction && e.direction !== 'to-server' && new RegExp(spec.traceIncludesAny, 'i').test(JSON.stringify(e))))
    failures.push('No selected call emitted the required trace evidence');
  if (spec.fixturePass && replay.lifecycle?.taskPassed !== true) failures.push('Benchmark fixture check did not pass');
  if (failures.length) return { verdict: 'fail', failures };
  if (skipped.length) return { verdict: 'skip', reason: skipped.join('; ') };
  return { verdict: 'pass', coveredCalls: calls.map(c => c.index) };
}

export function assertCheck(spec, replay, dir) {
  const files = readdirSync(dir).filter(name => /^trace-\d+\.jsonl$/.test(name));
  if (!files.length) return { id: spec.id, verdict: 'inconclusive', reason: 'Relay trace-<pid>.jsonl is missing; trace.jsonl contains replay transport only' };
  const trace = files.flatMap(name =>
    readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  return { id: spec.id, ...checkEvidence(spec, replay, trace) };
}
