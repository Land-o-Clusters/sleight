// Offline report only. Never evaluates transcript code, launches a process or drives an app.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTranscript, matchRun, RULES } from './turn-study.mjs';

const RELAY = 'plugins/sleight/lib/relay.mjs';
const SKILL = 'plugins/sleight/skills/drive-mac-apps/SKILL.md';
// Mechanism associations are hypotheses about costs, not causal findings from transcripts.
export const MECHANISMS = Object.freeze({
  'spilled-result': { mechanism: 'relay result trimming', file: RELAY },
  'spill-filter-followup': { mechanism: 'relay result trimming', file: RELAY },
  'nonexistent-method': { mechanism: 'tool description and API documentation', file: RELAY },
  'refused-tool': { mechanism: 'skill tool selection', file: SKILL },
  'wait-after-save': { mechanism: 'skill wait guidance and guard settling read', file: SKILL },
  'split-menu-click': { mechanism: 'tool description batching guidance', file: RELAY },
  'saved-unconfirmed-read': { mechanism: 'relay verification note', file: RELAY },
  'consecutive-read': { mechanism: 'relay result and guard read overlap', file: RELAY },
  'lease-or-guard-refusal': { mechanism: 'input lease and window guard', file: RELAY },
  'preliminary-inventory': { mechanism: 'tool description first acquisition guidance', file: RELAY },
  'explicit-delay': { mechanism: 'skill wait guidance', file: SKILL },
  'empty-tree-after-launch': { mechanism: 'launch readiness and tree recovery', file: 'plugins/sleight/lib/launch.mjs' },
  'front-app-changed-after-launch': { mechanism: 'background launch focus handling', file: 'plugins/sleight/lib/launch.mjs' },
  'list-did-not-scroll': { mechanism: 'skill scroll recovery guidance', file: SKILL },
});
const classNames = new Set([...Object.keys(RULES), ...Object.keys(MECHANISMS)]);
const round = n => Math.round(n * 1000) / 1000;
const token = (v, kind) => {
  if (typeof v !== 'string' || v.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v)) throw new Error(`Invalid ${kind}.`);
  return v;
};
const number = v => {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('Invalid measurement.');
  return v;
};
const date = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const seconds = ms => ms == null ? null : number(ms) / 1000;
const median = values => {
  const a = values.filter(v => v != null).sort((x, y) => x - y), n = a.length;
  return { median: n ? round(n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null, n };
};
const metric = (rows, key) => median(rows.map(r => r[key]));
const countMetric = (rows, key) => {
  const a = rows.map(r => r[key]).filter(v => v != null);
  return { ...median(a), sum: a.length ? round(a.reduce((s, n) => s + n, 0)) : null };
};
const group = (rows, key) => Map.groupBy(rows, key);
const context = r => JSON.stringify([r.task, r.app, r.run, r.stamp, r.setup, r.load, r.model]);
const identity = r => JSON.stringify([r.arm, context(r), r.experiment]);
const cleanCalls = calls => Array.isArray(calls) ? calls.map(c => ({
  classes: Array.isArray(c.classes) ? [...new Set(c.classes.filter(n => classNames.has(n)))] : [],
  attributableMs: number(c.attributableMs),
})) : null;

export function splitApp(bundleId) {
  // Fixed independent buckets, approximately half each; adding an app never reassigns another.
  return createHash('sha256').update(token(bundleId, 'bundle ID')).digest()[0] % 2 ? 'test' : 'learn';
}

function normalize(raw) {
  const app = raw.bundleId ?? raw.bundle ?? raw.app?.bundleId ?? raw.app;
  const totalSeconds = number(raw.totalSeconds ?? raw.seconds ?? seconds(raw.timing?.totalMs));
  const turns = number(raw.turns), modelSeconds = number(raw.modelSeconds ?? seconds(raw.modelMs ?? raw.timing?.modelMs));
  const events = raw.windowOrder?.events ?? raw.windowOrderEvents;
  const eventCount = type => Array.isArray(events) ? events.filter(e => e.type === type).length : null;
  const pass = raw.pass ?? raw.passed;
  if (typeof pass !== 'boolean') throw new Error('Invalid pass value.');
  const samples = raw.windows?.samples;
  const episodes = key => {
    if (!Array.isArray(samples) || !samples.length || samples.some(s => typeof s[key] !== 'boolean')) return null;
    return samples.filter((s, i) => s[key] && !samples[i - 1]?.[key]).length;
  };
  const split = raw.footprint?.split;
  const cpu = split && ['sleight', 'engine', 'client', 'other'].every(k => typeof split[k] === 'number')
    ? ['sleight', 'engine', 'client', 'other'].reduce((s, k) => s + number(split[k]), 0) : null;
  if (!Number.isInteger(raw.run) || raw.run < 1) throw new Error('Invalid run coordinate.');
  const result = { arm: token(raw.arm, 'arm'), app: token(app, 'bundle ID'), task: token(raw.task, 'task'), run: raw.run,
    pass, totalSeconds, turns, modelSeconds,
    modelSecondsPerTurn: turns > 0 && modelSeconds != null ? modelSeconds / turns : null,
    ownCpuSeconds: number(raw.ownCpuSeconds ?? raw.cpu?.ownSeconds ?? cpu),
    focusSteals: number(raw.focusSteals ?? raw.windowOrder?.focusSteals ?? eventCount('focus-steal') ?? episodes('focusChanged')),
    windowsOverOwner: number(raw.windowsOverOwner ?? raw.windowOrder?.windowsOverOwner ?? eventCount('window-over-owner') ?? episodes('targetOverOwner')),
    startedAt: date(raw.startedAt) == null ? null : new Date(date(raw.startedAt)).toISOString(),
    calls: cleanCalls(raw.calls), wasteCalls: cleanCalls(raw.wasteCalls), flags: {} };
  for (const key of ['stamp', 'setup', 'load', 'model', 'experiment']) {
    if (raw[key] != null) result[key] = token(String(raw[key]), key);
  }
  for (const [key, value] of Object.entries(raw.flags ?? {})) result.flags[token(key, 'flag')] = token(String(value), 'flag value');
  return result;
}

function stats(rows) {
  const passes = rows.filter(r => r.pass).length;
  return { runs: rows.length, passes, passRate: rows.length ? passes / rows.length : null,
    totalSeconds: metric(rows, 'totalSeconds'), turns: metric(rows, 'turns'), modelSeconds: metric(rows, 'modelSeconds'),
    modelSecondsPerTurn: metric(rows, 'modelSecondsPerTurn'), ownCpuSeconds: metric(rows, 'ownCpuSeconds'),
    focusSteals: countMetric(rows, 'focusSteals'), windowsOverOwner: countMetric(rows, 'windowsOverOwner') };
}
function comparison(rows, sleightArm, codexArm) {
  const sleight = stats(rows.filter(r => r.arm === sleightArm)), codex = stats(rows.filter(r => r.arm === codexArm));
  return { sleight, codex, status: !sleight.runs || !codex.runs ? 'incomplete' : sleight.passRate >= codex.passRate ? 'passes' : 'fails' };
}

function rankCalls(rows, runs, sleightArm, codexArm) {
  const analyses = new Map(rows.filter(r => r.calls !== null).map(r => [identity(r), r.calls]));
  const seen = new Set(); let mismatches = 0;
  for (const run of runs) {
    const matches = rows.filter(r => r.arm === run.arm && r.task === run.task && r.run === run.run
      && (!(run.bundleId ?? run.bundle ?? run.app) || r.app === (run.bundleId ?? run.bundle ?? run.app?.bundleId ?? run.app)) && (!run.stamp || r.stamp === run.stamp));
    if (matches.length !== 1 || !Array.isArray(run.calls)) continue;
    const key = identity(matches[0]);
    if (seen.has(key)) analyses.set(key, null); // Ambiguous sources never select the nicer transcript.
    else if (matches[0].calls && matches[0].calls.length !== run.calls.length) {
      analyses.set(key, matches[0].calls); mismatches++;
    } else analyses.set(key, cleanCalls(run.calls));
    seen.add(key);
  }
  const ranked = new Map(); let paired = 0;
  const driverPair = r => JSON.stringify([r.task, r.app, r.run, r.stamp, r.setup, r.load]);
  for (const rs of group(rows.filter(r => [sleightArm, codexArm].includes(r.arm)), driverPair).values()) {
    if (rs.length !== 2 || rs.filter(r => r.arm === sleightArm).length !== 1 || rs.filter(r => r.arm === codexArm).length !== 1) continue;
    const s = rs.find(r => r.arm === sleightArm), c = rs.find(r => r.arm === codexArm);
    const sc = s && analyses.get(identity(s)), cc = c && analyses.get(identity(c));
    if (!sc || !cc) continue;
    paired += 2;
    const key = JSON.stringify([s.app, s.task]);
    if (!ranked.has(key)) ranked.set(key, { app: s.app, task: s.task, pairedRuns: 0,
      sleightCalls: 0, codexCalls: 0, sleightSeconds: 0, codexSeconds: 0, sleightTimedCalls: 0, codexTimedCalls: 0, mechanisms: new Set() });
    const bucket = ranked.get(key); bucket.pairedRuns++;
    for (const [calls, arm] of [[sc, 'sleight'], [cc, 'codex']]) {
      bucket[`${arm}Calls`] += calls.length;
      bucket[`${arm}Seconds`] += calls.reduce((n, call) => n + (call.attributableMs ?? 0) / 1000, 0);
      bucket[`${arm}TimedCalls`] += calls.filter(c => c.attributableMs != null).length;
    }
    for (const call of sc) for (const name of call.classes) bucket.mechanisms.add(name);
  }
  return { mismatches, unpairedTranscripts: rows.filter(r => [sleightArm, codexArm].includes(r.arm)).length - paired,
    ranking: [...ranked.values()].map(r => ({ ...r, savedCalls: r.sleightCalls - r.codexCalls,
      sleightSeconds: r.sleightTimedCalls ? round(r.sleightSeconds) : null,
      codexSeconds: r.codexTimedCalls ? round(r.codexSeconds) : null,
      mechanisms: [...r.mechanisms].sort().map(rule => ({ rule, ...MECHANISMS[rule] })) }))
      .sort((a, b) => b.savedCalls / b.pairedRuns - a.savedCalls / a.pairedRuns || a.task.localeCompare(b.task)) };
}

function mine(rows, studyRuns, sleightArm) {
  const learnRows = rows.filter(r => r.arm === sleightArm && !r.experiment && splitApp(r.app) === 'learn');
  const rules = new Map();
  for (const r of learnRows) {
    const matches = studyRuns.filter(s => s.arm === r.arm && s.task === r.task && s.run === r.run
      && (!(s.bundleId ?? s.bundle ?? s.app) || (s.bundleId ?? s.bundle ?? s.app?.bundleId ?? s.app) === r.app) && (!s.stamp || s.stamp === r.stamp));
    const external = matches.length === 1 && (!r.calls || r.calls.length === matches[0].calls?.length)
      ? cleanCalls(matches[0].calls) : null;
    const calls = external?.some(c => c.classes.length) ? external : r.wasteCalls ?? r.calls ?? external ?? [];
    const seen = new Set();
    for (const c of calls) for (const rule of c.classes) {
      if (!rules.has(rule)) rules.set(rule, { rule, ...MECHANISMS[rule], status: 'candidate', runs: 0, calls: 0, timedCalls: 0, seconds: 0 });
      const item = rules.get(rule); item.calls++;
      if (c.attributableMs != null) { item.seconds += c.attributableMs / 1000; item.timedCalls++; }
      if (!seen.has(rule)) item.runs++;
      seen.add(rule);
    }
  }
  return [...rules.values()].map(r => ({ ...r, seconds: r.timedCalls ? round(r.seconds) : null }))
    .sort((a, b) => b.calls - a.calls || a.rule.localeCompare(b.rule));
}

function validateRule(rows, candidates, ab, sleightArm) {
  if (!ab) return { status: 'not-run', learn: null, test: null };
  ab = Object.fromEntries(['rule', 'flag', 'controlArm', 'treatmentArm', 'controlValue', 'treatmentValue', 'experiment']
    .map(key => [key, token(ab[key], key)]));
  if (ab.controlArm === ab.treatmentArm || ab.controlValue === ab.treatmentValue) throw new Error('Invalid A/B arms.');
  const discovery = rows.filter(r => r.arm === sleightArm && !r.experiment);
  const cutoff = discovery.every(r => date(r.startedAt) != null && r.totalSeconds != null) && discovery.length
    ? Math.max(...discovery.map(r => date(r.startedAt) + r.totalSeconds * 1000)) : null;
  const selected = rows.filter(r => r.experiment === ab.experiment && [ab.controlArm, ab.treatmentArm].includes(r.arm));
  const cohorts = {};
  for (const half of ['learn', 'test']) {
    const rs = selected.filter(r => splitApp(r.app) === half);
    const taskContext = r => JSON.stringify([r.app, r.task, r.setup, r.load, r.model]);
    const expected = new Set(discovery.filter(r => splitApp(r.app) === half).map(taskContext));
    const observed = new Set(rs.map(taskContext));
    const missingTasks = [...expected].filter(k => !observed.has(k)).length;
    let valid = rs.length > 0 && cutoff != null && missingTasks === 0, pairs = 0;
    for (const pair of group(rs, context).values()) {
      const c = pair.find(r => r.arm === ab.controlArm), t = pair.find(r => r.arm === ab.treatmentArm);
      if (pair.length !== 2 || !c || !t) { valid = false; continue; }
      pairs++;
      if (!(date(c.startedAt) > cutoff && date(t.startedAt) > cutoff)
        || [c, t].some(r => ['setup', 'load', 'model'].some(k => !r[k]))
        || c.flags[ab.flag] !== ab.controlValue || t.flags[ab.flag] !== ab.treatmentValue
        || JSON.stringify(Object.entries(c.flags).filter(([k]) => k !== ab.flag).sort())
          !== JSON.stringify(Object.entries(t.flags).filter(([k]) => k !== ab.flag).sort())) valid = false;
    }
    const control = stats(rs.filter(r => r.arm === ab.controlArm)), treatment = stats(rs.filter(r => r.arm === ab.treatmentArm));
    const byApp = [...group(rs, r => r.app)].map(([app, a]) => ({ app,
      control: stats(a.filter(r => r.arm === ab.controlArm)), treatment: stats(a.filter(r => r.arm === ab.treatmentArm)) }));
    const improves = valid && control.totalSeconds.n === control.runs && treatment.totalSeconds.n === treatment.runs
      && treatment.totalSeconds.median < control.totalSeconds.median
      && byApp.every(a => a.control.runs && a.treatment.runs && a.treatment.passRate >= a.control.passRate);
    cohorts[half] = { pairedRuns: pairs, missingTasks, valid, improves, control, treatment, byApp };
  }
  return { ...ab, cutoff: cutoff == null ? null : new Date(cutoff).toISOString(), metric: 'median total seconds, with no app pass-rate regression',
    status: candidates.some(c => c.rule === ab.rule) && cohorts.learn.improves && cohorts.test.improves ? 'proven-in-sample' : 'not-proven', ...cohorts };
}

export function buildReport(rawRows, { studyRuns = [], miningRuns = studyRuns, sleightArm = 'sleight', codexArm = 'codex', ab,
  diagnostics = {}, studyCount = studyRuns.length } = {}) {
  token(sleightArm, 'arm'); token(codexArm, 'arm');
  const rows = rawRows.map(normalize), ids = new Set();
  for (const r of rows) { const id = identity(r); if (ids.has(id)) throw new Error('Duplicate run coordinate.'); ids.add(id); }
  const baseline = rows.filter(r => [sleightArm, codexArm].includes(r.arm) && !r.experiment);
  if (new Set(baseline.map(r => JSON.stringify([r.setup, r.load]))).size > 1) {
    throw new Error('Invalid mixed setup or load. Generate separate reports.');
  }
  const appRows = [...group(baseline, r => r.app)].sort(([a], [b]) => a.localeCompare(b))
    .map(([app, a]) => ({ app, ...comparison(a, sleightArm, codexArm) }));
  const failures = appRows.filter(a => a.status === 'fails').map(a => a.app);
  const callData = rankCalls(baseline, studyRuns, sleightArm, codexArm);
  const candidates = mine(rows, miningRuns, sleightArm);
  const apps = [...new Set(rows.map(r => r.app))].sort();
  return { schemaVersion: 1, inputRows: rows, parity: { apps: appRows,
    overall: comparison(baseline, sleightArm, codexArm), failures,
    status: failures.length ? 'fails' : !appRows.length || appRows.some(a => a.status === 'incomplete') ? 'incomplete' : 'passes' },
    callRanking: callData.ranking, coverage: { resultRuns: rows.length, studyRuns: studyCount, unpairedTranscripts: callData.unpairedTranscripts,
      transcriptCallMismatches: callData.mismatches,
      ...Object.fromEntries(Object.entries(diagnostics).filter(([, v]) => Number.isInteger(v) && v >= 0)) },
    ruleMining: { splitMethod: 'SHA-256(bundle ID), first byte even = learn, odd = test',
      split: { learn: apps.filter(a => splitApp(a) === 'learn'), test: apps.filter(a => splitApp(a) === 'test') },
      candidates, validation: validateRule(rows, candidates, ab, sleightArm) } };
}

// Convert Codex's persisted response records into turn-study's neutral call/result shape.
export function analyzeCodex(rows) {
  const converted = [];
  for (const row of rows) {
    const p = row.payload ?? {};
    if (row.type === 'event_msg' && p.type === 'user_message') converted.push({ type: 'user', timestamp: row.timestamp, message: { content: '' } });
    if (row.type !== 'response_item') continue;
    if (['function_call', 'custom_tool_call'].includes(p.type)) {
      let input; try { input = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments; } catch { input = {}; }
      if (p.type === 'custom_tool_call') input = { code: p.input };
      converted.push({ type: 'assistant', timestamp: row.timestamp, message: { content: [{ type: 'tool_use', id: p.call_id, name: p.name, input }] } });
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) converted.push({ type: 'user', timestamp: row.timestamp,
      message: { content: [{ type: 'tool_result', tool_use_id: p.call_id, content: p.output?.content ?? p.output,
        is_error: p.is_error === true || p.output?.isError === true }] } });
  }
  return analyzeTranscript(converted);
}

const fmt = n => n == null ? 'unknown' : String(round(n));
const measured = v => `${fmt(v.median)} (${v.n})`;
function statsLine(app, arm, s) {
  return `| ${app} | ${arm} | ${s.passes}/${s.runs} | ${s.passRate == null ? 'unknown' : fmt(s.passRate * 100) + '%'} | ${measured(s.totalSeconds)} | ${measured(s.turns)} | ${measured(s.modelSeconds)} | ${measured(s.modelSecondsPerTurn)} | ${measured(s.ownCpuSeconds)} | ${fmt(s.focusSteals.sum)} (${s.focusSteals.n}) | ${fmt(s.windowsOverOwner.sum)} (${s.windowsOverOwner.n}) |`;
}
export function renderMarkdown(r) {
  const out = ['# Battery report', '', `Pass parity: ${r.parity.status}.`, '',
    '| Bundle ID | Arm | Passes/runs | Pass rate | Median total s (n) | Median turns (n) | Median model s (n) | Median model s/turn (n) | Median own CPU s (n) | Focus steals (n) | Windows over owner (n) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const a of [...r.parity.apps, { app: 'overall', ...r.parity.overall }]) {
    out.push(statsLine(a.app, 'sleight', a.sleight), statsLine(a.app, 'Codex', a.codex));
  }
  out.push('', `Apps below Codex: ${r.parity.failures.join(', ') || 'none observed'}.`, '',
    '## Calls on the same task', '',
    '| Bundle ID | Task | Paired runs | Sleight calls | Codex calls | Fewer Codex calls | Sleight attributed s (timed calls) | Codex attributed s (timed calls) | Mechanism hypotheses |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const c of r.callRanking) out.push(`| ${c.app} | ${c.task} | ${c.pairedRuns} | ${c.sleightCalls} | ${c.codexCalls} | ${c.savedCalls} | ${fmt(c.sleightSeconds)} (${c.sleightTimedCalls}) | ${fmt(c.codexSeconds)} (${c.codexTimedCalls}) | ${c.mechanisms.map(m => `${m.rule}: ${m.mechanism} ([file](../../${m.file}))`).join('; ') || 'unclassified'} |`);
  out.push('', '## Rule candidates', '', r.ruleMining.splitMethod + '.', '',
    '| Mechanism | Learn runs | Calls | Attributed s (timed calls) | Status |', '| --- | ---: | ---: | ---: | --- |');
  for (const c of r.ruleMining.candidates) out.push(`| ${c.rule}: ${c.mechanism} ([file](../../${c.file})) | ${c.runs} | ${c.calls} | ${fmt(c.seconds)} (${c.timedCalls}) | ${c.status} |`);
  const v = r.ruleMining.validation;
  out.push('', '## Later flag A/B on held-out apps', '', `Validation: ${v.status}.`, '');
  if (v.test) {
    out.push(`Flag: ${v.flag}, ${v.controlArm} (${v.controlValue}) against ${v.treatmentArm} (${v.treatmentValue}).`, '',
      '| Split | Paired runs | Control passes/runs | Treatment passes/runs | Control median s | Treatment median s | Improves |',
      '| --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const half of ['learn', 'test']) { const a = v[half]; out.push(`| ${half} | ${a.pairedRuns} | ${a.control.passes}/${a.control.runs} | ${a.treatment.passes}/${a.treatment.runs} | ${fmt(a.control.totalSeconds.median)} | ${fmt(a.treatment.totalSeconds.median)} | ${a.improves} |`); }
    out.push('', '| Test bundle ID | Control passes/runs | Treatment passes/runs | Control median s | Treatment median s |', '| --- | ---: | ---: | ---: | ---: |');
    for (const a of v.test.byApp) out.push(`| ${a.app} | ${a.control.passes}/${a.control.runs} | ${a.treatment.passes}/${a.treatment.runs} | ${fmt(a.control.totalSeconds.median)} | ${fmt(a.treatment.totalSeconds.median)} |`);
  }
  out.push('', '## Coverage and interpretation', '',
    `${r.coverage.resultRuns} result rows; ${r.coverage.studyRuns} turn-study rows; ${r.coverage.matchedTranscripts ?? 0} matched transcript files; ${r.coverage.unpairedTranscripts} baseline rows without paired call evidence; ${r.coverage.transcriptCallMismatches} transcript/harness count mismatches.`, '',
    'All attempted runs, including failures, enter medians. Unknown measurements keep their coverage count. Focus and window counts are event totals, not durations.', '',
    'Attributed call seconds include the preceding model and host scheduling gap. Call walls can overlap. Classes can overlap. Mechanism associations need an A/B to establish cause.', '',
    'Rules use only learn apps. A later paired A/B must improve median total time on both halves without reducing any app pass rate. Proven-in-sample describes this sample; it does not establish a population effect.', '',
    'Review limitations in [known problems](../known-problems.md) before publishing.', '');
  return out.join('\n');
}

function filesUnder(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(join(dir, e.name))
    : e.isFile() && e.name.endsWith('.jsonl') ? [join(dir, e.name)] : []); } catch { return []; }
}
function jsonLines(file, diagnostics) {
  const result = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) {
    try { result.push(JSON.parse(line)); } catch { diagnostics.malformedLines++; }
  }
  return result;
}

