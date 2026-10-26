// sleight as a Codex plugin (ROADMAP 4c): the Codex manifest, MCP config and marketplace beside Claude's, the skill naming
// the same tools on both hosts, Codex's turn-end hooks into the relay, the host label, and the doctor's Codex lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexServerKey } from '../bench/codex-sleight.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { hostWording } from '../plugins/sleight/lib/launch.mjs';
import { hostLabel, validHostLabel } from '../plugins/sleight/lib/host-label.mjs';
import { codexDoctorLines, codexStatus, pluginStates, BUNDLED_OFF_FOR_SESSION, CODEX_INSTALL } from '../plugins/sleight/lib/codex-host.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const plugin = join(repo, 'plugins/sleight');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const fixture = name => fileURLToPath(new URL(`fixtures/codex/${name}`, import.meta.url));
const shape = json(fixture('plugin-shape.json'));
const codex = json(join(plugin, '.codex-plugin/plugin.json'));
const claude = json(join(plugin, '.claude-plugin/plugin.json'));
const codexMcp = json(join(plugin, codex.mcpServers));
const SERVER = 'plugin:sleight:computer'; // Claude Code's name for the plugin's `computer` server
const inside = path => { const full = join(plugin, path); assert.ok(full.startsWith(plugin + '/'), path); return full; };

