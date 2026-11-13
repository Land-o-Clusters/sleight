import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { buildReport, loadSources, loadSuite, parseFowlReport, renderMarkdown, scrubHome, variantFromDir } from '../bench/world/report.mjs';

const haiku = 'claude-haiku-5-5';
const run = (extra) => ({ model: haiku, arm: 'sleight', task: 'calculator-click', run: 1, passed: true, seconds: 10, turns: 4, tokens: 1000, costUsd: 0.1, ...extra });

test('published claim coverage names the two removed bridge arms as not run with their reason', () => {
  const report = buildReport([run({})]);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /codex-cu.*not run.*Bridge code is not in the repository/);
  assert.match(markdown, /devtools.*not run.*Bridge code is not in the repository/);
  assert.ok(!report.models[0].arms.some(arm => ['codex-cu', 'devtools'].includes(arm.arm)));
});

test('pass rate counts every run; median and p90 wall time use passing runs only', () => {
  const report = buildReport([
    run({ run: 1, seconds: 10, turns: 3, tokens: 100, costUsd: 0.1 }),
    run({ run: 2, seconds: 30, passed: false, turns: 8, tokens: 900, costUsd: 0.4 }),
    run({ run: 3, seconds: 20, turns: 5, tokens: 200, costUsd: 0.2 }),
    run({ arm: 'codex', run: 1, seconds: 12, turns: 4, tokens: 80, costUsd: 0.05 }),
  ]);
  const cell = report.models[0].cells['calculator-click']['sleight'];
  assert.equal(cell.passed, 2);
  assert.equal(cell.runs, 3);
  assert.equal(cell.medianSeconds, 15);
  assert.equal(cell.p90Seconds, 20);
  assert.equal(cell.medianTurns, 4);
  assert.equal(cell.medianCalls, null);
  assert.equal(cell.tokens, 1200);
  assert.equal(cell.costUsd, 0.7);
  assert.equal(report.models[0].cells['calculator-click']['codex'].passed, 1);
});

test('a fowl report.md row becomes a browser run with the surface as the arm', () => {
  const md = `| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wikipedia | fowlbrowser | helium | ok | ok | 0/0 | ok | ok | ok | ok | 15 s, 15 s net / 90 | 3 calls | in 10, write 1, read 2, out 3, total 16 | 0.192 |
| mdn | fowlbrowser | helium | FAIL: no RESULT | ok | 0/0 | ok | ok | ok | ok | 11 s, 11 s net / 90 | 3 calls | in 10, write 1, read 2, out 3, total 16 | 0.191 |
`;
  const rows = parseFowlReport(md, { model: haiku, run: 1 });
  assert.equal(rows[0].task, 'wikipedia');
  assert.equal(rows[0].arm, 'fowlbrowser');
  assert.equal(rows[0].half, 'browser');
  assert.equal(rows[0].passed, true);
  assert.equal(rows[0].seconds, 15);
  assert.equal(rows[0].calls, 3);
  assert.equal(rows[0].turns, undefined);
  assert.equal(rows[0].tokens, 16);
  assert.equal(rows[0].costUsd, 0.192);
  assert.equal(rows[1].passed, false);
});

test('one table per model, with native and browser totals apart', () => {
  const report = buildReport([
    run({ model: haiku, task: 'calculator-click', seconds: 10 }),
    run({ model: haiku, arm: 'sleight', task: 'wikipedia', seconds: 9, turns: 2 }),
    run({ model: haiku, arm: 'playwright-mcp', task: 'wikipedia', seconds: 8, tokens: 50, costUsd: 0.02, turns: 2 }),
    run({ model: 'claude-opus-4-6', task: 'calculator-click', seconds: 9 }),
  ]);
  assert.deepEqual(report.models.map(m => m.model), [haiku, 'claude-opus-4-6']);
  const haikuArm = report.models[0].arms.find(a => a.arm === 'sleight');
  assert.equal(haikuArm.native.runs, 0);
  assert.equal(haikuArm.browser.runs, 1);
  const pw = report.models[0].arms.find(a => a.arm === 'playwright-mcp');
  assert.equal(pw.browser.runs, 1);
  assert.equal(pw.native.runs, 0);
});

