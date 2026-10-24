#!/usr/bin/env node
// Scores the native claim from bench/results/*.json with the exclusions written in bench/claim-exclusions.json, so anyone can
// rerun the table. Per arm and task: runs, passes, median seconds of passing runs, mean seconds per attempt, and expected seconds
// to a correct result (mean per attempt divided by pass rate). A task an arm never passed has no expected time.
// A second section applies the claim rules in docs/status/LAWS.md: which arm pairs are within 20% of sleight, whether those have
// 5 runs, median/range/p90 of passes, lowest-expected-time count, totals, and the wording the numbers allow.
// A third section is ROADMAP 4b: each sleight-in-Codex arm against Codex out of the box on the same model (SAME_MODEL), under the
// same claim rules with the hosted arm in sleight's place.
// claim-exclusions.json "regrades" entries ({ file, arm, task, run, reason, why }) replace the reason shown for one failed run whose
// recorded reason was mislabelled; they never change exclusion, pass or fail, and result files stay untouched.
//   node bench/claim-score.mjs [--since 2026-10-16T15-34] [--results <dir>] [--rules <exclusions.json>] [--json]
// --rules scores another task set with its own exclusions, such as the app claim's VS Code, Slack and Spotify tasks.
// Each arm's line names the ChatGPT engine versions its rows ran on with their UTC dates, read from the results or inferred from
// bench/engine-versions.json (bench/engine-version.mjs), and says when the arms that drive the engine ran on different versions.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparisonSeconds, timingSummary, hasAgentSeconds } from './agent-time.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const rules = JSON.parse(readFileSync(arg('--rules') ?? join(root, 'bench/claim-exclusions.json'), 'utf8'));
const ME = 'sleight';
// GPT with sleight as its plugin against GPT with Codex's own computer use (ROADMAP 4b): [hosted arm, baseline arm].
export const SAME_MODEL = [['codex-sleight', 'codex'], ['codex-sleight-sol', 'codex-sol']];
// |a-b|/max calls more pairs "within 20%" than |a-b|/min, so it demands more 5-run top-ups: the strict reading of the LAWS rule.
const STRICT = 'max';

export const HAND_ON = 'ghost hand on (SLEIGHT_BENCH_HAND=1, a cost-pass row)';
// raw: the row's results file. A row or pass with the ghost hand on (bench/hand/bench-hand.mjs) never reaches a claim table.
export function excluded(row, file, rules, raw) {
  if (!rules.tasks.includes(row.task)) return 'not a claim task';
  if (row.ghostHand === 'on' || raw?.ghostHand === 'on') return HAND_ON;
  if (row.skipped || row.seconds == null) return 'skipped';
  if (row.modelMismatch || row.effortMismatch) return 'Codex ran another model or effort than its arm names';
  for (const r of rules.reasons) if (new RegExp(r.match, 'i').test(row.reason ?? '')) return r.why;
  for (const f of rules.files) if ((f.names ? f.names.includes(file) : file.startsWith(f.prefix)) && (!f.arm || f.arm === row.arm)) return f.why;
  for (const r of rules.runs ?? []) if (r.file === file && r.arm === row.arm && r.task === row.task && r.run === row.run) return r.why;
  for (const w of rules.windows) if (w.tasks.includes(row.task) && (!w.arm || w.arm === row.arm) && file < w.before) return w.why;
  return undefined;
}

export const regradeFor = (row, file, rules) => (rules.regrades ?? []).find(g => g.file === file && g.arm === row.arm && g.task === row.task && g.run === row.run);

export function score(rows, options = {}) {
  const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const out = {};
  for (const row of rows) {
    const { arm, task, passed } = row, seconds = comparisonSeconds(row, options);
    (((out[arm] ??= {})[task] ??= { runs: [], passes: [] }).runs.push(seconds), passed && out[arm][task].passes.push(seconds));
  }
  for (const tasks of Object.values(out)) for (const t of Object.values(tasks)) {
    t.mean = t.runs.reduce((a, b) => a + b, 0) / t.runs.length;
    t.median = median(t.passes);
    t.expected = t.passes.length ? t.mean / (t.passes.length / t.runs.length) : null;
  }
  return out;
}