test('the Codex manifest has the installed plugins\' shape and matches the Claude manifest', () => {
  for (const key of Object.keys(codex)) assert.ok(shape.manifestKeys.includes(key), `unknown manifest key ${key}`);
  for (const key of Object.keys(codex.interface)) assert.ok(shape.interfaceKeys.includes(key), `unknown interface key ${key}`);
  for (const key of ['name', 'version', 'license', 'homepage', 'repository']) assert.deepEqual(codex[key], claude[key], key);
  assert.deepEqual(codex.author, claude.author);
  assert.ok(codex.interface.capabilities.every(c => shape.capabilities.includes(c)));
  assert.ok(statSync(inside(codex.skills)).isDirectory());
  // Reviewer-observed on Codex 0.164.0, not an upstream-documented single-skill path contract.
  assert.equal(codex.skills, './skills/drive-mac-apps/');
  assert.ok(statSync(join(inside(codex.skills), 'SKILL.md')).isFile());
  assert.equal(existsSync(join(plugin, 'skills/make-character/agents/openai.yaml')), false);
  assert.ok(statSync(inside(codex.interface.logo)).isFile());
  assert.match(codex.interface.brandColor, /^#[0-9A-F]{6}$/);
  assert.doesNotMatch(JSON.stringify(codex), /Claude/, 'the Codex manifest speaks to Codex users');
});

test('one launcher serves both hosts, under the server key that gives the same tool names', () => {
  // Claude names the plugin's tools mcp__plugin_sleight_computer__<tool>; Codex names a plugin's tools mcp__<key>__<tool>.
  assert.deepEqual(Object.keys(codexMcp.mcpServers), [codexServerKey(SERVER)]);
  const server = codexMcp.mcpServers[codexServerKey(SERVER)];
  for (const key of Object.keys(server)) assert.ok(shape.mcpServerKeys.includes(key), `unknown server key ${key}`);
  assert.equal(claude.mcpServers.computer.command, '${CLAUDE_PLUGIN_ROOT}/bin/sleight-mcp');
  // Codex resolves a plugin stdio command as a contained ./ path from cwd "." (the plugin root), as it ran it in a throwaway home.
  assert.equal(server.command, './bin/sleight-mcp');
  assert.equal(server.cwd, '.');
  accessSync(inside(server.command), constants.X_OK);
  // Turbo is on in Codex too: its prompt hook binds each turn (tests/codex-turbo.test.mjs). A user's SLEIGHT_TURBO=0 still applies.
  assert.equal(server.env, undefined);
  // Codex hands a stdio server only a short env list; a documented setting the user exports reaches sleight as under Claude.
  // Every documented setting is forwarded, so a tightening one such as SLEIGHT_GUARD=careful isn't dropped. The only
  // exceptions: the benchmark and test switches.
  const NOT_FORWARDED = { SLEIGHT_ARM_DIR: 'benchmark arms only',
    SLEIGHT_BENCH_API_CAP_USD: 'benchmark arms only', SLEIGHT_STUB_OSASCRIPT: 'tests only' };
  const documented = [...new Set(readFileSync(join(repo, 'docs/settings.md'), 'utf8').match(/SLEIGHT_[A-Z0-9_]+/g))]
    .filter(name => !Object.hasOwn(NOT_FORWARDED, name)).toSorted();
  assert.deepEqual(server.env_vars.filter(name => name.startsWith('SLEIGHT_')).toSorted(), documented);
  assert.deepEqual(server.env_vars.filter(name => !name.startsWith('SLEIGHT_')), ['CODEX_HOME']);
  // A plugin-root .mcp.json would be read by Claude Code as a second server beside the manifest's.
  assert.equal(existsSync(join(plugin, '.mcp.json')), false);
});

test('Codex reads hooks from the manifest, never the Claude mod\'s hooks/hooks.json', () => {
  assert.ok(codex.hooks?.hooks, 'without an inline hooks object Codex falls back to hooks/hooks.json');
  assert.deepEqual(json(join(plugin, 'hooks/hooks.json')), { modules: ['./register.tsx'] });
});

// What each Claude-side hook does and where it lands in Codex. Kept here so a new mod hook needs a decision.
const PARITY = {
  'turn.complete (Stop)': { codex: 'Stop', tool: 'turn_ended' },
  'turn.complete (aborted)': { codex: 'Interrupt', tool: 'turn_ended' },
  'turn.complete (subagent: skipped)': { codex: null, why: 'the mod ends only the main turn; SubagentStop is left unmapped to match' },
  'tool.call turn_ended deny': { codex: null, why: 'the engine marks turn_ended hidden and the relay keeps the mark outside Claude' },
  'prompt.submit (turbo begin)': { codex: 'UserPromptSubmit', tool: 'turn_started' },
  'prompt.submit (stop lift)': { codex: null, why: 'no /sleight stop in Codex' },
  'classic.PreToolUse preapproved guard': { codex: null, why: 'needs a command hook; the skill tells the model never to edit the file' },
  'session.start /sleight command, pane, status line': { codex: null, why: 'Codex has no plugin UI surface for them' },
};
test('the Codex hooks map the mod\'s turn end onto turn_ended and its turbo begin onto turn_started', () => {
  const events = Object.keys(codex.hooks.hooks);
  assert.deepEqual(events.toSorted(), Object.values(PARITY).map(row => row.codex).filter(Boolean).toSorted());
  for (const event of events) {
    assert.ok(shape.hookEvents.includes(event), event);
    const handlers = codex.hooks.hooks[event].flatMap(group => group.hooks);
    assert.equal(handlers.length, 1);
    const [handler] = handlers;
    for (const key of Object.keys(handler)) assert.ok(shape.mcpToolHandlerKeys.includes(key), key);
    assert.equal(handler.type, 'mcp_tool');
    assert.equal(handler.server, codexServerKey(SERVER));
    assert.equal(handler.tool, Object.values(PARITY).find(row => row.codex === event).tool);
    // The relay fills in its own session and turn ids, so a turn-end hook passes only which event ended the turn.
    // The prompt hook's input is checked in tests/codex-turbo.test.mjs.
    if (handler.tool === 'turn_ended') assert.deepEqual(handler.input, { hook_event_name: '${hook_event_name}' });
  }
  // Codex clamps an Interrupt hook to 3 seconds (it turned 10 into 3 in the throwaway home).
  assert.ok(codex.hooks.hooks.Interrupt[0].hooks[0].timeout <= 3);
  // Codex's own parse of these hooks matches.
  const listed = json(fixture('hooks-list.json'));
  assert.deepEqual(listed.errors, []);
  assert.deepEqual(listed.hooks.map(h => [h.eventName, h.server, h.tool, h.timeoutSec]),
    events.map(event => [event[0].toLowerCase() + event.slice(1), codexServerKey(SERVER), codex.hooks.hooks[event][0].hooks[0].tool,
      codex.hooks.hooks[event][0].hooks[0].timeout]));
});

test('the repo is a Codex marketplace whose sleight entry is the plugin folder', () => {
  const market = json(join(repo, '.agents/plugins/marketplace.json'));
  const claudeMarket = json(join(repo, '.claude-plugin/marketplace.json'));
  assert.equal(market.name, claudeMarket.name, 'one install name on both hosts: sleight@sleight');
  assert.equal(market.plugins.length, 1);
  const [entry] = market.plugins;
  for (const key of Object.keys(entry)) assert.ok(shape.marketplaceEntryKeys.includes(key), key);
  assert.equal(entry.name, codex.name);
  assert.equal(entry.source.source, 'local');
  assert.equal(join(repo, entry.source.path), plugin);
  assert.ok(shape.marketplacePolicy.installation.includes(entry.policy.installation));
  assert.ok(shape.marketplacePolicy.authentication.includes(entry.policy.authentication));
  assert.equal(CODEX_INSTALL, `codex plugin marketplace add Land-o-Clusters/sleight && codex plugin add ${entry.name}@${market.name}`);
});

test('the skill names the tools each host lists', () => {
  const prefix = `mcp__${codexServerKey(SERVER)}__`;
  assert.equal(prefix, `mcp__${Object.keys(codexMcp.mcpServers)[0]}__`, 'Claude Code and Codex prefixes agree');
  for (const file of ['SKILL.md', 'SKILL.lean.md']) {
    const text = readFileSync(join(plugin, 'skills/drive-mac-apps', file), 'utf8');
    for (const name of text.match(/mcp__[A-Za-z0-9_-]+?__/g) ?? []) assert.equal(name, prefix, `${file} names ${name}`);
    assert.doesNotMatch(text, /(?:^|\s)\/sleight\b|Claude Code|the mod\b/, `${file} stays host-neutral`);
  }
  const skill = readFileSync(join(plugin, 'skills/drive-mac-apps/SKILL.md'), 'utf8');
  const front = /^---\n([\s\S]*?)\n---/.exec(skill)[1];
  assert.match(front, /^name: drive-mac-apps$/m, 'Codex lists the skill as sleight:drive-mac-apps');
  const description = /^description: (.*)$/m.exec(front)[1];
  assert.ok(description.length <= 1024);
  assert.ok(description.includes(`\`${prefix}*\``), 'with two computer-use surfaces the listing points at sleight\'s tools');
});

// The relay under a host without the mod (Codex's clientInfo), against a fake engine.
function harness(t, modHost) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const toServer = [], toClient = [];
  for (const [stream, records] of [[serverIn, toServer], [clientOut, toClient]])
    stream.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => records.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, modHost: () => modHost });
  t.after(() => relay.close());
  const send = (stream, msg) => stream.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  return { toServer, toClient, client: msg => send(clientIn, msg), engine: msg => send(serverOut, msg) };
}
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const ENGINE_TOOLS = [{ name: 'js', description: 'Run.', inputSchema: { type: 'object' } },
  { name: 'turn_ended', description: 'Internal.', inputSchema: { type: 'object' }, _meta: { ui: { visibility: [] } } }];

