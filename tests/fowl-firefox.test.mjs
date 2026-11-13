import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realBrowserPlan, launchRealBrowser, resetRealBrowser, observeRealBrowser, checkBrowserOwner } from '../bench/fowl/real-browser.mjs';
import { realGatePlan, runRealGate } from '../bench/fowl/real-gate.mjs';
import { gradeGateTask } from '../bench/fowl/real-gate-grade.mjs';
import { taskSupport } from '../bench/fowl/support.mjs';
import { answer, gateWindowCheck } from '../bench/fowl/origin-hook.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const task = { name: 'fixture', browser: 'chrome', prompt: 'Visit the fixture in {browser}.', result: 'the answer' };
const session = tabs => ({ windows: [{ tabs: tabs.map(([url, title]) => ({ index: 1, entries: [{ url, title }] })) }] });
// Literal-only LZ4 block, independent of the decoder under test.
function encoded(value) {
  const bytes = Buffer.from(JSON.stringify(value)), length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
  const extra = []; let left = bytes.length - 15;
  if (left >= 0) { while (left >= 255) { extra.push(255); left -= 255; } extra.push(left); }
  return Buffer.concat([Buffer.from('mozLz40\0'), length, Buffer.from([Math.min(bytes.length, 15) << 4, ...extra]), bytes]);
}
function fixture(t) {
  const plan = realBrowserPlan({ browser: 'firefox', round: 'test-' + randomUUID() });
  t.after(() => rmSync(dirname(plan.profileRoot), { recursive: true, force: true }));
  // Fake LaunchServices launches: each "process" is a ps row with our profile argv.
  // emit('close') stands for the pid leaving the process table; launchd reaps it.
  const children = [], requests = [], signals = [], strays = [], launches = [];
  let current;
  const process_ = (pid, startedMs, args = [plan.executable, ...plan.args].join(' ')) => {
    const child = new EventEmitter(); Object.assign(child, { pid, startedMs, args });
    child.once('close', () => { child.closed = true; });
    child.kill = () => setImmediate(() => child.emit('close'));
    return child;
  };
  const openBrowser = async (command, args) => {
    assert.equal(command, '/usr/bin/open');
    assert.deepEqual(args.slice(0, 8), ['-n', '-g', '-a', '/Applications/Firefox.app', '--env', 'MOZ_CRASHREPORTER_DISABLE=1', '--args', '-profile']);
    assert.deepEqual(args.slice(7), plan.args);
    assert.ok(!existsSync(join(plan.profileRoot, 'old-task')));
    assert.match(readFileSync(join(plan.profileRoot, 'user.js'), 'utf8'), /browser.sessionstore.resume_from_crash", false/);
    launches.push(args);
    current = process_(4000 + children.length, Date.now()); children.push(current);
    mkdirSync(join(plan.profileRoot, 'sessionstore-backups'), { recursive: true });
    writeFileSync(join(plan.profileRoot, 'sessionstore-backups/recovery.jsonlz4'), encoded(session([[plan.args.at(-1), plan.marker]])));
    return current;
  };
  const live = () => [...children, ...strays].filter(child => !child.closed);
  const options = { openBrowser, stopMs: 5, quitMs: 5, timeoutMs: 100,
    listProcesses: async () => live().filter(child => child.args.startsWith(plan.executable)).map(child => ({ pid: child.pid, ppid: 1, pgid: child.pid, executable: plan.executable })),
    listArguments: async () => live().map(({ pid, startedMs, args }) => ({ pid, startedMs, args })),
    signalProcess: (pid, signal) => {
      const child = live().find(child => child.pid === pid);
      assert.ok(child, 'signals only a live verified pid'); signals.push(signal); child.kill(signal);
    },
    quitBrowser: async browser => {
      requests.push(browser.pid);
      for (const name of ['sessionstore.jsonlz4']) {
        const file = join(plan.profileRoot, name);
        // Stamp the rewrite with Date.now(): Linux file times come from the kernel's coarse clock and can trail it by a tick.
        if (existsSync(file)) { writeFileSync(file, readFileSync(file)); const now = new Date(); utimesSync(file, now, now); }
      }
      setImmediate(() => current.emit('close'));
    } };
  return { plan, options, children, requests, signals, strays, launches, process: process_, current: () => current };
}

test('Firefox plans a fresh visible profile without CDP and names the installed executable', () => {
  const plan = realBrowserPlan({ browser: 'firefox', round: 'fixture-firefox' });
  assert.equal(plan.executable, '/Applications/Firefox.app/Contents/MacOS/firefox');
  assert.equal(plan.command, '/usr/bin/open');
  assert.deepEqual(plan.launchArgs, ['-n', '-g', '-a', '/Applications/Firefox.app', '--env', 'MOZ_CRASHREPORTER_DISABLE=1', '--args', ...plan.args]);
  assert.equal(plan.launchMode, 'LaunchServices-open-new-instance');
  assert.deepEqual(plan.args.slice(0, 4), ['-profile', plan.profileRoot, '-no-remote', '-new-instance']);
  assert.equal(plan.connectionMode, 'engine-computer');
  assert.equal(plan.version, '157');
  assert.ok(!plan.args.some(arg => /debugging|headless/.test(arg)));
  assert.match(decodeURIComponent(plan.args.at(-1)), /Sleight Gate fixture-firefox/);
});

test('Firefox owner census refuses an external process but accepts owned ancestry', async () => {
  const plan = realBrowserPlan({ browser: 'firefox', round: 'fixture-census' });
  const rows = [{ pid: 40, ppid: 1, executable: plan.executable }, { pid: 41, ppid: 40, executable: 'firefox' }];
  await assert.rejects(checkBrowserOwner(plan, { listProcesses: async () => rows }), /Quit firefox/);
  assert.equal((await checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => rows })).ok, true);
  await assert.rejects(checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => [...rows, { pid: 42, ppid: 1, executable: 'firefox' }] }), /PID 42/);
});

