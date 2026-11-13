// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
// AS-3 A/B harness: SLEIGHT_BROWSER_CORE through the race's engine arm, the held-out browser tasks, the block runner (with
// a fake round runner and stand-in hold, lock and pause paths) and the scorer (with fake round folders). Nothing here
// launches a browser or touches /tmp/sleight-hold or /tmp/sleight-live.lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abFlags, engineAllowed, realAgentSetup, traceEnv } from '../bench/fowl/real-gate-setup.mjs';
import { realGatePlan } from '../bench/fowl/real-gate.mjs';
import { taskSupport } from '../bench/fowl/support.mjs';
import { browserOpenUse, errorKind, loadAbRound, roundSide, scoreAb } from '../bench/fowl/as3-score.mjs';
import { codexSleightServers } from '../bench/codex-sleight.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(repo, path), 'utf8');
const heldOut = JSON.parse(read('bench/world/tasks/browser-open-heldout.json'));
const raceFile = JSON.parse(read('bench/world/tasks/fowlbrowser.json'));
const OPEN = 'mcp__plugin_sleight_computer__browser_open';
const browsers = {
  safari: { browser: 'safari', profileRoot: '/tmp/as3-profile', executable: '/Applications/Safari.app/Contents/MacOS/Safari', marker: 'Sleight Gate as3-fixture', pid: 1 },
  firefox: { browser: 'firefox', profileRoot: '/tmp/as3-profile', executable: '/Applications/Firefox.app/Contents/MacOS/firefox', marker: 'Sleight Gate as3-fixture', pid: 1 },
};
const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(vars)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    return fn();
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
};

test('traceEnv forwards SLEIGHT_BROWSER_CORE=1 only, and abFlags records each A/B flag as on or off', () => {
  assert.deepEqual(traceEnv({ SLEIGHT_BROWSER_CORE: '1', HOME: '/h' }), { SLEIGHT_BROWSER_CORE: '1' });
  assert.deepEqual(traceEnv({ SLEIGHT_BROWSER_CORE: '0' }), {});
  assert.deepEqual(traceEnv({ SLEIGHT_BROWSER_CORE: 'true' }), {});
  assert.deepEqual(traceEnv({ SLEIGHT_TRACE: '/t', SLEIGHT_FS: '1', SLEIGHT_BROWSER_CORE: '1' }), { SLEIGHT_TRACE: '/t', SLEIGHT_FS: '1', SLEIGHT_BROWSER_CORE: '1' });
  assert.deepEqual(abFlags({ SLEIGHT_BROWSER_CORE: '1' }), { SLEIGHT_TS3: false, SLEIGHT_FS: false, SLEIGHT_BROWSER_CORE: true, SLEIGHT_RS: true, SLEIGHT_MC1: true });
  assert.deepEqual(abFlags({}), { SLEIGHT_TS3: false, SLEIGHT_FS: false, SLEIGHT_BROWSER_CORE: false, SLEIGHT_RS: true, SLEIGHT_MC1: true });
  assert.ok(!engineAllowed({}).includes('browser_open'));
  assert.ok(!engineAllowed({ SLEIGHT_BROWSER_CORE: '0' }).includes('browser_open'));
  assert.equal(engineAllowed({ SLEIGHT_BROWSER_CORE: '1' }), engineAllowed({}) + ',' + OPEN);
});

