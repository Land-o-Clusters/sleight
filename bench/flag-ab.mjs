#!/usr/bin/env node
// Flag A/Bs (g3, 2026-10-19): each opt-in flag alone against the same build without it, on held-out native tasks that
// reach the flag's code. bench/flag-ab.command runs the plan and writes a manifest, and `score` reads it back.
//   node bench/flag-ab.mjs plan [--rounds 5] [--start 1] [--arms preview-read,office]
//   node bench/flag-ab.mjs score [--legacy] [--manifest ~/Projects/sleight-wt/race-1017/flags-manifest.tsv] [--min-runs 3] [--json]
// A plan line is one bench/run.mjs invocation: round, arm, side, runs, tasks, env (tab-separated, explicit zero for "off").
// Verdict, per flag over its tasks' summed expected time (mean seconds per attempt over the pass rate, as claim-score):
//   default on   faster than off by more than one standard error, no task with a lower pass rate, and no task more than
//                10% slower beyond that task's own standard error
//   stay opt-in  faster, but inside the noise, or with a lost pass or a slower task (rerun those)
//   remove       not faster at all
//   no verdict   a task short of --min-runs on a side, or rows from more than one commit or a dirty tree
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MODEL = 'claude-haiku-5-5';
export const WORSE = 0.1;

export const FLAGS = {
  'open-shot': 'SLEIGHT_OPEN_SHOT=1',
  'compact-toolbars': 'SLEIGHT_COMPACT_TOOLBARS=1',
  'skill-screenshot': 'SLEIGHT_SCREENSHOT_READS=1',
};

// Tasks in world-suite order (bench/run.mjs runs them in that order whatever --tasks says). Arms with the same task list
// share one "off" invocation per round (office). Office runs last: a stuck Word costs every later task.
export const ARMS = [
  // open_file in 25/25, 15/15 and 7/7 runs (2026-10-16 to 19). Word and Excel already get a screenshot (SLEIGHT_OPEN_AUTO_SHOT).
  { id: 'open-shot', block: 'native', tasks: ['textedit-edit', 'preview-pdf', 'textedit-replace-save'], runs: 1, flags: ['open-shot'] },
  // preview-read is a claim task, and sleight's only native loss (to Peekaboo), so LAWS allows it. PV4 asks for 10 runs.
  { id: 'preview-read', block: 'native', tasks: ['preview-read'], runs: 2, flags: ['open-shot'] },
  // No native window outside Office has a toolbar over 20 controls (TextEdit 15, Preview 13, Finder 11), so off Office
  // the flag only removes repeated trees: multi-read TextEdit tasks.
  { id: 'toolbars-text', block: 'native', tasks: ['textedit-replace-all', 'textedit-insert-line'], runs: 1, flags: ['compact-toolbars'] },
  // Word's ribbon (50 controls) is where the fold cost word-edit ~40% before FL1; Word's document area is the textless
  // window the screenshot guidance covers. No held-out Excel task exists, and excel-edit is a claim task sleight leads.
  { id: 'office', block: 'office', tasks: ['word-memo', 'word-brief'], runs: 1, flags: ['compact-toolbars', 'skill-screenshot'] },
];

// The 2026-10-19 manifest predates default-on screenshots and includes the removed confirmation arm.
// Keep its labels and task membership for score --legacy; new plans use only the active flags above.
export const LEGACY_FLAGS = {
  'open-shot': 'SLEIGHT_OPEN_SHOT=1',
  'compact-confirmations': 'SLEIGHT_COMPACT_CONFIRMATIONS=1',
  'compact-toolbars': 'SLEIGHT_COMPACT_TOOLBARS=1',
  'skill-screenshot': 'SLEIGHT_SKILL=screenshot',
};
export const LEGACY_ARMS = [...ARMS.slice(0, 2),
  { id: 'confirmations', block: 'native', tasks: ['textedit-edit', 'preview-pdf', 'finder-create-folder', 'textedit-insert-line'],
    runs: 1, flags: ['compact-confirmations'] }, ...ARMS.slice(2)];

export function plan({ rounds = 5, start = 1, arms = ARMS.map(arm => arm.id) } = {}) {
  const unknown = arms.filter(id => !ARMS.some(arm => arm.id === id));
  if (unknown.length) throw new Error(`unknown arm: ${unknown.join(', ')}`);
  const lines = [];
  for (const block of ['native', 'office']) for (let round = start; round < start + rounds; round++) {
    for (const arm of ARMS.filter(arm => arm.block === block && arms.includes(arm.id))) {
      const sides = ['off', ...arm.flags];
      // Odd rounds run "off" first, even rounds last, so neither side always runs first.
      for (const side of round % 2 ? sides : sides.toReversed()) {
        const env = arm.flags.map(flag => FLAGS[flag].replace(/=1$/, flag === side ? '=1' : '=0')).join(' ');
        lines.push({ round, arm: arm.id, side, runs: arm.runs, tasks: arm.tasks.join(','), env });
      }
    }
  }
  return lines;
}

