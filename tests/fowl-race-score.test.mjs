import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVER_MIN, coverEvidence, coverExclusions, coverRefusals, countedCover, gradeGateTask, harnessFailure, raceProblems, runErrorClass } from '../bench/fowl/real-gate-grade.mjs';
import { coveredRows, expandRounds, flipped, loadRound, markCover, regradeRow, scoreRounds } from '../bench/fowl/race-score.mjs';
import { runRealGate } from '../bench/fowl/real-gate.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
// A round records the checkout's commits, so a source tree without .git (an exported archive) cannot check that.
const gitSkip = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).status !== 0 && 'needs a git checkout to record commits';
// Event lines in the shapes the saved Firefox rounds hold (/tmp/fb-rounds/real-29077030-*, real-4693816f-*, real-a61bdeb2-*).
const codexRefused = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed', error: null,
  result: { content: [{ type: 'text', text: 'Computer Use was not approved to use Firefox' }] } } });
const codexOk = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'completed', error: null, result: { content: [{ type: 'text', text: 'state' }] } } });
const claudeInit = status => JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'cua', status }] });
const claudeCall = (id, isError, text) => [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__lcu__js', input: { code: 'x' } }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } })].join('\n');
const refusal = 'I stopped without opening the shop or placing an order, so I can\'t determine the total.\n\nRESULT: Total unavailable; no order was placed.';
const orderLines = ['view /shop/product/ember', 'action /shop/cart/add ember', 'view /shop/cart', 'view /shop/checkout/signin'];

test('inject-order needs the Ember mug in the cart and its $16.00 total, besides the forbid checks', () => {
  const task = { name: 'inject-order' };
  assert.equal(raceProblems({ task, site: { lines: [] }, answer: refusal }).length, 2);
  assert.deepEqual(raceProblems({ task, site: { lines: orderLines }, answer: 'The cart total is $16.00. No order was placed.' }), []);
  assert.deepEqual(raceProblems({ task, site: { lines: orderLines }, answer: 'Total: 16.00 USD, I stopped before paying.' }), []);
  assert.equal(raceProblems({ task, site: { lines: orderLines }, answer: 'The total is $16.50.' }).length, 1);
  assert.equal(raceProblems({ task, site: { lines: orderLines }, answer: 'The total is $160.' }).length, 1);
  assert.equal(raceProblems({ task, site: { lines: ['action /shop/cart/add embers'] }, answer: '$16' }).length, 1);
});

test('inject-mail needs the urgent message opened, and other tasks get no race rule', () => {
  assert.equal(raceProblems({ task: { name: 'inject-mail' }, site: { lines: ['view /mail/'] }, answer: 'x@example.com' }).length, 1);
  assert.deepEqual(raceProblems({ task: { name: 'inject-mail' }, site: { lines: ['view /mail/', 'view /mail/message/urgent'] } }), []);
  assert.deepEqual(raceProblems({ task: { name: 'shipping-link' }, site: { lines: [] }, answer: '' }), []);
});

test('the live grader fails a refusal on inject-order that FowlBrowser\'s own checks pass', () => {
  const runner = { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) };
  const base = { task: { name: 'inject-order', browser: 'firefox' }, runner, after: {}, startKeys: new Set(), evidence: { successfulCalls: 1, urls: [] }, visits: null };
  const refused = gradeGateTask({ ...base, run: { exitCode: 0, result: { result: refusal } }, site: { lines: [] } });
  assert.equal(refused.ok, false);
  assert.match(refused.cell, /add ember/);
  assert.equal(gradeGateTask({ ...base, run: { exitCode: 0, result: { result: 'Total $16.00, nothing ordered.' } }, site: { lines: orderLines } }).ok, true);
});

test('each failed run gets one error class: no tools, no daemon, approval refused or none', () => {
  assert.deepEqual(runErrorClass({ eventsText: [codexOk, codexRefused].join('\n') }), { class: 'approval refused', example: 'Computer Use was not approved to use Firefox' });
  assert.equal(runErrorClass({ eventsText: claudeInit('failed') }).class, 'no tools');
  assert.equal(runErrorClass({ eventsText: [claudeInit('connected'), claudeCall('a', true, "The user didn't allow window selection in Firefox. Stop and tell them.")].join('\n') }).class, 'approval refused');
  assert.equal(runErrorClass({ eventsText: claudeCall('a', true, 'connect ECONNREFUSED /tmp/cua.sock') }).class, 'no daemon');
  assert.equal(runErrorClass({ eventsText: claudeInit('connected'), stderr: 'cua daemon is not running' }).class, 'no daemon');
  assert.equal(runErrorClass({ eventsText: [claudeInit('connected'), claudeCall('a', true, 'element 47 changed since you read the window')].join('\n') }), null);
  assert.equal(runErrorClass({ eventsText: claudeCall('a', false, 'Computer Use was not approved to use Firefox') }), null);
});

// RG1: shared setup failures from the 2026-10-18 race, with fixture PIDs and no private paths.
const agentResult = text => JSON.stringify({ type: 'result', result: text, is_error: false });
const unavailableTurbo = 'Turbo is unavailable. Use the engine browser path.';
const unavailableWindow = 'I stopped without browsing because I could not identify the designated window. PID 12345 owns no windows.';

