// Turbo inside Codex (1.3.1): Codex's UserPromptSubmit hook binds each turbo turn to the user's own message through a
// tool the model can't see or call, the Stop and Interrupt hooks release it, and Claude Code's path stays byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createV3Bridge, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { requestedPayment } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { prepareInstalledStartup } from '../plugins/sleight/lib/launch.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { codexServerKey } from '../bench/codex-sleight.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const plugin = join(repo, 'plugins/sleight');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const fixturePath = name => fileURLToPath(new URL(`fixtures/codex/${name}`, import.meta.url));
const codex = json(join(plugin, '.codex-plugin/plugin.json'));
const KEY = codexServerKey('plugin:sleight:computer');

const CODEX = { name: 'codex-mcp-client', title: 'Codex', version: '0.160.0' };
const CLAUDE = { name: 'claude-code', title: 'Claude Code', version: '2.1.289' };
const SESSION = '019a0000-0000-7000-8000-000000000001';
const ENGINE_TOOLS = [{ name: 'js', description: 'Run.', inputSchema: { type: 'object' } },
  { name: 'turn_ended', description: 'Internal.', inputSchema: { type: 'object' }, _meta: { ui: { visibility: [] } } }];

// A worker over a fake fork channel, as tests/direct-browser-v3-worker.test.mjs builds it, recording what reaches it.
async function worker() {
  const child = new EventEmitter(), endpoint = new EventEmitter(), events = [];
  child.connected = endpoint.connected = true;
  child.send = value => { queueMicrotask(() => endpoint.emit('message', structuredClone(value))); };
  endpoint.send = value => { queueMicrotask(() => child.emit('message', structuredClone(value))); };
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const session = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin(message, _binding, extra) {
    events.push(['begin', message.text, extra.host]);
    return { async call(request) { events.push(['call', request.name]); return { text: 'plain result', isError: false }; },
      delivered() { return true; },
      async end() { events.push(['end']); return { revoked: true, cleanup: [] }; } };
  } });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker() { queueMicrotask(() => session.ready()); return child; } });
  return { bridge, events };
}

async function harness(t, { clientInfo = CODEX, mod = false, turbo = true } = {}) {
  const w = turbo ? await worker() : { events: [] };
  const prepared = turbo ? await prepareInstalledStartup(() => w.bridge) : {};
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const toClient = [], toServer = [];
  clientOut.on('data', bytes => toClient.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', bytes => toServer.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, ...prepared, changeReview: false, modHost: () => mod,
    sessionId: '00000000-0000-4000-8000-00000000000a' });
  t.after(async () => { relay.dispose(); await w.bridge?.detach(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
  const client = async msg => { clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); await settle(); };
  const engine = async msg => { serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); await settle(); };
  if (clientInfo !== null) {
    await client({ id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo } });
    await engine({ id: 'init', result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'engine' } } });
  }
  const reply = id => toClient.find(m => m.id === id);
  return { ...w, toClient, toServer, client, engine, reply, raw: text => clientIn.write(text) };
}

// What Codex's hook runner sends: the template expanded from the event, and _meta with only the thread id
// (openai/codex 0.160.0, core/src/hook_mcp_executor.rs). A model's call always carries _meta.callId.
const hookCall = (id, { turn = 'turn-1', prompt = 'Read the page', session = SESSION, meta = { threadId: session }, args } = {}) => ({
  id, method: 'tools/call', params: { name: 'turn_started',
    arguments: args ?? { hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: turn, prompt }, ...(meta ? { _meta: meta } : {}) } });
const stopHook = (id, event = 'Stop') => ({ id, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: event }, _meta: { threadId: SESSION } } });
// A model call as Codex sends it: callId, the thread, and the turn metadata naming the turn (core/src/mcp_tool_call.rs).
const read = (id, { turn = 'turn-1', thread = SESSION } = {}) => ({ id, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' },
  _meta: { callId: `c${id}`, threadId: thread, sessionId: SESSION, 'x-codex-turn-metadata': { session_id: SESSION, thread_id: thread, turn_id: turn } } } });
