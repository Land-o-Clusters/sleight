import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHARTS, PALETTES, chartBlock, chartCaption, engineLine, loadData, renderCharts, studyFor, summaryRows } from '../bench/results-charts.mjs';
import { cellText } from '../bench/results-hub.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'docs/results');
const committed = () => loadData(OUT);
const clone = value => JSON.parse(JSON.stringify(value));
const f1 = value => (Math.round(value * 10) / 10).toFixed(1);
const unescape = text => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Every labelled value in an SVG: { attrs, text } for each <text> that carries data-kind.
function labels(svg) {
  return [...svg.matchAll(/<text ([^>]*data-kind="[^"]*"[^>]*)>([^<]*)<\/text>/g)].map(([, attrs, text]) => ({
    attrs: Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, unescape(v)])), text: unescape(text) }));
}

// A strict enough check for the files we write: tags balance, nothing is left outside the root, <text> is never empty.
function wellFormed(svg, name) {
  const stack = [];
  const body = svg.replace(/<style>[\s\S]*?<\/style>/, '<style/>');
  for (const [tag, close, tagName, , selfClose] of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
    if (selfClose) continue;
    if (close) assert.equal(stack.pop(), tagName, `${name}: ${tag} closes the wrong element`);
    else stack.push(tagName);
  }
  assert.deepEqual(stack, [], `${name}: unclosed ${stack.join(', ')}`);
  assert.ok(!/<(?!\/?[a-zA-Z])/.test(body), `${name}: a stray <`);
  for (const [, inner] of svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) assert.ok(inner.trim(), `${name}: an empty <text>`);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 900 \d+(\.\d)?"/, `${name}: viewBox`);
  assert.match(svg, /role="img" aria-labelledby="title desc"/);
  assert.match(svg, /<title id="title">[^<]+<\/title>\n<desc id="desc">[^<]+<\/desc>/);
}

test('all chart files render from the committed data, twice the same, and match img and charts', () => {
  const first = renderCharts(committed()), second = renderCharts(committed());
  assert.deepEqual(first, second);
  const names = CHARTS.flatMap(c => ['light', 'dark'].flatMap(mode => [
    ...(c.kind !== 'summary' ? [`img/${c.id}-${mode}.svg`] : []),
    ...(c.family && c.kind !== 'headline' ? [`charts/${c.id}-${mode}.svg`] : []),
  ])).sort();
  assert.equal(names.length, 34);
  assert.deepEqual(Object.keys(first).sort(), names);
  assert.deepEqual(['img', 'charts'].flatMap(dir => readdirSync(join(OUT, dir)).filter(n => n.endsWith('.svg')).map(n => `${dir}/${n}`)).sort(), names);
  for (const [name, text] of Object.entries(first)) assert.equal(readFileSync(join(OUT, name), 'utf8'), text, `${name} is stale: run node bench/results-charts.mjs`);
});

test('light and dark differ only in the palette tokens of the style block', () => {
  const files = renderCharts(committed());
  for (const chart of CHARTS) {
    const dir = chart.kind === 'summary' ? 'charts' : 'img';
    const light = files[`${dir}/${chart.id}-light.svg`], dark = files[`${dir}/${chart.id}-dark.svg`];
    const styleOf = svg => /<style>[\s\S]*?<\/style>/.exec(svg)[0];
    assert.equal(light.replace(styleOf(light), ''), dark.replace(styleOf(dark), ''), `${chart.id}: the structure differs`);
    const tokens = (svg, palette) => Object.entries(palette).reduce((style, [token, hex]) => style.replaceAll(hex, `{${token}}`), styleOf(svg));
    // Each palette's values are swapped for their names in a fixed order, so equal text means the same token in every slot.
    const ordered = palette => Object.fromEntries(Object.entries(palette).sort(([a], [b]) => (a < b ? -1 : 1)));
    assert.equal(tokens(light, ordered(PALETTES.light)), tokens(dark, ordered(PALETTES.dark)), `${chart.id}: the style blocks differ beyond colours`);
    assert.notEqual(light, dark);
  }
});

test('every value a family chart prints is the hub\'s cellText for that cell, and every cell is printed', () => {
  const all = committed(), files = renderCharts(all);
  for (const chart of CHARTS.filter(c => c.kind === 'family')) {
    const study = studyFor(all, chart.family, chart.browser);
    assert.ok(study, `${chart.id}: no study`);
    const printed = labels(files[`img/${chart.id}-light.svg`]).filter(l => l.attrs['data-section'] === 'main');
    assert.equal(printed.length, study.tasks.length * study.arms.length, `${chart.id}: one label per task and arm`);
    for (const { attrs, text } of printed) {
      const cell = study.cells.find(c => c.task === attrs['data-task'] && c.arm === attrs['data-arm']);
      assert.equal(text, cellText(cell), `${chart.id} ${attrs['data-task']} ${attrs['data-arm']}`);
    }
  }
});