export function main(argv) {
  const options = { results: [], projects: join(homedir(), 'Library/Caches/sleight-bench/claude-config/projects'),
    'codex-sessions': join(homedir(), '.codex-bench/sessions') };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') { console.log('node bench/battery-report.mjs --results FILE [--results FILE] [--catalog FILE] [--turn-study FILE] [--projects DIR] [--codex-sessions DIR] [--ab FILE] [--json FILE] [--table FILE]'); return; }
    const value = argv[++i];
    if (!value || !['--results', '--catalog', '--turn-study', '--projects', '--codex-sessions', '--ab', '--json', '--table'].includes(key)) throw new Error('Invalid option.');
    if (key === '--results') options.results.push(value); else options[key.slice(2)] = value;
  }
  if (!options.results.length) throw new Error('Supply results.');
  const catalog = options.catalog ? JSON.parse(readFileSync(options.catalog, 'utf8')) : [];
  const catalogRows = Array.isArray(catalog) ? catalog : catalog.runs ?? catalog.tasks;
  if (!Array.isArray(catalogRows)) throw new Error('Invalid catalog.');
  const bundles = new Map();
  for (const c of catalogRows) {
    const task = token(c.task ?? c.id, 'task'), bundle = token(c.bundleId ?? c.bundle, 'bundle ID');
    if (bundles.has(task) && bundles.get(task) !== bundle) throw new Error('Invalid catalog mapping.');
    bundles.set(task, bundle);
  }
  const rawRows = options.results.flatMap(file => {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const rows = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(rows)) throw new Error('Invalid results.');
    return rows.map(r => ({ ...(data.stamp ? { stamp: data.stamp } : {}),
      ...(data.armSetup ? { setup: data.armSetup } : {}), ...(bundles.has(r.task) ? { bundleId: bundles.get(r.task) } : {}), ...r }));
  });
  // Validate before scanning private data. The CLI never opens spill wrapper paths.
  buildReport(rawRows);
  const study = options['turn-study'] ? JSON.parse(readFileSync(options['turn-study'], 'utf8')).runs : [];
  if (!Array.isArray(study)) throw new Error('Invalid turn study.');
  const diagnostics = { malformedLines: 0, matchedTranscripts: 0, ambiguousTranscripts: 0 };
  const sources = new Map();
  for (const [arm, root] of [['sleight', options.projects], ['codex', options['codex-sessions']]]) {
    for (const file of filesUnder(root)) {
      const candidates = rawRows.filter(r => r.arm === arm);
      const filename = basename(file, '.jsonl');
      let matches = candidates.filter(r => r.session === filename || r.sessionId === filename || r.threadId === filename);
      // Codex rollout filenames contain timestamps; metadata supplies the exact session ID.
      if (!matches.length && arm === 'sleight' && !candidates.some(r => !r.session && !r.sessionId)) continue;
      const rows = jsonLines(file, diagnostics);
      if (!matches.length && arm === 'codex') {
        const id = rows.find(r => r.type === 'session_meta')?.payload?.id;
        if (id) matches = candidates.filter(r => r.threadId === id || r.sessionId === id || r.session === id);
      }
      if (!matches.length && arm === 'sleight') {
        const match = matchRun(rows, candidates);
        if (match.run) matches = [match.run];
      }
      if (matches.length !== 1) { if (matches.length) diagnostics.ambiguousTranscripts++; continue; }
      const metadata = matches[0], key = identity(normalize(metadata));
      if (sources.has(key)) { sources.set(key, null); diagnostics.ambiguousTranscripts++; continue; }
      const analysis = arm === 'codex' ? analyzeCodex(rows) : analyzeTranscript(rows);
      sources.set(key, { ...metadata, calls: analysis.calls }); diagnostics.matchedTranscripts++;
    }
  }
  const analyses = [...sources.values()].filter(Boolean);
  diagnostics.matchedTranscripts = analyses.length;
  const attached = new Set(analyses.map(r => identity(normalize(r))));
  const mappedStudy = study.flatMap(s => {
    const matches = rawRows.filter(r => r.arm === s.arm && r.task === s.task && r.run === s.run
      && (!s.stamp || r.stamp === s.stamp));
    return matches.length === 1 ? [{ ...matches[0], calls: s.calls }] : [];
  });
  const supplemental = mappedStudy.filter(s => !attached.has(identity(normalize(s))));
  const studied = new Set(mappedStudy.map(r => identity(normalize(r))));
  const report = buildReport(rawRows, { studyRuns: [...analyses, ...supplemental],
    miningRuns: [...mappedStudy, ...analyses.filter(r => !studied.has(identity(normalize(r))))],
    studyCount: study.length, diagnostics, ab: options.ab ? JSON.parse(readFileSync(options.ab, 'utf8')) : undefined });
  const markdown = renderMarkdown(report);
  const inputs = [...options.results, options.catalog, options['turn-study'], options.ab, ...filesUnder(options.projects), ...filesUnder(options['codex-sessions'])]
    .filter(Boolean).map(path => resolve(path));
  for (const key of ['json', 'table']) if (options[key] && inputs.includes(resolve(options[key]))) throw new Error('Output overlaps input.');
  if (options.json) writeFileSync(options.json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (options.table) writeFileSync(options.table, markdown, { flag: 'wx' });
  console.log(markdown);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch { console.error('battery-report failed. Check input schema, unique run coordinates and output permissions.'); process.exitCode = 1; }
}
