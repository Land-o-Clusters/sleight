#!/usr/bin/env node
// H6, the ghost hand cost pass (fable-1018-ghost-hand.md section 2 and section 5 item 6, live-runbook-1019.md step 3b).
// Each claim task runs once per side per round through bench/run.mjs, the hand on (SLEIGHT_BENCH_HAND=1) against off,
// with the side order alternating by round and task. bench/hand/cost-sampler.mjs samples the pass's hand hosts and
// WindowServer once a second, and the run's own trace gives tool times and the hand's events.
//
//   node bench/hand/cost-pass.mjs --owner-away [--tasks calculator-click,textedit-save,textedit-drag] [--rounds 3]
//        [--model claude-haiku-5-5] [--effort high] [--out DIR]
//   node bench/hand/cost-pass.mjs --report DIR      the comparison again from DIR/cost-pass.json
//   node bench/hand/cost-pass.mjs --cursor-style ring --rounds 5 --stop-on-owner --owner-away --out DIR   (VC7 check 4)
//   node bench/hand/cost-pass.mjs ... --dry-run      the schedule and every run's exact command; runs nothing
//
// VC7 (the agent cursor): --cursor-style ring|seam|sprite runs the on side with SLEIGHT_CURSOR_STYLE set, and the sampler
// checks every on-side host was started with that style. The report adds per-task figures: per-call tool-time medians and
// wall time per task (mean and standard error), and a speed verdict that says "no slowdown" only when every task's on minus
// off difference, for both figures, is within the pass's own noise rule below (10% of the off side or 20 ms, whichever is
// more). --out DIR with a saved cost-pass.json of the same settings resumes: finished steps are kept, the rest run.
// --stop-on-owner stops before the next run when someone used the keyboard or pointer after the last run ended
// (owner-watch.mjs), and exits 4.
//
// Budget (section 2): hand host under 1% CPU averaged over each task; WindowServer under 2% added on average and under 10%
// added at its busiest second; host RSS under 50 MB; tool-time medians unchanged, which this pass reads as the per-call
// median within 10% or 20 ms of the off side (a threshold proposed here, not an owner ruling). Beat drift is reported.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCostSampler, summarize } from './cost-sampler.mjs';
import { evidenceRoots, tempRoots } from '../evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CLAIM_TASKS = ['calculator-click', 'textedit-save', 'textedit-drag'];
export const BUDGET = Object.freeze({ hostAvgPct: 1, wsAddedPct: 2, wsAddedPeakPct: 10, rssMB: 50, spriteRssMB: 64, toolMedianPct: 10, toolMedianMs: 20 });
// Peak RSS is in MiB. The sprite style keeps each decoded sheet resident (13.4 MiB at full size), so its host gets 64 MiB;
// the ring and the glove keep 50.
export const budgetFor = cursorStyle => cursorStyle === 'sprite' ? Object.freeze({ ...BUDGET, rssMB: BUDGET.spriteRssMB }) : BUDGET;
// VC4's --cursor-style named the on side's style for its RSS budget; VC7's also sets it (SLEIGHT_CURSOR_STYLE), glove included.
export const CURSOR_STYLES = Object.freeze(['glove', 'ring', 'seam', 'sprite']);

/** The pass's order: per round and task, which side runs first. Every task gets each side once per round. */
export function schedule(tasks, rounds) {
  const steps = [];
  for (let round = 1; round <= rounds; round++) {
    tasks.forEach((task, j) => {
      const sides = (round + j) % 2 === 1 ? ['off', 'on'] : ['on', 'off'];
      for (const side of sides) steps.push({ round, task, side });
    });
  }
  return steps;
}

export const runArgs = ({ task, model, effort }) => ['bench/run.mjs', '--suite', 'world', '--arm', 'sleight', '--tasks', task, '--runs', '1',
  '--model', model, '--effort', effort, '--owner-away'];
export const resultsPath = stdout => /^results: (.+\.json)\s*$/m.exec(String(stdout))?.[1];

