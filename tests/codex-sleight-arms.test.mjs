// The sleight-in-Codex benchmark arms (LAWS, 2026-10-18): codex-sleight on gpt-6-luna and codex-sleight-sol on gpt-6.1-sol.
// Plans, config.toml content, the approval proxy and its guards. No app, browser, model or Codex login is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { baseClient } from '../bench/other-hosts-client.mjs';
import { PROXY, approvalSummary, codexSleightRunConfig, codexSleightToml, ensureCodexSleightHome, tomlString, writeCodexSleightConfig } from '../bench/codex-sleight.mjs';
import { acceptedContent, answerElicitation, guardReason, normalizeMessage, parseArgs } from '../bench/codex-sleight-proxy.mjs';
import { CODEX_SLEIGHT_ARM_MODELS, REAL_BROWSER_ARMS, isCodexSleightSurface, runsCodexExec, sleightKind, taskSupport } from '../bench/fowl/support.mjs';
import { realAgentSetup } from '../bench/fowl/real-gate-setup.mjs';
import { admitRealGate, prepareRoundArms, realGatePlan, roundArmPrep, runGateAgent } from '../bench/fowl/real-gate.mjs';

const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'codex-sleight-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const fixture = fileURLToPath(new URL('./fixtures/other-hosts-stdio.mjs', import.meta.url));
const MODELS = [['codex-sleight', 'gpt-6-luna'], ['codex-sleight-sol', 'gpt-6.1-sol']];
const raceTask = { name: 'fixture', browser: 'firefox', prompt: 'Visit {browser}.', result: 'the answer' };
const firefox = { browser: 'firefox', profileRoot: '/tmp/profile', executable: '/Applications/Firefox.app/Contents/MacOS/firefox', marker: 'Sleight Gate fixture0001', pid: 1 };
const chrome = { browser: 'chrome', profileRoot: '/tmp/profile', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', marker: 'Sleight Gate fixture0002', pid: 2, connectionMode: 'product-remote-debugging' };
const engineForm = (app, schema = { type: 'object', properties: { remember: { type: 'string', enum: ['This session', 'Always'], default: 'This session' } } }) =>
  ({ message: `Allow Computer Use to use "${app}"?`, mode: 'form', requestedSchema: schema });

test('the two arms are Codex runs on the two models, one per surface name', () => {
  assert.deepEqual(CODEX_SLEIGHT_ARM_MODELS, { 'codex-sleight': 'gpt-6-luna', 'codex-sleight-sol': 'gpt-6.1-sol' });
  for (const [surface] of MODELS) assert.ok(REAL_BROWSER_ARMS.includes(surface) && isCodexSleightSurface(surface) && runsCodexExec(surface));
  assert.equal(sleightKind('codex-sleight', 'firefox'), 'sleight'); assert.equal(sleightKind('codex-sleight', 'safari'), 'sleight');
  assert.equal(sleightKind('codex-sleight-sol', 'chrome'), 'sleight-turbo'); assert.equal(sleightKind('codex-sleight', 'helium'), 'sleight-turbo');
  assert.equal(sleightKind('codex', 'chrome'), 'codex');
});

test('they race wherever sleight races, and nowhere else', () => {
  for (const [surface] of MODELS) {
    assert.equal(taskSupport(raceTask, surface, { realBrowser: 'firefox' }), null);
    assert.equal(taskSupport({ ...raceTask, browser: 'chrome' }, surface, { realBrowser: 'chrome' }), null);
    assert.match(taskSupport({ ...raceTask, browser: 'safari', viewport: {} }, surface, { realBrowser: 'safari' }), /viewport/);
    assert.match(taskSupport({ ...raceTask, downloads: true }, surface, { realBrowser: 'firefox' }), /downloads/);
  }
});

for (const [surface, model] of MODELS) {
  test(`${surface} on Firefox plans the engine path under Codex: ${model}, effort high, its own CODEX_HOME, sleight's server alone`, () => {
    const setup = realAgentSetup({ task: raceTask, surface, dir: '/tmp/x', realBrowser: firefox, dryRun: true });
    assert.equal(setup.command, 'codex');
    assert.equal(setup.args[setup.args.indexOf('-m') + 1], model);
    assert.ok(setup.args.includes('model_reasoning_effort="high"') && setup.args.includes('shell_tool'));
    assert.equal(setup.args.at(-1), setup.prompt, 'the prompt is the codex exec argument');
    assert.equal(setup.env.CODEX_HOME, join(homedir(), '.codex-bench-sleight'));
    assert.notEqual(setup.env.CODEX_HOME, join(homedir(), '.codex'), 'never the owner\'s Codex home');
    assert.deepEqual(setup.codexConfig.servers, ['plugin_sleight_computer']);
    assert.equal(setup.metadata.model, model); assert.equal(setup.metadata.effort, 'high'); assert.equal(setup.metadata.sleightAs, 'sleight');
    const toml = setup.codexConfig.toml;
    assert.deepEqual(toml.match(/^\[mcp_servers\.[^\]]+\]/gm), ['[mcp_servers.plugin_sleight_computer]', '[mcp_servers.plugin_sleight_computer.env]']);
    // The proxy may use ChatGPT's bundled Node. Its runtime path is not an engine server entry.
    assert.ok(!/cua_repl|cua-repl/.test(toml), 'the engine\'s own computer-use server is not configured');
    assert.ok(toml.includes(`model = "${model}"`) && toml.includes('model_reasoning_effort = "high"'));
    assert.ok(toml.includes('enabled_tools = ["js", "js_reset", "open_file", "drag", "select_window"]'), 'the engine race arm\'s tools');
    // Engine path only (turbo off, as the Claude-hosted Firefox arm), the panel impossible, and the gate window bound.
    assert.match(toml, /SLEIGHT_TURBO = "0"/); assert.match(toml, /SLEIGHT_SURFACES = "computer"/);
    assert.match(toml, /SLEIGHT_APPROVAL_PROMPT = "client"/);
    assert.match(toml, /FOWL_GATE_WINDOW = .*Sleight Gate fixture0001/);
    assert.match(toml, /"--policy", "race", "--log", "\/tmp\/x\/approvals\.jsonl", "--gate-window", "--", ".*\/plugins\/sleight\/bin\/sleight-mcp"/);
    assert.ok(!/browser_open|sleight-turbo/.test(toml));
    assert.match(setup.prompt, /Sleight Gate fixture0001/, 'the engine arm\'s window prompt');
  });

  test(`${surface} on Chrome plans turbo under Codex: the bench turbo server beside sleight, the browser's own debugging connection`, () => {
    const setup = realAgentSetup({ task: { ...raceTask, browser: 'chrome', prompt: 'Visit http://127.0.0.1:5420/x in {browser}.' }, surface,
      dir: '/tmp/x', realBrowser: chrome, dryRun: true });
    assert.deepEqual(setup.codexConfig.servers, ['plugin_sleight_computer', 'sleight-turbo']);
    const toml = setup.codexConfig.toml;
    assert.match(toml, /enabled_tools = \["browser_open", "browser_read", "browser_act", "browser_fill", "browser_tabs"\]/);
    assert.match(toml, /enabled_tools = \["js", "js_reset", "open_file"\]/);
    assert.match(toml, /SLEIGHT_SURFACES = "browser,computer"/); assert.match(toml, /SLEIGHT_SKILL = "default"/);
    assert.ok(!/SLEIGHT_TURBO = "0"/.test(toml), 'turbo stays on');
    assert.match(toml, /"--turbo-guard", "bbench"/); assert.ok(!toml.includes('--gate-window'));
    assert.match(toml, /SLEIGHT_TURBO_REAL_BROWSER = .*product-remote-debugging/);
    assert.match(toml, /SLEIGHT_TURBO_ORIGINS = "\[\\"http:\/\/127\.0\.0\.1:5420\\"\]"/);
    assert.match(toml, /SLEIGHT_TURBO_METRICS = "\/tmp\/x\/turbo-metrics\.jsonl"/);
    assert.equal(setup.metadata.sleightAs, 'sleight-turbo'); assert.equal(setup.metadata.focus, 'host monitor');
    assert.match(setup.prompt, /browser_open/, 'the turbo skill and window prompt');
  });
}

