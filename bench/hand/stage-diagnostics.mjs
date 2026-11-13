// Offline receipt accounting. ST9 includes the fixture, renderer and descendant process tree.
// Decode/cache/install can share an interval. Their buckets overlap and must never be added together.
export const COST_PHASES = Object.freeze(['decode', 'cache', 'install', 'animate', 'parked']);
const finite = n => Number.isFinite(n) && n >= 0;
const visibility = s => s?.shown === true ? 'visible' : s?.shown === false ? 'hidden' : 'unknown';
const phases = (a, b) => {
  if (!a || !b) return [];
  const out = [];
  if (a.pending > 0 || b.pending > 0 || b.decodes > a.decodes) out.push('decode');
  if (b.cacheBytes !== a.cacheBytes || b.cacheHits > a.cacheHits || b.cacheSelects > a.cacheSelects) out.push('cache');
  if (b.installCount > a.installCount) out.push('install');
  if (a.activity === b.activity && ['animate', 'parked'].includes(b.activity)) out.push(b.activity);
  return out;
};
// samples counts observations in byVisibility and tagged intervals in byPhase.
// mixed has interval costs only; its sample count stays zero.
const empty = () => ({ samples: 0, intervals: 0, wallS: 0, cpuS: null, avgCpuPct: null, peakRssMiB: null,
  windowServer: { scope: 'whole-machine, overlapping activity', cpuS: null, avgPct: null, peakPct: null } });
function add(bucket, row) {
  bucket.intervals++; bucket.wallS += row.wallS;
  bucket.cpuS = (bucket.cpuS ?? 0) + row.cpuS;
  bucket.avgCpuPct = bucket.cpuS / bucket.wallS * 100;
  bucket.peakRssMiB = Math.max(bucket.peakRssMiB ?? 0, row.peakRssMiB);
  bucket.windowServer.cpuS = (bucket.windowServer.cpuS ?? 0) + row.wsCpuS;
  bucket.windowServer.avgPct = bucket.windowServer.cpuS / bucket.wallS * 100;
  bucket.windowServer.peakPct = Math.max(bucket.windowServer.peakPct ?? 0, row.wsCpuS / row.wallS * 100);
}
export function attributeStageCosts(samples, hostPid) {
  const buckets = () => Object.fromEntries(['visible', 'hidden', 'mixed', 'unknown'].map(k => [k, empty()]));
  const byVisibility = buckets(), byPhase = Object.fromEntries(COST_PHASES.map(p => [p, buckets()]));
  let unmeasuredIntervals = 0, unmeasuredWallS = 0;
  const intervals = [];
  for (let i = 0; i < samples.length; i++) {
    const b = samples[i], a = samples[i - 1], state = visibility(b.status);
    byVisibility[state].samples++;
    if (!a) continue;
    const before = a.hosts?.[hostPid], after = b.hosts?.[hostPid];
    const vis = visibility(a.status) === state ? state : 'mixed', tags = phases(a.status, b.status);
    const valid = before && after && b.t > a.t && b.t - a.t <= 1500 &&
      [before.cpu, after.cpu, before.rssKb, after.rssKb, a.ws, b.ws].every(finite) && after.cpu >= before.cpu && b.ws >= a.ws;
    if (!valid) {
      unmeasuredIntervals++;
      // Unknown or non-increasing clocks have no elapsed duration to attribute.
      if (Number.isFinite(a.t) && Number.isFinite(b.t) && b.t > a.t) unmeasuredWallS += (b.t - a.t) / 1000;
      continue;
    }
    const row = { from: a.t, to: b.t, visibility: vis, phases: tags, wallS: (b.t - a.t) / 1000,
      cpuS: after.cpu - before.cpu, peakRssMiB: Math.max(before.rssKb, after.rssKb) / 1024, wsCpuS: b.ws - a.ws,
      hideReason: b.status?.hideReason ?? null, callMonitor: b.status?.callMonitor ?? null };
    intervals.push(row); add(byVisibility[vis], row);
    for (const phase of tags) { byPhase[phase][vis].samples++; add(byPhase[phase][vis], row); }
  }
  const hideReasonCounts = {}, differences = [];
  for (const sample of samples) {
    for (const [reason, count] of Object.entries(sample.status?.hideReasonCounts ?? {})) {
      if (finite(count)) hideReasonCounts[reason] = Math.max(hideReasonCounts[reason] ?? 0, count);
    }
    if (finite(sample.status?.maxWindowBoundsDifferencePt)) differences.push(sample.status.maxWindowBoundsDifferencePt);
  }
  return { hideReasonCounts, maxWindowBoundsDifferencePt: differences.length ? Math.max(...differences) : null,
    scope: samples.some(s => s.processTreeMeasured === true) ?
      'fixture, renderer and descendant process tree; phase buckets overlap at sampler resolution' :
      'fixture-and-renderer process; phase buckets overlap at sampler resolution',
    intervalRule: 'adjacent samples only, maximum 1500 ms; transitions are mixed',
    byVisibility, byPhase, unmeasuredIntervals, unmeasuredWallS, intervals };
}

// Identity comes from the owned fixture's renderer panel, never a global window-list guess.
export function rendererWindowTimeline(samples, ownedPid) {
  let generation = 0, previous = null;
  return samples.map(sample => {
    const raw = sample.status ?? sample;
    const owned = raw.pid === ownedPid && Number.isSafeInteger(raw.panelID) && raw.panelID > 0;
    const id = owned ? raw.panelID : null;
    if (id !== null && id !== previous) generation++;
    const row = { t: sample.t, ownerPid: ownedPid, panelID: id, generation, shown: owned && raw.shown === true,
      hideReason: raw.hideReason ?? null, rejectedForeignIdentity: raw.panelID != null && !owned };
    if (id !== null) previous = id;
    return row;
  });
}

export function replayObservations(rows) {
  return rows.filter(r => ['stage', 'stage-hide', 'stage-stats', 'end'].includes(r.effect)).map(r => ({
    effect: r.effect, time: r.time ?? null, seq: r.seq ?? null, shown: r.effect === 'stage' || r.shown === true,
    hideReason: r.reason ?? r.hiddenReason ?? null, retainedTargetRectangles: r.turnTargets ?? null,
    rung: r.rung ?? null,
  }));
}