test('Firefox launches with offline prefs, relaunches a clean profile, and inventories after graceful quit', async t => {
  // A graceful quit ends the wait as soon as the fake exits. 5 ms lost to node --test's own reporter work on Linux,
  // which ran 10 to 13 ms ahead of the fake's setImmediate exit (2026-10-19).
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options, quitMs: 1000 });
  assert.equal(browser.pid, 4000);
  const prefs = readFileSync(join(f.plan.profileRoot, 'user.js'), 'utf8');
  for (const key of ['browser.shell.checkDefaultBrowser', 'toolkit.telemetry.enabled', 'app.update.staging.enabled', 'browser.sessionstore.resume_from_crash'])
    assert.ok(prefs.includes(`user_pref("${key}", false)`), key);
  assert.ok(prefs.includes('user_pref("app.update.interval", 2147483647)'));
  writeFileSync(join(f.plan.profileRoot, 'old-task'), 'must not survive');
  const start = await resetRealBrowser(browser);
  assert.equal(browser.pid, 4001);
  assert.equal(Object.values(start)[0].title, f.plan.marker);
  writeFileSync(join(f.plan.profileRoot, 'sessionstore.jsonlz4'), encoded(session([['http://127.0.0.1:5420/checkout/signin', 'Sign in']])));
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, true);
  assert.match(observed.source, /sessionstore.jsonlz4$/);
  assert.equal(Object.values(observed.tabs)[0].url, 'http://127.0.0.1:5420/checkout/signin');
  assert.equal(browser.pid, undefined);
  assert.deepEqual(f.requests, [4000, 4001]);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(await browser.stop(), { browserClosed: true, profileDeleted: true });
  assert.equal(existsSync(f.plan.profileRoot), false);
});

test('a missing sessionstore is unobserved, and forced collection never certifies an inventory', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options, quitBrowser: async () => {} });
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false);
  assert.match(observed.reason, /graceful/i);
  assert.ok(observed.unavailableGraders.includes('handoff'));
  assert.deepEqual(f.signals, ['SIGTERM']);
  await browser.stop();
  const g = fixture(t), other = await launchRealBrowser(g.plan, g.options);
  rmSync(join(g.plan.profileRoot, 'sessionstore-backups'), { recursive: true });
  const absent = await observeRealBrowser(other);
  assert.equal(absent.observed, false);
  assert.match(absent.reason, /sessionstore/i);
  await other.stop();
});

test('an uncollected Firefox retains its profile and blocks relaunch', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options, quitBrowser: async () => {} });
  f.current().kill = () => {};
  await assert.rejects(resetRealBrowser(browser), /CLEANUP_UNPROVED/);
  assert.equal(f.children.length, 1);
  assert.equal(existsSync(f.plan.profileRoot), true);
  f.current().emit('close', 0, null);
});

test('a graceful quit with only a stale recovery file cannot certify the after-task pages', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options,
    quitBrowser: async () => { setImmediate(() => f.current().emit('close', 0, null)); } });
  const file = join(f.plan.profileRoot, 'sessionstore-backups/recovery.jsonlz4');
  utimesSync(file, new Date(0), new Date(0));
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false);
  assert.match(observed.reason, /MISSING/i);
  await browser.stop();
});

test('Firefox observation refuses sessionstore paths escaping the owned profile', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options,
    quitBrowser: async () => { setImmediate(() => f.current().emit('close', 0, null)); } });
  const outside = mkdtempSync(join(tmpdir(), 'br2a-session-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'sessionstore.jsonlz4'), encoded(session([['outside', 'not ours']])));
  rmSync(join(f.plan.profileRoot, 'sessionstore-backups'), { recursive: true });
  symlinkSync(join(outside, 'sessionstore.jsonlz4'), join(f.plan.profileRoot, 'sessionstore.jsonlz4'));
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false);
  assert.match(observed.reason, /SESSIONSTORE_INVALID/);
  await browser.stop();
  assert.equal(existsSync(join(outside, 'sessionstore.jsonlz4')), true);
});