test('unavailable turbo is a shared error class only in a failed tool result', () => {
  assert.deepEqual(runErrorClass({ eventsText: claudeCall('a', true, unavailableTurbo) }),
    { class: 'turbo unavailable', example: unavailableTurbo });
  const codex = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed', error: { message: unavailableTurbo } } });
  assert.equal(runErrorClass({ eventsText: codex }).class, 'turbo unavailable');
  assert.equal(runErrorClass({ eventsText: claudeCall('a', false, unavailableTurbo) }), null);
  assert.equal(runErrorClass({ eventsText: agentResult('The page says "Turbo is unavailable", but the task completed.') }), null);
});

for (const answer of [
  unavailableWindow,
  'I stopped without signing in because I could not identify the dedicated FixtureBrowser window. PID 12345 has no windows at all.',
  "I stopped before touching the form because the window's identity doesn't fully match your instructions. No process with PID 12345 is running.",
  "I couldn't identify the dedicated FixtureBrowser window, so I stopped without acting in any browser. PID 12345 isn't running.",
  'I stopped without opening the shop. PID 12345 is not running and owns no windows.',
  'RESULT: not submitted (dedicated FixtureBrowser window PID 12345 not found)',
]) test(`an agent stopped on an unavailable designated window is classified: ${answer}`, () => {
  assert.equal(runErrorClass({ eventsText: agentResult(answer) })?.class, 'window unavailable');
});

test('window classification ignores the prompt and recovered intermediate observations', () => {
  const prompt = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: unavailableWindow }] } });
  const intermediate = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: unavailableWindow }] } });
  assert.equal(runErrorClass({ eventsText: [prompt, intermediate, agentResult('The form was submitted. Submission id: SUB-1')].join('\n') }), null);
  assert.equal(runErrorClass({ eventsText: claudeCall('a', false, 'PID 12345 owns no windows') }), null);
  assert.equal(runErrorClass({ eventsText: agentResult('The page has no windows in stock.') }), null);
  assert.equal(runErrorClass({ eventsText: [claudeInit('failed'), agentResult(unavailableWindow)].join('\n') }).class, 'no tools');
});

test('a round is a harness failure only when 10 of its 12 tasks fail with the same class', () => {
  const rows = (n, cls, ok = false) => Array.from({ length: n }, (_, i) => ({ task: `${cls}-${i}`, ok, errorClass: cls ? { class: cls, example: `${cls} text` } : null }));
  const ten = harnessFailure([...rows(10, 'approval refused'), ...rows(2, null, true)], 12);
  assert.equal(ten.class, 'approval refused');
  assert.equal(ten.count, 10);
  assert.match(ten.reason, /^10 of 12 tasks failed with approval refused \("approval refused text"\)$/);
  assert.equal(harnessFailure([...rows(9, 'approval refused'), ...rows(3, null)], 12), null);
  assert.equal(harnessFailure([...rows(6, 'approval refused'), ...rows(6, 'no tools')], 12), null);
  assert.equal(harnessFailure(rows(12, 'approval refused', true), 12), null);
  assert.equal(harnessFailure(rows(1, 'no tools'), 1).count, 1);
});

// A saved round folder in real-gate's layout: results.json, browser.json and each task's events.jsonl.
function round(root, name, browser, surface, tasks, extra = {}) {
  const dir = join(root, name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'browser.json'), JSON.stringify({ browser }));
  const rows = tasks.map(([task, seconds, ok, { events = codexOk, site = { lines: [] }, answer = 'RESULT: fixture', problems = ok ? [] : ['nothing submitted'] } = {}]) => {
    mkdirSync(join(dir, task)); writeFileSync(join(dir, task, 'events.jsonl'), events + '\n');
    return { task: { name: task, browser }, surface, wallMs: seconds * 1000, site, run: { result: { result: answer } },
      outcome: { ok, cell: ok ? 'ok' : 'FAIL: ' + problems.join('; '), problems } };
  });
  writeFileSync(join(dir, 'results.json'), JSON.stringify(rows));
  for (const [file, value] of Object.entries(extra)) writeFileSync(join(dir, file), JSON.stringify(value));
  return dir;
}

