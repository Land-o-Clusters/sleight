#!/usr/bin/env node
// Charts for the benchmark hub and the README: static SVG files in docs/results/img/, one light and one dark per chart.
// Everything here is a pure function of the hub's data files (docs/results/data/*.json): no clock, no randomness, no fonts or
// scripts from other hosts. The two variants of a chart share one structure; only the <style> block's colours differ.
//   CHARTS                      the chart list: { id, family, browser, kind }
//   renderCharts(all)           { 'img/<id>-light.svg': text, 'img/<id>-dark.svg': text } for every chart
//   chartCaption(id, all)       one sentence with the chart's numbers, used as alt text, <desc> and the caption line
//   chartBlock(id, all, {base}) the <picture> block and its <sub> caption, for a page whose path to docs/results/ is `base`
//                               ('' for the pages in docs/results, 'docs/results/' for the repo README)
// Until the hub's render() includes renderCharts(), this file writes the images itself:
//   node bench/results-charts.mjs [--out docs/results] [--check]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dayRange, usesEngine } from './engine-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const W = 900, PAD = 24, FONT = 13, TITLE = 15;

export const CHARTS = [
  { id: 'headline-native', family: 'native-claim', browser: null, kind: 'headline' },
  { id: 'overview', family: null, browser: null, kind: 'overview' },
  { id: 'family-native-claim', family: 'native-claim', browser: null, kind: 'family' },
  { id: 'family-app-claim', family: 'app-claim', browser: null, kind: 'family' },
  { id: 'family-browser-turbo-chrome', family: 'browser-turbo', browser: 'chrome', kind: 'family' },
  { id: 'family-browser-turbo-helium', family: 'browser-turbo', browser: 'helium', kind: 'family' },
  { id: 'family-browser-race-safari', family: 'browser-race', browser: 'safari', kind: 'family' },
  { id: 'family-browser-race-firefox', family: 'browser-race', browser: 'firefox', kind: 'family' },
  { id: 'family-ab-tests', family: 'ab-tests', browser: null, kind: 'summary' },
  { id: 'family-validation', family: 'validation', browser: null, kind: 'summary' },
  { id: 'family-release-passes', family: 'release-passes', browser: null, kind: 'summary' },
];

// Section 2c of the 1.4.0 plan: ember for sleight, dab blue for the one other arm of a two-arm chart, one slate for every
// competitor of a multi-arm chart (the row labels name them), hatched stubs for "never passed". Paper and stage navy surfaces.
export const PALETTES = {
  light: { bg: '#FBF8F1', ink: '#141A26', muted: '#545E6E', grid: '#E4DED2', me: '#E8622C', other: '#4E79D9', slate: '#7A879A' },
  dark: { bg: '#141A26', ink: '#EFE9DC', muted: '#A7B0BF', grid: '#2C3442', me: '#E8622C', other: '#4E79D9', slate: '#9AA6B8' },
};

// The same names and cell text as bench/results-hub.mjs (tests/results-charts.test.mjs checks the cell text against it).
const ARM_NAMES = { sleight: 'sleight', 'sleight-turbo': 'sleight turbo', lcu: 'LCU', codex: 'Codex', cua: 'Cua', peekaboo: 'Peekaboo', 'claude-cu': 'Claude computer use',
  fowlbrowser: 'FowlBrowser', 'claude-in-chrome': 'Claude in Chrome', 'codex-sleight': 'sleight inside Codex' };
export const armName = arm => ARM_NAMES[arm] ?? arm;
const f1 = value => (value === null || value === undefined ? 'n/a' : (Math.round(value * 10) / 10).toFixed(1));
const cellText = cell => (!cell ? 'no runs' : cell.passes === 0 ? `no pass (0/${cell.runs})` : `${f1(cell.expected)} (${cell.passes}/${cell.runs})`);
const joinAnd = items => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const cap = word => word[0].toUpperCase() + word.slice(1);
const uniq = list => [...new Set(list)];

// ---------------------------------------------------------------------------------------------------------------------------
// Picking the data each chart shows.

const PANELS = [
  { label: 'Native apps', family: 'native-claim', browser: null },
  { label: 'VS Code, Slack, Spotify', family: 'app-claim', browser: null },
  { label: 'Chrome, turbo', family: 'browser-turbo', browser: 'chrome' },
  { label: 'Helium, turbo', family: 'browser-turbo', browser: 'helium' },
  { label: 'Safari, engine path', family: 'browser-race', browser: 'safari' },
  { label: 'Firefox, engine path', family: 'browser-race', browser: 'firefox' },
];

// The claim study, or the newest complete set for a browser (`latest`, as the pages lead with it). Null when there is none.
export function studyFor(all, family, browser) {
  const data = all[family];
  if (!data) return null;
  if (family === 'native-claim' || family === 'app-claim') return data.studies?.[0] ?? null;
  const studies = family === 'browser-turbo' ? data.race?.studies ?? [] : data.studies ?? [];
  return studies.find(s => s.browser === browser && s.latest) ?? null;
}