/** One run's trace, every trace-*.jsonl line of it: per-call tool times and the hand's own events. */
export function traceStats(lines) {
  const calls = new Map(), hand = { started: 0, off: {}, skipped: {}, dropped: 0, restarts: 0, beats: 0, drift: [] };
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.t), msg = e.msg ?? {};
    if (e.direction === 'call-received' && msg.id !== undefined && typeof msg.params?.name === 'string' && !calls.has(msg.id)) calls.set(msg.id, { tool: msg.params.name, received: t });
    else if (e.direction === 'to-client' && msg.method === undefined && calls.has(msg.id) && calls.get(msg.id).answered === undefined) calls.get(msg.id).answered = t;
    else if (e.direction === 'hand-started') hand.started++;
    else if (e.direction === 'hand-off') hand.off[msg.reason ?? 'unknown'] = (hand.off[msg.reason ?? 'unknown'] ?? 0) + 1;
    else if (e.direction === 'hand-skipped') hand.skipped[msg.reason ?? 'unknown'] = (hand.skipped[msg.reason ?? 'unknown'] ?? 0) + 1;
    else if (e.direction === 'hand-dropped') hand.dropped++;
    else if (e.direction === 'hand-restart') hand.restarts++;
    else if (e.direction === 'hand-beat') { hand.beats++; if (Number.isFinite(msg.driftMs)) hand.drift.push(msg.driftMs); }
  }
  const toolMs = [...calls.values()].filter(c => Number.isFinite(c.answered) && Number.isFinite(c.received)).map(c => c.answered - c.received);
  return { calls: toolMs.length, toolMs, hand };
}

/** Durable evidence first, then legacy evidence and run folders under both temp spellings. */
export function traceDirs(stamp, task, run = 1, temps = tempRoots(), armHome) {
  return [...evidenceRoots({ armHome, temps }), ...temps.map(base => join(base, 'sleight-bench'))]
    .map(base => join(base, stamp, `sleight-${task}-${run}`));
}

const median = values => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p90 = values => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(0.9 * values.length) - 1)] : null;
const round = (n, d = 2) => n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d;