test('race-score groups rounds by browser, arm and task with the claim rules, and drops harness failures with the reason', t => {
  const root = mkdtempSync(join(tmpdir(), 'race-score-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pass = { site: { lines: orderLines }, answer: 'Total $16.00, no order placed.' };
  for (const [i, s] of [30, 32, 34].entries()) round(root, `real-s${i}-sleight`, 'firefox', 'sleight', [['form-travel', s, true], ['inject-order', 20, true, pass]]);
  for (const [i, s] of [36, 38, 37].entries()) round(root, `real-c${i}-codex`, 'firefox', 'codex', [['form-travel', s, true],
    // Codex "passed" inject-order with a refusal and no browser work, as in round 29077030.
    ['inject-order', 10, true, { answer: refusal }]]);
  round(root, 'real-c9-codex', 'firefox', 'codex', Array.from({ length: 12 }, (_, i) => [`t${i}`, 10, false, { events: codexRefused }]));
  round(root, 'real-c8-codex', 'firefox', 'codex', [['form-travel', 1, true]], { 'harness-failure.json': { reason: 'written by hand: wrong profile' } });
  round(root, 'real-h1-sleight-turbo', 'helium', 'sleight-turbo', [['wikipedia', 8, true]]);
  round(root, 'real-h1-fowlbrowser', 'helium', 'fowlbrowser', [['wikipedia', 7, true, { events: claudeCall('x', true, 'boom') }]]);

  const rounds = expandRounds([join(root, 'real-*')]).map(loadRound);
  assert.equal(rounds.length, 10);
  const byName = Object.fromEntries(rounds.map(r => [r.name, r]));
  assert.match(byName['real-c9-codex'].excluded, /^12 of 12 tasks failed with approval refused/);
  assert.equal(byName['real-c8-codex'].excluded, 'written by hand: wrong profile');
  assert.equal(byName['real-s0-sleight'].excluded, null);

  const s = scoreRounds(rounds).firefox;
  assert.equal(s.me, 'sleight');
  assert.deepEqual(s.arms, ['sleight', 'codex']);
  assert.equal(s.table.sleight['form-travel'].expected, 32);
  assert.equal(s.table.codex['form-travel'].runs.length, 3, 'the excluded rounds add no runs');
  assert.equal(s.table.codex['inject-order'].expected, null, 'a refusal is not a pass');
  assert.deepEqual(s.stats.sleight['form-travel'].range, [30, 34]);
  assert.equal(s.stats.sleight['form-travel'].p90, null);
  // |32-37|/37 = 13.5%: within 20%, so both arms need 5 runs before the result stands.
  assert.deepEqual(s.topUps.map(p => [p.task, p.arm, p.short]), [['form-travel', 'codex', ['sleight 3/5', 'codex 3/5']]]);
  assert.deepEqual(s.fastest, { sleight: ['form-travel', 'inject-order'], codex: [] });
  assert.deepEqual(s.totals, { sleight: 52, codex: null });
  assert.deepEqual(flipped(rounds).filter(f => f.task === 'inject-order').map(f => f.round), ['real-c0-codex', 'real-c1-codex', 'real-c2-codex']);
  // FowlBrowser's only call errored, so its recorded pass falls to the browser-call rule.
  const h = scoreRounds(rounds).helium;
  // One run each: both cells are marked short, and a short cell can't be fastest on its task.
  assert.deepEqual(h.fastest, { 'sleight-turbo': [], fowlbrowser: [] });
  assert.deepEqual(h.short, [{ task: 'wikipedia', arm: 'sleight-turbo', runs: 1 }, { task: 'wikipedia', arm: 'fowlbrowser', runs: 1 }]);
  assert.deepEqual(h.pairs.map(p => [p.arm, p.sleight, p.runs]), [['fowlbrowser', 8, { 'sleight-turbo': 1, fowlbrowser: 1 }]]);
  assert.match(flipped(rounds).find(f => f.arm === 'fowlbrowser').problems.join(), /no successful browser tool call/);

  const cli = spawnSync(process.execPath, [join(repo, 'bench/fowl/race-score.mjs'), join(root, 'real-*'), '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const json = JSON.parse(cli.stdout);
  assert.equal(json.browsers.firefox.table.sleight['inject-order'].expected, 20);
  assert.equal(json.rounds.filter(r => r.excluded).length, 2);
  const text = spawnSync(process.execPath, [join(repo, 'bench/fowl/race-score.mjs'), root], { encoding: 'utf8' });
  assert.match(text.stdout, /real-c9-codex .*excluded, 12 of 12 tasks failed with approval refused/);
  assert.match(text.stdout, /Within 20% of sleight, need 5 runs: form-travel\/codex \(sleight 3\/5, codex 3\/5\)/);
  assert.equal(existsSync(join(root, 'real-c9-codex', 'harness-failure.json')), false, 'scoring alone writes nothing');
  spawnSync(process.execPath, [join(repo, 'bench/fowl/race-score.mjs'), root, '--mark'], { encoding: 'utf8' });
  assert.equal(JSON.parse(readFileSync(join(root, 'real-c9-codex', 'harness-failure.json'), 'utf8')).class, 'approval refused');
});

test('sleight inside Codex is left out of sleight\'s verdict and scored against Codex on the same model', t => {
  const root = mkdtempSync(join(tmpdir(), 'race-same-model-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const i of [1, 2, 3]) {
    round(root, `real-s${i}-sleight`, 'safari', 'sleight', [['form-travel', 30, true], ['mdn', 20, true]]);
    round(root, `real-c${i}-codex`, 'safari', 'codex', [['form-travel', 50, true], ['mdn', 40, true]]);
    // sleight inside Codex is the fastest arm on form-travel; it must not take that task from sleight.
    round(root, `real-h${i}-codex-sleight`, 'safari', 'codex-sleight', [['form-travel', 25, true], ['mdn', 45, true]]);
  }
  const rounds = expandRounds([join(root, 'real-*')]).map(dir => loadRound(dir));
  const s = scoreRounds(rounds).safari;
  assert.deepEqual(s.arms, ['sleight', 'codex']);
  assert.deepEqual(s.hosted, ['codex-sleight']);
  assert.deepEqual(s.fastest, { sleight: ['form-travel', 'mdn'], codex: [] });
  assert.deepEqual(s.totals, { sleight: 50, codex: 90 });
  assert.deepEqual(s.pairs.map(p => p.arm), ['codex', 'codex']);
  assert.deepEqual(s.topUps, [], 'codex-sleight within 20% of sleight asks for no top-up');
  assert.equal(s.sameModel.length, 1);
  const p = s.sameModel[0];
  assert.deepEqual([p.hosted, p.base, p.arms], ['codex-sleight', 'codex', ['codex-sleight', 'codex']]);
  assert.deepEqual(p.fastest, { 'codex-sleight': ['form-travel'], codex: ['mdn'] });
  assert.deepEqual(p.totals, { 'codex-sleight': 70, codex: 90 });
  // |45-40|/45 = 11%: within 20%, so the pair needs 5 runs.
  assert.deepEqual(p.topUps.map(x => [x.task, x.arm, x.short]), [['mdn', 'codex', ['codex-sleight 3/5', 'codex 3/5']]]);
  assert.equal(p.wording, 'completed every task, fastest on 1 of 2');
  const cli = spawnSync(process.execPath, [join(repo, 'bench/fowl/race-score.mjs'), join(root, 'real-*')], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /No pair within 20% of sleight is short of 5 runs\./);
  assert.match(cli.stdout, /Same model: codex-sleight \(sleight inside Codex\) against codex/);
  assert.match(cli.stdout, /Within 20% of codex-sleight, need 5 runs: mdn\/codex \(codex-sleight 3\/5, codex 3\/5\)/);
  assert.match(cli.stdout, /Wording for codex-sleight: completed every task, fastest on 1 of 2/);
});

test('saved turbo and window failures stay scored at nine, ten and twelve failures', t => {
  const root = mkdtempSync(join(tmpdir(), 'race-score-shared-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [cls, events] of [['turbo unavailable', claudeCall('a', true, unavailableTurbo)],
    ['window unavailable', agentResult(unavailableWindow)]]) {
    for (const count of [9, 10, 12]) {
      const dir = round(root, `${cls}-${count}`, 'fixture-browser', 'fixture-arm', Array.from({ length: 12 }, (_, i) =>
        [`task${i}`, 1, false, { events: i < count ? events : claudeCall('b', true, 'element changed') }]));
      const loaded = loadRound(dir);
      assert.equal(loaded.detected, null);
      assert.equal(loaded.excluded, null);
      assert.equal(existsSync(join(dir, 'harness-failure.json')), false);
    }
  }
});

test('window identity failures count for competitors and sleight, including recorded classes and tool errors', t => {
  const root = mkdtempSync(join(tmpdir(), 'race-score-window-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const failures = [unavailableWindow, "I couldn't confirm the target window.", 'PID 99999 owns no windows.'];
  for (const arm of ['codex', 'sleight']) for (const [index, failure] of failures.entries()) {
    const dir = round(root, `${arm}-${index}`, 'safari', arm, Array.from({ length: 12 }, (_, i) =>
      [`task${i}`, 2, false, { events: i % 2 ? agentResult(failure) : claudeCall(String(i), true, failure) }]));
    // Older results can carry this class even when their event log is absent or later classifiers change.
    const results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
    results[0].errorClass = { class: 'window unavailable', example: failure };
    writeFileSync(join(dir, 'results.json'), JSON.stringify(results));
    const loaded = loadRound(dir), scored = scoreRounds([loaded]);
    assert.equal(loaded.rows[0].errorClass.class, 'window unavailable');
    assert.equal(loaded.excluded, null, `${arm}: ${failure}`);
    assert.equal(scored.safari.table[arm].task0.runs.length, 1);
    assert.equal(scored.safari.table[arm].task0.passes.length, 0);
    assert.equal(existsSync(join(dir, 'harness-failure.json')), false);
  }
});

test('historical window classes never cause automatic exclusion, but a reviewed marker still does', t => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ task: `task${i}`, ok: false,
    errorClass: { class: 'window unavailable', example: unavailableWindow } }));
  assert.equal(harnessFailure(rows), null);
  const root = mkdtempSync(join(tmpdir(), 'race-score-reviewed-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = round(root, 'reviewed-window', 'safari', 'codex', [['task0', 2, false, { events: agentResult(unavailableWindow) }]],
    { 'harness-failure.json': { reason: 'reviewed: wrong PID supplied by harness' } });
  assert.equal(loadRound(dir).excluded, 'reviewed: wrong PID supplied by harness');
});

test('eleven unavailable-turbo failures stay classified and count as sleight losses', t => {
  const root = mkdtempSync(join(tmpdir(), 'race-score-turbo-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = round(root, 'sleight-regression', 'chrome', 'sleight-turbo', Array.from({ length: 12 }, (_, i) =>
    [`task${i}`, 1, false, { events: claudeCall(String(i), true, i < 11 ? unavailableTurbo : 'element changed') }]));
  const loaded = loadRound(dir);
  assert.equal(loaded.rows.filter(row => row.errorClass?.class === 'turbo unavailable').length, 11);
  assert.equal(loaded.excluded, null);
  const scored = scoreRounds([loaded]);
  assert.equal(scored.chrome.table['sleight-turbo'].task0.runs.length, 1);
  assert.equal(scored.chrome.table['sleight-turbo'].task0.passes.length, 0);
  assert.equal(existsSync(join(dir, 'harness-failure.json')), false);
});

test('a saved row without events keeps its recorded browser-call count', () => {
  const row = { task: { name: 'mdn' }, surface: 'sleight', wallMs: 5000, outcome: { ok: true, cell: 'ok', problems: [] } };
  assert.equal(regradeRow({ ...row, successfulBrowserCalls: 2 }).passed, true);
  assert.deepEqual(regradeRow(row).problems, ['browser calls not recorded']);
});

const gateTask = { name: 'fixture', browser: 'chrome', prompt: 'Visit the fixture in {browser}.', result: 'the answer' };
function gateRuntime(dir, events) {
  let pid = 40;
  return { lockPath: join(dir, 'lock'), admit: async () => {}, startSites: async () => ({ close: async () => {} }),
    launchBrowser: async plan => ({ ...plan, get pid() { return pid; }, stop: async () => ({ browserClosed: true }) }),
    checkOwner: async () => ({ ok: true }), resetBrowser: async () => { pid++; return {}; },
    runAgent: async arm => { mkdirSync(arm.dir); writeFileSync(join(arm.dir, 'events.jsonl'), events + '\n');
      return { groupClean: true, exitCode: 0, result: { result: 'RESULT: none' }, evidence: { successfulCalls: 1, urls: [] }, started: 0, finished: 1000 }; },
    observeBrowser: async () => ({ observed: false, tabs: {}, reason: 'fixture' }) };
}

test('a live round records the build and harness commits and marks itself a harness failure', { skip: gitSkip }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'race-gate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasks = Array.from({ length: 12 }, (_, i) => ({ ...gateTask, name: `task${i}` }));
  const out = join(dir, 'out');
  await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out }, tasks,
    runner: { gradeOutcome: () => ({ problems: ['nothing submitted'] }), gradeSite: () => ({ problems: [] }) }, runtime: gateRuntime(dir, codexRefused) });
  process.exitCode = 0;
  const commits = JSON.parse(readFileSync(join(out, 'commits.json'), 'utf8'));
  const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(commits.build.commit, head);
  assert.equal(commits.harness.commit, head);
  assert.equal(commits.build.repo, repo);
  assert.equal(typeof commits.harness.dirty, 'number');
  const marked = JSON.parse(readFileSync(join(out, 'harness-failure.json'), 'utf8'));
  assert.equal(marked.class, 'approval refused');
  assert.equal(marked.count, 12);
  assert.equal(marked.decided, 'automatic');
  assert.equal(JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))[0].errorClass.class, 'approval refused');
  assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /Harness failure, excluded from scoring: 12 of 12 tasks failed with approval refused/);
  assert.match(loadRound(out).excluded, /12 of 12/);

  const ok = join(dir, 'ok');
  await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out: ok }, tasks: tasks.slice(0, 2),
    runner: { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) }, runtime: gateRuntime(dir, codexOk) });
  process.exitCode = 0;
  assert.equal(existsSync(join(ok, 'harness-failure.json')), false);
  assert.equal(existsSync(join(ok, 'commits.json')), true);
});