for (const mod of [false, true]) test(`turn_ended ${mod ? 'loses' : 'keeps'} the engine's hidden mark ${mod ? 'under the mod' : 'in Codex'}`, async t => {
  const h = harness(t, mod);
  h.client({ id: 1, method: 'tools/list' });
  await tick();
  h.engine({ id: h.toServer.at(-1).id, result: { tools: ENGINE_TOOLS } });
  await tick();
  const listed = h.toClient.at(-1).result.tools.find(tool => tool.name === 'turn_ended');
  assert.deepEqual(listed._meta?.ui, mod ? undefined : { visibility: [] });
});

test('Codex\'s Stop hook ends a used turn through the engine and answers an unused one itself', async t => {
  const h = harness(t, false);
  const hook = id => h.client({ id, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Stop' } } });
  hook(1); await tick();
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0, 'a turn sleight sat out never reaches the engine');
  assert.deepEqual(h.toClient.find(m => m.id === 1).result, { content: [] });
  h.client({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }); await tick();
  const meta = JSON.parse(h.toServer.at(-1).params._meta['x-codex-turn-metadata']);
  h.engine({ id: 2, result: { content: [{ type: 'text', text: '2' }] } }); await tick();
  hook(3); await tick();
  const end = h.toServer.findLast(m => m.params?.name === 'turn_ended');
  assert.deepEqual(end.params.arguments, { hook_event_name: 'Stop', session_id: meta.session_id, turn_id: meta.turn_id });
  // Interrupt carries its own event name through.
  h.engine({ id: end.id, result: { content: [] } }); await tick();
  h.client({ id: 4, method: 'tools/call', params: { name: 'js', arguments: { code: '2 + 2' } } }); await tick();
  h.engine({ id: 4, result: { content: [{ type: 'text', text: '4' }] } }); await tick();
  h.client({ id: 5, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } }); await tick();
  assert.equal(h.toServer.findLast(m => m.params?.name === 'turn_ended').params.arguments.hook_event_name, 'Interrupt');
});

