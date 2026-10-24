#!/usr/bin/env node
// Scores the browser race from real-gate round folders with bench/claim-score.mjs's rules: per browser, arm and task the
// passes/runs, expected seconds (mean attempt / pass rate), median and range of passes, p90 at 5 runs, the pairs within 20%
// of sleight that still need 5 runs, and per browser how many tasks each arm is fastest on and its total.
// Each saved row is graded again offline: a pass needs the recorded outcome ok, at least one successful browser call by
// that arm (counted again from events.jsonl where it was saved) and the race's positive site evidence (real-gate-grade.mjs
// RACE_EXPECT). A round with harness-failure.json, or one where 10 or more of 12 tasks failed with one error class, is
// excluded with its reason. --mark writes harness-failure.json into a newly detected round's folder.
// Cover: a row whose drag met another app's window over the browser's has cover evidence (real-gate-grade.mjs coverEvidence),
// listed with the app. Only --exclude-covered leaves rows out (coverExclusions), passes and failures alike; the output's first
// line says which. A cell under 3 runs is marked and can't be fastest on its task.
// Each task carries the ChatGPT engine version it ran on and its UTC dates: the round's engine.json when the gate recorded one,
// otherwise inferred from the task's recorded start and end against bench/engine-versions.json (bench/engine-version.mjs). A row
// without times takes the birth time of the round's commits.json, marked as an inferred date. Per browser, the output names each
// arm's versions with their dates and says when the arms that drive the engine ran on different versions.
// The sleight-in-Codex arms (claim-score.mjs SAME_MODEL, ROADMAP 4b) are sleight itself under GPT, so they never count against
// sleight: each is scored only against Codex's own computer use on the same model, by the same rules, in its own section.
// Answer patterns: by default each row is graded with the task it saved, so a score keeps the patterns it ran with. Opt-in
// --current-graders checks each saved answer against the current bench/world/tasks/fowlbrowser.json instead, in both directions,
// for rows whose saved patterns differ; the output says which patterns it used and lists every row that changed.
//   node bench/fowl/race-score.mjs [round folders or <dir>/<prefix>*] [--json] [--mark] [--exclude-covered] [--current-graders]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAME_MODEL, claim, sameModel, score } from '../claim-score.mjs';
import { timingSummary, hasAgentSeconds } from '../agent-time.mjs';
import { ANSWER_GRADER_FILE, answerProblems, browserEvidence, coverEvidence, coverExclusions, currentAnswerGraders, graderId, harnessFailure, isAnswerProblem,
  raceProblems, runErrorClass, runnerGradesAnswer } from './real-gate-grade.mjs';
import { currentTimeline, dayRange, engineForRun, engineMix, engineNote, engineText, loadTimeline, summarizeEngines } from '../engine-version.mjs';

const DEFAULT = join(homedir(), 'Projects/sleight-wt/race-1017/*');
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
const readText = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const birthMs = file => { try { return statSync(file).birthtimeMs; } catch { return undefined; } };
const isDir = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const isRound = dir => ['results.json', 'browser.json', 'failure.json'].some(name => existsSync(join(dir, name)));

