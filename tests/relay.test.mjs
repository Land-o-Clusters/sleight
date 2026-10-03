import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

// Wires a relay to in-memory streams and records what each side receives.
function harness(options = {}) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const toServer = [];
  const toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'session-1', ...options });
  return {
    relay,
    toServer,
    toClient,
    fromClient: msg => clientIn.write(JSON.stringify(msg) + '\n'),
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
  };
}

const tick = () => new Promise(r => setImmediate(r));
const meta = msg => JSON.parse(msg.params._meta['x-codex-turn-metadata']);

test('adds session and turn metadata to tool calls, keeping existing _meta', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1' }, _meta: { progressToken: 7 } } });
  await tick();
  assert.equal(h.toServer[0].params._meta.progressToken, 7);
  assert.deepEqual(meta(h.toServer[0]), { session_id: 'session-1', turn_id: h.relay.turnId });
});

test('keeps one turn id until turn_ended, then starts a new one', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js', arguments: {} } });
  h.fromClient({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } });
  h.fromClient({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await tick();
  const [first, second, ended, next] = h.toServer;
  assert.equal(meta(first).turn_id, meta(second).turn_id);
  assert.deepEqual(ended.params.arguments, { hook_event_name: 'Interrupt', session_id: 'session-1', turn_id: meta(first).turn_id });
  assert.notEqual(meta(next).turn_id, meta(first).turn_id);
  assert.equal(meta(next).session_id, 'session-1');
});

test('hides js_add_node_module_dir and marks turn_ended internal in tools/list', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js' }, { name: 'js_reset' }, { name: 'turn_ended', _meta: { ui: { visibility: [] } } }, { name: 'js_add_node_module_dir' }] } });
  await tick();
  const tools = h.toClient[0].result.tools;
  assert.deepEqual(tools.map(t => t.name), ['js', 'js_reset', 'turn_ended']);
  assert.match(tools[2].description, /Internal to sleight/);
  assert.equal(tools[2]._meta, undefined);
});

test('passes other messages through unchanged', async () => {
  const h = harness();
  const elicit = { jsonrpc: '2.0', id: 9, method: 'elicitation/create', params: { message: 'Allow?' } };
  h.fromServer(elicit);
  h.fromClient({ jsonrpc: '2.0', id: 9, result: { action: 'accept' } });
  await tick();
  assert.deepEqual(h.toClient[0], elicit);
  assert.deepEqual(h.toServer[0], { jsonrpc: '2.0', id: 9, result: { action: 'accept' } });
});

test('endOpenTurn ends a used turn and swallows the reply', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await tick();
  const usedTurn = meta(h.toServer[0]).turn_id;
  const done = h.relay.endOpenTurn();
  await tick();
  const call = h.toServer[1];
  assert.equal(call.params.name, 'turn_ended');
  assert.deepEqual(call.params.arguments, { hook_event_name: 'Stop', session_id: 'session-1', turn_id: usedTurn });
  h.fromServer({ jsonrpc: '2.0', id: call.id, result: { content: [] } });
  await done;
  assert.equal(h.toClient.length, 0);
});

test('endOpenTurn does nothing when no call used the turn', async () => {
  const h = harness();
  await h.relay.endOpenTurn();
  await tick();
  assert.equal(h.toServer.length, 0);
});

const appApproval = (id, persist = ['session', 'always'], app = 'com.apple.calculator', riskLevel = 'low') => ({
  jsonrpc: '2.0', id, method: 'elicitation/create',
  params: { message: `Allow Computer Use to use "${app}"?`, mode: 'form', requestedSchema: { type: 'object', properties: {} },
    _meta: { connector_id: 'computer-use', persist, riskLevel, tool_params: { app } } },
});

test('scopes an accepted app approval to the session', async () => {
  const h = harness();
  h.fromServer(appApproval(5));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 5, result: { action: 'accept', content: {} } });
  await tick();
  assert.deepEqual(h.toServer[0].result, { action: 'accept', content: {}, _meta: { persist: 'session' } });
});

test('never changes a decline, a cancel, or a scope the client chose', async () => {
  const h = harness();
  for (const id of [1, 2, 3]) h.fromServer(appApproval(id));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'decline' } });
  h.fromClient({ jsonrpc: '2.0', id: 2, result: { action: 'cancel' } });
  h.fromClient({ jsonrpc: '2.0', id: 3, result: { action: 'accept', _meta: { persist: 'always' } } });
  await tick();
  assert.deepEqual(h.toServer.map(m => m.result), [
    { action: 'decline' }, { action: 'cancel' }, { action: 'accept', _meta: { persist: 'always' } },
  ]);
});

test('does not treat a server request as the answer to a pending tools/list', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await tick();
  h.fromServer(appApproval(1));
  await tick();
  assert.equal(h.toClient[0].method, 'elicitation/create');
});

test('leaves approvals alone that do not offer a session scope or are not computer use', async () => {
  const h = harness();
  h.fromServer(appApproval(1, []));
  h.fromServer({ jsonrpc: '2.0', id: 2, method: 'elicitation/create', params: { message: 'Other?', _meta: { connector_id: 'other', persist: ['session'] } } });
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept' } });
  h.fromClient({ jsonrpc: '2.0', id: 2, result: { action: 'accept' } });
  await tick();
  assert.deepEqual(h.toServer.map(m => m.result), [{ action: 'accept' }, { action: 'accept' }]);
});