test('under the mod an unused turn_ended still reaches the engine, as before', async t => {
  const h = harness(t, true);
  h.client({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Stop' } } }); await tick();
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 1);
});

test('the host label and wording come from each host\'s own clientInfo, and no host reports a model', () => {
  const { hosts } = json(fixture('host-client-info.json'));
  for (const row of hosts) {
    const label = hostLabel(row.clientInfo ?? undefined);
    assert.equal(label ?? null, row.label, row.host);
    if (label) assert.ok(validHostLabel(label), row.host);
    assert.doesNotMatch(String(label), /gpt|claude-|model/i, 'never a model');
    if (!['odd', 'absent'].includes(row.host)) assert.equal(hostWording(row.clientInfo, {}).host, row.wording, row.host);
    assert.equal(hostWording(row.clientInfo ?? undefined, {}).claudeCode, row.modHost, row.host);
  }
  assert.equal(validHostLabel('Codex\n0.160.0'), false);
  assert.equal(validHostLabel('x'.repeat(73)), false);
});

const status = name => codexStatus({ env: { CODEX_HOME: '/codex-fixture' }, read: () => readFileSync(fixture(name), 'utf8'),
  exists: path => path.endsWith('/sleight/sleight'), list: () => ['1.3.0'] });
test('the Codex config reader takes plugin tables only', () => {
  const states = pluginStates(readFileSync(fixture('config-both-on.toml'), 'utf8'));
  assert.deepEqual([...states], [['sleight@sleight', true], ['computer-use@openai-bundled', true], ['unified-computer-use@openai-bundled', true]]);
});
test('doctor reports sleight in Codex and Codex\'s own Computer Use beside it', () => {
  assert.deepEqual(codexDoctorLines(status('config-both-on.toml')), ['Codex',
    'ok        sleight is installed and enabled in Codex (sleight@sleight 1.3.0)',
    "note      Codex's own Computer Use is also on (computer-use@openai-bundled, unified-computer-use@openai-bundled). sleight's skill tells the model to use sleight's tools.",
    `          To start Codex without it: ${BUNDLED_OFF_FOR_SESSION}`]);
  assert.deepEqual(codexDoctorLines(status('config-sleight-only.toml')), ['Codex',
    'ok        sleight is installed and enabled in Codex (sleight@sleight-dev)', "ok        Codex's own Computer Use plugin is off"]);
  assert.deepEqual(codexDoctorLines(status('config-sleight-off.toml')), ['Codex',
    "note      sleight is installed in Codex but turned off (sleight@sleight). Turn it on in Codex's Plugins settings.",
    "note      Codex's own Computer Use is also on (unified-computer-use@openai-bundled)."]);
  assert.deepEqual(codexDoctorLines(status('config-none.toml')), ['Codex',
    `note      sleight isn't installed in Codex. To add it: ${CODEX_INSTALL}`, "ok        Codex's own Computer Use plugin is off"]);
  const missing = codexStatus({ env: { CODEX_HOME: '/no-codex' }, read: () => { throw Error('ENOENT'); } });
  assert.deepEqual(codexDoctorLines(missing), ['Codex', `note      no Codex config at /no-codex/config.toml. To use sleight in Codex: ${CODEX_INSTALL}`]);
});

// Review fixes (2026-10-19).
test('only a positive Claude Code signal counts as the mod\'s host, and every other host gets the relay\'s own guards', () => {
  // The CLI and the desktop app's Code tab both send name "claude-code". A lookalike name doesn't count.
  for (const [info, env, want] of [
    [{ name: 'claude-code', version: '2.1.299' }, {}, true],
    [{ name: 'claude-desktop' }, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, false],
    [{ name: 'Claude' }, {}, false],
    [{ name: 'codex-mcp-client', title: 'Codex' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, false],
    [undefined, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, true],
    [{ title: 'No name' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, true],
    [undefined, {}, false],
  ]) assert.equal(hostWording(info, env).claudeCode, want, JSON.stringify([info, env]));
});

test('Always counts only from the user: no reviewer marker, or the marker user', async t => {
  const added = [];
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const toServer = [], toClient = [];
  for (const [stream, records] of [[serverIn, toServer], [clientOut, toClient]])
    stream.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => records.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, modHost: () => false,
    alwaysAllow: (app, riskLevel) => added.push([app, riskLevel]) });
  t.after(() => relay.close());
  const send = (stream, msg) => stream.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  send(clientIn, { id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } },
    clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.0' } } });
  const ask = (id, app) => send(serverOut, { id, method: 'elicitation/create', params: { mode: 'form', message: `Allow Computer Use to use "${app}"?`,
    requestedSchema: { type: 'object', properties: {} }, _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'low', tool_params: { app } } } });
  ask('a1', 'TextEdit'); await tick();
  const form = toClient.find(m => m.id === 'a1');
  assert.ok(form.params.requestedSchema.properties.remember, 'the user\'s form offers Always');
  // Always counts only when Codex says nothing about a reviewer or says the user answered; any other marker is a session allow.
  const cases = [['TextEdit', { approvals_reviewer: 'auto_review' }, false], ['Notes', undefined, true], ['Mail', { approvals_reviewer: 'user' }, true],
    ['Maps', { approvals_reviewer: 'guardian_subagent' }, false], ['Music', { approvals_reviewer: null }, false]];
  for (const [n, [app, meta, written]] of cases.entries()) {
    if (n) { ask('a' + (n + 1), app); await tick(); }
    send(clientIn, { id: 'a' + (n + 1), result: { action: 'accept', content: { remember: 'Always' }, ...(meta ? { _meta: meta } : {}) } }); await tick();
    assert.equal(added.some(([name]) => name === app), written, JSON.stringify(meta));
    const answer = toServer.find(m => m.id === 'a' + (n + 1));
    assert.equal(answer.result.action, 'accept', 'still allowed for the session');
    assert.equal('remember' in answer.result.content, false);
  }
});

