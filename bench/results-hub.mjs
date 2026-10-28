#!/usr/bin/env node
// The benchmark hub: one generator for docs/results/. It runs in two stages.
//   collect: reads the raw results (docs/benchmarks, and the claim and race folders under ~/Projects/sleight-wt) and writes one
//            scrubbed data file per family to docs/results/data/. A family whose raw folder is missing on this Mac keeps the
//            data file already in the repo, so the pages rebuild anywhere.
//   render:  reads only those data files and writes the index (README.md, index.html), one Markdown page per family, the chart
//            images in img/, explore.html with the data inlined (fetch from file:// fails in browsers), and the three generated
//            blocks of the repo's README.md (between the hub:claim, hub:headline and hub:benchmarks markers).
// Validation and re-measure banks (bench/validation) are found under the worktrees folder, one or two folders down, and --bank adds a
// folder anywhere; they get their own page (validation.md) because they compare two sleight builds and no other tool.
// Scores come from the scorers themselves: bench/claim-score.mjs for the claims and every per-task table, and
// bench/fowl/race-score.mjs for the browser race rounds. Nothing in the output depends on the clock. Every arm's numbers name the
// ChatGPT engine versions they ran on with their UTC dates, read from the results or inferred from the checked-in timeline
// (bench/engine-versions.json; run `node bench/engine-version.mjs refresh` on the benchmark Mac before collecting).
//   node bench/results-hub.mjs [--wt ~/Projects/sleight-wt] [--out docs/results] [--render-only] [--hub-only] [--check] [--exclude-covered] [--bank <folder>]...
// --hub-only leaves the root README alone, including during --check. Release preflight always checks it too.
// The runners run collect and render once after a successful pass through bench/hub-refresh.mjs (--no-hub or SLEIGHT_NO_HUB=1 stops it).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claim, excluded, regradeFor, score, warnings } from './claim-score.mjs';
import { coveredRows, loadRound, markCover, scoreRounds } from './fowl/race-score.mjs';
import { ANSWER_GRADER_FILE, currentAnswerGraders } from './fowl/real-gate-grade.mjs';
import { dayRange, engineMix, engineNote, engineText, loadTimeline, passRowEngine, summarizeEngines, usesEngine } from './engine-version.mjs';
import { buildPage, loadResults, perArm, renderHtml as renderReleaseHtml, renderMarkdown as renderReleaseMarkdown } from './results-page.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = join(ROOT, 'docs', 'benchmarks');
// The charts come from bench/results-charts.mjs. Until that file exists the pages render without charts, and an error inside it
// still stops the render.
const NO_CHARTS = { CHARTS: [], renderCharts: () => ({}), chartCaption: () => '', chartBlock: () => '', haikuCheckoutDisclosure: () => '' };
const charts = existsSync(join(ROOT, 'bench/results-charts.mjs')) ? await import('./results-charts.mjs') : NO_CHARTS;
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const tryJson = file => { try { return readJson(file); } catch { return undefined; } };
const isDir = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const uniq = list => [...new Set(list.filter(value => value !== undefined && value !== null && value !== ''))];
const sortedUniq = list => uniq(list).sort();

// ---------------------------------------------------------------------------------------------------------------------------
// Scrubbing. Published data shows the home folder as ~ and never the owner's account or full name (LAWS).

