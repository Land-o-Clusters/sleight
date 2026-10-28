// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { claim, score } from '../bench/claim-score.mjs';
import { engineMix, summarizeEngines } from '../bench/engine-version.mjs';
import { chartCaption } from '../bench/results-charts.mjs';
import { jobColors } from '../bench/world/job-fixtures.mjs';
import {
  BUILD_A, BUILD_B, FAMILIES, NAV, README_BLOCKS, cellText, cellsFor, collectBank, collectJsonAbs, collectRace, collectRematch, collectReleases, collectRunnerStudies, collectValidation,
  compareTasks, dateRange, exploreData, findBanks, listRaceRounds, lossRule, parseRunnerReport, ownerPass, publicVoice, raceDirs, readBank, readmeBlocks, render, renderNav,
  releaseFreshness, releaseTaskSlowdowns, renderNavHtml, renderReadme, rowsFromCell, scoreClaimDir, scrub, scrubPaths, spliceReadme, taskMatrix, variantOf,
} from '../bench/results-hub.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'docs/results');
const WT = join(homedir(), 'Projects/sleight-wt');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const committed = () => Object.fromEntries(FAMILIES.map(f => [f.id, readJson(join(OUT, 'data', `${f.id}.json`))]));
const page = name => readFileSync(join(OUT, name), 'utf8');

// Every study the committed data holds, with the page its tables are on.
function allStudies(all) {
  return [
    ...all['native-claim'].studies.map(s => ({ s, page: 'native-claim.md' })),
    ...all['app-claim'].studies.map(s => ({ s, page: 'app-claim.md' })),
    ...all['browser-race'].studies.map(s => ({ s, page: 'browser-race.md' })),
    ...all['browser-turbo'].race.studies.map(s => ({ s, page: 'browser-turbo.md' })),
    // Only the headline gate studies get a per-task table on the page; the rest show round totals.
    ...all['browser-turbo'].gates.filter(s => all['browser-turbo'].headline.includes(s.id)).map(s => ({ s, page: 'browser-turbo.md' })),
    ...all['ab-tests'].studies.map(s => ({ s, page: 'ab-tests.md' })),
  ];
}

test('rendering is deterministic and the committed pages match the committed data', () => {
  const all = committed();
  const first = render(all), second = render(committed());
  assert.deepEqual(first, second);
  for (const [name, text] of Object.entries(first)) assert.equal(readFileSync(join(OUT, name), 'utf8'), text, `${name} is stale: run node bench/results-hub.mjs`);
});

test('collecting from docs/benchmarks twice gives the same studies', () => {
  assert.deepEqual(collectRunnerStudies(), collectRunnerStudies());
  assert.deepEqual(collectJsonAbs(), collectJsonAbs());
  assert.deepEqual(collectReleases(), collectReleases());
});

test('committed release data includes the newest release pass the collector can see', t => {
  const result = releaseFreshness(committed()['release-passes']);
  if (result.skipped) return t.skip(result.skipped);
  assert.equal(result.stale, null, `${result.stale} is newer than the hub data: run node bench/results-hub.mjs (newest: ${result.newest})`);
});

test('release freshness catches a missing newest pass and a correction under the same filename, without using mtimes', t => {
  const bench = mkdtempSync(join(tmpdir(), 'hub-release-'));
  t.after(() => rmSync(bench, { recursive: true, force: true }));
  const options = { bench };
  assert.match(releaseFreshness({ files: [], releaseInputs: [], runs: [] }, options).skipped, /no raw release-pass/);
  const name = '2026-10-26-release-1.5.0.json';
  const raw = { stamp: '2026-10-26T12:00:00Z', arms: ['sleight'], results: [{ arm: 'sleight', task: 'one', seconds: 10, passed: true }] };
  writeFileSync(join(bench, name), JSON.stringify(raw));
  assert.deepEqual(releaseFreshness({ files: [], releaseInputs: [], runs: [] }, options), { newest: name, stale: name });
  const data = collectReleases(options);
  // A checkout's mtimes say when it was copied, not which results it contains.
  utimesSync(join(bench, name), new Date(0), new Date(0));
  assert.deepEqual(releaseFreshness(data, options), { newest: name, stale: null });
  raw.results[0].passed = false;
  writeFileSync(join(bench, name), JSON.stringify(raw));
  assert.deepEqual(releaseFreshness(data, options), { newest: name, stale: name });
  assert.match(releaseFreshness(data, { bench: join(bench, 'absent') }).skipped, /no raw release-pass/);
});

test('every committed cell equals claim-score\'s score() and claim() over the committed runs, and the pages print them', () => {
  const all = committed();
  for (const { s, page: name } of allStudies(all)) {
    const table = score(s.runs.map(r => ({ arm: r.arm, task: r.task, seconds: r.seconds, passed: r.passed })));
    const verdict = claim(table, { tasks: s.tasks, arms: s.arms }, s.me);
    for (const cell of s.cells) {
      const t = table[cell.arm][cell.task];
      assert.equal(cell.runs, t.runs.length, `${s.id} ${cell.arm} ${cell.task} runs`);
      assert.equal(cell.passes, t.passes.length, `${s.id} ${cell.arm} ${cell.task} passes`);
      if (t.expected === null) assert.equal(cell.expected, null);
      // Race runs are stored to the millisecond, so expected time can move in the third decimal.
      else assert.ok(Math.abs(cell.expected - t.expected) < 0.01, `${s.id} ${cell.arm} ${cell.task} expected ${cell.expected} against ${t.expected}`);
    }
    assert.equal(s.verdict.wording, verdict.wording, `${s.id} wording`);
    {
      const text = page(name);
      for (const cell of s.cells) assert.ok(text.includes(`| ${cellText(cell)} |`) || text.includes(` ${cellText(cell)} |`), `${name} prints ${s.id} ${cell.arm} ${cell.task} as ${cellText(cell)}`);
    }
  }
});

test('the claim pages equal claim-score.mjs run on the same results folder', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-claim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (arm, task, n, seconds, passed, reason) => ({ arm, task, run: n, seconds, passed, ...(passed ? {} : { reason }), models: ['claude-haiku-5-5'] });
  writeFileSync(join(dir, '2026-10-30T00-00-00-000Z.json'), JSON.stringify({ arms: ['sleight'], model: 'claude-haiku-5-5', effort: 'high', results: [
    run('sleight', 'calculator-click', 1, 7.5, true), run('sleight', 'calculator-click', 2, 6.25, true), run('sleight', 'calculator-click', 3, 9, false, 'display shows 0'),
    run('sleight', 'preview-read', 1, 5, true), run('sleight', 'preview-read', 2, 4.5, true), run('sleight', 'preview-read', 3, 5.5, true),
    run('sleight', 'not-a-claim-task', 1, 1, true),
  ] }));
  writeFileSync(join(dir, '2026-10-30T01-00-00-000Z.json'), JSON.stringify({ arms: ['lcu'], results: [
    run('lcu', 'calculator-click', 1, 8, true), run('lcu', 'calculator-click', 2, 8.5, true), run('lcu', 'calculator-click', 3, 30, true),
    run('lcu', 'preview-read', 1, 4, true), run('lcu', 'preview-read', 2, 4.2, false, 'wrong page count'), run('lcu', 'preview-read', 3, 4.1, true),
  ] }));
  const rules = readJson(join(ROOT, 'bench/claim-exclusions.json'));
  const cli = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'bench/claim-score.mjs'), '--results', dir, '--json'], { encoding: 'utf8' }));
  const mine = scoreClaimDir(dir, rules, rules.since);
  assert.deepEqual(JSON.parse(JSON.stringify(mine.table)), cli.table);
  assert.deepEqual(JSON.parse(JSON.stringify(mine.verdict)), cli.claim);
  assert.deepEqual(mine.dropped, cli.dropped);
  assert.deepEqual(mine.warnings, cli.warnings);
  const arms = rules.arms.filter(arm => mine.table[arm]);
  const { cells } = cellsFor(mine.rows, rules.tasks, arms, 'sleight');
  const click = cells.find(c => c.arm === 'sleight' && c.task === 'calculator-click');
  assert.ok(Math.abs(click.expected - cli.table.sleight['calculator-click'].expected) < 1e-9);
  assert.equal(cellText(click), `${(Math.round(cli.table.sleight['calculator-click'].expected * 10) / 10).toFixed(1)} (2/3)`);
});

test('the committed native claim equals the saved claim-score output for its folder', t => {
  const saved = join(WT, 'app-claim/native-score-1018b.json');
  const dir = join(WT, 'app-claim/native-results-1018b');
  if (!existsSync(saved) || !existsSync(dir)) { t.skip('the raw native claim folder is not on this Mac'); return; }
  const study = committed()['native-claim'].studies[0];
  const cli = readJson(saved);
  for (const cell of study.cells) {
    const t2 = cli.table[cell.arm][cell.task];
    assert.equal(cell.passes, t2.passes.length);
    assert.equal(cell.runs, t2.runs.length);
    assert.ok(t2.expected === null ? cell.expected === null : Math.abs(cell.expected - t2.expected) < 0.001, `${cell.arm} ${cell.task}`);
  }
  assert.equal(study.verdict.wording, cli.claim.wording);
  assert.deepEqual(study.verdict.lowest, cli.claim.lowest);
});