// A folder that is a round, a folder of rounds, or <dir>/<prefix>* (shells leave an unmatched glob as is).
export function expandRounds(args) {
  const out = [];
  for (const arg of args) {
    const name = basename(arg);
    if (name.includes('*')) {
      const re = new RegExp('^' + name.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      const parent = dirname(arg);
      if (isDir(parent)) out.push(...readdirSync(parent).filter(n => re.test(n)).sort().map(n => join(parent, n)).filter(isDir));
    } else if (isRound(arg)) out.push(arg);
    else if (isDir(arg)) out.push(...readdirSync(arg).sort().map(n => join(arg, n)).filter(d => isDir(d) && isRound(d)));
  }
  return [...new Set(out)];
}

// One saved row graded again. Problems already recorded stay; the new rules can only turn a pass into a failure.
// graders (opt-in, currentAnswerGraders()): where the task's current answer patterns differ from the saved ones, the saved answer
// problems are dropped and the answer is checked against the current patterns, so the row can move either way.
export function regradeRow(row, { eventsText = '', stderr = '', graders } = {}) {
  const saved = graderId(row.task), wanted = graders?.get(row.task.name);
  const swap = wanted && runnerGradesAnswer(row.task) && graderId(wanted) !== saved;
  const recorded = row.outcome?.ok ? [] : [...(row.outcome?.problems?.length ? row.outcome.problems : [row.outcome?.cell ?? 'no outcome recorded'])];
  const problems = swap ? [...recorded.filter(p => !isAnswerProblem(p)), ...answerProblems(wanted, row.run?.result?.result)] : recorded;
  const calls = eventsText ? browserEvidence(eventsText).successfulCalls : row.successfulBrowserCalls ?? row.run?.evidence?.successfulCalls ?? null;
  if (!(calls >= 1) && !problems.includes('no successful browser tool call')) problems.push(calls == null ? 'browser calls not recorded' : 'no successful browser tool call');
  problems.push(...raceProblems({ task: row.task, site: row.site, answer: row.run?.result?.result }).filter(p => !problems.includes(p)));
  const passed = problems.length === 0;
  // Rows saved before the cover watch have only the start reading; a saved row without events keeps what the gate recorded.
  const cover = eventsText ? coverEvidence({ eventsText, readings: [row.cover, row.coverRun] }) : row.coverEvidence ?? null;
  return { task: row.task.name, arm: row.surface, seconds: row.wallMs / 1000, passed, problems, successfulCalls: calls,
    ...((row.agentSeconds ?? row.run?.agentSeconds) != null && { agentSeconds: row.agentSeconds ?? row.run.agentSeconds }),
    ...((row.agentTiming ?? row.run?.agentTiming) && { agentTiming: row.agentTiming ?? row.run.agentTiming }),
    ...((row.secondsTiming ?? row.run?.secondsTiming) && { secondsTiming: row.secondsTiming ?? row.run.secondsTiming }),
    recordedOk: row.outcome?.ok === true, errorClass: passed ? null : row.errorClass ?? runErrorClass({ eventsText, stderr }),
    graders: swap ? { used: 'current', saved, current: graderId(wanted), passedSaved: regradeRow(row, { eventsText, stderr }).passed } : { used: 'saved', saved },
    ...(cover ? { coverEvidence: cover } : {}) };
}

let staticTimeline;
export function loadRound(dir, { timeline = staticTimeline ??= loadTimeline(), graders } = {}) {
  const browser = readJson(join(dir, 'browser.json'))?.browser;
  let saved = readJson(join(dir, 'results.json'));
  if (!Array.isArray(saved)) saved = readdirSync(dir).map(n => readJson(join(dir, n, 'run.json'))).filter(r => r?.outcome && r.task);
  const span = readJson(join(dir, 'engine.json'));
  const born = span ? undefined : birthMs(join(dir, 'commits.json'));
  const when = row => (Number.isFinite(row.run?.started) ? { startMs: row.run.started, endMs: row.run.finished } : { startMs: born, dated: 'inferred' });
  const rows = saved.map(row => ({ ...regradeRow(row, { eventsText: readText(join(dir, row.task.name, 'events.jsonl')), stderr: readText(join(dir, row.task.name, 'stderr.txt')), graders }),
    engine: engineForRun({ recorded: row.engineVersion ?? span, ...when(row) }, timeline) }));
  const starts = saved.map(row => row.run?.started).filter(Number.isFinite), ends = saved.map(row => row.run?.finished).filter(Number.isFinite);
  const engine = engineForRun({ recorded: span, ...(starts.length ? { startMs: Math.min(...starts), endMs: Math.max(...ends) } : { startMs: born, dated: 'inferred' }) }, timeline);
  const marked = readJson(join(dir, 'harness-failure.json')), failure = readJson(join(dir, 'failure.json'));
  const detected = marked ? null : harnessFailure(rows.map(r => ({ task: r.task, ok: r.passed, errorClass: r.errorClass })), rows.length);
  const harness = marked ?? detected;
  return { dir, name: basename(dir), browser: browser ?? saved[0]?.task?.browser ?? 'unknown', arm: rows[0]?.arm ?? saved[0]?.surface ?? null,
    rows, failure: failure?.error ?? null, excluded: harness ? harness.reason : rows.length ? null : `no results${failure ? ` (${failure.error})` : ''}`,
    detected, commits: readJson(join(dir, 'commits.json')) ?? null, engine };
}

const sleightArm = browser => ['firefox', 'safari'].includes(browser) ? 'sleight' : 'sleight-turbo';
const HOSTED = SAME_MODEL.map(([hosted]) => hosted);

export const MIN_RUNS = 3;
// Per task the one arm with the strictly lowest expected time, and each arm's total when it passed every task.
// A cell under 3 runs (LAWS: 3 runs per arm) is shown, marked, and can't be fastest on its task.
function rank(table, tasks, arms) {
  const fastest = Object.fromEntries(arms.map(a => [a, []]));
  const short = tasks.flatMap(task => arms.filter(a => table[a]?.[task] && table[a][task].runs.length < MIN_RUNS).map(arm => ({ task, arm, runs: table[arm][task].runs.length })));
  for (const task of tasks) {
    const ranked = arms.filter(a => table[a]?.[task]?.expected != null && table[a][task].runs.length >= MIN_RUNS).sort((a, b) => table[a][task].expected - table[b][task].expected);
    if (ranked.length && (ranked.length === 1 || table[ranked[0]][task].expected < table[ranked[1]][task].expected)) fastest[ranked[0]].push(task);
  }
  const totals = Object.fromEntries(arms.map(a => [a, tasks.every(t => table[a]?.[t]?.expected != null) ? tasks.reduce((s, t) => s + table[a][t].expected, 0) : null]));
  return { fastest, short, totals };
}

// Marks row.harnessCover on the rows --exclude-covered leaves out, judged over every scored round together (any browser).
export function markCover(rounds) {
  const rows = rounds.filter(r => !r.excluded).flatMap(r => r.rows), out = coverExclusions(rows);
  for (const row of rows) if (out.has(row)) row.harnessCover = out.get(row); else delete row.harnessCover;
  for (const round of rounds) round.coverMarked = true;
  return rounds;
}

export function scoreRounds(rounds, { excludeCovered = false, agentSeconds = false } = {}) {
  // The results hub marks its whole pool once, so a study's subset keeps the pool's verdicts.
  if (excludeCovered && !rounds.every(round => round.coverMarked)) markCover(rounds);
  const browsers = {};
  for (const round of rounds) if (!round.excluded) for (const row of round.rows) if (!(excludeCovered && row.harnessCover)) (browsers[round.browser] ??= []).push({ ...row, file: round.name });
  const out = {};
  for (const [browser, rows] of Object.entries(browsers)) {
    const me = sleightArm(browser), tasks = [...new Set(rows.map(r => r.task))], seen = [...new Set(rows.map(r => r.arm))];
    const arms = [me, ...seen.filter(a => a !== me && !HOSTED.includes(a)).sort()], hosted = HOSTED.filter(a => seen.includes(a));
    const table = score(rows, { agentSeconds }), verdict = claim(table, { tasks, arms }, me);
    const counted = summarizeEngines(rows), engines = Object.fromEntries([...arms, ...hosted].filter(a => counted[a]).map(a => [a, counted[a]]));
    const same = sameModel(table, { tasks }).filter(p => table[p.hosted]).map(p => ({ ...p, arms: [p.hosted, p.base], stats: p.stats ?? {},
      topUps: p.pairs.filter(x => x.short?.length), ...rank(table, tasks, [p.hosted, p.base]) }));
    out[browser] = { me, tasks, arms, hosted, table, ...(agentSeconds && { timingByArm: timingSummary(rows) }), stats: verdict.stats, pairs: verdict.pairs, topUps: verdict.pairs.filter(p => p.short?.length),
      ...rank(table, tasks, arms), engines, engineMix: engineMix(engines), sameModel: same };
  }
  return out;
}

// Every scored row with cover evidence, pass or fail, and whether --exclude-covered leaves it out (and why not, when it doesn't).
export function coveredRows(rounds) {
  const out = coverExclusions(rounds.filter(r => !r.excluded).flatMap(r => r.rows));
  return rounds.filter(r => !r.excluded).flatMap(r => r.rows.filter(row => row.coverEvidence).map(row => {
    const left = out.get(row);
    return { round: r.name, browser: r.browser, arm: row.arm, task: row.task, passed: row.passed, excluded: !!left, source: left?.source ?? null,
      reason: left?.reason ?? `kept: ${Object.values(row.coverEvidence.share).some(f => f >= 0.5) ? 'a run of this arm and task passed under the same window' : 'reading under 50% and no drag refusal'}` };
  }));
}

// Rows that passed as recorded and fail under the race rules.
export const flipped = rounds => rounds.flatMap(r => r.rows.filter(row => row.recordedOk && !row.passed).map(row => ({ round: r.name, browser: r.browser, ...row })));
// Rows whose verdict the current answer patterns change, either way (--current-graders).
export const regraded = rounds => rounds.flatMap(r => r.rows.filter(row => row.graders?.used === 'current' && row.graders.passedSaved !== row.passed)
  .map(row => ({ round: r.name, browser: r.browser, ...row })));
export const gradersLine = current => current
  ? `Answer patterns: CURRENT ${ANSWER_GRADER_FILE} (opt-in --current-graders). Rows whose saved patterns differ are checked again in both directions.`
  : `Answer patterns: as saved with each run (the default). --current-graders checks saved answers against the current ${ANSWER_GRADER_FILE}.`;

export const coverLabel = excludeCovered => excludeCovered ? 'Cover exclusions: ON (opt-in --exclude-covered)' : 'Cover exclusions: OFF (default)';

function print(rounds, scored, { current = false, excludeCovered = false } = {}) {
  const n = x => x == null ? '-' : x.toFixed(1), col = s => ' ' + String(s).padStart(36);
  console.log(coverLabel(excludeCovered));
  console.log(gradersLine(current) + '\n');
  console.log('Rounds:');
  const roundEngine = e => (e.version ? `engine ${e.version} ${e.provenance}` : `engine ${e.provenance}${e.candidates ? ` (${e.candidates.join(' or ')})` : ''}`) +
    (e.startedAt ? `, ${dayRange(e.startedAt, e.endedAt)}${e.dated === 'inferred' ? ' (date inferred)' : ''}` : ', no date');
  for (const r of rounds) console.log(`  ${r.name} (${r.browser}, ${r.arm ?? 'no arm'}, ${r.rows.length} rows${r.commits?.build?.commit ? `, build ${r.commits.build.commit.slice(0, 8)}` : ''}, ${roundEngine(r.engine)}): ${r.excluded ? `excluded, ${r.excluded}` : 'scored'}`);
  const grid = (s, arms, stats, fastest, totals, short) => {
    console.log('task'.padEnd(22) + arms.map(col).join(''));
    for (const task of s.tasks) console.log(task.padEnd(22) + arms.map(a => {
      const t = s.table[a]?.[task], st = stats[a]?.[task];
      if (!t) return col('no runs');
      const mark = t.runs.length < MIN_RUNS ? '*' : '';
      if (!t.passes.length) return col(`never (0/${t.runs.length})${mark}`);
      return col(`${n(t.expected)} (${t.passes.length}/${t.runs.length}) ${n(st.median)} [${n(st.range[0])}-${n(st.range[1])}]${st.p90 != null ? ` p90 ${n(st.p90)}` : ''}${mark}`);
    }).join(''));
    if (short.length) console.log(`* under ${MIN_RUNS} runs, kept out of "fastest on": ${short.map(c => `${c.task}/${c.arm} (${c.runs})`).join(', ')}`);
    console.log('fastest on'.padEnd(22) + arms.map(a => col(`${fastest[a].length} of ${s.tasks.length}`)).join(''));
    console.log('total expected s'.padEnd(22) + arms.map(a => col(totals[a] == null ? 'none (a task has no pass)' : n(totals[a]))).join(''));
  };
  const topUpLine = (me, topUps) => topUps.length ? `Within 20% of ${me}, need 5 runs: ${topUps.map(p => `${p.task}/${p.arm} (${p.short.join(', ')})`).join('; ')}` : `No pair within 20% of ${me} is short of 5 runs.`;
  for (const [browser, s] of Object.entries(scored)) {
    console.log(`\n${browser}. Cell: expected s (passes/runs), median [min-max] of passes, p90 at 5+ runs.`);
    grid(s, s.arms, s.stats, s.fastest, s.totals, s.short);
    const all = [...s.arms, ...s.hosted];
    console.log(`Engine and UTC dates per arm (runs): ${all.map(a => `${a} ${s.engines[a] ? engineText(s.engines[a], a) : 'no runs'}`).join(' | ')}.`);
    console.log(engineNote(s.engines, s.engineMix));
    console.log(topUpLine(s.me, s.topUps));
    for (const p of s.sameModel) {
      console.log(`\nSame model: ${p.hosted} (sleight inside Codex) against ${p.base} (Codex's own computer use), left out of ${s.me}'s columns above.`);
      if (p.wording === 'no comparison') { console.log(p.reasons.join('; ')); continue; }
      grid(s, p.arms, p.stats, p.fastest, p.totals, p.short);
      console.log(topUpLine(p.hosted, p.topUps));
      console.log(`Wording for ${p.hosted}: ${p.wording}`);
    }
  }
  const covered = coveredRows(rounds), left = covered.filter(c => c.excluded);
  console.log(`\nRows with cover evidence (${covered.length}), ${left.length} of them ${excludeCovered ? 'left out above' : 'left out under --exclude-covered, scored above'}` +
    ` (${left.filter(c => c.passed).length} passes, ${left.filter(c => !c.passed).length} failures):`);
  for (const c of covered) console.log(`  ${c.round} ${c.arm} ${c.task} ${c.passed ? 'pass' : 'fail'}: ${c.excluded ? 'out, ' : ''}${c.reason}`);
  const flips = flipped(rounds);
  console.log(`\nPasses as recorded that fail under the race rules (${flips.length}):`);
  for (const f of flips) console.log(`  ${f.round} ${f.arm} ${f.task}: ${f.problems.join('; ')}`);
  if (!current) return;
  const moved = regraded(rounds);
  console.log(`\nRows the current answer patterns change (${moved.length}):`);
  for (const m of moved) console.log(`  ${m.round} ${m.arm} ${m.task}: ${m.graders.passedSaved ? 'pass' : 'fail'} with saved patterns ${m.graders.saved}, ` +
    `${m.passed ? 'pass' : `fail (${m.problems.join('; ')})`} with current ${m.graders.current}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dirs = args.filter(a => !a.startsWith('--'));
  const timeline = currentTimeline(), current = args.includes('--current-graders');
  const graders = current ? currentAnswerGraders() : undefined;
  const rounds = expandRounds(dirs.length ? dirs : [DEFAULT]).map(dir => loadRound(dir, { timeline, graders }));
  if (args.includes('--mark')) for (const r of rounds) if (r.detected) writeFileSync(join(r.dir, 'harness-failure.json'),
    JSON.stringify({ ...r.detected, decided: 'automatic (race-score --mark)', at: new Date().toISOString() }, null, 2));
  const excludeCovered = args.includes('--exclude-covered');
  const agentSeconds = args.includes('--agent-seconds');
  const scored = scoreRounds(rounds, { excludeCovered, agentSeconds });
  const timingRows = rounds.filter(r => !r.excluded).flatMap(r => r.rows).filter(r => !excludeCovered || !r.harnessCover);
  if (args.includes('--json')) console.log(JSON.stringify({ coverExclusions: excludeCovered, graders: current ? `current ${ANSWER_GRADER_FILE}` : 'saved', rounds,
    browsers: scored, flipped: flipped(rounds), covered: coveredRows(rounds), ...(current ? { regraded: regraded(rounds) } : {}),
    ...(agentSeconds && { timing: 'agentSeconds where present; seconds otherwise; consult timingByArm for boundaries',
      timingByArm: timingSummary(timingRows), legacyTimingRows: timingRows.filter(r => !hasAgentSeconds(r)).length }) }, null, 1));
  else { if (agentSeconds) console.log('Timing: agentSeconds where present; seconds otherwise. Per arm: ' + JSON.stringify(timingSummary(timingRows))); print(rounds, scored, { current, excludeCovered }); }
}