test('a Firefox startup timeout collects its child and removes its private bank', async t => {
  const f = fixture(t);
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options, timeoutMs: 1, openBrowser: async (...args) => {
    const child = await f.options.openBrowser(...args);
    rmSync(join(f.plan.profileRoot, 'sessionstore-backups'), { recursive: true });
    return child;
  } }), /START_FAILED/);
  assert.deepEqual(f.requests, [4000]);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('Firefox rechecks for newly arrived owners before relaunching and collects only its own bank', async t => {
  const f = fixture(t); let occupied = false;
  const browser = await launchRealBrowser(f.plan, { ...f.options, listProcesses: async () => occupied
    ? [{ pid: 999, ppid: 1, executable: 'firefox' }] : await f.options.listProcesses() });
  occupied = true;
  await assert.rejects(resetRealBrowser(browser), /PID 999/);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.requests, [4000]);
  await browser.stop();
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('Firefox repeats admission after helper preparation and preserves a newly arrived owner refusal', async t => {
  const f = fixture(t); let checks = 0;
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options, listProcesses: async () => ++checks === 1
    ? [] : [{ pid: 999, ppid: 1, executable: 'firefox' }] }), error => {
    assert.match(error.message, /PID 999/);
    assert.equal(error.ownerCheck.ok, false);
    assert.deepEqual(error.ownerCheck.otherPids, [999]);
    return true;
  });
  assert.equal(f.children.length, 0);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('mozlz4 decoding handles literal lengths, overlapping matches, active history and closed tabs', async () => {
  const { decodeMozLz4, firefoxTabs } = await import('../bench/fowl/firefox-browser.mjs');
  const value = { text: 'x'.repeat(600) };
  assert.deepEqual(decodeMozLz4(encoded(value)), value);
  // {"a":"aaaaaa"}: 7 literals, a 5-byte overlapping match, then 2 literals.
  const header = Buffer.alloc(4); header.writeUInt32LE(14);
  const matched = Buffer.concat([Buffer.from('mozLz40\0'), header, Buffer.from([0x71]), Buffer.from('{"a":"a'), Buffer.from([1, 0, 0x20]), Buffer.from('"}')]);
  assert.deepEqual(decodeMozLz4(matched), { a: 'aaaaaa' });
  const state = { windows: [{ tabs: [{ index: 2, entries: [{ url: 'old' }, { url: 'new', title: 'Current' }] }], _closedTabs: [{ state: { entries: [{ url: 'closed' }] } }] }], _closedWindows: [{ tabs: [] }] };
  assert.deepEqual(Object.values(firefoxTabs(state)), [{ url: 'new', title: 'Current', initialUrl: 'old' }]);
  for (const bad of [Buffer.from('not lz4'), encoded(value).subarray(0, 14), Buffer.concat([Buffer.from('mozLz40\0'), Buffer.from([255, 255, 255, 127]), Buffer.from([0])])])
    assert.throws(() => decodeMozLz4(bad), /SESSIONSTORE/);
  assert.throws(() => firefoxTabs({ windows: [{ tabs: [{ index: 2, entries: [{ url: 'x' }] }] }] }), /SESSIONSTORE/);
});

