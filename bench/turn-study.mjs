// Offline only. No transcript code is evaluated and no process is launched.
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const RULES = Object.freeze({
  'spilled-result': 'Claude Code persisted-output wrapper naming a tool-results file; charged to the producing call.',
  'spill-filter-followup': 'Consecutive read-only calls with split/filter/slice/includes/match after a spilled result, ending at input or an unknown call.',
  'nonexistent-method': 'An error result contains is not a function or is not defined.',
  'refused-tool': 'An error result says No such tool available or a tool is disabled for this session.',
  'wait-after-save': 'waitFor in a Cmd+S call or the next call; the entire call is charged.',
  'split-menu-click': 'One click opens an observed menu and the next call clicks an observed item in that menu; charged to the second call.',
  'saved-unconfirmed-read': 'Read-only call immediately after a result containing saved: not confirmed.',
  'consecutive-read': 'Read-only call immediately after a read-only call, excluding failed calls.',
  'lease-or-guard-refusal': 'Error result contains Input lease, nothing from this call ran, or sleight stopped before.',
  'preliminary-inventory': 'Read-only getState/listApps call followed immediately by getApp; charged to the inventory call.',
  'explicit-delay': 'Call contains setTimeout or sleep; the entire call is charged.',
});
const READ = new Set(['getApp', 'getState', 'listApps', 'getAXState', 'getAXStateAndScreenshot', 'getScreenshot']);
const PURE = new Set([...READ, 'write', 'emitImage', 'then', 'catch', 'split', 'filter', 'slice', 'join', 'includes', 'test', 'match', 'map', 'find', 'trim', 'stringify', 'keys', 'replace', 'replaceAll', 'startsWith', 'endsWith', 'toLowerCase']);
const ACTION = /\.(?:click|pressKey|typeText|paste|setValue|selectText|drag|scroll|performSecondaryAction|hover|openFile|waitFor)\s*\(/;
const SAVE = /\.pressKey\s*\(\s*(?:\{[^}]*\bkey\s*:\s*)?["'](?:super|cmd|command|meta)\+s["']/i;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : '';
const blocksOf = row => Array.isArray(row.message?.content) ? row.message.content : [];
const time = value => { const n = Date.parse(value); return Number.isFinite(n) ? n : null; };
const delta = (a, b) => a !== null && b !== null && a >= b ? a - b : null;
const bytes = value => Buffer.byteLength(value, 'utf8');
const round = n => Math.round(n * 1000) / 1000;
const codeOf = block => block.input?.code ?? '';
const jsTool = name => /(?:^|__)js$/.test(name);

function readOnly(block) {
  if (!jsTool(block.name)) return false;
  const code = codeOf(block);
  const methods = [...code.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  if (ACTION.test(code) || /\b(?:new|eval|setTimeout|sleep|require|import)\b|\]\s*\(/.test(code)) return false;
  return (methods.some(m => READ.has(m)) && methods.every(m => PURE.has(m))) || /^\s*app\s*;?\s*$/.test(code);
}

// Treat wrapper paths as untrusted data. Read only the owning session's ordinary result files.
function resultInfo(block, transcriptPath) {
  const wrapper = textOf(block.content);
  const spill = /<persisted-output>/.test(wrapper) && /Full output saved to:[^\n]*[\\/]tool-results[\\/]/.test(wrapper);
  const info = { text: wrapper, wrapperBytes: bytes(JSON.stringify(block.content ?? '')),
    resultTextBytes: bytes(wrapper), resultBytes: bytes(JSON.stringify(block.content ?? '')), spillStatus: spill ? 'unavailable' : 'none' };
  if (!spill || !transcriptPath) return info;
  const target = wrapper.match(/Full output saved to:\s*([^\n\r]+)/)?.[1]?.trim();
  try {
    const expanded = target?.startsWith('~/') ? join(homedir(), target.slice(2)) : target;
    const root = realpathSync(join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'tool-results'));
    const file = realpathSync(expanded);
    if (!file.startsWith(root + sep)) return info;
    const raw = readFileSync(file, 'utf8');
    let full; try { full = JSON.parse(raw); } catch { full = raw; }
    info.text = textOf(full) || textOf(full?.content) || (typeof full === 'string' ? full : '');
    info.resultBytes = bytes(raw); info.resultTextBytes = bytes(info.text); info.spillStatus = 'read';
  } catch { /* Missing or removed spill files remain measured previews. */ }
  return info;
}

function click(code) {
  const matches = [...code.matchAll(/\.click\s*\(\s*(?:\{\s*(?:id\s*:\s*(\d+)|label\s*:\s*["']([^"']+)["'])|(\d+)|["']([^"']+)["'])/g)];
  return matches.length === 1 ? { id: matches[0][1] ?? matches[0][3], label: matches[0][2] ?? matches[0][4] } : null;
}
function lineFor(tree, target) {
  if (!target) return '';
  return tree.split('\n').find(line => target.id ? new RegExp(`^\\s*${target.id}\\s`).test(line)
    : line.includes(target.label)) ?? '';
}

export function analyzeTranscript(rows, { transcriptPath } = {}) {
  const pending = new Map(), results = new Map();
  for (const row of rows) {
    for (const block of blocksOf(row)) {
      if (block.type === 'tool_use' && !pending.has(block.id)) pending.set(block.id, { block, at: time(row.timestamp) });
      if (block.type === 'tool_result' && !results.has(block.tool_use_id)) results.set(block.tool_use_id, { block, at: time(row.timestamp) });
    }
  }
  const firstUser = rows.find(r => r.type === 'user' && !blocksOf(r).some(b => b.type === 'tool_result'));
  let frontier = time(firstUser?.timestamp), previous = null, spillChain = false, lastStart = null;
  const calls = [];
  for (const [id, entry] of pending) {
    const returned = results.get(id), info = resultInfo(returned?.block ?? {}, transcriptPath);
    const code = codeOf(entry.block), error = returned?.block.is_error === true;
    const modelGapMs = entry.at === null || frontier === null || (lastStart !== null && entry.at < lastStart)
      ? null : Math.max(0, entry.at - frontier);
    const wallMs = delta(returned?.at ?? null, entry.at);
    const read = readOnly(entry.block) && !error;
    const classes = [];
    const add = name => classes.push(name);
    if (info.spillStatus !== 'none') add('spilled-result');
    if (spillChain && read && /\.(?:split|filter|slice|includes|match)\s*\(/.test(code)) add('spill-filter-followup');
    if (error && /\bis not (?:a function|defined)\b/.test(info.text)) add('nonexistent-method');
    if (error && /No such tool available:|\bis disabled for this session\b/i.test(info.text)) add('refused-tool');
    if (/\.waitFor\s*\(/.test(code) && (SAVE.test(code) || (previous && SAVE.test(previous.code)))) add('wait-after-save');
    if (read && previous && /saved:\s*not confirmed/i.test(previous.info.text)) add('saved-unconfirmed-read');
    if (read && previous?.read) add('consecutive-read');
    if (error && /Input lease|nothing from this call ran|sleight stopped before/i.test(info.text)) add('lease-or-guard-refusal');
    if (/\b(?:setTimeout|sleep)\s*\(/.test(code)) add('explicit-delay');
    if (previous && click(previous.code) && click(code) && /(?:^|\n)\s*\d+ menu\b(?! bar)/.test(previous.info.text)
      && lineFor(previous.info.text, click(code)) && previous.menuOpener) add('split-menu-click');
    const lastTree = previous?.info.text ?? '';
    const targetLine = lineFor(lastTree, click(code));
    // A menu bar child has a plain label; buttons and text fields have role names.
    const menuOpener = /\d+ menu bar\b/.test(lastTree) && /^\s*\d+ (?:File|Edit|Format|View|Window|Tools|Table|Insert|Help)\s*$/.test(targetLine);
    if (previous?.read && /\.(?:getState|listApps)\s*\(/.test(previous.code) && /\.getApp\s*\(/.test(code)) previous.call.classes.push('preliminary-inventory');
    const call = { index: calls.length + 1, tool: /^(?:[\w]+)$/.test(entry.block.name ?? '') ? entry.block.name : 'unknown',
      startedAt: entry.at === null ? null : new Date(entry.at).toISOString(),
      endedAt: returned?.at == null ? null : new Date(returned.at).toISOString(),
      wallMs, modelGapMs, attributableMs: wallMs === null || modelGapMs === null ? null : wallMs + modelGapMs,
      resultBytes: returned ? info.resultBytes : null, resultTextBytes: returned ? info.resultTextBytes : null,
      wrapperBytes: returned ? info.wrapperBytes : null, spillStatus: info.spillStatus, readOnly: read, error, classes };
    calls.push(call);
    previous = { call, code, read, info, menuOpener };
    spillChain = info.spillStatus !== 'none' || (spillChain && read);
    // A parallel call cannot own another model gap until earlier results have arrived.
    const end = returned?.at ?? entry.at;
    if (end !== null) frontier = frontier === null ? end : Math.max(frontier, end);
    lastStart = entry.at;
  }
  return { startedAt: firstUser?.timestamp ?? null, calls,
    unknownWallCalls: calls.filter(c => c.wallMs === null).length,
    unknownGapCalls: calls.filter(c => c.modelGapMs === null).length };
}

function totals(items) {
  return { calls: items.length, timedCalls: items.filter(c => c.attributableMs !== null).length,
    wallSeconds: round(items.reduce((s, c) => s + (c.wallMs ?? 0), 0) / 1000),
    modelGapSeconds: round(items.reduce((s, c) => s + (c.modelGapMs ?? 0), 0) / 1000),
    attributableSeconds: round(items.reduce((s, c) => s + (c.attributableMs ?? 0), 0) / 1000) };
}
export function summarize(runs) {
  const byClass = new Map(), byTask = new Map();
  for (const [i, run] of runs.entries()) for (const call of run.calls) for (const name of call.classes) {
    for (const [map, key, props] of [[byClass, name, { class: name }], [byTask, `${run.task}:${name}`, { task: run.task, class: name }]]) {
      if (!map.has(key)) map.set(key, { props, calls: [], runs: new Set() });
      const bucket = map.get(key); bucket.calls.push(call); bucket.runs.add(i);
    }
  }
  const flatten = map => [...map.values()].map(b => ({ ...b.props, runsAffected: b.runs.size, ...totals(b.calls) }))
    .sort((a, b) => b.attributableSeconds - a.attributableSeconds || a.class.localeCompare(b.class));
  return { classes: flatten(byClass), byTask: flatten(byTask),
    unique: { runsAffected: runs.filter(r => r.calls.some(c => c.classes.length)).length,
      ...totals(runs.flatMap(r => r.calls.filter(c => c.classes.length))) }, all: totals(runs.flatMap(r => r.calls)) };
}

export function matchRun(rows, runs) {
  const prompts = rows.filter(r => r.type === 'user' && !blocksOf(r).some(b => b.type === 'tool_result')).map(r => textOf(r.message?.content)).join('\n');
  const exact = runs.filter(r => prompts.includes(`sleight-bench/${r.stamp}/${r.arm}-${r.task}-${r.run}/`));
  if (exact.length === 1) return { status: 'prompt', run: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous' };
  const first = rows.flatMap(r => blocksOf(r).filter(b => b.type === 'tool_use').map(block => ({ block, at: time(r.timestamp) })))[0];
  const traced = first ? runs.filter(r => r.firstCode === codeOf(first.block) && first.at !== null && time(r.firstCallAt) !== null
    && Math.abs(time(r.firstCallAt) - first.at) <= 2000) : [];
  if (traced.length === 1) return { status: 'trace', run: traced[0] };
  if (traced.length > 1) return { status: 'ambiguous' };
  const state = rows.findLast(r => r.type === 'cost-state');
  const values = Object.values(state?.modelUsage ?? {});
  const fingerprint = values.length ? {
    input: values.reduce((s, v) => s + (v.inputTokens ?? 0), 0),
    output: values.reduce((s, v) => s + (v.outputTokens ?? 0), 0),
    cacheRead: values.reduce((s, v) => s + (v.cacheReadInputTokens ?? 0), 0),
    cacheWrite: values.reduce((s, v) => s + (v.cacheCreationInputTokens ?? 0), 0),
  } : null;
  const usage = fingerprint ? runs.filter(r => r.usage && Object.entries(fingerprint).every(([k, v]) => r.usage[k] === v)) : [];
  return usage.length === 1 ? { status: 'usage', run: usage[0] } : { status: usage.length > 1 ? 'ambiguous' : 'unmatched' };
}

function filesUnder(dir, extension) {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(join(dir, e.name), extension)
    : e.isFile() && e.name.endsWith(extension) ? [join(dir, e.name)] : []); } catch { return []; }
}
function jsonRows(file, diagnostics) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) {
    try { rows.push(JSON.parse(line)); } catch { diagnostics.malformedLines++; }
  }
  return rows;
}
function loadRuns(files, scratch, diagnostics) {
  const runs = new Map();
  for (const file of files) {
    let data; try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { diagnostics.invalidResultFiles++; continue; }
    if (!data.stamp || !Array.isArray(data.results)) continue;
    for (const row of data.results) {
      if (!/^[a-z][a-z0-9-]*$/.test(row.arm ?? '') || !/^[a-z][a-z0-9-]*$/.test(row.task ?? '') || !Number.isInteger(row.run)) continue;
      const key = `${data.stamp}/${row.arm}-${row.task}-${row.run}`;
      if (runs.has(key)) { runs.get(key).resultCopies++; continue; }
      const run = { stamp: data.stamp, arm: row.arm, task: row.task, run: row.run, resultCopies: 1,
        reportedSeconds: row.seconds ?? null, reportedTurns: row.turns ?? null,
        usage: row.usage ? Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(k => [k, row.usage[k]])) : null,
        timing: row.timing ? Object.fromEntries(['totalMs', 'modelMs', 'toolMs', 'calls'].filter(k => typeof row.timing[k] === 'number').map(k => [k, row.timing[k]])) : null };
      for (const base of scratch) {
        const traces = filesUnder(join(base, key), '.jsonl').filter(f => /^trace-\d+\.jsonl$/.test(basename(f)));
        const calls = traces.flatMap(f => jsonRows(f, diagnostics)).filter(r => r.direction === 'call-received' && r.msg?.params?.name === 'js')
          .sort((a, b) => time(a.t) - time(b.t));
        if (calls.length) { run.firstCode = calls[0].msg.params.code ?? calls[0].msg.params.arguments?.code; run.firstCallAt = calls[0].t; break; }
      }
      runs.set(key, run);
    }
  }
  return [...runs.values()];
}
const publicRun = run => Object.fromEntries(Object.entries(run).filter(([k]) => !['firstCode', 'firstCallAt'].includes(k)));
const stampTime = stamp => time(stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
function table(summary, key) {
  const task = key === 'byTask';
  return [`| ${task ? 'Task | ' : ''}Class | Runs | Calls | Gap s | Call s | Attributed s |`,
    `| ${task ? '--- | ' : ''}--- | ---: | ---: | ---: | ---: | ---: |`,
    ...summary[key].map(r => `| ${task ? `${r.task} | ` : ''}${r.class} | ${r.runsAffected} | ${r.calls} | ${r.modelGapSeconds.toFixed(3)} | ${r.wallSeconds.toFixed(3)} | ${r.attributableSeconds.toFixed(3)} |`)].join('\n');
}

export function main(argv) {
  const options = { resultDirs: [], scratch: [], projects: join(homedir(), 'Library/Caches/sleight-bench/claude-config/projects') };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') { console.log('node bench/turn-study.mjs (--since ISO [--until ISO] | --results FILE) [--results-dir DIR] [--projects DIR] [--scratch DIR] [--json FILE] [--table FILE]'); return; }
    const value = argv[++i];
    if (!value || !['--since', '--until', '--results', '--results-dir', '--projects', '--scratch', '--json', '--table'].includes(key)) throw new Error('Invalid option. Use --help.');
    if (key === '--results-dir') options.resultDirs.push(value);
    else if (key === '--scratch') options.scratch.push(value);
    else options[key.slice(2)] = value;
  }
  if (!options.since && !options.results) throw new Error('Supply --since or --results.');
  if ((options.since && time(options.since) === null) || (options.until && time(options.until) === null)) throw new Error('Invalid time range.');
  if (options.until && options.since && time(options.until) <= time(options.since)) throw new Error('Empty time range.');
  if (!options.resultDirs.length) options.resultDirs.push('bench/results', 'docs/benchmarks');
  if (!options.scratch.length) options.scratch.push(join(tmpdir(), 'sleight-bench'), join(tmpdir(), 'sleight-real-evidence'));
  const diagnostics = { malformedLines: 0, invalidResultFiles: 0 };
  const resultFiles = options.results ? [options.results] : [...new Set(options.resultDirs.flatMap(d => filesUnder(d, '.json')))];
  const candidates = loadRuns(resultFiles, options.scratch, diagnostics), runs = [], used = new Set();
  let scanned = 0;
  for (const file of filesUnder(options.projects, '.jsonl').filter(f => resolve(dirname(dirname(f))) === resolve(options.projects))) {
    scanned++;
    const rows = jsonRows(file, diagnostics).filter(r => !options.until || time(r.timestamp) === null || time(r.timestamp) < time(options.until));
    const analysis = analyzeTranscript(rows, { transcriptPath: file });
    const start = time(analysis.startedAt);
    if (options.since && (start === null || start < time(options.since))) continue;
    if (options.until && (start === null || start >= time(options.until))) continue;
    const match = matchRun(rows, candidates);
    if (options.results && !match.run) continue;
    const metadata = match.run ? publicRun(match.run) : { task: 'unmatched', arm: 'unknown' };
    if (match.run) used.add(match.run);
    runs.push({ session: /^[a-f\d-]{36}\.jsonl$/.test(basename(file)) ? basename(file, '.jsonl') : `transcript-${runs.length + 1}`,
      match: match.status, ...metadata, ...analysis });
  }
  runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.session.localeCompare(b.session));
  const summary = summarize(runs);
  const inRange = candidates.filter(r => (!options.since || stampTime(r.stamp) >= time(options.since)) && (!options.until || stampTime(r.stamp) < time(options.until)));
  const output = { schemaVersion: 1, range: { since: options.since ?? null, until: options.until ?? null }, rules: RULES,
    accounting: 'Attributed seconds = gap before the call + call wall time. Gaps include model and host scheduling, not isolated model API time. Classes overlap. Unique counts each classified call once. Unknown times are null and omitted from seconds. Parallel call walls can overlap.',
    coverage: { scannedTranscripts: scanned, selectedTranscripts: runs.length, withCalls: runs.filter(r => r.calls.length).length,
      matchedTranscripts: runs.filter(r => ['prompt', 'trace', 'usage'].includes(r.match)).length,
      ambiguousTranscripts: runs.filter(r => r.match === 'ambiguous').length,
      resultRuns: candidates.length, resultRunsInRange: inRange.length, resultRunsMatched: used.size, ...diagnostics },
    unmatchedResults: inRange.filter(r => !used.has(r)).map(publicRun), summary, runs };
  const rendered = `${runs.length} transcripts, ${summary.all.calls} calls.\n\n${table(summary, 'classes')}\n\n${table(summary, 'byTask')}\n`;
  if (options.json) writeFileSync(options.json, JSON.stringify(output, null, 2) + '\n');
  if (options.table) writeFileSync(options.table, rendered);
  console.log(rendered);
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch { console.error('turn-study failed. Check input files, options and output permissions.'); process.exitCode = 1; }
}
