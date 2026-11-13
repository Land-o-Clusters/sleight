#!/usr/bin/env node
// Scores the AS-3 A/B (bench/fowl/as3-ab.command): the sleight arm with SLEIGHT_BROWSER_CORE off and on, per browser.
// Each round's side is what its rows recorded (agentConfig.abFlags, real-gate-setup.mjs), never its folder name; a round
// without that record, or with mixed rows, is left out with its reason, as are race-score's harness failures. Rows are
// graded again with race-score's rules (regradeRow).
// Per browser: per task passes/runs, median seconds and median tool calls a side (calls are what browser_open lowers);
// per side the median round (the sum of its rows' seconds); browser_open adoption on the on side; error kinds (run error
// classes and tool error prefixes) that only the on side shows; builds and engine versions a side ran on.
// The AO7 bar: the opening median saves 2.5 s per task, with whole-task time, passes and error kinds as guards.
// Product-on and on-prompt are separate cells; prompt-only wins cannot qualify the product.
//   node bench/fowl/as3-score.mjs [round folders or <dir>/<prefix>*] [--json]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandRounds, loadRound } from './race-score.mjs';

export const SAVING_PER_TASK_S = 30 / 12;
const DEFAULT = join(homedir(), 'Projects/sleight-wt/race-1017/as3-ao-*');
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
const readText = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// 'on', 'on-prompt', 'off', or { problem } when the rows don't say or disagree.
export function roundSide(saved) {
  if (!Array.isArray(saved) || !saved.length) return { problem: 'no saved rows' };
  const values = new Set(saved.map(row => row.agentConfig?.abFlags?.SLEIGHT_BROWSER_CORE));
  if (values.size > 1) return { problem: 'rows disagree on SLEIGHT_BROWSER_CORE' };
  const [value] = values;
  const prompts = new Set(saved.map(row => row.agentConfig?.as3WindowPrompt ?? false));
  if (prompts.size !== 1 || ![true, false].includes([...prompts][0])) return { problem: 'rows disagree on AS3_WINDOW_PROMPT or have an invalid value' };
  if (value === false && prompts.has(true)) return { problem: 'window prompt recorded without browser core' };
  return typeof value === 'boolean' ? (value ? prompts.has(true) ? 'on-prompt' : 'on' : 'off') : { problem: 'SLEIGHT_BROWSER_CORE not recorded (build without the AS-3 plumbing)' };
}

