// The native claim's GPT arms (ROADMAP 4b): sleight inside Codex against Codex out of the box, on the 9 claim tasks plus VS Code,
// Slack and Spotify. Config isolation, the proxy's answers for those apps, and what a run records from Codex's own events.
// No app, Codex, model or login is touched: Codex is a script that prints a recorded event stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTasks } from '../bench/tasks.mjs';
import { answerElicitation } from '../bench/codex-sleight-proxy.mjs';
import { approvalSummary, assertArmHome } from '../bench/codex-sleight.mjs';
import { runCodex, rolloutFacts } from '../bench/codex-arm.mjs';
import { SAME_MODEL, claim, excluded, sameModel, score, warnings } from '../bench/claim-score.mjs';

const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'codex-native-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const claimTasks = readFileSync(new URL('../bench/claim-tasks.txt', import.meta.url), 'utf8').trim().split(',');
const NATIVE = [...claimTasks, 'vscode-edit', 'slack-post', 'spotify-play'];
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// Every file under a folder with its bytes, to prove a folder unchanged.
const snapshot = dir => Object.fromEntries(readdirSync(dir, { recursive: true }).sort()
  .map(name => join(dir, name)).filter(path => statSync(path).isFile()).map(path => [path, readFileSync(path, 'utf8')]));

test('with the default homes, the arm\'s Codex home lists only sleight\'s server and the owner\'s ~/.codex and the codex arm\'s home are untouched', t => {
  const home = temporary(t), owner = join(home, '.codex'), bench = join(home, '.codex-bench');
  mkdirSync(owner); mkdirSync(bench);
  writeFileSync(join(owner, 'config.toml'), 'model = "owner"\n[mcp_servers.owner_tool]\ncommand = "/owner/tool"\n');
  writeFileSync(join(owner, 'AGENTS.md'), 'owner instructions\n');
  writeFileSync(join(bench, 'auth.json'), '{"fixture":"login"}');
  writeFileSync(join(bench, 'config.toml'), '[mcp_servers.cua_repl]\ncommand = "/engine"\n');
  const before = { owner: snapshot(owner), bench: snapshot(bench) };
  const url = name => new URL(`../bench/${name}`, import.meta.url).href;
  const script = `
    import { CODEX_SLEIGHT_HOME, ensureCodexSleightHome, codexSleightRunConfig, writeCodexSleightConfig } from ${JSON.stringify(url('codex-sleight.mjs'))};
    import { CODEX_HOME, codexConfigServers } from ${JSON.stringify(url('codex-arm.mjs'))};
    import { join } from 'node:path';
    const setup = ensureCodexSleightHome();
    const config = codexSleightRunConfig({ model: 'gpt-6.1-sol', dir: process.env.RUN_DIR, suite: 'world', surfaces: 'computer' });
    writeCodexSleightConfig(config.toml, undefined, join(process.env.RUN_DIR, 'codex-config.toml'));
    const refused = [];
    for (const other of [join(process.env.HOME, '.codex'), CODEX_HOME]) try { writeCodexSleightConfig('x', other); } catch (error) { refused.push(error.message); }
    console.log(JSON.stringify({ home: CODEX_SLEIGHT_HOME, codexHome: CODEX_HOME, setup, planned: config.servers, servers: codexConfigServers(CODEX_SLEIGHT_HOME),
      refused, refusedSetup: ensureCodexSleightHome({ home: join(process.env.HOME, '.codex') }) }));`;
  const run = join(home, 'run'); mkdirSync(run);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, RUN_DIR: run } });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout);
  assert.deepEqual([out.home, out.codexHome], [join(home, '.codex-bench-sleight'), bench]);
  assert.equal(out.setup.ok, true);
  assert.deepEqual([out.planned, out.servers], [['plugin_sleight_computer'], ['plugin_sleight_computer']]);
  const toml = readFileSync(join(out.home, 'config.toml'), 'utf8');
  assert.equal(toml, readFileSync(join(run, 'codex-config.toml'), 'utf8'), 'the run keeps a copy');
  assert.ok(!/owner_tool|cua_repl|AGENTS/.test(toml));
  assert.match(toml, /--policy", "bench"/);
  assert.equal(readFileSync(join(out.home, 'auth.json'), 'utf8'), '{"fixture":"login"}', 'the login is a copy of the codex arm\'s');
  assert.deepEqual({ owner: snapshot(owner), bench: snapshot(bench) }, before, 'nothing in ~/.codex or ~/.codex-bench changed or appeared');
  assert.equal(out.refused.length, 2);
  assert.match(out.refused[0], /the owner's Codex home/); assert.match(out.refused[1], /the codex arm's home/);
  assert.equal(out.refusedSetup.ok, false);
  assert.throws(() => assertArmHome(join(homedir(), '.codex')), /owner's Codex home/);
});