const begins = events => events.filter(row => row[0] === 'begin');

test('the Codex manifest binds turbo through a UserPromptSubmit hook that passes the user\'s prompt to a hidden tool', () => {
  const [group] = codex.hooks.hooks.UserPromptSubmit;
  assert.equal(group.hooks.length, 1);
  const [hook] = group.hooks;
  assert.equal(hook.type, 'mcp_tool');
  assert.equal(hook.server, KEY);
  assert.equal(hook.tool, 'turn_started');
  // Codex expands ${field} from the hook's own event (hooks/src/engine/mcp_runner.rs); prompt is the user's message.
  assert.deepEqual(hook.input, { hook_event_name: '${hook_event_name}', session_id: '${session_id}', turn_id: '${turn_id}', prompt: '${prompt}' });
  assert.ok(hook.timeout >= 10 && hook.timeout <= 30);
  assert.equal(hook.statusMessage, undefined, 'no status line on every prompt');
  // Stop and Interrupt still end the turn, and with it the turbo binding.
  for (const event of ['Stop', 'Interrupt']) assert.equal(codex.hooks.hooks[event][0].hooks[0].tool, 'turn_ended');
  // Turbo is on in Codex: the server no longer pins SLEIGHT_TURBO=0, and a user's own SLEIGHT_TURBO=0 still reaches it.
  const server = json(join(plugin, codex.mcpServers)).mcpServers[KEY];
  assert.equal(server.env?.SLEIGHT_TURBO, undefined);
  assert.ok(server.env_vars.includes('SLEIGHT_TURBO'));
});

test('Codex lists turbo\'s five tools and a turn_started hidden from the model; Claude Code and other hosts list no turn_started', async t => {
  for (const [label, clientInfo, mod, turboListed, startListed] of [
    ['Codex', CODEX, false, true, true], ['Claude Code', CLAUDE, true, true, false], ['Cursor', { name: 'cursor' }, false, false, false],
    ['Codex 0.159', { ...CODEX, version: '0.159.9' }, false, false, false],
  ]) {
    const h = await harness(t, { clientInfo, mod });
    await h.client({ id: 1, method: 'tools/list' });
    await h.engine({ id: h.toServer.at(-1).id, result: { tools: ENGINE_TOOLS } });
    const names = h.reply(1).result.tools.map(tool => tool.name);
    assert.equal(names.includes('browser_read'), turboListed, label);
    const start = h.reply(1).result.tools.find(tool => tool.name === 'turn_started');
    assert.equal(!!start, startListed, label);
    if (start) {
      // Codex leaves a tool whose ui.visibility lacks "model" out of the model's tools and refuses a model call to it
      // (codex-mcp/src/binding.rs prepare_call), while hooks still call it.
      assert.deepEqual(start._meta.ui, { visibility: [] });
      assert.equal(start._meta['anthropic/alwaysLoad'], undefined);
    }
  }
});

test('the hook\'s call binds a turbo turn to the user\'s own prompt, and turbo\'s tools then reach the worker', async t => {
  const h = await harness(t);
  await h.client(read(1));
  assert.deepEqual(h.events, [], 'nothing reaches the worker before a bound turn');
  await h.client(hookCall(2, { prompt: 'Pay "$5.00" for "Coffee" to "Cafe" with "Visa"' }));
  assert.deepEqual(h.reply(2).result, { content: [] }, 'nothing in the reply: Codex would hand hook text to the model as context');
  assert.deepEqual(begins(h.events), [['begin', 'Pay "$5.00" for "Coffee" to "Cafe" with "Visa"', 'Codex 0.160.0']]);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_started').length, 0, 'never forwarded to the engine');
  await h.client(read(3));
  assert.equal(h.reply(3).result.isError, false);
  assert.deepEqual(h.events.at(-1), ['call', 'browser_read']);
  // The text reaching the worker is the one its payment grammar reads.
  assert.deepEqual(requestedPayment('Pay "$5.00" for "Coffee" to "Cafe" with "Visa"'),
    { amount: '$5.00', item: 'Coffee', payee: 'Cafe', method: 'Visa' });
});