/** Each side's figures, the budget checks, and within, over or invalid. entries: what runSide returns. */
export function compareSides(entries, budget = BUDGET, { cursorStyle } = {}) {
  const side = name => {
    const runs = entries.filter(e => e.side === name && !e.error);
    const hostPct = runs.map(e => e.window?.hand && e.elapsedS > 0 ? e.window.hand.cpuS / e.elapsedS * 100 : null).filter(Number.isFinite);
    return {
      runs: runs.length, failed: entries.filter(e => e.side === name && e.error).length, passed: runs.filter(e => e.passed).length,
      hostsSeen: runs.map(e => e.whole?.hand?.hosts ?? 0),
      styles: [...new Set(runs.flatMap(e => e.whole?.hand?.styles ?? []))].sort(),
      hostAvgPct: hostPct.map(n => round(n, 3)),
      wsAvgPct: runs.map(e => e.window?.windowServer?.avgPct).filter(Number.isFinite),
      wsPeakPct: runs.map(e => e.window?.windowServer?.peakPct).filter(Number.isFinite),
      peakRssMB: runs.some(e => Number.isFinite(e.whole?.hand?.peakRssMB)) ? Math.max(...runs.map(e => e.whole?.hand?.peakRssMB ?? 0)) : null,
      idle: runs.reduce((n, e) => n + (e.window?.hand?.idleIntervals ?? 0), 0), live: runs.reduce((n, e) => n + (e.window?.hand?.liveIntervals ?? 0), 0),
      toolMs: runs.flatMap(e => e.trace?.toolMs ?? []),
      drift: runs.flatMap(e => e.trace?.hand?.drift ?? []),
      skipped: runs.reduce((all, e) => { for (const [k, v] of Object.entries(e.trace?.hand?.skipped ?? {})) all[k] = (all[k] ?? 0) + v; return all; }, {}),
    };
  };
  const on = side('on'), off = side('off');
  const invalid = [];
  if (!on.runs || !off.runs) invalid.push('a side has no finished runs');
  if (off.hostsSeen.some(n => n > 0)) invalid.push('a hand host ran on the off side: SLEIGHT_HAND=0 did not reach the arm');
  if (on.hostsSeen.some(n => n === 0)) invalid.push(`no hand host ran in ${on.hostsSeen.filter(n => n === 0).length} on-side run(s): check sleight-mcp hand status and the host build`);
  // A sprite setting draws as the ring on a build without the sprite renderer (lib/hand/client.mjs hostCursorStyle).
  if (cursorStyle && on.styles.some(style => style !== cursorStyle)) invalid.push(`on-side hosts ran as ${on.styles.join(', ')}, not ${cursorStyle}: SLEIGHT_CURSOR_STYLE did not reach the arm or the host can't draw it`);
  const toolOn = median(on.toolMs), toolOff = median(off.toolMs);
  // A difference with a missing side is no figure, never 0 (null - null is 0 in JavaScript), and the pass can't be scored.
  const minus = (a, b) => a === null || b === null ? null : a - b;
  const wsAvg = [median(on.wsAvgPct), median(off.wsAvgPct)], wsPeak = [median(on.wsPeakPct), median(off.wsPeakPct)];
  for (const [label, pair] of [['WindowServer average', wsAvg], ['WindowServer busiest second', wsPeak], ['tool time', [toolOn, toolOff]]]) {
    pair.forEach((value, i) => { if (value === null) invalid.push(`no ${label} figure on the ${i ? 'off' : 'on'} side`); });
  }
  const toolDelta = minus(toolOn, toolOff);
  const checks = [
    { name: 'hand host CPU, highest task average', value: on.hostAvgPct.length ? Math.max(...on.hostAvgPct) : null, unit: '%', limit: budget.hostAvgPct },
    { name: 'WindowServer added, median task average', value: round(minus(...wsAvg)), unit: '%', limit: budget.wsAddedPct },
    { name: 'WindowServer added, median busiest second', value: round(minus(...wsPeak)), unit: '%', limit: budget.wsAddedPeakPct },
    { name: 'hand host RSS, peak', value: on.peakRssMB, unit: 'MB', limit: budget.rssMB },
    { name: 'tool time per call, median on minus off', value: round(toolDelta, 0), unit: 'ms',
      limit: toolOff === null ? null : round(Math.max(budget.toolMedianMs, toolOff * budget.toolMedianPct / 100), 0) },
  ].map(c => ({ ...c, ok: c.value !== null && !Number.isNaN(c.value) && c.limit !== null && c.value < c.limit }));
  const verdict = invalid.length ? 'invalid' : checks.every(c => c.ok) ? 'within' : 'over';
  const absDrift = on.drift.map(Math.abs);
  return { verdict, invalid, checks, on: { ...on, toolMs: undefined, drift: undefined, medianToolMs: toolOn, calls: on.toolMs.length },
    off: { ...off, toolMs: undefined, drift: undefined, medianToolMs: toolOff, calls: off.toolMs.length },
    drift: { beats: on.drift.length, medianAbsMs: median(absDrift), p90AbsMs: p90(absDrift) },
    passes: { on: `${on.passed}/${on.runs}`, off: `${off.passed}/${off.runs}` } };
}

export function reportMarkdown(cmp, { tasks, rounds, model, effort, started, finished }) {
  const row = (label, f) => `| ${label} | ${f(cmp.on)} | ${f(cmp.off)} |`;
  const list = v => v.length ? v.join(', ') : 'none';
  return [
    `# Ghost hand cost pass (H6)`, '',
    `${tasks.join(', ')}, ${rounds} round(s) per side, ${model} at ${effort} effort, ${started} to ${finished} (UTC). Verdict: **${cmp.verdict}**.`, '',
    ...cmp.invalid.map(r => `- Invalid: ${r}`), ...(cmp.invalid.length ? [''] : []),
    '| Figure | Hand on | Hand off |', '|---|---|---|',
    row('Runs (passed)', s => `${s.runs} (${s.passed})`),
    row('Hand hosts per run', s => list(s.hostsSeen)),
    row('Hand host CPU per task, %', s => list(s.hostAvgPct)),
    row('Host intervals idle of live', s => `${s.idle} of ${s.live}`),
    row('WindowServer CPU per task, %', s => list(s.wsAvgPct)),
    row('WindowServer busiest second, %', s => list(s.wsPeakPct)),
    row('Hand host RSS peak, MB', s => s.peakRssMB ?? 'none'),
    row('Tool time per call, median ms', s => `${s.medianToolMs ?? 'none'} (${s.calls} calls)`), '',
    '| Budget check | Value | Limit | Within |', '|---|---|---|---|',
    ...cmp.checks.map(c => `| ${c.name} | ${c.value ?? 'none'} ${c.unit} | ${c.limit ?? 'none'} ${c.unit} | ${c.ok ? 'yes' : 'no'} |`), '',
    `Beat drift (hand-beat traces, on side): ${cmp.drift.beats} beats, median |drift| ${cmp.drift.medianAbsMs ?? 'none'} ms, p90 ${cmp.drift.p90AbsMs ?? 'none'} ms.`,
    `Hand skips (on side): ${Object.entries(cmp.on.skipped).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`, '',
  ].join('\n');
}