test('a change in Codex\'s sandbox state means a new engine kernel: full guard setup, and the relay\'s own calls follow it', async () => {
  const { GUARD_READY } = await import('../plugins/sleight/lib/document-scope.mjs');
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, warmRepl: true, changeReview: false, modHost: () => false });
  try {
    const send = msg => clientIn.write(JSON.stringify(msg) + '\n'), respond = msg => serverOut.write(JSON.stringify(msg) + '\n');
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client' } } }); respond({ id: 1, result: { capabilities: {} } });
    send({ method: 'notifications/initialized' }); await tick();
    const warm = sent.find(m => String(m.id).startsWith('sleight-warm-'));
    respond({ id: warm.id, result: { content: [{ type: 'text', text: GUARD_READY }] } }); await tick();
    const sandbox = { 'codex/sandbox-state': { permissionProfile: 'workspace-write' }, 'codex/sandbox-state-meta': { permissionProfile: 'workspace-write' } };
    send({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("Calculator");' },
      _meta: { callId: 'c1', threadId: 't1', ...sandbox } } }); await tick();
    const first = sent.find(m => m.id === 2);
    assert.match(first.params.arguments.code, /globalThis\.__sleightDocumentGuardSetup = /, 'the warm kernel had no sandbox: install the guard again');
    assert.deepEqual(first.params._meta['codex/sandbox-state'], sandbox['codex/sandbox-state']);
    respond({ id: 2, result: { content: [{ type: 'text', text: 'Window: "Calculator", App: Calculator.\n' + GUARD_READY }] } }); await tick();
    send({ id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.click({ id: "One" });' }, _meta: { callId: 'c2', ...sandbox } } }); await tick();
    assert.doesNotMatch(sent.find(m => m.id === 3).params.arguments.code, /globalThis\.__sleightDocumentGuardSetup = /, 'same kernel: setup reused');
    // The relay's own engine calls carry the same sandbox state, so they reach the same kernel.
    const own = sent.filter(m => typeof m.id === 'string' && m.method === 'tools/call' && m.params.name === 'js' && !String(m.id).startsWith('sleight-warm-'));
    for (const call of own) assert.deepEqual(call.params._meta['codex/sandbox-state'], sandbox['codex/sandbox-state'], call.params.arguments.title);
  } finally { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); }
});