test('Firefox dry plans choose plain sleight and explicitly exclude mobile and takeover for every arm', t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2a-plan-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const armHome = join(dir, 'arms'); mkdirSync(join(armHome, 'lcu-arm'), { recursive: true });
  writeFileSync(join(armHome, 'lcu-arm/.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  const tasks = [task, { ...task, name: 'mobile', viewport: { maxWidth: 600 } }, { ...task, name: 'takeover', takeover: { afterViews: 4 } }];
  for (const surface of [undefined, 'sleight', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const plan = realGatePlan({ args: { 'real-browser': 'firefox', surface, out: join(dir, 'never') }, tasks, armHome, round: 'fixture-plan' });
    assert.equal(plan.arms.length, 1);
    assert.match(plan.arms[0].prompt, /dedicated Firefox window/);
    assert.match(plan.arms[0].prompt, /Visit the fixture in Firefox/);
    assert.deepEqual(plan.unsupported.map(row => row.task.name), ['mobile', 'takeover']);
    if (!surface || surface === 'sleight') {
      const arm = plan.arms[0];
      assert.equal(plan.surface, 'sleight');
      assert.deepEqual(Object.keys(arm.mcpConfig.mcpServers), ['plugin:sleight:computer']);
      assert.equal(arm.mcpConfig.mcpServers['plugin:sleight:computer'].env.SLEIGHT_SURFACES, 'computer');
      assert.equal(arm.mcpConfig.mcpServers['plugin:sleight:computer'].env.SLEIGHT_TURBO, '0');
      assert.equal(arm.env.SLEIGHT_TURBO, '0');
      assert.ok(arm.args.includes('--plugin-dir'));
      const pre = arm.settingsOverrides.hooks.PreToolUse;
      assert.deepEqual(pre.map(h => h.matcher), ['mcp__plugin_sleight_computer__select_window']);
      assert.match(pre[0].hooks[0].command, /origin-hook/);
      const gate = JSON.parse(arm.env.FOWL_GATE_WINDOW);
      assert.deepEqual(gate, { apps: ['Firefox', 'org.mozilla.firefox', '/Applications/Firefox.app'], title: 'Sleight Gate fixture-plan' });
      assert.match(arm.settingsOverrides.hooks.Elicitation[0].hooks[0].command, /origin-hook/);
      assert.equal(arm.metadata.connectionMode, 'engine-computer');
    }
  }
  assert.equal(existsSync(join(dir, 'never')), false);
  assert.throws(() => realGatePlan({ args: { 'real-browser': 'firefox', surface: 'sleight-turbo' }, tasks: [task] }), /turbo/i);
  assert.equal(taskSupport(task, 'sleight', { realBrowser: 'firefox' }), null);
  assert.match(taskSupport(tasks[1], 'sleight', { realBrowser: 'firefox' }), /viewport/i);
  assert.equal(answer({ mcp_server_name: 'plugin:sleight:computer', message: 'Allow Computer Use to use "Firefox"?' }), 'accept');
});

// Real round 2026-10-17: five tasks stopped on "The user didn't allow window selection in Firefox".
test('window selection is accepted only for the gate browser and only with the exact marker title', () => {
  const env = { FOWL_GATE_WINDOW: JSON.stringify({ apps: ['Firefox', 'org.mozilla.firefox', '/Applications/Firefox.app'], title: 'Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971' }) };
  const ask = app => ({ mcp_server_name: 'plugin:sleight:computer', message: `Allow Claude to select a window in ${app}? It changes the app's main window without activating the app.` });
  for (const app of ['Firefox', 'org.mozilla.firefox', '/Applications/Firefox.app']) assert.equal(answer(ask(app), env), 'accept');
  for (const app of ['Safari', 'Google Chrome', 'Finder']) assert.equal(answer(ask(app), env), 'decline');
  assert.equal(answer(ask('Firefox'), {}), 'decline', 'other rounds keep declining');
  assert.equal(answer({ ...ask('Firefox'), mcp_server_name: 'other' }, env), 'decline');
  assert.equal(answer({ mcp_server_name: 'plugin:sleight:computer', message: "Allow Claude to drag in Firefox? Background comes first; foreground fallback can move your pointer for a few seconds." }, env), 'accept', 'the owner allowed drag in away gate rounds');
  const call = input => gateWindowCheck({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_sleight_computer__select_window', tool_input: input }, env);
  assert.equal(call({ app: 'Firefox', title: 'Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971' }), null);
  assert.equal(call({ app: 'org.mozilla.firefox', title: 'Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971' }), null);
  // Safari with a profile titles the window "<profile> — <title>" (b7 r1 shipping-link, 2026-10-19: two refused calls).
  assert.equal(call({ app: 'Firefox', title: 'sleight benchmark — Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971' }), null);
  for (const title of ['sleight benchmark Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971', 'x — Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe970',
    'x — Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971 — y', ' — Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971'])
    assert.match(call({ app: 'Firefox', title }), /only for the gate's own window/, title);
  for (const input of [{ app: 'Firefox', title: 'Mozilla Firefox' }, { app: 'Firefox', title: 'Sleight Gate c1c0b0b2' },
    { app: 'Safari', title: 'Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971' },
    { app: 'Firefox', title: 'Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971', windowNumber: 7 },
    { app: 'Firefox', url: 'file:///tmp/x' }]) assert.match(call(input), /only for the gate's own window/);
  assert.match(gateWindowCheck({ tool_name: 'mcp__plugin_sleight_computer__select_window', tool_input: { app: 'Firefox', title: 'Sleight Gate c1c0b0b2-e352-4977-be8a-7b93ec6fe971' } }, {}), /only for the gate's own window/);
  assert.equal(gateWindowCheck({ tool_name: 'mcp__plugin_sleight_computer__js', tool_input: {} }, env), null);
  for (const bad of ['not json', JSON.stringify({ apps: [], title: 'Sleight Gate abcdefgh' }), JSON.stringify({ apps: ['Firefox'], title: 'Mozilla Firefox' })])
    assert.equal(answer(ask('Firefox'), { FOWL_GATE_WINDOW: bad }), 'decline');
});

test('the select_window guard runs as a hook process and denies with PreToolUse output', () => {
  const run = (input, env) => spawnSync(process.execPath, [join(repo, 'bench/fowl/origin-hook.mjs')], { input: JSON.stringify(input), encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const env = { FOWL_GATE_WINDOW: JSON.stringify({ apps: ['Firefox'], title: 'Sleight Gate fixture-plan' }) };
  const base = { hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_sleight_computer__select_window' };
  const allowed = run({ ...base, tool_input: { app: 'Firefox', title: 'Sleight Gate fixture-plan' } }, env);
  assert.equal(allowed.status, 0); assert.equal(allowed.stdout, '');
  const denied = run({ ...base, tool_input: { app: 'Firefox', title: 'Other' } }, env);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('Firefox CLI dry plans enumerate all pinned tasks for all five arms without runtime side effects', t => {
  const tasks = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/tools/agents/codex-h2h.json');
  if (!existsSync(tasks)) return t.skip('pinned FowlBrowser cache is absent');
  const home = mkdtempSync(join(tmpdir(), 'br2a-cli-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const lcu = join(home, 'Library/Caches/sleight-bench/lcu-arm'); mkdirSync(lcu, { recursive: true });
  writeFileSync(join(lcu, '.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  for (const surface of ['sleight', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const out = join(home, 'never', surface);
    const result = spawnSync(process.execPath, [join(repo, 'bench/fowl/real-gate.mjs'), '--real-browser', 'firefox',
      '--dry-run', '--surface', surface, '--tasks', tasks, '--out', out],
    { encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH }, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.arms.length, 12);
    assert.deepEqual(plan.unsupported.map(row => row.task.name), ['mobile', 'takeover']);
    assert.equal(plan.browser.connectionMode, 'engine-computer');
    if (['lcu', 'cua', 'peekaboo'].includes(surface)) {
      assert.equal(plan.arms[0].environment.BENCH_SUITE, 'browser-race');
      assert.deepEqual(JSON.parse(plan.arms[0].environment.BENCH_RACE_APPS).slice(0, 2), ['Firefox', 'org.mozilla.firefox']);
    }
    if (surface === 'codex') assert.deepEqual(plan.armPrep.approvals, ['org.mozilla.firefox', 'com.apple.Preview', 'com.apple.TextEdit']);
    if (surface === 'cua') assert.ok(plan.armPrep.cuaDaemon.includes('serve'));
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(plan.browser.profileRoot), false);
    assert.equal(existsSync(join(home, '.config')), false);
  }
});

test('unobserved Firefox inventory runs answer/site grading but cannot pass handoff or retention', () => {
  let observed;
  const runner = { gradeOutcome: input => { observed = input.observed; return { problems: [] }; }, gradeSite: () => ({ problems: [] }),
    gradeHandoff: () => assert.fail('no page inventory for handoff') };
  const input = { task, run: { exitCode: 0, result: { result: 'RESULT: fixture' } }, runner,
    after: {}, observed: false, observationReason: 'sessionstore absent', startKeys: new Set() };
  assert.equal(gradeGateTask(input).ok, true);
  assert.equal(observed, false);
  for (const extra of [{ handoff: { url: '/signin' } }, { keepMin: 1 }, { keep: ['/signin'] }]) {
    const grade = gradeGateTask({ ...input, task: { ...task, ...extra } });
    assert.equal(grade.ok, false); assert.match(grade.problems.join(' '), /unobserved.*sessionstore absent/i);
  }
});

test('Firefox lifecycle rebuilds each arm with the relaunched PID and records unobserved metadata', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2a-gate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = [], lockPath = join(dir, 'lock'); let pid = 40, serial = 40;
  const rows = await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out: join(dir, 'out') }, tasks: [task, { ...task, name: 'second' }],
    runner: { gradeOutcome: input => { assert.equal(input.observed, false); return { problems: [] }; }, gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath, admit: async () => {}, startSites: async () => ({ close: async () => events.push('sites closed') }),
      launchBrowser: async plan => ({ ...plan, get pid() { return pid; }, stop: async () => { events.push('browser closed'); return { browserClosed: true }; } }),
      checkOwner: async (_browser, options) => { events.push(['census', options.ownedPid]); return { ok: true }; },
      resetBrowser: async () => { pid = ++serial; return {}; },
      runAgent: async arm => { assert.match(arm.prompt, new RegExp('PID ' + pid)); mkdirSync(arm.dir); return { groupClean: true, exitCode: 0, result: { result: 'RESULT: fixture' } }; },
      observeBrowser: async () => { pid = undefined; return { observed: false, tabs: {}, reason: 'fixture unavailable', unavailableGraders: ['handoff'] }; } } });
  assert.equal(rows.length, 2); assert.equal(rows[0].observation.observed, false);
  assert.deepEqual(events, [['census', 41], ['census', 42], 'sites closed', 'browser closed']);
  assert.equal(existsSync(lockPath), false);
});

test('a refusal during Firefox reset replaces the successful pre-task census receipt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2a-refusal-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'out'), lockPath = join(dir, 'lock'); let stopped = false;
  const ownerCheck = { ok: false, otherPids: [999], error: 'new owner' };
  await assert.rejects(runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out }, tasks: [task],
    runtime: { lockPath, admit: async () => {}, startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => ({ ...plan, pid: 40, stop: async () => { stopped = true; return { browserClosed: true }; } }),
      checkOwner: async () => ({ ok: true }),
      resetBrowser: async () => { throw Object.assign(Error('new owner'), { ownerCheck }); },
      runAgent: () => assert.fail('must not start an arm after an owner refusal') } }), /new owner/);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'browser.json'), 'utf8')).ownerCheck, ownerCheck);
  assert.equal(stopped, true);
  assert.equal(existsSync(lockPath), false);
});

test('Firefox checks ownership with its live PID after readiness and again before observation', async t => {
  const f = fixture(t); let occupied = false, checks = 0;
  const browser = await launchRealBrowser(f.plan, { ...f.options, listProcesses: async () => {
    checks++;
    return [...await f.options.listProcesses(), ...(occupied ? [{ pid: 999, ppid: 1, executable: '(Firefox)' }] : [])];
  } });
  assert.equal(checks, 3);
  occupied = true;
  const observed = await browser.observe();
  assert.equal(observed.observed, false);
  assert.equal(observed.ownerCheck.ok, false);
  assert.deepEqual(observed.ownerCheck.otherPids, [999]);
  assert.match(observed.reason, /PID 999/);
  assert.deepEqual(f.requests, [4000]);
  await browser.stop();
});

test('an owner arriving during Firefox readiness refuses launch and collects only the launched child', async t => {
  const f = fixture(t);
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options, listProcesses: async () =>
    [...await f.options.listProcesses(), ...(f.children.length ? [{ pid: 999, ppid: 1, executable: 'firefox' }] : [])]
  }), error => { assert.deepEqual(error.ownerCheck.otherPids, [999]); return true; });
  assert.deepEqual(f.requests, [4000]);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('Firefox disables crash reporting and records top-level profile changes before and after collection', async t => {
  const f = fixture(t); let snapshot = 0;
  const browser = await launchRealBrowser(f.plan, { ...f.options, profileMetadata: () => ({
    support: [{ name: 'profiles.ini', mtimeMs: ++snapshot }], cache: []
  }) });
  assert.deepEqual(f.launches[0].slice(4, 6), ['--env', 'MOZ_CRASHREPORTER_DISABLE=1']);
  assert.match(readFileSync(join(f.plan.profileRoot, 'user.js'), 'utf8'), /block_toplevel_data_uri_navigations", false/);
  await browser.observe();
  assert.deepEqual(browser.profileAudit.before, { support: [{ name: 'profiles.ini', mtimeMs: 1 }], cache: [] });
  assert.deepEqual(browser.profileAudit.after, { support: [{ name: 'profiles.ini', mtimeMs: 2 }], cache: [] });
  assert.equal(browser.profileAudit.changed, true);
  await browser.stop();
});

test('Firefox profile metadata reads only names and mtimes at the two top levels', async t => {
  const { firefoxProfileMetadata } = await import('../bench/fowl/firefox-browser.mjs');
  const home = mkdtempSync(join(tmpdir(), 'br2c-metadata-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const support = join(home, 'Library/Application Support/Firefox'), cache = join(home, 'Library/Caches/Mozilla');
  mkdirSync(join(support, 'Profiles'), { recursive: true }); mkdirSync(cache, { recursive: true });
  writeFileSync(join(support, 'profiles.ini'), 'private content');
  writeFileSync(join(support, 'Profiles/hidden'), 'must not read');
  utimesSync(join(support, 'profiles.ini'), new Date(1000), new Date(1000));
  const value = firefoxProfileMetadata(home);
  assert.deepEqual(value[support].map(row => row.name), ['Profiles', 'profiles.ini']);
  assert.equal(value[support][1].mtimeMs, 1000);
  assert.deepEqual(value[cache], []);
});

test('Firefox waits the graceful quit budget before forcing and records helper refusal details', async t => {
  const f = fixture(t), began = Date.now();
  const browser = await launchRealBrowser(f.plan, { ...f.options, quitMs: 40,
    quitBrowser: async () => { throw Object.assign(Error('refused'), { code: 23, stderr: 'parent mismatch' }); } });
  const observed = await browser.observe();
  assert.equal(observed.observed, false);
  assert.ok(Date.now() - began >= 35);
  assert.deepEqual(browser.collections[0].quit.exitCode, 23);
  assert.equal(browser.collections[0].quit.stderr, 'parent mismatch');
  assert.ok(browser.collections[0].quit.durationMs >= 35);
  assert.deepEqual(f.signals, ['SIGTERM']);
  await browser.stop();
});

test('Firefox allows a slow graceful exit without SIGTERM and never observes recovery as final evidence', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options, quitMs: 80,
    quitBrowser: async () => { setTimeout(() => f.current().emit('close', 0, null), 25); } });
  const observed = await browser.observe();
  assert.equal(observed.observed, false);
  assert.match(observed.reason, /SESSIONSTORE_MISSING/);
  assert.deepEqual(f.signals, []);
  assert.ok(browser.collections[0].quit.durationMs >= 20);
  await browser.stop();
});

test('a fresh recovery file after graceful quit is still unobserved', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options, quitBrowser: async () => {
    writeFileSync(join(f.plan.profileRoot, 'sessionstore-backups/recovery.jsonlz4'), encoded(session([['https://example.test', 'Recovery']])));
    setImmediate(() => f.current().emit('close', 0, null));
  } });
  const observed = await browser.observe();
  assert.equal(observed.observed, false); assert.match(observed.reason, /SESSIONSTORE_MISSING/);
  await browser.stop();
});