// The first successful result with a task page in a non-gate window. A browser_open reply can carry its gate
// acquisition before the page tree, so inspect each Window block. Missing clocks or page proof never score as zero.
export function openingPhase(eventsText = '', started) {
  let start = Number.isFinite(started) ? started : null, calls = 0;
  for (const line of String(eventsText).split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const parsed = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
    const time = Number.isFinite(event.t) ? event.t : Number.isFinite(parsed) ? parsed : null;
    start ??= time; // Without run.started, the first timestamp is after the model's first turn, so this understates it.
    for (const item of event.message?.content ?? []) {
      if (item.type === 'tool_use') calls++;
      if (item.type !== 'tool_result' || item.is_error === true || time == null || start == null || time < start) continue;
      const text = typeof item.content === 'string' ? item.content : (item.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
      const blocks = text.match(/^Window: [^\n]*\n[\s\S]*?(?=^Window: |$(?![\s\S]))/gm) ?? [];
      if (blocks.some(block => !/Sleight Gate /i.test(block.split('\n')[0]) && /\bURL: (?:http:\/\/)?127\.0\.0\.1:54\d{2}\//.test(block)))
        return { seconds: (time - start) / 1000, calls };
    }
  }
  return null;
}

// browser_open calls in one task's stream-json events, and how many came back as errors.
export function browserOpenUse(eventsText = '') {
  const ids = new Set();
  let calls = 0, errors = 0;
  for (const line of String(eventsText).split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    for (const item of event.message?.content || []) {
      if (item.type === 'tool_use' && /(?:^|__)browser_open$/.test(item.name ?? '')) { calls++; ids.add(item.id); }
      if (item.type === 'tool_result' && item.is_error === true && ids.has(item.tool_use_id)) errors++;
    }
  }
  return { calls, errors };
}

// Tool calls in one task's events.
export const toolCalls = (eventsText = '') => String(eventsText).split('\n').reduce((sum, line) => {
  let event; try { event = JSON.parse(line); } catch { return sum; }
  return sum + (event.message?.content || []).filter(item => item.type === 'tool_use').length;
}, 0);

// A tool error's kind: the label before its first colon ("Flow rules", "browser_open"), else its first five words, with
// numbers and quoted text blanked so one kind doesn't split by value.
export const errorKind = text => {
  const flat = String(text).replace(/\s+/g, ' ').trim().replace(/"[^"]*"|'[^']*'/g, '"…"').replace(/\d+/g, '#');
  const label = /^([^:.]{1,40}):/.exec(flat)?.[1];
  return label ?? flat.split(' ').slice(0, 5).join(' ');
};
export function toolErrorKinds(eventsText = '') {
  const kinds = new Set();
  for (const line of String(eventsText).split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    for (const item of event.message?.content || []) if (item.type === 'tool_result' && item.is_error === true)
      kinds.add(errorKind(typeof item.content === 'string' ? item.content : (item.content || []).map(c => c.text ?? '').join(' ')));
  }
  return kinds;
}

export function loadAbRound(dir, options) {
  const round = loadRound(dir, options);
  const saved = readJson(join(dir, 'results.json'));
  const side = roundSide(saved);
  const promptProblem = /-on-prompt-/.test(basename(dir)) && side === 'on'
    ? 'on-prompt folder but AS3_WINDOW_PROMPT was not recorded; prompt plumbing may be missing' : null;
  const rows = round.rows.map(row => {
    const events = readText(join(dir, row.task, 'events.jsonl'));
    const started = saved?.find(r => r.task?.name === row.task)?.run?.started;
    return { ...row, opening: openingPhase(events, started), browserOpen: browserOpenUse(events), calls: toolCalls(events), kinds: [...toolErrorKinds(events), ...(row.errorClass?.class ? [`run: ${row.errorClass.class}`] : [])] };
  });
  return { ...round, rows, side: typeof side === 'string' ? side : null,
    excluded: round.excluded ?? promptProblem ?? (typeof side === 'string' ? null : side.problem) };
}

export function scoreAb(rounds) {
  const browsers = {};
  for (const round of rounds) if (!round.excluded) ((browsers[round.browser] ??= { off: [], on: [], 'on-prompt': [] })[round.side]).push(round);
  const out = {};
  for (const [browser, sides] of Object.entries(browsers)) {
    const tasks = [...new Set(Object.values(sides).flat().flatMap(r => r.rows.map(row => row.task)))].sort();
    const side = list => {
      const rows = list.flatMap(r => r.rows);
      const perTask = Object.fromEntries(tasks.map(task => {
        const mine = rows.filter(row => row.task === task), passed = mine.filter(row => row.passed);
        return [task, { runs: mine.length, passes: passed.length, rate: mine.length ? passed.length / mine.length : null,
          medianS: median(passed.map(row => row.seconds)), medianCalls: median(mine.map(row => row.calls)),
          openingS: median(mine.filter(row => row.opening).map(row => row.opening.seconds)),
          openingCalls: median(mine.filter(row => row.opening).map(row => row.opening.calls)) }];
      }));
      const roundS = list.map(r => r.rows.reduce((sum, row) => sum + row.seconds, 0));
      return { rounds: list.map(r => r.name), roundS, medianRoundS: median(roundS), perTask,
        completeTasks: list.every(r => r.rows.length === tasks.length && tasks.every(task => r.rows.filter(row => row.task === task).length === 1)),
        opening: { medianS: median(rows.filter(row => row.opening).map(row => row.opening.seconds)),
          medianCalls: median(rows.filter(row => row.opening).map(row => row.opening.calls)), measured: rows.filter(row => row.opening).length, of: rows.length },
        kinds: [...new Set(rows.flatMap(row => row.kinds))].sort(),
        adoption: { tasks: rows.filter(row => row.browserOpen.calls > 0).length, of: rows.length,
          calls: rows.reduce((s, row) => s + row.browserOpen.calls, 0), errors: rows.reduce((s, row) => s + row.browserOpen.errors, 0) },
        builds: [...new Set(list.map(r => r.commits?.build?.commit?.slice(0, 8) ?? 'unknown'))],
        engines: [...new Set(list.map(r => r.engine?.version ?? 'unknown'))] };
    };
    const off = side(sides.off), on = side(sides.on);
    const compare = on => {
      const saving = off.medianRoundS != null && on.medianRoundS != null ? off.medianRoundS - on.medianRoundS : null, barS = SAVING_PER_TASK_S;
      // Less noisy than round sums: per-task median seconds (tasks both sides passed) and median calls, summed over tasks.
      const both = tasks.filter(task => off.perTask[task].medianS != null && on.perTask[task].medianS != null);
      const taskSaving = both.length ? both.reduce((sum, task) => sum + off.perTask[task].medianS - on.perTask[task].medianS, 0) : null;
      const callSaving = tasks.reduce((sum, task) => sum + (off.perTask[task].medianCalls ?? 0) - (on.perTask[task].medianCalls ?? 0), 0);
      const lost = tasks.filter(task => off.perTask[task].rate != null && (on.perTask[task].rate ?? 0) < off.perTask[task].rate);
      const newKinds = on.kinds.filter(kind => !off.kinds.includes(kind));
      const unlike = [...(off.builds.join() !== on.builds.join() ? ['builds differ'] : []), ...(off.engines.join() !== on.engines.join() ? ['engine versions differ'] : [])];
      const openingSaving = off.opening.medianS != null && on.opening.medianS != null ? off.opening.medianS - on.opening.medianS : null;
      const problems = [...(openingSaving == null ? ['opening phase missing on a side'] : openingSaving < SAVING_PER_TASK_S ? [`opening median saving ${openingSaving.toFixed(1)} s, under ${SAVING_PER_TASK_S.toFixed(1)} s`] : []),
        ...(off.opening.measured !== off.opening.of || on.opening.measured !== on.opening.of ? ['opening phase missing for some tasks'] : []),
        ...(!off.completeTasks || !on.completeTasks ? ['task coverage differs between rounds'] : []),
        ...(saving == null ? ['a side has no scored round'] : saving < 0 ? ['whole-task median round is slower'] : []),
        ...(on.adoption.of === 0 || on.adoption.tasks / on.adoption.of < 0.8 ? ['browser_open adoption under 80 percent'] : []),
        ...lost.map(task => `lost ${task}`), ...newKinds.map(kind => `new error kind "${kind}"`), ...unlike];
      return { tasks, off, on, saving, barS, openingSaving, openingBarS: SAVING_PER_TASK_S, taskSaving, callSaving, lost, newKinds, unlike, pass: problems.length === 0, problems };
    };
    out[browser] = { ...compare(on), ...(sides['on-prompt'].length ? { prompt: compare(side(sides['on-prompt'])) } : {}) };
  }
  const defaultOn = ['safari', 'firefox'].every(browser => out[browser]?.pass === true && out[browser].off.rounds.length >= 5 && out[browser].on.rounds.length >= 5);
  return { browsers: out, defaultOn };
}

function print(rounds, scored) {
  const n = x => x == null ? '-' : x.toFixed(1);
  console.log('Rounds:');
  for (const r of rounds) console.log(`  ${r.name} (${r.browser}, ${r.side ?? 'side unknown'}, ${r.rows.length} rows${r.commits?.build?.commit ? `, build ${r.commits.build.commit.slice(0, 8)}` : ''}, engine ${r.engine?.version ?? 'unknown'}): ${r.excluded ? `excluded, ${r.excluded}` : 'scored'}`);
  for (const [browser, s] of Object.entries(scored.browsers)) {
    console.log(`\n${browser}. Cell: passes/runs, median s of passes, median tool calls of runs.`);
    console.log('task'.padEnd(16) + 'off'.padStart(26) + 'on'.padStart(26));
    for (const task of s.tasks) console.log(task.padEnd(16) + [s.off, s.on].map(side => {
      const t = side.perTask[task];
      return `${t.passes}/${t.runs} ${n(t.medianS)} s ${t.medianCalls ?? '-'} calls`.padStart(26);
    }).join(''));
    console.log(`median round s: off ${n(s.off.medianRoundS)} (${s.off.roundS.map(n).join(', ') || 'none'}), on ${n(s.on.medianRoundS)} (${s.on.roundS.map(n).join(', ') || 'none'}), saving ${n(s.saving)}`);
    console.log(`summed per-task median saving ${n(s.taskSaving)} s, summed median call saving ${s.callSaving}`);
    console.log(`opening median: off ${n(s.off.opening.medianS)} s / ${n(s.off.opening.medianCalls)} calls, on ${n(s.on.opening.medianS)} s / ${n(s.on.opening.medianCalls)} calls, saving ${n(s.openingSaving)} s, bar ${n(s.openingBarS)} s`);
    for (const task of s.tasks) console.log(`  ${task} opening: off ${n(s.off.perTask[task].openingS)} s / ${n(s.off.perTask[task].openingCalls)} calls, on ${n(s.on.perTask[task].openingS)} s / ${n(s.on.perTask[task].openingCalls)} calls`);
    if (s.prompt) {
      console.log(`on + prompt (separate cell): opening ${n(s.prompt.on.opening.medianS)} s / ${n(s.prompt.on.opening.medianCalls)} calls, saving ${n(s.prompt.openingSaving)} s; whole-task median round ${n(s.prompt.on.medianRoundS)} s; adoption ${s.prompt.on.adoption.tasks}/${s.prompt.on.adoption.of}; bar ${s.prompt.pass ? 'met' : s.prompt.problems.join('; ')}`);
      for (const task of s.tasks) { const t = s.prompt.on.perTask[task]; console.log(`  ${task} on + prompt: ${t.passes}/${t.runs}, ${n(t.medianS)} s, opening ${n(t.openingS)} s / ${n(t.openingCalls)} calls`); }
    }
    console.log(`browser_open on the on side: ${s.on.adoption.tasks} of ${s.on.adoption.of} tasks, ${s.on.adoption.calls} calls, ${s.on.adoption.errors} errors`);
    console.log(`builds: off ${s.off.builds.join(', ') || 'none'}, on ${s.on.builds.join(', ') || 'none'}; engines: off ${s.off.engines.join(', ') || 'none'}, on ${s.on.engines.join(', ') || 'none'}`);
    console.log(`error kinds only on: ${s.newKinds.length ? s.newKinds.join(' | ') : 'none'}`);
    console.log(`bar: ${s.pass ? 'met' : `not met (${s.problems.join('; ')})`}`);
  }
  console.log(`\nDefault-on: ${scored.defaultOn ? 'yes, the bar is met in Safari and Firefox' : 'no'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dirs = args.filter(a => !a.startsWith('--'));
  const rounds = expandRounds(dirs.length ? dirs : [DEFAULT]).map(dir => loadAbRound(dir));
  const scored = scoreAb(rounds);
  if (args.includes('--json')) console.log(JSON.stringify({ rounds, ...scored }, null, 1));
  else print(rounds, scored);
}