const chartById = id => {
  const chart = CHARTS.find(c => c.id === id);
  if (!chart) throw new Error(`no chart ${id}`);
  return chart;
};
const cellOf = (study, task, arm) => study.cells.find(c => c.task === task && c.arm === arm);
const neverPassed = (study, arm) => study.tasks.filter(task => { const c = cellOf(study, task, arm); return !c || c.passes === 0; });
const fastestCount = (study, arm) => study.verdict.fastest?.[arm]?.length ?? 0;
const total = (study, arm) => study.verdict.totals?.[arm] ?? null;
const familyTitle = chart => ({ 'native-claim': 'Native claim', 'app-claim': 'App claim' }[chart.family] ??
  (chart.family === 'browser-turbo' ? `${cap(chart.browser)}, turbo against FowlBrowser` : `${cap(chart.browser)}, the engine path against Codex, LCU, Cua and Peekaboo`));

// The next-best arm with a total, by total and then by the study's arm order.
function nextBest(study) {
  const others = study.arms.filter(arm => arm !== study.me && total(study, arm) !== null);
  return others.sort((a, b) => total(study, a) - total(study, b) || study.arms.indexOf(a) - study.arms.indexOf(b))[0] ?? null;
}

const taskList = (tasks, max = 2) => (tasks.length <= max ? joinAnd(tasks) : `${tasks.slice(0, max).join(', ')} and ${tasks.length - max} more`);
const noTotalText = (study, arm) => {
  const never = neverPassed(study, arm);
  return never.length ? `no total: never passed ${taskList(never)}` : 'no total';
};

// ---------------------------------------------------------------------------------------------------------------------------
// Footer text: engine versions with their UTC dates, models and effort.

const provenance = b => (b.recorded === b.runs ? 'recorded' : b.recorded === 0 ? 'inferred' : `${b.recorded} of ${b.runs} recorded`);

// One line naming the ChatGPT engine versions the engine-driving arms ran on, with their UTC days, from the data's `engines`
// summary (bench/engine-version.mjs). Data collected before versions were tracked says so.
export function engineLine(study, arms = study.arms) {
  if (!study.engines) return 'ChatGPT engine version: not in this data file, which predates engine tracking (2026-10-19). The pages name it once the data is collected again.';
  const used = arms.filter(arm => usesEngine(arm) && study.engines[arm]);
  if (!used.length) return 'ChatGPT engine: none of these arms drives it.';
  const byVersion = {};
  let unsettled = 0;
  for (const arm of used) {
    const s = study.engines[arm];
    for (const [version, b] of Object.entries(s.versions ?? {})) {
      const v = byVersion[version] ??= { runs: 0, recorded: 0, first: null, last: null };
      v.runs += b.runs; v.recorded += b.recorded;
      if (b.first && (!v.first || b.first < v.first)) v.first = b.first;
      if (b.last && (!v.last || b.last > v.last)) v.last = b.last;
    }
    unsettled += (s.ambiguous?.runs ?? 0) + (s.unknown?.runs ?? 0);
  }
  const parts = Object.keys(byVersion).sort().map(version => { const v = byVersion[version]; return `${version} (${dayRange(v.first, v.last)}, ${provenance(v)})`; });
  const who = joinAnd(used.map(armName));
  return `ChatGPT engine for ${who}: ${joinAnd(parts) || 'no settled version'}.${unsettled && parts.length ? ` ${unsettled} runs have no settled version.` : ''} Dates are UTC.`;
}

function effortText(study, arms) {
  if (Array.isArray(study.effort)) return study.effort.length ? study.effort.join(', ') : 'not recorded';
  const recorded = arms.filter(arm => study.effort?.[arm]?.length);
  const values = uniq(recorded.flatMap(arm => study.effort[arm])).sort();
  if (recorded.length === arms.length) return values.join(', ');
  if (!study.browser) return values.length ? `${values.join(', ')} (recorded for ${joinAnd(recorded.map(armName))})` : 'not recorded';
  return values.length ? `${values.join(', ')} as recorded for ${joinAnd(recorded.map(armName))}, and high from the race scripts' flag for the others`
    : 'high, from the race scripts\' flag';
}

export function modelLine(study, arms = study.arms) {
  const byModel = new Map();
  for (const arm of arms) for (const model of study.models?.[arm]?.length ? study.models[arm] : ['model not recorded']) {
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push(armName(arm));
  }
  return `Models: ${[...byModel].map(([model, names]) => `${model} (${joinAnd(names)})`).join(', ')}. Effort: ${effortText(study, arms)}.`;
}

const wordingLine = study => `The scorer's wording is "${study.verdict.wording}". ${armName(study.me)} has the lowest expected time on ${fastestCount(study, study.me)} of ${study.tasks.length} tasks.`;