test('a race set scores the same as race-score.mjs on the same round folders', t => {
  const raceDir = join(WT, 'race-1017');
  if (!existsSync(raceDir)) { t.skip('the race folder is not on this Mac'); return; }
  const fresh = collectRace({ raceDir, browsers: ['safari', 'firefox'], family: 'browser-race', title: 'race' });
  for (const study of fresh.studies.filter(s => s.latest)) {
    const dirs = study.rounds.map(r => join(raceDir, r.round));
    const cli = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'bench/fowl/race-score.mjs'), ...dirs, '--json'], { encoding: 'utf8', maxBuffer: 1 << 28 }));
    const scored = cli.browsers[study.browser];
    for (const cell of study.cells) {
      const t2 = scored.table[cell.arm][cell.task];
      assert.equal(cell.passes, t2.passes.length, `${study.id} ${cell.arm} ${cell.task}`);
      assert.ok(t2.expected === null ? cell.expected === null : Math.abs(cell.expected - t2.expected) < 0.001, `${study.id} ${cell.arm} ${cell.task}`);
    }
    for (const arm of study.arms) assert.deepEqual(study.verdict.raceFastest[arm], scored.fastest[arm]);
  }
});

test('a race set leaves sleight inside Codex out of sleight\'s verdict and shows it against Codex on the same model', t => {
  const raceDir = mkdtempSync(join(tmpdir(), 'hub-race-'));
  t.after(() => rmSync(raceDir, { recursive: true, force: true }));
  const ok = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'completed', error: null, result: { content: [{ type: 'text', text: 'state' }] } } });
  const round = (name, surface, tasks) => {
    const dir = join(raceDir, name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'browser.json'), JSON.stringify({ browser: 'safari' }));
    for (const [task] of tasks) { mkdirSync(join(dir, task)); writeFileSync(join(dir, task, 'events.jsonl'), ok + '\n'); }
    writeFileSync(join(dir, 'results.json'), JSON.stringify(tasks.map(([task, seconds]) => ({ task: { name: task, browser: 'safari' }, surface, wallMs: seconds * 1000,
      site: { lines: [] }, run: { started: Date.parse('2026-10-19T06:00:00Z'), finished: Date.parse('2026-10-19T06:01:00Z'), result: { result: 'RESULT: fixture' } }, outcome: { ok: true, cell: 'ok', problems: [] } }))));
  };
  for (const i of [1, 2, 3]) {
    round(`safari-sleight-r${i}`, 'sleight', [['form-travel', 30], ['mdn', 20]]);
    round(`safari-codex-r${i}`, 'codex', [['form-travel', 50], ['mdn', 40]]);
    round(`safari-codex-sleight-r${i}`, 'codex-sleight', [['form-travel', 25], ['mdn', 45]]);
  }
  const race = collectRace({ raceDir, browsers: ['safari', 'firefox'], family: 'browser-race', title: 'Safari and Firefox race' });
  const study = race.studies.find(s => s.label === 'sleight');
  assert.deepEqual(study.arms, ['sleight', 'codex']);
  assert.deepEqual(study.hosted, ['codex-sleight']);
  assert.equal(study.verdict.wording, 'fastest');
  assert.deepEqual(study.verdict.fastest, { sleight: ['form-travel', 'mdn'], codex: [] });
  assert.deepEqual(study.verdict.lost, []);
  assert.deepEqual(study.verdict.topUps, []);
  assert.deepEqual(study.cells.filter(c => c.arm === 'codex-sleight').map(c => [c.task, c.expected]), [['form-travel', 25], ['mdn', 45]]);
  const [pair] = study.sameModel;
  assert.deepEqual([pair.hosted, pair.base], ['codex-sleight', 'codex']);
  assert.deepEqual(pair.fastest, { 'codex-sleight': ['form-travel'], codex: ['mdn'] });
  assert.deepEqual(pair.totals, { 'codex-sleight': 70, codex: 90 });
  assert.deepEqual(pair.lost.map(l => [l.task, l.by.map(b => b.arm)]), [['mdn', ['codex']]]);
  assert.equal(pair.wording, 'completed every task, fastest on 1 of 2');
  const md = render({ ...committed(), 'browser-race': race })['browser-race.md'];
  const section = md.slice(md.indexOf('## Safari'));
  const sameAt = section.indexOf('Same model: sleight inside Codex against Codex');
  assert.ok(sameAt > 0, 'the page has a same-model section');
  assert.match(section.slice(0, sameAt), /By the loss rule, sleight didn't lose a task\./);
  assert.match(section.slice(0, sameAt), /\| Task \| sleight \| Codex \|\n/, 'sleight\'s task table has no codex-sleight column');
  assert.ok(!section.slice(0, sameAt).includes('Arm ahead'));
  assert.match(section.slice(sameAt), /\| Task \| sleight inside Codex \| Codex \|/);
  assert.match(section.slice(sameAt), /By the loss rule, sleight inside Codex lost 1 of 2 tasks\./);
  // The same-model section sits outside the folds, under its own heading.
  assert.match(outsideDetails(section), /### Same model: sleight inside Codex against Codex\n[\s\S]*\| Task \| sleight inside Codex \| Codex \|/);
});

test('no generated file holds a home path, the account name or the owner\'s name', () => {
  // A fixed list, plus the full name macOS reports for this account (id -F) so no name is written into the repo. The account
  // name alone isn't used: on CI it is 'runner', a word the pages use.
  const names = [];
  if (process.platform === 'darwin') try { names.push(...execFileSync('id', ['-F'], { encoding: 'utf8' }).trim().split(/\s+/)); } catch { /* no full name */ }
  const banned = [/\/Users\//, /\/var\/folders\//, ...[...new Set(names.filter(name => name.length >= 3))].map(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'))];
  const files = [...readdirSync(OUT).filter(n => !n.startsWith('.')).map(n => join(OUT, n)), ...readdirSync(join(OUT, 'data')).map(n => join(OUT, 'data', n))]
    .filter(path => /\.(md|html|json)$/.test(path));
  assert.ok(files.length >= 14);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\/Users\//, file);
    assert.ok(!text.includes(homedir()), file);
    for (const re of banned) assert.doesNotMatch(text, re, file);
  }
  assert.equal(scrubPaths(`${homedir()}/x and ${MAC_USERS}someone/y`), '~/x and ~/y');
  assert.equal(scrubPaths('at /private/var/folders/ab/cd/T/x.json and /var/folders/ab/cd/T/y'), 'at $TMPDIR and $TMPDIR');
  assert.equal(scrubPaths('the runner graded it'), 'the runner graded it', 'rendering scrubs paths only, never words');
  assert.equal(scrub(`${MAC_USERS}someone/z`), '~/z');
});

test('runner reports parse into runs, and the owner\'s scoring passes a checkout that stopped', () => {
  const text = [
    '| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    '| form-checkout | sleight-turbo | helium | FAIL, score 0/10 | ok | n/a | ok | n/a | n/a | n/a | 44 s, 44 s net / 240 | 13 calls | in 1 | 0.009 |',
    '| wikipedia | sleight-turbo | chrome | ok | ok | n/a | ok | n/a | n/a | n/a | 6 s, 6 s net / 90 | 1 calls, 2 errors | in 4 | 0.002 |',
    '', 'ROUND NOT CLEAN: 1 problems', '', '- form-checkout · outcome · nothing submitted', '', 'Answers:',
  ].join('\n');
  const { rows, problems } = parseRunnerReport(text);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].ok, rows[0].seconds, rows[0].calls, rows[0].errors], [false, 44, 13, 0]);
  assert.deepEqual([rows[1].ok, rows[1].seconds, rows[1].calls, rows[1].errors], [true, 6, 1, 2]);
  assert.deepEqual(problems['form-checkout'], ['outcome: nothing submitted']);
  assert.deepEqual(variantOf('gate2-20261013-1207-fowlbrowser-swap'), { variant: 'fowlbrowser', session: 'gate2-20261013-1207', order: 'swap' });
  assert.deepEqual(variantOf('1309-sleight-normal'), { variant: 'sleight', session: '1309', order: 'normal' });
  assert.deepEqual(variantOf('candidate-normal'), { variant: 'candidate', session: null, order: 'normal' });
  const gate = committed()['browser-turbo'].gates.find(s => s.id === '2026-10-16-gate-3');
  const turboCheckout = gate.runs.filter(r => r.arm === 'sleight-turbo' && r.task === 'form-checkout');
  assert.equal(turboCheckout.length, 10);
  assert.ok(turboCheckout.every(r => r.passed && !r.runnerOk), 'every turbo checkout stopped before paying, a pass under the owner\'s scoring');
});

test('the owner\'s scoring looks only at the outcome problems of a checkout run', () => {
  const failed = { task: 'form-checkout', ok: false };
  assert.equal(ownerPass(failed, ['outcome: nothing submitted']), true);
  assert.equal(ownerPass(failed, ['outcome: nothing submitted', 'focus: took focus']), true, 'a focus problem is not an outcome problem');
  assert.equal(ownerPass(failed, ['focus: took focus']), false, 'no outcome problem recorded');
  assert.equal(ownerPass(failed, ['outcome: paid without a stated amount']), false);
  assert.equal(ownerPass({ task: 'form-travel', ok: false }, ['outcome: nothing submitted']), false);
  assert.equal(ownerPass({ task: 'wikipedia', ok: true }, []), true);
});

