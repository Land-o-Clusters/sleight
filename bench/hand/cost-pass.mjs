#!/usr/bin/env node
// H6, the ghost hand cost pass (fable-1018-ghost-hand.md section 2 and section 5 item 6, live-runbook-1019.md step 3b).
// Each claim task runs once per side per round through bench/run.mjs, the hand on (SLEIGHT_BENCH_HAND=1) against off,
// with the side order alternating by round and task. bench/hand/cost-sampler.mjs samples the pass's hand hosts and
// WindowServer once a second, and the run's own trace gives tool times and the hand's events.
//
//   node bench/hand/cost-pass.mjs --owner-away [--tasks calculator-click,textedit-save,textedit-drag] [--rounds 3]
//        [--model claude-haiku-5-5] [--effort high] [--out DIR]
//   node bench/hand/cost-pass.mjs --report DIR      the comparison again from DIR/cost-pass.json
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
export function compareSides(entries, budget = BUDGET) {
  const side = name => {
    const runs = entries.filter(e => e.side === name && !e.error);
    const hostPct = runs.map(e => e.window?.hand && e.elapsedS > 0 ? e.window.hand.cpuS / e.elapsedS * 100 : null).filter(Number.isFinite);
    return {
      runs: runs.length, failed: entries.filter(e => e.side === name && e.error).length, passed: runs.filter(e => e.passed).length,
      hostsSeen: runs.map(e => e.whole?.hand?.hosts ?? 0),
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
export async function runSide(deps, { round, task, side, model, effort }) {
  const env = { ...deps.env, SLEIGHT_BENCH_HAND: side === 'on' ? '1' : '0' };
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
  const elapsedMs = row.timing?.elapsedMs ?? (Number.isFinite(row.seconds) ? row.seconds * 1000 : undefined);
  const end = Date.parse(row.finishedAt);
  entry.passed = row.passed === true;
  entry.elapsedS = Number.isFinite(elapsedMs) ? elapsedMs / 1000 : entry.whole.wallS;
  entry.window = Number.isFinite(end) && Number.isFinite(elapsedMs) ? summarize(samples, { from: end - elapsedMs - 1000, to: end + 1000 }) : entry.whole;
  entry.trace = traceStats(deps.traceLines(traceDirs(results.stamp, task)));
  return entry;
}

export async function runCostPass(deps, { tasks = CLAIM_TASKS, rounds = 3, model = 'claude-haiku-5-5', effort = 'high', save = () => {}, log = () => {} } = {}) {
  const entries = [];
  for (const step of schedule(tasks, rounds)) {
    await deps.waitForHold?.();
    log(`round ${step.round} ${step.task} hand ${step.side}`);
    entries.push(await runSide(deps, { ...step, model, effort }));
    save(entries);
  }
  return entries;
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
  return { tasks, rounds, model: value('--model') ?? 'claude-haiku-5-5', effort: value('--effort') ?? 'high', out: value('--out'),
    report: value('--report'), ownerAway: argv.includes('--owner-away') };
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  if (opts.report) {
    const saved = JSON.parse(readFileSync(join(opts.report, 'cost-pass.json'), 'utf8'));
    const cmp = compareSides(saved.entries);
    console.log(reportMarkdown(cmp, saved.meta));
    return cmp.verdict === 'within' ? 0 : 1;
  }
  if (!opts.ownerAway) { console.error('The cost pass runs live claim tasks: pass --owner-away'); return 2; }
  const { handSetting } = await import('../../plugins/sleight/lib/hand/settings.mjs');
  const setting = handSetting({ env: {} });
  if (!setting.enabled) { console.error(`The ghost hand is ${setting.reason === 'user' ? 'off in hand.json' : `off (${setting.reason})`}: the on side would measure nothing. Run plugins/sleight/bin/sleight-mcp hand on first.`); return 2; }
  const { handHostBuilt, prepareHandHost } = await import('../../plugins/sleight/lib/direct-browser/host.mjs');
  if (!handHostBuilt()) {
    console.log('Building the hand host first, so no on-side session starts without its hand');
    const built = await prepareHandHost();
    if (built.status !== 'ready') { console.error(`Hand host build: ${built.code ?? built.status}`); return 2; }
  }
  const out = resolve(opts.out ?? join(homedir(), 'Library/Logs/sleight', `h6-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  mkdirSync(out, { recursive: true });
  const meta = { tasks: opts.tasks, rounds: opts.rounds, model: opts.model, effort: opts.effort, started: new Date().toISOString(), finished: null };
  const save = entries => writeFileSync(join(out, 'cost-pass.json'), JSON.stringify({ meta, entries }, null, 2) + '\n');
  let n = 0;
  const entries = await runCostPass({
    env: process.env,
    waitForHold: async () => { while (existsSync('/tmp/sleight-hold')) await new Promise(r => setTimeout(r, 30000)); },
    run: async (args, env) => {
      const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const log = join(out, `run-${String(++n).padStart(2, '0')}.log`);
      let stdout = '', all = '';
      child.stdout.on('data', c => { stdout += c; all += c; });
      child.stderr.on('data', c => { all += c; });
      return { pid: child.pid, done: new Promise(r => child.once('close', code => { writeFileSync(log, all); r({ code, stdout }); })) };
    },
    sampler: rootPid => createCostSampler({ rootPid }),
    readJson: path => JSON.parse(readFileSync(path, 'utf8')),
    traceLines: readTraceLines,
  }, { ...opts, save, log: line => console.log(line) });
  meta.finished = new Date().toISOString();
  save(entries);
  const cmp = compareSides(entries);
  const md = reportMarkdown(cmp, meta);
  writeFileSync(join(out, 'cost-pass.md'), md);
  console.log(md);
  console.log(`Saved: ${join(out, 'cost-pass.json').split(homedir()).join('~')}`);
  return cmp.verdict === 'within' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