for (const name of ['safari', 'firefox']) test(`${name} engine arm: flag off has no browser_open; flag on passes the flag, allows browser_open and records it`, () => {
  const task = { ...heldOut[0], browser: name };
  const plan = core => withEnv({ SLEIGHT_BROWSER_CORE: core, SLEIGHT_TRACE: undefined }, () =>
    realAgentSetup({ task, surface: 'sleight', dir: `${MAC_TMP}/as3-task`, realBrowser: browsers[name], dryRun: true }));
  const allowedOf = setup => setup.args[setup.args.indexOf('--allowedTools') + 1];
  for (const core of [undefined, '0']) {
    const off = plan(core);
    assert.deepEqual(off.mcpConfig.mcpServers['plugin:sleight:computer'].env, { SLEIGHT_SURFACES: 'computer', SLEIGHT_TURBO: '0', SLEIGHT_HAND: '0' });
    assert.ok(!allowedOf(off).includes('browser_open'));
    assert.equal(off.metadata.abFlags.SLEIGHT_BROWSER_CORE, false);
  }
  const on = plan('1');
  assert.equal(on.mcpConfig.mcpServers['plugin:sleight:computer'].env.SLEIGHT_BROWSER_CORE, '1');
  assert.equal(on.mcpConfig.mcpServers['plugin:sleight:computer'].env.SLEIGHT_TURBO, '0');
  assert.equal(allowedOf(on), on.allowed);
  assert.deepEqual(on.allowed.split(','), [...allowedOf(plan(undefined)).split(','), OPEN]);
  assert.equal(on.metadata.abFlags.SLEIGHT_BROWSER_CORE, true);
  assert.equal(on.metadata.connectionMode, 'engine-computer');
  assert.ok(!('SLEIGHT_BROWSER_CORE' in on.env), 'the flag goes to the sleight server, not to Claude Code');
  // sleight inside Codex builds the same arm, so its enabled tools follow the flag too.
  const servers = codexSleightServers({ mcpServers: on.mcpConfig.mcpServers, allowed: on.allowed, dir: `${MAC_TMP}/as3-task`, policy: 'race' });
  assert.ok(Object.values(servers)[0].enabledTools.includes('browser_open'));
});