/** One side of one task. deps: run(args, env) → { pid, done: Promise<{ code, stdout }> }, sampler(rootPid) → sampler,
 *  readJson(path), traceLines(dirs) → lines. */
export async function runSide(deps, { round, task, side, model, effort, cursorStyle }) {
  const env = { ...deps.env, SLEIGHT_BENCH_HAND: side === 'on' ? '1' : '0' };
  delete env.SLEIGHT_CURSOR_STYLE;
  if (cursorStyle && side === 'on') env.SLEIGHT_CURSOR_STYLE = cursorStyle;
  const child = await deps.run(runArgs({ task, model, effort }), env);
  const sampler = deps.sampler(child.pid);
  await sampler.start();
  const { code, stdout } = await child.done;
  const samples = await sampler.stop();
  const entry = { round, task, side, code, whole: summarize(samples) };
  const file = resultsPath(stdout);
  if (!file) return { ...entry, error: `run.mjs exited ${code} without a results file` };
  entry.results = file;
  let results;
  try { results = deps.readJson(file); } catch (error) { return { ...entry, error: `results unreadable: ${error.message}` }; }
  if ((results.ghostHand ?? 'off') !== side) return { ...entry, error: `results say the hand was ${results.ghostHand}, not ${side}` };
  const row = results.results?.find(r => r.arm === 'sleight' && r.task === task);
  if (!row) return { ...entry, error: 'no sleight row for the task' };
  // An interrupted or skipped run is not a measurement, so a resumed pass runs it again.
  if (row.cancelled || row.skipped) return { ...entry, error: `the run was ${row.cancelled ? 'cancelled' : 'skipped'}` };
  const elapsedMs = row.timing?.elapsedMs ?? (Number.isFinite(row.seconds) ? row.seconds * 1000 : undefined);
  const end = Date.parse(row.finishedAt);
  entry.passed = row.passed === true;
  entry.elapsedS = Number.isFinite(elapsedMs) ? elapsedMs / 1000 : entry.whole.wallS;
  entry.window = Number.isFinite(end) && Number.isFinite(elapsedMs) ? summarize(samples, { from: end - elapsedMs - 1000, to: end + 1000 }) : entry.whole;
  entry.trace = traceStats(deps.traceLines(traceDirs(results.stamp, task)));
  return entry;
}

/** Runs the schedule. done: entries kept from a resumed pass (finished steps are skipped). deps.ownerBack(), when given, is
 *  asked before each run; a reason stops the pass with entries.stopped set to it. */
export async function runCostPass(deps, { tasks = CLAIM_TASKS, rounds = 3, model = 'claude-haiku-5-5', effort = 'high', cursorStyle, done = [], save = () => {}, log = () => {} } = {}) {
  const entries = [...done];
  const finished = new Set(done.filter(e => !e.error).map(e => `${e.round}/${e.task}/${e.side}`));
  for (const step of schedule(tasks, rounds)) {
    if (finished.has(`${step.round}/${step.task}/${step.side}`)) continue;
    await deps.waitForHold?.();
    const back = await deps.ownerBack?.();
    if (back) { log(`stopped: ${back}`); entries.stopped = back; return entries; }
    log(`round ${step.round} ${step.task} hand ${step.side}${cursorStyle && step.side === 'on' ? ` (${cursorStyle})` : ''}`);
    // A retried step replaces its failed entry.
    const at = entries.findIndex(e => e.round === step.round && e.task === step.task && e.side === step.side);
    if (at >= 0) entries.splice(at, 1);
    entries.push(await runSide(deps, { ...step, model, effort, cursorStyle }));
    save(entries);
  }
  return entries;
}

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const standardError = values => {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1) / values.length);
};
/** The pass's noise rule: a difference is noise when it is under 10% of the off side or 20 ms, whichever is more. */
export const noiseLimitMs = (offMs, budget = BUDGET) => offMs === null ? null : Math.max(budget.toolMedianMs, offMs * budget.toolMedianPct / 100);

