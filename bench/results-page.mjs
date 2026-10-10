// One page for everything the benchmark publishes. Reads the results files named on
// the command line and writes docs/results/index.html, a static page with no external
// requests that works opened from disk and on GitHub Pages from /docs, plus
// docs/results/README.md with the same tables for GitHub's viewer. Every number in
// the pages comes from those files; nothing is typed by hand. Rebuild it after each
// release pass:
//   node bench/results-page.mjs docs/benchmarks/<results>.json ... [--out docs/results]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// What a process is called in a footprint comes from bench/footprint.mjs's label().
// The page groups those names: the engine's node and the shared helper; the relay,
// MCP servers and osascript helpers (sleight's processes on the sleight arm); the
// host CLI; and the target app plus anything unclassified. Names group by name, so
// one name can cover more than one program; the per-process table next to it has
// the detail.
const ENGINE = new Set(['engine node', 'engine helper']);
const SLEIGHT = new Set(['node', 'mcp@latest', 'osascript']);
const CLIENT = new Set(['claude', 'codex', 'codex-code-mode-host']);

export function loadResults(name, raw, writeUp) {
  const passes = Array.isArray(raw.passes) ? raw.passes : undefined;
  const last = passes ? passes[passes.length - 1] : raw;
  const results = passes ? last.results : raw.results;
  if (!Array.isArray(results) || results.length === 0) throw new Error(`no runs in ${name}`);
  const arms = raw.arms ?? last.arms ?? ['sleight'];
  const version = /-release-([0-9.]+)\.json$/.exec(name)?.[1];
  return {
    name,
    link: `../benchmarks/${name}`,
    writeUp: writeUp ? `../benchmarks/${writeUp}` : undefined,
    kind: arms.length > 1 ? 'h2h' : 'release',
    rival: arms.filter(arm => arm !== 'sleight').join(', ') || undefined,
    version,
    stamp: raw.stamp ?? last.stamp,
    date: (raw.stamp ?? last.stamp ?? '').slice(0, 10),
    model: raw.model ?? last.model,
    effort: raw.effort ?? last.effort,
    auth: raw.auth,
    ownerAway: raw.ownerAway,
    suite: raw.suite,
    note: raw.note,
    passes: passes ? passes.length : 1,
    results,
  };
}

// A pass's totals. Model time exists only where the harness reports it (the Claude
// arms), CPU only where the run carried a footprint sampler.
export function summarize(results) {
  const total = { runs: results.length, passed: 0, seconds: 0, turns: 0, modelMs: 0, modelRuns: 0, cpu: 0, cpuRuns: 0 };
  for (const run of results) {
    if (run.passed) total.passed += 1;
    total.seconds += run.seconds ?? 0;
    total.turns += run.turns ?? 0;
    if (Number.isFinite(run.timing?.modelMs)) { total.modelMs += run.timing.modelMs; total.modelRuns += 1; }
    if (Number.isFinite(run.footprint?.cpuSeconds)) { total.cpu += run.footprint.cpuSeconds; total.cpuRuns += 1; }
  }
  total.seconds = Math.round(total.seconds * 10) / 10;
  total.modelS = total.modelRuns > 0 ? total.modelMs / 1000 : undefined;
  total.cpu = total.cpuRuns > 0 ? total.cpu : undefined;
  return total;
}

export function cpuBuckets(footprint) {
  const buckets = { engine: 0, sleight: 0, client: 0, other: 0 };
  for (const group of [footprint.group, footprint.outside]) {
    for (const [name, seconds] of Object.entries(group ?? {})) {
      if (ENGINE.has(name)) buckets.engine += seconds;
      else if (SLEIGHT.has(name)) buckets.sleight += seconds;
      else if (CLIENT.has(name)) buckets.client += seconds;
      else buckets.other += seconds;
    }
  }
  for (const key of Object.keys(buckets)) buckets[key] = Math.round(buckets[key] * 100) / 100;
  return buckets;
}

// Every process name the runs' footprints saw, with its summed CPU seconds.
export function cpuNames(results) {
  const names = {};
  for (const run of results) {
    for (const group of [run.footprint?.group, run.footprint?.outside]) {
      for (const [name, seconds] of Object.entries(group ?? {})) names[name] = Math.round(((names[name] ?? 0) + seconds) * 100) / 100;
    }
  }
  return names;
}