test('the proxy accepts every app of the 12 native claim tasks and nothing else, under the claim allowlist, without Always', async () => {
  const tasks = getTasks('world').filter(task => NATIVE.includes(task.id));
  assert.deepEqual(tasks.map(task => task.id).sort(), [...NATIVE].sort());
  const world = { BENCH_SUITE: 'world', BENCH_WORLD_TASKS: JSON.stringify(tasks.map(task => task.id)) };
  const schemas = [undefined, { properties: { remember: { enum: ['This session', 'Always'] } } },
    { properties: { choice: { enum: ['once', 'session', 'always'] } } }];
  const names = [...new Set(tasks.flatMap(task => task.allowedApps.filter(app => !/^(com|net)\./.test(app))))];
  assert.ok(['Calculator', 'TextEdit', 'Finder', 'Preview', 'Microsoft Word', 'Microsoft Excel', 'Visual Studio Code', 'Slack', 'Spotify'].every(app => names.includes(app)), names.join(', '));
  for (const app of names) for (const requestedSchema of schemas) {
    const answer = await answerElicitation({ message: `Allow Computer Use to use "${app}"?`, mode: 'form', requestedSchema }, { policy: 'bench', env: world });
    assert.equal(answer.action, 'accept', app);
    assert.ok(!('remember' in answer.content) && answer.content.choice !== 'always', `${app}: never Always`);
  }
  // sleight's own local-tool prompts in the words a Codex host gets
  for (const task of tasks) for (const message of [`Allow Codex Mcp Client to drag in ${task.app}? It can move the pointer.`,
    `Allow Codex Mcp Client to select a window in ${task.app}? It changes the app's main window without activating the app.`,
    `Allow Codex Mcp Client to open files in ${task.app}? It opens the file you name.`, `Allow Codex Mcp Client to use ${task.app}'s menu bar item?`])
    assert.equal((await answerElicitation({ message, mode: 'form' }, { policy: 'bench', env: world })).action, 'accept', message);
  for (const app of ['Terminal', 'Safari', 'Google Chrome', 'Firefox', 'Messages', 'Mail', 'Notes', 'ChatGPT', 'Codex', 'System Settings', 'Keychain Access']) {
    assert.equal((await answerElicitation({ message: `Allow Computer Use to use "${app}"?`, mode: 'form' }, { policy: 'bench', env: world })).action, 'decline', app);
    assert.equal((await answerElicitation({ message: `Allow Codex Mcp Client to drag in ${app}? x`, mode: 'form' }, { policy: 'bench', env: world })).action, 'decline', app);
  }
  for (const app of ['Visual Studio Code', 'Slack', 'Spotify', 'Microsoft Word'])
    assert.equal((await answerElicitation({ message: `Allow Computer Use to use "${app}"?`, mode: 'form' }, { policy: 'bench', env: {} })).action, 'decline', `${app} is a claim app only in the world suite`);
  assert.equal((await answerElicitation({ message: 'Allow Computer Use to use "Slack"?', mode: 'url' }, { policy: 'bench', env: world })).action, 'decline');
});

// A sleight-in-Codex rollout recorded on this Mac (2026-10-18 21:29Z, Codex 0.160.0), stripped to the fields the runner reads, and
// the exec stream rebuilt from its completed MCP calls. Codex is a script that prints that stream.
const recordedRun = (t, { model = 'gpt-6-luna', effort = 'high' } = {}) => {
  const dir = temporary(t), home = join(dir, 'home'), sessions = join(home, 'sessions', '2026', '10', '18');
  mkdirSync(sessions, { recursive: true });
  copyFileSync(fixture('codex-sleight-rollout.jsonl'), join(sessions, 'rollout-2026-10-18T21-29-13-0000-native-fixture.jsonl'));
  const codex = join(dir, 'codex');
  writeFileSync(codex, `#!/bin/sh\ncat ${JSON.stringify(fixture('codex-sleight-exec.jsonl'))}\n`); chmodSync(codex, 0o755);
  return runCodex('task', { cwd: dir, model, effort, timeoutMs: 10000, home, command: codex });
};