/** Per task and side: per-call tool-time median, wall time per task (mean and standard error, seconds), and whether each
 *  on minus off difference is within the noise rule. */
export function perTask(entries, budget = BUDGET) {
  const tasks = [...new Set(entries.map(e => e.task))];
  return tasks.map(task => {
    const side = name => {
      const runs = entries.filter(e => e.task === task && e.side === name && !e.error);
      const walls = runs.map(e => e.elapsedS).filter(Number.isFinite);
      return { runs: runs.length, passed: runs.filter(e => e.passed).length, medianToolMs: median(runs.flatMap(e => e.trace?.toolMs ?? [])),
        calls: runs.reduce((n, e) => n + (e.trace?.toolMs?.length ?? 0), 0), wallMeanS: round(mean(walls)), wallSeS: round(standardError(walls)) };
    };
    const on = side('on'), off = side('off');
    const toolDelta = on.medianToolMs === null || off.medianToolMs === null ? null : on.medianToolMs - off.medianToolMs;
    const wallDeltaMs = on.wallMeanS === null || off.wallMeanS === null ? null : (on.wallMeanS - off.wallMeanS) * 1000;
    const toolLimit = noiseLimitMs(off.medianToolMs, budget), wallLimit = noiseLimitMs(off.wallMeanS === null ? null : off.wallMeanS * 1000, budget);
    return { task, on, off, toolDeltaMs: round(toolDelta, 0), toolLimitMs: round(toolLimit, 0), toolWithin: toolDelta !== null && toolDelta < toolLimit,
      wallDeltaS: round(wallDeltaMs === null ? null : wallDeltaMs / 1000), wallLimitS: round(wallLimit === null ? null : wallLimit / 1000),
      wallWithin: wallDeltaMs !== null && wallDeltaMs < wallLimit };
  });
}

/** The speed verdict that decides the default: "no slowdown" only when every task's tool and wall differences are noise. */
export function speedVerdict(rows, { cursorStyle = 'the hand' } = {}) {
  if (!rows.length) return { slowdown: null, line: 'Speed verdict: no tasks measured' };
  const missing = rows.filter(r => r.toolDeltaMs === null || r.wallDeltaS === null);
  if (missing.length) return { slowdown: null, line: `Speed verdict: not measured for ${missing.map(r => r.task).join(', ')}` };
  const slow = rows.filter(r => !r.toolWithin || !r.wallWithin);
  if (!slow.length) return { slowdown: false, line: `Speed verdict: no slowdown with ${cursorStyle} on (${rows.length} tasks, every difference within 10% or 20 ms)` };
  const signed = n => `${n >= 0 ? '+' : ''}${n}`;
  return { slowdown: true, line: `Speed verdict: slower with ${cursorStyle} on in ${slow.map(r => `${r.task} (tool ${signed(r.toolDeltaMs)} ms per call, wall ${signed(r.wallDeltaS)} s)`).join(', ')}` };
}

export function perTaskMarkdown(rows, verdict) {
  const cell = (s, field) => s[field] ?? 'none';
  return ['| Task | Tool median on / off, ms | Limit | Within | Wall on / off, s (SE) | Limit | Within |', '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.task} | ${cell(r.on, 'medianToolMs')} / ${cell(r.off, 'medianToolMs')} | ${r.toolLimitMs ?? 'none'} | ${r.toolWithin ? 'yes' : 'no'} | ` +
      `${cell(r.on, 'wallMeanS')} (${cell(r.on, 'wallSeS')}) / ${cell(r.off, 'wallMeanS')} (${cell(r.off, 'wallSeS')}) | ${r.wallLimitS ?? 'none'} | ${r.wallWithin ? 'yes' : 'no'} |`),
    '', verdict.line, ''].join('\n');
}

