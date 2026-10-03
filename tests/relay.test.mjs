import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/undertow/lib/relay.mjs';

// Wires a relay to in-memory streams and records what each side receives.
function harness() {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const toServer = [];
  const toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'session-1' });
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

test('hides host-only tools from tools/list responses', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js' }, { name: 'js_reset' }, { name: 'turn_ended' }, { name: 'js_add_node_module_dir' }] } });
  await tick();
  assert.deepEqual(h.toClient[0].result.tools.map(t => t.name), ['js', 'js_reset']);
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