test('Firefox quit invocation passes the exact pid, profile and start second, and preserves a real fake-helper refusal', async t => {
  const { requestFirefoxQuit } = await import('../bench/fowl/firefox-browser.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'br2c-quit-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = join(dir, 'refuse'), args = join(dir, 'args');
  writeFileSync(helper, '#!/bin/sh\nprintf "%s\\n" "$@" > "' + args + '"\nprintf "profile mismatch" >&2\nexit 23\n', { mode: 0o700 });
  await assert.rejects(requestFirefoxQuit(helper, { pid: 4000, executable: '/fixture/browser', profileRoot: '/fixture/profile dir', startedMs: 1792266481999 }), error => {
    assert.equal(error.code, 23); assert.equal(error.stderr, 'profile mismatch'); return true;
  });
  assert.deepEqual(readFileSync(args, 'utf8').trim().split('\n'), ['4000', '/fixture/browser', '/fixture/profile dir', '1792266481']);
});

test('Firefox startup restart quits the replacement on its profile and leaves other Firefox rows alone', async t => {
  const f = fixture(t);
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options, openBrowser: async (...args) => {
    const child = await f.options.openBrowser(...args);
    // After 4000 is adopted it exits and a replacement takes the profile.
    setTimeout(() => {
      f.strays.push(f.process(5000, Date.now()), f.process(5999, Date.now(), f.plan.executable + ' -profile /elsewhere'));
      child.emit('close');
    }, 20);
    rmSync(join(f.plan.profileRoot, 'sessionstore-backups'), { recursive: true }); return child;
  }, listProcesses: async () => f.children.length ? [] : await f.options.listProcesses(),
  quitBrowser: async browser => { f.requests.push(browser.pid); f.strays.find(row => row.pid === browser.pid)?.emit('close'); }
  }), /START_FAILED/);
  assert.deepEqual(f.requests, [5000]);
  assert.equal(f.strays[1].closed, undefined);
  assert.deepEqual(f.signals, []);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('Firefox adopts only one profile process started after the request and quits ambiguous ones', async t => {
  const f = fixture(t);
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options, openBrowser: async (...args) => {
    const child = await f.options.openBrowser(...args);
    f.strays.push(f.process(4900, Date.now() - 5000), f.process(5000, Date.now()));
    return child;
  }, listProcesses: async () => [], quitBrowser: async browser => {
    f.requests.push(browser.pid); [...f.children, ...f.strays].find(row => row.pid === browser.pid)?.emit('close');
  } }), /START_FAILED/);
  // 4900 predates the launch request, so it is never adopted or quit.
  assert.deepEqual(f.requests.sort(), [4000, 5000]);
  assert.equal(f.strays[0].closed, undefined);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('a failed LaunchServices open fails the start with its cause and adopts nothing', async t => {
  const f = fixture(t);
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options, openBrowser: async () => { throw Error('LSOpen -10810'); } }), error => {
    assert.equal(error.message, 'BENCH_BROWSER_START_FAILED'); assert.match(error.cause.message, /-10810/); return true;
  });
  assert.deepEqual(f.requests, []);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('Firefox treats a reused pid as closed and never signals it', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options, quitBrowser: async () => {} });
  f.current().startedMs += 60000;
  const observed = await browser.observe();
  assert.equal(observed.observed, false);
  assert.deepEqual(f.signals, []);
  assert.equal(browser.pid, undefined);
  await browser.stop();
});