test('a live-shaped plan carries the config per task and the round arm prep names the arm\'s home, not the engine list', () => {
  for (const [surface, model] of MODELS) for (const [browser, kind] of [[firefox, 'sleight'], [chrome, 'sleight-turbo']]) {
    const task = { ...raceTask, browser: browser.browser };
    const plan = realGatePlan({ args: { surface, 'real-browser': browser.browser, out: '/tmp/never-made' }, tasks: [task], realBrowser: browser });
    assert.equal(plan.surface, surface);
    assert.equal(plan.arms[0].args.at(-1), plan.arms[0].prompt);
    assert.equal(plan.arms[0].metadata.model, model); assert.equal(plan.arms[0].metadata.sleightAs, kind);
    assert.equal(plan.arms[0].codexConfig.home, join(homedir(), '.codex-bench-sleight'));
    assert.deepEqual(roundArmPrep(plan), { codexSleightHome: join(homedir(), '.codex-bench-sleight'), approvalPath: 'proxy: race allowlist (origin-hook.mjs)' });
  }
  // Each browser keeps its own surface: the plain names are refused there, as before.
  assert.throws(() => realGatePlan({ args: { surface: 'sleight', 'real-browser': 'chrome', out: '/tmp/never-made' }, tasks: [{ ...raceTask, browser: 'chrome' }], realBrowser: chrome }), /sleight-turbo/);
});