function leaseHarness(t, inputLease) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const toServer = [], toClient = [];
  for (const [stream, records] of [[serverIn, toServer], [clientOut, toClient]])
    stream.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => records.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, modHost: () => false, ...(inputLease ? { inputLease } : {}) });
  t.after(() => relay.close());
  const send = (stream, msg) => stream.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  return { toServer, toClient, client: msg => send(clientIn, msg), engine: msg => send(serverOut, msg) };
}
const fakeLease = () => ({ acquire: () => 'fixture-key', renew() {}, grant() {}, close() {} });
test('an Interrupt hook during a running call is answered at once and ends the turn when the call finishes', async t => {
  const h = leaseHarness(t, fakeLease());
  h.client({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getState()' } } }); await tick();
  assert.ok(h.toServer.some(m => m.id === 1), 'the call is running');
  h.client({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } }); await tick();
  assert.deepEqual(h.toClient.find(m => m.id === 2).result, { content: [] }, 'within Codex\'s 3-second hook limit');
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0, 'not while the call runs');
  h.engine({ id: 1, result: { isError: true, content: [{ type: 'text', text: 'cancelled' }] } }); await tick(); await tick();
  const end = h.toServer.findLast(m => m.params?.name === 'turn_ended');
  assert.equal(end?.params.arguments.hook_event_name, 'Interrupt');
});
test('without an input lease an Interrupt is not answered early, so nobody ends a turn under a running call that way', async t => {
  const h = leaseHarness(t);
  h.client({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getState()' } } }); await tick();
  h.client({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } }); await tick();
  assert.notDeepEqual(h.toClient.find(m => m.id === 2)?.result, { content: [] });
});

test('an unused turn\'s hook still lets go of any input lease, and an unexpanded event name reads as Stop', async t => {
  let closed = 0;
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const toServer = [], toClient = [];
  for (const [stream, records] of [[serverIn, toServer], [clientOut, toClient]])
    stream.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => records.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, modHost: () => false,
    inputLease: { close() { closed++; }, acquire() { return 'k'; }, renew() { return true; }, current() { return undefined; } } });
  t.after(() => relay.close());
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Stop' } } }) + '\n'); await tick();
  assert.ok(closed >= 1);
  const h = harness(t, false);
  h.client({ id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } }); await tick();
  h.engine({ id: 3, result: { content: [{ type: 'text', text: '1' }] } }); await tick();
  h.client({ id: 4, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: '${hook_event_name}' } } }); await tick();
  assert.equal(h.toServer.findLast(m => m.params?.name === 'turn_ended').params.arguments.hook_event_name, 'Stop');
});

test('stop and resume, the user\'s own controls, work on every host; only a turbo turn needs the mod', async t => {
  for (const mod of [false, true]) {
    const h = harness(t, mod);
    h.client({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_resume: true } } }); await tick();
    assert.deepEqual(h.toClient.find(m => m.id === 1).result, { content: [] }, `resume with mod ${mod}`);
    h.client({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } }); await tick();
    assert.notEqual(h.toClient.find(m => m.id === 2)?.result?.content?.[0]?.text, 'Trusted turn binding unavailable.', `stop with mod ${mod}`);
    h.client({ id: 3, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: { event: 'bootstrap' } } } }); await tick();
    // Since RA1 the mod's host gets the envelope without a turbo bridge, for typed app approvals. Codex never does.
    assert.equal(h.toClient.find(m => m.id === 3).result.isError, !mod, 'no host without the mod gets the private envelope');
  }
});

test('the doctor reads dotted plugin keys too', () => {
  const states = pluginStates('plugins."computer-use@openai-bundled".enabled = false\n\n[plugins]\n"sleight@sleight".enabled = true\n');
  assert.equal(states.get('sleight@sleight'), true);
  assert.equal(states.get('computer-use@openai-bundled'), false);
});