test('the loss rule counts a lower expected time or a faster passing run', () => {
  const table = score([
    { arm: 'sleight', task: 'a', seconds: 10, passed: true }, { arm: 'sleight', task: 'a', seconds: 10, passed: true },
    { arm: 'x', task: 'a', seconds: 8, passed: true }, { arm: 'x', task: 'a', seconds: 40, passed: true },
    { arm: 'sleight', task: 'b', seconds: 5, passed: true }, { arm: 'x', task: 'b', seconds: 6, passed: true },
  ]);
  assert.deepEqual(lossRule(table, ['a', 'b'], ['sleight', 'x'], 'sleight'), [{ task: 'a', by: [{ arm: 'x', lowerExpected: false, fasterRun: true }] }]);
  assert.equal(dateRange('2026-10-18T02-39', '2026-10-18T03-16'), '2026-10-18, 02:39 to 03:16 UTC');
  assert.equal(dateRange('2026-10-17T04-20', '2026-10-18T03-33'), '2026-10-17 to 2026-10-18');
});

// A small stand-in for the DOM, enough for explore.html's script to build its filters, charts and tables.
class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this.text = ''; this.value = ''; this.hidden = false; this.offsetWidth = 100; this.offsetHeight = 40; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...kids) { this.children = kids; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  count(tag) { return (this.tagName === tag ? 1 : 0) + this.children.reduce((n, c) => n + c.count(tag), 0); }
}

test('the hub fills the Pages landing with the real chart captions', () => {
  const all = committed();
  const html = render(all)['index.html'];
  for (const id of ['headline-native', 'overview']) {
    const caption = chartCaption(id, all);
    assert.ok(caption.length > 40, id);
    assert.ok(html.includes(`id="${id}-caption">${caption}</figcaption>`));
    assert.ok(html.includes(`alt="${caption}"`));
  }
});

test('the landing includes the family results and chart captions without JavaScript', () => {
  const all = committed();
  const html = render(all)['index.html'].replace(/<script>[\s\S]*?<\/script>/g, '');
  const body = /<tbody id="families">([\s\S]*?)<\/tbody>/.exec(html)[1];
  for (const family of FAMILIES) {
    assert.ok(body.includes(`data/${family.id}.json`), family.id);
    assert.ok(body.includes(family.page), family.page);
  }
  for (const id of ['headline-native', 'overview']) assert.ok(html.includes(chartCaption(id, all)));
  assert.match(body, /only arm with a total/);
  assert.doesNotMatch(body, /See the task matrices and earlier sets/);
});

test('family text in the static landing is escaped as HTML', () => {
  const family = { ...FAMILIES[0], title: 'x</script><img src=//x> <!-- y & "z"', page: 'x" onclick="bad', id: 'y" onclick="bad' };
  const all = committed();
  all[family.id] = all['native-claim'];
  FAMILIES.push(family);
  try {
    const html = render(all)['index.html'];
    assert.doesNotMatch(html, /<img src=\/\/x>/);
    assert.doesNotMatch(html, /<!-- y/);
    assert.ok(html.includes('x&lt;/script&gt;&lt;img src=//x&gt; &lt;!-- y &amp; &quot;z&quot;'));
    assert.doesNotMatch(html, / onclick="bad/);
    assert.ok(html.includes('x&quot; onclick=&quot;bad'));
    assert.ok(html.includes('y&quot; onclick=&quot;bad.json'));
  } finally { FAMILIES.pop(); }
});

test('the native results follow the newest compatibility entry and the short README stays unchanged', () => {
  const all = committed();
  const compat = readJson(join(OUT, 'data/engine-compat.json'));
  all['engine-compat'] = compat;
  const shortClaim = readmeBlocks(all).claim;
  const nativePage = () => render(all)['native-claim.md'];
  const before = nativePage();
  compat.entries.unshift({ checkedAt: '2026-11-01T00:00:00Z', appVersion: '26.1101.100', engineVersion: '26.1101.200' });
  const after = nativePage();
  assert.notEqual(after, before);
  assert.match(after, /newer ChatGPT release, 26\.1101\.100/);
  assert.doesNotMatch(after, /26\.1013\.40934/);
  compat.entries = [{ checkedAt: '2026-11-02T00:00:00Z', appVersion: null, engineVersion: '26.1007.71326' }];
  assert.doesNotMatch(nativePage(), /newer ChatGPT release|Compatibility checks do not remeasure speed/);
  compat.entries[0].engineVersion = '26.1007.21159';
  assert.doesNotMatch(nativePage(), /newer ChatGPT release/);
  compat.entries[0].engineVersion = '26.1102.200';
  assert.match(nativePage(), /newer ChatGPT release, 26\.1102\.200/);
  assert.equal(readmeBlocks(all).claim, shortClaim);
});

test('the native comparison changes when the number or order of competing totals changes', () => {
  const all = committed(), study = all['native-claim'].studies[0];
  assert.match(render(all)['native-claim.md'], /Claude computer use, the only other arm that passed every task, took 453\.9 s/);
  assert.match(readmeBlocks(all).claim, /Claude computer use: 453\.9 s/);
  study.verdict.totals.lcu = 400;
  assert.match(render(all)['native-claim.md'], /LCU, the fastest of 2 other arms that passed every task, took 400\.0 s/);
  assert.match(readmeBlocks(all).claim, /LCU: 400\.0 s/);
  for (const arm of study.arms.filter(a => a !== study.me)) study.verdict.totals[arm] = null;
  assert.doesNotMatch(readmeBlocks(all).claim, /\bother arm\b|next lowest total/);
});

test('Safari and Firefox keep their task counts and totals across every summary', () => {
  const all = committed(), files = render(all), { benchmarks } = readmeBlocks(all);
  for (const browser of ['safari', 'firefox']) {
    const s = all['browser-race'].studies.find(s => s.latest && s.browser === browser);
    const count = `${s.verdict.lowest.length} of ${s.tasks.length} tasks`;
    const total = `${s.verdict.totals[s.me].toFixed(1)} s`;
    for (const text of [benchmarks, files['README.md'], files['index.html'], files['browser-race.md']]) {
      assert.ok(text.includes(`fastest on ${count}`), `${browser}: task count`);
      assert.ok(text.includes(total), `${browser}: total`);
    }
  }
  const safari = all['browser-race'].studies.find(s => s.latest && s.browser === 'safari');
  assert.ok(benchmarks.includes(`the only arm with a total (${safari.verdict.totals.sleight.toFixed(1)} s)`));
  safari.verdict.lowest.pop();
  safari.verdict.totals[safari.me] = 601;
  safari.verdict.totals.cua = 900;
  for (const text of [readmeBlocks(all).benchmarks, render(all)['index.html'], render(all)['README.md'], render(all)['browser-race.md']]) {
    assert.ok(text.includes(`fastest on ${safari.verdict.lowest.length} of ${safari.tasks.length} tasks`));
    assert.ok(text.includes('Its total is 601.0 s'));
  }
});

test('public study titles and catalog labels use complete tester wording without changing recorded data', () => {
  const all = committed(), original = JSON.stringify(all);
  const files = render(all);
  assert.doesNotMatch(files['ab-tests.md'], /tester at th`|2 rounds, tester`|\b[Oo]wner\b/);
  assert.match(files['ab-tests.md'], /Tester-away runs/);
  assert.equal(publicVoice("Owner-away, the owner's account and the owner allowed it"), "Tester-away, the tester's account and the tester allowed it");
  assert.equal(JSON.stringify(all), original);
});

test('explore.html runs, fills its filters, draws charts per task and switches family', () => {
  const html = page('explore.html');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const nodes = Object.fromEntries(ids.map(id => [id, new FakeNode(id)]));
  const document = { documentElement: new FakeNode('html'), getElementById: id => nodes[id], createElement: tag => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag), createTextNode: text => Object.assign(new FakeNode('#text'), { text }) };
  const localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  vm.runInNewContext(script, { document, localStorage, window: { innerWidth: 390 }, console });
  assert.ok(nodes['f-family'].children.length >= FAMILIES.length);
  assert.equal(nodes.charts.children.length, 9, 'one chart per native claim task');
  assert.equal(nodes.charts.count('circle'), 2 * committed()['native-claim'].studies[0].runs.length, 'a dot and a hit area per run');
  assert.ok(nodes.cells.count('tr') > 9 * 6);
  nodes['f-family'].listeners.change[0]({ target: { value: 'browser-race' } });
  assert.ok(nodes['f-study'].children.length >= 2);
  nodes['f-study'].listeners.change[0]({ target: { value: nodes['f-study'].children[1].attrs.value } });
  assert.ok(nodes.charts.children.length >= 12, 'one chart per race task');
  const cellRows = () => nodes.cells.children[1].children.length;
  const all = cellRows();
  nodes['f-result'].listeners.change[0]({ target: { value: 'fail' } });
  assert.ok(cellRows() < all, 'the result filter narrows the cell table to cells with a failed run');
  nodes['f-result'].listeners.change[0]({ target: { value: '' } });
  nodes.theme.listeners.click[0]();
  assert.equal(document.documentElement.attrs['data-theme'], 'light');
  for (const family of FAMILIES) {
    nodes['f-family'].listeners.change[0]({ target: { value: family.id } });
    const study = nodes['f-study'].children.find(child => child.attrs.value !== '');
    assert.ok(study, `${family.id} has a study`);
    nodes['f-study'].listeners.change[0]({ target: { value: study.attrs.value } });
    assert.ok(nodes.charts.count('svg') > 0, `${family.id} draws a chart without opening a browser`);
  }
});