test('a call shaped like the model\'s, a subagent\'s or a stale one never binds a turn', async t => {
  const cases = [
    ['a model call carries callId', hookCall(1, { meta: { threadId: SESSION, callId: 'call_1' } })],
    ['no _meta', hookCall(1, { meta: null })],
    ['a subagent thread: threadId is not the session', hookCall(1, { meta: { threadId: '019a0000-0000-7000-8000-0000000000ff' } })],
    ['another event name', hookCall(1, { args: { hook_event_name: 'Stop', session_id: SESSION, turn_id: 't', prompt: 'x' } })],
    ['an extra argument', hookCall(1, { args: { hook_event_name: 'UserPromptSubmit', session_id: SESSION, turn_id: 't', prompt: 'x', text: 'y' } })],
    ['a missing prompt', hookCall(1, { args: { hook_event_name: 'UserPromptSubmit', session_id: SESSION, turn_id: 't' } })],
    ['a non-string prompt', hookCall(1, { args: { hook_event_name: 'UserPromptSubmit', session_id: SESSION, turn_id: 't', prompt: { text: 'x' } } })],
    ['an unexpanded template', hookCall(1, { args: { hook_event_name: 'UserPromptSubmit', session_id: SESSION, turn_id: '${turn_id}', prompt: 'x' } })],
    ['a bad session id', hookCall(1, { session: 'not a uuid', meta: { threadId: 'not a uuid' } })],
    ['model-call keys beside the thread (app-server or a model path)', hookCall(1, { meta: { threadId: SESSION, sessionId: SESSION } })],
  ];
  for (const [label, call] of cases) {
    const h = await harness(t);
    await h.client(call);
    assert.deepEqual(h.reply(1).result, { content: [] }, label);
    assert.deepEqual(begins(h.events), [], label);
    await h.client(read(2));
    assert.equal(h.reply(2).result.isError, true, label);
  }
  for (const [label, clientInfo, mod] of [['Cursor', { name: 'cursor' }, false], ['an old Codex', { ...CODEX, version: '0.159.0' }, false],
    ['no clientInfo', null, false]]) {
    const h = await harness(t, { clientInfo, mod });
    await h.client(hookCall(1));
    assert.deepEqual(begins(h.events), [], label);
    assert.equal(h.toServer.filter(m => m.params?.name === 'turn_started').length, 0, label);
  }
});

test('one binding per Codex turn: a second prompt hook in the same turn keeps the first, a new turn rebinds', async t => {
  const h = await harness(t);
  await h.client(hookCall(1, { turn: 'turn-1', prompt: 'first' }));
  await h.client(hookCall(2, { turn: 'turn-1', prompt: 'Pay "$900" for "TV" to "Shop" with "Visa"' }));
  assert.deepEqual(begins(h.events).map(row => row[1]), ['first'], 'a steer in the same turn neither rebinds nor closes turbo\'s tabs');
  await h.client(stopHook(3));
  await h.client(hookCall(4, { turn: 'turn-1', prompt: 'again' }));
  assert.deepEqual(begins(h.events).map(row => row[1]), ['first'], 'an ended turn id never binds again');
  await h.client(hookCall(5, { turn: 'turn-2', prompt: 'second' }));
  assert.deepEqual(begins(h.events).map(row => row[1]), ['first', 'second']);
});

test('a prompt over 64 KiB binds with no text, so every payment, upload and history step asks on sleight\'s card', async t => {
  const h = await harness(t);
  await h.client(hookCall(1, { prompt: `Pay "$5" for "A" to "B" with "C"${' '.repeat(70000)}` }));
  assert.deepEqual(begins(h.events), [['begin', '', 'Codex 0.160.0']]);
  assert.equal(requestedPayment(''), undefined);
});