test('every total the headline and overview print is the verdict\'s, and an arm without one says which task it never passed', () => {
  const all = committed(), files = renderCharts(all);
  const native = studyFor(all, 'native-claim');
  const headline = labels(files['img/headline-native-light.svg']);
  assert.equal(headline.length, native.arms.length);
  assert.equal(headline[0].attrs['data-arm'], 'sleight', 'sleight comes first');
  for (const { attrs, text } of headline) {
    const total = native.verdict.totals[attrs['data-arm']];
    if (total === null) {
      const never = native.tasks.filter(task => native.cells.find(c => c.task === task && c.arm === attrs['data-arm'])?.passes === 0);
      assert.match(text, new RegExp(`^no total: never passed ${never[0]}`));
    } else assert.equal(text, `${f1(total)} s`);
  }
  const withTotals = headline.filter(l => !l.text.startsWith('no total')).slice(1).map(l => native.verdict.totals[l.attrs['data-arm']]);
  assert.deepEqual(withTotals, [...withTotals].sort((a, b) => a - b), 'the other arms are sorted by total');
  for (const { attrs, text } of labels(files['img/overview-light.svg'])) {
    const study = studyFor(all, attrs['data-family'], attrs['data-browser'] || null);
    const total = study.verdict.totals[attrs['data-arm']];
    assert.equal(text, total === null ? 'no total: a task never passed' : `${f1(total)} s`, `${attrs['data-family']} ${attrs['data-browser']} ${attrs['data-arm']}`);
  }
});

test('each SVG is well formed, names its caption, and loads nothing', () => {
  const all = committed(), files = renderCharts(all);
  for (const [name, svg] of Object.entries(files)) {
    wellFormed(svg, name);
    const id = name.replace(/^(img|charts)\/|-(light|dark)\.svg$/g, '');
    assert.ok(svg.includes(`<desc id="desc">${chartCaption(id, all).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</desc>`), `${name}: desc is the caption`);
    // The xmlns declaration is the one URL an SVG image needs; nothing else may name a host.
    assert.ok(!svg.replace('xmlns="http://www.w3.org/2000/svg"', '').includes('http'), `${name}: names a host`);
    assert.ok(!/<script|@import|<image|<foreignObject|href=/i.test(svg), `${name}: loads or runs something`);
    assert.ok(svg.length < 60_000, `${name}: ${svg.length} bytes`);
  }
});

test('the palette keeps text readable on both surfaces', () => {
  const lum = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const palette of Object.values(PALETTES)) {
    assert.ok(contrast(palette.ink, palette.bg) > 12, 'text');
    assert.ok(contrast(palette.muted, palette.bg) >= 4.5, 'muted text');
    for (const mark of ['me', 'other', 'slate']) assert.ok(contrast(palette[mark], palette.bg) >= 3, `${mark} marks`);
  }
});

test('chartBlock gives the picture pair for a page\'s path and repeats the caption under it', () => {
  const all = committed();
  for (const chart of CHARTS) {
    const caption = chartCaption(chart.id, all);
    assert.ok(/^[A-Z].*\.$/.test(caption) && !/\n/.test(caption) && !/;/.test(caption), `${chart.id}: one line of sentences`);
    const readme = chartBlock(chart.id, all, { base: 'docs/results/' });
    const dir = chart.kind === 'summary' ? 'charts' : 'img';
    assert.ok(readme.includes(`<source media="(prefers-color-scheme: dark)" srcset="docs/results/${dir}/${chart.id}-dark.svg">`));
    assert.ok(readme.includes(`<img src="docs/results/${dir}/${chart.id}-light.svg" width="900" alt="`));
    assert.ok(readme.includes('\n\n<sub>') && readme.endsWith('</sub>\n'));
    assert.ok(chartBlock(chart.id, all).includes(`src="${dir}/${chart.id}-light.svg"`));
    const alt = /alt="([^"]*)"/.exec(readme)[1];
    assert.equal(unescape(alt), caption);
  }
  assert.throws(() => chartBlock('no-such-chart', all), /no chart/);
});