export function readTraceLines(dirs) {
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter(f => /^trace-\d+\.jsonl$/.test(f)); } catch { continue; }
    const lines = [];
    for (const f of files) lines.push(...readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
    if (lines.length) return lines;
  }
  return [];
}

export function parseArgs(argv) {
  const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const tasks = (value('--tasks') ?? CLAIM_TASKS.join(',')).split(',').filter(Boolean);
  const rounds = Number(value('--rounds') ?? 3);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('--rounds must be a whole number from 1 to 10');
  if (!tasks.length || tasks.some(t => !/^[a-z0-9-]{1,60}$/.test(t))) throw new Error('--tasks must be task ids');
  const cursorStyle = value('--cursor-style');
  if (cursorStyle !== undefined && !CURSOR_STYLES.includes(cursorStyle)) throw new Error(`--cursor-style must be one of ${CURSOR_STYLES.join(', ')}`);
  return { tasks, rounds, model: value('--model') ?? 'claude-haiku-5-5', effort: value('--effort') ?? 'high', out: value('--out'),
    report: value('--report'), ownerAway: argv.includes('--owner-away'), cursorStyle, stopOnOwner: argv.includes('--stop-on-owner'),
    dryRun: argv.includes('--dry-run') };
}

/** The settings a saved pass must match to be resumed. */
export const resumeKey = meta => JSON.stringify([meta.tasks, meta.rounds, meta.model, meta.effort, meta.cursorStyle ?? null]);