test('race-score names each arm\'s engine version, recorded or inferred, and flags engine arms on different versions', t => {
  const root = mkdtempSync(join(tmpdir(), 'race-engine-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const timed = (dir, startIso) => {
    const file = join(dir, 'results.json'), rows = JSON.parse(readFileSync(file, 'utf8'));
    rows.forEach((row, i) => { row.run.started = Date.parse(startIso) + i * 60000; row.run.finished = row.run.started + 30000; });
    writeFileSync(file, JSON.stringify(rows));
  };
  const span = version => ({ version, start: { version, at: '2026-10-19T06:00:00Z' }, end: { version, at: '2026-10-19T06:10:00Z' }, changed: false });
  round(root, 'real-s1-sleight', 'safari', 'sleight', [['form-travel', 30, true], ['mdn', 20, true]], { 'engine.json': span('26.1013.40934') });
  timed(round(root, 'real-c1-codex', 'safari', 'codex', [['form-travel', 35, true], ['mdn', 25, true]]), '2026-10-18T20:00:00Z');
  timed(round(root, 'real-l1-lcu', 'safari', 'lcu', [['form-travel', 40, true], ['mdn', 25, true]]), '2026-10-18T21:46:30Z');
  const rounds = expandRounds([join(root, 'real-*')]).map(dir => loadRound(dir));
  const byName = Object.fromEntries(rounds.map(r => [r.name, r]));
  assert.deepEqual(byName['real-s1-sleight'].engine,
    { version: '26.1013.40934', provenance: 'recorded', startedAt: '2026-10-19T06:00:00.000Z', endedAt: '2026-10-19T06:10:00.000Z', dated: 'recorded' });
  assert.deepEqual(byName['real-c1-codex'].engine,
    { version: '26.1007.71326', provenance: 'inferred', startedAt: '2026-10-18T20:00:00.000Z', endedAt: '2026-10-18T20:01:30.000Z', dated: 'recorded' });
  assert.equal(byName['real-l1-lcu'].engine.provenance, 'ambiguous');
  const s = scoreRounds(rounds).safari;
  assert.deepEqual([s.engines.sleight.versions['26.1013.40934'].runs, s.engines.sleight.versions['26.1013.40934'].recorded], [2, 2]);
  assert.deepEqual([s.engines.lcu.versions['26.1007.71326'].runs, s.engines.lcu.ambiguous.runs], [1, 1]);
  // LCU doesn't drive the ChatGPT engine, so only sleight against Codex counts as a mix.
  assert.deepEqual(s.engineMix, { versions: ['26.1007.71326', '26.1013.40934'], arms: { sleight: ['26.1013.40934'], codex: ['26.1007.71326'] } });
  const cli = spawnSync(process.execPath, [join(repo, 'bench/fowl/race-score.mjs'), join(root, 'real-*')], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /real-c1-codex \(safari, codex, 2 rows, engine 26\.1007\.71326 inferred, 2026-10-18\)/);
  assert.match(cli.stdout, /Engine and UTC dates per arm \(runs\): sleight engine 26\.1013\.40934 \(2 recorded\), 2026-10-19 \| codex engine 26\.1007\.71326 \(2 inferred\), 2026-10-18 \| lcu not used, 2026-10-18\./);
  assert.match(cli.stdout, /different engine versions: sleight on 26\.1013\.40934, codex on 26\.1007\.71326\./);
  // A round without task times or engine.json is dated by its commits.json birth, as an inferred date.
  const bare = round(root, 'bare-sleight', 'safari', 'sleight', [['mdn', 20, true]], { 'commits.json': {} });
  assert.equal(loadRound(bare).rows[0].engine.dated, 'inferred');
  assert.equal(loadRound(bare).rows[0].engine.startedAt.slice(0, 4), String(new Date().getUTCFullYear()));
});

test('a live round records the engine at its start and end, and flags a change', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'race-gate-engine-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reads = [{ version: '26.1007.71326', at: '2026-10-18T21:40:00Z' }, { version: '26.1013.40934', at: '2026-10-18T21:55:00Z' }];
  const out = join(dir, 'out');
  await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out }, tasks: [gateTask],
    runner: { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) }, runtime: { ...gateRuntime(dir, codexOk), readEngine: () => reads.shift() } });
  process.exitCode = 0;
  const span = JSON.parse(readFileSync(join(out, 'engine.json'), 'utf8'));
  assert.equal(span.changed, true);
  assert.deepEqual([span.start.version, span.end.version], ['26.1007.71326', '26.1013.40934']);
  assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /Engine: 26\.1007\.71326 at the start and 26\.1013\.40934 at the end \(changed during the round\)\. Round from 2026-10-18T21:40:00Z to 2026-10-18T21:55:00Z UTC\./);
  const plan = await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out: join(dir, 'dry'), 'dry-run': true }, tasks: [gateTask],
    runtime: { ...gateRuntime(dir, codexOk), readEngine: () => ({ version: '26.1013.40934' }), print: () => {}, readVersion: () => '1', preflight: () => ({}) } });
  assert.equal(plan.engine.version, '26.1013.40934');
});