export function perArm(results) {
  const arms = {};
  for (const run of results) (arms[run.arm] ??= []).push(run);
  for (const [arm, runs] of Object.entries(arms)) {
    arms[arm] = summarize(runs);
    arms[arm].arm = arm;
    arms[arm].models = [...new Set(runs.flatMap(run => run.models ?? []))];
    arms[arm].buckets = { engine: 0, sleight: 0, client: 0, other: 0 };
    for (const run of runs) {
      if (!run.footprint) continue;
      const buckets = cpuBuckets(run.footprint);
      for (const key of Object.keys(arms[arm].buckets)) arms[arm].buckets[key] = Math.round((arms[arm].buckets[key] + buckets[key]) * 100) / 100;
    }
  }
  return arms;
}

export function byTask(results) {
  const tasks = new Map();
  for (const run of results) {
    const list = tasks.get(run.task) ?? [];
    list.push({ run: run.run, arm: run.arm, passed: run.passed === true, cancelled: run.cancelled === true, seconds: run.seconds, turns: run.turns, modelMs: run.timing?.modelMs, reason: scrub(run.reason) });
    tasks.set(run.task, list);
  }
  return [...tasks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([task, runs]) => ({ task, runs }));
}

const versionOf = version => version.split('.').map(Number);
const byVersion = (a, b) => {
  const left = versionOf(a.version), right = versionOf(b.version);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return 0;
};

// The page's inputs, ordered: release passes old to new, and per rival the latest
// head-to-head by stamp (Codex first, then the rest by name).
export function buildPage(inputs) {
  const releases = inputs.filter(file => file.kind === 'release').sort(byVersion);
  const rivals = new Map();
  for (const file of inputs.filter(file => file.kind === 'h2h')) {
    const held = rivals.get(file.rival);
    if (!held || file.stamp > held.stamp) rivals.set(file.rival, file);
  }
  const order = rival => (rival === 'codex' ? 0 : rival === 'lcu' ? 1 : 2);
  const latest = [...rivals.values()].sort((a, b) => order(a.rival) - order(b.rival));
  return { releases, latestRelease: releases[releases.length - 1], rivals: latest };
}