export function dryRunPlan(opts, { out, root = ROOT, home = homedir() }) {
  const steps = schedule(opts.tasks, opts.rounds), short = path => path.split(home).join('~');
  return [
    `Ghost hand cost pass${opts.cursorStyle ? ` (VC7 speed A/B, cursor style ${opts.cursorStyle})` : ''}: ${steps.length} runs (dry run: nothing runs)`,
    `  out ${short(out)}; ${opts.stopOnOwner ? 'stops before a run when the owner is back (exit 4); ' : ''}waits while /tmp/sleight-hold exists`,
    ...steps.map((step, i) => `  ${String(i + 1).padStart(2)}. round ${step.round} ${step.task} ${step.side}: cd ${short(root)} && ` +
      `SLEIGHT_BENCH_HAND=${step.side === 'on' ? 1 : 0}${opts.cursorStyle && step.side === 'on' ? ` SLEIGHT_CURSOR_STYLE=${opts.cursorStyle}` : ''} node ${runArgs({ ...step, ...opts }).join(' ')}`),
  ];
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  if (opts.report) {
    const saved = JSON.parse(readFileSync(join(opts.report, 'cost-pass.json'), 'utf8'));
    const style = saved.meta.cursorStyle;
    const cmp = compareSides(saved.entries, budgetFor(style), { cursorStyle: style });
    const rows = perTask(saved.entries), speed = speedVerdict(rows, { cursorStyle: style });
    console.log(reportMarkdown(cmp, saved.meta) + '\n' + perTaskMarkdown(rows, speed));
    return cmp.verdict === 'within' && speed.slowdown === false ? 0 : 1;
  }
  const out = resolve(opts.out ?? join(homedir(), 'Library/Logs/sleight', `h6-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  if (opts.dryRun) { console.log(dryRunPlan(opts, { out }).join('\n')); return 0; }
  if (!opts.ownerAway) { console.error('The cost pass runs live claim tasks: pass --owner-away'); return 2; }
  const { handSetting } = await import('../../plugins/sleight/lib/hand/settings.mjs');
  // The on side forces the hand on (run.mjs passes SLEIGHT_HAND=1 from SLEIGHT_BENCH_HAND=1), so the saved file can't stop it.
  const setting = handSetting({ env: { SLEIGHT_HAND: '1', ...(opts.cursorStyle ? { SLEIGHT_CURSOR_STYLE: opts.cursorStyle } : {}) } });
  if (!setting.enabled) { console.error(`The ghost hand is off (${setting.reason}): the on side would measure nothing.`); return 2; }
  const { handHostBuilt, prepareHandHost } = await import('../../plugins/sleight/lib/direct-browser/host.mjs');
  if (!handHostBuilt()) {
    console.log('Building the hand host first, so no on-side session starts without its hand');
    const built = await prepareHandHost();
    if (built.status !== 'ready') { console.error(`Hand host build: ${built.code ?? built.status}`); return 2; }
  }
  mkdirSync(out, { recursive: true });
  const meta = { tasks: opts.tasks, rounds: opts.rounds, model: opts.model, effort: opts.effort, ...(opts.cursorStyle ? { cursorStyle: opts.cursorStyle } : {}),
    started: new Date().toISOString(), finished: null };
  let done = [];
  if (existsSync(join(out, 'cost-pass.json'))) {
    const saved = JSON.parse(readFileSync(join(out, 'cost-pass.json'), 'utf8'));
    if (resumeKey(saved.meta) !== resumeKey(meta)) { console.error(`${out} holds a pass with other settings: use a new --out`); return 2; }
    done = saved.entries; meta.started = saved.meta.started; meta.resumed = [...(saved.meta.resumed ?? []), new Date().toISOString()];
    console.log(`Resuming: ${done.filter(e => !e.error).length} finished runs kept`);
  }
  const save = entries => writeFileSync(join(out, 'cost-pass.json'), JSON.stringify({ meta, entries }, null, 2) + '\n');
  let n = readdirSync(out).filter(f => /^run-\d+\.log$/.test(f)).length;
  const { createOwnerWatch, ownerWords } = await import('./owner-watch.mjs');
  const watch = createOwnerWatch();
  // A signal stops the pass before its next run and reaches the current run.mjs, whose abort is idempotent.
  let current, interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; try { current?.kill('SIGINT'); } catch {} });
  const entries = await runCostPass({
    env: process.env,
    waitForHold: async () => {
      let held = false;
      while (existsSync('/tmp/sleight-hold')) { held = true; await new Promise(r => setTimeout(r, 30000)); }
      if (held) watch.quiet(); // another project's window may have made input of its own
    },
    ownerBack: async () => {
      if (interrupted) return 'interrupted by a signal';
      if (!opts.stopOnOwner) return undefined;
      const r = await watch.check();
      return r.back ? ownerWords(r) : undefined;
    },
    run: async (args, env) => {
      const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      current = child;
      const log = join(out, `run-${String(++n).padStart(2, '0')}.log`);
      let stdout = '', all = '';
      child.stdout.on('data', c => { stdout += c; all += c; });
      child.stderr.on('data', c => { all += c; });
      return { pid: child.pid, done: new Promise(r => child.once('close', code => { writeFileSync(log, all); watch.quiet(); r({ code, stdout }); })) };
    },
    sampler: rootPid => createCostSampler({ rootPid }),
    readJson: path => JSON.parse(readFileSync(path, 'utf8')),
    traceLines: readTraceLines,
  }, { ...opts, done, save, log: line => console.log(line) });
  if (entries.stopped) {
    meta.stopped = entries.stopped; save(entries);
    console.log(`VC7 RESULT: speed A/B stopped (${entries.stopped}); rerun the same command to resume`);
    return interrupted ? 130 : 4;
  }
  meta.finished = new Date().toISOString();
  save(entries);
  const cmp = compareSides(entries, budgetFor(opts.cursorStyle), { cursorStyle: opts.cursorStyle });
  const rows = perTask(entries), speed = speedVerdict(rows, { cursorStyle: opts.cursorStyle });
  const md = reportMarkdown(cmp, meta) + '\n' + perTaskMarkdown(rows, speed);
  writeFileSync(join(out, 'cost-pass.md'), md);
  console.log(md);
  console.log(`VC7 RESULT: ${speed.line}; budget ${cmp.verdict}`);
  console.log(`Saved: ${join(out, 'cost-pass.json').split(homedir()).join('~')}`);
  return cmp.verdict === 'within' && speed.slowdown !== true ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