test('round prep sets up the arm\'s home and never touches the engine\'s Always allow list', async t => {
  const dir = temporary(t), calls = [];
  const plan = { surface: 'codex-sleight', out: '/tmp/fb-rounds/real-x-codex-sleight', browser: { browser: 'firefox' } };
  const { receipt, release } = await prepareRoundArms(plan, { logs: dir, armHome: dir,
    approve: () => assert.fail('the engine list stays as the owner has it'), daemon: () => assert.fail('no daemon'),
    codexHome: options => { calls.push(options); return { ok: true, home: options.home, did: ['login copied'] }; } });
  assert.deepEqual(calls, [{ home: join(homedir(), '.codex-bench-sleight') }]);
  assert.deepEqual(receipt, { codexSleightHome: join(homedir(), '.codex-bench-sleight'), setup: ['login copied'], approvalPath: 'proxy: race allowlist (origin-hook.mjs)' });
  await release();
  await assert.rejects(prepareRoundArms(plan, { logs: dir, codexHome: () => ({ ok: false, problem: 'no login' }) }), /no login/);
});

test('admission refuses a Codex home with any server but sleight\'s, and a missing proxy', async () => {
  const plan = realGatePlan({ args: { surface: 'codex-sleight', 'real-browser': 'firefox', out: `/tmp/never-made-${process.pid}` }, tasks: [raceTask], realBrowser: firefox });
  const stray = structuredClone(plan);
  stray.arms[0].codexConfig.servers.push('cua_repl');
  await assert.rejects(admitRealGate(stray), /only sleight's servers/);
  const none = structuredClone(plan);
  none.arms[0].codexConfig = undefined;
  await assert.rejects(admitRealGate(none), /only sleight's servers/);
});

test('a run writes its servers into the arm\'s home, keeps a copy, and records the model Codex ran and the proxy\'s decisions', async t => {
  for (const [surface, model] of MODELS) {
    const root = temporary(t), home = join(root, 'home'), dir = join(root, 'task');
    const setup = realAgentSetup({ task: raceTask, surface, dir, realBrowser: firefox, dryRun: true });
    const plan = { ...setup, surface, dir, task: { name: 'fixture' }, codexConfig: { ...setup.codexConfig, home } };
    let seen;
    const receipt = await runGateAgent(plan, { runNativeCodex: async (_prompt, options) => {
      seen = options;
      writeFileSync(join(dir, 'approvals.jsonl'), [{ kind: 'elicitation', message: 'Allow Computer Use to use "Firefox"?', action: 'accept' },
        { kind: 'elicitation', message: 'Allow Computer Use to use "Terminal"?', action: 'decline' }, { kind: 'tool-refused', tool: 'select_window', reason: 'x' }]
        .map(entry => JSON.stringify(entry)).join('\n') + '\n');
      return { groupClean: true, code: 0, out: { result: 'RESULT: none' }, stderr: '', forbidden: [], toolCalls: 2, modelRequested: model, modelsRan: [model] };
    } });
    assert.equal(seen.model, model); assert.equal(seen.effort, 'high'); assert.equal(seen.home, home);
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), setup.codexConfig.toml);
    assert.equal(readFileSync(join(dir, 'codex-config.toml'), 'utf8'), setup.codexConfig.toml);
    assert.equal(statSync(join(home, 'config.toml')).mode & 0o777, 0o600);
    assert.deepEqual(receipt.result.modelsRan, undefined);
    assert.deepEqual([receipt.modelRequested, receipt.modelsRan], [model, [model]]);
    assert.deepEqual(receipt.approvals, { accepted: 1, declined: ['Allow Computer Use to use "Terminal"?'], toolsRefused: ['select_window'] });
    assert.equal(receipt.agentConfig.codexServers[0], 'plugin_sleight_computer');
  }
});