test('a run records the model, effort and CLI version Codex\'s own events name, and which server each call went to', async t => {
  const run = await recordedRun(t, { model: 'gpt-6.1-sol' });
  assert.equal(run.code, 0); assert.equal(run.groupClean, true);
  assert.deepEqual([run.modelRequested, run.modelsRan, run.effortRequested, run.effortsRan, run.codexCliVersion], ['gpt-6.1-sol', ['gpt-6.1-sol'], 'high', ['high'], '0.160.0']);
  assert.deepEqual(Object.keys(run.out.modelUsage), ['gpt-6.1-sol']);
  assert.equal(run.out.num_turns, 9, 'one token_count per model response');
  assert.deepEqual([run.toolCalls, run.toolServers], [7, { plugin_sleight_computer: 7 }]);
  assert.equal(run.out.result, 'Done.');
});

test('a run asked for one model that ran another is published with the one it ran', async t => {
  const run = await recordedRun(t, { model: 'gpt-6-luna' });
  assert.deepEqual([run.modelRequested, run.modelsRan, Object.keys(run.out.modelUsage)], ['gpt-6-luna', ['gpt-6.1-sol'], ['gpt-6.1-sol']]);
  assert.deepEqual(rolloutFacts(undefined), { models: [], efforts: [], cliVersion: undefined, requests: 0 });
  assert.deepEqual(rolloutFacts(['{"type":"session_meta","payload":{"cli_version":"0.160.0"}}', '{"type":"turn_context"', '']).cliVersion, '0.160.0', 'a cut line is skipped');
});

test('approvals.jsonl reaches the row beside its counts, without a hook\'s reason text', t => {
  const file = join(temporary(t), 'approvals.jsonl');
  const entries = [{ t: '2026-10-19T00:00:00.000Z', policy: 'bench', kind: 'elicitation', message: 'Allow Computer Use to use "Slack"?', action: 'accept' },
    { t: '2026-10-19T00:00:01.000Z', policy: 'bench', kind: 'elicitation', message: 'Allow Computer Use to use "Terminal"?', action: 'decline' },
    { t: '2026-10-19T00:00:02.000Z', policy: 'bench', kind: 'tool-refused', tool: 'select_window', reason: 'window title Example' }];
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const { log, ...counts } = approvalSummary(file, { log: true });
  assert.deepEqual(counts, { accepted: 1, declined: ['Allow Computer Use to use "Terminal"?'], toolsRefused: ['select_window'] });
  assert.deepEqual(log, entries.map(({ policy: _policy, reason: _reason, ...kept }) => kept));
  assert.equal('log' in approvalSummary(file), false, 'the race receipts keep their counts only');
  assert.ok(!existsSync(join(file, '..', 'preapproved.json')));
});

test('the scorer pairs each sleight-in-Codex arm with Codex on the same model, under the claim rules', () => {
  const rules = { files: [], tasks: ['a', 'b', 'c'], arms: ['sleight', 'codex', 'codex-sol', 'codex-sleight', 'codex-sleight-sol'] };
  const rows = (arm, seconds) => rules.tasks.flatMap((task, i) => [1, 2, 3].map(run => ({ arm, task, run, seconds: seconds[i], passed: true })));
  const table = score([...rows('codex', [40, 40, 40]), ...rows('codex-sleight', [20, 20, 50]), ...rows('codex-sleight-sol', [30, 30, 30])]);
  assert.deepEqual(SAME_MODEL, [['codex-sleight', 'codex'], ['codex-sleight-sol', 'codex-sol']]);
  const [luna, sol] = sameModel(table, rules);
  assert.deepEqual([luna.hosted, luna.base, luna.lowest, luna.totals], ['codex-sleight', 'codex', ['a', 'b'], { 'codex-sleight': 90, codex: 120 }]);
  assert.deepEqual(luna.pairs.map(pair => pair.arm), ['codex', 'codex', 'codex'], 'only its own model\'s baseline');
  assert.deepEqual([sol.wording, sol.reasons], ['no comparison', ['no runs for codex-sol']], 'a lone arm is never called faster');
  assert.deepEqual(Object.keys(claim(table, rules).totals), ['sleight', 'codex', 'codex-sleight', 'codex-sleight-sol'], 'the main claim still compares sleight with every arm');
  assert.deepEqual(warnings([{ arm: 'codex-sleight-max', task: 'a', file: 'f' }], rules, '9999'), ['codex-sleight-max has rows but is not in the rules\' arms, so it is not scored']);
  const exclusions = { ...rules, reasons: [], windows: [] };
  assert.equal(excluded({ arm: 'codex-sol', task: 'a', seconds: 30, modelMismatch: true }, 'f.json', exclusions), 'Codex ran another model or effort than its arm names');
  assert.equal(excluded({ arm: 'codex-sol', task: 'a', seconds: 30, effortMismatch: true }, 'f.json', exclusions), 'Codex ran another model or effort than its arm names');
  assert.equal(excluded({ arm: 'codex-sol', task: 'a', seconds: 30 }, 'f.json', exclusions), undefined);
});