test('experiment, validation and release charts label every study and arm with the recorded pass count', () => {
  const all = committed(), files = renderCharts(all);
  for (const chart of CHARTS.filter(chart => chart.kind === 'summary')) {
    const rows = summaryRows(all, chart.family);
    const printed = labels(files[`charts/${chart.id}-light.svg`]);
    assert.equal(printed.length, rows.length);
    for (const row of rows) {
      const label = printed.find(p => p.attrs['data-study'] === row.study && p.attrs['data-arm'] === row.arm);
      assert.equal(label?.text, `${f1(row.runs ? row.passed / row.runs * 100 : 0)}% (${row.passed}/${row.runs})`);
      if (chart.family !== 'release-passes') {
        const runs = all[chart.family].studies.find(study => study.id === row.study).runs.filter(run => run.arm === row.arm);
        assert.equal(row.passed, runs.filter(run => run.passed).length);
        assert.equal(row.runs, runs.length);
      } else {
        const runs = all[chart.family].runs.filter(run => run.file === row.study && run.arm === row.arm);
        assert.equal(row.passed, runs.filter(run => run.passed).length);
        assert.equal(row.runs, runs.length);
      }
    }
  }
});

test('footers name the engine versions and UTC dates once the data carries them', () => {
  const all = committed();
  const study = clone(studyFor(all, 'native-claim'));
  // A data file collected before engine tracking has no engines field.
  delete study.engines;
  assert.match(engineLine(study), /not in this data file/);
  const bucket = (runs, recorded, first, last) => ({ runs, recorded, first, last, datesInferred: 0, undated: 0 });
  const none = () => bucket(0, 0, null, null);
  study.engines = {
    sleight: { versions: { '26.1013.40934': bucket(30, 30, '2026-10-19T03:00:00Z', '2026-10-19T04:00:00Z') }, ambiguous: none(), unknown: none() },
    codex: { versions: { '26.1007.71326': bucket(27, 0, '2026-10-17T04:00:00Z', '2026-10-17T07:00:00Z') }, ambiguous: bucket(2, 0, '2026-10-17T08:00:00Z', '2026-10-17T08:10:00Z'), unknown: none() },
    lcu: { versions: { '26.1007.71326': bucket(27, 0, '2026-10-17T04:00:00Z', '2026-10-17T07:00:00Z') }, ambiguous: none(), unknown: none() },
  };
  assert.equal(engineLine(study), 'ChatGPT engine for sleight and Codex: 26.1007.71326 (2026-10-17, inferred) and 26.1013.40934 (2026-10-19, recorded). 2 runs have no settled version. Dates are UTC.');
  const data = clone(all);
  data['native-claim'].studies[0] = study;
  // Footer lines wrap, so read the chart's text back as one string.
  const words = svg => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => unescape(m[1])).join(' ');
  for (const id of ['family-native-claim', 'headline-native']) assert.ok(words(renderCharts(data)[`img/${id}-light.svg`]).includes(engineLine(study)), id);
});

test('a race set with a same-model pair draws its own two-bar rows from the pair\'s cells', () => {
  const all = clone(committed());
  const study = studyFor(all, 'browser-race', 'safari');
  study.cells.push(...study.tasks.map((task, i) => ({ task, arm: 'codex-sleight', runs: 3, passes: i === 0 ? 0 : 3, expected: i === 0 ? null : 10 + i, median: null, min: null, max: null, p90: null })));
  study.sameModel = [{ hosted: 'codex-sleight', base: 'codex', wording: 'completed every task, fastest on 9 of 12' }];
  const svg = renderCharts(all)['img/family-browser-race-safari-light.svg'];
  const same = labels(svg).filter(l => l.attrs['data-section'] === 'same');
  assert.equal(same.length, study.tasks.length * 2);
  for (const { attrs, text } of same) assert.equal(text, cellText(study.cells.find(c => c.task === attrs['data-task'] && c.arm === attrs['data-arm'])));
  assert.ok(svg.includes('Same model: sleight inside Codex against Codex'));
  assert.match(chartCaption('family-browser-race-safari', all), /same-model rows put sleight inside Codex against Codex/);
});

test('a family without a complete set gets a chart that says so', () => {
  const all = clone(committed());
  for (const s of all['browser-race'].studies) s.latest = false;
  const files = renderCharts(all);
  assert.match(files['img/family-browser-race-firefox-light.svg'], /No complete set yet\./);
  assert.match(chartCaption('overview', all), /Firefox, engine path has no complete set yet\./);
  for (const [name, svg] of Object.entries(files)) wellFormed(svg, name);
});
