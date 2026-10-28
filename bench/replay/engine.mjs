import { performance } from 'node:perf_hooks';
import { divergence, refreshCode, resultText, TargetMapper, comparisonResult, normalized, replayResultStop } from './mapping.mjs';
import { assertReplayArguments } from './allowlist.mjs';
import { replayDocumentation, taskResult } from './documentation.mjs';
import { matchingMedia } from './images.mjs';
export { parseEnv } from './switches.mjs';

export function untilAbort(signal, operation) {
  if (!signal) return Promise.resolve().then(operation);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error('Replay aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function replayCalls(calls, { call, mapper = new TargetMapper(), signal, beforeCall = () => {}, record = () => {}, comparison = 'recording', documentation = replayDocumentation() } = {}) {
  if (!['recording', 'switches', 'worktrees'].includes(comparison)) throw Error('Unknown replay comparison');
  const rows = [];
  let verdict = 'pass', reason;
  for (const [index, original] of calls.entries()) {
    const startedAt = new Date().toISOString();
    let args, result, recordingTextDifference, mappingMs = 0, toolMs = 0;
    try {
      await untilAbort(signal, beforeCall);
      assertReplayArguments(original.arguments);
      if (comparison === 'switches') {
        const stop = replayResultStop(original.result, documentation);
        if (stop) throw Error(stop);
      }
      try { args = mapper.arguments(original.arguments); }
      catch (error) {
        // Never retry an action. Refresh only before sending it, on an already acquired handle.
        if (!/refresh required/.test(error.message)) throw error;
        const native = original.name === 'js';
        if (!native && original.server !== 'sleight-turbo') throw error;
        const refresh = native ? { code: mapper.replaceStrings(refreshCode(original.arguments)), title: 'Replay target refresh' }
          : { tab: mapper.arguments({ tab: original.arguments.tab }).tab, max_chars: 40000 };
        const start = performance.now();
        const fresh = await untilAbort(signal, () => call(original.server, native ? 'js' : 'browser_read', refresh));
        mappingMs = performance.now() - start;
        record({ event: 'mapping-read', index, arguments: refresh, result: fresh, ms: mappingMs });
        if (fresh.isError || comparison !== 'recording' && replayResultStop(fresh, documentation)) throw Error('Target refresh failed');
        mapper.after = resultText(fresh);
        mapper.refresh(mapper.after, original.arguments);
        args = mapper.arguments(original.arguments);
      }
      await untilAbort(signal, beforeCall);
      const start = performance.now();
      try { result = await untilAbort(signal, () => call(original.server, original.name, args)); }
      finally { toolMs = performance.now() - start; }
      if (comparison !== 'recording') {
        const stop = replayResultStop(result, documentation);
        if (stop) throw Error(stop);
      }
      mapper.observe(resultText(original.result), resultText(result), original.arguments, original);
      const recorded = normalized(resultText(original.result), mapper, true, original.arguments.tab), fresh = normalized(resultText(result), mapper);
      if (recorded !== fresh) recordingTextDifference = { recorded, replay: fresh };
      // Worktree campaigns compare the live arms below, never old engine output.
      if (comparison === 'worktrees') {
        const task = taskResult(result, documentation);
        // Validate fresh media here. Window identity compares A with B in campaignEvidence.
        const media = (task.content ?? []).filter(block => block.type !== 'text'), text = resultText(task);
        if (!matchingMedia(media, media, text, text, new TargetMapper())) reason = 'non-text evidence changed; visual interpretation required';
      } else reason = divergence(original.result, result, mapper, original.arguments, { comparison, documentation });
    } catch (error) { reason = error.message; }
    const row = { index, id: original.id, server: original.server, name: original.name, arguments: args,
      recordedArguments: original.arguments, expected: original.result, result, toolMs, mappingMs, startedAt, finishedAt: new Date().toISOString(),
      comparisonResult: result && comparisonResult(result, mapper, documentation),
      ...(recordingTextDifference ? { recordingTextDifference } : {}),
      verdict: reason ? 'diverge' : 'pass', ...(reason ? { reason } : {}) };
    rows.push(row); record({ event: 'call', ...row });
    if (reason) { verdict = 'diverge'; break; }
  }
  return { verdict, reason, plannedCalls: calls.length, calls: rows,
    totalToolMs: rows.reduce((n, row) => n + row.toolMs, 0), totalMappingMs: rows.reduce((n, row) => n + row.mappingMs, 0) };
}

export function schedule(repeat, variants) {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) throw Error('--repeat must be 1 to 100');
  return Array.from({ length: repeat }, (_, iteration) => variants
    .map(variant => ({ iteration: iteration + 1, ...variant }))).flat();
}
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}
export function summarize(runs) {
  return [...new Set(runs.map(r => r.variant))].map(variant => {
    const group = runs.filter(r => r.variant === variant), complete = group.filter(r => r.verdict === 'pass');
    return { variant, runs: group.length, passing: complete.length,
      totalToolMedianMs: median(complete.map(r => r.totalToolMs)),
      // Keep divergent prefixes visible, but never present their short totals as a speed win.
      calls: Array.from({ length: Math.max(0, ...group.map(r => r.calls.length)) }, (_, index) => {
        const rows = group.flatMap(r => r.calls[index] ? [r.calls[index]] : []);
        return { index, samples: rows.length, passing: rows.filter(r => r.verdict === 'pass').length,
          toolMedianMs: median(rows.map(r => r.toolMs)), mappingMedianMs: median(rows.map(r => r.mappingMs)) };
      }) };
  });
}