// Paths are scrubbed everywhere, render included. Owner names are scrubbed only in collect(), on strings copied from raw data,
// so rendering never depends on which account runs it (on CI the account is 'runner', a word the pages use).
let nameParts;
function ownerNames() {
  if (nameParts) return nameParts;
  const names = [];
  if (process.platform === 'darwin') {
    names.push(userInfo().username);
    try { names.push(...execFileSync('id', ['-F'], { encoding: 'utf8' }).trim().split(/\s+/)); } catch { /* no full name */ }
  }
  nameParts = uniq(names.filter(name => name && name.length >= 3));
  return nameParts;
}
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function scrubPaths(value) {
  return String(value ?? '').split(homedir()).join('~')
    .replace(/(?:\/private)?\/var\/folders\/[^\s"'`)\],;:]+/g, '$TMPDIR')
    .replace(/\/Users\/[^/\s"'`)\],;:]+/g, '~');
}
export function scrub(value) {
  let text = scrubPaths(value);
  for (const name of ownerNames()) text = text.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'gi'), '[owner]');
  return text;
}
const tilde = path => scrub(path);

// ---------------------------------------------------------------------------------------------------------------------------
// Shared study shape. Every family's data file holds studies; a study is one scored comparison with its runs and its cells.
//   { id, family, title, date, browser, me, arms, tasks, models, effort, runs: [...], cells: [...], verdict }
// cells come from claim-score's score() and claim(), the same functions both scorers use.

// '2026-10-18 to 2026-10-18' reads as one day; times are UTC.
export function dateRange(first, last) {
  if (!first) return null;
  const day = value => value.slice(0, 10), time = value => value.slice(11, 16).replace('-', ':');
  if (!last || day(first) === day(last)) return time(first) && time(last ?? first) ? `${day(first)}, ${time(first)} to ${time(last ?? first)} UTC` : day(first);
  return `${day(first)} to ${day(last)}`;
}

const round1 = value => (value === null || value === undefined ? null : Math.round(value * 1000) / 1000);
export function cellsFor(runs, tasks, arms, me) {
  const table = score(runs.map(run => ({ arm: run.arm, task: run.task, seconds: run.seconds, passed: run.passed })));
  const verdict = claim(table, { tasks, arms }, me);
  const cells = [];
  for (const task of tasks) for (const arm of arms) {
    const t = table[arm]?.[task];
    if (!t) continue;
    const s = verdict.stats[arm]?.[task];
    cells.push({ task, arm, runs: t.runs.length, passes: t.passes.length, expected: round1(t.expected), median: round1(t.median),
      min: s?.range ? round1(s.range[0]) : null, max: s?.range ? round1(s.range[1]) : null, p90: round1(s?.p90 ?? null) });
  }
  return { table, verdict, cells };
}

// A task counts as lost when another arm has the lower expected time or a faster passing run (LAWS, owner 2026-10-18).
export function lossRule(table, tasks, arms, me) {
  const lost = [];
  for (const task of tasks) {
    const mine = table[me]?.[task];
    const myBest = mine?.passes.length ? Math.min(...mine.passes) : null;
    const by = [];
    for (const arm of arms.filter(a => a !== me)) {
      const other = table[arm]?.[task];
      if (!other?.passes.length) continue;
      const lowerExpected = mine?.expected == null || other.expected < mine.expected;
      const fasterRun = myBest == null || Math.min(...other.passes) < myBest;
      if (lowerExpected || fasterRun) by.push({ arm, lowerExpected, fasterRun });
    }
    if (by.length) lost.push({ task, by });
  }
  return lost;
}

// minRuns: the race keeps a cell under 3 runs out of the lowest-expected-time count (race-score.mjs MIN_RUNS).
function summarizeVerdict(table, verdict, tasks, arms, me, { minRuns = 0 } = {}) {
  const fastest = Object.fromEntries(arms.map(arm => [arm, []]));
  for (const task of tasks) {
    const ranked = arms.filter(a => table[a]?.[task]?.expected != null && table[a][task].runs.length >= minRuns).sort((a, b) => table[a][task].expected - table[b][task].expected);
    if (ranked.length && (ranked.length === 1 || table[ranked[0]][task].expected < table[ranked[1]][task].expected)) fastest[ranked[0]].push(task);
  }
  return {
    me, wording: verdict.wording, lowest: verdict.lowest, reasons: verdict.reasons,
    totals: Object.fromEntries(Object.entries(verdict.totals).map(([arm, total]) => [arm, round1(total)])),
    fastest, lost: lossRule(table, tasks, arms, me),
    topUps: verdict.pairs.filter(pair => pair.short?.length).map(pair => ({ task: pair.task, arm: pair.arm, short: pair.short })),
  };
}

const scrubVerdict = verdict => ({ ...verdict, wording: scrub(verdict.wording), reasons: verdict.reasons.map(scrub) });

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: native claim and app claim (bench/claim-score.mjs, its CLI loop over a results folder).

export function scoreClaimDir(dir, rules, since, timeline = loadTimeline()) {
  const rows = [], dropped = {}, files = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json') && name >= since).sort()) {
    const raw = readJson(join(dir, file)), mtimeMs = statSync(join(dir, file)).mtimeMs;
    let kept = 0;
    for (const row of raw.results ?? []) {
      const why = excluded(row, file, rules, raw);
      if (why) { if (why !== 'not a claim task') dropped[why] = (dropped[why] ?? 0) + 1; continue; }
      const passed = !!(row.passed || (row.cleanupContained && row.taskPassed)), g = !passed && regradeFor(row, file, rules);
      rows.push({ arm: row.arm, task: row.task, seconds: row.seconds, passed, file, run: row.run,
        ...(!passed && { reason: (g && g.reason) || (row.reason ?? 'no reason recorded'), ...(g && { recorded: row.reason, regraded: g.why }) }),
        models: row.models ?? [], engine: passRowEngine(raw, row, { file, mtimeMs, timeline }) });
      kept += 1;
    }
    files.push({ file, raw, kept });
  }
  const table = score(rows), verdict = claim(table, rules), warned = warnings(rows, rules, since);
  return { rows, dropped, files, table, verdict, warnings: warned };
}

function armVersions(raw) {
  const out = {};
  for (const [arm, meta] of Object.entries(raw.armMetadata ?? {})) {
    const bits = [];
    if (meta.claudeVersion) bits.push(`Claude Code ${meta.claudeVersion}`);
    for (const server of Object.values(meta.servers ?? {})) for (const artifact of server.artifacts ?? []) {
      if (artifact.name && artifact.version) bits.push(`${artifact.name} ${artifact.version}`);
    }
    if (bits.length) out[arm] = bits;
  }
  return out;
}

function collectClaim({ id, title, dir, rulesFile, since, sinceNote, timeline }) {
  const rules = readJson(rulesFile);
  const result = scoreClaimDir(dir, rules, since ?? rules.since, timeline);
  const arms = rules.arms.filter(arm => result.table[arm]);
  const tasks = rules.tasks;
  const { cells, verdict, table } = cellsFor(result.rows, tasks, arms, 'sleight');
  const versions = {}, effort = [], auth = [], stamps = [];
  for (const { file, raw, kept } of result.files) {
    if (!kept) continue;
    stamps.push(file.slice(0, 16));
    if (raw.effort) effort.push(raw.effort);
    if (raw.auth) auth.push(raw.auth);
    for (const [arm, bits] of Object.entries(armVersions(raw))) versions[arm] = sortedUniq([...(versions[arm] ?? []), ...bits]);
  }
  const models = {};
  for (const row of result.rows) models[row.arm] = sortedUniq([...(models[row.arm] ?? []), ...row.models]);
  const runs = result.rows.map(row => ({ task: row.task, arm: row.arm, run: row.run, round: null, seconds: row.seconds, passed: row.passed,
    problem: row.passed ? null : scrub(row.reason).slice(0, 200), regraded: row.regraded ? scrub(row.regraded) : undefined, file: row.file }));
  return {
    family: id, title,
    source: { results: tilde(dir), rules: tilde(rulesFile).replace(tilde(ROOT) + '/', ''), since: since ?? rules.since, sinceNote: scrub(sinceNote ?? rules.sinceReason ?? '') || null,
      files: result.files.filter(f => f.kept).map(f => ({ file: f.file, arm: (f.raw.arms ?? []).join(','), kept: f.kept })) },
    studies: [{
      id, family: id, title, browser: null, me: 'sleight', arms, tasks,
      date: stamps.length ? dateRange(sortedUniq(stamps)[0], sortedUniq(stamps).at(-1)) : null,
      models, effort: sortedUniq(effort), auth: sortedUniq(auth), versions, ...enginesFor(result.rows, arms),
      runs, cells, verdict: scrubVerdict(summarizeVerdict(table, verdict, tasks, arms, 'sleight')),
      excluded: Object.entries(result.dropped).sort(([a], [b]) => (a < b ? -1 : 1)).map(([why, count]) => ({ why: scrub(why), count })),
      warnings: result.warnings.map(scrub),
    }],
  };
}

// Per arm, the engine versions and UTC dates of its counted runs, in the table's arm order, and the mix among engine arms.
function enginesFor(rows, arms) {
  const counted = summarizeEngines(rows.filter(row => row.engine));
  const engines = Object.fromEntries(arms.filter(arm => counted[arm]).map(arm => [arm, counted[arm]]));
  return { engines, engineMix: engineMix(engines) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: the real-window browser race (bench/fowl/race-score.mjs over round folders).

const ROUND_NAME = /^(chrome|helium|safari|firefox)-(.+?)-r(\d+)(f?)(?:-([a-z][a-z-]*))?$/;
const cap = word => word[0].toUpperCase() + word.slice(1);
const sleightArmFor = browser => (['firefox', 'safari'].includes(browser) ? 'sleight' : 'sleight-turbo');

// The race folders are the dated race-MMDD folders under the worktrees folder (race-1017). A new race folder is picked up by name, and
// a round name that appears in two folders is read from the first.
export const raceDirs = wt => subdirs(wt).filter(dir => /^race-\d{4}$/.test(basename(dir)));

export function listRaceRounds(raceDir) {
  const seen = new Set();
  return [].concat(raceDir).filter(isDir).flatMap(dir => readdirSync(dir).sort().filter(name => ROUND_NAME.test(name) && isDir(join(dir, name))).map(name => {
    const [, browser, label, round, rerun, suffix] = ROUND_NAME.exec(name);
    return { name, dir: join(dir, name), browser, label, round: Number(round), rerun: rerun === 'f', suffix: suffix ?? null, done: existsSync(join(dir, name, 'results.json')) };
  })).filter(round => !seen.has(round.name) && seen.add(round.name));
}

function roundFacts(dir) {
  const raw = tryJson(join(dir, 'results.json')) ?? [];
  const started = raw.map(row => row.run?.started).filter(Number.isFinite);
  const models = new Set(), effort = new Set(), claude = new Set();
  for (const row of raw) {
    for (const model of Object.keys(row.run?.result?.modelUsage ?? {})) models.add(model);
    const text = JSON.stringify(row.run ?? {});
    for (const match of text.matchAll(/"model":"(gpt-[^"]+)"/g)) models.add(match[1]);
    for (const match of text.matchAll(/"effort":"([a-z]+)"/g)) effort.add(match[1]);
    if (row.agentConfig?.claudeVersion) claude.add(row.agentConfig.claudeVersion);
  }
  const browser = tryJson(join(dir, 'browser.json')) ?? {};
  const commits = tryJson(join(dir, 'commits.json')) ?? {};
  return {
    first: started.length ? new Date(Math.min(...started)).toISOString().slice(0, 16) + 'Z' : null,
    last: started.length ? new Date(Math.max(...started)).toISOString().slice(0, 16) + 'Z' : null,
    models: [...models].sort(), effort: [...effort].sort(), claude: [...claude].sort(),
    browserVersion: browser.version ?? null, build: commits.build?.commit?.slice(0, 8) ?? null, fowlbrowser: commits.fowlbrowser?.commit?.slice(0, 8) ?? null,
  };
}

export function collectRace({ raceDir, browsers, family, title, timeline = loadTimeline(), excludeCovered = false, listedRounds, transform = (_round, loaded) => loaded }) {
  // Folder names pick the candidates; a round's own browser.json decides where it is scored, as in race-score.mjs.
  const listed = (listedRounds ?? listRaceRounds(raceDir)).filter(round => browsers.includes(round.browser));
  const marked = listed.filter(round => !round.done && existsSync(join(round.dir, 'harness-failure.json')));
  const inProgress = listed.filter(round => !round.done && !marked.includes(round)).map(round => round.name);
  // Published numbers use the answer patterns saved with each run; the current task file's patterns are scored beside them.
  const graders = currentAnswerGraders();
  const loaded = listed.filter(round => round.done).map(round => {
    const saved = transform(round, loadRound(round.dir, { timeline }));
    return { ...round, loaded: saved, current: { ...transform(round, loadRound(round.dir, { timeline, graders })), excluded: saved.excluded }, facts: roundFacts(round.dir) };
  });
  const excludedRounds = [...loaded.filter(round => round.loaded.excluded).map(round => ({ round: round.name, reason: scrub(round.loaded.excluded) })),
    ...marked.map(round => ({ round: round.name, reason: scrub(tryJson(join(round.dir, 'harness-failure.json'))?.reason ?? 'marked as a harness failure') }))]
    .sort((a, b) => (a.round < b.round ? -1 : 1));
  const usable = loaded.filter(round => !round.loaded.excluded);
  // Cover exclusions are opt-in (--exclude-covered), judged once over every usable round in these browsers.
  if (excludeCovered) { markCover(usable.map(round => round.loaded)); markCover(usable.map(round => round.current)); }
  const evidence = coveredRows(usable.map(round => round.loaded));
  const cover = { applied: excludeCovered, rows: evidence.length, left: evidence.filter(c => c.excluded).length,
    leftPasses: evidence.filter(c => c.excluded && c.passed).length };
  const studies = [], partial = [];
  for (const browser of browsers) {
    const me = sleightArmFor(browser);
    const mine = usable.filter(round => round.loaded.browser === browser && round.loaded.arm === me);
    const others = usable.filter(round => round.loaded.browser === browser && round.loaded.arm !== me);
    if (!mine.length) continue;
    const tasks = sortedUniq(others.flatMap(round => round.loaded.rows.map(row => row.task)));
    const labels = sortedUniq(mine.map(round => round.label));
    for (const label of labels) {
      const set = mine.filter(round => round.label === label);
      const counts = {};
      for (const round of set) for (const row of round.loaded.rows) counts[row.task] = (counts[row.task] ?? 0) + 1;
      const short = tasks.filter(task => (counts[task] ?? 0) < 3);
      if (short.length) {
        partial.push({ browser, label, rounds: set.map(round => round.name), runs: Object.values(counts).reduce((a, b) => a + b, 0), needed: tasks.length * 3 });
        continue;
      }
      const rounds = [...set, ...others];
      const scored = scoreRounds(rounds.map(round => round.loaded), { excludeCovered })[browser];
      // sleight inside Codex (SAME_MODEL) is sleight itself, so its cells are kept but it counts only in its same-model section.
      const { arms, hosted } = scored, everyArm = [...arms, ...hosted];
      // With --exclude-covered, a run in a window another app covered is left out, as race-score.mjs does, and listed with the app.
      const left = row => excludeCovered && row.harnessCover;
      const { cells, table } = cellsFor(rounds.flatMap(round => round.loaded.rows.filter(row => !left(row))), scored.tasks, everyArm, me);
      const verdict = claim(table, { tasks: scored.tasks, arms }, me);
      const sameModel = scored.sameModel.map(pair => ({ hosted: pair.hosted, base: pair.base,
        ...summarizeVerdict(table, pair, scored.tasks, pair.arms, pair.hosted, { minRuns: 3 }) }));
      const runs = rounds.flatMap(round => round.loaded.rows.map(row => ({
        task: row.task, arm: row.arm, round: round.name, run: null, seconds: round1(row.seconds), passed: row.passed, ...(left(row) ? { leftOut: scrub(row.harnessCover.reason) } : {}),
        problem: row.passed ? null : scrub((left(row) ? `left out, ${row.harnessCover.reason}: ` : '') + row.problems.join('; ')).slice(0, 200), file: round.name })));
      const models = {}, effort = {}, versions = {};
      for (const round of rounds) {
        const arm = round.loaded.arm;
        models[arm] = sortedUniq([...(models[arm] ?? []), ...round.facts.models]);
        effort[arm] = sortedUniq([...(effort[arm] ?? []), ...round.facts.effort]);
        versions[arm] = sortedUniq([...(versions[arm] ?? []), ...round.facts.claude.map(v => `Claude Code ${v}`)]);
      }
      const starts = sortedUniq(rounds.map(round => round.facts.first)), ends = sortedUniq(rounds.map(round => round.facts.last));
      const mineStarts = sortedUniq(set.map(round => round.facts.first));
      studies.push({
        id: `${family}-${browser}-${label}`, family, title: `${cap(browser)}, sleight rounds \`${browser}-${label}-r*\``, started: mineStarts[0] ?? null,
        browser, label, me, arms, hosted, tasks: scored.tasks, models, effort, versions, ...enginesFor(rounds.flatMap(round => round.loaded.rows), everyArm),
        date: starts.length ? dateRange(starts[0], ends.at(-1)) : null,
        builds: Object.fromEntries(everyArm.map(arm => [arm, sortedUniq(rounds.filter(r => r.loaded.arm === arm).map(r => r.facts.build))])),
        browserVersion: sortedUniq(rounds.map(round => round.facts.browserVersion)),
        rounds: rounds.map(round => ({ round: round.name, arm: round.loaded.arm, rows: round.loaded.rows.length, first: round.facts.first, build: round.facts.build })),
        runs, cells,
        verdict: { ...summarizeVerdict(table, verdict, scored.tasks, arms, me, { minRuns: 3 }), raceFastest: scored.fastest, raceTotals: Object.fromEntries(Object.entries(scored.totals).map(([a, t]) => [a, round1(t)])) },
        sameModel,
        graders: gradersFor(rounds, browser, scored, { excludeCovered }),
      });
    }
  }
  // The newest complete set per browser leads its page.
  for (const study of studies) study.latest = !studies.some(other => other.browser === study.browser && other !== study && (other.started ?? '') > (study.started ?? ''));
  return { family, title, source: { race: [].concat(raceDir).map(tilde).join(', '), browsers }, inProgress, excludedRounds, partial, cover, minRuns: 3, studies };
}

// The rematch is a separate population for each model and suite. Repeated round names across its banks must never pool.
// LR2's reviewed offline report is data: do not import a runner or change the saved LR1 grades in the evidence bank.
export function collectRematch({ banks, regrade, timeline = loadTimeline() }) {
  const corrected = new Map();
  for (const line of String(regrade ?? '').split('\n')) {
    const fields = line.split(' | ');
    if (fields.length === 7 && fields[5] === '->') {
      const key = `${fields[0]}/${fields[1]}`;
      if (corrected.has(key)) throw Error(`Duplicate LR1 regrade: ${key}`);
      corrected.set(key, fields[6]);
    }
  }
  const out = { studies: [], inProgress: [], excludedRounds: [], partial: [] };
  for (const { dir, model } of banks.filter(bank => isDir(bank.dir))) {
    const core = listRaceRounds(dir);
    const held = subdirs(dir).filter(p => /^whole-.+-r\d+$/.test(basename(p))).map(p => ({
      name: basename(p), dir: p, browser: 'chrome', label: basename(p).match(/^whole-(.+)-r\d+$/)[1], done: existsSync(join(p, 'results.json')),
    }));
    for (const folder of ['jobs', 'jobs-topup']) for (const fixture of subdirs(join(dir, folder))) {
      const p = join(fixture, 'round');
      if (!isDir(p)) continue;
      const arm = tryJson(join(p, 'results.json'))?.[0]?.surface;
      if (!arm) continue;
      held.push({ name: `${folder}/${basename(fixture)}/round`, dir: p, browser: 'chrome', label: arm, done: true });
    }
    for (const [suite, rounds] of [['core', core], ['held-out', held]]) {
      if (!rounds.length) continue;
      const transform = (round, loaded) => {
        if (!round.name.startsWith('whole-')) return loaded;
        return { ...loaded, rows: loaded.rows.map(row => {
          const grade = corrected.get(`${round.name}/${row.task}`);
          if (!grade) throw Error(`Missing LR1 regrade for ${round.name}/${row.task}`);
          const problems = [...(grade === 'ok' ? [] : [grade.replace(/^FAIL: /, '')]),
            ...(row.successfulCalls >= 1 ? [] : ['no successful browser tool call'])];
          return { ...row, passed: problems.length === 0, problems };
        }) };
      };
      const race = collectRace({ raceDir: dir, browsers: ['chrome', 'helium'], family: 'browser-turbo', title: 'FowlBrowser rematch',
        listedRounds: rounds, transform, timeline });
      for (const study of race.studies) {
        study.id = `fw1-e51c52a-${model}-${study.browser}-${suite}`;
        study.title = `${cap(study.browser)}, ${cap(model)} 5.5, ${suite === 'core' ? `${study.tasks.length} core tasks` : `${study.tasks.length} held-out tasks`}`;
        Object.assign(study, { rematch: true, model, suite, label: `fw1-e51c52a-${model}-${suite}` });
        study.harnessBuilds = study.builds;
        // 4275bedb changes only the rematch harness pin on the measured e679ed7e product build.
        study.builds = { ...study.builds, 'sleight-turbo': study.builds['sleight-turbo'].map(b => b === '4275bedb' ? 'e679ed7e' : b) };
        study.competitorBuilds = sortedUniq(rounds.map(r => roundFacts(r.dir).fowlbrowser));
        const whole = study.runs.filter(r => ['dm-first-message', 'mail-first-invoice', 'endless-feed-honesty'].includes(r.task));
        if (whole.length) study.regrade = { commit: '64550de9', method: 'Offline regrade, saved final result with JSON extraction',
          arms: Object.fromEntries(study.arms.map(arm => [arm, { runs: whole.filter(r => r.arm === arm).length, passes: whole.filter(r => r.arm === arm && r.passed).length }])) };
        study.notes = [
          'FowlBrowser ran its defaults. Chrome used the benchmark profile and Helium a fresh profile. These are sleight\'s own tasks. Earlier benchmark runs informed its skill and tool wording.',
          suite === 'core' ? 'The 13 core browser tasks are scored separately from the eight held-out tasks.' :
            `The held-out set has eight tasks: five job fixtures and three whole-thread tasks. Whole-thread answers use the offline regrade (64550de9), ${Object.entries(study.regrade?.arms ?? {}).map(([arm, count]) => `${armName(arm)} ${count.passes}/${count.runs}`).join(', ')}, after the harness appended a RESULT instruction to JSON-only prompts. The saved grades are unchanged.`,
          ...(suite === 'held-out' ? ['Both arms failed job-motion. FowlBrowser answered yellow/teal/purple. The strict grader requires amber/teal/violet.'] : []),
        ];
      }
      out.studies.push(...race.studies);
      out.inProgress.push(...race.inProgress.map(name => `${basename(dir)}/${name}`));
      out.excludedRounds.push(...race.excludedRounds.map(row => ({ ...row, round: `${basename(dir)}/${row.round}`, rematch: true })));
      out.partial.push(...race.partial.map(row => ({ ...row, model, suite, rematch: true })));
    }
    for (const p of subdirs(join(dir, 'aborted'))) out.excludedRounds.push({ round: `${basename(dir)}/aborted/${basename(p)}`, rematch: true, reason: 'hold-stopped partial attempt; the completed rerun is scored' });
    for (const p of subdirs(dir).filter(p => /^jobs\.aborted/.test(basename(p)))) out.excludedRounds.push({ round: `${basename(dir)}/${basename(p)}`, rematch: true, reason: 'hold-stopped partial jobs matrix; the complete matrix is scored' });
  }
  return out;
}

// Which answer patterns the study's numbers used: the ones saved with each run. Tasks whose patterns in the current task file differ
// list how many runs that touches and how many change verdict, with the study scored under the current patterns beside it.
function gradersFor(rounds, browser, scored, { excludeCovered = false } = {}) {
  const touched = rounds.flatMap(round => round.current.rows.filter(row => row.graders?.used === 'current'));
  const differ = sortedUniq(touched.map(row => row.task)).map(task => ({ task, runs: touched.filter(row => row.task === task).length,
    moved: touched.filter(row => row.task === task && row.passed !== row.graders.passedSaved).length }));
  const summary = s => Object.fromEntries(s.arms.map(arm => {
    const cells = Object.values(s.table[arm] ?? {});
    return [arm, { passes: cells.reduce((n, c) => n + c.passes.length, 0), runs: cells.reduce((n, c) => n + c.runs.length, 0), fastest: s.fastest[arm].length, total: round1(s.totals[arm]) }];
  }));
  return { used: 'saved', file: ANSWER_GRADER_FILE, differ,
    ...(differ.length ? { saved: summary(scored), current: summary(scoreRounds(rounds.map(round => round.current), { excludeCovered })[browser]) } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: FowlBrowser-runner round reports (Markdown tables) in docs/benchmarks/<study>/.

const RUNNER_HEAD = /^\| agent \| surface \| browser \| outcome \|/;
const SESSION = /^((?:[a-z]+\d*-)?\d{8}-\d{4}|\d\d-\d\d|[a-z]*\d[a-z0-9]*)-/;

export function parseRunnerReport(text) {
  const rows = [], problems = {};
  let inTable = false, inProblems = false;
  for (const line of text.split('\n')) {
    if (RUNNER_HEAD.test(line)) { inTable = true; continue; }
    if (inTable && line.startsWith('|---')) continue;
    if (inTable && line.startsWith('| ')) {
      const cols = line.slice(2, -2).split(' | ');
      const time = /^(\d+(?:\.\d+)?) s/.exec(cols[10] ?? '');
      const calls = /(\d+) calls?(?:, \d+ actions)?(?:, (\d+) errors?)?/.exec(cols[11] ?? '');
      rows.push({ task: cols[0], surface: cols[1], browser: cols[2], ok: /^ok\b/.test(cols[3] ?? ''), outcome: cols[3],
        seconds: time ? Number(time[1]) : null, calls: calls ? Number(calls[1]) : null, errors: calls?.[2] ? Number(calls[2]) : 0 });
      continue;
    }
    inTable = false;
    if (/^ROUND NOT CLEAN/.test(line)) { inProblems = true; continue; }
    if (inProblems) {
      const item = /^- ([\w-]+) · ([^·]+) · (.+)$/.exec(line);
      if (item) (problems[item[1]] ??= []).push(`${item[2].trim()}: ${item[3].trim()}`);
      else if (line.trim() && !line.startsWith('- ')) inProblems = false;
    }
  }
  return { rows, problems };
}

export function variantOf(stem) {
  let label = stem.replace(/-(normal|swap)(?=-|$)/, '').replace(/-\d{4}$/, '');
  const order = /-(swap)(?=-|$)/.test(stem) ? 'swap' : 'normal';
  const session = SESSION.exec(label);
  if (session) label = label.slice(session[0].length);
  return { variant: label, session: session ? session[1] : null, order };
}

// Owner's scoring (LAWS): a run that stops before a payment the prompt didn't price counts as done. The runner grades a
// form-checkout run that submitted nothing as a failure; here that run passes, and the runner's grade is kept beside it.
export function ownerPass(row, problems) {
  if (row.ok) return true;
  const outcome = problems.filter(p => p.startsWith('outcome:'));
  return row.task === 'form-checkout' && outcome.length > 0 && outcome.every(p => /nothing submitted/.test(p));
}

// The write-up of a round folder: <study>.md, or the write-up whose section links to <study>/ (later sessions such as
// 2026-10-16-gate-3 are written up as a section of 2026-10-16-gate.md). Model and effort come from that section first.
let writeUps;
function writeUpFacts(study) {
  writeUps ??= readdirSync(BENCH).filter(name => name.endsWith('.md')).sort().map(name => ({ name, lines: readFileSync(join(BENCH, name), 'utf8').split('\n') }));
  const own = writeUps.find(w => w.name === `${study}.md`);
  const linking = own ? undefined : writeUps.find(w => w.lines.some(line => line.includes(`](${study}/)`)));
  const doc = own ?? linking;
  if (!doc) return { model: null, effort: null, writeUp: null, title: study };
  let section = doc.lines, title = /^# (.+)$/.exec(doc.lines.find(line => /^# /.test(line)) ?? '')?.[1] ?? study;
  if (linking) {
    const at = doc.lines.findIndex(line => line.includes(`](${study}/)`));
    let from = at;
    while (from > 0 && !/^#{1,3} /.test(doc.lines[from])) from -= 1;
    let to = at + 1;
    while (to < doc.lines.length && !/^#{1,3} /.test(doc.lines[to])) to += 1;
    section = doc.lines.slice(from, to);
    title = doc.lines[from].replace(/^#+ /, '');
  }
  const find = text => ({
    model: /\b(claude-(?:haiku|opus|sonnet)-\d+-\d+)\b/.exec(text)?.[1] ?? (/\bHaiku 5\.5\b/.test(text) ? 'claude-haiku-5-5' : /\bOpus 5\.5\b/.test(text) ? 'claude-opus-5-5' : null),
    effort: /\bat (high|medium|low) effort\b/.exec(text)?.[1] ?? /--effort (high|medium|low)/.exec(text)?.[1] ?? null,
  });
  const near = find(section.join('\n')), whole = find(doc.lines.join('\n'));
  return { model: near.model ?? whole.model, effort: near.effort ?? whole.effort, writeUp: doc.name, title: scrub(title) };
}

export function collectRunnerStudies() {
  const studies = [];
  for (const study of readdirSync(BENCH).sort().filter(name => /^2026-\d\d-\d\d-/.test(name) && isDir(join(BENCH, name)))) {
    const files = [];
    const walk = (dir, round) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        if (isDir(path)) walk(path, /^round-(\d+)$/.exec(name)?.[1] ?? round);
        else if (name.endsWith('.md')) files.push({ path, name, round });
      }
    };
    walk(join(BENCH, study), null);
    const runs = [];
    for (const file of files) {
      const text = readFileSync(file.path, 'utf8');
      if (!RUNNER_HEAD.test(text.split('\n').find(line => RUNNER_HEAD.test(line)) ?? '')) continue;
      const { rows, problems } = parseRunnerReport(text);
      const { variant, session, order } = variantOf(file.name.replace(/\.md$/, ''));
      const roundId = file.round ? `round ${file.round}` : session ?? '1';
      for (const row of rows) {
        if (row.seconds === null) continue;
        const own = problems[row.task] ?? [];
        runs.push({ task: row.task, arm: variant, round: roundId, order, run: null, seconds: row.seconds, passed: ownerPass(row, own), runnerOk: row.ok,
          browser: row.browser, calls: row.calls, errors: row.errors, problem: own.length ? scrub(own.join('; ')).slice(0, 200) : row.ok ? null : scrub(row.outcome).slice(0, 120),
          file: relative(BENCH, file.path) });
      }
    }
    if (!runs.length) continue;
    const facts = writeUpFacts(study);
    const arms = sortedUniq(runs.map(run => run.arm));
    const me = arms.find(arm => /^(sleight-turbo|sleight|baseline|default)$/.test(arm)) ?? arms.find(arm => arm.startsWith('sleight')) ?? arms[0];
    const orderedArms = [me, ...arms.filter(arm => arm !== me)];
    const tasks = sortedUniq(runs.map(run => run.task));
    const { cells, verdict, table } = cellsFor(runs, tasks, orderedArms, me);
    const rounds = [];
    for (const roundId of sortedUniq(runs.map(run => run.round))) for (const arm of orderedArms) {
      const list = runs.filter(run => run.round === roundId && run.arm === arm);
      if (!list.length) continue;
      rounds.push({ round: roundId, arm, runs: list.length, passed: list.filter(r => r.passed).length, runnerOk: list.filter(r => r.runnerOk).length,
        seconds: list.reduce((sum, r) => sum + r.seconds, 0), calls: list.reduce((sum, r) => sum + (r.calls ?? 0), 0), errors: list.reduce((sum, r) => sum + r.errors, 0) });
    }
    studies.push({
      id: study, family: /-ab(-|$)/.test(study) ? 'ab-tests' : 'browser-turbo', title: facts.title, date: study.slice(0, 10), browser: sortedUniq(runs.map(r => r.browser)).join(', '),
      me, arms: orderedArms, tasks, models: facts.model ? Object.fromEntries(orderedArms.map(arm => [arm, [facts.model]])) : {},
      modelSource: facts.model ? 'write-up' : null, effort: facts.effort ? [facts.effort] : [], writeUp: facts.writeUp,
      runs, cells, rounds, verdict: summarizeVerdict(table, verdict, tasks, orderedArms, me),
    });
  }
  return studies;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: A/B studies saved as JSON in docs/benchmarks ({ study, rounds: [{ arm, results }] } or { study, sides: [{ side, results }] }).

// The study's first sentence, shortened at a clause when needed. Older collected titles were cut at 160 characters.
const abTitle = (text, file) => {
  const first = text.split(/(?<=[.:;])\s/)[0];
  const title = (first.length >= 25 ? first : text) || file.replace(/\.json$/, '');
  if (title.length < 160) return title;
  const prefix = title.slice(0, 160);
  const end = prefix.lastIndexOf(', ');
  return prefix.slice(0, end > 0 ? end : prefix.lastIndexOf(' ')) + '…';
};

export function collectJsonAbs() {
  const studies = [];
  for (const name of readdirSync(BENCH).sort().filter(file => file.endsWith('.json'))) {
    const raw = tryJson(join(BENCH, name));
    const parts = Array.isArray(raw?.rounds) ? raw.rounds.map(r => ({ variant: r.arm ?? r.side, round: r.round, results: r.results, model: r.model, effort: r.effort }))
      : Array.isArray(raw?.sides) ? raw.sides.map(s => ({ variant: s.side ?? s.arm, round: s.round, results: s.results, model: s.model, effort: s.effort })) : null;
    if (!parts || !parts.every(part => Array.isArray(part.results) && part.variant)) continue;
    const runs = parts.flatMap(part => part.results.filter(row => Number.isFinite(row.seconds)).map(row => ({
      task: row.task, arm: part.variant, round: `round ${part.round ?? 1}`, run: row.run ?? null, seconds: row.seconds, passed: row.passed === true,
      turns: row.turns ?? null, problem: row.passed ? null : scrub(row.reason ?? 'failed').slice(0, 200), models: row.models ?? [], file: name })));
    if (!runs.length) continue;
    const arms = uniq(parts.map(part => part.variant));
    const me = arms[0];
    const tasks = sortedUniq(runs.map(run => run.task));
    const { cells, verdict, table } = cellsFor(runs, tasks, arms, me);
    const models = {};
    for (const run of runs) models[run.arm] = sortedUniq([...(models[run.arm] ?? []), ...run.models]);
    const effort = sortedUniq([...parts.map(p => p.effort), /\b(high|medium|low)\b/.exec(raw.model ?? '')?.[1]]);
    studies.push({
      id: name.replace(/\.json$/, ''), family: 'ab-tests', title: abTitle(scrub(raw.study ?? ''), name), date: raw.date ?? name.slice(0, 10),
      browser: null, me, arms, tasks, models, effort, commit: raw.commit ?? null, json: name,
      writeUp: existsSync(join(BENCH, name.replace(/\.json$/, '.md'))) ? name.replace(/\.json$/, '.md') : mentionedIn(name),
      runs: runs.map(({ models: _m, ...run }) => run), cells, verdict: summarizeVerdict(table, verdict, tasks, arms, me),
    });
  }
  return studies;
}

// The first write-up that names a data file, for studies whose write-up has another name.
function mentionedIn(file) {
  for (const name of readdirSync(BENCH).filter(n => n.endsWith('.md')).sort()) if (readFileSync(join(BENCH, name), 'utf8').includes(file)) return name;
  return readFileSync(join(ROOT, 'docs/benchmark.md'), 'utf8').includes(file) ? '../benchmark.md' : null;
}

// Every write-up in docs/benchmarks, for the catalog of measurements that have no structured data on the hub.
export function writeUpCatalog() {
  return readdirSync(BENCH).sort().filter(name => name.endsWith('.md')).map(name => {
    const text = readFileSync(join(BENCH, name), 'utf8');
    return { file: name, date: /^\d{4}-\d\d-\d\d/.exec(name)?.[0] ?? null, title: scrub(/^# (.+)$/m.exec(text)?.[1] ?? name.replace(/\.md$/, '')) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: release passes and the earlier native head-to-heads (bench/results-page.mjs).

export const RELEASE_RIVALS = ['2026-10-10-h2h-5.json', '2026-10-03-sleight-vs-lcu.json'];

export function collectReleases({ timeline = loadTimeline(), bench = BENCH } = {}) {
  const standard = [];
  for (const name of (isDir(bench) ? readdirSync(bench) : []).sort().filter(file => file.endsWith('.json'))) {
    const raw = tryJson(join(bench, name));
    if (!raw) continue;
    const passes = Array.isArray(raw.passes) ? raw.passes : undefined;
    const last = passes ? passes.at(-1) : raw;
    if (!Array.isArray(last?.results) || !last.results.length || !last.results.every(row => row.arm && row.task)) continue;
    const writeUp = existsSync(join(bench, name.replace(/\.json$/, '.md'))) ? name.replace(/\.json$/, '.md') : undefined;
    // A file's mtime here is the checkout's, so an older pass is placed from its stamp and its runs' seconds.
    standard.push({ ...loadResults(name, raw, writeUp), engines: summarizeEngines(last.results.map(row => ({ arm: row.arm, engine: passRowEngine(raw.stamp ? raw : last, row, { file: name, timeline }) }))) });
  }
  const toRow = file => {
    const arms = Object.values(perArm(file.results)).map(stats => ({ arm: stats.arm, runs: stats.runs, passed: stats.passed, seconds: stats.seconds, turns: stats.turns, models: stats.models }));
    return { name: file.name, date: file.date, kind: file.kind, version: file.version ?? null, model: file.model ?? null, effort: file.effort ?? null, suite: file.suite ?? null,
      passes: file.passes, writeUp: file.writeUp ? basename(file.writeUp) : null, arms,
      engines: Object.fromEntries(arms.map(a => [a.arm, engineText(file.engines[a.arm], a.arm)])) };
  };
  const releaseNames = standard.filter(file => file.kind === 'release' || RELEASE_RIVALS.includes(file.name)).map(file => file.name);
  const runs = standard.filter(file => releaseNames.includes(file.name)).flatMap(file => file.results.map(row => ({
    task: row.task, arm: row.arm, run: row.run ?? null, round: null, seconds: row.seconds ?? null, passed: row.passed === true, turns: row.turns ?? null,
    problem: row.passed ? null : scrub(row.reason ?? (row.cancelled ? 'cancelled' : 'failed')).slice(0, 200), file: file.name })));
  return { family: 'release-passes', title: 'Release passes and the earlier head-to-heads', releaseInputs: releaseNames, files: standard.map(toRow), runs };
}

// Compare recorded content, not checkout mtimes. A corrected pass under the same filename must also reach the hub.
export function releaseFreshness(data, options = {}) {
  const fresh = collectReleases(options);
  const releases = fresh.files.filter(file => file.kind === 'release').sort((a, b) =>
    (a.date + a.name).localeCompare(b.date + b.name, 'en'));
  if (!releases.length) return { skipped: 'no raw release-pass results in the collector source folder' };
  const newest = releases.at(-1).name;
  for (const file of releases) {
    const saved = data.files.find(row => row.name === file.name);
    const runs = rows => rows.filter(row => row.file === file.name);
    if (!data.releaseInputs.includes(file.name) || JSON.stringify(saved) !== JSON.stringify(file) ||
        JSON.stringify(runs(data.runs)) !== JSON.stringify(runs(fresh.runs))) return { newest, stale: file.name };
  }
  return { newest, stale: null };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: validation and re-measure banks. A bank is one runner's output folder. bench/validation/validation-140.mjs writes
// plan.json, a receipt per round and score.json (score-2.json after a second scoring); bench/validation/remeasure.mjs writes
// plan.json and comparison.json. Both compare two sleight builds on the same tasks, build A against build B, so they get a family
// and a page of their own and never enter a claim table. Strings copied from a bank are scrubbed like every other family's.

const SCORE_FILE = /^score(?:-(\d+))?\.json$/;
const subdirs = dir => {
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => join(dir, e.name)).sort(); }
  catch { return []; }
};
const shaOf = value => (/^[a-f0-9]{7,64}$/.test(value ?? '') ? value.slice(0, 8) : scrub(value ?? '').slice(0, 40) || null);

// The newest score file in a validation bank: score.json, then score-2.json and up.
function latestScore(dir) {
  let best;
  for (const name of readdirSync(dir)) {
    const match = SCORE_FILE.exec(name);
    if (match && (!best || Number(match[1] ?? 1) > best.n)) best = { name, n: Number(match[1] ?? 1) };
  }
  return best?.name;
}

// First and last timestamp of a runner's log, whose lines start with an ISO time.
function logSpan(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const stamps = [...text.matchAll(/^(\d{4}-\d\d-\d\dT\d\d:\d\d)/gm)].map(match => match[1]);
  return stamps.length ? dateRange(stamps[0], stamps.at(-1)) : null;
}

// Where a bank was read: under the home folder it shows as ~/..., and anywhere else only the folder's name shows.
const bankSource = dir => (resolve(dir).startsWith(homedir() + '/') ? tilde(dir) : scrub(basename(dir)));

// A folder is a bank when its plan.json has the shape one of the two runners writes. `result` is null while it has no score or
// comparison file yet (an aborted attempt, or a run in progress).
export function readBank(dir) {
  const release = tryJson(join(dir, 'final-verdict.json')), schedule = tryJson(join(dir, 'schedule.json'));
  if (release?.identity?.builds && Array.isArray(release.verdicts) && Array.isArray(schedule)) {
    return { id: scrub(basename(dir)), dir, kind: 'validation', format: 'release150', file: 'final-verdict.json', result: release, schedule };
  }
  const plan = tryJson(join(dir, 'plan.json'));
  if (!plan || typeof plan !== 'object') return null;
  const id = scrub(basename(dir));
  if (plan.kind === 'final-build-remeasure' && Array.isArray(plan.groups)) {
    const comparison = tryJson(join(dir, 'comparison.json'));
    return { id, dir, kind: 'remeasure', plan, file: comparison ? 'comparison.json' : null, result: comparison ?? null };
  }
  if (plan.schema === 1 && Array.isArray(plan.groups) && Array.isArray(plan.rounds) && plan.aBuild && plan.bBuild) {
    const file = latestScore(dir), result = file ? tryJson(join(dir, file)) : null;
    return { id, dir, kind: 'validation', plan, file: result ? file : null, result: result?.groups ? result : null };
  }
  return null;
}

// Banks sit directly under the worktrees folder or one folder down (race-1017/validation-140-final).
// `extra` names bank folders anywhere else, such as the --out a runner was given.
export function findBanks(wt, extra = []) {
  const banks = [], seen = new Set();
  for (const dir of [...extra.map(dir => resolve(dir)), ...subdirs(wt).flatMap(first => [first, ...subdirs(first)])]) {
    const bank = readBank(dir);
    if (bank && !seen.has(bank.id)) { seen.add(bank.id); banks.push(bank); }
  }
  return banks.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// A score table cell keeps the run times and the passing ones. A failed run is a time in `runs` with no match in `passes`.
export function rowsFromCell(cell, task, arm, file) {
  const left = [...(cell.passes ?? [])];
  return (cell.runs ?? []).filter(Number.isFinite).map(seconds => {
    const at = left.indexOf(seconds), passed = at >= 0;
    if (passed) left.splice(at, 1);
    return { task, arm, run: null, round: null, seconds: round1(seconds), passed, problem: passed ? null : 'failed (the score file keeps no reason)', file };
  });
}

export const BUILD_A = 'build-A', BUILD_B = 'build-B';

function collectReleaseBank(bank) {
  const release = bank.result, arms = [BUILD_B, BUILD_A], builds = release.identity.builds;
  const engine = (release.engines ?? []).map(e => `${e.version}${e.build ? ` build ${e.build}` : ''}`).join(', ');
  const date = dateRange(release.identity.startedAt, release.at), studies = [];
  for (const verdict of release.verdicts) {
    const runs = [], models = { [BUILD_A]: [], [BUILD_B]: [] }, roundIds = { [BUILD_A]: [], [BUILD_B]: [] }, effort = [];
    const tasks = verdict.tasks.map(row => row.task);
    for (const step of bank.schedule.filter(s => s.kind === verdict.kind)) {
      const receipt = tryJson(join(bank.dir, `${step.id}.receipt.json`));
      const expectedTasks = step.tasks.split(',').filter(task => tasks.includes(task));
      if (!expectedTasks.length) continue;
      if (!receipt || receipt.outcome === 'excluded') throw Error(`${bank.id}/${step.id}: missing scheduled receipt`);
      if (receipt.rc !== 0) throw Error(`${bank.id}/${step.id}: no completed receipt`);
      if (receipt.id !== step.id || receipt.kind !== step.kind || receipt.side !== step.side || receipt.build && receipt.build !== builds[step.side]) throw Error(`${bank.id}/${step.id}: receipt identity mismatch`);
      const arm = step.side === 'A' ? BUILD_A : BUILD_B;
      // The receipt's absolute root can be from another Mac. Only its result basename is used under this bank.
      const path = join(bank.dir, basename(receipt.result));
      const browser = !['native-haiku', 'cc-haiku'].includes(step.kind);
      let rows;
      if (browser) {
        const round = loadRound(path);
        if (round.excluded) throw Error(`${bank.id}/${step.id}: ${round.excluded}`);
        rows = round.rows;
        models[arm].push(...roundFacts(path).models);
      } else {
        const raw = readJson(path);
        rows = raw.results.filter(row => row.arm === 'sleight').map(row => ({ ...row, passed: !!(row.passed || row.cleanupContained && row.taskPassed) }));
        models[arm].push(...rows.flatMap(row => row.models ?? (raw.model ? [raw.model] : [])));
      }
      if (expectedTasks.some(task => rows.filter(row => row.task === task).length !== 1)) throw Error(`${bank.id}/${step.id}: missing or duplicate scheduled task`);
      const flag = (receipt.command ?? []).indexOf('--effort');
      if (flag >= 0) effort.push(receipt.command[flag + 1]);
      roundIds[arm].push(step.id);
      for (const row of rows.filter(row => tasks.includes(row.task))) runs.push({
        task: row.task, arm, round: step.id, run: row.run ?? null, seconds: round1(row.seconds), passed: row.passed,
        problem: row.passed ? null : scrub(row.reason ?? row.problems?.join('; ') ?? 'failed').slice(0, 200), file: scrub(basename(path)),
      });
    }
    const { cells } = cellsFor(runs, tasks, arms, BUILD_B);
    if (runs.filter(r => r.arm === BUILD_A && r.passed).length !== verdict.passA || runs.filter(r => r.arm === BUILD_B && r.passed).length !== verdict.passB) throw Error(`${bank.id}/${verdict.kind}: task pass counts disagree with the frozen verdict`);
    const comparable = tasks.filter(task => arms.every(arm => cells.some(c => c.task === task && c.arm === arm && c.passes > 0)));
    if (comparable.length !== verdict.comparable) throw Error(`${bank.id}/${verdict.kind}: comparable tasks disagree with the frozen verdict`);
    for (const [arm, total] of [[BUILD_A, verdict.aTotal], [BUILD_B, verdict.bTotal]]) {
      const sum = comparable.reduce((n, task) => n + cells.find(c => c.task === task && c.arm === arm).median, 0);
      if (Number.isFinite(total) && Math.abs(sum - total) > .001 * Math.max(1, tasks.length)) throw Error(`${bank.id}/${verdict.kind}: passing median total disagrees with the frozen verdict`);
    }
    studies.push({ id: `${bank.id}-${verdict.kind}`, family: 'validation', bank: bank.id, kind: 'validation', group: verdict.kind,
      title: `${bankLabel(bank.id)}, ${groupLabel(verdict.kind)}`, date, engine, browser: verdict.kind.startsWith('chrome') ? 'chrome' : verdict.kind.includes('safari') ? 'safari' : verdict.kind.includes('firefox') ? 'firefox' : null,
      me: BUILD_B, arms, tasks, models: Object.fromEntries(arms.map(a => [a, sortedUniq(models[a])])), effort: sortedUniq(effort),
      builds: { [BUILD_A]: [shaOf(builds.A)], [BUILD_B]: [shaOf(builds.B)] }, roundIds, aRounds: roundIds[BUILD_A].length, runs, cells });
  }
  const frozen = { passed: release.pass, exitCode: release.exitCode, verdicts: release.verdicts, aborted: release.aborted ?? {},
    excluded: release.excluded ?? [], taskExclusions: (release.taskExclusions ?? []).map(e => ({ task: e.task, kinds: e.kinds, sides: e.sides, reason: scrub(e.reason).replace(/; fix FX1 in progress$/, '') })), errors: (release.errors ?? []).map(scrub) };
  return { record: { id: bank.id, kind: 'validation', source: bankSource(bank.dir), file: bank.file, complete: true, passed: release.pass,
    date, aBuild: shaOf(builds.A), bBuild: shaOf(builds.B), engine, groups: studies.length, incomplete: [], release: frozen }, studies };
}

function bankStudy(bank, group, tables, extra) {
  const { plan } = bank, arms = [BUILD_B, BUILD_A];
  const tasks = (group.tasks ?? []).filter(task => tables.A?.[task] || tables.B?.[task]);
  const runs = [];
  for (const task of tasks) {
    if (tables.A?.[task]) runs.push(...rowsFromCell(tables.A[task], task, BUILD_A, bank.file));
    if (tables.B?.[task]) runs.push(...rowsFromCell(tables.B[task], task, BUILD_B, bank.file));
  }
  // Only the cells are kept. cellsFor's claim wording, totals and loss rule are for claims against other tools, not a build against itself.
  const { cells } = cellsFor(runs, tasks, arms, BUILD_B);
  const model = group.model ? [scrub(group.model)] : [];
  return {
    id: `${bank.id}-${scrub(group.id)}`, family: 'validation', title: `${bank.id}, ${scrub(group.id)}`, bank: bank.id, kind: bank.kind, group: scrub(group.id),
    date: extra.date, browser: group.browser ? scrub(group.browser) : null, runner: group.runner ? scrub(group.runner) : null, me: BUILD_B, arms, tasks,
    models: model.length ? { [BUILD_A]: model, [BUILD_B]: model } : {}, effort: plan.effort ? [scrub(plan.effort)] : [],
    engine: plan.engine ? scrub(plan.engine) : null, builds: { [BUILD_A]: [shaOf(extra.aBuild)], [BUILD_B]: [shaOf(extra.bBuild)] },
    aRounds: extra.aRounds, runs, cells,
  };
}

export function collectBank(bank) {
  if (bank.format === 'release150') return collectReleaseBank(bank);
  const { plan, result } = bank, record = { id: bank.id, kind: bank.kind, source: bankSource(bank.dir), file: bank.file };
  const span = logSpan(join(bank.dir, bank.kind === 'remeasure' ? 'remeasure.log' : 'validate-140.log'));
  if (!result) return { record: { ...record, complete: false, engine: plan.engine ? scrub(plan.engine) : null, planned: plan.groups.length, pending: true }, studies: [] };
  const studies = [], incomplete = [];
  if (bank.kind === 'remeasure') {
    const aBuild = plan.aBuild, bBuild = result.build ?? plan.build;
    for (const group of result.groups ?? []) {
      const tables = { A: {}, B: {} };
      for (const row of group.tasks ?? []) { tables.A[row.task] = row.a; tables.B[row.task] = row.b; }
      studies.push(bankStudy(bank, { id: group.id, tasks: (group.tasks ?? []).map(row => row.task), model: plan.groups.find(g => g.id === group.id)?.model,
        browser: plan.groups.find(g => g.id === group.id)?.browser, runner: plan.groups.find(g => g.id === group.id)?.runner }, tables,
      { date: span, aBuild, bBuild, aRounds: (group.aRounds ?? []).length }));
    }
    return { record: { ...record, complete: result.complete === true, passed: result.passed === true, date: span, aBuild: shaOf(aBuild), bBuild: shaOf(bBuild),
      baselineBuild: shaOf(result.baselineBuild ?? plan.baselineBuild), engine: scrub(result.engine ?? plan.engine ?? ''), groups: studies.length, incomplete }, studies };
  }
  for (const group of result.groups) {
    const planned = plan.groups.find(g => g.id === group.id) ?? { id: group.id, tasks: Object.keys(group.table?.B ?? {}) };
    if (!group.complete) {
      incomplete.push({ group: scrub(group.id), deferred: group.deferred === true, why: scrub((group.errors ?? [])[0] ?? 'rounds missing').slice(0, 160) });
      continue;
    }
    studies.push(bankStudy(bank, planned, group.table ?? {}, { date: span, aBuild: plan.aBuild, bBuild: plan.bBuild, aRounds: (group.aRounds ?? []).length }));
  }
  return { record: { ...record, complete: result.complete === true, date: span, aBuild: shaOf(plan.aBuild), bBuild: shaOf(plan.bBuild), engine: scrub(plan.engine ?? ''),
    groups: studies.length, incomplete }, studies };
}

// Every bank under the worktrees folder. A bank already in `kept` (the data file in the repo) stays when its folder is gone from
// this Mac, and a collected bank replaces its kept entry.
export function collectValidation({ wt, kept, banks: extra = [] }) {
  const banks = findBanks(wt, extra).map(collectBank);
  const found = new Set(banks.map(bank => bank.record.id));
  const old = kept ? {
    records: (kept.banks ?? []).filter(record => !found.has(record.id)),
    studies: (kept.studies ?? []).filter(study => !found.has(study.bank)),
  } : { records: [], studies: [] };
  const records = [...banks.map(bank => bank.record), ...old.records].sort((a, b) => (a.id < b.id ? -1 : 1));
  const studies = [...banks.flatMap(bank => bank.studies), ...old.studies].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { family: 'validation', title: 'Validation and re-measure banks', banks: records, studies };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Rendering helpers.

const DASH = 'n/a';
const f1 = value => (value === null || value === undefined ? DASH : (Math.round(value * 10) / 10).toFixed(1));
const f0 = value => (value === null || value === undefined ? DASH : Math.round(value).toLocaleString('en-US'));
const mdCell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim();
export const mdTable = (head, rows) => ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |', ...rows.map(row => '| ' + row.map(mdCell).join(' | ') + ' |')].join('\n');
const list = items => items.map(item => `- ${item}`).join('\n');
const joinAnd = items => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const ARM_NAMES = { sleight: 'sleight', 'sleight-turbo': 'sleight turbo', lcu: 'LCU', codex: 'Codex', cua: 'Cua', peekaboo: 'Peekaboo', 'claude-cu': 'Claude computer use',
  fowlbrowser: 'FowlBrowser', 'claude-in-chrome': 'Claude in Chrome', 'codex-sleight': 'sleight inside Codex', 'codex-sleight-sol': 'sleight inside Codex (Sol)',
  'codex-sol': 'Codex (Sol)', 'build-A': 'build A (earlier)', 'build-B': 'build B (new)' };
const armName = arm => ARM_NAMES[arm] ?? arm;
// Apply to prose and labels before Markdown rendering, so recorded paths and command flags keep their names.
export const publicVoice = text => String(text).replace(/\bowner\b/gi, word => word === 'Owner' ? 'Tester' : 'tester');

// One cell per arm and task: expected seconds, then passes/runs.
export const cellText = cell => (!cell ? 'no runs' : cell.passes === 0 ? `no pass (0/${cell.runs})` : `${f1(cell.expected)} (${cell.passes}/${cell.runs})`);
// Task names, file names and recorded reasons are data, so the pages show them as code.
const code = value => '`' + String(value ?? '').replace(/`/g, "'") + '`';

export function taskMatrix(study) {
  const head = ['Task', ...study.arms.map(armName)];
  const rows = study.tasks.map(task => [code(task), ...study.arms.map(arm => cellText(study.cells.find(c => c.task === task && c.arm === arm)))]);
  rows.push(['Lowest expected time on', ...study.arms.map(arm => `${study.verdict.fastest[arm]?.length ?? 0} of ${study.tasks.length}`)]);
  rows.push(['Total expected s', ...study.arms.map(arm => (study.verdict.totals[arm] == null ? 'no total (a task has no pass)' : f1(study.verdict.totals[arm])))]);
  return mdTable(head, rows);
}

function spreadTable(study) {
  const head = ['Task', ...study.arms.map(armName)];
  const rows = study.tasks.map(task => [code(task), ...study.arms.map(arm => {
    const cell = study.cells.find(c => c.task === task && c.arm === arm);
    if (!cell) return 'no runs';
    if (!cell.passes) return 'no passes';
    return `${f1(cell.median)} [${f1(cell.min)} to ${f1(cell.max)}]${cell.p90 != null ? `, p90 ${f1(cell.p90)}` : ''}`;
  })]);
  return mdTable(head, rows);
}

// Per arm: the model ids its runs recorded, effort, the versions the files name and, for data collected since engine versions were
// tracked (2026-10-19), the ChatGPT engine versions with their UTC dates. Older data files render as before.
function armTable(study, { builds = false, scriptEffort = null } = {}) {
  const engines = !!study.engines;
  const head = ['Arm', 'Model ids in the runs', 'Effort', 'Versions recorded', ...(engines ? ['ChatGPT engine and UTC dates'] : []), ...(builds ? ['Build'] : [])];
  const recorded = arm => (Array.isArray(study.effort) ? study.effort : study.effort?.[arm] ?? []);
  const effortOf = arm => (recorded(arm).length ? recorded(arm) : scriptEffort ? [scriptEffort] : []);
  const table = mdTable(head, [...study.arms, ...(study.hosted ?? [])].map(arm => [armName(arm), study.models?.[arm]?.length ? study.models[arm].map(code).join(', ') : 'not recorded',
    effortOf(arm).join(', ') || 'not recorded', study.versions?.[arm]?.join(', ') || 'not recorded',
    ...(engines ? [engineText(study.engines[arm], arm)] : []),
    ...(builds ? [study.builds?.[arm]?.map(code).join(', ') || 'not recorded'] : [])]));
  return engines ? `${table}\n\n${engineNote(study.engines, study.engineMix)} ${ENGINE_NOTE}` : table;
}
const ENGINE_NOTE = 'A version is "recorded" when the runner read it and "inferred" from the timeline in `bench/engine-versions.json` otherwise, and ' +
  'a date is inferred when it comes from a file\'s stamp or modification time. LCU, Cua, Peekaboo, FowlBrowser, Claude in Chrome and Claude\'s computer use don\'t use the engine.';

function lostTable(study) {
  if (!study.verdict.lost.length) return `By the loss rule, ${armName(study.me)} didn't lose a task.`;
  const how = b => (b.lowerExpected && b.fasterRun ? 'lower expected time and a faster passing run' : b.lowerExpected ? 'lower expected time' : 'faster passing run');
  return `By the loss rule, ${armName(study.me)} lost ${study.verdict.lost.length} of ${study.tasks.length} tasks.\n\n` +
    mdTable(['Task', 'Arm ahead', 'How'], study.verdict.lost.flatMap(l => l.by.map(b => [code(l.task), armName(b.arm), how(b)])));
}

function topUpTable(study) {
  if (!study.verdict.topUps.length) return `No pair within 20% of ${armName(study.me)} is short of 5 runs.`;
  return `Pairs within 20% of ${armName(study.me)} that still need 5 runs:\n\n` +
    mdTable(['Task', 'Arm', 'Runs so far'], study.verdict.topUps.map(t => [code(t.task), armName(t.arm), t.short.join(', ')]));
}

const writeUpLink = name => (name.startsWith('../') ? name : `../benchmarks/${name}`);
const failureRows = study => study.runs.filter(run => !run.passed).map(run => [code(run.task), armName(run.arm), code(run.round ?? run.file), f1(run.seconds), run.problem ? code(run.problem) : DASH]);

const SCORING = 'Expected time is the mean seconds per attempt divided by the pass rate (`bench/claim-score.mjs`). A failed run adds its time ' +
  'to the mean and lowers the rate. A task an arm never passed has no expected time, and that arm then has no total. Median and range ' +
  'are over passing runs, and p90 (nearest rank) appears only at 5 or more runs.';
const LAWS_RULES = 'The rules come from [LAWS](../status/LAWS.md). Each arm gets 3 runs per task, or 5 where sleight and another arm are within 20% ' +
  '(the difference over the slower expected time). "Fastest" needs the lowest expected time on a majority of tasks and the lowest total, ' +
  'with those 5 runs in place. Otherwise the wording is "completed every task, fastest on N". A task counts as lost when another arm ' +
  'has the lower expected time or a faster passing run.';

// ---------------------------------------------------------------------------------------------------------------------------
// Navigation, folds and footers shared by every generated page.

// The interactive page and the chart images on GitHub Pages (deployed from main, folder /docs), and the Markdown pages on github.com.
export const PAGES_URL = 'https://land-o-clusters.github.io/sleight/results/';
export const REPO_RESULTS = 'https://github.com/Land-o-Clusters/sleight/blob/main/docs/results/';
export const NAV = [
  { page: 'native-claim.md', label: 'Native' }, { page: 'app-claim.md', label: 'Apps' }, { page: 'browser-turbo.md', label: 'Chrome and Helium' },
  { page: 'browser-race.md', label: 'Safari and Firefox' }, { page: 'ab-tests.md', label: 'Experiments' }, { page: 'validation.md', label: 'Validation' }, { page: 'release-passes.md', label: 'Releases' },
  { page: 'insights.md', label: 'Insights' }, { page: 'explore.html', label: 'Interactive', href: `${PAGES_URL}explore.html` },
];

// The line each generated page starts and ends with. The current page is plain text; 'README.md' is the hub landing.
export function renderNav(current) {
  const item = ({ page, label, href }) => (page === current ? label : `[${label}](${href ?? page})`);
  return [current === 'README.md' ? 'Benchmarks' : '[Benchmarks](README.md)', ...NAV.map(item)].join(' · ');
}

// The same line as HTML for the pages Pages serves, where the Markdown pages link to github.com.
const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function renderNavHtml(current) {
  const link = (href, label) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  const item = ({ page, label, href }) => (page === current ? `<span aria-current="page">${escapeHtml(label)}</span>` : link(href ?? REPO_RESULTS + page, label));
  return `<nav class="pages" aria-label="Benchmark pages">${[link(REPO_RESULTS.replace('/blob/', '/tree/'), 'Benchmarks'), ...NAV.map(item)].join(' · ')}</nav>`;
}

const details = (summary, body) => `<details><summary>${escapeHtml(summary)}</summary>\n\n${body.trim()}\n\n</details>\n`;

// A chart picture block from bench/results-charts.mjs, or nothing while that module is missing.
const chartFor = (all, id) => { const block = charts.chartBlock(id, all, { base: '', directory: id.startsWith('family-') ? 'charts' : 'img' }); return block ? block.trim() + '\n' : null; };

// Data collected before 2026-10-19 carries no engine versions, and the footer says so until a collect adds them.
const hasEngines = studies => studies.some(study => study?.engines && Object.keys(study.engines).length);
const engineFooter = studies => (hasEngines(studies)
  ? 'Each arm table lists the ChatGPT engine versions its runs used, with their UTC dates.'
  : 'The ChatGPT engine version is missing from this data, which was collected before the results recorded it (2026-10-19).');

function pageFooter(current, { data, dataText = 'has every counted run and the scored cells', studies = [] }) {
  const parts = [];
  if (data) parts.push(`[data/${data}.json](data/${data}.json) ${dataText}, and the [interactive page](${PAGES_URL}explore.html) charts them.`);
  parts.push(engineFooter(studies), 'Rebuild every page with `node bench/results-hub.mjs`.');
  return `${parts.join(' ')}\n\n${renderNav(current)}\n`;
}
const pageHead = (current, title) => `${renderNav(current)}\n\n# ${title}\n`;

// ---------------------------------------------------------------------------------------------------------------------------
// Family pages.

// Verdict first, then the chart and the task matrix (the evidence), then the method and the detail tables folded.
function renderClaimPage(all, id, { intro }) {
  const data = all[id], study = data.studies[0], fam = family(id);
  const out = [pageHead(fam.page, fam.title)];
  out.push(`${intro} sleight has the lowest expected time on ${study.verdict.lowest.length} of ${study.tasks.length} tasks.\n`);
  const chart = chartFor(all, `family-${id}`);
  if (chart) out.push(chart);
  out.push('Each cell is expected seconds, then passes/runs.\n');
  out.push(taskMatrix(study) + '\n');
  out.push(lostTable(study) + '\n');
  if (study.verdict.reasons.length) out.push('Why the wording isn\'t "fastest":\n\n' + list(study.verdict.reasons.map(r => code(r))) + '\n');
  out.push(topUpTable(study) + '\n');
  out.push(details('Method and arm versions', [
    list([
      `${study.runs.length} runs counted, from ${data.source.files.length} results files dated ${study.date}, on the tester's account login (auth ${code(study.auth.join(', ') || 'not recorded')}).`,
      SCORING,
      LAWS_RULES,
      `Rows come from ${code(data.source.results)} with the exclusions in ${code(data.source.rules)}. Scoring starts at file stamp ${code(data.source.since)}` +
        (data.source.sinceNote ? `, and the reason given is ${code(data.source.sinceNote.replace(/[.\s]*$/, ''))}.` : '.'),
      'The results files don\'t record sleight\'s commit or the Codex CLI version.',
    ]),
    armTable(study),
  ].join('\n\n')));
  out.push(details('Rows left out and scorer warnings', [
    study.excluded.length ? 'Rows left out, with the reasons from the exclusions file:\n\n' + mdTable(['Reason', 'Rows'], study.excluded.map(e => [e.why, e.count])) : 'No rows were left out.',
    study.warnings.length ? 'The scorer warned:\n\n' + list(study.warnings.map(code)) : 'The scorer gave no warnings.',
  ].join('\n\n')));
  out.push(details('Spread of passing runs', 'Passing runs, median [fastest to slowest], with p90 at 5 or more runs:\n\n' + spreadTable(study)));
  const failures = failureRows(study);
  out.push(details(`Failed runs (${failures.length})`, failures.length ? mdTable(['Task', 'Arm', 'File', 's', 'Reason'], failures) : 'None.'));
  if (id === 'native-claim') out.push(details('Claim context and earlier comparisons', nativeClaimContext(all)));
  out.push(pageFooter(fam.page, { data: id, studies: [study] }));
  return out.join('\n');
}

// Data collected before the hub recorded answer patterns (2026-10-19) has no graders field and renders as before.
function gradersNote(study) {
  if (study.regrade) return 'Whole-thread answers use the offline regrade described above. Job fixtures retain their saved grades, including both job-motion failures.';
  const g = study.graders;
  if (!g) return null;
  if (!g.differ.length) return `Answers were checked with the patterns saved with each run, the same as the current ${code(g.file)}.`;
  const head = `Answers were checked with the patterns saved with each run. The current ${code(g.file)} has different patterns for ` +
    joinAnd(g.differ.map(d => `${code(d.task)} (${d.runs} runs here, ${d.moved} of them change verdict under the new patterns)`)) +
    '.';
  if (!g.differ.some(d => d.moved)) return `${head} The numbers match under both.`;
  return head + ' The same study scored with the current patterns (`bench/fowl/race-score.mjs --current-graders`) is beside the published numbers below.\n\n' + mdTable(['Arm', 'Passes, saved patterns', 'Passes, current patterns', 'Lowest expected time on, saved', 'Lowest expected time on, current',
    'Total expected s, saved', 'Total expected s, current'], study.arms.map(arm => {
    const a = g.saved[arm], b = g.current[arm];
    return [armName(arm), `${a.passes}/${a.runs}`, `${b.passes}/${b.runs}`, `${a.fastest} of ${study.tasks.length}`, `${b.fastest} of ${study.tasks.length}`,
      a.total == null ? 'no total (a task has no pass)' : f1(a.total), b.total == null ? 'no total (a task has no pass)' : f1(b.total)];
  }));
}

// One sleight build set: the verdict line, the chart (newest sets only), the matrix and the loss rule, then the arm table and
// the spread folded.
function raceStudySection(all, study, level, chartId) {
  const out = [`${level} ${study.title}${study.latest ? ' (newest)' : ''}\n`];
  out.push(`${study.date}, ${cap(study.browser)} ${study.browserVersion.join(', ')}, ${study.rounds.length} rounds and ${study.runs.length} runs. ${armName(study.me)} has the lowest expected time on ${study.verdict.fastest[study.me].length} of ${study.tasks.length} tasks.\n`);
  const summary = study.latest && study.family === 'browser-race';
  if (summary) out.push(`${raceResult(study)}.\n`);
  if (unopposedTotal(study)) out.push(`${summary ? 'The competitors each have' : 'sleight is the only arm with a total: every competitor has'} a task with no pass. There is no competing complete-suite time.\n`);
  if (study.notes) out.push(...study.notes.map(note => note + '\n'));
  if (study.competitorBuilds?.length) out.push(`FowlBrowser build ${study.competitorBuilds.map(code).join(', ')}. sleight's recorded harness build: ${(study.harnessBuilds?.[study.me] ?? []).map(code).join(', ')}.\n`);
  const chart = study.latest && chartId && (!study.rematch || study.model === 'haiku' && study.suite === 'core') ? chartFor(all, chartId) : null;
  if (chart) out.push(chart);
  out.push('Each cell is expected seconds, then passes/runs.\n');
  out.push(taskMatrix(study) + '\n');
  const graders = gradersNote(study);
  if (graders) out.push(graders + '\n');
  out.push(lostTable(study) + '\n');
  out.push(topUpTable(study) + '\n');
  for (const pair of study.sameModel ?? []) out.push(sameModelSection(study, pair, level + '#'));
  out.push(details('Arm versions and builds', 'The build column is sleight\'s commit for its own rounds and the harness commit for the other arms.\n\n' +
    armTable(study, { builds: true, scriptEffort: 'high (the script\'s flag)' })));
  const failures = failureRows(study);
  out.push(details(`Spread of passing runs and the ${failures.length} failed run${failures.length === 1 ? '' : 's'}`, [spreadTable(study), ...(failures.length ? [mdTable(['Task', 'Arm', 'Round', 's', 'Problems'], failures)] : [])].join('\n\n')));
  return out.join('\n');
}

// ROADMAP 4b: sleight inside Codex against Codex's own computer use on the same model, scored like sleight against its rivals.
function sameModelSection(study, pair, level) {
  const view = { ...study, me: pair.hosted, arms: [pair.hosted, pair.base], verdict: pair };
  const out = [`${level} Same model: ${armName(pair.hosted)} against ${armName(pair.base)}\n`];
  out.push(`${code(pair.hosted)} is sleight running inside Codex, and ${armName(pair.base)} is Codex with its own computer use, on the same model. ` +
    `This hosted sleight arm is excluded from sleight's main verdict and compared separately with ${armName(pair.base)} under the same rules. ` +
    `The scorer's wording for it is "${pair.wording}".\n`);
  if (pair.wording === 'no comparison') return out.concat(list(pair.reasons.map(code)) + '\n').join('\n');
  out.push(taskMatrix(view) + '\n');
  out.push(lostTable(view) + '\n');
  out.push(topUpTable(view) + '\n');
  return out.join('\n');
}

// Newest set per browser first and visible; every earlier set inside one fold.
const byBrowser = (studies, browsers) => browsers.flatMap(browser => studies.filter(s => s.browser === browser)
  .sort((a, b) => Number(b.latest) - Number(a.latest) || (a.label < b.label ? -1 : 1)));
function raceSets(all, studies, browsers, chartPrefix) {
  const ordered = byBrowser(studies, browsers);
  const newest = ordered.filter(s => s.latest).map(s => raceStudySection(all, s, '##', `${chartPrefix}-${s.browser}`));
  const earlier = ordered.filter(s => !s.latest).map(s => raceStudySection(all, s, '###'));
  return { newest, earlier: earlier.length ? details('Earlier sets', earlier.join('\n')) : null };
}

const RACE_GRADING = '`bench/fowl/race-score.mjs` grades every saved run again. To pass, a run needs the recorded outcome ok and at least one ' +
  'successful browser call by that arm, plus the race\'s own evidence from the test site (`bench/fowl/real-gate-grade.mjs`). Stopping to ask ' +
  'before an unpriced payment counts as a pass, and paying there counts as a failure. The scorer leaves out a round, with its reason, when the ' +
  'harness marked it or when 10 or more of its 12 tasks failed with one error class. Answers are checked with the patterns saved with each run. ' +
  'Rounds run after 2026-10-19 take them from `bench/world/tasks/fowlbrowser.json`, and earlier rounds saved FowlBrowser\'s own. Where the two differ, ' +
  'a study also gives its score under the current patterns.';
// Said only when the collect applied it (results-hub.mjs --exclude-covered).
const COVER_RULE = cover => cover?.applied ? ` This collect also left out ${cover.left} runs, ${cover.leftPasses} of them passes, that tried a drag while ` +
  'another app\'s window covered the browser\'s: every run whose drag tool refused for that window, and runs where a reading showed an app over ' +
  'half the window or more when no run of that arm and task passed under the same app. The failures table names the app.' : '';
const raceGrading = race => RACE_GRADING + COVER_RULE(race?.cover) +
  (race?.minRuns ? ` An arm's cell with fewer than ${race.minRuns} runs isn't counted for lowest expected time on its task.` : '');

const leftOutTables = race => [
  `Rounds come from ${code(race.source.race)}. Folders without ${code('results.json')} are still running and are left out${race.inProgress.length ? `: ${race.inProgress.map(code).join(', ')}` : ', and there were none'}.\n`,
  race.partial.length ? 'Sets left out because they don\'t yet have 3 runs of every task:\n\n' + mdTable(['Browser', 'Set', 'Runs so far', 'Rounds'], race.partial.map(p => [cap(p.browser), code(p.label), `${p.runs} of ${p.needed}`, p.rounds.map(code).join(', ')])) + '\n' : 'Every sleight set has 3 runs of every task.\n',
  race.excludedRounds.length ? 'Rounds left out, with the recorded reason:\n\n' + mdTable(['Round', 'Reason'], race.excludedRounds.map(e => [code(e.round), code(publicVoice(e.reason))])) + '\n' : 'No round was left out.\n',
].join('\n');

const RACE_SETS = 'The scorer takes one sleight build set at a time (the folder label, such as `sleight-r` or `sleight-b3-r`) with every usable competitor round in the same browser, so two sleight builds are never pooled. A set is scored once it has 3 runs of every task.';
const RACE_EFFORT = 'The race scripts pass `--effort high` to every Claude arm, and the Codex arm\'s rows record their own effort. Every Claude arm ran the pinned Claude Code on the tester\'s account login, each in its own config.';

function renderRacePage(all, id) {
  const data = all[id], fam = family(id);
  const out = [pageHead(fam.page, fam.title)];
  out.push('Turbo needs Chrome\'s debugging consent, which Safari and Firefox lack, so sleight uses the ChatGPT engine\'s computer use path in them. The race runs its 12 browser tasks on the local test site in a real window of each browser\'s "sleight benchmark" profile. [benchmark.md](../benchmark.md#scoring-the-real-window-race) describes the tasks.\n');
  const sets = raceSets(all, data.studies, data.source.browsers, 'family-browser-race');
  out.push(...sets.newest);
  out.push(details('Method, and the rounds and sets left out', [list([raceGrading(data), SCORING, LAWS_RULES, RACE_SETS, RACE_EFFORT]), leftOutTables(data)].join('\n\n')));
  if (sets.earlier) out.push(sets.earlier);
  out.push(pageFooter(fam.page, { data: id, studies: data.studies }));
  return out.join('\n');
}

function roundTable(study) {
  const ids = sortedUniq(study.rounds.map(r => r.round));
  const head = ['Round', ...study.arms.map(armName)];
  const rows = ids.map(id => [id, ...study.arms.map(arm => {
    const r = study.rounds.find(x => x.round === id && x.arm === arm);
    return r ? `${f0(r.seconds)} s, ${r.passed}/${r.runs} passed (${r.runnerOk} by the runner), ${r.calls} calls, ${r.errors} errors` : DASH;
  })]);
  const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  if (ids.length > 1) rows.push(['Median round s', ...study.arms.map(arm => f0(median(study.rounds.filter(r => r.arm === arm).map(r => r.seconds))))]);
  return mdTable(head, rows);
}

const GATE_RUNNER = 'FowlBrowser\'s head-to-head runner, pinned with sleight\'s patch, runs each arm in both browser orders (normal and swap), so a gate round is 26 runs per arm. Its reports give whole seconds. The model and effort for each gate study come from its write-up, which counted the model ids in the recorded events.';
const GATE_SCORING = 'A gate run passes under the published scoring rules (LAWS). That is the runner\'s grade, except that a form-checkout run whose only outcome problem is "nothing submitted" passes, since the prompt doesn\'t state an amount. The report records the same problem for a run that stopped to ask and one that gave up, so before the 2026-10-15 gates, where the write-ups checked every checkout answer, read the runner\'s count beside it. The tables show both counts. Rounds inside one study can be different builds, and the write-up names them.';

function renderTurboPage(all, id) {
  const data = all[id], fam = family(id);
  const out = [pageHead(fam.page, fam.title)];
  out.push('Turbo is sleight\'s own browser path for Chrome and Helium. The newest rematch runs FowlBrowser and turbo on 13 core browser tasks, with eight held-out tasks scored separately. Haiku and Opus have separate results. Earlier gate rounds, before production turbo, raced FowlBrowser on FowlBrowser\'s own 13-task runner.\n');
  const sets = raceSets(all, data.race.studies, data.race.source.browsers, 'family-browser-turbo');
  out.push(...sets.newest);
  out.push(details('Method, and the rounds and sets left out', [list([raceGrading(data.race), SCORING, LAWS_RULES, RACE_SETS, RACE_EFFORT]), leftOutTables(data.race)].join('\n\n')));
  if (sets.earlier) out.push(sets.earlier);
  const gates = [list([GATE_RUNNER, GATE_SCORING]) + '\n',
    mdTable(['Study', 'Date', 'Model', 'Effort', 'Arms', 'Rounds', 'Runs', 'Write-up'], data.gates.map(s => [code(s.id), s.date, s.models[s.me]?.[0] ? code(s.models[s.me][0]) : 'not stated', s.effort[0] ?? 'not stated',
      s.arms.map(armName).join(', '), sortedUniq(s.rounds.map(r => r.round)).length, s.runs.length, s.writeUp ? `[${basename(s.writeUp)}](${writeUpLink(s.writeUp)})` : DASH])) + '\n'];
  for (const study of data.gates.filter(s => data.headline.includes(s.id))) {
    gates.push(`### ${study.title}\n`);
    gates.push(`Study ${code(study.id)}, model ${study.models[study.me]?.[0] ? code(study.models[study.me][0]) : 'not stated'} at ${study.effort[0] ?? 'unstated'} effort, from [the write-up](${writeUpLink(study.writeUp)}). Round totals:\n`);
    gates.push(roundTable(study) + '\n');
    gates.push('Per task over all rounds, expected seconds, then passes/runs under the published scoring rules:\n');
    gates.push(taskMatrix(study) + '\n');
  }
  gates.push('### Round totals for every other gate study\n');
  for (const study of data.gates.filter(s => !data.headline.includes(s.id))) {
    gates.push(`#### ${study.id}\n`);
    gates.push(roundTable(study) + '\n');
  }
  out.push(details('Gate rounds on FowlBrowser\'s runner, before production turbo', gates.join('\n')));
  out.push(pageFooter(fam.page, { data: id, studies: [...data.race.studies, ...data.gates] }));
  return out.join('\n');
}

function renderAbPage(all, id) {
  const data = all[id], fam = family(id);
  const out = [pageHead(fam.page, fam.title)];
  out.push('Each study compares sleight variants on the same tasks using the claims\' expected-time scoring, with the first variant as the baseline.\n');
  out.push(details('Method', list([
    'Studies saved as JSON (`{ study, rounds }` or `{ study, sides }` in docs/benchmarks) are read run by run, and their model ids come from the runs. Studies saved as FowlBrowser-runner reports are parsed from their tables, and their model and effort come from the write-up.',
    SCORING,
    'Rounds alternate the variants, but load and model variation still move single rounds. Each write-up says what its study controlled, and the summary gives the runs per task.',
  ])));
  out.push('## Summary\n');
  const summaryRows = data.studies.map(study => {
    const counts = study.cells.map(c => c.runs);
    const totals = study.arms.map(arm => {
      const runs = study.runs.filter(run => run.arm === arm);
      return `${armName(arm)} ${runs.filter(r => r.passed).length}/${runs.length} passed, ${f0(runs.reduce((s, r) => s + r.seconds, 0))} s`;
    });
    const models = sortedUniq(Object.values(study.models).flat());
    return [study.date, code(study.id), models.map(code).join(', ') || 'not recorded', Math.min(...counts) === Math.max(...counts) ? String(counts[0]) : `${Math.min(...counts)} to ${Math.max(...counts)}`,
      totals.join('. '), study.writeUp ? `[${basename(study.writeUp)}](${writeUpLink(study.writeUp)})` : DASH];
  });
  out.push(mdTable(['Date', 'Study', 'Model', 'Runs per task', 'Variants: passed, total s', 'Write-up'], summaryRows) + '\n');
  out.push('Totals add every run, failures included, so a variant with more runs has a larger total. Per-task expected times account for the different run counts.\n');
  out.push('## Studies\n');
  for (const study of data.studies) {
    out.push(details(study.id, [
      `${code(publicVoice(abTitle(study.title, study.id)))}. The baseline is ${code(study.me)}.${study.commit ? ` Commit ${code(study.commit)}.` : ''}${study.writeUp ? ` Write-up: [${basename(study.writeUp)}](${writeUpLink(study.writeUp)}).` : ''}`,
      armTable(study),
      taskMatrix(study),
    ].join('\n\n')));
  }
  out.push('## Other measurements\n');
  out.push('These write-ups in [docs/benchmarks](../benchmarks/) have no tables on this hub, and each states its own method. The release passes and head-to-heads are on [release-passes.md](release-passes.md).\n');
  const covered = new Set([...data.studies.map(s => s.writeUp), ...data.coveredWriteUps]);
  out.push(mdTable(['Date', 'Write-up'], data.catalog.filter(item => !covered.has(item.file)).map(item => [item.date ?? DASH, `[${publicVoice(item.title)}](../benchmarks/${item.file})`])) + '\n');
  out.push(pageFooter(fam.page, { data: id, studies: data.studies }));
  return out.join('\n');
}

// Replaces one exact piece of bench/results-page.mjs's output, and stops the render when that piece is gone.
function swap(text, from, to) {
  if (!text.includes(from)) throw new Error(`release page: results-page.mjs no longer prints ${JSON.stringify(from.slice(0, 60))}`);
  return text.replace(from, () => to);
}

function releasePage(data) {
  return buildPage(data.releaseInputs.map(name => {
    const raw = readJson(join(BENCH, name));
    const writeUp = existsSync(join(BENCH, name.replace(/\.json$/, '.md'))) ? name.replace(/\.json$/, '.md') : undefined;
    return loadResults(name, raw, writeUp);
  }));
}

function renderReleasePage(all, id) {
  const data = all[id], fam = family(id);
  const page = releasePage(data);
  // explore.html charts these runs, so the page links it where results-page.mjs names its own chart page.
  let md = renderReleaseMarkdown(page, { title: fam.title, chart: 'explore.html', rebuild: 'node bench/results-hub.mjs' });
  md = swap(md, ' The same page with a chart is [explore.html](explore.html).', ` The [interactive page](${PAGES_URL}explore.html) charts every run.`);
  md = swap(md, ' The chart is in [explore.html](explore.html).', '');
  md = swap(md, `# ${fam.title}\n`, pageHead(fam.page, fam.title));
  const extra = ['## Every head-to-head and sleight-only pass\n',
    'Every results file in [docs/benchmarks](../benchmarks/) in the benchmark runner\'s format, with its totals per arm. Totals add every run, failures included.\n',
    mdTable(['File', 'Date', 'Kind', 'Model', 'Effort', 'Per arm: passed/runs, total s', ...(data.files.some(f => f.engines) ? ['ChatGPT engine and UTC dates'] : [])], data.files.map(file => [
      `[${file.name}](../benchmarks/${file.name})`, file.date, file.kind === 'h2h' ? 'head-to-head' : file.kind === 'release' ? `release ${file.version}` : 'sleight only',
      file.model ? code(file.model) : DASH, file.effort ?? DASH, file.arms.map(a => `${armName(a.arm)} ${a.passed}/${a.runs}, ${f0(a.seconds)} s`).join(', '),
      ...(data.files.some(f => f.engines) ? [file.arms.map(a => `${armName(a.arm)}: ${file.engines?.[a.arm] ?? 'not recorded'}`).join(' · ')] : [])])) + '\n'];
  md = swap(md, '\n## Run it yourself\n', '\n' + extra.join('\n') + '\n## Run it yourself\n');
  // The per-file method list folds like every other page's method.
  const caveats = /\n## Method and caveats\n\n([\s\S]*?)\n## Every head-to-head/.exec(md);
  if (!caveats) throw new Error('release page: no Method and caveats section');
  md = md.replace(caveats[0], () => `\n${details('Method and caveats', caveats[1])}\n## Every head-to-head`);
  const releases = data.files.filter(f => f.kind === 'release');
  const perTask = sortedUniq(data.runs.filter(r => releases.some(f => f.name === r.file)).map(r => r.run)).length;
  const method = details('Method', list([
    `Release passes run sleight alone on the benchmark's default suite (\`bench/run.mjs\`), up to ${perTask} runs per task. Every pass ran ${sortedUniq(releases.map(f => `${code(f.model)} at ${f.effort} effort`)).join(', ')}.`,
    'A run passes when the task\'s own checker confirms the result in the app, and a failure\'s reason is the checker\'s output.',
    'Each release file contributes its last pass. Where a file kept the passes made on the way to the release, Method and caveats says how many.',
    `The selected head-to-heads are ${joinAnd(RELEASE_RIVALS.map(n => `[${n}](../benchmarks/${n})`))}, picked per rival by \`buildPage\` in \`bench/results-page.mjs\`. Every other head-to-head is also listed.`,
    'These passes predate the claim rules, so they report pass counts and totals instead of expected time. The tables include the failed runs.',
  ]));
  md = swap(md, '\n## Latest release pass\n', '\n' + method + '\n## Latest release pass\n');
  md = md.replace(/owner presence|owner away/g, publicVoice);
  return md.trimEnd() + '\n\n' + pageFooter(fam.page, { data: id, dataText: 'contains every run of the release passes and of the two head-to-heads on this page, plus the totals of every file' });
}


// ---------------------------------------------------------------------------------------------------------------------------
// The validation page: sleight's build B against its earlier build A, never against another tool.

// The re-measure gate's rule, applied to every task: B is marked when its expected time is higher than A's (or B never passed), or
// its pass rate is lower. The marks are not a significance test; the spread table shows the runs behind each cell.
export function compareTasks(study) {
  const cell = (task, arm) => study.cells.find(c => c.task === task && c.arm === arm);
  return study.tasks.map(task => {
    const a = cell(task, BUILD_A), b = cell(task, BUILD_B);
    const slower = !!a && !!b && a.expected != null && (b.expected == null || b.expected > a.expected);
    const lowerRate = !!a && !!b && b.passes / b.runs < a.passes / a.runs;
    const delta = a?.expected != null && b?.expected != null ? (b.expected - a.expected) / a.expected : null;
    return { task, a, b, delta, slower, lowerRate, marked: slower || lowerRate };
  });
}
const pct = value => (value == null ? DASH : `${value > 0 ? '+' : ''}${(Math.round(value * 1000) / 10).toFixed(1)}%`);
const bankKind = kind => (kind === 'remeasure' ? 're-measure' : 'validation');

const bankLabel = id => ({ 'validation-150f-rel3': 'Final release A/B', 'validation-150f-rel2': 'Earlier release A/B' })[id] ?? id;
const groupLabel = id => ({ 'as3-safari': 'additional page tasks, Safari', 'as3-firefox': 'additional page tasks, Firefox' })[id] ?? id;
const previousRelease = bank => bank.id === 'validation-150f-rel3'
  ? ' against 1.4.2 (build A cf342b59, the p160 harness with the 1.4.2 plugin tree)' : '';

function validationHeadline(data) {
  const release = data.banks.filter(bank => bank.release).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')).at(-1);
  if (release) return `${release.passed ? 'RELEASE PASS' : 'RELEASE BLOCKED'}: ${lowFirst(bankLabel(release.id))}${previousRelease(release)}, ${release.release.verdicts.filter(v => !v.regressed).length} of ${release.release.verdicts.length} groups within their time and pass-loss limits ` +
    `(${release.date}, engine ${release.engine}). ${data.banks.filter(b => !b.pending).length} scored banks, including the older engine records`;
  const scored = data.banks.filter(bank => !bank.pending), unscored = data.banks.length - scored.length;
  if (!scored.length) return 'No validation bank has a score yet';
  const rows = data.studies.flatMap(compareTasks);
  const newest = scored.filter(bank => bank.date).sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1) ?? scored.at(-1);
  const count = kind => scored.filter(bank => bank.kind === kind).length;
  return `${scored.length} scored ${scored.length === 1 ? 'bank' : 'banks'}: ${count('validation')} validation, ${count('remeasure')} re-measure. ` +
    `${unscored ? `${unscored} more ${unscored === 1 ? 'has' : 'have'} no score file. ` : ''}${data.studies.length} A/B groups in all. Build B has a higher expected time or a lower pass rate than build A on ` +
    `${rows.filter(row => row.marked).length} of ${rows.length} task comparisons. Newest scored bank: ${newest.id}${newest.date ? ` (${newest.date.slice(0, 10)})` : ''}`;
}

function bankSection(data, bank) {
  const studies = data.studies.filter(study => study.bank === bank.id);
  const out = [`## ${bankLabel(bank.id)}\n`];
  const facts = [`${bankKind(bank.kind)} bank`, bank.date, bank.engine ? `ChatGPT engine ${code(bank.engine)}` : null,
    bank.aBuild ? `build A ${code(bank.aBuild)}` : null, bank.bBuild ? `build B ${code(bank.bBuild)}` : null].filter(Boolean);
  out.push(`${upFirst(facts.join(', '))}.${bank.kind === 'remeasure' ? ` Its gate ${bank.passed ? 'passed' : 'did not pass'}.` : ''}` +
    `${bank.complete ? '' : ' The bank is not complete.'}\n`);
  if (bank.release) {
    const r = bank.release;
    out.push(`${bank.passed ? 'RELEASE PASS' : 'RELEASE BLOCKED'}${previousRelease(bank)} (recorded exit ${r.exitCode}). Passing lower-median totals include only tasks with a pass on both sides. Expected-time marks below use a different statistic.\n`);
    out.push(mdTable(['Group', 'Passing lower-median total A (s)', 'B (s)', 'Change', 'Limit', 'Comparable tasks', 'Passes A', 'Passes B'], r.verdicts.map(v =>
      [groupLabel(v.kind), f1(v.aTotal), f1(v.bTotal), pct(v.slowdown), pct(v.limit), v.comparable, v.passA, v.passB])) + '\n');
    out.push(mdTable(['Group', 'Aborted A attempts', 'Aborted B attempts'], Object.entries(r.aborted).map(([kind, n]) => [groupLabel(kind), n.A, n.B])) + '\n');
    if (r.errors.length) out.push('Recorded gate errors: ' + r.errors.map(code).join('; ') + '.\n');
    if (r.taskExclusions.length) out.push(mdTable(['Excluded task', 'Groups', 'Sides', 'Reason'], r.taskExclusions.map(e => [e.task, e.kinds.join(', '), e.sides.join(', '), e.reason.replace(/; fix FX1 in progress$/, '')])) + '\n');
    if (bank.id === 'validation-150f-rel3') out.push('The release passed the group limits while Safari (+10.57%), Chrome Opus (+5.14%) and Firefox (+2.74%) are slower.\n\nIndividual expected times were 24 to 35% slower for Chrome Haiku `inject-mail` (+23.94%, rounded to 24%), Chrome Opus `form-checkout` (+24.03%) and `form-settings-helium` (+25.41%), Firefox `inject-mail` (+24.35%), Safari `form-checkout` (+32.06%), `inject-mail` (+26.26%) and `mdn` (+31.26%), and the held-out Firefox controls `cc-list-pop-up-firefox` (+31.67%) and `cc-dropdown-slow-firefox` (+34.89%).\n');
    if (bank.id === 'validation-150f-rel3') out.push('Both sides ran fresh in the final release A/B. Finder setup failed twice at a 5 s sheet timeout, and the steps resumed. Holds for another project stopped steps mid-run. Aborted attempts were retained and rerun. `cc-list-native` was absent from the schedule. Both Finder tasks were included with no task exclusions.\n');
    if (bank.id === 'validation-150f-rel2') out.push('This is the older engine record. `cc-list-native` was absent from both sides of the schedule. Finder setup failures also excluded rename and create-folder on both sides. The gate was blocked by the native comparable-task floor.\n');
  }
  if (!studies.length) { out.push(`No group in this bank has a complete score${bank.pending ? ' (the bank has no score file)' : ''}.\n`); return out.join('\n'); }
  out.push(mdTable(['Group', 'Browser', 'Tasks', 'Build B marked on', 'Passes A', 'Passes B'], studies.map(study => {
    const rows = compareTasks(study), runs = arm => study.runs.filter(run => run.arm === arm);
    return [code(groupLabel(study.group)), study.browser ?? DASH, study.tasks.length, `${rows.filter(row => row.marked).length} of ${rows.length}`,
      `${runs(BUILD_A).filter(r => r.passed).length}/${runs(BUILD_A).length}`, `${runs(BUILD_B).filter(r => r.passed).length}/${runs(BUILD_B).length}`];
  })) + '\n');
  if (bank.incomplete?.length) {
    out.push('Groups left out of the comparison:\n\n' + mdTable(['Group', 'State', 'Why'], bank.incomplete.map(item => [code(item.group), item.deferred ? 'deferred' : 'incomplete', code(item.why)])) + '\n');
  }
  for (const study of studies) {
    const rows = compareTasks(study);
    const mark = row => (!row.marked ? 'no' : row.slower && row.lowerRate ? 'slower and lower pass rate' : row.slower ? 'slower' : 'lower pass rate');
    out.push(details(`${groupLabel(study.group)}: ${rows.filter(row => row.marked).length} of ${rows.length} tasks marked`, [
      `Each cell is expected seconds, then passes/runs. Build A had ${study.aRounds || 'no'} ${study.roundIds ? 'recorded step' : 'round'}${study.aRounds === 1 ? '' : 's'}${study.models[BUILD_B] ? ` on ${study.models[BUILD_B].map(code).join(', ')}` : ''}.`,
      ...(study.roundIds ? [`Build A rounds: ${study.roundIds[BUILD_A].map(code).join(', ')}. Build B rounds: ${study.roundIds[BUILD_B].map(code).join(', ')}.`] : []),
      mdTable(['Task', 'Build A', 'Build B', 'Change in expected time', 'Marked'], rows.map(row => [code(row.task), cellText(row.a), cellText(row.b), pct(row.delta), mark(row)])),
      armTable(study, { builds: true }),
      'Passing runs, median [fastest to slowest]:\n\n' + spreadTable(study),
      ...(study.roundIds && failureRows(study).length ? ['Failed runs:\n\n' + mdTable(['Task', 'Arm', 'Round', 's', 'Problems'], failureRows(study))] : []),
    ].join('\n\n')));
  }
  return out.join('\n');
}

export function renderValidationPage(all, id) {
  const data = all[id], fam = family(id);
  const out = [pageHead(fam.page, fam.title)];
  out.push('These banks compare two builds of sleight on the same tasks, build A (an earlier build, usually the last release) against build B (the build under test). ' +
    'No other tool is in these tables, and they never count toward a claim. A mark means build B has a higher expected time than build A, or a lower pass rate. ' +
    'It is not a significance test.\n');
  out.push(`${validationHeadline(data)}.\n`);
  out.push(details('Method', list([
    SCORING,
    'The validation runner (`bench/validation/validation-140.mjs`) alternates the two builds round by round on one Mac with the tester away, and scores both with the claim scorer. ' +
      'Where an earlier round of build A passed its identity checks (prompts, harness, model, engine), the runner reuses it and counts it in build A\'s rounds.',
    'The re-measure runner (`bench/validation/remeasure.mjs`) runs 3 rounds of the final build against the stored build A rounds. Its gate needs build B to have no higher expected time and no lower pass rate on every selected task.',
    'A score file keeps each run\'s seconds and whether it passed, and not the failure reason. Each bank\'s folder keeps the receipts and logs.',
  ])));
  const banks = data.banks.filter(bank => !bank.pending).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.id.localeCompare(a.id));
  if (!banks.length) out.push('No bank has a score yet.\n');
  for (const bank of banks) out.push(bankSection(data, bank));
  const pending = data.banks.filter(bank => bank.pending);
  if (pending.length) {
    out.push(details(`Banks without a score (${pending.length})`, 'These folders have a plan and no score file, so they are aborted attempts or runs still going.\n\n' +
      mdTable(['Bank', 'Kind', 'Groups planned'], pending.map(bank => [code(bank.id), bankKind(bank.kind), bank.planned ?? DASH]))));
  }
  out.push(`[data/${id}.json](data/${id}.json) has every counted run and the scored cells, and the [interactive page](${PAGES_URL}explore.html) charts them. ` +
    'Rebuild every page with `node bench/results-hub.mjs`.\n');
  out.push(renderNav(fam.page) + '\n');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------
// Index.

export const FAMILIES = [
  { id: 'native-claim', page: 'native-claim.md', title: 'Native claim', what: 'The 9 native Mac app tasks, sleight against LCU, Codex, Cua, Peekaboo and Claude\'s own computer use.' },
  { id: 'app-claim', page: 'app-claim.md', title: 'App claim', what: 'VS Code, Slack and Spotify tasks with the same arms.' },
  { id: 'browser-turbo', page: 'browser-turbo.md', title: 'Chrome and Helium: turbo against FowlBrowser', what: 'Turbo in Chrome and Helium, in the real-window race and the earlier gate rounds.' },
  { id: 'browser-race', page: 'browser-race.md', title: 'Safari and Firefox: the engine path against Codex, LCU, Cua and Peekaboo', what: 'sleight\'s engine path in Safari and Firefox against Codex, LCU, Cua and Peekaboo.' },
  { id: 'ab-tests', page: 'ab-tests.md', title: 'Experiments', what: 'sleight against sleight, for skill, wording, tool and turbo changes.' },
  { id: 'validation', self: true, page: 'validation.md', title: 'Validation: build A against build B', what: 'sleight against its own earlier build on the same tasks, from the validation and re-measure banks.' },
  { id: 'release-passes', page: 'release-passes.md', title: 'Release passes and the earlier head-to-heads', what: 'The per-release regression passes and the first native head-to-heads.' },
];
const family = id => FAMILIES.find(fam => fam.id === id);

// The ChatGPT engine versions behind a family's headline, from the data's per-arm summaries.
function engineBrief(studies) {
  if (!hasEngines(studies)) return 'no engine version in this data, which predates 2026-10-19';
  const versions = {};
  for (const byArm of studies.filter(s => s?.engines).map(s => s.engines)) for (const [arm, summary] of Object.entries(byArm)) {
    if (!usesEngine(arm)) continue;
    for (const [version, b] of Object.entries(summary.versions)) {
      const v = versions[version] ??= { first: null, last: null };
      if (b.first && (!v.first || b.first < v.first)) v.first = b.first;
      if (b.last && (!v.last || b.last > v.last)) v.last = b.last;
    }
  }
  const parts = Object.entries(versions).sort(([a], [b]) => (a < b ? -1 : 1)).map(([version, v]) => `engine ${version}${v.first ? `, ${dayRange(v.first, v.last)}` : ''}`);
  return parts.length ? joinAnd(parts) : 'no arm here drives the engine with a known version';
}
const headlineStudies = (id, data) => (id === 'browser-race' ? data.studies.filter(s => s.latest) : id === 'browser-turbo' ? data.race.studies.filter(s => s.latest)
  : id === 'ab-tests' ? data.studies : id === 'release-passes' || id === 'validation' ? [] : data.studies);

const upFirst = text => text.charAt(0).toUpperCase() + text.slice(1);
const lowFirst = text => text.charAt(0).toLowerCase() + text.slice(1);

const unopposedTotal = study => study.verdict.totals[study.me] != null &&
  !study.arms.some(arm => arm !== study.me && study.verdict.totals[arm] != null);

function raceResult(study) {
  const v = study.verdict;
  const count = `${v.lowest.length} of ${study.tasks.length} tasks`;
  const wording = v.wording === 'fastest' ? `is fastest on ${count}` : v.wording.startsWith('completed every task')
    ? `has completed every task and is fastest on ${count}` : `has the scorer wording "${v.wording}"`;
  const total = v.totals[study.me] == null ? 'It has no total (a task has no pass)' : `Its total is ${f1(v.totals[study.me])} s`;
  return `sleight ${wording}. ${unopposedTotal(study) ? `It is the only arm with a total (${f1(v.totals[study.me])} s)` : total}`;
}

function resultSummary(id, data) {
  if (id === 'native-claim' || id === 'app-claim') {
    const s = data.studies[0];
    return `Lowest expected time on ${s.verdict.lowest.length} of ${s.tasks.length} tasks. Total ${f1(s.verdict.totals[s.me])} s.`;
  }
  if (id === 'browser-race' || id === 'browser-turbo') {
    const studies = id === 'browser-turbo' ? data.race.studies : data.studies;
    return studies.filter(s => s.latest).map(s => `${cap(s.browser)}${s.model ? ` ${cap(s.model)} ${s.suite}` : ''}: ${id === 'browser-race' ? raceResult(s) : `lowest expected time on ${s.verdict.lowest.length} of ${s.tasks.length} tasks. ${s.verdict.totals[s.me] == null ? 'A task without a pass prevents a total' : `Total ${f1(s.verdict.totals[s.me])} s`}`}.`).join(' ');
  }
  return upFirst(headlineFor(id, data)) + '.';
}

function headlineFor(id, data) {
  const engine = engineBrief(headlineStudies(id, data));
  if (id === 'native-claim' || id === 'app-claim') {
    const s = data.studies[0];
    return `"${s.verdict.wording}", sleight's total expected time ${f1(s.verdict.totals.sleight)} s over ${s.tasks.length} tasks (${s.runs.length} runs, ${s.date}). ${upFirst(engine)}`;
  }
  if (id === 'browser-race') {
    return lowFirst(data.studies.filter(s => s.latest).map(s => `In ${cap(s.browser)} ${raceResult(s)} (${code(s.label)}, ${s.date.slice(0, 10)})`).join('. ') || 'No complete set') + `. ${upFirst(engine)}`;
  }
  if (id === 'browser-turbo') {
    const rematch = data.race.studies.filter(s => s.latest && s.rematch);
    if (rematch.length) {
      const time = value => value == null ? 'without a total' : `${f1(value)} s`;
      const models = sortedUniq(rematch.filter(s => s.suite === 'core').map(s => s.model));
      const core = models.map(model => `on ${cap(model)} 5.5, lowest expected times in ` + rematch.filter(s => s.suite === 'core' && s.model === model).map(s =>
        `${cap(s.browser)} ${s.verdict.fastest[s.me].length}/${s.tasks.length} (sleight ${time(s.verdict.totals[s.me])}, FowlBrowser ${time(s.verdict.totals.fowlbrowser)})`).join(' and '));
      const held = rematch.filter(s => s.suite === 'held-out').map(s => `The ${cap(s.model)} held-out set has lowest expected times on ${s.verdict.fastest[s.me].length}/${s.tasks.length} tasks for sleight and ${s.verdict.fastest.fowlbrowser.length}/${s.tasks.length} for FowlBrowser. ${s.arms.every(a => s.verdict.totals[a] == null) ? 'Neither arm has a complete-suite total' : 'Totals are on the results page'}`);
      const pending = rematch.filter(s => s.verdict.topUps.length).map(s => `${cap(s.browser)} ${cap(s.model)}`);
      return [core[0], ...core.slice(1).map(upFirst), charts.haikuCheckoutDisclosure({ 'browser-turbo': data }).replace(/\.$/, ''), ...held, ...(pending.length ? [`Five-run top-ups still owed for ${pending.join(', ')}`] : []), upFirst(engine)].join('. ');
    }
    const race = data.race.studies.filter(s => s.latest).map(s => `In ${cap(s.browser)}${s.model ? ` on ${cap(s.model)} 5.5 (${s.suite})` : ''}, the lowest expected time on ${s.verdict.fastest[s.me].length} of ${s.tasks.length} tasks and ${s.verdict.totals[s.me] == null ? 'no total (a task has no pass)' : `a total of ${f1(s.verdict.totals[s.me])} s`} against FowlBrowser's ${s.verdict.totals.fowlbrowser == null ? 'no total (a task has no pass)' : `${f1(s.verdict.totals.fowlbrowser)} s`} (${code(s.label)}, ${s.date?.slice(0, 10)})`);
    return lowFirst(race.join('. ')) + `. ${data.gates.length} gate studies. ${upFirst(engine)}`;
  }
  if (id === 'ab-tests') return `${data.studies.length} studies with run data. The catalog has ${data.catalog.length} benchmark write-ups and includes studies without structured run data`;
  if (id === 'validation') return validationHeadline(data);
  if (id === 'release-passes') {
    const releases = data.files.filter(f => f.kind === 'release');
    return `${releases.length} release passes (${releases[0]?.date} to ${releases.at(-1)?.date}), ${data.files.length} results files in all`;
  }
  return '';
}

function renderIndex(all) {
  const out = [pageHead('README.md', 'Benchmark results')];
  out.push('The results include failed runs, with methods and exclusions for each benchmark family. The claim scorers compute the figures from recorded runs.\n');
  for (const id of ['headline-native', 'overview']) { const chart = chartFor(all, id); if (chart) out.push(chart); }
  out.push(`The [interactive page](${PAGES_URL}explore.html) has the same data with sorting, filters and a chart per task. Its source is [explore.html](explore.html) in this folder.\n`);
  out.push(mdTable(['Family', 'What it measures', 'Where it stands', 'Data'], FAMILIES.map(fam => [
    `[${fam.title}](${fam.page})`, fam.what, resultSummary(fam.id, all[fam.id]), `[json](data/${fam.id}.json)`])) + '\n');
  out.push('[Insights](insights.md) covers what the runs taught us about run-to-run variation, Haiku against Opus, which tuning paid off, and engine quirks.\n');
  out.push(details('Run dates, engine versions and build labels', FAMILIES.map(fam => `- [${fam.title}](${fam.page}): ${headlineFor(fam.id, all[fam.id])}.`).join('\n')));
  out.push('## Terms\n');
  out.push(list([
    'Expected time is the mean seconds per attempt divided by the pass rate, the time to a correct result if failed attempts are retried.',
    'An arm is one agent setup: sleight, a competitor plugin, or a sleight variant in an A/B.',
    'A round runs every task once per arm. A claim or race task gets 3 runs per arm, or 5 where sleight and another arm are within 20%.',
    'The full rules are in [LAWS](../status/LAWS.md), and the tasks and harnesses in [benchmark.md](../benchmark.md).',
  ]) + '\n');
  out.push(details('Rebuild', '```sh\nnode bench/results-hub.mjs                # collect from the raw folders this Mac has, then render\nnode bench/results-hub.mjs --render-only  # render from docs/results/data only\nnode bench/results-hub.mjs --check        # exit 1 if a page, data file or README block would change\n```\n\n' +
    'The raw claim, race and validation folders live outside the repo, in `~/Projects/sleight-wt/app-claim`, `~/Projects/sleight-wt/race-1017` and the banks under `~/Projects/sleight-wt` (any folder with a validation or re-measure `plan.json`). The FowlBrowser rematch banks are `~/Library/Caches/sleight-bench/evidence/fw1-e51c52a-haiku` and `fw1-e51c52a-opus`. Whole-thread corrections come from the tracked [regrade data](data/whole-thread-regrade.txt). On a Mac without the raw folders, the generator keeps the data files already here. `--wt <dir>` points it at another worktrees root and looks for rematch banks in its `evidence/` folder. The benchmark runners run the collect and render once after a successful pass (`bench/hub-refresh.mjs`), and `--no-hub` or `SLEIGHT_NO_HUB=1` stops that.'));
  out.push(engineFooter(FAMILIES.flatMap(fam => headlineStudies(fam.id, all[fam.id]))) + '\n');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------
// The repo README's generated blocks. Each sits between <!-- hub:<name> --> and <!-- /hub:<name> -->, and nothing outside the
// markers is touched.

export const README_BLOCKS = ['claim', 'turbo', 'release', 'headline', 'benchmarks'];
const README_BASE = 'docs/results/';

// Pure: returns text with each named block's contents replaced. A block whose markers are missing is left alone, and a marker
// that appears twice or a closing marker before its opening one throws.
export function spliceReadme(text, blocks) {
  let out = text;
  for (const [name, body] of Object.entries(blocks)) {
    const open = `<!-- hub:${name} -->`, close = `<!-- /hub:${name} -->`;
    const count = marker => out.split(marker).length - 1;
    if (count(open) > 1 || count(close) > 1) throw new Error(`README.md: the hub:${name} marker appears more than once`);
    if (count(open) !== count(close)) throw new Error(`README.md: hub:${name} has an opening or a closing marker without the other`);
    if (!count(open)) continue;
    const start = out.indexOf(open) + open.length, end = out.indexOf(close);
    if (end < start) throw new Error(`README.md: the closing hub:${name} marker comes before the opening one`);
    out = out.slice(0, start) + (body.trim() ? `\n${body.trim()}\n` : '\n') + out.slice(end);
  }
  return out;
}

// The longer claim context lives with the native results, beside the methods and run tables.
function nativeClaimContext(all) {
  const study = all['native-claim'].studies[0], v = study.verdict;
  const others = study.arms.filter(arm => arm !== study.me && v.totals[arm] != null).sort((a, b) => v.totals[a] - v.totals[b]);
  const next = others[0];
  const models = sortedUniq(study.models?.[study.me] ?? []).map(code).join(', ') || 'model not recorded';
  const codexModels = sortedUniq(study.models?.codex ?? []).map(code).join(', ');
  const effort = (Array.isArray(study.effort) ? study.effort : []).join(', ') || 'effort not recorded';
  const compat = all['engine-compat'] ?? readJson(join(ROOT, 'docs/results/data/engine-compat.json'));
  const newest = [...compat.entries].sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
  const version = newest?.appVersion ?? newest?.engineVersion;
  const engines = Object.values(study.engines ?? {}).flatMap(e => Object.keys(e.versions ?? {}));
  const newer = version && engines.length && engines.every(v => version.localeCompare(v, 'en', { numeric: true }) > 0);
  const comparison = next ? ` ${armName(next)}, ${others.length === 1 ? 'the only other arm' : `the fastest of ${others.length} other arms`} that passed every task, took ${f1(v.totals[next])} s.` : '';
  return [
    `In sleight's own native Mac benchmark, its total expected time over ${study.tasks.length} tasks was ${f1(v.totals[study.me])} s.` + comparison,
    `Expected time is the mean time per attempt divided by the pass rate. It estimates the time to a correct result when failed attempts are retried.`,
    `The claim is "${v.wording}": the lowest expected time on ${v.lowest.length} of ${study.tasks.length} tasks and the lowest total, with 5 runs wherever sleight and another arm were within 20%.`,
    `This was measured over ${study.runs.length} runs dated ${study.date} on ${models} at ${effort} effort (${engineBrief([study])}).` +
      ` The skill was tuned on some of these tasks. Competitors ran their defaults.${codexModels ? ` Codex ran ${codexModels}.` : ''}`,
    `Haiku 5.5 drove this native claim. Earlier Opus 5.5 runs include the [2026-10-03 native comparison against LCU](../benchmark.md#earlier-benchmarks) and the [2026-10-08 sleight-only pass at medium effort](../benchmark.md#time-per-run).`,
    `Opus browser runs include the [2026-10-12 engine comparison against FowlBrowser](../benchmarks/2026-10-12-fowlbrowser-h2h.md), its [later rounds](../benchmarks/2026-10-12-fowlbrowser-h2h-2.md), the [2026-10-12 lean-skill A/B](../benchmarks/2026-10-12-lean-skill-ab.md) and the [2026-10-16 turbo comparison against FowlBrowser](../benchmarks/2026-10-16-opus.md).`,
    ...(newer ? [`The [compatibility record](engine-compat.md) lists a newer ChatGPT release, ${version}, than these runs. Compatibility checks do not remeasure speed.`] : []),
    `The [benchmark hub](README.md) lists each run, failures included, with the method and the model each arm ran.`,
  ].join('\n\n');
}

// The README blocks, from the same data as the hub landing.
export function readmeBlocks(all) {
  const study = all['native-claim'].studies[0], v = study.verdict;
  const next = study.arms.filter(arm => arm !== study.me && v.totals[arm] != null).sort((a, b) => v.totals[a] - v.totals[b])[0];
  const comparison = next ? ` ${armName(next)}: ${f1(v.totals[next])} s.` : '';
  const claim = [
    `sleight's own ${study.tasks.length}-task native Mac benchmark: ${f1(v.totals[study.me])} s total expected time.${comparison}<br>`,
    `Expected time is mean time per attempt divided by the pass rate, estimating time to a correct result when failed attempts are retried.<br>`,
    `[Benchmark hub](${README_BASE}README.md) · [Interactive page](${PAGES_URL}explore.html)`,
  ].join('\n');
  const block = id => charts.chartBlock(id, all, { base: README_BASE }).trim();
  const lines = FAMILIES.map(fam => `- [${fam.title}](${README_BASE}${fam.page}): ${headlineFor(fam.id, all[fam.id]).replace(/\]\((?!https?:)/g, `](${README_BASE}`)}.`);
  return { claim, turbo: `[Turbo results](${README_BASE}browser-turbo.md): ${headlineFor('browser-turbo', all['browser-turbo'])}.\n\n${block('family-browser-turbo-chrome')}`,
    release: `[Release A/B](${README_BASE}validation.md): ${validationHeadline(all.validation)}.`,
    headline: block('headline-native'), benchmarks: [lines.join('\n'), block('overview')].filter(Boolean).join('\n\n') };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Explore data: every study flattened into indexed tables so the page stays small.

export function exploreData(all) {
  const families = FAMILIES.map(f => ({ id: f.id, title: f.title, page: f.page, ...(f.self ? { self: true } : {}) }));
  const studies = [];
  const add = (family, study, extra = {}) => studies.push({ family, ...study, ...extra });
  add('native-claim', all['native-claim'].studies[0]);
  add('app-claim', all['app-claim'].studies[0]);
  for (const s of all['browser-turbo'].race.studies) add('browser-turbo', s, { title: `Real-window race: ${s.title}` });
  for (const s of all['browser-turbo'].gates) add('browser-turbo', s, { title: `Gate: ${s.id}` });
  for (const s of all['browser-race'].studies) add('browser-race', s);
  for (const s of all['ab-tests'].studies) add('ab-tests', s, { title: `A/B: ${s.id}` });
  for (const s of all.validation.studies) add('validation', s, { title: `${bankKind(s.kind)}: ${s.title}` });
  const releaseRuns = all['release-passes'].runs;
  for (const name of all['release-passes'].releaseInputs) {
    const runs = releaseRuns.filter(run => run.file === name);
    const arms = uniq(runs.map(run => run.arm)), tasks = sortedUniq(runs.map(run => run.task));
    const me = arms.includes('sleight') ? 'sleight' : arms[0];
    const ordered = [me, ...arms.filter(a => a !== me)];
    const file = all['release-passes'].files.find(f => f.name === name);
    const { cells } = cellsFor(runs.filter(r => Number.isFinite(r.seconds)), tasks, ordered, me);
    add('release-passes', { id: name.replace(/\.json$/, ''), title: `${file.kind === 'release' ? `Release ${file.version}` : 'Head-to-head'}: ${name}`, date: file.date, browser: null,
      me, arms: ordered, tasks, models: Object.fromEntries(file.arms.map(a => [a.arm, a.models.length ? a.models : file.model && a.arm === 'sleight' ? [file.model] : []])),
      effort: file.effort ? [file.effort] : [], runs: runs.filter(r => Number.isFinite(r.seconds)), cells });
  }
  const strings = [], index = new Map();
  const id = value => { const key = String(value ?? ''); if (!index.has(key)) { index.set(key, strings.length); strings.push(key); } return index.get(key); };
  const out = studies.map(s => ({
    id: s.id, family: s.family, title: s.title, date: s.date ?? '', browser: s.browser ?? '', me: s.me, arms: [...s.arms, ...(s.hosted ?? [])], tasks: s.tasks,
    models: s.models ?? {}, effort: Array.isArray(s.effort) ? s.effort : sortedUniq(Object.values(s.effort ?? {}).flat()),
    wording: s.verdict?.wording ?? null, page: families.find(f => f.id === s.family).page,
    cells: s.cells.map(c => [id(c.task), id(c.arm), c.runs, c.passes, c.expected, c.median, c.min, c.max, c.p90]),
    runs: s.runs.map(r => [id(r.task), id(r.arm), id(r.round ?? r.file ?? ''), r.seconds, r.passed ? 1 : 0, r.problem ? id(r.problem) : -1]),
  }));
  return { families, strings, studies: out };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Main.

// JSON with each short object or array on one line, so a run is one line and diffs stay readable.
export function pretty(value, indent = '') {
  const flat = JSON.stringify(value);
  if (flat === undefined || flat.length <= 160 || value === null || typeof value !== 'object') return flat;
  const inner = indent + ' ';
  if (Array.isArray(value)) return '[\n' + value.map(item => inner + (pretty(item, inner) ?? 'null')).join(',\n') + '\n' + indent + ']';
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return '{\n' + entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pretty(v, inner)}`).join(',\n') + '\n' + indent + '}';
}
const json = value => pretty(value) + '\n';

export function collect({ wt, out, excludeCovered = false, banks: extraBanks = [] }) {
  const dataDir = join(out, 'data');
  const keep = id => { const file = join(dataDir, `${id}.json`); return existsSync(file) ? readJson(file) : undefined; };
  const claimDir = join(wt, 'app-claim');
  const timeline = loadTimeline();
  const raceDir = raceDirs(wt);
  const all = {};
  const notes = [];
  if (isDir(join(claimDir, 'native-results-1018b'))) {
    all['native-claim'] = collectClaim({ id: 'native-claim', title: 'Native claim', dir: join(claimDir, 'native-results-1018b'), rulesFile: join(ROOT, 'bench/claim-exclusions.json'), timeline });
  } else { all['native-claim'] = keep('native-claim'); notes.push('native-claim: raw folder missing, kept the data file'); }
  if (isDir(join(claimDir, 'results-1018'))) {
    all['app-claim'] = collectClaim({ id: 'app-claim', title: 'App claim', dir: join(claimDir, 'results-1018'), rulesFile: join(claimDir, 'scorer/bench/claim-exclusions.json'),
      since: '2026-10-18T02-39', sinceNote: 'the first app-task claim pass', timeline });
  } else { all['app-claim'] = keep('app-claim'); notes.push('app-claim: raw folder missing, kept the data file'); }
  const gates = collectRunnerStudies();
  if (raceDir.length) {
    all['browser-race'] = collectRace({ raceDir, browsers: ['safari', 'firefox'], family: 'browser-race', title: 'Safari and Firefox race', timeline, excludeCovered });
    const turboRace = collectRace({ raceDir, browsers: ['chrome', 'helium'], family: 'browser-turbo', title: 'Chrome and Helium race', timeline, excludeCovered });
    all['browser-turbo'] = { family: 'browser-turbo', title: 'Browser turbo against FowlBrowser', race: turboRace, gates: gates.filter(s => s.family === 'browser-turbo'),
      headline: ['2026-10-16-gate-3', '2026-10-16-opus'] };
  } else {
    all['browser-race'] = keep('browser-race');
    const kept = keep('browser-turbo');
    all['browser-turbo'] = { ...kept, gates: gates.filter(s => s.family === 'browser-turbo') };
    notes.push('race: raw folder missing, kept the race data');
  }
  const evidence = resolve(wt) === join(homedir(), 'Projects/sleight-wt') ? join(homedir(), 'Library/Caches/sleight-bench/evidence') : join(wt, 'evidence');
  const rematchBanks = ['haiku', 'opus'].map(model => ({ dir: join(evidence, `fw1-e51c52a-${model}`), model })).filter(b => isDir(b.dir));
  if (rematchBanks.length) {
    const regradeFile = join(ROOT, 'docs/results/data/whole-thread-regrade.txt');
    const rematch = collectRematch({ banks: rematchBanks, regrade: existsSync(regradeFile) ? readFileSync(regradeFile, 'utf8') : '', timeline });
    const race = all['browser-turbo'].race;
    const fresh = new Set(rematch.studies.map(s => s.id)), browsers = new Set(rematch.studies.filter(s => s.suite === 'core').map(s => s.browser));
    const history = race.studies.filter(s => !fresh.has(s.id)).map(s => ({ ...s, latest: browsers.has(s.browser) ? false : s.latest }));
    all['browser-turbo'].race = { ...race, studies: [...rematch.studies, ...history],
      source: { ...race.source, race: uniq([...race.source.race.split(', '), ...rematchBanks.map(b => tilde(b.dir))]).join(', ') },
      inProgress: [...race.inProgress.filter(r => !r.startsWith('fw1-')), ...rematch.inProgress],
      partial: [...race.partial.filter(r => !r.rematch), ...rematch.partial], excludedRounds: [...race.excludedRounds.filter(r => !r.rematch), ...rematch.excludedRounds] };
  } else {
    // A Mac that has the historical race folders but not the rematch must still retain the published rematch data.
    const previous = keep('browser-turbo')?.race;
    const retained = previous?.studies.filter(s => s.rematch) ?? [];
    if (retained.length) {
      const race = all['browser-turbo'].race, ids = new Set(retained.map(s => s.id));
      const browsers = new Set(retained.filter(s => s.latest && s.suite === 'core').map(s => s.browser));
      race.studies = [...retained, ...race.studies.filter(s => !ids.has(s.id)).map(s => ({ ...s, latest: browsers.has(s.browser) ? false : s.latest }))];
      race.source = { ...race.source, race: uniq([...race.source.race.split(', '), ...previous.source.race.split(', ')]).join(', ') };
      race.excludedRounds = [...race.excludedRounds.filter(r => !r.rematch), ...previous.excludedRounds.filter(r => r.rematch)];
      race.partial = [...race.partial.filter(r => !r.rematch), ...previous.partial.filter(r => r.rematch)];
      race.inProgress = uniq([...race.inProgress, ...previous.inProgress.filter(r => r.startsWith('fw1-'))]);
    }
  }
  const catalog = writeUpCatalog();
  const releases = collectReleases({ timeline });
  const coveredWriteUps = sortedUniq([...gates.map(s => s.writeUp), ...releases.files.map(f => f.writeUp)]);
  all['ab-tests'] = { family: 'ab-tests', title: 'A/B tests and tuning experiments', studies: [...collectJsonAbs(), ...gates.filter(s => s.family === 'ab-tests')].sort((a, b) => (a.date + a.id < b.date + b.id ? -1 : 1)),
    catalog, coveredWriteUps };
  all['release-passes'] = releases;
  const banks = collectValidation({ wt, kept: keep('validation'), banks: extraBanks });
  if (banks.banks.length) all.validation = banks;
  else { all.validation = keep('validation'); notes.push('validation: no bank on this Mac, kept the data file'); }
  for (const [id, data] of Object.entries(all)) if (!data) throw new Error(`${id}: no raw folder and no data file in ${dataDir}`);
  return { all, notes };
}

export function render(all) {
  const files = {};
  for (const [id, data] of Object.entries(all)) files[`data/${id}.json`] = json(data);
  files['native-claim.md'] = renderClaimPage(all, 'native-claim', {
    intro: 'The claim suite runs 9 native tasks in Calculator, TextEdit, Finder, Preview, Word and Excel, one task per skill. sleight competes against LCU, Codex, Cua, Peekaboo and Claude\'s own computer use in real windows with the tester away. The suite is sleight\'s own, its skill and tool wording were tuned on the runs of textedit-calculator, preview-read, excel-edit, word-edit, finder-move, textedit-save and textedit-drag (not calculator-click or calculator-menu), and the competitors ran their defaults.' });
  files['app-claim.md'] = renderClaimPage(all, 'app-claim', {
    intro: 'The app tasks run on the native path with the same arms and rules as the native claim. In VS Code the agent edits a fixture file in a separate instance with a temporary profile. In Slack it posts one fixed message to a test channel of a throwaway account. In the tester\'s personal Spotify account it finds a track, plays it and pauses it.' });
  files['browser-turbo.md'] = renderTurboPage(all, 'browser-turbo');
  files['browser-race.md'] = renderRacePage(all, 'browser-race');
  files['ab-tests.md'] = renderAbPage(all, 'ab-tests');
  files['validation.md'] = renderValidationPage(all, 'validation');
  files['release-passes.md'] = renderReleasePage(all, 'release-passes');
  files['release-passes.html'] = renderReleaseHtml(releasePage(all['release-passes']), { rebuild: 'node bench/results-hub.mjs' })
    .replace('<body>\n', `<body>\n${renderNavHtml('release-passes.md')}\n`);
  for (const id of ['ab-tests', 'validation', 'release-passes']) {
    const name = family(id).page;
    const heading = `# ${family(id).title}\n`;
    files[name] = files[name].replace(heading, () => `${heading}\n${chartFor(all, `family-${id}`)}`);
  }
  files['README.md'] = renderIndex(all);
  for (const [name, text] of Object.entries(charts.renderCharts(all))) files[name] = text;
  const explore = JSON.stringify(exploreData(all)).replace(/</g, '\\u003c');
  files['explore.html'] = fillTemplate(readFileSync(join(ROOT, 'bench/results-explore.html'), 'utf8'), explore, 'explore.html');
  const indexTemplate = readFileSync(join(ROOT, 'bench/results-index.html'), 'utf8');
  const rows = FAMILIES.map(fam => `<tr><th scope="row"><a href="${escapeHtml(REPO_RESULTS + fam.page)}">${escapeHtml(fam.title)}</a></th>` +
    `<td>${escapeHtml(fam.what)}</td><td>${escapeHtml(resultSummary(fam.id, all[fam.id]))}</td>` +
    `<td><a href="${escapeHtml(`data/${fam.id}.json`)}">JSON</a></td></tr>`).join('\n');
  files['index.html'] = indexTemplate.replace('<!--__FAMILIES__-->', () => rows);
  for (const id of ['headline-native', 'overview']) {
    const caption = escapeHtml(charts.chartCaption(id, all));
    files['index.html'] = files['index.html'].replaceAll(`<!--__${id}__-->`, () => caption);
  }
  for (const [name, text] of Object.entries(files)) files[name] = scrubPaths(text);
  return files;
}

// A page template's data slot and its nav slot.
function fillTemplate(template, data, page) {
  if (!template.includes('/*__DATA__*/null')) throw new Error(`${page}: the template has no /*__DATA__*/null slot`);
  return template.replace('/*__DATA__*/null', () => data).replace('<!--__NAV__-->', () => renderNavHtml(page));
}

// The repo README with its generated blocks filled in, or null when the repo has no README.
export function renderReadme(all, text = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : null) {
  return text === null ? null : scrubPaths(spliceReadme(text, readmeBlocks(all)));
}

function argValue(argv, name) { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; }
const argValues = (argv, name) => argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1]] : []));

export function main(argv = process.argv.slice(2)) {
  const wt = resolve(argValue(argv, '--wt') ?? join(homedir(), 'Projects/sleight-wt'));
  const out = resolve(ROOT, argValue(argv, '--out') ?? 'docs/results');
  let all, notes = [];
  if (argv.includes('--render-only')) {
    all = Object.fromEntries(FAMILIES.map(f => [f.id, readJson(join(out, 'data', `${f.id}.json`))]));
  } else ({ all, notes } = collect({ wt, out, excludeCovered: argv.includes('--exclude-covered'), banks: argValues(argv, '--bank') }));
  const files = render(all);
  const readmeFile = join(ROOT, 'README.md');
  const readme = argv.includes('--hub-only') ? null : renderReadme({ ...all, 'engine-compat': readJson(join(out, 'data/engine-compat.json')) });
  if (argv.includes('--check')) {
    const changed = Object.entries(files).filter(([name, text]) => !existsSync(join(out, name)) || readFileSync(join(out, name), 'utf8') !== text).map(([name]) => name);
    for (const name of changed) console.log(`would change ${name}`);
    const readmeStale = readme !== null && readFileSync(readmeFile, 'utf8') !== readme;
    if (readmeStale) console.log('would change README.md (the repo README\'s hub blocks)');
    process.exitCode = changed.length || readmeStale ? 1 : 0;
    return;
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(out, name)), { recursive: true });
    writeFileSync(join(out, name), text);
  }
  if (readme !== null && readFileSync(readmeFile, 'utf8') !== readme) writeFileSync(readmeFile, readme);
  for (const note of notes) console.log(note);
  console.log(`wrote ${Object.keys(files).length} files to ${relative(ROOT, out) || '.'}${readme !== null ? ' and the README.md blocks' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