// Manifest columns, written by bench/flag-ab.command: round arm side exit stops results log commit.
export function readManifest(text) {
  return text.split('\n').filter(line => line.trim() && !line.startsWith('round\t')).map(line => {
    const [round, arm, side, exit, stops, results, log, commit] = line.split('\t');
    return { round: Number(round), arm, side, exit: Number(exit), stops: Number(stops), results: results || undefined, log, commit };
  });
}

export function loadRows(entries, { read = path => JSON.parse(readFileSync(path, 'utf8')), reasons = [], model = MODEL, legacy = false } = {}) {
  const rows = [], dropped = {}, missing = [];
  const drop = why => { dropped[why] = (dropped[why] ?? 0) + 1; };
  for (const entry of entries) {
    const arm = (legacy ? LEGACY_ARMS : ARMS).find(arm => arm.id === entry.arm);
    if (!arm || !(entry.side === 'off' || arm.flags.includes(entry.side))) { missing.push({ ...entry, why: 'unknown arm or side' }); continue; }
    let results;
    try { results = entry.results && read(entry.results).results; } catch (error) { missing.push({ ...entry, why: error.message }); continue; }
    if (!results) { missing.push({ ...entry, why: 'no results file' }); continue; }
    for (const row of results) {
      if (row.arm !== 'sleight') continue;
      const why = !arm.tasks.includes(row.task) ? 'task not in the arm'
        : row.skipped || row.seconds == null ? 'skipped'
        : !(row.models ?? []).every(m => m === model) ? `model ${(row.models ?? []).join('+') || 'unknown'}`
        : reasons.find(r => new RegExp(r.match, 'i').test(row.reason ?? ''))?.why;
      if (why) { drop(why); continue; }
      rows.push({ arm: entry.arm, side: entry.side, round: entry.round, task: row.task, seconds: row.seconds,
        passed: !!(row.passed || (row.cleanupContained && row.taskPassed)), commit: row.sleightCommit, dirty: !!row.sleightDirty,
        engine: row.engineVersion });
    }
  }
  return { rows, dropped, missing };
}

function stats(list) {
  if (!list.length) return { runs: 0, passes: 0, mean: null, sd: 0, expected: null };
  const seconds = list.map(row => row.seconds), mean = seconds.reduce((a, b) => a + b, 0) / seconds.length;
  const sd = seconds.length > 1 ? Math.sqrt(seconds.reduce((a, s) => a + (s - mean) ** 2, 0) / (seconds.length - 1)) : 0;
  const passes = list.filter(row => row.passed).length;
  return { runs: list.length, passes, mean, sd, expected: passes ? mean / (passes / list.length) : null };
}

export function scoreFlag(flag, rows, { minRuns = 3, legacy = false } = {}) {
  const arms = (legacy ? LEGACY_ARMS : ARMS).filter(arm => arm.flags.includes(flag));
  const tasks = [...new Set(arms.flatMap(arm => arm.tasks))];
  const mine = rows.filter(row => arms.some(arm => arm.id === row.arm) && (row.side === 'off' || row.side === flag));
  const perTask = tasks.map(task => {
    const off = stats(mine.filter(row => row.task === task && row.side === 'off'));
    const on = stats(mine.filter(row => row.task === task && row.side === flag));
    const se = Math.sqrt((off.runs ? off.sd ** 2 / off.runs : 0) + (on.runs ? on.sd ** 2 / on.runs : 0));
    return { task, off, on, se, change: off.expected != null && on.expected != null ? on.expected / off.expected - 1 : null };
  });
  const sum = side => perTask.every(t => t[side].expected != null) ? perTask.reduce((a, t) => a + t[side].expected, 0) : null;
  const total = { off: sum('off'), on: sum('on'), se: Math.sqrt(perTask.reduce((a, t) => a + t.se ** 2, 0)) };
  total.diff = total.off != null && total.on != null ? total.on - total.off : null;
  const commits = [...new Set(mine.map(row => row.commit))], engines = [...new Set(mine.map(row => row.engine).filter(Boolean))];
  const result = { flag, env: (legacy ? LEGACY_FLAGS : FLAGS)[flag], tasks: perTask, total, commits, engines };

  const short = perTask.filter(t => t.off.runs < minRuns || t.on.runs < minRuns);
  const incomplete = short.length ? [`short of ${minRuns} runs a side: ${short.map(t => `${t.task} (off ${t.off.runs}, on ${t.on.runs})`).join(', ')}`] : [];
  if (commits.length > 1) incomplete.push(`rows from ${commits.length} commits: ${commits.join(', ')}`);
  if (mine.some(row => row.dirty)) incomplete.push('rows from a dirty tree');
  if (incomplete.length) return { ...result, verdict: 'no verdict', reasons: incomplete };

  const n = x => x.toFixed(1);
  const lost = perTask.filter(t => t.on.passes / t.on.runs < t.off.passes / t.off.runs)
    .map(t => `${t.task} passed ${t.on.passes}/${t.on.runs} with the flag against ${t.off.passes}/${t.off.runs}`);
  const slower = perTask.filter(t => t.on.expected != null && t.off.expected != null &&
    t.on.expected > t.off.expected * (1 + WORSE) && t.on.expected - t.off.expected > t.se)
    .map(t => `${t.task} ${n(t.on.expected)} s against ${n(t.off.expected)} s (+${(t.change * 100).toFixed(0)}%, ±${n(t.se)} s)`);
  // A side that never passed a task has no total: never passing with the flag is no win, never passing without it is one.
  const faster = total.diff != null ? total.diff < 0 : total.on != null;
  if (!faster) return { ...result, verdict: 'remove', reasons: [total.diff == null
    ? `never passed ${perTask.filter(t => t.on.expected == null).map(t => t.task).join(', ')} with the flag`
    : `no win: ${n(total.on)} s with the flag against ${n(total.off)} s without`, ...lost] };
  if (lost.length || slower.length) return { ...result, verdict: 'stay opt-in', reasons: [...lost, ...slower] };
  if (total.diff != null && -total.diff <= total.se) {
    return { ...result, verdict: 'stay opt-in', reasons: [`faster by ${n(-total.diff)} s, inside the noise (±${n(total.se)} s)`] };
  }
  return { ...result, verdict: 'default on', reasons: [total.diff == null ? 'passes a task the build never passed'
    : `faster by ${n(-total.diff)} s (${(total.diff / total.off * 100).toFixed(1)}%, ±${n(total.se)} s), no lost pass`] };
}