// ---------------------------------------------------------------------------------------------------------------------------
// Captions.

export function chartCaption(id, all) {
  const chart = chartById(id);
  if (chart.kind === 'summary') {
    const rows = summaryRows(all, chart.family);
    const passed = rows.reduce((sum, row) => sum + row.passed, 0), runs = rows.reduce((sum, row) => sum + row.runs, 0);
    return `${summaryTitle(chart.family)}: ${passed} of ${runs} recorded attempts passed across ${rows.length} study and arm rows. Task sets differ between studies.`;
  }
  if (chart.kind === 'overview') {
    const bits = PANELS.map(panel => {
      const study = studyFor(all, panel.family, panel.browser);
      if (!study) return `${panel.label} has no complete set yet.`;
      const mine = total(study, study.me), best = nextBest(study);
      const head = mine === null ? `${panel.label}, ${armName(study.me)} has no total because it never passed a task` : `${panel.label}, ${f1(mine)} s`;
      return best ? `${head} against ${armName(best)} at ${f1(total(study, best))} s.` : `${head}, and no other arm has a total.`;
    });
    return `Total expected seconds of sleight against the next-best arm with a total, in the newest complete set of each benchmark. ${bits.join(' ')}`;
  }
  const study = studyFor(all, chart.family, chart.browser);
  if (!study) return `${familyTitle(chart)}: no complete set yet.`;
  if (chart.kind === 'headline') {
    const mine = total(study, study.me);
    const others = study.arms.filter(arm => arm !== study.me);
    const withTotal = others.filter(arm => total(study, arm) !== null).sort((a, b) => total(study, a) - total(study, b));
    const without = others.filter(arm => total(study, arm) === null);
    const head = `${familyTitle(chart)}, ${study.date}: ${armName(study.me)}'s total expected time over ${study.tasks.length} tasks is ${mine === null ? 'none, since it missed a task' : `${f1(mine)} s`}`;
    const against = withTotal.length ? ` against ${joinAnd(withTotal.map(arm => `${armName(arm)} at ${f1(total(study, arm))} s`))}` : '';
    const rest = without.length ? `, and ${joinAnd(without.map(armName))} ${without.length === 1 ? 'has' : 'have'} no total because ${without.length === 1 ? 'it' : 'each'} never passed at least one task` : '';
    return `${head}${against}${rest}.`;
  }
  const same = (study.sameModel ?? []).map(pair => ` The same-model rows put ${armName(pair.hosted)} against ${armName(pair.base)}, with the wording "${pair.wording}".`).join('');
  return `${familyTitle(chart)}, ${study.date}. Expected seconds per task for ${joinAnd(study.arms.map(armName))}. ${armName(study.me)} has the lowest expected time on ` +
    `${fastestCount(study, study.me)} of ${study.tasks.length} tasks. The scorer's wording is "${study.verdict.wording}".${same}`;
}

const escXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escMd = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]|])/g, '\\$1');