test('the kernel identity is the sandbox policy itself: key order and launcher changes keep handles and setup', async () => {
  const { GUARD_READY } = await import('../plugins/sleight/lib/document-scope.mjs');
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, modHost: () => false });
  try {
    const call = (id, meta, code = 'await cua.getState();') => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code }, _meta: meta } }) + '\n');
    const respond = id => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text: GUARD_READY }] } }) + '\n');
    const full = id => /globalThis\.__sleightDocumentGuardSetup = /.test(sent.find(m => m.id === id).params.arguments.code);
    const kernel = id => /__sleightGuardKernel = (\d+)/.exec(sent.find(m => m.id === id).params.arguments.code)?.[1];
    const A = { permissionProfile: 'workspace-write', sandboxCwd: '/p' }, A2 = { sandboxCwd: '/p', permissionProfile: 'workspace-write' };
    const B = { permissionProfile: 'danger-full-access', sandboxCwd: '/p' };
    call(1, { 'codex/sandbox-state': A, 'codex/sandbox-launcher': { codexExecutable: '/a/codex' } }); await tick(); respond(1); await tick();
    assert.ok(full(1)); const a = kernel(1);
    call(2, { 'codex/sandbox-state-meta': A2, 'codex/sandbox-launcher': { codexExecutable: '/b/codex' } }); await tick(); respond(2); await tick();
    assert.equal(full(2), false, 'same policy, other key order and launcher: same kernel');
    call(3, { 'codex/sandbox-state': B }); await tick(); respond(3); await tick();
    assert.ok(full(3)); const b = kernel(3);
    call(4, { 'codex/sandbox-state': A }); await tick(); respond(4); await tick();
    assert.ok(full(4), 'back to A: set up again');
    const back = kernel(4);
    assert.ok(a && b && back && new Set([a, b, back]).size === 3, 'each switch gets a new kernel epoch, so A\'s old guard state is replaced');
    call(5, {}); await tick(); respond(5); await tick();
    assert.ok(full(5), 'a call without sandbox state after calls with it is another kernel');
  } finally { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); }
});

test('in the kernel, setup for a newer epoch replaces old guard state and keeps the raw getApp; the same epoch keeps it', async () => {
  const { readCode } = await import('../plugins/sleight/lib/document-scope.mjs');
  const { createContext, runInContext } = await import('node:vm');
  const raw = async name => ({ name, getAXState: async () => 'Window: "W", App: X.' });
  const context = createContext({ cua: { getApp: raw, listApps: async () => [] }, nodeRepl: { write() {} } });
  const run = code => runInContext('(async () => {' + code + '})()', context);
  await run(readCode('void 0;', { kernel: 1 }));
  runInContext('globalThis.__sleightDocumentGuard.marker = "A1"', context);
  await run(readCode('void 0;', { kernel: 1 }));
  assert.equal(runInContext('globalThis.__sleightDocumentGuard.marker', context), 'A1', 'same epoch keeps state');
  await run(readCode('void 0;', { kernel: 3 }));
  assert.equal(runInContext('globalThis.__sleightDocumentGuard.marker', context), undefined, 'newer epoch starts clean');
  assert.equal(runInContext('globalThis.__sleightDocumentGuard.getApp.name', context), 'bound raw', 'the raw getApp, not a wrapper');
});

test('a sandbox state that arrives while the warm-up is still running gets the full setup', async () => {
  const { GUARD_READY } = await import('../plugins/sleight/lib/document-scope.mjs');
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, warmRepl: true, changeReview: false, modHost: () => false });
  try {
    const send = msg => clientIn.write(JSON.stringify(msg) + '\n'), respond = msg => serverOut.write(JSON.stringify(msg) + '\n');
    send({ id: 1, method: 'initialize', params: {} }); respond({ id: 1, result: { capabilities: {} } }); send({ method: 'notifications/initialized' }); await tick();
    const warm = sent.find(m => String(m.id).startsWith('sleight-warm-'));
    send({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("Calculator");' }, _meta: { 'codex/sandbox-state': { p: 1 } } } }); await tick();
    assert.equal(sent.some(m => m.id === 2), false, 'held behind the warm-up');
    respond({ id: warm.id, result: { content: [{ type: 'text', text: GUARD_READY }] } }); await tick(); await tick();
    assert.match(sent.find(m => m.id === 2).params.arguments.code, /globalThis\.__sleightDocumentGuardSetup = /);
  } finally { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); }
});