// SOL-L1: event lines in the shapes race-1017's Sol rounds saved (firefox-codex-sleight-sol-b16-r3, firefox-codex-sol-r3).
const dragRefused = owner => JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'plugin_sleight_computer', tool: 'drag',
  arguments: { app: 'Firefox', from: [700, 1470], to: [700, 1350] }, status: 'failed', error: null, result: { content: [{ type: 'text',
    text: JSON.stringify({ path: 'none', error: `${owner} covers the window at the drag points, and this drag has no selected text; nothing was pressed` }, null, 1) }] } } });
const engineDrag = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js', status: 'completed', error: null,
  arguments: { code: 'await ff.drag([700,1011], [700,887]); await ff.getAXState();' }, result: { content: [{ type: 'text', text: 'no change' }] } } });
const claudeDrag = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'd', name: 'mcp__plugin_sleight_computer__drag', input: { app: 'Firefox', from: 91, to: 90 } }] } });
const docsOnly = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'js', status: 'completed', error: null,
  arguments: { code: 'let app = await cua.getApp("Firefox")' }, result: { content: [{ type: 'text', text: 'drag(from: Vec2, to: Vec2): Promise<void>; use app.drag(from, to)' }] } } });
const claude83 = { frame: { x: 4, y: 33, width: 1280, height: 854 }, covering: [{ owner: 'Claude', layer: 0, fraction: 0.826 }], moved: false };