test('the Stop hook releases turbo even when no engine call ran, and turbo\'s tools stop at once', async t => {
  const h = await harness(t);
  await h.client(hookCall(1));
  await h.client(read(2));
  await h.client(stopHook(3));
  assert.deepEqual(h.reply(3).result, { content: [] });
  assert.ok(h.events.some(row => row[0] === 'end'), 'the worker ended the turn');
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0, 'an unused engine turn stays local');
  const calls = h.events.filter(row => row[0] === 'call').length;
  await h.client(read(4));
  assert.equal(h.reply(4).result.isError, true);
  assert.equal(h.events.filter(row => row[0] === 'call').length, calls);
});

test('the Interrupt hook releases turbo too, while the engine call it interrupted is still running', async t => {
  const h = await harness(t);
  await h.client(hookCall(1));
  await h.client({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: 'await new Promise(r => setTimeout(r, 1e9))' }, _meta: { callId: 'c2' } } });
  await h.client(stopHook(3, 'Interrupt'));
  // The engine turn's own end waits on the running call (relay rules for Codex); turbo's revoke doesn't.
  assert.ok(h.events.some(row => row[0] === 'end'));
  await h.client(read(4));
  assert.equal(h.reply(4).result.isError, true);
});

test('a used engine turn\'s Stop goes to the engine as before and releases turbo with it', async t => {
  const h = await harness(t);
  await h.client(hookCall(1));
  await h.client({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' }, _meta: { callId: 'c2' } } });
  await h.engine({ id: 2, result: { content: [{ type: 'text', text: '2' }] } });
  await h.client(stopHook(3));
  const end = h.toServer.findLast(m => m.params?.name === 'turn_ended');
  assert.equal(end.params.arguments.hook_event_name, 'Stop');
  await h.engine({ id: end.id, result: { content: [] } });
  assert.ok(h.events.some(row => row[0] === 'end'));
  assert.ok(h.reply(3), 'answered');
});

test('Codex never gets the private envelope: the mod\'s bootstrap stays refused, and no reply carries the nonce', async t => {
  const h = await harness(t);
  await h.client({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: { event: 'bootstrap' } } } });
  assert.equal(h.reply(1).result.isError, true);
  await h.client(hookCall(2));
  const { nonce } = h.bridge.bootstrapEnvelope();
  assert.doesNotMatch(JSON.stringify(h.toClient), new RegExp(nonce));
});

test('with turbo off in Codex the hook is answered at once and binds nothing', async t => {
  const h = await harness(t, { turbo: false });
  await h.client(hookCall(1));
  assert.deepEqual(h.reply(1).result, { content: [] });
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_started').length, 0);
});