const rivalName = rival => (rival === 'codex' ? 'Codex' : rival === 'lcu' ? 'LCU' : rival);
const armName = arm => (arm === 'sleight' ? 'sleight' : rivalName(arm));
const scrub = value => String(value ?? '').replace(/\/Users\/[^/[\]\s)"'`,;:]*/g, '~');
const clean = value => scrub(value).replace(/\s+/g, ' ').trim();
// Table cells for GitHub's viewer: process names such as <defunct> must come out
// as text, so the entities are escaped here and the cell keeps no other markup.
const cell = value => clean(value).replace(/\|/g, '\\|').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fmtN = value => Math.round(value).toLocaleString('en-US');
const fmtS = value => (value === undefined || value === null ? '—' : Math.abs(value) >= 100 ? fmtN(value) : (Math.round(value * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const fmt1 = value => (value === undefined ? '—' : (Math.round(value * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const headline = file => (file.kind === 'release' ? `${file.version} release pass (${file.date})` : `sleight and ${rivalName(file.rival)} (${file.date})`);
const DASH = 'n/a';

const ARM_HEAD = ['Arm', 'Model', 'Passed', 'Total s', 'Turns', 'Model s', 'Own CPU s'];
// The sleight arm's model falls back to the file's, which describes it; a rival arm
// without models in its runs stays unnamed rather than borrowing the sleight model.
const armRows = file => Object.values(perArm(file.results)).map(stats => [
  armName(stats.arm),
  stats.models[0] ?? (stats.arm === 'sleight' ? file.model : undefined) ?? DASH,
  `${stats.passed}/${stats.runs}`,
  fmtS(stats.seconds),
  fmtN(stats.turns),
  stats.modelS === undefined ? DASH : fmt1(stats.modelS),
  stats.cpu === undefined ? DASH : fmt1(stats.cpu),
]);

const CPU_CAPTION = 'Own CPU is the run\'s own process group plus the shared engine helper and the target app. ' +
  'The groups are named by process name: engine is the engine\'s node and helper, "sleight\'s processes" is the relay, ' +
  'MCP servers and osascript, client is the host CLI, and other is the target app and anything unclassified.';

function bucketTables(file) {
  const arms = Object.values(perArm(file.results)).filter(stats => stats.cpu !== undefined);
  if (!arms.length) return undefined;
  const nameMaps = new Map(arms.map(stats => [stats.arm, cpuNames(file.results.filter(run => run.arm === stats.arm))]));
  const names = [...new Set(arms.flatMap(stats => Object.keys(nameMaps.get(stats.arm))))]
    .sort((a, b) => (nameMaps.get(arms[0].arm)[b] ?? 0) - (nameMaps.get(arms[0].arm)[a] ?? 0));
  return {
    splitHead: ['Arm', 'Engine', "sleight's processes", 'Client', 'Other'],
    splitRows: arms.map(stats => [armName(stats.arm), ...Object.values(stats.buckets).map(fmt1)]),
    namesHead: ['Process', ...arms.map(stats => armName(stats.arm))],
    nameRows: names.map(name => [name, ...arms.map(stats => fmt1(nameMaps.get(stats.arm)[name] ?? 0))]),
  };
}

const TASK_HEAD = ['Task', 'Run', 'Arm', 'Result', 's', 'Turns', 'Model s', 'Raw'];
// A failure reason is the checker's own output, so the markdown cell shows it as
// code rather than prose. The Raw cell carries its own markup per format; the
// table renderers escape plain strings, so the anchor arrives as an object.
const taskRows = (file, forMarkdown) => byTask(file.results)
  .map(({ task, runs }) => runs.map(run => ({ task, ...run }))).flat()
  .map(row => {
    const result = row.passed ? 'pass' : row.cancelled ? 'cancelled' : `failed: ${clean(row.reason).slice(0, 160)}`;
    return [
      row.task,
      String(row.run),
      armName(row.arm),
      forMarkdown && !row.passed ? '`' + result + '`' : result,
      fmtS(row.seconds),
      row.turns == null ? DASH : fmtN(row.turns),
      row.modelMs === undefined ? DASH : fmt1(row.modelMs / 1000),
      { md: `[json](${file.link})`, html: `<a href="${file.link}">json</a>` },
    ];
  });

function historyTable(page, render) {
  const rows = page.releases.map(file => {
    const stats = summarize(file.results);
    return [file.version, file.date, `${stats.passed}/${stats.runs}`, fmtN(stats.turns), fmtS(stats.seconds),
      stats.modelS !== undefined && stats.turns > 0 ? fmt1(stats.modelS / stats.turns) : DASH];
  });
  return render(['Version', 'Date', 'Passed', 'Turns', 'Total s', 'Model s a turn'], rows);
}

// Pass rate over the release versions, as an inline SVG: one labelled point per
// release, 0 and 100 percent guides, nothing else.
export function historySvg(rows) {
  const width = 640, height = 190, left = 72, right = 16, top = 22, bottom = 36;
  const innerW = width - left - right, innerH = height - top - bottom;
  const x = i => (rows.length === 1 ? left + innerW / 2 : left + (i * innerW) / (rows.length - 1));
  const y = pct => top + (1 - pct) * innerH;
  const points = rows.map((row, i) => ({ version: row.version, pct: row.passed / row.runs, x: x(i), y: y(row.passed / row.runs) }));
  const line = points.map(point => `${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10}`).join(' ');
  const marks = points.map(point =>
    `<circle cx="${Math.round(point.x * 10) / 10}" cy="${Math.round(point.y * 10) / 10}" r="3.5"/>` +
    `<text x="${Math.round(point.x * 10) / 10}" y="${Math.round(point.y * 10) / 10 - 8}" text-anchor="middle" class="tick">${Math.round(point.pct * 100)}%</text>` +
    `<text x="${Math.round(point.x * 10) / 10}" y="${height - 12}" text-anchor="middle" class="tick">${escapeHtml(point.version)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Pass rate of each release pass">` +
    `<line x1="${left}" y1="${y(1)}" x2="${width - right}" y2="${y(1)}" class="grid"/>` +
    `<text x="8" y="${y(1) + 4}" class="tick">100%</text>` +
    `<line x1="${left}" y1="${y(0)}" x2="${width - right}" y2="${y(0)}" class="grid"/>` +
    `<text x="8" y="${y(0) + 4}" class="tick">0%</text>` +
    `<polyline points="${line}" fill="none" stroke-width="1.5"/>${marks}</svg>`;
}

function markdownTable(head, rows) {
  const text = value => (value && typeof value === 'object' ? value.md : value);
  const cells = row => row.map(value => cell(text(value))).join(' | ');
  return ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |', ...rows.map(row => '| ' + cells(row) + ' |')].join('\n');
}

function htmlTable(head, rows) {
  const body = rows.map(row => '<tr>' + row.map(value => {
    if (value && typeof value === 'object') return `<td>${value.html}</td>`;
    return `<td>${typeof value === 'string' ? escapeHtml(value) : value}</td>`;
  }).join('') + '</tr>').join('\n');
  return `<table><thead><tr>${head.map(title => `<th>${escapeHtml(title)}</th>`).join('')}</thead>\n<tbody>\n${body}\n</tbody></table>`;
}

function methodList(inputs, forHtml) {
  return inputs.map(file => {
    const bits = [file.date];
    if (file.model) bits.push(`${file.model}${file.effort ? ` at ${file.effort}` : ''}`);
    bits.push('arm ' + [...new Set(file.results.map(run => run.arm))].map(armName).join(' and '));
    if (file.auth) bits.push(`auth ${file.auth}`);
    bits.push(file.ownerAway === true ? 'owner away' : file.ownerAway === false ? 'owner at the Mac' : 'owner presence not in the file');
    if (file.suite) bits.push(`suite ${file.suite}`);
    if (file.passes > 1) bits.push(`last of ${file.passes} passes in the file`);
    // The note is provenance from the results file; its first two sentences carry
    // the facts (engine version, owner away, arm folder) and the page quotes no more.
    const note = file.note ? ` ${cell(file.note.split(/(?<=\.)\s+/).slice(0, 2).join(' '))}` : '';
    const text = `${bits.join(', ')}.`;
    const writeUp = file.writeUp ? { label: basename(file.writeUp), href: file.writeUp } : undefined;
    if (forHtml) {
      const links = `<a href="${file.link}">${escapeHtml(file.name)}</a>` +
        (writeUp ? `, write-up <a href="${writeUp.href}">${escapeHtml(writeUp.label)}</a>` : '');
      return `<li>${links}: ${escapeHtml(text)}${escapeHtml(note)}</li>`;
    }
    return `- [${file.name}](${file.link}): ${text}${writeUp ? ` write-up [${writeUp.label}](${writeUp.href}).` : ''}${note}`;
  });
}

const RUN_IT_YOURSELF = [
  'npm run bench -- --runs 3                        # sleight only',
  'npm run bench -- --arm all --runs 3              # sleight and LCU',
  'npm run bench -- --arm sleight,codex --runs 3    # sleight against native Codex computer use',
  '',
  'PLUGIN_ARM_RIVAL_DIR=/absolute/path/to/plugin node bench/run.mjs --arm plugin:rival,sleight --tasks calculator-click --runs 1',
  'MCP_ARM_RIVAL_CONFIG=/absolute/path/to/mcp.json node bench/run.mjs --arm mcp:rival,sleight --tasks calculator-click --runs 1',
].join('\n');

const LIVE_MD = 'A live pass auto-approves the benchmark apps and drives them unattended, and Chess and the ' +
  'simulator need `--owner-away`. Live runs take /tmp/sleight-live.lock and stop while /tmp/sleight-hold exists. ' +
  'See [benchmark.md](../benchmark.md) for the full method.';
const LAWS_MD = 'Every run the benchmark made is published, failures included ([LAWS](../status/LAWS.md), Method). ' +
  'Known limits are quoted in [known-problems](../known-problems.md), not copied here.';
const htmlLinks = text => text
  .replace('[LAWS](../status/LAWS.md)', '<a href="../status/LAWS.md">LAWS</a>')
  .replace('[known-problems](../known-problems.md)', '<a href="../known-problems.md">known-problems</a>')
  .replace('[benchmark.md](../benchmark.md)', '<a href="../benchmark.md">benchmark.md</a>');
const METHOD_TAIL = 'The standard results files don\'t record an engine version or load figures. Passes that ' +
  'measured them state them in a write-up or note. Turns differ between harnesses.';

export function renderMarkdown(page) {
  const out = [];
  out.push('# Benchmark results\n');
  out.push('One page per release, generated from the results files in [benchmarks](../benchmarks/). ' +
    `Every number comes from those files. ${LAWS_MD} The same page as a chart is [index.html](index.html).\n`);
  const latest = page.latestRelease;
  if (latest) {
    const stats = summarize(latest.results);
    out.push('## Latest release pass\n');
    out.push(`${latest.version} (${latest.date}) on ${latest.model} at ${latest.effort}: ` +
      `${stats.passed} of ${stats.runs} runs passed, ${fmtN(stats.turns)} turns, ${fmtS(stats.seconds)} s in total. ` +
      `Raw file: [${latest.name}](${latest.link}).\n`);
  }
  if (page.rivals.length) {
    out.push('## Head-to-heads\n');
    for (const file of page.rivals) {
      out.push(`### sleight and ${rivalName(file.rival)} (${file.date})\n`);
      out.push(markdownTable(ARM_HEAD, armRows(file)) + '\n');
      out.push(CPU_CAPTION + '\n');
      const buckets = bucketTables(file);
      if (buckets) {
        out.push('Own CPU seconds by group:\n');
        out.push(markdownTable(buckets.splitHead, buckets.splitRows) + '\n');
        out.push('Every process the sampler saw, per arm:\n');
        out.push(markdownTable(buckets.namesHead, buckets.nameRows) + '\n');
      }
    }
  }
  out.push('## Every run\n');
  for (const file of [page.latestRelease, ...page.rivals].filter(Boolean)) {
    out.push(`### ${headline(file)}\n`);
    out.push(markdownTable(TASK_HEAD, taskRows(file, true)) + '\n');
  }
  out.push('## Release history\n');
  out.push(historyTable(page, markdownTable) + '\n');
  out.push('Run counts differ between versions: the task set grew from 18 runs to 21, and 0.8.0 and 0.11.0 ' +
    'ran partial sets. The chart is in [index.html](index.html).\n');
  out.push('## Method and caveats\n');
  out.push(methodList([...page.releases, ...page.rivals], false).join('\n') + '\n');
  out.push(METHOD_TAIL + '\n');
  out.push('## Run it yourself\n');
  out.push('```sh\n' + RUN_IT_YOURSELF + '\n```\n');
  out.push(LIVE_MD + '\n');
  out.push('Rebuild this page after a release pass with:\n');
  out.push('```sh\nnode bench/results-page.mjs ' +
    [...page.releases, ...page.rivals].map(file => `docs/benchmarks/${file.name}`).join(' ') + '\n```');
  return out.join('\n') + '\n';
}

export function renderHtml(page) {
  const out = [];
  out.push('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>sleight benchmark results</title>\n' +
    '<style>\n' +
    'html{color-scheme:light;}\n' +
    'body{font:15px/1.55 system-ui,sans-serif;max-width:62rem;margin:2rem auto;padding:0 1rem;color:#1c2430;background:#fff;}\n' +
    'h1{font-size:1.5rem;} h2{font-size:1.2rem;margin-top:2rem;} h3{font-size:1rem;margin-top:1.5rem;}\n' +
    'table{border-collapse:collapse;margin:0.6rem 0;font-size:0.86rem;}\n' +
    'th,td{border:1px solid #d4dae2;padding:0.2rem 0.5rem;text-align:left;vertical-align:top;}\n' +
    'th{background:#eef1f5;}\n' +
    'svg{max-width:100%;height:auto;} svg polyline{stroke:#3455b4;fill:none;} svg circle{fill:#3455b4;}\n' +
    'svg .grid{stroke:#c9d0d9;stroke-width:1;} svg text{fill:#5a6472;font-size:10px;}\n' +
    'code{background:#eef1f5;padding:0 0.25rem;}\n' +
    'pre{background:#eef1f5;padding:0.7rem;overflow-x:auto;}\n' +
    '.note{color:#5a6472;font-size:0.85rem;}\n' +
    '</style>\n</head>\n<body>\n');
  out.push('<h1>sleight benchmark results</h1>\n');
  out.push(`<p>One page per release, generated from the results files in <a href="../benchmarks/">benchmarks</a>. ` +
    `Every number comes from those files. ${htmlLinks(LAWS_MD)}</p>\n`);
  const latest = page.latestRelease;
  if (latest) {
    const stats = summarize(latest.results);
    out.push('<h2>Latest release pass</h2>\n');
    out.push(`<p>${escapeHtml(latest.version)} (${escapeHtml(latest.date)}) on ${escapeHtml(latest.model)} at ${escapeHtml(latest.effort)}: ` +
      `${stats.passed} of ${stats.runs} runs passed, ${fmtN(stats.turns)} turns, ${fmtS(stats.seconds)} s in total. ` +
      `Raw file: <a href="${latest.link}">${escapeHtml(latest.name)}</a>.</p>\n`);
  }
  if (page.rivals.length) {
    out.push('<h2>Head-to-heads</h2>\n');
    for (const file of page.rivals) {
      out.push(`<h3>sleight and ${escapeHtml(rivalName(file.rival))} (${escapeHtml(file.date)})</h3>\n`);
      out.push(htmlTable(ARM_HEAD, armRows(file)) + '\n');
      out.push(`<p class="note">${escapeHtml(CPU_CAPTION)}</p>\n`);
      const buckets = bucketTables(file);
      if (buckets) {
        out.push('<p>Own CPU seconds by group:</p>\n');
        out.push(htmlTable(buckets.splitHead, buckets.splitRows) + '\n');
        out.push('<p>Every process the sampler saw, per arm:</p>\n');
        out.push(htmlTable(buckets.namesHead, buckets.nameRows) + '\n');
      }
    }
  }
  out.push('<h2>Every run</h2>\n');
  for (const file of [page.latestRelease, ...page.rivals].filter(Boolean)) {
    out.push(`<h3>${escapeHtml(headline(file))}</h3>\n`);
    out.push(htmlTable(TASK_HEAD, taskRows(file, false)) + '\n');
  }
  out.push('<h2>Release history</h2>\n');
  out.push(historyTable(page, htmlTable) + '\n');
  out.push(historySvg(page.releases.map(file => ({ version: file.version, passed: summarize(file.results).passed, runs: summarize(file.results).runs }))) + '\n');
  out.push('<p class="note">Run counts differ between versions: the task set grew from 18 runs to 21, and 0.8.0 and 0.11.0 ran partial sets.</p>\n');
  out.push('<h2>Method and caveats</h2>\n<ul>\n');
  for (const line of methodList([...page.releases, ...page.rivals], true)) out.push(line + '\n');
  out.push(`</ul>\n<p class="note">${escapeHtml(METHOD_TAIL)}</p>\n`);
  out.push('<h2>Run it yourself</h2>\n');
  out.push('<pre><code>' + escapeHtml(RUN_IT_YOURSELF) + '</code></pre>\n');
  out.push('<p>' + htmlLinks(LIVE_MD) + '</p>\n');
  out.push('<p>Rebuild this page after a release pass with:</p>\n');
  out.push('<pre><code>node bench/results-page.mjs ' +
    escapeHtml([...page.releases, ...page.rivals].map(file => `docs/benchmarks/${file.name}`).join(' ')) + '</code></pre>\n');
  out.push('</body>\n</html>\n');
  return out.join('');
}

function usage() {
  console.error('usage: node bench/results-page.mjs docs/benchmarks/<results>.json ... [--out docs/results]');
}

export function main(argv = process.argv.slice(2)) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : 'docs/results';
  const paths = argv.filter((arg, i) => arg !== '--out' && (outIndex < 0 || i !== outIndex + 1));
  if (!paths.length) { usage(); process.exitCode = 2; return; }
  const benchDir = join(ROOT, 'docs', 'benchmarks');
  const inputs = paths.map(path => {
    const name = basename(path);
    const file = existsSync(path) ? path : join(benchDir, name);
    const writeUpName = name.replace(/\.json$/, '.md');
    return loadResults(name, JSON.parse(readFileSync(file, 'utf8')), existsSync(join(benchDir, writeUpName)) ? writeUpName : undefined);
  });
  const page = buildPage(inputs);
  const outDir = join(ROOT, out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), renderHtml(page));
  writeFileSync(join(outDir, 'README.md'), renderMarkdown(page));
  console.log(`wrote ${out}/index.html and ${out}/README.md from ${paths.length} results files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