test('a browser-only arm is not supported on a native task, written as not supported rather than 0 s', () => {
  const report = buildReport([
    run({ task: 'calculator-click', arm: 'sleight' }),
    run({ task: 'wikipedia', arm: 'sleight', seconds: 8, turns: 2 }),
    run({ task: 'wikipedia', arm: 'playwright-mcp', seconds: 7, turns: 2 }),
  ]);
  const native = report.models[0].cells['calculator-click']['playwright-mcp'];
  assert.equal(native.supported, false);
  const md = renderMarkdown(report);
  assert.match(md, /not supported/);
  assert.doesNotMatch(md, /playwright-mcp \| calculator-click \| 0\//);
});

test('skipped runs stay out of N; dry-run rows are ignored', () => {
  const report = buildReport([
    run({ run: 1 }),
    run({ run: 2, skipped: true, passed: false, seconds: 99 }),
    run({ run: 3, dryRun: true, seconds: 1 }),
  ]);
  const cell = report.models[0].cells['calculator-click']['sleight'];
  assert.equal(cell.runs, 1);
  assert.equal(cell.medianSeconds, 10);
});

test('home paths in the markdown table are written as ~', () => {
  const home = homedir();
  const report = buildReport([run({ passed: false, reason: `no file at ${home}/notes/out.txt` })]);
  const md = renderMarkdown(report);
  assert.equal(scrubHome(`${home}/notes/out.txt`), '~/notes/out.txt');
  assert.doesNotMatch(md, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(md, /~/);
});

test('loadSources reads a run.mjs results file and a FowlBrowser round directory', () => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-report-')));
  try {
    writeFileSync(join(dir, 'native.json'), JSON.stringify({
      model: haiku, arms: ['sleight', 'peekaboo'],
      results: [
        run({ arm: 'sleight', task: 'textedit-save', seconds: 12, tokens: 40, costUsd: 0.03 }),
        run({ arm: 'peekaboo', task: 'textedit-save', seconds: 14, tokens: 30, costUsd: 0.02 }),
      ],
    }));
    const round = join(dir, 'round');
    mkdirSync(round);
    writeFileSync(join(round, 'report.md'), `| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wikipedia | sleight | chrome | ok | ok | 0/0 | ok | ok | ok | ok | 18 s, 18 s net / 90 | 4 calls | in 1, write 2, read 3, out 4, total 10 | 0.050 |
`);
    writeFileSync(join(round, 'model'), haiku);
    const rows = loadSources([join(dir, 'native.json'), round]);
    const report = buildReport(rows);
    assert.equal(report.models[0].cells['textedit-save']['peekaboo'].runs, 1);
    assert.equal(report.models[0].cells['wikipedia']['sleight'].medianSeconds, 18);
    assert.equal(report.models[0].cells['wikipedia']['peekaboo'].supported, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseFowlReport reads cost and time from the right when outcome contains |', () => {
  const md = `| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mobile | sleight | chrome | FAIL: /foo|bar/ did not match | ok | 0/0 | ok | ok | ok | ok | 12 s, 12 s net / 90 | 2 calls | in 1, write 0, read 0, out 1, total 9 | 1.008 |
`;
  const rows = parseFowlReport(md, { model: haiku, run: 1 });
  assert.equal(rows[0].task, 'mobile');
  assert.equal(rows[0].arm, 'sleight');
  assert.equal(rows[0].passed, false);
  assert.equal(rows[0].seconds, 12);
  assert.equal(rows[0].costUsd, 1.008);
  assert.equal(rows[0].tokens, 9);
});

test('the CLI keeps every path when --out is omitted', () => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-cli-no-out-')));
  try {
    const files = [];
    for (const [i, task] of ['one-task', 'two-task'].entries()) {
      const file = join(dir, `${i}.json`);
      writeFileSync(file, JSON.stringify({ model: haiku, results: [run({ task, arm: 'sleight', seconds: 5 + i })] }));
      files.push(file);
    }
    const cli = spawnSync(process.execPath, ['bench/world/report.mjs', ...files], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /one-task/);
    assert.match(cli.stdout, /two-task/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing cost is a dash, p90 under 10 passing runs is n=k, and variants stay unpooled', () => {
  const report = buildReport([
    run({ task: 'calculator-click', arm: 'sleight', seconds: 10, costUsd: undefined, variant: 'docs-off' }),
    run({ task: 'calculator-click', arm: 'sleight', seconds: 12, costUsd: undefined, variant: 'docs-on' }),
  ]);
  const md = renderMarkdown(report);
  assert.match(md, /n=1/);
  assert.match(md, /docs-off/);
  assert.match(md, /docs-on/);
  assert.doesNotMatch(md, /\$0\.000/);
  assert.match(md, /–/);
});

test('the CLI writes one markdown table per model', () => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-cli-')));
  try {
    const file = join(dir, 'results.json');
    writeFileSync(file, JSON.stringify({ model: haiku, results: [run(), run({ arm: 'codex', seconds: 9 })] }));
    const out = join(dir, 'table.md');
    const cli = spawnSync(process.execPath, ['bench/world/report.mjs', file, '--out', out], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    const md = readFileSync(out, 'utf8');
    assert.match(md, /claude-haiku-5-5/);
    assert.match(md, /calculator-click/);
    assert.match(md, /sleight/);
    assert.match(md, /codex/);
    assert.match(md, /Native/);
    assert.match(md, /Browser/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('arm totals name shared tasks and never call an empty half not supported', () => {
  const report = buildReport([
    run({ task: 'wikipedia', arm: 'sleight', seconds: 8, turns: 2 }),
    run({ task: 'wikipedia', arm: 'playwright-mcp', seconds: 7, turns: 2 }),
    run({ task: 'calculator-click', arm: 'sleight' }),
  ]);
  const md = renderMarkdown(report);
  assert.match(md, /Totals cover: wikipedia/);
  assert.doesNotMatch(md, /sleight N=1 \| Native \| not supported/);
  const empty = buildReport([
    run({ task: 'calculator-click', arm: 'sleight' }),
    run({ task: 'wikipedia', arm: 'playwright-mcp', seconds: 7 }),
  ]);
  assert.match(renderMarkdown(empty), /Totals cover: no shared tasks/);
});

test('tool calls and model turns are separate columns', () => {
  const report = buildReport([
    run({ task: 'calculator-click', calls: 9, turns: 4 }),
  ]);
  const cell = report.models[0].cells['calculator-click']['sleight'];
  assert.equal(cell.medianCalls, 9);
  assert.equal(cell.medianTurns, 4);
  const md = renderMarkdown(report);
  assert.match(md, /Calls/);
  assert.match(md, /Turns/);
  assert.match(md, / 9 /);
  assert.match(md, / 4 /);
});

test('dir-name variants stay separate unless --pool, and a missing report.md warns', () => {
  assert.equal(variantFromDir('d5-hk-min-normal'), 'min');
  assert.equal(variantFromDir('d5-hk-min-swap'), 'min, swap');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-variant-')));
  try {
    const round = join(dir, 'd5-hk-min-normal');
    mkdirSync(round);
    writeFileSync(join(round, 'report.md'), `| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wikipedia | sleight | chrome | ok | ok | 0/0 | ok | ok | ok | ok | 10 s, 10 s net / 90 | 2 calls | in 1, write 0, read 0, out 1, total 4 | 0.010 |
`);
    writeFileSync(join(round, 'model'), haiku);
    const split = buildReport(loadSources([round]));
    assert.ok(split.models[0].cells.wikipedia['sleight (min)']);
    const pooled = buildReport(loadSources([round], { pool: true }));
    assert.ok(pooled.models[0].cells.wikipedia.sleight);
    const warnings = [];
    mkdirSync(join(dir, 'empty-round'));
    loadSources([join(dir, 'empty-round')], { warn: msg => warnings.push(msg) });
    assert.match(warnings.join('\n'), /no report\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clean rate counts over-budget passes, and timeouts are runner stops only', () => {
  const report = buildReport([
    run({ run: 1, seconds: 400, overBudget: true }),
    run({ run: 2, passed: false, reason: 'timeout', timedOut: true, seconds: 20 }),
    run({ run: 3, passed: false, reason: 'over budget', seconds: 500 }),
  ]);
  const cell = report.models[0].cells['calculator-click']['sleight'];
  assert.equal(cell.passed, 1);
  assert.equal(cell.clean, 0);
  assert.match(renderMarkdown(report), /clean 0\/3/);
  assert.equal(report.models[0].timeouts, 1);
});

test('a .log path is refused, missing tokens are a dash, and suite.json is the real file', () => {
  assert.throws(() => loadSources(['/tmp/round.log']), /log file/);
  const report = buildReport([run({ tokens: undefined, usage: undefined })]);
  assert.equal(report.models[0].cells['calculator-click']['sleight'].tokens, null);
  assert.match(renderMarkdown(report), /–/);
  const { byTask } = loadSuite();
  assert.ok(byTask.get('form-travel')?.timeoutMs);
  assert.equal(byTask.get('form-travel').half, 'browser');
  assert.equal(byTask.get('calculator-click').support['playwright-mcp'], false);
  assert.ok(byTask.size > 10);
});

test('a Fowl pass over the time-column budget is not clean', () => {
  const md = `| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| form-travel | sleight | chrome | ok, score 11/11 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 0 | 395 s, 395 s net / 330 | 52 calls | in 1, write 0, read 0, out 1, total 4 | 0.576 |
`;
  const rows = parseFowlReport(md, { model: haiku, run: 1 });
  assert.equal(rows[0].passed, true);
  assert.equal(rows[0].seconds, 395);
  assert.equal(rows[0].clean, false);
  const report = buildReport(rows);
  assert.equal(report.models[0].cells['form-travel']['sleight'].passed, 1);
  assert.equal(report.models[0].cells['form-travel']['sleight'].clean, 0);
  assert.match(renderMarkdown(report), /clean 0\/1/);
});

test('a group with a missing cost or tokens prints a partial sum, never a plain total', () => {
  const report = buildReport([
    run({ run: 1, tokens: 100, costUsd: 0.5 }),
    run({ run: 2, tokens: undefined, costUsd: undefined, usage: undefined }),
  ]);
  const cell = report.models[0].cells['calculator-click']['sleight'];
  assert.equal(cell.costUsd, 0.5);
  assert.equal(cell.tokens, 100);
  const md = renderMarkdown(report);
  assert.match(md, /≥ \$0\.50, 1 of 2 runs/);
  assert.match(md, /≥ 100, 1 of 2 runs/);
  assert.doesNotMatch(md, /\| \$0\.500 \|/);
});

test('Codex toolCalls fill the calls column', () => {
  const report = buildReport([
    run({ arm: 'codex', calls: undefined, toolCalls: 9, turns: 4 }),
  ]);
  const cell = report.models[0].cells['calculator-click']['codex'];
  assert.equal(cell.medianCalls, 9);
  assert.equal(cell.medianTurns, 4);
});

test('missing report.md and unequal N warnings appear in the markdown', () => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-warn-')));
  try {
    mkdirSync(join(dir, 'empty-round'));
    const rows = loadSources([join(dir, 'empty-round')], { warn: () => {} });
    assert.match(renderMarkdown(buildReport(rows)), /no report\.md/);
    const unequal = buildReport([
      run({ task: 'calculator-click', arm: 'sleight', run: 1 }),
      run({ task: 'calculator-click', arm: 'sleight', run: 2 }),
      run({ task: 'calculator-click', arm: 'codex', run: 1 }),
    ], { warn: () => {} });
    assert.match(renderMarkdown(unequal), /unequal run counts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing native Codex local fixture row remains supported with zero runs', () => {
  const report = buildReport([
    run({ task: 'local-mdn', arm: 'sleight' }),
    run({ task: 'local-wikipedia', arm: 'codex' }),
  ]);
  const cell = report.models[0].cells['local-mdn'].codex;
  assert.equal(cell.runs, 0);
  assert.equal(cell.supported, true);
});
