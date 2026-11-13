// sleight-mcp stats and the dropdown's usage row (1.4.0): the action log's timing and reads-saved fields, and the summary
// read back from the log on this Mac.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { ActionLog, browserActionCount } from '../plugins/sleight/lib/action-outcomes.mjs';
import { GUARD_MARK, GUARD_END, createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { menuUsage, readLogRows, statsCommand, summarize } from '../plugins/sleight/lib/action-stats.mjs';

const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-stats-')));
after(() => removeTemp(dir));
const rowsOf = path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
// A clock the test moves: each request and reply reads it once.
const ticking = (...times) => () => times.shift();

test('each row carries its call\'s time from send to reply less approval prompts, its pid, and the reads the call saved', () => {
  const path = join(dir, 'ms.jsonl');
  // request 0, sent 1000, prompt opens 2000 and is answered 5000, reply 5500: 1500 ms of the call's own time.
  const log = new ActionLog({ path, root: dir, now: () => new Date(0), pid: 7, clock: ticking(0, 1000, 2000, 5000, 5500) });
  log.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.click(1); await app.click(2);' } } });
  log.sent(1);
  log.waitStart('s:9');
  log.waitEnd('s:9');
  log.outcomes(1, { planned: 2, app: 'TextEdit', outcomes: [{ a: 'click', n: 1, f: [{ o: 'none' }] }, { a: 'click', n: 2, f: [{ o: 'none' }] }] });
  log.saved(1, 2);
  log.reply({ id: 1, result: { content: [{ type: 'text', text: 'ok' }] } });
  assert.deepEqual(rowsOf(path).map(row => [row.kind, row.ms, row.saved, row.pid]), [['click', 1500, 2, 7], ['click', 1500, undefined, 7]]);
});

test('a prompt still open at the reply comes off too, and sleight\'s own tools time from their request', () => {
  const path = join(dir, 'open-wait.jsonl');
  // js: request 0, sent 100, prompt opens 200, reply 900 → 100 ms. drag: request 1000, reply 1400 → 400 ms.
  // A third call: sent 2100, the engine's prompt 2200 to 3100 and the client's copy of it 2300 to 3000, reply 3500 → 500 ms.
  const log = new ActionLog({ path, root: dir, pid: 7, clock: ticking(0, 100, 200, 900, 1000, 1400, 2000, 2100, 2200, 2300, 3000, 3100, 3500) });
  log.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.click(1);' } } });
  log.sent(1);
  log.waitStart('c:4');
  log.outcomes(1, { planned: 1, outcomes: [{ a: 'click', n: 1 }] });
  log.reply({ id: 1, result: { content: [{ type: 'text', text: 'ok' }] } });
  log.waitEnd('never-opened');
  log.request({ id: 2, method: 'tools/call', params: { name: 'drag', arguments: { app: 'TextEdit', from: 1, to: 2 } } });
  log.reply({ id: 2, result: { content: [{ type: 'text', text: 'dragged' }] } });
  log.request({ id: 3, method: 'tools/call', params: { name: 'browser_open', arguments: { url: 'https://example.com' } } });
  log.sent(3);
  log.waitStart('s:5'); log.waitStart('c:5'); log.waitEnd('c:5'); log.waitEnd('s:5');
  log.reply({ id: 3, result: { content: [{ type: 'text', text: 't1 https://example.com' }] } });
  assert.deepEqual(rowsOf(path).map(row => [row.tool, row.ms]), [['js', 100], ['drag', 400], ['browser_open', 500]]);
});

test('a js call on the engine\'s browser surface gets one row with the actions its code names, and a read gets none', () => {
  const path = join(dir, 'surface.jsonl');
  const log = new ActionLog({ path, root: dir, pid: 7, clock: ticking(0, 0, 4000, 0, 0, 10, 0, 0, 50) });
  const browser = { 'codex/toolSurface': { kind: 'browserUse' } };
  const call = (id, code, result) => {
    log.request({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
    log.sent(id);
    log.reply({ id, result: { ...result, _meta: browser } });
  };
  call(1, 'await tab.click(3); await tab.typeText("x.click(1)"); // tab.pressKey("Return")', { content: [{ type: 'text', text: 'done' }] });
  call(2, 'await tab.getAXState()', { content: [{ type: 'text', text: 'tree' }] });
  call(3, 'await tab.click(9)', { isError: true, content: [{ type: 'text', text: 'no element with ID 9' }] });
  assert.deepEqual(rowsOf(path).map(({ time, ...row }) => row), [
    { call: 1, tool: 'js', kind: 'call', surface: 'browser', actions: 2, result: 'ok', outcome: 'unverified', ms: 4000, pid: 7 },
    { call: 3, tool: 'js', kind: 'call', surface: 'browser', result: 'refused', reason: 'element not found', ms: 50, pid: 7 },
  ]);
  assert.equal(browserActionCount('for (const r of rows) await tab.click(r); await tab.goto(u); await tab.getByRole("button").fill("a");'), 3);
  assert.equal(browserActionCount('await tab.getAXState(); "tab.click(1)"'), 0);
  assert.equal(browserActionCount('const q = /[\'"]/; await tab.click(1); const half = width / 2; await tab.click(2);'), 2, 'a regular expression literal');
});

test('a read that saved reads gets a read row, and only turbo\'s own diff header counts as one read saved', () => {
  const path = join(dir, 'reads.jsonl');
  const log = new ActionLog({ path, root: dir, pid: 7, clock: ticking(0, 300, 0, 0, 900, 0, 0, 200, 0, 0, 100) });
  log.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.getAXState()' } } });
  log.saved(1, 3);
  log.reply({ id: 1, result: { content: [{ type: 'text', text: 'tree' }] } });
  const turbo = (id, name, text) => {
    log.request({ id, method: 'tools/call', params: { name, arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e2' }] } } });
    log.sent(id);
    log.reply({ id, result: { content: [{ type: 'text', text }] } });
  };
  turbo(2, 'browser_act', '1 click e2: 3 lines changed\n# Changes since snapshot 4; snapshot 5 (untrusted page content)\n+ button OK');
  turbo(3, 'browser_read', '# Changes since snapshot 5; snapshot 6 (untrusted page content)\n- button OK');
  turbo(4, 'browser_read', '# Snapshot 7 (untrusted page content)\nbutton OK\n# Changes since snapshot 9; snapshot 10 (untrusted page content)');
  assert.deepEqual(rowsOf(path).map(({ time, ...row }) => row), [
    { call: 1, tool: 'js', kind: 'read', result: 'ok', outcome: 'compacted', saved: 3, ms: 300, pid: 7 },
    { call: 2, tool: 'browser_act', kind: 'click', target: { ref: 'e2' }, result: 'ok', outcome: 'changed', saved: 1, ms: 900, pid: 7 },
    { call: 3, tool: 'browser_read', kind: 'read', result: 'ok', outcome: 'compacted', saved: 1, ms: 200, pid: 7 },
  ]);
});

// The engine's reads Claude got as changed lines or not at all, per call.
const tree = (rows, title = 'a.txt') => [`Window: "${title}", App: TextEdit.`,
  `0 standard window ${title}, URL: file:///tmp/${title}, Secondary Actions: Raise`, ...rows].join('\n');
const sidebar = Array.from({ length: 50 }, (_, i) => `\t${i + 2} row (selectable) Value: Chat ${i}`);
const text = value => ({ type: 'text', text: value });

test('the compactor counts the reads Claude asked for that went out as changed lines or were left out, never the guard\'s own', () => {
  const c = createReadCompactor({ callTrees: true });
  const guarded = (rows, title) => text(GUARD_MARK + tree(rows, title) + GUARD_END);
  const read = 'await app.getAXState();';
  c.process([text(tree(sidebar))], { code: read });
  assert.equal(c.takeSaved(), 0, 'a full read is sent whole');
  const click = 'await app.click(5);';
  c.process([guarded([...sidebar, '\t60 button OK'])], { code: click, action: c.beginAction(click) });
  assert.equal(c.takeSaved(), 0, 'the guard\'s read after an action is sleight\'s own');
  c.process([guarded([...sidebar, '\t61 button Cancel'])], { code: read });
  assert.equal(c.takeSaved(), 1, 'Claude\'s read as changed lines');
  assert.equal(c.takeSaved(), 0, 'taken once');
  c.process([guarded([...sidebar, '\t61 button Cancel'])], { code: read });
  assert.equal(c.takeSaved(), 1, 'no change');
  c.process([guarded(sidebar, 'b.txt')], { code: read });
  assert.equal(c.takeSaved(), 0, 'a new window is sent whole');
  const loop = 'await app.getAXState(); await app.scroll(3, "down", 1); await app.getAXState();';
  const out = c.process([text([1, 2, 3].map(n => GUARD_MARK + tree([...sidebar, `\t${60 + n} button Row ${n}`]) + GUARD_END).join(''))],
    { code: loop, action: c.beginAction(loop) }).map(item => item.text).join('\n');
  assert.match(out, /2 earlier reads of the same window in this call left out/);
  assert.equal(c.takeSaved(), 3, 'two left out and the last as changed lines');
  const readThenClick = 'await app.getAXState(); await app.click(7);';
  c.process([text([4, 5].map(n => GUARD_MARK + tree([...sidebar, `\t${60 + n} button Row ${n}`]) + GUARD_END).join(''))],
    { code: readThenClick, action: c.beginAction(readThenClick) });
  assert.equal(c.takeSaved(), 1, 'Claude\'s read counts and the guard\'s closing read doesn\'t');
});

// Rows as the 1.4.0 log writes them, around 2026-10-19 12:00 UTC.
const at = (day, hour, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString();
const fixture = {
  rotated: [
    { time: at(1, 0), call: 10, tool: 'js', app: 'TextEdit', kind: 'click', result: 'ok', outcome: 'unverified', ms: 1000 },
    { time: at(13, 9), call: 1, tool: 'js', app: 'TextEdit', kind: 'click', result: 'ok', outcome: 'no visible change', ms: 3000, saved: 2 },
    { time: at(13, 9), call: 1, tool: 'js', app: 'TextEdit', kind: 'typeText', result: 'ok', outcome: 'value changed', ms: 3000 },
  ],
  current: [
    { time: at(14, 10), call: 2, tool: 'drag', app: 'TextEdit', kind: 'drag', result: 'ok', outcome: 'done', ms: 1900 },
    { time: at(15, 11), call: 3, tool: 'browser_act', origin: 'https://example.com', kind: 'type', target: { ref: 'e1' }, result: 'ok', outcome: 'changed', ms: 1200, saved: 1 },
    { time: at(15, 11), call: 3, tool: 'browser_act', origin: 'https://example.com', kind: 'click', target: { ref: 'e2' }, result: 'ok', outcome: 'navigated', ms: 1200 },
    { time: at(15, 11), call: 3, tool: 'browser_act', origin: 'https://example.com', kind: 'press', target: { ref: 'e2' }, result: 'not run', reason: 'earlier step stopped', ms: 1200 },
    { time: at(15, 11, 1), call: 4, tool: 'browser_open', origin: 'https://example.com', kind: 'open', result: 'ok', outcome: 'opened', ms: 400 },
    { time: at(16, 8), call: 5, tool: 'js', kind: 'call', surface: 'browser', actions: 2, result: 'ok', outcome: 'unverified', ms: 5000 },
    { time: at(17, 8), call: 6, tool: 'js', kind: 'call', result: 'refused', reason: 'input lease', ms: 100 },
    { time: at(17, 9), call: 7, tool: 'js', app: 'Numbers', kind: 'click', result: 'failed', reason: 'engine error', ms: 4000 },
    { time: at(17, 9), call: 7, tool: 'js', app: 'Numbers', kind: 'rest', count: 2, result: 'not run', reason: 'stopped after 0', ms: 4000 },
    { time: at(18, 9), call: 8, tool: 'js', kind: 'read', result: 'ok', outcome: 'compacted', saved: 3, ms: 300 },
    { time: at(18, 10), call: 9, tool: 'js', app: 'TextEdit', kind: 'click', result: 'ok', outcome: 'unverified' },
    { time: at(19, 11), call: 11, tool: 'menu_bar', kind: 'menu_bar open', result: 'refused', reason: 'evil \u001b[31m text', ms: 50 },
  ],
};
const NOW = Date.UTC(2026, 9, 19, 12);
function logHome(name, { rows = fixture, junk = true } = {}) {
  const home = join(dir, name), root = join(home, 'Library/Logs/sleight');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lines = list => list.map(row => JSON.stringify(row)).join('\n') + '\n';
  if (rows.rotated) writeFileSync(join(root, 'actions.jsonl.1'), lines(rows.rotated), { mode: 0o600 });
  if (rows.current) writeFileSync(join(root, 'actions.jsonl'), (junk ? 'not json\n{"call":1}\n' : '') + lines(rows.current), { mode: 0o600 });
  return { home, path: join(root, 'actions.jsonl') };
}
async function run(args, { env = {}, home, settings } = {}) {
  let output = '';
  if (settings !== undefined) { mkdirSync(join(home, '.claude'), { recursive: true }); writeFileSync(join(home, '.claude/settings.json'), settings); }
  const code = await statsCommand(args, { out: value => { output += value; }, env, home, now: () => NOW, timeZone: 'UTC' });
  return { code, output };
}

test('the summary counts actions that ran, times them per call, and splits native apps, turbo and the engine path', async () => {
  const { path } = logHome('summary');
  const { rows, files } = await readLogRows(path);
  assert.equal(files, 2);
  assert.deepEqual(summarize(rows, { now: NOW, days: 7 }), {
    days: 7, from: '2026-10-13T09:00:00.000Z', to: '2026-10-19T11:00:00.000Z', calls: 7, actions: 10, timed: 9, untimed: 1,
    paths: {
      native: { actions: 5, timed: 4, median: 1.7, p90: 3.37 },
      turbo: { actions: 3, timed: 3, median: 0.6, p90: 0.6 },
      engine: { actions: 2, timed: 2, median: 2.5, p90: 2.5 },
    },
    readsSaved: 6,
    refused: { count: 2, reasons: { 'input lease': 1, other: 1 } },
    failed: { count: 1, reasons: { 'engine error': 1 } },
    notRun: 3,
  });
});

test('a planted or corrupt log can\'t blow up the summary: weights are capped and never expanded', () => {
  const huge = [
    { time: at(18, 1), call: 1, pid: 1, tool: 'js', kind: 'rest', count: 1e15, result: 'not logged', reason: 'record cap', ms: 1000 },
    { time: at(18, 2), call: 2, pid: 1, tool: 'js', kind: 'call', surface: 'browser', actions: 1e9, result: 'ok', ms: 500, saved: 1e12 },
    { time: at(18, 3), call: 3, pid: 1, tool: 'js', kind: 'rest', count: 1e9, result: 'not run', reason: 'stopped after 0', ms: 1 },
  ];
  const started = Date.now(), summary = summarize(huge, { now: NOW });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual([summary.paths.native.actions, summary.paths.engine.actions, summary.readsSaved, summary.notRun], [1000, 100, 1000, 1000]);
  assert.deepEqual([summary.paths.native.median, summary.paths.engine.median], [0.001, 0.005]);
});

test('two sessions\' calls with the same id and time stay two calls', () => {
  const row = { time: at(18, 1), call: 1, tool: 'js', kind: 'click', result: 'ok', outcome: 'unverified' };
  const summary = summarize([{ ...row, pid: 10, ms: 1000 }, { ...row, pid: 11, ms: 3000 }], { now: NOW });
  assert.deepEqual([summary.calls, summary.paths.native.median], [2, 2]);
});

test('sleight-mcp stats prints the week from the log, with untrusted text from the log left out', async () => {
  const { home } = logHome('text');
  const { code, output } = await run([], { env: { SLEIGHT_ACTION_LOG: 'actions.jsonl' }, home });
  assert.equal(code, 0);
  assert.equal(output, [
    'sleight stats for the last 7 days, 2026-10-13 09:00 to 2026-10-19 11:00 (UTC)',
    'Log: ~/Library/Logs/sleight/actions.jsonl, with 1 rotated file',
    '10 actions in 7 calls',
    'Seconds per action, from sending each call to its reply, less approval prompts:',
    '  Native apps: 5 actions, median 1.7 s, p90 3.4 s',
    '  Turbo: 3 actions, median 0.6 s, p90 0.6 s',
    '  Engine path: 2 actions, median 2.5 s, p90 2.5 s, with actions counted from the code (an estimate)',
    'A p90 can include waits sleight can\'t separate, such as turbo\'s own confirmation cards.',
    'Reads saved: 6, reads Claude asked for that went out as changed lines or were left out',
    'Refused: 2 (input lease 1, other 1)',
    'Failed: 1 (engine error 1)',
    'Not run: 3',
    '1 action has no timing: sleight before 1.4.0 logged it.',
    'This comes from the log on this Mac. Nothing is sent anywhere.',
    '',
  ].join('\n'));
  assert.doesNotMatch(output, /evil|\u001b/);
});

test('--json gives the same summary with the log path, and --days widens the window', async () => {
  const { home } = logHome('json');
  const { code, output } = await run(['--json', '--days', '30'], { env: { SLEIGHT_ACTION_LOG: 'actions.jsonl' }, home });
  assert.equal(code, 0);
  const summary = JSON.parse(output);
  assert.equal(summary.log, '~/Library/Logs/sleight/actions.jsonl');
  assert.equal(summary.days, 30);
  assert.equal(summary.actions, 11);
  assert.equal(summary.from, '2026-10-01T00:00:00.000Z');
  for (const args of [['--days', '0'], ['--days', '7.5'], ['--days'], ['--days', '366'], ['--verbose'], ['week']]) {
    const bad = await run(args, { env: { SLEIGHT_ACTION_LOG: 'actions.jsonl' }, home });
    assert.equal(bad.code, 2, args.join(' '));
    assert.equal(bad.output, 'usage: sleight-mcp stats [--days N] [--json] [--log <file name>]\n');
  }
});

test('the log comes from --log, the environment, or the env block of ~/.claude/settings.json', async () => {
  const { home } = logHome('sources');
  const settings = await run(['--json'], { home, settings: JSON.stringify({ env: { SLEIGHT_ACTION_LOG: 'actions.jsonl' } }) });
  assert.equal(JSON.parse(settings.output).actions, 10);
  const flag = await run(['--json', '--log', '~/Library/Logs/sleight/actions.jsonl'], { home, env: { SLEIGHT_ACTION_LOG: 'other.jsonl' } });
  assert.equal(JSON.parse(flag.output).actions, 10);
});

test('with the log off, stats says how to turn it on; on but empty, it says so', async () => {
  const home = join(dir, 'off');
  mkdirSync(home);
  const howTo = 'To turn it on, add "SLEIGHT_ACTION_LOG": "actions.jsonl" to the env block of ~/.claude/settings.json, then start a new session.\n' +
    'The log stays in ~/Library/Logs/sleight/ on this Mac. Nothing is sent anywhere.\n';
  assert.deepEqual(await run([], { home }), { code: 0, output: 'The action log is off, so sleight has nothing to count.\n' + howTo });
  assert.deepEqual(await run([], { home, settings: '{ not json' }), { code: 0, output: 'The action log is off, so sleight has nothing to count.\n' + howTo });
  assert.deepEqual(await run([], { home, env: { SLEIGHT_ACTION_LOG: '/tmp/elsewhere.jsonl' } }), { code: 0, output:
    'SLEIGHT_ACTION_LOG takes a file name or a path under ~/Library/Logs/sleight/, so this one is ignored and the action log is off.\n' + howTo });
  assert.deepEqual(JSON.parse((await run(['--json'], { home })).output), { log: null });
  assert.deepEqual(await run([], { home, env: { SLEIGHT_ACTION_LOG: 'actions.jsonl' } }), { code: 0, output:
    'The action log is on (~/Library/Logs/sleight/actions.jsonl), and nothing is in it yet.\n' });
  const { home: quiet } = logHome('quiet', { rows: { current: [fixture.rotated[0]] }, junk: false });
  assert.deepEqual(await run([], { home: quiet, env: { SLEIGHT_ACTION_LOG: 'actions.jsonl' } }), { code: 0, output:
    'No actions logged in the last 7 days.\nLog: ~/Library/Logs/sleight/actions.jsonl\n' });
});

test('a log file over the size limit is skipped, and the output says so', async () => {
  const { home, path } = logHome('big');
  const { statSync } = await import('node:fs');
  let output = '';
  // A limit just over the rotated file's size: the current file, which is larger, is skipped.
  await statsCommand([], { out: value => { output += value; }, env: { SLEIGHT_ACTION_LOG: 'actions.jsonl' }, home, now: () => NOW, timeZone: 'UTC',
    maxBytes: statSync(path + '.1').size + 1 });
  assert.match(output, /\nSkipped 1 log file over 16 MB\.\n/);
  assert.match(output, /^sleight stats for the last 7 days, 2026-10-13 09:00 to 2026-10-13 09:00 \(UTC\)\n/);
});

test('stats reads only regular files and leaves a linked log alone', async () => {
  const { home, path } = logHome('linked', { rows: { current: fixture.current } });
  const { symlinkSync, renameSync } = await import('node:fs');
  renameSync(path, path + '.real');
  symlinkSync(path + '.real', path);
  const { rows, files } = await readLogRows(path);
  assert.deepEqual([rows.length, files], [0, 0]);
  chmodSync(path + '.real', 0o600);
  assert.match((await run([], { home, env: { SLEIGHT_ACTION_LOG: 'actions.jsonl' } })).output, /nothing is in it yet/);
});

test('sleight-mcp stats runs from the launcher without starting the engine', async () => {
  const { spawnSync } = await import('node:child_process');
  const { home } = logHome('launcher');
  const launch = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [launch, 'stats', '--json', '--days', '365'], { encoding: 'utf8', timeout: 30000,
    env: { PATH: '/usr/bin:/bin', HOME: home, SLEIGHT_ACTION_LOG: 'actions.jsonl' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([JSON.parse(result.stdout).log, JSON.parse(result.stdout).files], ['~/Library/Logs/sleight/actions.jsonl', 2]);
});

test('the dropdown\'s numbers: seconds per action, turbo\'s, and reads saved, or nothing without timed actions', async () => {
  const { path } = logHome('menu');
  assert.deepEqual(await menuUsage({ path, now: () => NOW }), { native: 1.7, turbo: 0.6, saved: 6 });
  const { path: refusedOnly } = logHome('menu-refused', { rows: { current: [fixture.current[6]] }, junk: false });
  assert.equal(await menuUsage({ path: refusedOnly, now: () => NOW }), undefined);
  assert.equal(await menuUsage({ path: join(dir, 'none/actions.jsonl'), now: () => NOW }), undefined);
  const { path: native } = logHome('menu-native', { rows: { current: fixture.current.slice(0, 1) }, junk: false });
  assert.deepEqual(await menuUsage({ path: native, now: () => NOW }), { native: 1.9, saved: 0 });
  const { path: engineOnly } = logHome('menu-engine', { rows: { current: [fixture.current[5]] }, junk: false });
  assert.equal(await menuUsage({ path: engineOnly, now: () => NOW }), undefined, 'the engine path\'s estimate stays out of the row');
});
