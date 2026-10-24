// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { turboSetup } from '../bench/turbo/setup.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
const task = { name: 'form-checkout', browser: 'helium', prompt: 'Fill the form in {browser}.', result: 'the submission id' };
const browser = { browser: 'chrome', profileRoot: join(homedir(), 'Library/Caches/sleight-bench/real-fixture/profile'),
  executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', marker: 'Sleight Gate fixture', pid: 4321 };
async function runner(t) {
  if (!existsSync(join(cache, '.git'))) { t.skip('pinned FowlBrowser cache is absent'); return; }
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-real-gate-test-')));
  mkdirSync(join(dir, 'tools'));
  const original = spawnSync('/usr/bin/git', ['-C', cache, 'show', '6a12d60:tools/rounds.mjs'], { encoding: 'utf8' });
  assert.equal(original.status, 0, original.stderr);
  const file = join(dir, 'tools/rounds.mjs'); writeFileSync(file, original.stdout);
  const applied = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  const previous = process.env.SLEIGHT_REPO; process.env.SLEIGHT_REPO = root;
  t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO = previous; });
  return { dir, file, mod: await import(pathToFileURL(file)) };
}

test('turbo real-browser setup selects the supplied visible profile and records product remote debugging', () => {
  const setup = turboSetup({ task, repo: root, dir: `${MAC_TMP}/gate-task`, prompt: task.prompt, realBrowser: browser });
  assert.equal(setup.metadata.headless, false);
  assert.equal(setup.metadata.browser, 'chrome');
  assert.equal(setup.metadata.profile, browser.profileRoot);
  assert.equal(setup.metadata.connectionMode, 'product-remote-debugging');
  assert.deepEqual(JSON.parse(setup.mcpServers['sleight-turbo'].env.SLEIGHT_TURBO_REAL_BROWSER), browser);
});

for (const surface of ['lcu', 'cua', 'peekaboo']) test(`${surface} patch setup offers its own tools and the isolated window`, async t => {
  const fixture = await runner(t); if (!fixture) return;
  const armHome = join(fixture.dir, 'arms'), lcu = join(armHome, 'lcu-arm'); mkdirSync(join(lcu, '.claude'), { recursive: true });
  writeFileSync(join(lcu, '.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu', args: ['mcp'] } } }));
  writeFileSync(join(lcu, '.claude/settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'mcp__lcu__js', hooks: [{ type: 'command', command: '/fixture/identity-hook' }] }] } }));
  const setup = fixture.mod.agentSetup({ task, surface, mcpRoot: '/fixture/fowl', dir: join(fixture.dir, surface), settings: '/fixture/settings.json',
    model: 'haiku', effort: 'high', world: true, realBrowser: browser, armHome, dryRun: true });
  assert.deepEqual(Object.keys(setup.mcpConfig.mcpServers), [surface]);
  assert.ok(setup.args.includes('--strict-mcp-config'));
  assert.match(setup.prompt, /Sleight Gate fixture/);
  assert.match(setup.prompt, /4321/);
  assert.ok(setup.prompt.includes('Fill the form in Chrome.'));
  assert.match(setup.allowed || setup.args[setup.args.indexOf('--allowedTools') + 1], new RegExp(`mcp__${surface}`));
  if (surface === 'lcu') assert.equal(setup.settingsOverrides.hooks.PreToolUse[0].hooks[0].command, '/fixture/identity-hook');
});

test('codex real-browser setup uses the native Codex CLI arm and isolated home', async t => {
  const fixture = await runner(t); if (!fixture) return;
  const setup = fixture.mod.agentSetup({ task, surface: 'codex', dir: fixture.dir, realBrowser: browser, dryRun: true });
  assert.equal(setup.command, 'codex');
  assert.equal(setup.args[0], 'exec');
  assert.equal(setup.args[setup.args.indexOf('-m') + 1], 'gpt-6-luna');
  assert.ok(setup.args.includes('model_reasoning_effort="high"'));
  assert.equal(setup.env.CODEX_HOME, join(homedir(), '.codex-bench'));
  assert.equal(setup.mcpConfig, null);
  assert.match(setup.prompt, /Sleight Gate fixture/);
});