test('ps argument rows parse start times and match only the exact profile pair', async () => {
  const { processArguments, ownsProfile } = await import('../bench/fowl/firefox-browser.mjs');
  const rows = await processArguments(), self = rows.find(row => row.pid === process.pid);
  assert.ok(self && Math.abs(self.startedMs - (Date.now() - process.uptime() * 1000)) < 5000);
  const plan = realBrowserPlan({ browser: 'firefox', round: 'fixture-owns' });
  const row = args => ({ args: args.join(' ') });
  assert.equal(ownsProfile(plan, row([plan.executable, ...plan.args])), true);
  assert.equal(ownsProfile(plan, row([plan.executable, '-profile', plan.profileRoot + '-other'])), false);
  assert.equal(ownsProfile(plan, row(['/usr/bin/open', '-n', '--args', '-profile', plan.profileRoot, 'x'])), false);
  assert.equal(ownsProfile(plan, row([plan.executable, '-P', 'default'])), false);
});

test('Firefox marker is excluded from retained tabs, including when sessionstore positions change', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2c-retention-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows = await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out: join(dir, 'out') }, tasks: [{ ...task, keepMin: 1 }],
    runner: { gradeOutcome: ({ run, startKeys }) => ({ problems: [...run.tabs].some(key => !startKeys.has(key)) ? [] : ['no retained task tabs'] }), gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath: join(dir, 'lock'), admit: async () => {}, startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => ({ ...plan, pid: 40, stop: async () => ({ browserClosed: true }) }),
      checkOwner: async () => ({ ok: true }), resetBrowser: async browser => ({ 'firefox:1:1': { url: browser.args.at(-1), title: browser.marker } }),
      runAgent: async arm => { mkdirSync(arm.dir); return { groupClean: true, exitCode: 0, result: { result: 'done' } }; },
      observeBrowser: async browser => ({ observed: true, tabs: { 'firefox:2:1': { url: browser.args.at(-1), title: browser.marker } } }) } });
  assert.equal(rows[0].outcome.ok, false);
  process.exitCode = 0;
});