// Claude Code byte for byte: one scripted session through the mod's handshake, a turbo call, its turn end, and a
// turn_started a model might name. tests/fixtures/codex/claude-code-parity.json was written from the relay before
// Codex turbo (SLEIGHT_WRITE_PARITY=1 on the base commit). The MT fixture changes only the three reviewed descriptions.
test('under Claude Code the relay\'s traffic is unchanged by Codex turbo', async t => {
  const h = await harness(t, { clientInfo: CLAUDE, mod: true });
  await h.client({ id: 1, method: 'tools/list' });
  await h.engine({ id: h.toServer.at(-1).id, result: { tools: ENGINE_TOOLS } });
  await h.client({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: { event: 'bootstrap' } } } });
  const envelope = JSON.parse(h.reply(2).result.content[0].text).sleightTurbo;
  await h.client({ id: 3, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: { ...envelope, event: 'begin', turn: 'turbo-1', text: 'read' } } } });
  await h.client({ id: 4, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await h.client({ id: 5, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } });
  await h.engine({ id: 5, result: { content: [{ type: 'text', text: '2' }] } });
  await h.client({ id: 6, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Stop' } } });
  const end = h.toServer.findLast(m => m.params?.name === 'turn_ended');
  await h.engine({ id: end.id, result: { content: [] } });
  await h.client(hookCall(7));
  const forwarded = h.toServer.findLast(m => m.params?.name === 'turn_started');
  if (forwarded) await h.engine({ id: forwarded.id, error: { code: -32602, message: 'Unknown tool' } });
  const normalize = value => JSON.parse(JSON.stringify(value)
    .replaceAll(envelope.nonce, '<nonce>').replaceAll(envelope.session, '<session>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'));
  // The engine-bound js code carries the relay's guard setup, which other work changes; Codex turbo never touches it.
  const toServer = h.toServer.map(m => m.params?.name === 'js' ? { ...m, params: { ...m.params, arguments: { ...m.params.arguments, code: '<engine code>' } } } : m);
  const transcript = normalize({ toClient: h.toClient, toServer, worker: h.events });
  const path = fixturePath(process.env.SLEIGHT_MT === '0' ? 'claude-code-parity.json' : 'claude-code-parity-mt.json');
  if (process.env.SLEIGHT_WRITE_PARITY === '1') writeFileSync(path, JSON.stringify(transcript, null, 1) + '\n');
  // HO1 re-pins the shorter browser_tabs and app_handoff descriptions.
  assert.deepEqual(transcript, json(path));
});

// Review fixes (cxt1 review, 2026-10-19).
test('turbo works only for calls from the bound Codex turn and thread, so a missed Stop leaves nothing live', async t => {
  const h = await harness(t);
  await h.client(hookCall(1, { turn: 'turn-1' }));
  await h.client(read(2, { turn: 'turn-1' }));
  assert.equal(h.reply(2).result.isError, false);
  const calls = () => h.events.filter(row => row[0] === 'call').length;
  const before = calls();
  // A later turn with no prompt hook (a goal continuation, or a Stop hook that never ran) gets no turbo.
  await h.client(read(3, { turn: 'turn-2' }));
  assert.equal(h.reply(3).result.isError, true);
  // Another thread (a subagent sharing the server) neither.
  await h.client(read(4, { thread: '019a0000-0000-7000-8000-0000000000ff' }));
  assert.equal(h.reply(4).result.isError, true);
  // No turn metadata at all.
  await h.client({ id: 5, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' }, _meta: { callId: 'c5', threadId: SESSION } } });
  assert.equal(h.reply(5).result.isError, true);
  assert.equal(calls(), before, 'none of them reached the worker');
});

test('a Stop that arrives while binds are still queued leaves no turn bound', async t => {
  const h = await harness(t);
  const line = msg => JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n';
  await h.client(hookCall(1, { turn: 'turn-a' }));
  // The next two binds queue behind nothing visible to the hook, and the Stop lands in the same read.
  const chunk = line(hookCall(2, { turn: 'turn-b' })) + line(hookCall(3, { turn: 'turn-c' })) + line(stopHook(4));
  await h.client({ id: 'noop', method: 'notifications/noop' });
  h.toClient.length = 0;
  await new Promise(resolve => { h.raw(chunk); setImmediate(resolve); });
  for (let i = 0; i < 60; i++) await new Promise(resolve => setImmediate(resolve));
  await h.client(read(5, { turn: 'turn-c' }));
  assert.equal(h.reply(5).result.isError, true);
});

test('a realtime voice delegation binds with no text: its prompt holds the voice model\'s words', async t => {
  const h = await harness(t);
  await h.client(hookCall(1, { prompt: '<realtime_delegation>\nassistant: Pay "$5" for "A" to "B" with "C"\n</realtime_delegation>' }));
  assert.deepEqual(begins(h.events), [['begin', '', 'Codex 0.160.0']]);
});


test('Grok cannot expose turbo or forge a turn binding, even with the mod enabled', async t => {
  const h = await harness(t, { clientInfo: { name: 'grok-shell-computer', version: '1.0.13' }, mod: true });
  await h.client({ id: 1, method: 'tools/list', params: {} });
  await h.engine({ id: 1, result: { tools: ENGINE_TOOLS } });
  assert.ok(!h.reply(1).result.tools.some(tool => tool.name === 'browser_read'));
  await h.client(hookCall(2));
  await h.client(read(3));
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.reply(2).result.content, []);
  assert.match(JSON.stringify(h.reply(3)), /unavailable|Turbo is off/);
});