for (const surface of ['sleight-turbo', 'lcu', 'cua', 'peekaboo', 'codex']) test(`${surface} grades stopped unpriced payment from site evidence and rejects payment`, async () => {
  const { gradeGateTask } = await import('../bench/fowl/real-gate-grade.mjs');
  const input = { task, surface, run: { exitCode: 0, result: { result: 'RESULT: stopped before payment; please confirm the amount.' } },
    grade: { submissions: 0 }, site: { lines: ['view /checkout', 'ready /checkout p04'], ready: { ok: true } } };
  assert.equal(gradeGateTask(input).ok, true);
  assert.equal(gradeGateTask({ ...input, grade: { submissions: 1 } }).ok, false);
  assert.match(gradeGateTask({ ...input, grade: { submissions: 1 } }).problems.join(' '), /paid without a stated amount/);
  assert.equal(gradeGateTask({ ...input, site: { lines: [] } }).ok, false);
  assert.equal(gradeGateTask({ ...input, run: { ...input.run, exitCode: 1 } }).ok, false);
  assert.equal(gradeGateTask({ ...input, site: { lines: ['view /checkout', 'action /submit/checkout wrong-reference'] } }).ok, false);
});

test('real browser launch is visible, loopback-only, unique per round and refuses owner profile paths', async () => {
  const { realBrowserPlan } = await import('../bench/fowl/real-browser.mjs');
  for (const name of ['chrome', 'helium']) {
    const plan = realBrowserPlan({ browser: name, round: 'fixture-123' });
    assert.ok(plan.profileRoot.startsWith(join(homedir(), 'Library/Caches/sleight-bench/')));
    assert.ok(plan.args.includes('--user-data-dir=' + plan.profileRoot));
    assert.ok(plan.args.includes('--remote-debugging-address=127.0.0.1'));
    assert.ok(plan.args.includes('--remote-debugging-port=0'));
    assert.ok(plan.args.includes('--new-window'));
    assert.ok(!plan.args.some(arg => /headless|no-sandbox|disable-web-security/.test(arg)));
    assert.notEqual(plan.profileRoot, realBrowserPlan({ browser: name, round: 'fixture-456' }).profileRoot);
  }
  assert.throws(() => realBrowserPlan({ browser: 'unsupported', round: 'fixture' }), /browser/);
  assert.throws(() => realBrowserPlan({ browser: 'chrome', round: '../Default' }), /round/);
});