for (const [name, size, data] of [
  ['offset past output', 6, [0x10, 0x7b, 2, 0]],
  ['match overruns declared output', 4, [0x10, 0x7b, 1, 0]],
  ['literal overruns input', 6, [0x60, 0x7b]],
  ['literal overruns output', 1, [0x20, 0x7b, 0x7d]],
  ['short output', 3, [0x20, 0x7b, 0x7d]],
]) test('mozlz4 rejects ' + name, async () => {
  const { decodeMozLz4 } = await import('../bench/fowl/firefox-browser.mjs');
  const length = Buffer.alloc(4); length.writeUInt32LE(size);
  assert.throws(() => decodeMozLz4(Buffer.concat([Buffer.from('mozLz40\0'), length, Buffer.from(data)])), /SESSIONSTORE_INVALID/);
});

test('an owner refusal at observation invalidates the row even for answer-only tasks and saves the quit receipt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2c-owner-row-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ownerCheck = { ok: false, otherPids: [999], error: 'PID 999 arrived' };
  const out = join(dir, 'out');
  const rows = await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out }, tasks: [task],
    runner: { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath: join(dir, 'lock'), admit: async () => {}, startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => ({ ...plan, pid: 40, collections: [], stop: async () => ({ browserClosed: true }) }),
      checkOwner: async () => ({ ok: true }), resetBrowser: async () => ({}),
      runAgent: async arm => { mkdirSync(arm.dir); return { groupClean: true, exitCode: 0, result: { result: 'done' } }; },
      observeBrowser: async browser => { browser.collections.push({ pid: 40, quit: { exitCode: 23, stderr: 'refused', durationMs: 30 } });
        return { observed: false, tabs: {}, reason: 'PID 999 arrived', ownerCheck }; } } });
  assert.equal(rows[0].outcome.ok, false);
  assert.match(rows[0].outcome.problems.join(' '), /PID 999/);
  const receipt = JSON.parse(readFileSync(join(out, 'browser.json'), 'utf8'));
  assert.deepEqual(receipt.ownerCheck, ownerCheck);
  assert.equal(receipt.collections[0].quit.exitCode, 23);
  process.exitCode = 0;
});