export function chartBlock(id, all, { base = '', directory } = {}) {
  const chart = chartById(id);
  directory ??= chart.kind === 'summary' ? 'charts' : 'img';
  const caption = chartCaption(id, all);
  return `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="${base}${directory}/${id}-dark.svg">\n` +
    `  <img src="${base}${directory}/${id}-light.svg" width="${W}" alt="${escXml(caption)}">\n</picture>\n\n<sub>${escMd(caption)}</sub>\n`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// SVG pieces.

const n = value => String(Math.round(value * 10) / 10);
const textWidth = (text, size = FONT) => String(text).length * size * 0.58;

// Greedy word wrap by the 0.58 em estimate, so a wider fallback font still fits.
export function wrap(text, width, size = FONT) {
  const max = Math.max(8, Math.floor(width / (size * 0.58)));
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

const text = (x, y, value, { cls = '', anchor = '', data = '' } = {}) =>
  `<text x="${n(x)}" y="${n(y)}"${cls ? ` class="${cls}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}${data}>${escXml(value)}</text>`;

// A bar from the baseline at x with a 4 px rounded data end, square at the baseline.
function bar(x, y, w, h, cls) {
  const r = Math.min(4, h / 2);
  if (w < r + 1) return `<rect class="${cls}" x="${n(x)}" y="${n(y)}" width="${n(Math.max(w, 1))}" height="${n(h)}"/>`;
  return `<path class="${cls}" d="M${n(x)} ${n(y)}h${n(w - r)}a${r} ${r} 0 0 1 ${r} ${r}v${n(h - 2 * r)}a${r} ${r} 0 0 1 -${r} ${r}h-${n(w - r)}z"/>`;
}
const STUB = 22;
const stub = (x, y, h, tone) => `<rect class="${tone}" fill-opacity="0.16" x="${n(x)}" y="${n(y)}" width="${STUB}" height="${n(h)}"/><rect fill="url(#h-${tone})" x="${n(x)}" y="${n(y)}" width="${STUB}" height="${n(h)}"/>`;

const style = p => `<style>
.bg{fill:${p.bg}}
text{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:${FONT}px;fill:${p.ink}}
.t{font-size:${TITLE}px;font-weight:600}
.b{font-weight:600}
.m{fill:${p.muted}}
.g{stroke:${p.grid};stroke-width:1;fill:none}
.me{fill:${p.me}}
.ot{fill:${p.other}}
.sl{fill:${p.slate}}
.hme{stroke:${p.me}}
.hot{stroke:${p.other}}
.hsl{stroke:${p.slate}}
</style>`;

const DEFS = '<defs>' + ['me', 'ot', 'sl'].map(tone =>
  `<pattern id="h-${tone}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="h${tone}" x1="1" y1="0" x2="1" y2="6" stroke-width="2"/></pattern>`).join('') + '</defs>';

// sleight's rest-state glove with its wrist dabs, path data copied from ledger/p130/hand-art/rest.svg and dabs.svg (gen.mjs, the
// ghost hand's art). Its colours are the hand's own and the same in both variants. At scale 0.8 the glove itself is about 24 pt, in the title row's corner.
const GLOVE_SHADOW = [
  'M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z',
  'M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z',
  'M0.83 13.52 L-5.04 7.13 A1.25 1.25 0 0 0 -6.93 8.76 L-1.43 15.48 Z',
  'M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z',
  'M6.15 11.51 L5.17 -0.67 A1.2 1.2 0 0 0 2.77 -0.53 L3.25 11.69 Z',
  'M9.85 11.59 L9.51 0.29 A1.2 1.2 0 0 0 7.11 0.31 L6.95 11.61 Z',
  'M13.5 11.68 L13.68 3.81 A1.15 1.15 0 0 0 11.39 3.68 L10.7 11.52 Z',
];
const GLOVE_IVORY = [
  'M-2.02 12.19 Q-2.2 10.8 -0.8 10.8 L10 10.8 Q11.4 10.8 11.24 12.19 L10.86 15.61 Q10.7 17 9.89 18.14 L9.81 18.26 Q9 19.4 7.6 19.4 L5 19.4 Q3.6 19.4 2.34 18.79 L-0.14 17.61 Q-1.4 17 -1.58 15.61 Z',
  'M-4 14 A2 2.8 0 1 0 0 14 A2 2.8 0 1 0 -4 14 Z',
  'M0.83 13.51 L-5.21 6.91 A0.78 0.78 0 0 0 -6.38 7.93 L-0.57 14.74 Z',
  'M1.35 11.58 L0.36 0.91 A0.74 0.74 0 0 0 -1.12 1.03 L-0.45 11.72 Z',
  'M5.05 11.59 L4.24 -0.88 A0.74 0.74 0 0 0 2.75 -0.8 L3.25 11.68 Z',
  'M8.75 11.6 L8.59 0.04 A0.74 0.74 0 0 0 7.1 0.04 L6.95 11.6 Z',
  'M12.43 11.63 L12.82 3.52 A0.71 0.71 0 0 0 11.39 3.42 L10.7 11.51 Z',
];
// [x, y, size, colour, rotation] of each wrist dab; each draws over a 1.22x copy at alpha 0.20.
const DABS = [[4.2, 23, 3.2, '#4E79D9', 8], [8.8, 23.5, 3, '#7299EA', -6], [6.5, 26.5, 2.8, '#7299EA', 4], [11.5, 26.2, 2.6, '#A9C4F5', -11],
  [2.6, 27.5, 2.2, '#A9C4F5', -4], [9.2, 29.6, 2.2, '#7299EA', 7], [13.9, 29.2, 1.8, '#A9C4F5', 3], [5.6, 30.6, 1.6, '#A9C4F5', -8]];
const dab = ([x, y, size, colour, rot], scale, alpha) => {
  const s = Math.round(size * scale * 100) / 100, h = Math.round(s * 50) / 100;
  return `<rect x="${-h}" y="${-h}" width="${s}" height="${s}" rx="${Math.round(s * 16) / 100}" fill="${colour}" fill-opacity="${alpha}" transform="translate(${x} ${y}) rotate(${rot})"/>`;
};
const glove = (x, y) => {
  const hand = 'translate(10 10) rotate(-35)';
  const halo = [[3, 0.08], [1.8, 0.12], [0.8, 0.2]].map(([width, alpha]) =>
    `<g fill="#141A26" stroke="#141A26" fill-opacity="${alpha}" stroke-opacity="${alpha}" stroke-width="${width}" stroke-linejoin="round">${GLOVE_SHADOW.map(d => `<path d="${d}"/>`).join('')}</g>`).join('');
  return `<g transform="translate(${n(x)} ${n(y)}) scale(0.8)"><g transform="translate(0.6 0.6)"><g transform="${hand}">${halo}</g></g>` +
    `<g transform="${hand}">${DABS.map(d => dab(d, 1.22, 0.2) + dab(d, 1, 0.92)).join('')}</g>` +
    `<g transform="${hand}">${GLOVE_SHADOW.map((d, i) => `<path d="${d}" fill="#B9BFC9"/><path d="${GLOVE_IVORY[i]}" fill="#EFE9DC"/>`).join('')}</g></g>`;
};

// Title row (title, subtitle, glove) and a legend line. Returns the elements and the y below them.
function header(title, subtitle, legend) {
  const out = [];
  let y = 34;
  for (const line of wrap(title, W - 2 * PAD - 44, TITLE)) { out.push(text(PAD, y, line, { cls: 't' })); y += 20; }
  for (const line of wrap(subtitle, W - 2 * PAD - 44)) { out.push(text(PAD, y, line, { cls: 'm' })); y += 18; }
  out.push(glove(W - PAD - 36, 8));
  y += 6;
  let x = PAD;
  for (const item of legend) {
    if (item.hatch) out.push(stub(x, y - 10, 12, item.tone).replace(/width="22"/g, 'width="12"'));
    else out.push(`<rect class="${item.tone}" x="${n(x)}" y="${n(y - 10)}" width="12" height="12" rx="2"/>`);
    out.push(text(x + 18, y, item.label));
    x += 18 + textWidth(item.label) + 22;
  }
  return { out, y: y + 22 };
}

function footer(lines, y) {
  const out = [];
  y += 8;
  for (const line of lines) for (const part of wrap(line, W - 2 * PAD)) { out.push(text(PAD, y, part, { cls: 'm' })); y += 18; }
  return { out, y: y + 6 };
}

function svg(id, all, body, height, palette) {
  const caption = chartCaption(id, all);
  const title = chartTitle(id, all);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${n(height)}" width="${W}" height="${n(height)}" role="img" aria-labelledby="title desc">\n` +
    `<title id="title">${escXml(title)}</title>\n<desc id="desc">${escXml(caption)}</desc>\n${style(palette)}\n${DEFS}\n` +
    `<rect class="bg" width="${W}" height="${n(height)}" rx="12"/>\n${body.join('\n')}\n</svg>\n`;
}

function chartTitle(id, all) {
  const chart = chartById(id);
  if (chart.kind === 'summary') return `${summaryTitle(chart.family)}: pass rates per study and arm`;
  if (chart.kind === 'overview') return 'sleight against the next-best arm, total expected seconds per benchmark';
  if (chart.kind === 'headline') return `${familyTitle(chart)}: total expected seconds over ${studyFor(all, chart.family)?.tasks.length ?? 0} tasks`;
  return `${familyTitle(chart)}: expected seconds per task`;
}

// Round axis steps: 1, 2, 2.5 or 5 times a power of ten.
function niceStep(max, count = 5) {
  const raw = max / count, power = 10 ** Math.floor(Math.log10(raw)), f = raw / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The three chart kinds.

function emptyChart(id, all) {
  const { out, y } = header(chartTitle(id, all), 'No complete set yet.', []);
  return { body: out, height: y + 12 };
}

function headlineChart(id, all) {
  const chart = chartById(id);
  const study = studyFor(all, chart.family, chart.browser);
  if (!study) return emptyChart(id, all);
  const others = study.arms.filter(arm => arm !== study.me);
  const order = [study.me, ...others.filter(a => total(study, a) !== null).sort((a, b) => total(study, a) - total(study, b) || others.indexOf(a) - others.indexOf(b)),
    ...others.filter(a => total(study, a) === null)];
  const tone = arm => (arm === study.me ? 'me' : 'sl');
  const { out, y: top } = header(chartTitle(id, all), `${study.date}. Expected time is the mean seconds per attempt divided by the pass rate. Shorter bars are faster.`,
    [{ tone: 'me', label: armName(study.me) }, { tone: 'sl', label: 'other arms' }, { tone: 'sl', hatch: true, label: 'no total (a task never passed)' }]);
  const labelW = Math.max(150, ...order.map(arm => textWidth(armName(arm)) + 16));
  const x0 = PAD + labelW, barMax = W - PAD - x0 - 72;
  const max = Math.max(1, ...order.map(arm => total(study, arm) ?? 0));
  const step = niceStep(max), axisMax = Math.ceil(max / step) * step;
  const pitch = 40, thick = 24, rowsH = order.length * pitch;
  for (let v = 0; v <= axisMax + 1e-9; v += step) {
    const x = x0 + (v / axisMax) * barMax;
    out.push(`<line class="g" x1="${n(x)}" y1="${n(top - 6)}" x2="${n(x)}" y2="${n(top + rowsH - 4)}"/>`);
    out.push(text(x, top + rowsH + 12, String(Math.round(v * 10) / 10), { cls: 'm', anchor: 'middle' }));
  }
  order.forEach((arm, i) => {
    const y = top + i * pitch, value = total(study, arm);
    out.push(text(PAD, y + thick / 2 + 4.5, armName(arm), { cls: arm === study.me ? 'b' : '' }));
    const data = ` data-arm="${escXml(arm)}" data-kind="total"`;
    if (value === null) {
      out.push(stub(x0, y, thick, tone(arm)));
      out.push(text(x0 + STUB + 8, y + thick / 2 + 4.5, noTotalText(study, arm), { cls: 'm', data }));
    } else {
      const w = Math.max(2, (value / axisMax) * barMax);
      out.push(bar(x0, y, w, thick, tone(arm)));
      out.push(text(x0 + w + 6, y + thick / 2 + 4.5, `${f1(value)} s`, { data }));
    }
  });
  const foot = footer([wordingLine(study), engineLine(study), modelLine(study)], top + rowsH + 36);
  return { body: [...out, ...foot.out], height: foot.y };
}

function overviewChart(id, all) {
  const { out, y: top } = header(chartTitle(id, all), 'Newest complete set of each benchmark, dates in UTC. Each panel has its own scale, and shorter bars are faster.',
    [{ tone: 'me', label: 'sleight' }, { tone: 'ot', label: 'next-best arm with a total' }, { tone: 'me', hatch: true, label: 'no total (a task never passed)' }]);
  const gap = 24, cols = 3, pw = (W - 2 * PAD - (cols - 1) * gap) / cols;
  const panels = PANELS.map(panel => {
    const study = studyFor(all, panel.family, panel.browser);
    const els = [];
    let y = 0;
    els.push(text(0, y + 14, `${panel.label}${study ? `, ${study.tasks.length} tasks` : ''}`, { cls: 'b' })); y += 20;
    if (!study) { els.push(text(0, y + 14, 'no complete set yet', { cls: 'm' })); return { els, h: y + 24 }; }
    for (const line of wrap(study.date, pw)) { els.push(text(0, y + 13, line, { cls: 'm' })); y += 17; }
    y += 6;
    const best = nextBest(study);
    const rows = [[study.me, 'me'], ...(best ? [[best, 'ot']] : [])];
    const max = Math.max(1, ...rows.map(([arm]) => total(study, arm) ?? 0));
    const barMax = pw - 64;
    for (const [arm, tone] of rows) {
      const value = total(study, arm), data = ` data-family="${panel.family}" data-browser="${panel.browser ?? ''}" data-arm="${escXml(arm)}" data-kind="total"`;
      els.push(text(0, y + 13, armName(arm), { cls: arm === study.me ? 'b' : '' })); y += 18;
      if (value === null) {
        els.push(stub(0, y, 16, tone));
        els.push(text(STUB + 6, y + 12.5, 'no total: a task never passed', { cls: 'm', data }));
      } else {
        const w = Math.max(2, (value / max) * barMax);
        els.push(bar(0, y, w, 16, tone));
        els.push(text(w + 6, y + 12.5, `${f1(value)} s`, { data }));
      }
      y += 24;
    }
    if (!best) { els.push(text(0, y + 13, 'no other arm has a total', { cls: 'm' })); y += 18; }
    y += 4;
    const notes = [`lowest expected time on ${fastestCount(study, study.me)} of ${study.tasks.length}`, panelEngine(study, rows.map(([arm]) => arm))];
    for (const note of notes) for (const line of wrap(note, pw)) { els.push(text(0, y + 13, line, { cls: 'm' })); y += 17; }
    return { els, h: y };
  });
  let y = top;
  for (let row = 0; row < Math.ceil(panels.length / cols); row++) {
    const slice = panels.slice(row * cols, row * cols + cols);
    const h = Math.max(...slice.map(p => p.h));
    slice.forEach((p, col) => out.push(`<g transform="translate(${n(PAD + col * (pw + gap))} ${n(y)})">${p.els.join('')}</g>`));
    y += h + 20;
    if (row < Math.ceil(panels.length / cols) - 1) out.push(`<line class="g" x1="${PAD}" y1="${n(y - 10)}" x2="${W - PAD}" y2="${n(y - 10)}"/>`);
  }
  const shown = PANELS.map(panel => studyFor(all, panel.family, panel.browser)).filter(Boolean);
  const byModel = new Map();
  for (const study of shown) for (const arm of [study.me, nextBest(study)].filter(Boolean)) {
    for (const model of study.models?.[arm]?.length ? study.models[arm] : ['model not recorded']) byModel.set(model, uniq([...(byModel.get(model) ?? []), armName(arm)]));
  }
  const models = [...byModel].map(([model, names]) => `${model} (${joinAnd(names)})`);
  const foot = footer([`Models: ${models.join(', ')}. Each benchmark's page names its effort, rounds and failed runs.`], y - 6);
  return { body: [...out, ...foot.out], height: foot.y };
}

// The engine versions of a panel's engine-driving arms, short enough for a panel.
function panelEngine(study, arms) {
  if (!study.engines) return 'engine version not recorded';
  const versions = uniq(arms.filter(usesEngine).flatMap(arm => Object.keys(study.engines[arm]?.versions ?? {}))).sort();
  if (!arms.some(usesEngine)) return 'no arm here drives the engine';
  const dates = arms.filter(usesEngine).flatMap(arm => Object.values(study.engines[arm]?.versions ?? {})).flatMap(b => [b.first, b.last]).filter(Boolean).sort();
  return versions.length ? `engine ${versions.join(' and ')}, ${dayRange(dates[0], dates.at(-1))}` : 'engine version not settled';
}

function familyChart(id, all) {
  const chart = chartById(id);
  const study = studyFor(all, chart.family, chart.browser);
  if (!study) return emptyChart(id, all);
  const two = study.arms.length === 2;
  const tone = arm => (arm === study.me ? 'me' : two ? 'ot' : 'sl');
  const legend = two ? [{ tone: 'me', label: armName(study.me) }, { tone: 'ot', label: armName(study.arms[1]) }]
    : [{ tone: 'me', label: armName(study.me) }, { tone: 'sl', label: 'other arms, named on each row' }];
  legend.push({ tone: two ? 'ot' : 'sl', hatch: true, label: 'never passed' });
  const set = study.label ? ` Set ${study.label}.` : '';
  const { out, y: top } = header(chartTitle(id, all), `${study.date}.${set} Each label is expected seconds, then passes/runs. Each task has its own scale, and shorter bars are faster.`, legend);
  const pairs = study.sameModel ?? [];
  const allArms = uniq([...study.arms, ...pairs.flatMap(p => [p.hosted, p.base])]);
  const taskW = Math.min(200, Math.max(...study.tasks.map(t => textWidth(t))) + 16);
  const armW = Math.max(...allArms.map(a => textWidth(armName(a)))) + 14;
  const x0 = PAD + taskW + armW;
  const labelReserve = Math.max(...study.tasks.flatMap(t => allArms.map(a => textWidth(cellText(cellOf(study, t, a)))))) + 12;
  const barMax = W - PAD - x0 - labelReserve;
  const pitch = 18, thick = 12, groupGap = 14;
  let y = top;
  const group = (task, arms, toneOf, section) => {
    const cells = arms.map(arm => cellOf(study, task, arm));
    const max = Math.max(1e-9, ...cells.map(c => (c?.passes ? c.expected : 0)));
    out.push(`<line class="g" x1="${PAD}" y1="${n(y - groupGap / 2)}" x2="${W - PAD}" y2="${n(y - groupGap / 2)}"/>`);
    out.push(text(PAD, y + 13, task, { cls: 'b' }));
    out.push(`<line class="g" x1="${n(x0)}" y1="${n(y)}" x2="${n(x0)}" y2="${n(y + arms.length * pitch - 4)}"/>`);
    arms.forEach((arm, i) => {
      const cell = cells[i], ry = y + i * pitch, by = ry + 3;
      const data = ` data-task="${escXml(task)}" data-arm="${escXml(arm)}" data-kind="cell" data-section="${section}"`;
      out.push(text(PAD + taskW, ry + 13, armName(arm), { cls: arm === study.me || section === 'same' && arm === arms[0] ? 'b' : 'm' }));
      if (!cell) out.push(text(x0 + 6, ry + 13, cellText(cell), { cls: 'm', data }));
      else if (!cell.passes) { out.push(stub(x0 + 1, by, thick, toneOf(arm))); out.push(text(x0 + 1 + STUB + 6, ry + 13, cellText(cell), { cls: 'm', data })); }
      else {
        const w = Math.max(2, (cell.expected / max) * barMax);
        out.push(bar(x0 + 1, by, w, thick, toneOf(arm)));
        out.push(text(x0 + 1 + w + 6, ry + 13, cellText(cell), { data }));
      }
    });
    y += arms.length * pitch + groupGap;
  };
  y += 4;
  for (const task of study.tasks) group(task, study.arms, tone, 'main');
  const footLines = [wordingLine(study)];
  for (const pair of pairs) {
    y += 10;
    out.push(text(PAD, y + 15, `Same model: ${armName(pair.hosted)} against ${armName(pair.base)}`, { cls: 't' }));
    y += 26;
    out.push(`<rect class="me" x="${PAD}" y="${n(y)}" width="12" height="12" rx="2"/>`, text(PAD + 18, y + 10.5, armName(pair.hosted)));
    const x2 = PAD + 18 + textWidth(armName(pair.hosted)) + 22;
    out.push(`<rect class="ot" x="${n(x2)}" y="${n(y)}" width="12" height="12" rx="2"/>`, text(x2 + 18, y + 10.5, armName(pair.base)));
    y += 30;
    const pairTone = arm => (arm === pair.hosted ? 'me' : 'ot');
    for (const task of study.tasks) group(task, [pair.hosted, pair.base], pairTone, 'same');
    footLines.push(`Same model: the scorer's wording for ${armName(pair.hosted)} against ${armName(pair.base)} is "${pair.wording}".`);
  }
  footLines.push(engineLine(study, allArms), modelLine(study, allArms));
  const foot = footer(footLines, y + 6);
  return { body: [...out, ...foot.out], height: foot.y };
}

const summaryTitle = family => ({ 'ab-tests': 'Experiments', validation: 'Validation', 'release-passes': 'Release passes' })[family];

export function summaryRows(all, family) {
  const data = all[family];
  if (family === 'release-passes') return (data?.files ?? []).filter(file => file.kind === 'release').flatMap(file =>
    file.arms.map(arm => ({ study: file.name, label: `${file.version} (${file.date})`, arm: arm.arm, passed: arm.passed, runs: arm.runs })));
  return (data?.studies ?? []).flatMap(study => study.arms.map(arm => {
    const runs = study.runs.filter(row => row.arm === arm);
    return { study: study.id, label: study.title ?? study.id, arm, passed: runs.filter(row => row.passed).length, runs: runs.length };
  }));
}

function summaryChart(id, all) {
  const chart = chartById(id), rows = summaryRows(all, chart.family);
  const { out, y: top } = header(summaryTitle(chart.family), 'Pass rate per study and arm. Bars share a 0 to 100% scale. Labels give passed attempts / all attempts.', []);
  const x0 = PAD + 210, barMax = W - PAD - x0 - 150;
  let y = top, previous;
  for (const row of rows) {
    if (row.study !== previous) {
      y += 12;
      for (const line of wrap(row.label, W - 2 * PAD)) { out.push(text(PAD, y + 13, line, { cls: 'b' })); y += 18; }
      previous = row.study;
    }
    const pct = row.runs ? row.passed / row.runs : 0;
    const data = ` data-study="${escXml(row.study)}" data-arm="${escXml(row.arm)}" data-kind="pass-rate"`;
    out.push(text(PAD, y + 14, armName(row.arm), { cls: 'm' }));
    out.push(`<line class="g" x1="${x0}" y1="${n(y + 16)}" x2="${x0 + barMax}" y2="${n(y + 16)}"/>`);
    if (pct) out.push(bar(x0, y + 3, pct * barMax, 14, row.arm === 'sleight' || row.arm === 'build-B' ? 'me' : 'ot'));
    out.push(text(x0 + barMax + 10, y + 14, `${f1(pct * 100)}% (${row.passed}/${row.runs})`, { data }));
    y += 25;
  }
  if (!rows.length) { out.push(text(PAD, y + 14, 'No recorded attempts.', { cls: 'm' })); y += 28; }
  const foot = footer(['Task sets differ between studies. See the tables for timing, models, engine versions and failed runs.'], y + 16);
  return { body: [...out, ...foot.out], height: foot.y };
}

const KINDS = { headline: headlineChart, overview: overviewChart, family: familyChart, summary: summaryChart };

export function renderCharts(all) {
  const files = {};
  for (const chart of CHARTS) {
    const { body, height } = KINDS[chart.kind](chart.id, all);
    for (const [mode, palette] of Object.entries(PALETTES)) {
      const bodyText = svg(chart.id, all, body, height, palette);
      if (chart.kind !== 'summary') files[`img/${chart.id}-${mode}.svg`] = bodyText;
      if (chart.family && chart.kind !== 'headline') files[`charts/${chart.id}-${mode}.svg`] = bodyText;
    }
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Main: render from the committed data files and write (or check) docs/results/img/.

const DATA_FAMILIES = ['native-claim', 'app-claim', 'browser-turbo', 'browser-race', 'ab-tests', 'validation', 'release-passes'];
export const loadData = out => Object.fromEntries(DATA_FAMILIES.map(id => [id, JSON.parse(readFileSync(join(out, 'data', `${id}.json`), 'utf8'))]));

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--out');
  const out = resolve(ROOT, i < 0 ? 'docs/results' : argv[i + 1]);
  const files = renderCharts(loadData(out));
  if (argv.includes('--check')) {
    const changed = Object.entries(files).filter(([name, body]) => !existsSync(join(out, name)) || readFileSync(join(out, name), 'utf8') !== body).map(([name]) => name);
    for (const name of changed) console.log(`would change ${name}`);
    process.exitCode = changed.length ? 1 : 0;
    return;
  }
  for (const [name, body] of Object.entries(files)) { mkdirSync(dirname(join(out, name)), { recursive: true }); writeFileSync(join(out, name), body); }
  console.log(`wrote ${Object.keys(files).length} charts to ${join(out, 'img')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