export function format(scores, { manifest, entries, dropped, missing }) {
  const n = x => x == null ? '-' : x.toFixed(1), out = [];
  out.push(`Flag A/B score from ${manifest}: ${entries} invocations.`);
  if (Object.keys(dropped).length) out.push(`Dropped rows: ${Object.entries(dropped).map(([why, count]) => `${why} (${count})`).join(', ')}.`);
  for (const m of missing) out.push(`No rows from ${m.arm} ${m.side} round ${m.round}: ${m.why}.`);
  out.push('Cell: expected s (passes/runs). Change is with the flag against without, ± one standard error.');
  for (const s of scores) {
    out.push('', `${s.flag} (${s.env}), commit ${s.commits.join(', ') || '-'}, engine ${s.engines.join(', ') || '-'}`);
    out.push(`${'task'.padEnd(24)}${'off'.padStart(16)}${'on'.padStart(16)}  change`);
    const cell = x => `${n(x.expected)} (${x.passes}/${x.runs})`.padStart(16);
    for (const t of s.tasks) out.push(`${t.task.padEnd(24)}${cell(t.off)}${cell(t.on)}  ${t.change == null ? '-' : `${(t.change * 100).toFixed(1)}% ±${n(t.se)} s`}`);
    out.push(`${'total'.padEnd(24)}${n(s.total.off).padStart(16)}${n(s.total.on).padStart(16)}  ${s.total.diff == null ? '-' : `${n(s.total.diff)} s ±${n(s.total.se)} s`}`);
    out.push(`verdict: ${s.verdict}. ${s.reasons.join('; ')}.`);
  }
  return out.join('\n');
}

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'plan') {
    const lines = plan({ rounds: Number(arg('--rounds') ?? 5), start: Number(arg('--start') ?? 1), arms: arg('--arms')?.split(',') });
    for (const l of lines) console.log([l.round, l.arm, l.side, l.runs, l.tasks, l.env].join('\t'));
  } else if (command === 'score') {
    const manifest = arg('--manifest') ?? join(homedir(), 'Projects/sleight-wt/race-1017/flags-manifest.tsv');
    const entries = readManifest(readFileSync(manifest, 'utf8'));
    const reasons = JSON.parse(readFileSync(join(root, 'bench/claim-exclusions.json'), 'utf8')).reasons;
    const legacy = process.argv.includes('--legacy') || entries.some(entry => entry.arm === 'confirmations');
    const { rows, dropped, missing } = loadRows(entries, { reasons, legacy });
    const scores = Object.keys(legacy ? LEGACY_FLAGS : FLAGS).map(flag => scoreFlag(flag, rows, { minRuns: Number(arg('--min-runs') ?? 3), legacy }));
    console.log(process.argv.includes('--json') ? JSON.stringify({ manifest, dropped, missing, scores }, null, 1)
      : format(scores, { manifest, entries: entries.length, dropped, missing }));
  } else {
    console.error('usage: flag-ab.mjs plan [--rounds N] [--start N] [--arms a,b] | score [--legacy] [--manifest file] [--min-runs N] [--json]');
    process.exit(2);
  }
}