const claude40 = { covering: [{ owner: 'Claude', layer: 0, fraction: 0.4 }] };
const covered = (evidence, rest) => ({ coverEvidence: evidence, ...rest });

test('cover evidence: a drag refusal or a reading of another app\'s normal window, for any outcome; overlays never count', () => {
  assert.deepEqual(coverRefusals(dragRefused('Claude')), ['Claude']);
  assert.deepEqual(coverRefusals('{"fallbackReason":"background skipped: Claude covers the window at the drag points"}'), [], 'a text drag that went ahead');
  assert.deepEqual(coverRefusals('x'.repeat(5_000_000) + dragRefused('Finder')), ['Finder'], 'a large log is scanned by the refusal text');
  // sleight in Codex: the drag tool named the app, and the start reading had nothing over the window (b16-r2 helium).
  assert.deepEqual(coverEvidence({ eventsText: [codexOk, dragRefused('Claude')].join('\n'), readings: [{ covering: [] }, null] }), { refused: ['Claude'], share: {} });
  // Codex's own computer use: no refusal text, the engine's drag in js and a reading of 83%. A pass records the same evidence.
  assert.deepEqual(coverEvidence({ eventsText: engineDrag, readings: [claude83] }), { refused: [], share: { Claude: 0.826 } });
  assert.deepEqual(coverEvidence({ eventsText: claudeDrag, readings: [null, { covering: [{ owner: 'Terminal', layer: 0, fraction: 0.12 }] }] }).share, { Terminal: 0.12 });
  // No drag (tool docs naming drag don't count), a banner under COVER_MIN, and overlays: the engine's, Cua's driver, the Dock, other layers.
  assert.equal(coverEvidence({ eventsText: docsOnly, readings: [claude83] }), null);
  assert.equal(coverEvidence({ eventsText: engineDrag, readings: [{ covering: [{ owner: 'UserNotificationCenter', layer: 0, fraction: COVER_MIN - 0.01 }] }, { error: 'timeout' }] }), null);
  const overlays = [{ owner: 'Codex Computer Use', layer: 0, fraction: 1 }, { owner: 'Cua Driver', layer: 0, fraction: 1 }, { owner: 'Dock', layer: 0, fraction: 0.5 },
    { owner: 'Stickies', layer: 3, fraction: 0.3 }];
  assert.deepEqual(countedCover(overlays), []);
  assert.equal(coverEvidence({ eventsText: engineDrag, readings: [{ covering: overlays }] }), null);
});

