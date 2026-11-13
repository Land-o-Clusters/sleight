// Geometry receipts for the stage benchmark. No live imports or application access.
import { isDeepStrictEqual } from 'node:util';
import { randomBytes } from 'node:crypto';
function withoutSessionNonce(value) {
  if (Array.isArray(value)) return value.map(withoutSessionNonce);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'nonce').map(([key, v]) => [key, withoutSessionNonce(v)]));
  return value;
}
export const TRACE_LIMIT = 4 * 1024 * 1024;
export function stageReplayReceipt({ frame, trace, scenario, actions = [], marks = {} }) {
  if (!['small-target-turn-lifecycle', 'full-window-scroll-stress'].includes(scenario)) throw Error('unknown trace arm');
  if (!frame || frame.hand !== 'character') throw Error('character frame required');
  if (trace?.schema !== 'sleight.stage-trace/1' || trace.complete !== true || !Array.isArray(trace.records) ||
      !trace.records.length || trace.records.length > 16384) throw Error('incomplete stage trace');
  let previous = -Infinity, clockDiscontinuities = 0;
  for (const [order, row] of trace.records.entries()) {
    if (row.order !== order || !row.input || !row.output) throw Error('stage trace ordering gap');
    if (row.input.op !== 'windows') {
      if (!Number.isFinite(row.input.now)) throw Error('stage trace clock invalid');
      if (row.input.now < previous) clockDiscontinuities++;
      previous = row.input.now;
      if (!Number.isInteger(row.output.turnTargets) || typeof row.output.shown !== 'boolean') throw Error('stage trace lacks result');
    }
  }
  const receipt = { schema: 'sleight.stage-replay/1', scenario, frame: withoutSessionNonce(frame), trace: withoutSessionNonce(trace), actions: withoutSessionNonce(actions), marks, clockDiscontinuities,
    witnesses: { completion: 'scheduled, non-authoritative', delivery: 'unknown', consumption: 'unknown', dependencyRelease: 'unknown' },
    geometryOnly: true, pixelsVerified: false };
  if (Buffer.byteLength(JSON.stringify(receipt)) > TRACE_LIMIT) throw Error('stage replay receipt exceeds bound');
  return receipt;
}
export function stageReplayLines(receipt) {
  stageReplayReceipt(receipt);
  // These are already resolved runtime transactions, including ring delivery order and art selections.
  // Reconstructing a scheduled sequence would lose that information.
  return [{ ...receipt.frame, nonce: randomBytes(32).toString('hex') }, { dumpTrace: true }, ...receipt.trace.records.map(r => ({ dumpTransaction: r.input })), { dumpTraceRead: true }];
}
export function stageTraceFigures(trace, { start, end, sampleTimes = [] } = {}) {
  if (trace?.complete !== true || !Array.isArray(trace?.records)) return { measured: false, reason: 'incomplete trace' };
  const rows = trace.records.filter(r => r.input.op !== 'windows');
  if (rows.some((r, i) => i && r.input.now < rows[i - 1].input.now)) return { measured: false, reason: 'clock discontinuity' };
  const a = start ?? rows[0]?.input.now, b = end ?? rows.at(-1)?.input.now;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return { measured: false };
  const seconds = { stage: 0, 'three-quarter': 0, medium: 0, small: 0, hidden: 0 };
  let prior = { shown: false }, at = a;
  for (const row of rows) {
    const t = row.input.now;
    if (t < a) { prior = row.output; continue; }
    if (t > b) break;
    seconds[prior.shown ? prior.draw?.rung ?? 'hidden' : 'hidden'] += t - at;
    at = t; prior = row.output;
  }
  seconds[prior.shown ? prior.draw?.rung ?? 'hidden' : 'hidden'] += b - at;
  const samples = Object.fromEntries(Object.keys(seconds).map(k => [k, 0]));
  let i = 0, current;
  for (const t of sampleTimes) {
    if (!Number.isFinite(t) || t < a || t > b) continue;
    while (i < rows.length && rows[i].input.now <= t) current = rows[i++].output;
    samples[current?.shown ? current.draw?.rung ?? 'hidden' : 'hidden']++;
  }
  const count = Object.values(samples).reduce((a, b) => a + b, 0);
  return { measured: true, seconds, shares: Object.fromEntries(Object.entries(seconds).map(([k, v]) => [k, v / (b - a)])),
    samples, sampleCount: count, sampleShares: count ? Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v / count])) : null };
}
// Integrate installed plans through their actual transaction intervals. This measures plan opacity,
// not captured pixels or live presentation. Polls that keep a plan do not restart its fade.
export function stageTraceVisibility(trace, { start, end } = {}) {
  const figures = stageTraceFigures(trace, { start, end });
  if (!figures.measured) return figures;
  const rows = trace.records.filter(r => r.input.op !== 'windows');
  const a = start ?? rows[0]?.input.now, b = end ?? rows.at(-1)?.input.now;
  let shownSeconds = 0, nonzeroSeconds = 0, opacitySeconds = 0, invalid = false;
  const interval = (state, lo, hi) => {
    if (!state.shown || hi <= lo) return;
    const keys = state.draw?.opacity, began = state.planBegan;
    if (!Number.isFinite(began) || !Array.isArray(keys) || !keys.length || keys.some((p, i) =>
      !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p[1] < 0 || p[1] > 1 || i && p[0] < keys[i - 1][0])) {
      invalid = true; return;
    }
    const opacity = t => {
      const local = t - began;
      if (local <= keys[0][0]) return keys[0][1];
      for (let i = 1; i < keys.length; i++) if (local <= keys[i][0]) {
        const x = keys[i - 1], y = keys[i];
        return x[1] + (y[1] - x[1]) * ((local - x[0]) / (y[0] - x[0]));
      }
      return keys.at(-1)[1];
    };
    const cuts = [lo, ...keys.map(p => began + p[0]).filter(t => t > lo && t < hi), hi];
    shownSeconds += hi - lo;
    for (let i = 1; i < cuts.length; i++) {
      const left = opacity(cuts[i - 1]), right = opacity(cuts[i]), dt = cuts[i] - cuts[i - 1];
      opacitySeconds += dt * (left + right) / 2;
      if (left > 0 || right > 0) nonzeroSeconds += dt;
    }
  };
  let at = a, prior = { shown: false };
  for (const row of rows) {
    const time = row.input.now;
    if (time < a) { prior = row.output; continue; }
    if (time > b) break;
    interval(prior, at, time); at = time; prior = row.output;
  }
  interval(prior, at, b);
  if (invalid) return { measured: false, reason: 'missing or invalid installed opacity plan' };
  return { measured: true, durationSeconds: b - a, shownSeconds, nonzeroSeconds, opacitySeconds,
    shownShare: shownSeconds / (b - a), nonzeroShare: nonzeroSeconds / (b - a), opacityShare: opacitySeconds / (b - a), pixelsVerified: false };
}
export function compareStageReplay(captured, replayed) {
  const fields = ['turnTargets', 'contributors', 'shown', 'hiddenReason', 'seq', 'planBegan', 'draw'];
  const a = captured.records.filter(r => r.input.op !== 'windows'), b = replayed.records.filter(r => r.input.op !== 'windows');
  const mismatches = [];
  if (!captured.complete || !replayed.complete || a.length !== b.length) mismatches.push({ reason: 'incomplete trace or transaction count' });
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].input.now !== b[i].input.now || a[i].input.op !== b[i].input.op) mismatches.push({ order: i, field: 'transaction' });
    for (const field of fields) if (!isDeepStrictEqual(a[i].output[field], b[i].output[field])) mismatches.push({ order: i, field, captured: a[i].output[field], replayed: b[i].output[field] });
  }
  return { reproduced: mismatches.length === 0, transactions: a.length, mismatches };
}