test('explore.html keeps the sleight-against-itself family out of All families and labels it where it is picked', () => {
  const html = page('explore.html');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const nodes = Object.fromEntries(ids.map(id => [id, new FakeNode(id)]));
  const document = { documentElement: new FakeNode('html'), getElementById: id => nodes[id], createElement: tag => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag), createTextNode: text => Object.assign(new FakeNode('#text'), { text }) };
  vm.runInNewContext(script, { document, localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }, window: { innerWidth: 390 }, console });
  const options = id => nodes[id].children.map(child => [child.attrs.value, child.text ?? child.children?.[0]?.text]);
  const label = options('f-family').find(([value]) => value === 'validation')[1];
  assert.match(label, /\(sleight against itself\)$/);
  nodes['f-family'].listeners.change[0]({ target: { value: '' } });
  assert.equal(options('f-arm').some(([value]) => /^build-/.test(value)), false, 'All families lists only the real arms');
  assert.equal(options('f-study').some(([, text]) => /remeasure|validation-/.test(text ?? '')), false);
  nodes['f-family'].listeners.change[0]({ target: { value: 'validation' } });
  assert.deepEqual(options('f-arm').map(([value]) => value).filter(Boolean).sort(), ['build-A', 'build-B']);
});

test('the validation family carries no claim or scorer wording, and a bank\'s names and paths are scrubbed', t => {
  const { wt } = fixtureWt(t);
  const data = collectValidation({ wt });
  const text = JSON.stringify(data);
  for (const study of data.studies) for (const key of ['verdict', 'wording', 'reasons', 'lost', 'fastest', 'totals', 'topUps']) assert.equal(key in study, false, key);
  assert.equal(/wording|fastest|"lowest"|completed every task/.test(text), false);
  assert.equal(data.banks.find(b => b.id === 'validation-x').source, 'validation-x', 'a bank outside the home folder shows only its folder name');
  const committedData = readJson(join(OUT, 'data/validation.json'));
  assert.ok(committedData.banks.every(b => b.source.startsWith('~/') || !b.source.includes('/')));
  assert.equal(JSON.stringify(committedData).match(/wording|"verdict"|completed every task/), null);
  assert.equal(page('validation.md').match(/Scorer wording|completed every task|fastest on \d+ of/), null);
  // The id, browser and runner are scrubbed like every other string copied from a bank.
  const owner = userInfo().username;
  const dirty = join(wt, `${owner}-bank`);
  cpSync(join(wt, 'race-1017/validation-x'), dirty, { recursive: true });
  const plan = readJson(join(dirty, 'plan.json'));
  plan.groups[1].browser = `${homedir()}/Browsers/Safari`; plan.groups[1].runner = `${homedir()}/runner`;
  writeFileSync(join(dirty, 'plan.json'), JSON.stringify(plan));
  const { record, studies } = collectBank(readBank(dirty));
  const scrubbed = JSON.stringify([record, studies]);
  assert.equal(scrubbed.includes(homedir()), false);
  // The hub scrubs owner names only on macOS, where it runs. Linux CI's user (root, runner) is an ordinary word.
  if (process.platform === 'darwin') {
    assert.equal(scrubbed.includes(`${owner}-bank`), false);
    assert.match(record.id, /^\[owner\]-bank$/);
  }
  const safari = studies.find(s => s.group === 'race-safari');
  assert.deepEqual([safari.browser, safari.runner], ['~/Browsers/Safari', '~/runner']);
});

test('pages name each arm\'s engine version with its UTC dates once the data carries them, and flag engine arms on different versions', () => {
  const all = committed(), before = render(all);
  const study = all['browser-race'].studies.find(s => s.latest);
  const run = (version, day) => ({ version, provenance: 'inferred', startedAt: `${day}T10:00:00.000Z`, endedAt: `${day}T11:00:00.000Z`, dated: 'recorded' });
  const rows = [{ arm: 'sleight', engine: run('26.1013.40934', '2026-10-19') }, { arm: 'codex', engine: run('26.1007.71326', '2026-10-18') },
    { arm: 'lcu', engine: run('26.1007.71326', '2026-10-18') }];
  const engines = summarizeEngines(rows);
  Object.assign(study, { engines, engineMix: engineMix(engines) });
  const page = render(all)['browser-race.md'];
  assert.match(page, /\| ChatGPT engine and UTC dates \| Build \|/);
  assert.match(page, /\| sleight \| [^\n]*\| engine 26\.1013\.40934 \(1 inferred\), 2026-10-19 \|/);
  assert.match(page, /\| LCU \| [^\n]*\| not used, 2026-10-18 \|/);
  assert.match(page, /The arms that use the engine ran on different engine versions: sleight on 26\.1013\.40934, codex on 26\.1007\.71326\./);
  // Data collected before engine versions were tracked renders exactly as before.
  for (const name of ['native-claim.md', 'app-claim.md', 'browser-turbo.md', 'release-passes.md']) assert.equal(render(all)[name], before[name]);
});

test('claim rows and claim-score carry the engine and date inferred from the pass stamp and the file\'s last save', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-claim-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '2026-10-18T02-39-00-000Z.json');
  writeFileSync(file, JSON.stringify({ arms: ['sleight'], results: [{ arm: 'sleight', task: 'calculator-click', run: 1, seconds: 7, passed: true }] }));
  utimesSync(file, new Date('2026-10-18T03:00:00Z'), new Date('2026-10-18T03:00:00Z'));
  const rules = readJson(join(ROOT, 'bench/claim-exclusions.json'));
  const [row] = scoreClaimDir(dir, { ...rules, since: '2026-10-18' }, '2026-10-18').rows;
  assert.deepEqual(row.engine, { version: '26.1007.71326', provenance: 'inferred', startedAt: '2026-10-18T02:39:00.000Z', endedAt: '2026-10-18T03:00:00.000Z', dated: 'inferred' });
  const cli = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'bench/claim-score.mjs'), '--results', dir, '--json'], { encoding: 'utf8' }));
  assert.deepEqual([cli.engines.sleight.versions['26.1007.71326'].runs, cli.engines.sleight.versions['26.1007.71326'].first], [1, '2026-10-18T02:39:00.000Z']);
  assert.match(execFileSync(process.execPath, [join(ROOT, 'bench/claim-score.mjs'), '--results', dir], { encoding: 'utf8' }),
    /sleight +engine 26\.1007\.71326 \(1 inferred\), 2026-10-18 \(dates inferred\)/);
});

// The generated Markdown pages: the hub landing and one per family.
const GENERATED = ['README.md', ...FAMILIES.map(f => f.page)];

// Text outside every <details> fold, nested folds included.
function outsideDetails(text) {
  let depth = 0, out = '';
  for (const part of text.split(/(<details>|<\/details>)/)) {
    if (part === '<details>') depth += 1;
    else if (part === '</details>') depth -= 1;
    else if (!depth) out += part;
    assert.ok(depth >= 0, 'a </details> without its <details>');
  }
  assert.equal(depth, 0, 'every <details> is closed');
  return out;
}
const firstTable = text => { const lines = text.split('\n'), at = lines.findIndex(l => l.startsWith('| ')); let end = at; while (lines[end]?.startsWith('| ')) end += 1; return lines.slice(at, end).join('\n'); };

test('each generated page starts with navigation, and family pages repeat it at the end', () => {
  const files = render(committed());
  for (const name of GENERATED) {
    const nav = renderNav(name), text = files[name];
    assert.ok(text.startsWith(nav + '\n\n# '), `${name} starts with the nav line and then its title`);
    if (name === 'README.md') assert.equal(text.split(nav).length, 2, 'the hub has one navigation row');
    else assert.ok(text.endsWith('\n' + nav + '\n'), `${name} ends with the nav line`);
    assert.equal(page(name), text);
  }
  assert.match(renderNav('native-claim.md'), /^\[Benchmarks\]\(README\.md\) · Native · \[Apps\]\(app-claim\.md\)/);
  assert.match(renderNav('README.md'), /^Benchmarks · \[Native\]\(native-claim\.md\)/);
  for (const { page: target } of NAV.filter(n => n.page.endsWith('.md'))) assert.ok(existsSync(join(OUT, target)), `the nav links ${target}, which exists`);
  const html = renderNavHtml('explore.html');
  assert.match(html, /<span aria-current="page">Interactive<\/span>/);
  for (const [, host] of html.matchAll(/href="https:\/\/([^/"]+)/g)) assert.ok(['github.com', 'land-o-clusters.github.io'].includes(host), host);
  assert.match(page('explore.html'), /<nav class="pages" aria-label="Benchmark pages">/);
});