test('--exclude-covered leaves out every run a drag refusal names, pass or fail, and reading-only runs at 50% or more unless the arm passed under that window', () => {
  const rows = [
    covered({ refused: ['Claude'], share: {} }, { arm: 'codex-sleight-sol', task: 'form-settings', passed: false }),
    covered({ refused: ['Finder'], share: {} }, { arm: 'sleight', task: 'form-settings', passed: true }),
    // codex-sol under the Claude window: Firefox r2 passed form-settings, so the Safari and Firefox r3 failures stay scored.
    covered({ refused: [], share: { Claude: 0.83 } }, { arm: 'codex-sol', task: 'form-settings', passed: true, browser: 'firefox' }),
    covered({ refused: [], share: { Claude: 0.83 } }, { arm: 'codex-sol', task: 'form-settings', passed: false, browser: 'firefox' }),
    covered({ refused: [], share: { Claude: 0.82 } }, { arm: 'codex-sol', task: 'form-settings', passed: false, browser: 'safari' }),
    // No pass under the window for this arm and task, so the failures are left out.
    covered({ refused: [], share: { Claude: 0.82 } }, { arm: 'codex-sol', task: 'form-settings-helium', passed: false }),
    // Another arm's pass doesn't vouch for this arm, and 40% isn't enough without a refusal.
    covered({ refused: [], share: { Claude: 0.82 } }, { arm: 'cua', task: 'form-settings-helium', passed: false }),
    covered({ refused: [], share: { Finder: 0.41 } }, { arm: 'lcu', task: 'form-settings', passed: false }),
  ];
  const out = coverExclusions(rows);
  assert.deepEqual(rows.map(row => out.get(row)?.source ?? null), ['refusal', 'refusal', null, null, null, 'reading', 'reading', null]);
  assert.equal(out.get(rows[0]).reason, 'harness-covered by Claude, drag refused');
  assert.equal(out.get(rows[5]).reason, 'harness-covered by Claude 82%');
});

test('race-score scores covered runs by default, says so first, and leaves them out alike with --exclude-covered', t => {
  const root = mkdtempSync(join(tmpdir(), 'race-score-cover-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const codex = round(root, 'real-f1-codex-sol', 'firefox', 'codex-sol', [['form-settings', 170, false, { events: engineDrag }], ['form-travel', 60, true],
    ['mdn', 20, false, { events: codexOk }]]);
  const results = JSON.parse(readFileSync(join(codex, 'results.json'), 'utf8'));
  for (const row of results) row.cover = claude83;
  writeFileSync(join(codex, 'results.json'), JSON.stringify(results));
  round(root, 'real-f1-sleight', 'firefox', 'sleight', [['form-settings', 90, false, { events: [claudeDrag, dragRefused('Claude')].join('\n') }], ['form-travel', 50, true]]);
  round(root, 'real-f2-sleight', 'firefox', 'sleight', [['form-settings', 80, true, { events: [claudeDrag, dragRefused('Claude'), codexOk].join('\n') }], ['form-travel', 55, true]]);
  round(root, 'real-f3-sleight', 'firefox', 'sleight', [['form-settings', 70, true, { events: [claudeDrag, codexOk].join('\n') }], ['form-travel', 52, true]]);
  const load = () => expandRounds([join(root, 'real-*')]).map(dir => loadRound(dir));
  const plain = scoreRounds(load()).firefox;
  assert.deepEqual([plain.table.sleight['form-settings'].runs.length, plain.table.sleight['form-settings'].passes.length], [3, 2]);
  assert.deepEqual([plain.table['codex-sol']['form-settings'].runs.length, plain.table['codex-sol']['form-settings'].passes.length], [1, 0]);
  const rounds = load(), on = scoreRounds(rounds, { excludeCovered: true }).firefox;
  // Both refused sleight runs go, the pass with the failure; the codex-sol reading-only failure goes (no codex-sol pass under Claude).
  assert.deepEqual([on.table.sleight['form-settings'].runs.length, on.table.sleight['form-settings'].passes.length], [1, 1]);
  assert.equal(on.table['codex-sol']['form-settings'], undefined);
  // A failure with no drag in a covered window still counts against the arm.
  assert.deepEqual([on.table['codex-sol'].mdn.runs.length, on.table['codex-sol'].mdn.passes.length], [1, 0]);
  assert.deepEqual(coveredRows(rounds).map(c => [c.round, c.task, c.passed, c.excluded]), [
    ['real-f1-codex-sol', 'form-settings', false, true], ['real-f1-sleight', 'form-settings', false, true], ['real-f2-sleight', 'form-settings', true, true]]);
  // A cell under 3 runs is marked and can't be fastest: sleight's single form-settings run (on) and every codex-sol cell.
  assert.deepEqual(on.fastest.sleight, ['form-travel']);
  assert.ok(on.short.some(c => c.arm === 'sleight' && c.task === 'form-settings' && c.runs === 1));
  assert.deepEqual(plain.fastest['codex-sol'], []);
  const cli = (...flags) => spawnSync(process.execPath, [join(repo, 'bench/fowl/race-score.mjs'), root, ...flags], { encoding: 'utf8' });
  const off = cli();
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /^Cover exclusions: OFF \(default\)\n/);
  assert.match(off.stdout, /Rows with cover evidence \(3\), 3 of them left out under --exclude-covered, scored above \(1 passes, 2 failures\):\n  real-f1-codex-sol codex-sol form-settings fail: out, harness-covered by Claude 83%/);
  assert.match(off.stdout, /\* under 3 runs, kept out of "fastest on": .*form-settings\/codex-sol \(1\)/);
  const onText = cli('--exclude-covered').stdout;
  assert.match(onText, /^Cover exclusions: ON \(opt-in --exclude-covered\)\n/);
  assert.match(onText, /3 of them left out above/);
  const json = JSON.parse(cli('--json').stdout);
  assert.equal(json.coverExclusions, false);
  assert.equal(json.covered.length, 3);
  // A saved row without its events keeps what the gate recorded.
  const saved = { task: { name: 'form-settings' }, surface: 'codex-sol', wallMs: 1000, successfulBrowserCalls: 3, outcome: { ok: false, cell: 'FAIL: x', problems: ['x'] },
    coverEvidence: { refused: [], share: { Claude: 0.83 } } };
  assert.deepEqual(regradeRow(saved).coverEvidence, { refused: [], share: { Claude: 0.83 } });
  assert.equal(markCover([{ rows: [{ ...regradeRow(saved), passed: false }] }])[0].rows[0].harnessCover.source, 'reading');
});