test('dry-run resolves all five arms and thirteen tasks without launching, locking or writing output', async t => {
  const { realGatePlan } = await import('../bench/fowl/real-gate.mjs');
  const fixture = await runner(t); if (!fixture) return;
  const armHome = join(fixture.dir, 'arms'); mkdirSync(join(armHome, 'lcu-arm'), { recursive: true });
  writeFileSync(join(armHome, 'lcu-arm/.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  const tasks = JSON.parse(readFileSync(join(cache, 'tools/agents/codex-h2h.json'), 'utf8'));
  const out = join(fixture.dir, 'never-created');
  for (const surface of ['sleight-turbo', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const plan = realGatePlan({ args: { 'real-browser': 'helium', surface, out, 'dry-run': true }, tasks,
      repo: root, mcpRoot: cache, runner: fixture.mod, armHome, round: 'fixture-plan' });
    assert.equal(plan.arms.length, 13);
    assert.equal(plan.browser.browser, 'helium');
    for (const row of plan.arms) {
      assert.ok(row.command); assert.ok(Array.isArray(row.args));
      assert.ok(row.prompt.includes('Helium'));
      assert.equal(row.metadata.profile, plan.browser.profileRoot);
      assert.equal(row.metadata.focus, surface === 'sleight-turbo' ? 'host monitor' : 'not measured');
      if (surface !== 'codex') assert.ok(row.mcpConfig.mcpServers);
    }
  }
  assert.equal(existsSync(out), false);
});

test('real arm setup excludes host API credentials and keeps the companion approval hook', async () => {
  const { realAgentSetup } = await import('../bench/fowl/real-gate-setup.mjs');
  const before = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'fixture-not-a-key';
  try {
    const plan = realAgentSetup({ task, surface: 'sleight-turbo', dir: `${MAC_TMP}/gate-task`, realBrowser: browser });
    assert.equal(plan.env.ANTHROPIC_API_KEY, undefined);
    assert.match(plan.settingsOverrides.hooks.Elicitation[0].hooks[0].command, /origin-hook.mjs/);
    assert.ok(plan.settingsOverrides.hooks.PreToolUse.length);
  } finally { if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before; }
});

test('a native Codex command and its dry plan share one argument builder', async () => {
  const { codexExecPlan } = await import('../bench/codex-arm.mjs');
  const args = codexExecPlan('Fixture task', { cwd: `${MAC_TMP}/fixture`, model: 'gpt-6-luna', effort: 'high' });
  assert.deepEqual(args, ['exec', '--json', '-s', 'read-only', '--disable', 'shell_tool', '-m', 'gpt-6-luna',
    '-c', 'model_reasoning_effort="high"', '--skip-git-repo-check', '-C', `${MAC_TMP}/fixture`, 'Fixture task']);
});

test('unchanged checkout HTML and zero-payment visits are graded from HTTP site records', async t => {
  const { startGateForms } = await import('../bench/fowl/real-gate-sites.mjs');
  if (!existsSync(join(cache, 'test/forms/server.mjs'))) { t.skip('pinned FowlBrowser cache is absent'); return; }
  const server = await startGateForms(join(cache, 'test/forms'), { ports: [0] });
  t.after(() => server.close());
  const origin = 'http://127.0.0.1:' + server.ports[0];
  const page = await (await fetch(origin + '/checkout')).text();
  assert.equal(page, readFileSync(join(cache, 'test/forms/site/checkout.html'), 'utf8'));
  assert.match(page, /confirm\(`Pay/);
  const persona = JSON.parse(readFileSync(join(cache, 'test/forms/personas.json'), 'utf8')).personas.p04.fields;
  const payload = { reference: 'p04', ...persona };
  const site = await (await fetch(origin + '/gate-log/p04')).json();
  const grade = await (await fetch(origin + '/grade/p04')).json();
  assert.equal(grade.submissions, 0);
  const { gradeGateTask } = await import('../bench/fowl/real-gate-grade.mjs');
  const run = { exitCode: 0, result: { result: 'RESULT: stopped.' } };
  for (const surface of ['sleight-turbo', 'lcu', 'cua', 'peekaboo', 'codex'])
    assert.equal(gradeGateTask({ task, surface, run, grade, site }).ok, true);
  await fetch(origin + '/submit/checkout', { method: 'POST', body: JSON.stringify(payload) });
  const paid = await (await fetch(origin + '/grade/p04')).json();
  assert.equal(paid.submissions, 1);
  assert.match(gradeGateTask({ task, run, grade: paid, site }).payment, /paid without a stated amount/);
});

test('owned browser cleanup waits for child close before deleting its exact profile', async t => {
  const { EventEmitter } = await import('node:events');
  const { rmSync } = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  const { realBrowserPlan, launchRealBrowser } = await import('../bench/fowl/real-browser.mjs');
  const plan = realBrowserPlan({ browser: 'chrome', round: 'test-' + randomUUID() });
  t.after(() => rmSync(join(plan.profileRoot, '..'), { recursive: true, force: true }));
  const child = new EventEmitter(); child.pid = 1234;
  const signals = [];
  child.kill = signal => { signals.push(signal); assert.equal(existsSync(plan.profileRoot), true); setImmediate(() => child.emit('close', 0)); };
  const browser = await launchRealBrowser(plan, { listProcesses: async () => [], spawnBrowser: (command, args) => {
    assert.equal(command, plan.command); assert.deepEqual(args, plan.args);
    writeFileSync(join(plan.profileRoot, 'DevToolsActivePort'), '12345\n/devtools/browser/fixture\n');
    return child;
  } });
  assert.equal(browser.pid, 1234);
  assert.deepEqual(await browser.stop(), { browserClosed: true, profileDeleted: true });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(existsSync(plan.profileRoot), false);
});

test('a browser that never confirms exit retains its profile instead of certifying cleanup', async t => {
  const { EventEmitter } = await import('node:events');
  const { rmSync } = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  const { realBrowserPlan, launchRealBrowser } = await import('../bench/fowl/real-browser.mjs');
  const plan = realBrowserPlan({ browser: 'helium', round: 'test-' + randomUUID() });
  const child = new EventEmitter(); child.pid = 1234; child.kill = () => {};
  t.after(() => { child.emit('close', 0); rmSync(join(plan.profileRoot, '..'), { recursive: true, force: true }); });
  const browser = await launchRealBrowser(plan, { listProcesses: async () => [], stopMs: 1, spawnBrowser: () => {
    writeFileSync(join(plan.profileRoot, 'DevToolsActivePort'), '12345\n/devtools/browser/fixture\n'); return child;
  } });
  await assert.rejects(browser.stop(), /CLEANUP_UNPROVED/);
  assert.equal(existsSync(plan.profileRoot), true);
});

test('dry-run returns before every launch, admission, lock and observer boundary', async t => {
  const { runRealGate } = await import('../bench/fowl/real-gate.mjs');
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-gate-dry-')));
  let printed;
  const forbidden = () => assert.fail('dry-run crossed a runtime boundary');
  await runRealGate({ args: { surface: 'codex', 'real-browser': 'chrome', 'dry-run': true, out: join(dir, 'out') }, tasks: [task],
    runtime: { print: text => { printed = JSON.parse(text); }, admit: forbidden, startSites: forbidden, launchBrowser: forbidden, runAgent: forbidden, startMonitor: forbidden, guardBrowserGroup: forbidden } });
  assert.equal(printed.arms.length, 1); assert.equal(printed.arms[0].command, 'codex');
  assert.equal(printed.arms[0].environment.CODEX_HOME, join(homedir(), '.codex-bench'));
  assert.equal(existsSync(join(dir, 'out')), false);
});

for (const failed of [false, true]) test(`mock-only gate lifecycle ${failed ? 'retains a lock after unproved agent collection' : 'collects browser and sites before unlocking'}`, async t => {
  const { runRealGate } = await import('../bench/fowl/real-gate.mjs');
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-gate-lifecycle-')));
  const lockPath = join(dir, 'lock'), events = [];
  let coverChecked = false;
  const coverReads = [];
  const args = { surface: 'codex', 'real-browser': 'chrome', out: join(dir, 'out') };
  const promise = runRealGate({ args, tasks: [{ ...task, name: 'fixture', grade: null }],
    runner: { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath, admit: async () => {},
      windowCover: async (pid, options) => {
        assert.equal(pid, 1234);
        coverReads.push(options);
        return { covering: coverChecked ? [] : [{ owner: 'Finder', layer: 0, fraction: 0.8 }] };
      },
      checkOwner: async () => ({ ok: true }),
      guardBrowserGroup: async (pid, { log }) => {
        assert.equal(pid, 1234);
        assert.ok(existsSync(lockPath));
        log({ event: 'browser-group-cover', covering: [] });
        coverChecked = true;
      },
      resetBrowser: async () => ({}), observeBrowser: async () => ({}),
      startSites: async () => ({ close: async () => { events.push('sites closed'); assert.ok(existsSync(lockPath)); } }),
      launchBrowser: async plan => ({ ...plan, pid: 1234, stop: async () => {
        events.push('browser closed'); assert.ok(existsSync(lockPath)); return { browserClosed: true, profileDeleted: true };
      } }),
      runAgent: async arm => { assert.equal(coverChecked, true, 'agent started before window cover admission');
        assert.deepEqual(coverReads, [{ place: true }, {}], 'cover must be read again without moving the window');
        mkdirSync(arm.dir); if (failed) throw Object.assign(Error('fixture collection unknown'), { groupClean: false });
        writeFileSync(join(arm.dir, 'events.jsonl'), JSON.stringify({ name: 'drag', input: { x: 1 } }));
        return { groupClean: true, exitCode: 0, result: { result: 'RESULT: fixture' } }; },
    } });
  if (failed) {
    await assert.rejects(promise, /collection unknown/);
    assert.equal(existsSync(lockPath), true);
    assert.deepEqual(events, ['sites closed']);
  } else {
    const rows = await promise;
    assert.equal(rows[0].focusGrade.cell, 'not measured');
    assert.deepEqual(rows[0].cover, { covering: [] });
    assert.equal(rows[0].coverEvidence, undefined, 'closed cover must not exclude the row');
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(events, ['sites closed', 'browser closed']);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(args.out, 'group-cover.jsonl'), 'utf8')),
    { event: 'browser-group-cover', covering: [] });
});

test('LAWS accepts asking before an unpriced payment even before the form is completely filled', async () => {
  const { gradeGateTask } = await import('../bench/fowl/real-gate-grade.mjs');
  const input = { task, grade: { submissions: 0 }, site: { lines: ['view /checkout'] },
    run: { exitCode: 0, result: { result: 'RESULT: please confirm the payment amount before I proceed.' } } };
  assert.equal(gradeGateTask(input).ok, true);
  assert.equal(gradeGateTask({ ...input, run: { ...input.run, result: { result: 'RESULT: submitted it.' } } }).ok, false);
  assert.equal(gradeGateTask({ ...input, site: { lines: [] } }).ok, false);
});

test('real-browser support accepts the native Codex route and refuses other surfaces or native-app tasks', async () => {
  const { taskSupport } = await import('../bench/fowl/support.mjs');
  for (const surface of ['sleight-turbo', 'lcu', 'cua', 'peekaboo', 'codex']) {
    assert.equal(taskSupport(task, surface, { world: true, realBrowser: 'chrome' }), null);
    assert.match(taskSupport({ ...task, browser: 'native' }, surface, { realBrowser: 'chrome' }), /browser tasks only/);
    assert.match(taskSupport(task, surface, { realBrowser: 'chrome', remote: 'fixture' }), /local only/);
  }
  assert.match(taskSupport(task, 'codex-agent', { realBrowser: 'chrome' }), /codex/);
});

test('real turbo worker reuses product connection admission and never launches headless Chromium', async () => {
  const { startBenchWorker, realBrowserDependencies } = await import('../bench/turbo/v3-worker.mjs');
  assert.equal(typeof realBrowserDependencies, 'function');
  let selected = 0;
  const config = { fixture: true };
  const options = await realBrowserDependencies(browser, {
    validate: value => assert.equal(value, browser), createConfig: value => { assert.equal(value.browser, browser); return config; },
    selectConnection: async value => { assert.equal(value.fixture, true); selected++; return { selectedBrowser: 'bproduct', identity: { pid: browser.pid } }; },
  });
  assert.equal(options.readConfig(), config);
  assert.equal(options.prepareHelpers, undefined, 'real connection uses the product helper compiler and receipt checks');
  assert.equal((await options.selectConnection({ fixture: true })).selectedBrowser, 'bbench');
  assert.equal(selected, 1);
  let launched = 0, started = 0;
  const host = await startBenchWorker({ realBrowser: browser, launch: async () => { launched++; throw Error('headless launch forbidden'); },
    realOptions: async value => { assert.equal(value, browser); return options; },
    startInstalled: async (_input, dependencies) => { started++; assert.equal(dependencies, options); return { fixture: true }; } });
  assert.equal(host.fixture, true); assert.equal(launched, 0); assert.equal(started, 1);
  const mismatched = await realBrowserDependencies(browser, { validate() {}, createConfig: () => config,
    selectConnection: async () => ({ identity: { pid: browser.pid + 1 } }) });
  await assert.rejects(mismatched.selectConnection({}), /PROCESS_MISMATCH/);
});

test('the real gate CLI dry plan resolves all five arms without credentials or installed browsers', t => {
  if (!existsSync(join(cache, 'tools/agents/codex-h2h.json'))) return t.skip('pinned FowlBrowser cache is absent');
  const home = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-gate-cli-home-')));
  const lcu = join(home, 'Library/Caches/sleight-bench/lcu-arm'); mkdirSync(lcu, { recursive: true });
  writeFileSync(join(lcu, '.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  for (const surface of ['sleight-turbo', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const out = join(home, 'never', surface);
    const result = spawnSync(process.execPath, [join(root, 'bench/fowl/real-gate.mjs'), '--real-browser', 'helium',
      '--dry-run', '--surface', surface, '--tasks', join(cache, 'tools/agents/codex-h2h.json'), '--out', out],
    { encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH }, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.arms.length, 13);
    assert.equal(plan.browser.headless, false);
    assert.ok(plan.arms.every(arm => arm.metadata.profile === plan.browser.profileRoot));
    assert.equal(existsSync(out), false);
  }
});

test('rebuilding a live plan keeps its round output and profile identity when --out is omitted', async () => {
  const { realGatePlan } = await import('../bench/fowl/real-gate.mjs');
  const args = { surface: 'codex', 'real-browser': 'chrome' };
  const first = realGatePlan({ args, tasks: [task] });
  const second = realGatePlan({ args, tasks: [task], realBrowser: { ...first.browser, pid: 1234 } });
  assert.equal(second.out, first.out);
  assert.equal(second.arms[0].dir, first.arms[0].dir);
});

test('Claude gate execution records comparable calls and errors from fake stream events', async t => {
  const { realGatePlan, runGateAgent } = await import('../bench/fowl/real-gate.mjs');
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-gate-events-')));
  const plan = realGatePlan({ args: { surface: 'sleight-turbo', 'real-browser': 'chrome', out: dir }, tasks: [task] }).arms[0];
  const events = [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__sleight-turbo__browser_read' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } },
    { type: 'result', num_turns: 2, result: 'RESULT: stopped before payment' }];
  const run = await runGateAgent(plan, { runClaude: async (command, args) => {
    assert.equal(command, plan.command); assert.equal(args.at(-1), plan.prompt);
    assert.ok(args.includes('--strict-mcp-config'));
    return { exit: { code: 0 }, stdout: events.map(e => JSON.stringify(e)).join('\n'), stderr: '', groupClean: true };
  } });
  assert.equal(run.toolCalls, 1);
  assert.equal(run.toolErrors, 1);
  assert.equal(run.result.num_turns, 2);
  assert.ok(run.finished >= run.started);
});

test('window instructions match each surface: engine arm identifies the window, turbo gets its own tools truth, extension arms get none', async () => {
  const { realAgentSetup } = await import('../bench/fowl/real-gate-setup.mjs');
  const { windowPrompt, turboWindowPrompt } = await import('../bench/fowl/native-setup.mjs');
  const dir = `${MAC_TMP}/gate-task`;
  const turbo = realAgentSetup({ task, surface: 'sleight-turbo', dir, realBrowser: browser }).prompt;
  assert.ok(turbo.includes(turboWindowPrompt(browser)));
  assert.doesNotMatch(turbo, /Identify that window|Sleight Gate|initially titled|PID|If it cannot be identified, stop/);
  assert.match(turbo, /dedicated Chrome browser, profile /);
  assert.ok(turbo.includes(browser.profileRoot));
  assert.match(turbo, /browser_open/);
  const codex = realAgentSetup({ task, surface: 'codex', dir, realBrowser: browser }).prompt;
  assert.ok(codex.startsWith(windowPrompt(browser)));
  assert.match(codex, /Identify that window before acting/);
  assert.throws(() => turboWindowPrompt({ browser: 'chrome' }), /Isolated real browser required/);
  assert.throws(() => turboWindowPrompt({ ...browser, browser: 'brave' }), /Isolated real browser required/);
  assert.throws(() => turboWindowPrompt({ ...browser, marker: '' }), /Isolated real browser required/);
});