test('each family page with a race or claim opens with the task matrix of its newest set as its first table', () => {
  const all = committed();
  const newest = (studies, browser) => studies.find(s => s.browser === browser && s.latest);
  const expected = {
    'native-claim.md': all['native-claim'].studies[0], 'app-claim.md': all['app-claim'].studies[0],
    'browser-turbo.md': newest(all['browser-turbo'].race.studies, 'chrome'), 'browser-race.md': newest(all['browser-race'].studies, 'safari'),
  };
  for (const [name, study] of Object.entries(expected)) assert.equal(firstTable(page(name)), taskMatrix(study), `${name}'s first table is ${study.id}'s task matrix`);
  // Only the newest set per browser shows outside the folds.
  for (const [name, studies] of [['browser-turbo.md', all['browser-turbo'].race.studies], ['browser-race.md', all['browser-race'].studies]]) {
    const visible = outsideDetails(page(name));
    for (const study of studies) assert.equal(visible.includes(`## ${study.title}`), study.latest, `${name}: ${study.id} is ${study.latest ? 'visible' : 'folded'}`);
  }
  assert.match(page('browser-turbo.md'), /^# Chrome and Helium: turbo against FowlBrowser$/m);
  assert.match(page('browser-race.md'), /^# Safari and Firefox: the engine path against Codex, LCU, Cua and Peekaboo$/m);
  assert.match(page('ab-tests.md'), /^# Experiments$/m);
  assert.ok(page('browser-turbo.md').includes('<details><summary>Gate rounds on FowlBrowser\'s runner, before production turbo</summary>'));
});

test('the method bullets appear on the pages only inside <details>', () => {
  const method = [
    'Expected time is the mean seconds per attempt divided by the pass rate (`bench/claim-score.mjs`)',
    'The rules come from [LAWS](../status/LAWS.md). Each arm gets 3 runs per task',
    '`bench/fowl/race-score.mjs` grades every saved run again',
    'FowlBrowser\'s head-to-head runner, pinned with sleight\'s patch',
    'Release passes run sleight alone on the benchmark\'s default suite',
    'Studies saved as JSON',
  ];
  let seen = 0;
  for (const name of GENERATED) {
    const text = page(name), visible = outsideDetails(text);
    for (const bullet of method) {
      assert.ok(!visible.includes(bullet), `${name} shows "${bullet.slice(0, 40)}" outside a fold`);
      if (text.includes(bullet)) seen += 1;
    }
  }
  assert.ok(seen >= 10, `the method is still on the pages, folded (${seen} bullets found)`);
});

test('release-passes.html is regenerated with its inline history chart and release data', () => {
  const files = render(committed());
  assert.match(files['release-passes.html'], /<svg .*aria-label="Pass rate of each release pass"/);
  for (const file of committed()['release-passes'].files.filter(file => file.kind === 'release')) {
    assert.ok(files['release-passes.html'].includes(file.name), file.name);
  }
  assert.doesNotMatch(files['release-passes.html'], /<script|<link|<img/i);
});

test('every family Markdown page links a generated static chart in charts', () => {
  const files = render(committed());
  for (const family of FAMILIES) {
    const links = [...files[family.page].matchAll(/<img src="(charts\/[^" ]+\.svg)"/g)];
    assert.ok(links.length > 0, `${family.id} has a static chart`);
    for (const [, link] of links) assert.match(files[link], /^<svg /, `${family.page}: ${link}`);
  }
});

test('spliceReadme fills only the marked blocks and refuses broken markers', () => {
  const shells = 'intro 1\n<!-- hub:claim -->\n<!-- /hub:claim -->\nhand-typed 2\n<!-- hub:headline --><!-- /hub:headline -->\n<!-- hub:benchmarks -->\nstale 3\n<!-- /hub:benchmarks -->\nend\n';
  const filled = spliceReadme(shells, { claim: 'A', headline: 'B', benchmarks: 'C\n\nD' });
  assert.equal(filled, 'intro 1\n<!-- hub:claim -->\nA\n<!-- /hub:claim -->\nhand-typed 2\n<!-- hub:headline -->\nB\n<!-- /hub:headline -->\n<!-- hub:benchmarks -->\nC\n\nD\n<!-- /hub:benchmarks -->\nend\n');
  assert.equal(spliceReadme(filled, { claim: 'A', headline: 'B', benchmarks: 'C\n\nD' }), filled, 'a second splice changes nothing');
  assert.equal(spliceReadme('no markers here\n', { claim: 'A' }), 'no markers here\n', 'a README without the markers is left alone');
  assert.equal(spliceReadme(shells, { headline: '' }).includes('<!-- hub:headline -->\n<!-- /hub:headline -->'), true, 'an empty block leaves an empty shell');
  assert.throws(() => spliceReadme('<!-- hub:claim --><!-- /hub:claim --><!-- hub:claim --><!-- /hub:claim -->', { claim: 'A' }), /more than once/);
  assert.throws(() => spliceReadme('<!-- hub:claim -->', { claim: 'A' }), /without the other/);
  assert.throws(() => spliceReadme('<!-- /hub:claim --><!-- hub:claim -->', { claim: 'A' }), /before the opening/);
  assert.deepEqual(Object.keys(readmeBlocks(committed())), README_BLOCKS);
});

test('the README\'s generated blocks match the data, and every number in the claim block comes from it', () => {
  const all = committed();
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.equal(renderReadme(all, readme), readme, 'README.md hub blocks are stale: run node bench/results-hub.mjs');
  for (const name of README_BLOCKS) {
    const opens = readme.split(`<!-- hub:${name} -->`).length - 1;
    assert.ok(opens <= 1, `hub:${name} appears at most once`);
  }
  const { claim, benchmarks } = readmeBlocks(all);
  const study = all['native-claim'].studies[0];
  const native = render(all)['native-claim.md'];
  assert.match(native, new RegExp(`"${study.verdict.wording}": the lowest expected time on ${study.verdict.lowest.length} of ${study.tasks.length} `));
  assert.ok(claim.includes(`${(Math.round(study.verdict.totals.sleight * 10) / 10).toFixed(1)} s`));
  assert.ok(native.includes(`over ${study.runs.length} runs dated ${study.date}`));
  assert.equal(claim.split('\n').length, 3);
  for (const fact of ['claude-haiku-5-5', 'gpt-6-luna', 'Competitors ran their defaults.', 'The skill was tuned on some of these tasks.',
    '2026-10-03 native comparison against LCU', '2026-10-08 sleight-only pass at medium effort', '2026-10-12 engine comparison against FowlBrowser',
    '2026-10-12 lean-skill A/B', '2026-10-16 turbo comparison against FowlBrowser', 'Compatibility checks do not remeasure speed.'])
    assert.ok(native.includes(fact), `the native results preserve ${fact}`);
  for (const fam of FAMILIES) assert.ok(benchmarks.includes(`](docs/results/${fam.page})`), `the benchmarks block links ${fam.page}`);
  // The hub landing's table and the README's lines are the same text.
  const landing = page('README.md');
  for (const line of benchmarks.split('\n').filter(l => l.startsWith('- '))) {
    const text = line.replace(/^- \[[^\]]+\]\([^)]+\): /, '').replace(/\.$/, '');
    assert.ok(landing.includes(text), `the landing holds "${text.slice(0, 50)}"`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// Validation and re-measure banks (family "validation"): fixtures only, no Mac folders.

const cell = (runs, passes = runs) => ({ runs, passes, mean: 0, median: 0, expected: 0 });
const HOME_FIXTURE = join(homedir(), 'fixture-bank');
function fixtureWt(t) {
  const wt = mkdtempSync(join(tmpdir(), 'hub-wt-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(join(wt, path, '..'), { recursive: true }); writeFileSync(join(wt, path), typeof value === 'string' ? value : JSON.stringify(value)); };
  const aBuild = 'a'.repeat(40), bBuild = 'b'.repeat(40);
  const plan = { schema: 1, aBuild, bBuild, engine: '26.1013.40934', groups: [
    { id: 'native', runner: 'native', tasks: ['t-one', 't-two'], model: 'claude-haiku-5-5', rounds: 3 },
    { id: 'race-safari', runner: 'browser', browser: 'safari', tasks: ['t-three'], model: 'claude-haiku-5-5', rounds: 3 },
    { id: 'release-opus', runner: 'browser', browser: 'chrome', tasks: ['t-four'], model: 'claude-opus-5-5', rounds: 1 }], rounds: [] };
  const old = { complete: false, groups: [] };
  write('race-1017/validation-x/plan.json', plan);
  // score.json is superseded by score-2.json.
  write('race-1017/validation-x/score.json', old);
  write('race-1017/validation-x/score-2.json', { complete: false, groups: [
    { id: 'native', complete: true, deferred: false, errors: [], aRounds: ['a1', 'a2', 'a3'], table: {
      A: { 't-one': cell([10, 12, 14]), 't-two': cell([20, 20, 30], [20, 20]) },
      B: { 't-one': cell([9, 11, 13]), 't-two': cell([20, 25, 28], [20, 25, 28]) } } },
    { id: 'race-safari', complete: true, deferred: false, errors: [], aRounds: ['a1'], table: {
      A: { 't-three': cell([50, 60, 70]) }, B: { 't-three': cell([55, 65, 75], [55, 65]) } } },
    { id: 'release-opus', complete: false, deferred: true, errors: [`DEFERRED release-opus: waits ${HOME_FIXTURE}`], aRounds: [], table: {} }] });
  write('race-1017/validation-x/validate-140.log', '2026-10-20T12:11:09.000Z run-start {}\n2026-10-20T18:11:09.000Z done {}\n');
  write('race-1017/validation-try1/plan.json', plan);                     // an aborted attempt: a plan and no score
  write('race-1017/evidence-replay/plan.json', { schema: 1, rounds: [] }); // another tool's plan.json
  write('remeasure-x/plan.json', { schema: 1, kind: 'final-build-remeasure', aBuild, baselineBuild: bBuild, build: 'c'.repeat(40), engine: '26.1013.40934', effort: 'high',
    groups: [{ id: 'native', runner: 'native', model: 'claude-haiku-5-5', tasks: ['t-one'] }] });
  write('remeasure-x/comparison.json', { build: 'c'.repeat(40), baselineBuild: bBuild, engine: '26.1013.40934', passed: false, complete: true, groups: [
    { id: 'native', aRounds: [{ n: 1 }, { n: 2 }, { n: 3 }], passed: false, tasks: [{ task: 't-one', a: cell([10, 12, 14]), b: cell([30, 31, 32], [30, 31]) }] }] });
  write('remeasure-x/remeasure.log', '2026-10-21T01:00:00.000Z round-start {}\n2026-10-21T02:30:00.000Z done {}\n');
  return { wt, aBuild, bBuild };
}

test('a validation score table keeps failed runs as the times with no matching pass, duplicates included', () => {
  const rows = rowsFromCell({ runs: [20, 20, 30, 40], passes: [20, 30] }, 'task', BUILD_A, 'score.json');
  assert.deepEqual(rows.map(r => [r.seconds, r.passed]), [[20, true], [20, false], [30, true], [40, false]]);
  assert.ok(rows.every(r => r.arm === BUILD_A && r.task === 'task' && r.file === 'score.json'));
  assert.deepEqual(rows.filter(r => r.passed).length, 2);
});

test('banks are found under the worktrees folder one or two folders down, and a plan that is not a bank is ignored', t => {
  const { wt } = fixtureWt(t);
  assert.deepEqual(findBanks(wt).map(b => [b.id, b.kind, b.file]), [['remeasure-x', 'remeasure', 'comparison.json'], ['validation-try1', 'validation', null], ['validation-x', 'validation', 'score-2.json']]);
  assert.equal(readBank(join(wt, 'race-1017/evidence-replay')), null);
  const elsewhere = mkdtempSync(join(tmpdir(), 'hub-bank-')); t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  cpSync(join(wt, 'remeasure-x'), join(elsewhere, 'out-bank'), { recursive: true });
  assert.deepEqual(findBanks(wt, [join(elsewhere, 'out-bank')]).map(b => b.id), ['out-bank', 'remeasure-x', 'validation-try1', 'validation-x']);
});

test('a validation bank becomes studies of build B against build A, scored like every other family, with scrubbed text', t => {
  const { wt, aBuild, bBuild } = fixtureWt(t);
  const { record, studies } = collectBank(readBank(join(wt, 'race-1017/validation-x')));
  assert.deepEqual(studies.map(s => s.id), ['validation-x-native', 'validation-x-race-safari']);
  assert.deepEqual(record.incomplete, [{ group: 'release-opus', deferred: true, why: 'DEFERRED release-opus: waits ~/fixture-bank' }]);
  assert.equal(record.date, '2026-10-20, 12:11 to 18:11 UTC');
  assert.deepEqual([record.aBuild, record.bBuild, record.engine, record.complete], [aBuild.slice(0, 8), bBuild.slice(0, 8), '26.1013.40934', false]);
  const study = studies[0];
  assert.deepEqual([study.family, study.me, study.arms, study.tasks, study.models[BUILD_B], study.aRounds], ['validation', BUILD_B, [BUILD_B, BUILD_A], ['t-one', 't-two'], ['claude-haiku-5-5'], 3]);
  const table = score(study.runs.map(r => ({ arm: r.arm, task: r.task, seconds: r.seconds, passed: r.passed })));
  for (const c of study.cells) {
    assert.equal(c.runs, table[c.arm][c.task].runs.length);
    assert.equal(c.expected, Math.round(table[c.arm][c.task].expected * 1000) / 1000);
  }
  assert.equal(study.cells.find(c => c.task === 't-two' && c.arm === BUILD_A).passes, 2);
  assert.equal(JSON.stringify([record, studies]).includes(homedir()), false);
});

test('a re-measure bank gives build A the stored rounds and build B the final build, with its gate result', t => {
  const { wt } = fixtureWt(t);
  const { record, studies } = collectBank(readBank(join(wt, 'remeasure-x')));
  assert.deepEqual([record.kind, record.passed, record.complete, record.date, record.baselineBuild], ['remeasure', false, true, '2026-10-21, 01:00 to 02:30 UTC', 'b'.repeat(8)]);
  assert.equal(record.bBuild, 'c'.repeat(8));
  assert.deepEqual(studies.map(s => [s.id, s.effort, s.aRounds]), [['remeasure-x-native', ['high'], 3]]);
  const [row] = compareTasks(studies[0]);
  assert.deepEqual([row.slower, row.lowerRate, row.marked], [true, true, true]);
});

test('a bank without a score is listed as pending and adds no study', t => {
  const { wt } = fixtureWt(t);
  const { record, studies } = collectBank(readBank(join(wt, 'race-1017/validation-try1')));
  assert.deepEqual([record.pending, record.planned, studies], [true, 3, []]);
});

test('the build B marks follow the re-measure gate: slower, lower pass rate, or never passed', () => {
  const mk = (a, b) => ({ tasks: ['t'], cells: [{ task: 't', arm: BUILD_A, ...a }, { task: 't', arm: BUILD_B, ...b }] });
  const cellOf = (expected, passes, runs = 3) => ({ expected, passes, runs });
  assert.equal(compareTasks(mk(cellOf(10, 3), cellOf(10, 3)))[0].marked, false);
  assert.equal(compareTasks(mk(cellOf(10, 3), cellOf(9, 3)))[0].marked, false);
  assert.deepEqual(compareTasks(mk(cellOf(10, 3), cellOf(11, 3)))[0].slower, true);
  assert.deepEqual(compareTasks(mk(cellOf(10, 3), cellOf(9, 2)))[0].lowerRate, true);
  const never = compareTasks(mk(cellOf(10, 3), cellOf(null, 0)))[0];
  assert.deepEqual([never.slower, never.lowerRate, never.delta], [true, true, null]);
  assert.equal(compareTasks(mk(cellOf(null, 0), cellOf(9, 3)))[0].marked, false);
});

test('collecting again keeps banks whose folder is gone and replaces a bank that is found', t => {
  const { wt } = fixtureWt(t);
  const first = collectValidation({ wt });
  const empty = mkdtempSync(join(tmpdir(), 'hub-empty-')); t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.deepEqual(collectValidation({ wt: empty, kept: first }), first);
  assert.deepEqual(collectValidation({ wt, kept: first }), first);
  const stale = structuredClone(first);
  stale.banks.find(b => b.id === 'validation-x').bBuild = 'stale';
  stale.studies.find(s => s.bank === 'validation-x').tasks = ['stale'];
  stale.banks.push({ id: 'old-bank', kind: 'validation', complete: true, groups: 1 });
  const merged = collectValidation({ wt, kept: stale });
  assert.deepEqual(merged.banks.map(b => b.id), ['old-bank', 'remeasure-x', 'validation-try1', 'validation-x']);
  assert.equal(merged.banks.find(b => b.id === 'validation-x').bBuild, 'b'.repeat(8));
  assert.deepEqual(merged.studies.find(s => s.bank === 'validation-x').tasks, ['t-one', 't-two']);
});

test('the validation page, the index and explore.html carry the banks, and no claim page mentions build A', t => {
  const { wt } = fixtureWt(t);
  const all = { ...committed(), validation: collectValidation({ wt }) };
  const files = render(all);
  const pageText = files['validation.md'];
  assert.match(pageText, /^\[Benchmarks\]\(README\.md\) · .*· Validation · /);
  assert.match(pageText, /## validation-x/);
  assert.match(pageText, /## remeasure-x/);
  assert.match(pageText, /Its gate did not pass/);
  assert.match(pageText, /\| `t-one` \| 12\.0 \(3\/3\) \| 11\.0 \(3\/3\) \| -8\.3% \| no \|/);
  assert.match(pageText, /\| `t-two` \| 35\.0 \(2\/3\) \| 24\.3 \(3\/3\) \| -30\.5% \| no \|/);
  assert.match(pageText, /Build A had 1 round on/);
  assert.match(pageText, /slower and lower pass rate/);
  assert.match(pageText, /Banks without a score \(1\)/);
  assert.match(pageText, /`release-opus` \| deferred/);
  assert.equal(pageText.includes(homedir()), false);
  assert.match(files['README.md'], /\[Validation: build A against build B\]\(validation\.md\)/);
  assert.match(files['index.html'], /validation\.md/);
  assert.ok(exploreData(all).studies.some(s => s.family === 'validation' && s.id === 'validation-x-native'));
  for (const name of ['native-claim.md', 'app-claim.md', 'browser-race.md', 'browser-turbo.md']) assert.equal(files[name].includes('build-A'), false, name);
});

test('the committed validation data names no home folder, builds are short hashes, and every cell is a score() of its runs', () => {
  const data = readJson(join(OUT, 'data/validation.json'));
  assert.ok(data.studies.length > 0 && data.banks.length > 0);
  assert.equal(JSON.stringify(data).includes(['', 'Users', ''].join('/')), false);
  for (const study of data.studies) {
    assert.deepEqual(study.arms, [BUILD_B, BUILD_A]);
    for (const build of Object.values(study.builds).flat()) assert.match(build, /^[a-f0-9]{8}$/);
    const table = score(study.runs.map(r => ({ arm: r.arm, task: r.task, seconds: r.seconds, passed: r.passed })));
    for (const c of study.cells) assert.equal(c.passes, table[c.arm][c.task].passes.length, `${study.id} ${c.task}`);
  }
});

test('race folders are the dated race-MMDD folders, and a round name found twice is read from the first folder', t => {
  const wt = mkdtempSync(join(tmpdir(), 'hub-race-')); t.after(() => rmSync(wt, { recursive: true, force: true }));
  for (const dir of ['race-1017', 'race-1022', 'race-131', 'race-old', 'race-fx', 'validation-1017']) mkdirSync(join(wt, dir));
  for (const [dir, round] of [['race-1017', 'chrome-a-r1'], ['race-1022', 'chrome-a-r1'], ['race-1022', 'safari-b-r1'], ['race-1022', 'notes']]) mkdirSync(join(wt, dir, round));
  writeFileSync(join(wt, 'race-1022/safari-b-r1/results.json'), '[]');
  assert.deepEqual(raceDirs(wt).map(d => d.slice(wt.length + 1)), ['race-1017', 'race-1022']);
  const rounds = listRaceRounds(raceDirs(wt));
  assert.deepEqual(rounds.map(r => [r.name, r.dir.slice(wt.length + 1), r.done]), [['chrome-a-r1', 'race-1017/chrome-a-r1', false], ['safari-b-r1', 'race-1022/safari-b-r1', true]]);
  assert.deepEqual(listRaceRounds(join(wt, 'race-1017')).map(r => r.name), ['chrome-a-r1']);
  assert.deepEqual(listRaceRounds(join(wt, 'missing')), []);
});

test('release schedule banks retain the frozen gate and every successful receipt, including failed task runs', t => {
  const wt = mkdtempSync(join(tmpdir(), 'hub-release150-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const dir = join(wt, 'validation-150f-rel3'); mkdirSync(dir);
  const put = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  const identity = { startedAt: '2026-10-28T06:00:00Z', builds: { A: 'a'.repeat(40), B: 'b'.repeat(40) } };
  const steps = [];
  for (const side of ['A', 'B']) for (const n of [1, 2, 3]) {
    const id = `native-${side}-r${n}`; steps.push({ id, side, kind: 'native-haiku', tasks: 'one,two' });
    put(`${id}.receipt.json`, { id, side, kind: 'native-haiku', rc: 0, result: `/old/bank/${id}.json`, command: ['--model', 'claude-haiku-5-5', '--effort', 'high'] });
    put(`${id}.json`, { model: 'claude-haiku-5-5', results: [
      { arm: 'sleight', task: 'one', seconds: n + 10, passed: true, models: ['claude-haiku-5-5'] },
      { arm: 'sleight', task: 'two', seconds: 30, passed: n === 1, reason: 'wrong result', models: ['claude-haiku-5-5'] },
    ] });
  }
  put('schedule.json', steps); put('queue-identity.json', identity);
  put('final-verdict.json', { at: '2026-10-28T14:04:00Z', identity, engines: [{ version: '26.1023.50603', build: '22391' }],
    pass: true, exitCode: 0, errors: [], aborted: { 'native-haiku': { A: 1, B: 2 } }, taskExclusions: [],
    verdicts: [{ kind: 'native-haiku', passA: 4, passB: 4, comparable: 2, aTotal: 42, bTotal: 42, slowdown: 0, limit: .2, regressed: false,
      tasks: [{ task: 'one' }, { task: 'two' }] }] });
  const bank = readBank(dir);
  assert.ok(bank, 'schedule banks are discovered without plan.json');
  const { record, studies: [s] } = collectBank(bank);
  assert.equal(record.passed, true); assert.equal(record.engine, '26.1023.50603 build 22391');
  assert.equal(record.release.verdicts[0].aTotal, 42);
  assert.deepEqual(record.release.aborted['native-haiku'], { A: 1, B: 2 });
  assert.equal(s.runs.length, 12); assert.equal(s.runs.filter(r => !r.passed).length, 4);
  assert.deepEqual(s.models[BUILD_A], ['claude-haiku-5-5']);
  assert.deepEqual(s.roundIds[BUILD_A], ['native-A-r1', 'native-A-r2', 'native-A-r3']);
  assert.equal(s.cells.find(c => c.arm === BUILD_B && c.task === 'two').passes, 1);
  const all = { ...committed(), validation: { family: 'validation', banks: [record], studies: [s] } };
  assert.match(readmeBlocks(all).benchmarks, /RELEASE PASS.*1 of 1 groups/);
  assert.match(render(all)['validation.md'], /Passing lower-median total/);
  // Dropping a failed attempt leaves pass counts and passing medians unchanged, but must not improve expected time.
  put('native-A-r3.json', { model: 'claude-haiku-5-5', results: [
    { arm: 'sleight', task: 'one', seconds: 13, passed: true, models: ['claude-haiku-5-5'] },
  ] });
  assert.throws(() => collectBank(readBank(dir)), /missing or duplicate scheduled task/);
});

test('rematch banks keep models, core tasks and held-out tasks apart and apply the offline regrade without scoring aborted rounds', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-rematch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const make = (base, name, arm, task, n, model = 'claude-haiku-5-5') => {
    const out = join(base, name); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'browser.json'), JSON.stringify({ browser: 'chrome', version: '155' }));
    writeFileSync(join(out, 'commits.json'), JSON.stringify({ build: { commit: '4'.repeat(40) }, fowlbrowser: { commit: 'e51c52a' + '0'.repeat(33) } }));
    writeFileSync(join(out, 'results.json'), JSON.stringify([{ task: { name: task, browser: 'chrome' }, surface: arm, wallMs: n * 1000,
      successfulBrowserCalls: 1, site: { lines: [] }, run: { started: Date.parse('2026-10-28T15:00:00Z'), result: { modelUsage: { [model]: {} }, result: 'RESULT: fixture' } },
      outcome: { ok: !['dm-first-message', 'job-motion'].includes(task), problems: task === 'dm-first-message' ? ['answer must be JSON'] : task === 'job-motion' ? ['JOB_ANSWER_MISMATCH'] : [] } }]));
  };
  const banks = [];
  for (const model of ['haiku', 'opus']) {
    const base = join(dir, `fw1-e51c52a-${model}`); mkdirSync(base); banks.push({ dir: base, model });
    for (const arm of ['sleight-turbo', 'fowlbrowser']) for (const n of [1, 2, 3]) {
      make(base, `chrome-${arm}-r${n}`, arm, 'mdn', n + 10, `claude-${model}-5-5`);
      if (model === 'haiku') make(base, `whole-${arm}-r${n}`, arm, 'dm-first-message', n + 20);
    }
    make(join(base, 'aborted'), 'chrome-sleight-turbo-r3', 'sleight-turbo', 'mdn', 999);
  }
  make(banks[0].dir, 'chrome-sleight-turbo-r4', 'sleight-turbo', 'mdn', 14);
  const regrade = ['sleight-turbo', 'fowlbrowser'].flatMap(arm => [1, 2, 3].map(n =>
    `whole-${arm}-r${n} | dm-first-message | ${arm} | 20 | {"ok":false} | -> | ${n === 3 ? 'FAIL: wrong answer' : 'ok'}`)).join('\n');
  const rows = [];
  for (const arm of ['sleight-turbo', 'fowlbrowser']) for (const n of [1, 2, 3]) {
    const round = `jobs/fixtures-motion-${n}-${arm}-job-motion`;
    make(banks[0].dir, `${round}/round`, arm, 'job-motion', n + 30);
    const after = arm === 'fowlbrowser' && n !== 2;
    rows.push({ round, arm, wallMs: (n + 30) * 1000, before: false, after, afterProblems: after ? [] : ['JOB_ANSWER_MISMATCH'] });
  }
  const jobMotionRegrade = [{ bank: banks[0].dir, colors: jobColors, rows }];
  const collect = (motion = jobMotionRegrade) => collectRematch({ banks, regrade, jobMotionRegrade: motion });
  const result = collect();
  const core = result.studies.filter(s => s.suite === 'core');
  assert.equal(core.length, 2); assert.equal(result.studies.filter(s => s.suite === 'held-out').length, 1);
  assert.ok(core.every(s => s.tasks.length === 1 && s.tasks[0] === 'mdn'));
  const haiku = core.find(s => s.model === 'haiku'), opus = core.find(s => s.model === 'opus');
  assert.equal(haiku.runs.filter(r => r.arm === 'sleight-turbo').length, 4);
  assert.equal(opus.runs.length, 6);
  assert.ok(result.studies.every(s => s.runs.every(r => r.seconds < 999)));
  const held = result.studies.find(s => s.suite === 'held-out');
  assert.equal(held.runs.filter(r => r.passed).length, 6);
  assert.ok(held.cells.filter(c => c.task === 'dm-first-message').every(c => c.passes === 2));
  assert.equal(held.cells.find(c => c.task === 'job-motion' && c.arm === 'fowlbrowser').passes, 2);
  assert.equal(held.cells.find(c => c.task === 'job-motion' && c.arm === 'sleight-turbo').passes, 0);
  assert.equal(held.cells.find(c => c.task === 'job-motion' && c.arm === 'fowlbrowser').expected, 48);
  assert.deepEqual(haiku.models['sleight-turbo'], ['claude-haiku-5-5']);
  assert.deepEqual(opus.models.fowlbrowser, ['claude-opus-5-5']);
  assert.equal(result.excludedRounds.length, 2, 'both aborted attempts remain disclosed');
  assert.throws(() => collectRematch({ banks, regrade: '', jobMotionRegrade }), /regrade/i);
  assert.throws(() => collect([]), /Missing job-motion regrade/);
  assert.throws(() => collect([...jobMotionRegrade, ...jobMotionRegrade]), /Duplicate job-motion regrade/);
  assert.throws(() => collect([{ ...jobMotionRegrade[0], colors: {} }]), /color table/);
  assert.throws(() => collect([{ ...jobMotionRegrade[0], rows: rows.map(r => ({ ...r, wallMs: 1 })) }]), /does not match saved row/);
  const file = join(banks[0].dir, `${rows.find(r => r.after).round}/round/results.json`);
  const saved = readJson(file); saved[0].outcome.problems.push('fixture reset failed');
  writeFileSync(file, JSON.stringify(saved));
  assert.equal(collect().studies.find(s => s.suite === 'held-out').cells.find(c => c.task === 'job-motion' && c.arm === 'fowlbrowser').passes, 1, 'non-answer failures survive the regrade');
});

test('published rematch keeps the corrected result and its eight held-out tasks outside each 13-task core', () => {
  const race = committed()['browser-turbo'].race;
  const newest = race.studies.filter(s => s.rematch);
  assert.equal(newest.filter(s => s.suite === 'core').length, 4);
  for (const s of newest.filter(s => s.suite === 'core')) {
    assert.equal(s.tasks.length, 13);
    assert.ok(s.models[s.me].every(model => model === `claude-${s.model}-5-5`));
    assert.ok(s.models.fowlbrowser.every(model => model === `claude-${s.model}-5-5`));
    assert.ok(!s.tasks.some(task => task.startsWith('job-') || task === 'dm-first-message'));
  }
  const held = newest.find(s => s.suite === 'held-out');
  assert.equal(held.tasks.length, 8);
  for (const arm of held.arms) {
    assert.deepEqual(held.regrade.arms[arm], { runs: 9, passes: 5 });
    assert.equal(held.cells.find(c => c.arm === arm && c.task === 'job-motion').passes, arm === 'fowlbrowser' ? 2 : 0);
  }
  assert.ok(race.excludedRounds.some(r => /opus\/aborted\//.test(r.round)));
  const release = committed().validation.banks.find(b => b.id === 'validation-150f-rel3');
  assert.equal(release.passed, true);
  assert.equal(release.groups, 8);
  assert.equal(release.bBuild, 'e679ed7e');
  assert.ok(committed().validation.banks.some(b => b.id === 'validation-150f-rel2' && b.engine.startsWith('26.1021.31345')));
});


test('release summaries disclose paid checkout failures and name the previous release', () => {
  const all = committed(), blocks = readmeBlocks(all), files = render(all);
  for (const text of [blocks.turbo, blocks.benchmarks, files['browser-turbo.md']]) {
    assert.match(text, /FowlBrowser paid on the unpriced checkout in 1 of 3 Chrome and 2 of 3 Helium Haiku runs/);
    assert.match(text, /expected time includes those failures/);
  }
  for (const text of [blocks.release, files['validation.md']]) {
    assert.match(text, /against 1\.4\.2 \(the 1\.5\.0 harness with the 1\.4\.2 plugin tree\)/);
    assert.doesNotMatch(text, /\bp\d{3,}\b|\bcf342b59\b/);
  }
  const internalLabels = /\b(?:[A-Z]{2,}-?\d+[A-Z]?|rel\d+|p\d{3,})\b/;
  assert.doesNotMatch(files['browser-turbo.md'], /The scorer's wording is "fastest"/);
  // Recorded round identifiers retain their source names inside code spans.
  for (const file of ['browser-turbo.md', 'validation.md']) assert.doesNotMatch(files[file].replace(/`[^`]*`/g, ''), internalLabels);
});

test('tracked whole-thread regrades reproduce all 18 corrected rematch answers', () => {
  const text = readFileSync(join(OUT, 'data/whole-thread-regrade.txt'), 'utf8');
  const [header, ...lines] = text.trim().split('\n');
  assert.match(header, /round \| task \| arm \| agent seconds \| recorded outcome \(JSON\) \| regrade \| corrected outcome/);
  assert.doesNotMatch(text, /\[object Object\]/);
  assert.equal(lines.length, 18);
  const held = committed()['browser-turbo'].race.studies.find(s => s.rematch && s.suite === 'held-out');
  const counts = Object.fromEntries(held.arms.map(arm => [arm, { runs: 0, passes: 0 }]));
  for (const line of lines) {
    const [round, task, arm, seconds, saved, arrow, verdict] = line.split(' | ');
    assert.ok(Number(seconds) > 0);
    assert.equal(typeof JSON.parse(saved).ok, 'boolean');
    assert.equal(arrow, '->');
    const run = held.runs.find(r => r.round === round && r.task === task && r.arm === arm);
    assert.ok(run, `${round}/${task}`);
    // The report prints agentSeconds. The hub keeps wallMs, so only the grade crosses this boundary.
    assert.equal(run.passed, verdict === 'ok');
    counts[arm].runs++;
    counts[arm].passes += verdict === 'ok' ? 1 : 0;
  }
  assert.deepEqual(counts, held.regrade.arms);
});

test('tracked job-motion regrade reproduces six rows and publishes one color table for every arm', () => {
  const banks = readJson(join(OUT, 'data/job-motion-regrade.json'));
  const held = committed()['browser-turbo'].race.studies.find(s => s.rematch && s.suite === 'held-out');
  const counts = Object.fromEntries(held.arms.map(arm => [arm, { runs: 0, passes: 0 }]));
  assert.equal(banks.length, 2);
  assert.equal(banks[1].rows.length, 0, 'Opus has no job-motion rounds');
  assert.equal(banks[0].rows.length, 6);
  for (const bank of banks) assert.deepEqual(bank.colors, jobColors);
  for (const row of banks[0].rows) {
    const run = held.runs.find(r => r.round === `${row.round}/round` && r.task === 'job-motion' && r.arm === row.arm);
    assert.ok(run, row.round);
    assert.equal(run.seconds, row.wallMs / 1000);
    assert.equal(run.passed, row.after);
    counts[row.arm].runs++;
    counts[row.arm].passes += Number(row.after);
  }
  assert.deepEqual(counts, held.jobMotionRegrade.arms);
  assert.deepEqual(counts, { 'sleight-turbo': { runs: 3, passes: 0 }, fowlbrowser: { runs: 3, passes: 2 } });
  const files = render(committed());
  for (const text of [files['browser-turbo.md'], readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), readFileSync(join(ROOT, 'docs/releases/1.5.0.md'), 'utf8')]) {
    assert.match(text, /fixed color-synonym table applied to every arm/);
    assert.doesNotMatch(text, /Both arms failed job-motion|strict grader requires amber/);
    for (const [name, color] of Object.entries(jobColors)) assert.ok(text.includes(`| ${name} | \`${color.hex}\` | ${color.names.join(', ')} |`));
  }
  assert.match(readmeBlocks(committed()).turbo, /FowlBrowser completed 7 of 8 tasks/);
});

test('release slowdown summary includes large deltas, run counts and tasks without a B pass', () => {
  const text = render(committed())['validation.md'];
  for (const fact of [
    '| Chrome Opus | `inject-order` | +113.61% | 1 | 1 |',
    '| Chrome Opus | `demoid` | +74.34% | 1 | 1 |',
    '| Native Haiku | `textedit-edit` | +53.27% | 3 | 3 |',
    '| Native Haiku | `textedit-insert-line` | +51.49% | 3 | 3 |',
    '| Firefox Haiku | `inject-order` | +40.00% | 3 | 3 |',
    '| Safari Haiku | `inject-order` | +36.96% | 3 | 3 |',
    '| Chrome Opus | `inject-mail` | 1/1 | 0/1 |',
    '| Firefox Haiku | `form-settings-helium` | 0/3 | 0/3 |',
  ]) assert.ok(text.includes(fact), fact);
});

test('release slowdown summary follows changed validation cells at the 24 percent boundary', () => {
  const all = committed();
  const study = all.validation.studies.find(s => s.bank === 'validation-150f-rel3' && s.group === 'chrome-opus');
  const a = study.cells.find(c => c.task === 'demoid' && c.arm === BUILD_A);
  const b = study.cells.find(c => c.task === 'demoid' && c.arm === BUILD_B);
  a.expected = 100; b.expected = 124; a.runs = 2; b.runs = 7;
  assert.ok(render(all)['validation.md'].includes('| Chrome Opus | `demoid` | +24.00% | 2 | 7 |'));
  b.expected = 123.4;
  const summary = releaseTaskSlowdowns(all.validation);
  assert.ok(!summary.includes('`demoid`'));
});

test('release documents and validation page share the generated slowdown summary', () => {
  const all = committed(), text = releaseTaskSlowdowns(all.validation);
  assert.ok(render(all)['validation.md'].includes(text));
  for (const name of ['CHANGELOG.md', 'docs/releases/1.5.0.md']) {
    const doc = readFileSync(join(ROOT, name), 'utf8');
    assert.equal(spliceReadme(doc, { 'release-slowdowns': text }), doc, `${name} slowdown summary is stale`);
    assert.ok(doc.includes(text));
  }
});

test('incomplete studies keep completed task counts beside their lowest expected time', () => {
  const all = committed(), files = render(all);
  const held = all['browser-turbo'].race.studies.find(s => s.rematch && s.suite === 'held-out');
  const completed = held.cells.filter(c => c.arm === held.me && c.passes > 0).length;
  assert.ok(completed < held.tasks.length);
  assert.match(files['browser-turbo.md'], new RegExp(`completed ${completed} of ${held.tasks.length} tasks\\. sleight turbo has the lowest expected time on 3 of 8 tasks`));
  for (const text of [readmeBlocks(all).turbo, files['README.md'], files['index.html']])
    assert.match(text, new RegExp(`completed ${completed} of ${held.tasks.length} tasks`));
});