test('config.toml text: strings are escaped, servers keep their order, and Codex accepts the file', t => {
  assert.equal(tomlString('a"b\\c\n\u007f'), '"a\\"b\\\\c\\n\\u007f"');
  const servers = { one: { command: '/bin/x', args: ['a b', '--'], env: { K: 'v "q"' }, enabledTools: ['js'] }, two: { command: '/bin/y' } };
  const toml = codexSleightToml({ model: 'gpt-6-luna', servers });
  assert.deepEqual(toml.match(/^\[mcp_servers\.[^\]]+\]/gm), ['[mcp_servers.one]', '[mcp_servers.one.env]', '[mcp_servers.two]', '[mcp_servers.two.env]']);
  assert.match(toml, /^approval_policy = "never"$/m); assert.match(toml, /^web_search = "disabled"$/m); assert.match(toml, /^computer_use = false$/m);
  assert.match(toml, /K = "v \\"q\\""/);
  if (spawnSync('codex', ['--version']).status !== 0) return t.skip('codex is not installed');
  // Codex parses and validates the real plans' files (an unknown value for a known key is an error). `mcp list` starts no server.
  for (const [surface] of MODELS) for (const browser of [firefox, chrome]) {
    const home = temporary(t);
    const setup = realAgentSetup({ task: { ...raceTask, browser: browser.browser }, surface, dir: '/tmp/x', realBrowser: browser, dryRun: true });
    writeCodexSleightConfig(setup.codexConfig.toml, home);
    const listed = spawnSync('codex', ['mcp', 'list', '--json'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).map(server => server.name), setup.codexConfig.servers);
  }
});