export function claim(table, rules, me = ME, arms = rules.arms) {
  const tasks = rules.tasks, others = arms.filter(a => a !== me && table[a]), stats = {}, totals = {}, pairs = [], reasons = [];
  const off = (a, b, d) => Math.abs(a - b) / Math[d](a, b);
  for (const arm of [me, ...others]) {
    for (const task of tasks) {
      const t = table[arm]?.[task]; if (!t) continue;
      const s = [...t.passes].sort((a, b) => a - b);
      (stats[arm] ??= {})[task] = { runs: t.runs.length, passes: s.length, median: t.median, range: s.length ? [s[0], s.at(-1)] : null,
        p90: t.runs.length >= 5 && s.length ? s[Math.ceil(0.9 * s.length) - 1] : null };
    }
    totals[arm] = tasks.every(t => table[arm]?.[t]?.expected != null) ? tasks.reduce((a, t) => a + table[arm][t].expected, 0) : null;
  }
  for (const task of tasks) for (const arm of others) {
    const a = table[me]?.[task], b = table[arm]?.[task], ea = a?.expected ?? null, eb = b?.expected ?? null, both = ea != null && eb != null;
    const p = { task, arm, sleight: ea, other: eb, offMin: both ? off(ea, eb, 'min') : null, offMax: both ? off(ea, eb, 'max') : null,
      runs: { [me]: a?.runs.length ?? 0, [arm]: b?.runs.length ?? 0 } };
    p.withinMin = both && p.offMin <= 0.2; p.withinMax = both && p.offMax <= 0.2;
    p.short = (STRICT === 'max' ? p.withinMax : p.withinMin) ? [me, arm].filter(n => p.runs[n] < 5).map(n => `${n} ${p.runs[n]}/5`) : null;
    pairs.push(p);
  }
  const lowest = tasks.filter(task => {
    const e = table[me]?.[task]?.expected;
    return e != null && others.every(arm => { const o = table[arm]?.[task]?.expected; return o == null || e < o; });
  });
  const majority = Math.floor(tasks.length / 2) + 1, completed = tasks.filter(t => table[me]?.[t]?.passes.length).length;
  if (lowest.length < majority) reasons.push(`${me} has the lowest expected time on ${lowest.length} of ${tasks.length}; "fastest" needs ${majority}`);
  if (totals[me] == null) reasons.push(`${me} has no total (a task with no pass or no runs)`);
  else {
    const beat = others.filter(a => totals[a] != null && totals[a] <= totals[me]);
    if (beat.length) reasons.push(`${me}'s total ${totals[me].toFixed(0)} s is not the lowest: ${beat.map(a => `${a} ${totals[a].toFixed(0)} s`).join(', ')}`);
  }
  const topUp = pairs.filter(p => p.short?.length);
  if (topUp.length) reasons.push(`5 runs missing on ${topUp.length} pair(s) within 20%: ${topUp.map(p => `${p.task}/${p.arm} (${p.short.join(', ')})`).join('; ')}`);
  const absent = pairs.filter(p => !p.runs[p.arm]);
  if (absent.length) reasons.push(`no runs to compare: ${absent.map(p => `${p.arm} on ${p.task}`).join(', ')}`);
  const wording = !reasons.length ? 'fastest' : completed === tasks.length ? `completed every task, fastest on ${lowest.length} of ${tasks.length}`
    : `completed ${completed} of ${tasks.length} tasks, fastest on ${lowest.length} of ${tasks.length} (LAWS has no wording for a missed task)`;
  return { strict: STRICT, stats, pairs, lowest, totals, wording, reasons };
}

// The same-model pairs that have rows, each scored by claim() with the hosted arm as "me" and the baseline as its one rival.
// A pair missing either arm has no comparison: claim() alone would call a lone arm fastest.
export const sameModel = (table, rules) => SAME_MODEL.filter(([hosted, base]) => table[hosted] || table[base]).map(([hosted, base]) => {
  const missing = [hosted, base].filter(arm => !table[arm]);
  return missing.length ? { hosted, base, pairs: [], lowest: [], totals: {}, wording: 'no comparison', reasons: [`no runs for ${missing.join(' and ')}`] }
    : { hosted, base, ...claim(table, rules, hosted, [hosted, base]) };
});