test('a turbo arm is left as it was: browser_open there is turbo\'s own tool, not this A/B', () => {
  const task = { ...heldOut[0], browser: 'chrome' };
  const chrome = { browser: 'chrome', profileRoot: '/tmp/as3-profile', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', marker: 'Sleight Gate as3-fixture', pid: 1, port: 9222 };
  const [off, on] = ['0', '1'].map(core => withEnv({ SLEIGHT_BROWSER_CORE: core }, () =>
    realAgentSetup({ task, surface: 'sleight-turbo', dir: `${MAC_TMP}/as3-task`, realBrowser: chrome, dryRun: true })));
  assert.equal(on.allowed, off.allowed);
  assert.equal(on.metadata.abFlags, undefined);
});

test('rounds.sh carries SLEIGHT_BROWSER_CORE through its real-browser env -i branch', () => {
  const script = read('bench/fowl/rounds.sh');
  const branch = script.slice(script.indexOf('if [ -n "$REAL" ]; then'), script.indexOf('fi\n', script.indexOf('if [ -n "$REAL" ]; then')));
  assert.match(branch, /env -i[\s\S]*\$\{SLEIGHT_BROWSER_CORE:\+SLEIGHT_BROWSER_CORE="\$SLEIGHT_BROWSER_CORE"\}[\s\S]*node tools\/rounds\.mjs/);
  assert.ok(!/SLEIGHT_PROMPT|ANTHROPIC_API_KEY|CLAUDE_/.test(branch));
});

test('the held-out tasks share no task, persona or site tag with the 12 race tasks', () => {
  const race = raceFile.filter(task => !['mobile', 'takeover'].includes(task.name));
  assert.equal(race.length, 12);
  const tokens = list => new Set(list.flatMap(task => [task.grade, task.site?.log].filter(Boolean)).map(url => url.replace(/\/api\/log$/, '')));
  const raceTokens = tokens(race), names = new Set(raceFile.map(task => task.name));
  const refs = list => new Set(list.flatMap(task => task.prompt.match(/reference code (p\d+)/g) ?? []));
  assert.ok(heldOut.length >= 5);
  for (const task of heldOut) {
    assert.ok(!names.has(task.name), task.name);
    for (const token of tokens([task])) assert.ok(!raceTokens.has(token), `${task.name}: ${token}`);
    for (const ref of refs([task])) assert.ok(!refs(race).has(ref), `${task.name}: ${ref}`);
    assert.ok(!race.some(other => other.prompt === task.prompt), task.name);
  }
  assert.equal(new Set(heldOut.map(task => task.name)).size, heldOut.length);
});

test('every held-out task runs on the local demo site in Safari and Firefox, with its source and rationale', () => {
  for (const task of heldOut) {
    assert.match(task.name, /^[a-zA-Z0-9_-]+$/);
    assert.equal(typeof task.rationale, 'string'); assert.ok(task.rationale.length > 40, task.name);
    assert.match(task.source, /^(?:FowlBrowser tools\/agents\/\S+\.json \S+|sleight AO held-out lookup)$/);
    assert.ok(task.result && task.budgetSeconds > 0 && (task.grade || task.expect), task.name);
    assert.ok(!/\{repo\}|\{out\}/.test(task.prompt), `${task.name} needs no path`);
    for (const url of [...task.prompt.match(/https?:\/\/\S+/g), task.grade, task.site?.log].filter(Boolean))
      assert.match(url, /^http:\/\/127\.0\.0\.1:(5413|5420)\//, `${task.name}: ${url}`);
    for (const browser of ['safari', 'firefox']) assert.equal(taskSupport(task, 'sleight', { realBrowser: browser }), null, `${task.name} in ${browser}`);
  }
  for (const browser of ['safari', 'firefox']) {
    const plan = withEnv({ SLEIGHT_BROWSER_CORE: '1' }, () => realGatePlan({ args: { 'real-browser': browser, surface: 'sleight', out: '/tmp/as3-never-made' },
      tasks: heldOut, realBrowser: browsers[browser] }));
    assert.deepEqual(plan.unsupported, []);
    assert.deepEqual(plan.arms.map(arm => arm.task.name), heldOut.map(task => task.name));
    assert.ok(plan.arms.every(arm => arm.task.browser === browser && arm.allowed.includes(OPEN) && arm.metadata.abFlags.SLEIGHT_BROWSER_CORE));
  }
  assert.equal(existsSync('/tmp/as3-never-made'), false);
});

// The block runner, with a fake rounds.sh that records its flag and arguments and writes results.json.
const fakeRunner = dir => {
  const file = join(dir, 'fake-rounds.sh');
  writeFileSync(file, `#!/bin/sh
out=""; prev=""; for a in "$@"; do [ "$prev" = --out ] && out="$a"; prev="$a"; done
n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${dir}/count"
if [ -e "${dir}/busy-once" ]; then rm "${dir}/busy-once"; echo "Error: EEXIST: file already exists, mkdir '/tmp/sleight-live.lock'"; exit 1; fi
echo "$SLEIGHT_BROWSER_CORE $(basename "$out") $* prompt=\${AS3_WINDOW_PROMPT:-0}" >> "${dir}/calls"
mkdir -p "$out"; echo '[]' > "$out/results.json"
`);
  chmodSync(file, 0o755);
  return file;
};
const runner = (dir, extra = {}) => ({ ...process.env, AS3_OUT: join(dir, 'out'), AS3_RUNNER: fakeRunner(dir), AS3_HOLD: join(dir, 'hold'),
  AS3_LOCK: join(dir, 'lock'), AS3_POLL: '0.05', ...extra });
const script = join(repo, 'bench/fowl/as3-ab.command');
const calls = dir => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : [];

test('the runner runs 5 rounds per cell and browser in balanced order on the held-out list, then scores, and resumes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'as3-ab-'));
  try {
    const result = spawnSync('/bin/sh', [script], { env: runner(dir), encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    const lines = calls(dir);
    const expected = [];
    const orders = [['off', 'on', 'on-prompt'], ['on', 'on-prompt', 'off'], ['on-prompt', 'off', 'on'],
      ['off', 'on-prompt', 'on'], ['on-prompt', 'on', 'off'], ['on', 'off', 'on-prompt']];
    for (let n = 1; n <= 5; n++) for (const browser of ['safari', 'firefox'])
      for (const side of orders[(n - 1) % orders.length])
        expected.push(`${side === 'off' ? 0 : 1} as3-ao-${browser}-${side}-r${n}`);
    assert.deepEqual(lines.map(line => line.split(' ').slice(0, 2).join(' ')), expected);
    for (const line of lines) assert.equal(line.endsWith('prompt=1'), /-on-prompt-/.test(line), line);
    for (const line of lines) {
      assert.match(line, / --world --real-browser (safari|firefox) --surface sleight --model haiku --effort high /);
      assert.ok(line.includes(`--tasks ${join(repo, 'bench/world/tasks/browser-open-heldout.json')} `), line);
      assert.ok(line.includes(`--out ${join(dir, 'out')}/as3-ao-`), line);
    }
    const log = readFileSync(join(dir, 'out/as3-ab.log'), 'utf8');
    assert.match(log, /^as3-ab start \S+ build \S+ rounds 5$/m);
    assert.match(log, /^as3-ao-firefox-on-prompt-r5 exit 0 /m);
    assert.match(log, /^as3-ab done .*as3-score\.txt$/m);
    assert.ok(existsSync(join(dir, 'out/as3-score.txt')));
    // A second start keeps every finished round.
    assert.equal(spawnSync('/bin/sh', [script], { env: runner(dir), encoding: 'utf8', timeout: 60000 }).status, 0);
    assert.equal(calls(dir).length, 30);
    assert.match(readFileSync(join(dir, 'out/as3-ab.log'), 'utf8'), /^as3-ao-safari-off-r1 kept /m);
    // A configured sixth round completes the permutation cycle; the default remains five rounds.
    assert.equal(spawnSync('/bin/sh', [script], { env: runner(dir, { AS3_ROUNDS: '6' }), encoding: 'utf8', timeout: 60000 }).status, 0);
    const sixth = calls(dir).slice(30).map(line => line.split(' ')[1]);
    assert.deepEqual(sixth, ['safari', 'firefox'].flatMap(br => orders[5].map(side => `as3-ao-${br}-${side}-r6`)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the runner waits on the hold, the live lock and the pause file, and reruns a round that met the lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'as3-ab-'));
  try {
    mkdirSync(join(dir, 'out'));
    for (const [make, path] of [[p => writeFileSync(p, ''), join(dir, 'hold')], [p => mkdirSync(p), join(dir, 'lock')], [p => writeFileSync(p, ''), join(dir, 'out/pause')]]) make(path);
    writeFileSync(join(dir, 'busy-once'), '');
    const child = spawn('/bin/sh', [script], { env: runner(dir, { AS3_ROUNDS: '1' }), stdio: 'ignore' });
    const exited = new Promise(resolve => child.on('exit', resolve));
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await wait(600);
    assert.equal(existsSync(join(dir, 'count')), false, 'nothing starts while the hold, lock and pause exist');
    rmSync(join(dir, 'hold')); await wait(300);
    assert.equal(existsSync(join(dir, 'count')), false, 'the lock still holds it');
    rmSync(join(dir, 'lock'), { recursive: true }); await wait(300);
    assert.equal(existsSync(join(dir, 'count')), false, 'the pause file still holds it');
    rmSync(join(dir, 'out/pause'));
    assert.equal(await Promise.race([exited, wait(30000).then(() => 'timeout')]), 0);
    assert.equal(readFileSync(join(dir, 'count'), 'utf8').trim(), '7', 'the round that met the lock ran again');
    assert.deepEqual(calls(dir).map(line => line.split(' ')[1]), ['as3-ao-safari-off-r1', 'as3-ao-safari-on-r1', 'as3-ao-safari-on-prompt-r1', 'as3-ao-firefox-off-r1', 'as3-ao-firefox-on-r1', 'as3-ao-firefox-on-prompt-r1']);
    assert.ok(!existsSync(join(dir, 'hold')) && !existsSync(join(dir, 'lock')), 'the runner never makes the hold or the lock');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const missing of ['core', 'forwarded prompt', 'recorded prompt']) test(`the runner refuses a build without ${missing} plumbing`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'as3-ab-'));
  try {
    const copy = join(dir, 'repo/bench/fowl');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'as3-ab.command'), read('bench/fowl/as3-ab.command'));
    mkdirSync(join(dir, 'repo/plugins/sleight/lib'), { recursive: true });
    mkdirSync(join(dir, 'repo/bench/world/tasks'), { recursive: true });
    writeFileSync(join(dir, 'repo/plugins/sleight/lib/engine-browser-open.mjs'), '');
    writeFileSync(join(dir, 'repo/bench/world/tasks/browser-open-heldout.json'), '[]');
    const rounds = read('bench/fowl/rounds.sh');
    const setup = read('bench/fowl/real-gate-setup.mjs');
    writeFileSync(join(copy, 'rounds.sh'), missing === 'core' ? rounds.replaceAll('SLEIGHT_BROWSER_CORE', 'MISSING_CORE')
      : missing === 'forwarded prompt' ? rounds.replaceAll('AS3_WINDOW_PROMPT', 'MISSING_PROMPT') : rounds);
    writeFileSync(join(copy, 'real-gate-setup.mjs'), missing === 'recorded prompt' ? setup.replaceAll('AS3_WINDOW_PROMPT', 'MISSING_PROMPT') : setup);
    const result = spawnSync('/bin/sh', [join(copy, 'as3-ab.command')], { env: runner(dir), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lacks AS-3 or its harness plumbing/);
    assert.equal(existsSync(join(dir, 'count')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an on-prompt folder with product-on metadata is excluded instead of polluting the product cell', () => {
  const root = mkdtempSync(join(tmpdir(), 'as3-score-'));
  try {
    const dir = fakeRound(root, 'as3-ao-safari-on-prompt-r1', { core: true, seconds: { 'smoke-red': 20 } });
    const round = loadAbRound(dir);
    assert.equal(round.side, 'on');
    assert.match(round.excluded, /on-prompt.*AS3_WINDOW_PROMPT.*not recorded/);
    assert.deepEqual(scoreAb([round]).browsers, {});
    const cli = spawnSync(process.execPath, [join(repo, 'bench/fowl/as3-score.mjs'), dir], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /excluded, on-prompt folder but AS3_WINDOW_PROMPT was not recorded/);
    const rows = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
    rows.forEach(row => { row.agentConfig.as3WindowPrompt = true; });
    writeFileSync(join(dir, 'results.json'), JSON.stringify(rows));
    assert.equal(loadAbRound(dir).side, 'on-prompt');
    assert.equal(loadAbRound(dir).excluded, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Fake rounds in the shape real-gate.mjs saves: results.json rows, browser.json and each task's events.jsonl.
const call = (id, name, isError, text) => [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } })].join('\n');
function fakeRound(root, name, { browser = 'safari', core, seconds, failed = [], errors = {}, opens = core === true }) {
  const dir = join(root, name), started = Date.parse('2026-10-19T12:00:00Z');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'browser.json'), JSON.stringify({ browser }));
  const rows = Object.entries(seconds).map(([task, s], i) => {
    mkdirSync(join(dir, task));
    // Off: the lone getApp, the tab keys, then the page; on: browser_open, then the page.
    const open = opens ? [call(`o${i}`, 'mcp__plugin_sleight_computer__browser_open', false, 'tree')]
      : [call(`g${i}`, 'mcp__plugin_sleight_computer__js', false, 'app'), call(`t${i}`, 'mcp__plugin_sleight_computer__js', false, 'tab')];
    const events = [JSON.stringify({ type: 'system', t: started }), ...open, call(`j${i}`, 'mcp__plugin_sleight_computer__js', false, 'ok'),
      ...(errors[task] ? [call(`e${i}`, 'mcp__plugin_sleight_computer__js', true, errors[task])] : [])].join('\n').split('\n').map((line, index) => {
      const event = JSON.parse(line);
      event.t ??= started + index * (opens ? 1000 : 2000);
      if (event.type === 'user' && event.message.content[0].tool_use_id === `j${i}`)
        event.message.content[0].content = 'Window: "Shop", App: Browser.\n0 standard window Shop\n\t1 HTML content URL: 127.0.0.1:5420/t/x/shop/';
      return JSON.stringify(event);
    });
    writeFileSync(join(dir, task, 'events.jsonl'), events.join('\n') + '\n');
    const ok = !failed.includes(task);
    return { task: { name: task, browser }, surface: 'sleight', wallMs: s * 1000, successfulBrowserCalls: 1,
      outcome: { ok, cell: ok ? 'ok' : 'FAIL: x', problems: ok ? [] : ['x'] }, run: { started, finished: started + s * 1000, result: { result: 'done' } },
      agentConfig: core === undefined ? { surface: 'sleight' } : { surface: 'sleight', abFlags: { SLEIGHT_TS3: false, SLEIGHT_FS: false, SLEIGHT_BROWSER_CORE: core } } };
  });
  writeFileSync(join(dir, 'results.json'), JSON.stringify(rows));
  return dir;
}

test('the scorer reads each round\'s side from its rows and applies the bar per browser', () => {
  const root = mkdtempSync(join(tmpdir(), 'as3-score-'));
  try {
    const base = { 'smoke-red': 20, 'survey-p09': 80, 'signup-p05': 90 };
    const faster = { 'smoke-red': 10, 'survey-p09': 60, 'signup-p05': 70 };
    const dirs = [
      fakeRound(root, 'as3-safari-off-r1', { core: false, seconds: base }),
      fakeRound(root, 'as3-safari-on-r1', { core: true, seconds: faster }),
      fakeRound(root, 'as3-safari-off-r2', { core: false, seconds: base }),
      fakeRound(root, 'as3-safari-on-r2', { core: true, seconds: faster }),
      fakeRound(root, 'as3-firefox-off-r1', { browser: 'firefox', core: false, seconds: base }),
      fakeRound(root, 'as3-firefox-on-r1', { browser: 'firefox', core: true, seconds: { ...faster, 'survey-p09': 79 }, failed: ['signup-p05'],
        errors: { 'survey-p09': 'browser_open: the front window has no tab strip.' } }),
      fakeRound(root, 'as3-firefox-on-r9', { browser: 'firefox', seconds: faster }),
    ];
    const rounds = dirs.map(dir => loadAbRound(dir));
    assert.equal(rounds.at(-1).excluded, 'SLEIGHT_BROWSER_CORE not recorded (build without the AS-3 plumbing)');
    assert.deepEqual(rounds.slice(0, -1).map(r => r.side), ['off', 'on', 'off', 'on', 'off', 'on']);
    const scored = scoreAb(rounds);
    const safari = scored.browsers.safari;
    assert.equal(safari.off.medianRoundS, 190); assert.equal(safari.on.medianRoundS, 140); assert.equal(safari.saving, 50);
    assert.deepEqual(safari.on.adoption, { tasks: 6, of: 6, calls: 6, errors: 0 });
    assert.equal(safari.off.adoption.calls, 0);
    assert.equal(safari.pass, true, safari.problems.join('; '));
    const firefox = scored.browsers.firefox;
    assert.equal(firefox.saving, 31);
    assert.deepEqual(firefox.lost, ['signup-p05']);
    assert.deepEqual(firefox.newKinds, ['browser_open']);
    assert.equal(firefox.pass, false);
    assert.equal(scored.defaultOn, false);
    // The bar's saving threshold, with nothing else wrong.
    assert.equal(safari.barS, 2.5, 'AO7 scores the opening median per task');
    assert.equal(safari.taskSaving, 50);
    assert.equal(safari.callSaving, 3, 'one call fewer in each of three tasks');
    const slow = scoreAb([loadAbRound(dirs[0]), loadAbRound(fakeRound(root, 'as3-safari-on-r5', { core: true, opens: false, seconds: { ...base, 'smoke-red': 15 } }))]);
    assert.equal(slow.browsers.safari.saving, 5);
    assert.ok(slow.browsers.safari.problems.some(p => /opening median saving/.test(p)));
    assert.ok(slow.browsers.safari.problems.some(p => /adoption/.test(p)));
    const cli = spawnSync(process.execPath, [join(repo, 'bench/fowl/as3-score.mjs'), join(root, 'as3-*')], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /as3-firefox-on-r9 \(firefox, side unknown, .*excluded, SLEIGHT_BROWSER_CORE not recorded/);
    assert.match(cli.stdout, /browser_open on the on side: 6 of 9 tasks, 6 calls, 0 errors/);
    assert.match(cli.stdout, /^smoke-red +1\/1 20\.0 s 3 calls +1\/1 10\.0 s 2 calls$/m);
    assert.match(cli.stdout, /bar: not met \(lost signup-p05; new error kind "browser_open"\)/);
    assert.match(cli.stdout, /Default-on: no$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scorer helpers: side, browser_open use and error kinds', () => {
  assert.equal(roundSide([{ agentConfig: { abFlags: { SLEIGHT_BROWSER_CORE: true } } }]), 'on');
  assert.deepEqual(roundSide([{ agentConfig: { abFlags: { SLEIGHT_BROWSER_CORE: true } } }, { agentConfig: { abFlags: { SLEIGHT_BROWSER_CORE: false } } }]),
    { problem: 'rows disagree on SLEIGHT_BROWSER_CORE' });
  assert.deepEqual(roundSide([]), { problem: 'no saved rows' });
  assert.deepEqual(browserOpenUse([call('a', 'mcp__plugin_sleight_computer__browser_open', true, 'browser_open: no'), call('b', 'mcp__plugin_sleight_computer__js', true, 'x')].join('\n')), { calls: 1, errors: 1 });
  assert.equal(errorKind('Flow rules: blocked 3 times. Stop.'), 'Flow rules');
  assert.equal(errorKind('Input lease stopped this action 12 times "x"'), 'Input lease stopped this action');
  assert.equal(errorKind('Waited 1500 ms for the page'), errorKind('Waited 900 ms for the page'));
});


test('AO6: product-on and prompt-on are separate engine cells; other arms keep their prompt', () => {
  const setup = vars => withEnv(vars, () => realAgentSetup({ task: heldOut[0], surface: 'sleight', dir: `${MAC_TMP}/as3-task`, realBrowser: browsers.safari, dryRun: true }));
  const off = setup({ SLEIGHT_BROWSER_CORE: '0', AS3_WINDOW_PROMPT: '1' });
  const product = setup({ SLEIGHT_BROWSER_CORE: '1', AS3_WINDOW_PROMPT: '0' });
  const prompted = setup({ SLEIGHT_BROWSER_CORE: '1', AS3_WINDOW_PROMPT: '1' });
  assert.equal(off.metadata.as3WindowPrompt, false);
  assert.equal(product.metadata.as3WindowPrompt, false);
  assert.equal(prompted.metadata.as3WindowPrompt, true);
  const sentence = 'browser_open opens the page in a new tab of that window and returns its title and tabs, which is the check.';
  assert.ok(prompted.prompt.includes(sentence));
  assert.ok(!product.prompt.includes(sentence) && !off.prompt.includes(sentence));
  assert.equal(prompted.prompt.replace(sentence + ' ', ''), product.prompt);
  assert.equal(roundSide([{ agentConfig: { abFlags: { SLEIGHT_BROWSER_CORE: true }, as3WindowPrompt: true } }]), 'on-prompt');
});

test('AO7: opening phase counts calls to the first local page result, excluding gate trees and errors', async () => {
  const { openingPhase } = await import('../bench/fowl/as3-score.mjs');
  const events = [
    { t: 1000, type: 'system' },
    { t: 2000, message: { content: [{ type: 'tool_use', id: 'a' }] } },
    { t: 3000, message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Window: \"Sleight Gate abcd\", App: Safari.\n0 standard window\n1 HTML content URL: 127.0.0.1:5420/t/gate/' }] } },
    { t: 4000, message: { content: [{ type: 'tool_use', id: 'b' }] } },
    { t: 4500, message: { content: [{ type: 'tool_result', is_error: true, content: 'Window: Shop\nURL: 127.0.0.1:5420/t/x/' }] } },
    { t: 5000, message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'Window: \"Shop\", App: Safari.\n0 standard window\n1 HTML content URL: http://127.0.0.1:5420/t/x/shop/' }] }] } },
  ];
  const text = events.map(JSON.stringify).join('\n');
  assert.deepEqual(openingPhase(text, 500), { seconds: 4.5, calls: 2 });
  assert.deepEqual(openingPhase(text), { seconds: 4, calls: 2 });
  assert.equal(openingPhase(events.slice(0, 3).map(JSON.stringify).join('\n')), null);
  assert.equal(openingPhase(text.replaceAll('5420', '5531')), null);
  assert.equal(openingPhase(text.replaceAll('"t":', '"noClock":')), null);
  const dated = events.map(e => ({ ...e, t: undefined, timestamp: new Date(e.t).toISOString() })).map(JSON.stringify).join('\n');
  assert.deepEqual(openingPhase(dated, 500), { seconds: 4.5, calls: 2 });
  const joined = structuredClone(events);
  joined.at(-1).message.content[0].content[0].text = 'Window: "Sleight Gate other", App: Safari.\n0 standard window\n' + joined.at(-1).message.content[0].content[0].text;
  assert.deepEqual(openingPhase(joined.map(JSON.stringify).join('\n'), 500), { seconds: 4.5, calls: 2 });
});

test('AO7: default-on needs five product rounds per browser, page proof, adoption and whole-task guards', () => {
  const rounds = (browser, side, n = 5) => Array.from({ length: n }, (_, i) => ({
    name: `${browser}-${side}-${i}`, browser, side, commits: { build: { commit: '4fc88abc' } }, engine: { version: 'fixture' },
    rows: ['a', 'b'].map(task => ({ task, seconds: side === 'off' ? 20 : 16, passed: true, kinds: [], calls: 3,
      browserOpen: { calls: side === 'off' ? 0 : 1, errors: 0 }, opening: { seconds: side === 'off' ? 10 : 6, calls: side === 'off' ? 3 : 1 } })),
  }));
  const complete = ['safari', 'firefox'].flatMap(b => [...rounds(b, 'off'), ...rounds(b, 'on')]);
  assert.equal(scoreAb(complete).defaultOn, true);
  assert.equal(scoreAb(complete.slice(1)).defaultOn, false);
  const promptOnly = ['safari', 'firefox'].flatMap(b => [...rounds(b, 'off'), ...rounds(b, 'on-prompt')]);
  const prompted = scoreAb(promptOnly);
  assert.equal(prompted.defaultOn, false);
  assert.equal(prompted.browsers.safari.prompt.pass, true);
  for (const mutate of [
    r => { r.rows[0].opening = null; },
    r => { r.rows.forEach(row => { row.browserOpen.calls = 0; }); },
    r => { r.rows[0].passed = false; },
    r => { r.rows[0].seconds = 80; },
  ]) {
    const copy = structuredClone(complete);
    copy.filter(r => r.side === 'on' && r.browser === 'safari').forEach(mutate);
    assert.equal(scoreAb(copy).defaultOn, false);
  }
  const incomplete = structuredClone(complete);
  incomplete.filter(r => r.side === 'off' && r.browser === 'safari').forEach(r => { r.rows.pop(); r.rows[0].seconds = 40; });
  assert.equal(scoreAb(incomplete).browsers.safari.pass, false, 'unmatched task coverage cannot meet the bar');
});

test('the AO held-out set has five tasks, fresh shop slugs and no signup', () => {
  assert.deepEqual(heldOut.map(t => t.name), ['smoke-red', 'survey-p09', 'survey-p10', 'ao-moss-color', 'ao-cheapest-mug']);
  const lookups = heldOut.slice(3);
  for (const task of lookups) { assert.equal(task.needsClicks, false); assert.equal(task.expect.length, 2); assert.ok(task.site.expect.length); }
  assert.match(lookups[0].prompt, /t\/ao-moss-color\/shop\/product\/moss/);
  assert.match(lookups[1].prompt, /t\/ao-cheapest-mug\/shop\//);
  assert.ok(heldOut.every(t => !/signup|create account/i.test(t.prompt)));
  const price = new RegExp(lookups[1].expect[1]);
  for (const answer of ['Chalk $11', 'Chalk 11.00', 'Chalk costs $11.', 'Chalk costs $11.00.']) assert.match(answer, price);
  for (const answer of ['Chalk $211', 'Chalk 111.00', 'Chalk $11.99']) assert.doesNotMatch(answer, price);
  assert.match(read('bench/fowl/as3-ab.command'), /out=\$O\/as3-ao-/);
  assert.match(read('bench/fowl/as3-ab.command'), /\"\$O\/as3-ao-\*\"/);
});