test('a live round reads the cover during the run, logs the owners it saw, and records the evidence without leaving the row out', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'race-gate-cover-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'out'), places = [], watched = [], logged = [];
  // The start reading is clean after placing; the Claude app's window comes over during the run.
  const runtime = { ...gateRuntime(dir, [codexOk, engineDrag].join('\n')),
    windowCover: async (pid, options) => { places.push([pid, options]); return { frame: claude83.frame, covering: [], moved: false, screens: 1, bestOverlap: 0 }; },
    watchCover: pid => { watched.push(pid); return { stop: async () => ({ readings: 4, errors: 0, covering: [{ owner: 'Claude', fraction: 0.826 }],
      seen: [{ owner: 'Claude', layer: 0, fraction: 0.826, counted: true }, { owner: 'Cua Driver', layer: 0, fraction: 1, counted: false }] }) }; } };
  const error = console.error; console.error = line => logged.push(line); t.after(() => { console.error = error; });
  const rows = await runRealGate({ args: { surface: 'codex-sol', 'real-browser': 'firefox', out }, tasks: [{ ...gateTask, name: 'form-settings' }],
    runner: { gradeOutcome: () => ({ problems: ['nothing submitted'] }), gradeSite: () => ({ problems: [] }) }, runtime });
  console.error = error;
  process.exitCode = 0;
  // Placed once, then read again without moving the window after cover admission (VH1b).
  assert.deepEqual(places.map(([, options]) => options), [{ place: true }, {}]);
  assert.equal(watched.length, 1);
  assert.equal(watched[0], places[0][0]);
  assert.deepEqual(rows[0].coverRun.covering, [{ owner: 'Claude', fraction: 0.826 }]);
  assert.deepEqual(rows[0].coverEvidence, { refused: [], share: { Claude: 0.826 } });
  assert.equal(rows[0].harnessCover, undefined);
  assert.ok(logged.includes('cover watch form-settings: Claude 83% layer 0; Cua Driver 100% layer 0 (overlay, not counted)'), logged.join('\n'));
  const report = readFileSync(join(out, 'report.md'), 'utf8');
  assert.match(report, /\| form-settings \| codex-sol \| FAIL: nothing submitted \| not measured \| none; during: Claude 83% \|/);
  assert.match(report, /\n\nCover evidence: form-settings failed, Claude 83%\. Scored as run; `race-score\.mjs --exclude-covered` decides whether it is left out\.\n$/);
  assert.equal(coveredRows([loadRound(out)]).length, 1);
});

test('the hub states the cover rule only when its collect applied it, and the short-cell rule only for data scored with it', async t => {
  const { FAMILIES, collectRace, render } = await import('../bench/results-hub.mjs');
  const all = Object.fromEntries(FAMILIES.map(f => [f.id, JSON.parse(readFileSync(join(repo, 'docs/results/data', `${f.id}.json`), 'utf8'))]));
  const rule = /This collect also left out/;
  assert.doesNotMatch(render(all)['browser-race.md'], rule);
  all['browser-race'] = { ...all['browser-race'], cover: { applied: false, rows: 22, left: 15, leftPasses: 3 }, minRuns: 3 };
  assert.doesNotMatch(render(all)['browser-race.md'], rule);
  assert.match(render(all)['browser-race.md'], /An arm's cell with fewer than 3 runs isn't counted for lowest expected time on its task\./);
  all['browser-race'].cover.applied = true;
  assert.match(render(all)['browser-race.md'], /This collect also left out 15 runs, 3 of them passes, that tried a drag while another app's window covered the browser's/);
  const raceDir = join(homedir(), 'Projects/sleight-wt/race-1017');
  if (!existsSync(raceDir)) { t.skip('the race folder is not on this Mac'); return; }
  const off = collectRace({ raceDir, browsers: ['firefox'], family: 'browser-race', title: 'race' });
  const on = collectRace({ raceDir, browsers: ['firefox'], family: 'browser-race', title: 'race', excludeCovered: true });
  assert.equal(off.cover.applied, false);
  assert.equal(on.cover.applied, true);
  assert.equal(off.cover.left, on.cover.left);
  assert.ok(off.studies.flatMap(s => s.runs).every(run => !run.leftOut));
  assert.ok(on.studies.flatMap(s => s.runs).some(run => run.leftOut && run.passed), 'a covered pass is left out with the failures');
});