// A sleight exclusion by file prefix can also drop a later claim run in the same hour, and sleight's rows should be one pass.
export function warnings(rows, rules, since) {
  const out = [], mine = {};
  for (const arm of new Set(rows.map(r => r.arm))) if (rules.arms && !rules.arms.includes(arm)) out.push(`${arm} has rows but is not in the rules' arms, so it is not scored`);
  for (const f of rules.files) if (f.prefix && (!f.arm || f.arm === ME) && f.prefix >= since) out.push(`file prefix ${f.prefix} can catch a new ${ME} run; list exact names`);
  for (const r of rows) if (r.arm === ME) mine[r.file] = (mine[r.file] ?? 0) + 1;
  if (Object.keys(mine).length > 1) out.push(`${ME}'s included rows come from ${Object.keys(mine).length} passes: ${Object.entries(mine).map(([f, n]) => `${f} (${n})`).join(', ')}`);
  for (const g of rules.regrades ?? []) if (!rows.some(r => r.file === g.file && r.arm === g.arm && r.task === g.task && r.run === g.run && !r.passed))
    out.push(`regrade ${g.file} ${g.arm} ${g.task} #${g.run} matches no included failed run`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const since = arg('--since') ?? rules.since, dir = arg('--results') ?? join(root, 'bench/results'), rows = [], dropped = {};
  const { currentTimeline, passRowEngine } = await import('./engine-version.mjs'), timeline = currentTimeline();
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json') && f >= since).sort()) {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')), mtimeMs = statSync(join(dir, file)).mtimeMs;
    for (const row of raw.results ?? []) {
      const why = excluded(row, file, rules, raw);
      if (why) { if (why !== 'not a claim task') dropped[why] = (dropped[why] ?? 0) + 1; continue; }
      const passed = !!(row.passed || (row.cleanupContained && row.taskPassed)), g = !passed && regradeFor(row, file, rules);
      rows.push({ arm: row.arm, task: row.task, seconds: row.seconds, ...(row.agentSeconds !== undefined && { agentSeconds: row.agentSeconds }),
        ...(row.agentTiming && { agentTiming: row.agentTiming }), ...(row.secondsTiming && { secondsTiming: row.secondsTiming }),
        passed, file, run: row.run, engine: passRowEngine(raw, row, { file, mtimeMs, timeline }),
        ...(!passed && { reason: (g && g.reason) || (row.reason ?? 'no reason recorded'), ...(g && { recorded: row.reason, regraded: g.why }) }) });
    }
  }
  const { engineMix, engineNote, engineText, summarizeEngines } = await import('./engine-version.mjs');
  const engines = summarizeEngines(rows), mix = engineMix(engines);
  const agentSeconds = process.argv.includes('--agent-seconds');
  const table = score(rows, { agentSeconds }), verdict = claim(table, rules), gpt = sameModel(table, rules), warned = warnings(rows, rules, since), failures = rows.filter(r => !r.passed);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ since, dropped, table, claim: verdict, sameModel: gpt, failures: failures.map(({ engine, ...f }) => f), warnings: warned, engines, engineMix: mix,
      ...(agentSeconds && { timing: 'agentSeconds where present; seconds otherwise; consult timingByArm for boundaries',
        timingByArm: timingSummary(rows), legacyTimingRows: rows.filter(r => !hasAgentSeconds(r)).length }) }, null, 1));
    process.exit(0);
  }
  const arms = rules.arms.filter(a => table[a]), n = x => x == null ? '-' : x.toFixed(0), pct = x => x == null ? '-' : `${(x * 100).toFixed(1)}%`;
  if (agentSeconds) console.log('Timing: agentSeconds where present; seconds otherwise. Per arm: ' + JSON.stringify(timingSummary(rows)));
  console.log(`Claim score since ${since}. Cell: expected s to a correct result (passes/runs), median of passes in brackets.`);
  console.log('task'.padEnd(20) + arms.map(a => a.padStart(22)).join(''));
  for (const task of rules.tasks) console.log(task.padEnd(20) + arms.map(a => {
    const t = table[a]?.[task];
    return (!t ? 'no runs' : !t.passes.length ? `never (0/${t.runs.length})` : `${t.expected.toFixed(0)} (${t.passes.length}/${t.runs.length}) [${t.median}]`).padStart(22);
  }).join(''));
  console.log('completed'.padEnd(20) + arms.map(a => `${rules.tasks.filter(t => table[a]?.[t]?.passes.length).length}/${rules.tasks.length}`.padStart(22)).join(''));
  console.log('Excluded rows:', JSON.stringify(dropped));
  for (const a of arms) console.log(`${a.padEnd(20)}${engineText(engines[a], a)}`);
  console.log(engineNote(engines, mix));

  console.log(`\nClaim rules (docs/status/LAWS.md). Expected time = mean seconds per attempt / pass rate; none without a pass.`);
  console.log(`Within 20% of ${ME}'s expected time, by |a-b|/min and |a-b|/max. The 5-run rule uses /${STRICT}, the denominator that marks more pairs within 20%.`);
  console.log('task'.padEnd(20) + 'arm'.padEnd(11) + `${ME}`.padStart(8) + 'arm'.padStart(8) + '/min'.padStart(13) + '/max'.padStart(13) + '  5 runs');
  for (const p of verdict.pairs) console.log(p.task.padEnd(20) + p.arm.padEnd(11) + n(p.sleight).padStart(8) + (p.runs[p.arm] ? n(p.other) : 'no runs').padStart(8)
    + `${pct(p.offMin)} ${p.withinMin ? 'yes' : 'no'}`.padStart(13) + `${pct(p.offMax)} ${p.withinMax ? 'yes' : 'no'}`.padStart(13)
    + `  ${!p.short ? 'not required' : p.short.length ? `missing: ${p.short.join(', ')}` : 'met'}`);
  console.log('\nPasses per arm: median [min-max], p90 (nearest rank) only at 5+ runs.');
  console.log('task'.padEnd(20) + arms.map(a => a.padStart(30)).join(''));
  for (const task of rules.tasks) console.log(task.padEnd(20) + arms.map(a => {
    const s = verdict.stats[a]?.[task];
    return (!s ? 'no runs' : !s.passes ? 'no passes' : `${s.median} [${s.range[0]}-${s.range[1]}]${s.p90 != null ? ` p90 ${s.p90}` : ''}`).padStart(30);
  }).join(''));
  console.log('total expected s'.padEnd(20) + arms.map(a => (verdict.totals[a] == null ? 'none' : n(verdict.totals[a])).padStart(30)).join(''));
  console.log(`\n${ME} has the lowest expected time on ${verdict.lowest.length} of ${rules.tasks.length}: ${verdict.lowest.join(', ') || 'none'}`);
  console.log(`Wording: ${verdict.wording}`);
  for (const r of verdict.reasons) console.log(`  not "fastest": ${r}`);
  for (const p of gpt) {
    console.log(`\nSame model: ${p.hosted} (sleight inside Codex) against ${p.base} (Codex's own computer use), same rules.`);
    for (const task of rules.tasks) {
      const pair = p.pairs.find(x => x.task === task), runs = pair?.runs ?? {};
      console.log(task.padEnd(20) + `${p.hosted} ${n(pair?.sleight)} (${runs[p.hosted] ?? 0} runs)`.padStart(34) + `${p.base} ${n(pair?.other)} (${runs[p.base] ?? 0} runs)`.padStart(30));
    }
    console.log(`totals: ${p.hosted} ${n(p.totals[p.hosted])} s, ${p.base} ${n(p.totals[p.base])} s. ${p.hosted} lower on ${p.lowest.length} of ${rules.tasks.length}. Claim wording for ${p.hosted}: ${p.wording}`);
    for (const r of p.reasons) console.log(`  not "fastest": ${r}`);
  }
  console.log(`\nFailed runs counted (${failures.length}):`);
  for (const f of failures) console.log(`  ${f.arm} ${f.task} #${f.run} ${f.file}: ${f.reason}${f.regraded ? ` (regraded from "${f.recorded}": ${f.regraded})` : ''}`);
  for (const w of warned) console.log(`Warning: ${w}`);
}
