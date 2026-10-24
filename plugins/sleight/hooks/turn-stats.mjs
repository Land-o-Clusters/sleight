// User-facing numbers only. This module runs in the mod's sandbox and never reads a transcript or prices a model.
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const count = value => Number.isSafeInteger(value) ? number(value) : null;
const fields = ['calls', 'reads', 'characters', 'errors', 'pending', 'omitted', 'unclassified', 'toolMs'];
const pathNames = ['native', 'turbo', 'engine'];

function counters(value) {
  if (!value || fields.some(key => count(value[key]) === null)) return null;
  if (!value.text || ['docs', 'tree', 'other'].some(key => count(value.text[key]) === null) ||
      value.text.docs + value.text.tree + value.text.other !== value.characters) return null;
  const paths = {};
  for (const name of pathNames) {
    const part = value.paths?.[name];
    if (!part || ['actions', 'estimatedActions', 'actionMs', 'timedActions'].some(key => number(part[key]) === null) ||
        count(part.actions) === null || count(part.estimatedActions) === null || count(part.timedActions) === null ||
        part.estimatedActions > part.actions || part.timedActions > part.actions || !part.timedActions && part.actionMs !== 0) return null;
    const estimatedCalls = count(part.estimatedCalls);
    if (estimatedCalls === null) return null;
    paths[name] = { estimatedCalls, actions: part.actions, estimatedActions: part.estimatedActions, actionMs: part.actionMs, timedActions: part.timedActions };
  }
  return { ...Object.fromEntries(fields.map(key => [key, value[key]])), text: { docs: value.text.docs, tree: value.text.tree, other: value.text.other }, paths };
}

export function statsFromReply(reply) {
  const meta = counters(reply?._meta?.['sleight/stats']);
  if (meta) return meta;
  for (const block of [...reply?.content ?? []].reverse()) {
    if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.startsWith('sleight-turn-stats: ') || block.text.length > 8192) continue;
    try {
      const parsed = JSON.parse(block.text.slice('sleight-turn-stats: '.length));
      if (parsed?.unavailable === true) return null;
      const value = counters(parsed); if (value) return value;
    } catch {}
  }
  return null;
}

export function costSnapshot(value) {
  const startedAt = number(value?.startedAt), usd = number(value?.cost?.usd);
  return startedAt === null || usd === null ? null : { startedAt, usd };
}

export function turnSummary(event, ledger, baseline = null) {
  const usage = event?.usage;
  const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  return {
    durationMs: number(event?.durationMs), interrupted: event?.isAborted === true,
    tokens: usage && typeof usage === 'object' ? Object.fromEntries(keys.map(key => [key, count(usage[key])])) : null,
    costUsd: ledger?.usd ?? null,
    costDeltaUsd: ledger && baseline && ledger.startedAt === baseline.startedAt && ledger.usd >= baseline.usd ? ledger.usd - baseline.usd : null,
    stats: null,
  };
}

const seconds = ms => (ms / 1000).toFixed(1);
const shown = value => value === null ? 'unavailable' : String(value);
export function turnStatsText(summary) {
  if (!summary) return 'No completed sleight turn in this session yet.';
  const lines = [`Last sleight turn: ${summary.durationMs === null ? 'time unavailable' : `${seconds(summary.durationMs)} s`}${summary.interrupted ? ' (interrupted)' : ''}`];
  const s = summary.stats;
  if (s && !s.omitted) {
    lines.push(`Sleight (main loop): ${s.calls} calls, ${s.reads} read-only call${s.reads === 1 ? '' : 's'}, ${s.characters} characters delivered (UTF-16).`);
    lines.push(`Text by heading: docs ${s.text.docs}, UI trees ${s.text.tree}, other ${s.text.other}.`);
    const names = { native: 'Native apps', turbo: 'Turbo', engine: 'Engine browser' };
    const actions = pathNames.filter(name => s.paths[name].actions || s.paths[name].estimatedCalls).map(name => {
      const p = s.paths[name];
      const estimate = p.estimatedCalls > 0;
      const label = !p.actions && estimate ? `0 estimated; aliases can be missed (${names[name]})`
        : `${names[name]} ${p.actions}${estimate ? ` (${p.estimatedActions} from code, estimated; aliases can be missed)` : ''}`;
      return label + ', ' +
        (p.timedActions ? `mean ${seconds(p.actionMs / p.timedActions)} s/action (${p.timedActions} timed)` : 'action timing unavailable');
    });
    lines.push(actions.length ? 'Actions: ' + actions.join('; ') + '. Times use action-span receipts only.' : 'Actions: none counted.');
    lines.push(`Tool wall time: ${seconds(s.toolMs)} s for completed calls, including checks and approvals.`);
    if (s.errors || s.pending || s.omitted || s.unclassified) lines.push(`Counts incomplete: ${s.errors} errors, ${s.pending} pending calls, ${s.omitted} omitted calls, ${s.unclassified} calls with unknown actions.`);
    if (pathNames.some(name => s.paths[name].estimatedCalls)) lines.push('Code counts can miss aliases or repeated loop actions, and can include untaken branches.');
  } else lines.push(s?.omitted ? 'Sleight stats unavailable: collector capacity exceeded.' : 'Sleight stats unavailable.');
  const t = summary.tokens;
  lines.push(t ? `Tokens (main loop, host): input ${shown(t.input_tokens)}, output ${shown(t.output_tokens)}, cache read ${shown(t.cache_read_input_tokens)}, cache write ${shown(t.cache_creation_input_tokens)}.`
    : 'Tokens (main loop, host): unavailable.');
  lines.push(`Host cost (session total so far, including subagents): ${summary.costUsd === null ? 'unavailable' : '$' + summary.costUsd.toFixed(4)}.`);
  lines.push(`Host cost since turn start: ${summary.costDeltaUsd == null ? 'unavailable' : '$' + summary.costDeltaUsd.toFixed(4)} (including subagents).`);
  return lines.join('\n');
}