test('approvalScope once passes accepts through unchanged', async () => {
  const h = harness({ approvalScope: 'once' });
  h.fromServer(appApproval(5));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 5, result: { action: 'accept', content: {} } });
  await tick();
  assert.deepEqual(h.toServer[0].result, { action: 'accept', content: {} });
});

test('answers repeat approvals for an app the user accepted this session', async () => {
  const h = harness();
  h.fromServer(appApproval(1));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept', content: {} } });
  await tick();
  h.fromServer(appApproval(2));
  h.fromServer(appApproval(3));
  await tick();
  // Only the first prompt reached the user; the relay answered the others.
  assert.equal(h.toClient.length, 1);
  assert.deepEqual(h.toServer.slice(1).map(m => [m.id, m.result.action]), [[2, 'accept'], [3, 'accept']]);
});

test('still asks for a different app or a riskier request', async () => {
  const h = harness();
  h.fromServer(appApproval(1));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept' } });
  await tick();
  h.fromServer(appApproval(2, undefined, 'com.apple.TextEdit'));
  h.fromServer(appApproval(3, undefined, 'com.apple.calculator', 'high'));
  await tick();
  assert.deepEqual(h.toClient.map(m => m.id), [1, 2, 3]);
});

test('never remembers a decline', async () => {
  const h = harness();
  h.fromServer(appApproval(1));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'decline' } });
  await tick();
  h.fromServer(appApproval(2));
  await tick();
  assert.deepEqual(h.toClient.map(m => m.id), [1, 2]);
});

test('approvalScope once asks every time', async () => {
  const h = harness({ approvalScope: 'once' });
  h.fromServer(appApproval(1));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept' } });
  await tick();
  h.fromServer(appApproval(2));
  await tick();
  assert.deepEqual(h.toClient.map(m => m.id), [1, 2]);
});

test('a new relay (a new session) asks again', async () => {
  const first = harness();
  first.fromServer(appApproval(1));
  await tick();
  first.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept' } });
  await tick();
  const second = harness();
  second.fromServer(appApproval(1));
  await tick();
  assert.equal(second.toClient.length, 1);
});

test('answers a server/discover probe itself instead of forwarding it', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} });
  await tick();
  assert.equal(h.toServer.length, 0);
  assert.deepEqual(h.toClient[0], { jsonrpc: '2.0', id: 'server-discover-probe-1', error: { code: -32601, message: 'Method not found' } });
});

// An `ask` stand-in that records each prompt and answers from a list.
function asker(...answers) {
  const asked = [];
  const ask = async (message, sessionScoped) => {
    asked.push({ message, sessionScoped });
    return answers.shift();
  };
  return { ask, asked };
}

test('with ask, answers app approvals itself and never forwards them', async () => {
  const a = asker('accept');
  const h = harness({ ask: a.ask });
  h.fromServer(appApproval(1));
  await tick();
  await tick();
  assert.equal(h.toClient.length, 0);
  assert.deepEqual(a.asked, [{ message: 'Allow Computer Use to use "com.apple.calculator"?', sessionScoped: true }]);
  assert.deepEqual(h.toServer[0], { jsonrpc: '2.0', id: 1, result: { action: 'accept', content: {}, _meta: { persist: 'session' } } });
});

test('with ask, an accepted app is not asked again, a declined one is', async () => {
  const a = asker('accept', 'decline', 'cancel');
  const h = harness({ ask: a.ask });
  h.fromServer(appApproval(1));
  h.fromServer(appApproval(2));
  await tick(); await tick(); await tick();
  h.fromServer(appApproval(3, undefined, 'com.apple.TextEdit'));
  await tick(); await tick();
  h.fromServer(appApproval(4, undefined, 'com.apple.TextEdit'));
  await tick(); await tick();
  assert.equal(a.asked.length, 3);
  assert.deepEqual(h.toServer.map(m => [m.id, m.result.action]), [[1, 'accept'], [2, 'accept'], [3, 'decline'], [4, 'cancel']]);
});

test('with ask and approvalScope once, asks every time and never adds a scope', async () => {
  const a = asker('accept', 'accept');
  const h = harness({ ask: a.ask, approvalScope: 'once' });
  h.fromServer(appApproval(1));
  await tick(); await tick();
  h.fromServer(appApproval(2));
  await tick(); await tick();
  assert.deepEqual(a.asked.map(q => q.sessionScoped), [false, false]);
  assert.deepEqual(h.toServer.map(m => m.result), [{ action: 'accept', content: {} }, { action: 'accept', content: {} }]);
});

test('with ask, other elicitations still go to the client', async () => {
  const a = asker();
  const h = harness({ ask: a.ask });
  h.fromServer({ jsonrpc: '2.0', id: 2, method: 'elicitation/create', params: { message: 'Other?', _meta: { connector_id: 'other' } } });
  await tick();
  assert.equal(a.asked.length, 0);
  assert.equal(h.toClient[0].id, 2);
});