test('the home is set up once: a private folder, the codex arm\'s login copied and left alone, a config with no servers', t => {
  const root = temporary(t), loginHome = join(root, 'login'), home = join(root, 'home');
  assert.match(ensureCodexSleightHome({ home, loginHome }).problem, /no Codex login/);
  mkdirSync(loginHome); writeFileSync(join(loginHome, 'auth.json'), '{"fixture":1}');
  const first = ensureCodexSleightHome({ home, loginHome });
  assert.equal(first.ok, true); assert.deepEqual(first.did, [`login copied from ${loginHome}`, 'base config.toml']);
  assert.equal(statSync(home).mode & 0o777, 0o700); assert.equal(statSync(join(home, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(loginHome, 'auth.json'), 'utf8'), '{"fixture":1}');
  assert.ok(!/\[mcp_servers/.test(readFileSync(join(home, 'config.toml'), 'utf8')));
  assert.deepEqual(ensureCodexSleightHome({ home, loginHome }).did, []);
});

test('the world and claim runner\'s config is the Claude-hosted sleight arm\'s server under the claim\'s policy', () => {
  const config = codexSleightRunConfig({ model: 'gpt-6.1-sol', dir: '/tmp/run', suite: 'world', ownerPresent: true, surfaces: 'computer', trace: '/tmp/ev', repo: '/repo', home: '/home/x', node: '/bin/node' });
  assert.deepEqual(config.servers, ['plugin_sleight_computer']);
  assert.match(config.toml, /model = "gpt-6\.1-sol"/);
  assert.ok(config.toml.includes(`args = [${tomlString(PROXY)}, "--policy", "bench", "--log", "/tmp/run/approvals.jsonl", "--", "/repo/plugins/sleight/bin/sleight-mcp"]`));
  assert.match(config.toml, /enabled_tools = \["js", "js_reset", "drag", "hover", "menu_bar", "notifications", "select_window", "open_file"\]/);
  for (const line of ['BENCH_SUITE = "world"', 'BENCH_OWNER_PRESENT = "1"', 'SLEIGHT_SURFACES = "computer"', 'SLEIGHT_TRACE = "/tmp/ev"', 'SLEIGHT_APPROVAL_PROMPT = "client"', 'BENCH_ROOT = "/repo"']) assert.ok(config.toml.includes(line), line);
});

// ---- the approval proxy -----------------------------------------------------------------------------------------

test('host wording in sleight\'s local prompts goes back to the wording the hooks match, and the log keeps the original', () => {
  assert.equal(normalizeMessage('Allow Codex Mcp Client to drag in Firefox? It can move the pointer.'), 'Allow Claude to drag in Firefox? It can move the pointer.');
  assert.equal(normalizeMessage("Allow Codex to use Firefox's menu bar item?"), "Allow Claude to use Firefox's menu bar item?");
  assert.equal(normalizeMessage('Allow this agent to select a window in Firefox? It changes the app\'s main window without activating the app.'),
    'Allow Claude to select a window in Firefox? It changes the app\'s main window without activating the app.');
  for (const same of ['Allow Computer Use to use "Firefox"?', 'Allow Browser use to access https://en.wikipedia.org?', 'Allow Claude to drag in Firefox? x']) assert.equal(normalizeMessage(same), same);
});

test('accepted forms carry the session choice when asked and never the Always field', () => {
  assert.deepEqual(acceptedContent({ properties: { choice: { enum: ['once', 'session', 'always'] } } }), { choice: 'session' });
  assert.deepEqual(acceptedContent({ properties: { choice: { enum: ['once', 'always'] } } }), { choice: 'once' });
  assert.deepEqual(acceptedContent({ properties: { remember: { enum: ['This session', 'Always'] } } }), {});
  assert.deepEqual(acceptedContent(undefined), {});
});

test('race policy: the round\'s browser and hand-off apps are accepted, everything else declined, and the owner\'s Always is never answered', async () => {
  const env = {};
  for (const app of ['Firefox', 'Google Chrome', 'Helium', 'Safari', 'Preview', 'TextEdit']) {
    const answer = await answerElicitation(engineForm(app), { policy: 'race', env });
    assert.equal(answer.action, 'accept', app); assert.deepEqual(answer.content, {}); assert.ok(!('remember' in answer.content));
  }
  for (const app of ['Terminal', 'Mail', 'System Settings']) assert.equal((await answerElicitation(engineForm(app), { policy: 'race', env })).action, 'decline', app);
  assert.equal((await answerElicitation({ message: 'Allow Browser use to access https://evil.example?', mode: 'form' }, { policy: 'race', env })).action, 'decline');
  assert.equal((await answerElicitation({ message: 'Allow Browser use to access https://en.wikipedia.org?', mode: 'form' }, { policy: 'race', env })).action, 'accept');
  assert.equal((await answerElicitation({ message: 'Allow Firefox via CDP?', mode: 'form' }, { policy: 'race', env })).action, 'decline');
  assert.equal((await answerElicitation({ ...engineForm('Firefox'), mode: 'url' }, { policy: 'race', env })).action, 'decline');
  assert.equal((await answerElicitation(engineForm('Firefox'), { policy: 'nothing', env })).action, 'decline');
  // sleight's own local-tool prompts, in the words a Codex host gets
  const gate = { FOWL_GATE_WINDOW: JSON.stringify({ apps: ['Firefox', 'org.mozilla.firefox'], title: 'Sleight Gate abcdef12' }) };
  assert.equal((await answerElicitation({ message: 'Allow Codex to select a window in Firefox? It changes the app\'s main window without activating the app.', mode: 'form' }, { policy: 'race', env: gate })).action, 'accept');
  assert.equal((await answerElicitation({ message: 'Allow Codex to select a window in Terminal? It changes the app\'s main window without activating the app.', mode: 'form' }, { policy: 'race', env: gate })).action, 'decline');
  assert.equal((await answerElicitation({ message: 'Allow Codex to drag in Firefox? x', mode: 'form' }, { policy: 'race', env: gate })).action, 'accept');
  assert.equal((await answerElicitation({ message: 'Allow Codex to drag in Firefox? x', mode: 'form' }, { policy: 'race', env })).action, 'decline', 'no gate window, no drag');
});

test('bench policy: the claim and world suites\' allowlist, from approve.mjs', async () => {
  const world = { BENCH_SUITE: 'world', BENCH_WORLD_TASKS: '["calculator-click","slack-post","textedit-save"]' };
  const form = { properties: { choice: { enum: ['once', 'session'] }, remember: { enum: ['This session', 'Always'] } } };
  const accepted = await answerElicitation(engineForm('Calculator', form), { policy: 'bench', env: world });
  assert.deepEqual([accepted.action, accepted.content], ['accept', { choice: 'session' }]);
  assert.equal((await answerElicitation(engineForm('Terminal', form), { policy: 'bench', env: world })).action, 'decline');
  assert.equal((await answerElicitation(engineForm('Firefox', form), { policy: 'bench', env: world })).action, 'decline', 'the selected world tasks have no Firefox');
  assert.equal((await answerElicitation(engineForm('Slack', form), { policy: 'bench', env: world })).action, 'accept');
  assert.equal((await answerElicitation({ message: 'Allow Codex to open files in TextEdit? x', mode: 'form' }, { policy: 'bench', env: world })).action, 'accept');
  assert.equal((await answerElicitation(engineForm('iPhone Mirroring'), { policy: 'bench', env: { BENCH_SUITE: 'real' } })).action, 'decline', 'owner-present apps stay out unless the pass says so');
});

test('the guards are the PreToolUse hooks: select_window only for the gate window, engine js never names a browser under turbo', async () => {
  const gate = { FOWL_GATE_WINDOW: JSON.stringify({ apps: ['Firefox'], title: 'Sleight Gate abcdef12' }) };
  assert.equal(await guardReason('select_window', { app: 'Firefox', title: 'Sleight Gate abcdef12' }, { gateWindow: true, env: gate }), undefined);
  assert.match(await guardReason('select_window', { app: 'Firefox', title: 'Other' }, { gateWindow: true, env: gate }), /only for the gate's own window/);
  assert.match(await guardReason('select_window', { app: 'Firefox', title: 'Sleight Gate abcdef12' }, { gateWindow: true, env: {} }), /only for the gate's own window/);
  assert.equal(await guardReason('select_window', { app: 'Firefox' }, { gateWindow: false, env: {} }), undefined, 'no guard unless asked for');
  assert.match(await guardReason('js', { code: 'const b = await cua.getBrowser("chrome")' }, { turboBrowser: 'bbench' }), /Use the mcp__sleight-turbo__browser_\* tools/);
  assert.equal(await guardReason('js', { code: 'await app.getAXState()' }, { turboBrowser: 'bbench' }), undefined);
  assert.equal(await guardReason('js_reset', {}, { turboBrowser: 'bbench' }), undefined);
});

test('proxy arguments', () => {
  assert.deepEqual(parseArgs(['--policy', 'race', '--log', '/l', '--gate-window', '--turbo-guard', 'b', '--', '/x', 'a']),
    { policy: 'race', log: '/l', gateWindow: true, turboBrowser: 'b', command: '/x', args: ['a'] });
  assert.throws(() => parseArgs(['--policy', 'race']), /usage/);
  assert.throws(() => parseArgs(['--policy', 'maybe', '--', 'x']), /race or bench/);
  assert.throws(() => parseArgs(['--surprise', '--policy', 'race', '--', 'x']), /unknown option/);
});

test('approvalSummary counts accepted and lists declined prompts and refused tools', t => {
  const file = join(temporary(t), 'approvals.jsonl');
  assert.deepEqual(approvalSummary(file), { accepted: 0, declined: [], toolsRefused: [] });
  writeFileSync(file, `${JSON.stringify({ kind: 'elicitation', message: 'a', action: 'accept' })}\nnot json\n${JSON.stringify({ kind: 'elicitation', message: 'b', action: 'decline' })}\n`);
  assert.deepEqual(approvalSummary(file), { accepted: 1, declined: ['b'], toolsRefused: [] });
});

// Through the real relay (a fake engine behind it): a client with no capabilities at all, as `codex exec` is. Without the proxy
// the relay would open its native panel (the other-hosts test counts that dialog); behind the proxy no dialog opens, and the
// answer comes from the benchmark's allowlist.
const throughProxy = async (t, { policy, env = {}, guards = [] }) => {
  const dir = temporary(t), log = join(dir, 'approvals.jsonl');
  const client = await baseClient({ command: process.execPath, env,
    args: [PROXY, '--policy', policy, '--log', log, ...guards, '--', process.execPath, fixture, 'relay'] });
  t.after(() => client.close());
  return { client, log, entries: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] };
};

test('behind the proxy the engine\'s approval is answered from the bench policy, with no dialog and nothing remembered', async t => {
  const { client, entries } = await throughProxy(t, { policy: 'bench', env: { BENCH_SUITE: 'world', BENCH_WORLD_TASKS: '["calculator-click"]' } });
  const result = await client.call('js', { code: 'var app = await cua.getApp("Calculator")' });
  assert.equal(result.isError, undefined);
  assert.equal(result._meta.fixture.dialogs, 0, 'no native panel');
  assert.ok(result._meta.fixture.engineCapabilities.elicitation.form, 'the relay was told forms are answerable');
  assert.deepEqual(entries().map(entry => [entry.kind, entry.action, entry.policy]), [['elicitation', 'accept', 'bench']]);
  assert.equal(entries()[0].message, 'Allow Computer Use to use "Calculator"?');
});

test('behind the proxy an app outside the race allowlist is declined, logged, and no dialog opens', async t => {
  const { client, entries } = await throughProxy(t, { policy: 'race' });
  const result = await client.call('js', { code: 'var app = await cua.getApp("Calculator")' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not approved/);
  assert.equal(result._meta.fixture.dialogs, 0);
  assert.deepEqual(entries().map(entry => [entry.kind, entry.action]), [['elicitation', 'decline']]);
});

test('behind the proxy a refused tool call gets the hook\'s reason and never reaches sleight', async t => {
  const gate = { FOWL_GATE_WINDOW: JSON.stringify({ apps: ['Firefox'], title: 'Sleight Gate abcdef12' }) };
  const { client, entries } = await throughProxy(t, { policy: 'race', env: gate, guards: ['--gate-window'] });
  const refused = await client.call('select_window', { app: 'Firefox', title: 'Someone else' });
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /gate's own window/);
  assert.deepEqual(entries().map(entry => [entry.kind, entry.tool]), [['tool-refused', 'select_window']]);
  const turbo = await throughProxy(t, { policy: 'race', guards: ['--turbo-guard', 'bbench'] });
  const js = await turbo.client.call('js', { code: 'const list = await cua.listBrowsers()' });
  assert.equal(js.isError, true); assert.match(js.content[0].text, /sleight-turbo/);
});

test('the proxy passes sleight\'s exit through and closes with its client', async t => {
  const { client } = await throughProxy(t, { policy: 'race' });
  await client.call('js', { code: 'var app = await cua.getApp("Calculator")' });
  await client.close();
});