test('an uncollected startup replacement during reset retains the profile through stop', async t => {
  const f = fixture(t);
  const browser = await launchRealBrowser(f.plan, { ...f.options, openBrowser: async (...args) => {
    const child = await f.options.openBrowser(...args);
    if (f.children.length > 1) {
      rmSync(join(f.plan.profileRoot, 'sessionstore-backups'), { recursive: true });
      setTimeout(() => { f.strays.push(f.process(5000, Date.now())); child.emit('close'); }, 20);
    }
    return child;
  }, quitBrowser: async browser => {
    if (browser.pid === 5000) throw Object.assign(Error('parent mismatch'), { code: 23, stderr: 'not owned' });
    return f.options.quitBrowser(browser);
  } });
  await assert.rejects(browser.reset(), /CLEANUP_UNPROVED/);
  await assert.rejects(browser.stop(), /CLEANUP_UNPROVED/);
  assert.equal(existsSync(f.plan.profileRoot), true);
  assert.equal(browser.collections.at(-1).quit.exitCode, 23);
  assert.equal(browser.collections.at(-1).quit.stderr, 'not owned');
});

test('forced collection samples top-level metadata after the child has actually exited', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options, quitBrowser: async () => {},
    profileMetadata: () => ({ support: [{ name: f.signals.length ? 'after-forced-exit' : 'before', mtimeMs: 1 }] }) });
  await browser.observe();
  assert.deepEqual(browser.profileAudit.after.support, [{ name: 'after-forced-exit', mtimeMs: 1 }]);
  await browser.stop();
});

test('the compiled Firefox quit helper checks start time and the exact -profile pair before AppKit', async t => {
  const compiler = spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8', timeout: 5000 });
  if (compiler.status !== 0 || !existsSync(compiler.stdout.trim())) return t.skip('swiftc is unavailable; JS refusal path is covered');
  const dir = mkdtempSync(join(tmpdir(), 'br2c-swift-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = join(dir, 'quit-firefox');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
    join(repo, 'bench/fowl/firefox-quit.swift'), '-o', helper], { encoding: 'utf8', timeout: 60000 });
  assert.equal(built.status, 0, built.stderr);
  // A plain child, not an app: the checks before AppKit decide each refusal.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', '--', '-profile', '/fixture/profile dir'], { stdio: 'ignore' });
  t.after(() => child.kill());
  const { processArguments } = await import('../bench/fowl/firefox-browser.mjs');
  let row;
  for (let i = 0; i < 50 && !row?.args.includes('-profile'); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    row = (await processArguments()).find(candidate => candidate.pid === child.pid);
  }
  const started = String(row.startedMs / 1000);
  for (const [profile, second, code] of [['/fixture/profile', started, /PROFILE_MISMATCH/], ['/fixture/profile dir', String(row.startedMs / 1000 - 1), /START_MISMATCH/],
    ['/fixture/profile dir', started, /QUIT_REFUSED/]]) {
    const refused = spawnSync(helper, [String(child.pid), process.execPath, profile, second], { encoding: 'utf8', timeout: 5000 });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, code);
  }
});

test('Firefox inventory preserves the first history URL to identify a navigated start tab', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  writeFileSync(join(f.plan.profileRoot, 'sessionstore.jsonlz4'), encoded({ windows: [{ tabs: [{ index: 2,
    entries: [{ url: f.plan.args.at(-1), title: f.plan.marker }, { url: 'https://example.test/task', title: 'Task' }] }] }] }));
  const observed = await browser.observe();
  assert.equal(observed.tabs['firefox:1:1'].url, 'https://example.test/task');
  assert.equal(observed.tabs['firefox:1:1'].initialUrl, f.plan.args.at(-1));
  await browser.stop();
});

for (const startTab of [true, false]) test(`retention ${startTab ? 'excludes navigated start history' : 'counts a newly created task tab at a reused position'}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2c-history-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows = await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out: join(dir, 'out') }, tasks: [{ ...task, keepMin: 1 }],
    runner: { gradeOutcome: ({ run, startKeys }) => ({ problems: [...run.tabs].some(key => !startKeys.has(key)) ? [] : ['no retained task tabs'] }), gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath: join(dir, 'lock'), admit: async () => {}, startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => ({ ...plan, pid: 40, stop: async () => ({ browserClosed: true }) }),
      checkOwner: async () => ({ ok: true }), resetBrowser: async browser => ({ 'firefox:1:1': { url: browser.args.at(-1), title: browser.marker } }),
      runAgent: async arm => { mkdirSync(arm.dir); return { groupClean: true, exitCode: 0, result: { result: 'done' } }; },
      observeBrowser: async browser => ({ observed: true, tabs: { 'firefox:1:1': { url: 'https://example.test/task',
        initialUrl: startTab ? browser.args.at(-1) : 'https://example.test/task', title: 'Task' } } }) } });
  assert.equal(rows[0].outcome.ok, !startTab);
  process.exitCode = 0;
});

test('the gate hook accepts sleight drag only in the gate browser during a gate round', async () => {
  const { answer } = await import('../bench/fowl/origin-hook.mjs');
  const env = { FOWL_GATE_WINDOW: JSON.stringify({ apps: ['Firefox'], title: 'Sleight Gate 12345678-aaaa' }) };
  const drag = app => ({ mcp_server_name: 'plugin:sleight:computer', message: `Allow Claude to drag in ${app}? Background comes first; foreground fallback can move your pointer for a few seconds.` });
  assert.equal(answer(drag('Firefox'), env), 'accept');
  assert.equal(answer(drag('Finder'), env), 'decline');
  assert.equal(answer(drag('Firefox'), {}), 'decline');
});
