import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { flatRootSchema, flatTool, fitBranch } from '../plugins/sleight/lib/tool-schema.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { MOD_META } from './fixtures/mod-attribution.mjs';

// The ChatGPT engine 26.1103.41825's js schema shape (2026-11-09): code or completion_summary, never both.
const ENGINE_JS = {
  type: 'object',
  oneOf: [
    { type: 'object', properties: { code: { type: 'string', description: 'JavaScript to run.' }, timeout_ms: { type: 'integer' }, title: { type: 'string' } }, required: ['code'], additionalProperties: false },
    { type: 'object', properties: { completion_summary: { type: 'string', maxLength: 80 } }, required: ['completion_summary'], additionalProperties: false },
  ],
};

// The same schema as the engine lists it (handshake cache, 2026-11-09): the root also lists every field and is closed.
const LIVE_JS = { ...structuredClone(ENGINE_JS), additionalProperties: false,
  properties: { ...ENGINE_JS.oneOf[0].properties, ...ENGINE_JS.oneOf[1].properties } };

test('the engine js schema becomes one flat object with both fields optional', () => {
  const flat = flatRootSchema(ENGINE_JS);
  assert.equal(flat.oneOf, undefined);
  assert.equal(flat.anyOf, undefined);
  assert.equal(flat.type, 'object');
  assert.deepEqual(Object.keys(flat.properties), ['code', 'timeout_ms', 'title', 'completion_summary']);
  assert.equal(flat.required, undefined);
  assert.equal(flat.additionalProperties, false);
  assert.deepEqual(flat.properties.completion_summary, { type: 'string', maxLength: 80 });
});

test('a field every branch requires stays required, and root fields are kept', () => {
  const flat = flatRootSchema({ type: 'object', description: 'd', required: ['id'], properties: { id: { type: 'string' } },
    anyOf: [{ properties: { a: { type: 'number' }, both: { type: 'string' } }, required: ['a', 'both'] }, { properties: { b: { type: 'number' }, both: { type: 'string' } }, required: ['both'] }] });
  assert.deepEqual(flat.required, ['id', 'both']);
  assert.equal(flat.description, 'd');
  assert.equal(flat.additionalProperties, undefined);
  assert.deepEqual(Object.keys(flat.properties), ['id', 'a', 'both', 'b']);
});

test('schemas it cannot merge honestly are left exactly as the engine sent them', () => {
  const cases = [
    { type: 'object', properties: { code: { type: 'string' } } },
    { oneOf: [{ properties: { x: { type: 'string' } } }, { properties: { x: { type: 'number' } } }] },
    { oneOf: [{ type: 'string' }, { type: 'object' }] },
    { type: 'array', oneOf: [{ type: 'object' }] },
    { oneOf: [{ $ref: '#/defs/a' }] },
    { oneOf: [{ oneOf: [{ type: 'object' }] }] },
    { oneOf: [] },
    { oneOf: [{ type: 'object' }], anyOf: [{ type: 'object' }] },
    { type: 'object', allOf: [{ required: ['code'] }], oneOf: [{ type: 'object' }] },
    { type: 'object', allOf: [{ required: ['code'] }], anyOf: [{ type: 'object' }] },
  ];
  for (const schema of cases) assert.equal(flatRootSchema(schema), schema, JSON.stringify(schema));
  const tool = { name: 'drag', inputSchema: cases[0] };
  assert.equal(flatTool(tool), tool);
  assert.equal(flatTool({ name: 'x' }).inputSchema, undefined);
});

test('flatTool logs one line naming a tool whose root oneOf or anyOf it leaves as is', () => {
  const lines = [], log = line => lines.push(line);
  const kept = { name: 'drag', inputSchema: { type: 'object', allOf: [{ required: ['x'] }], oneOf: [{ type: 'object' }] } };
  assert.equal(flatTool(kept, log), kept);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^sleight: drag .*oneOf/);
  flatTool({ name: 'plain', inputSchema: { type: 'object' } }, log);
  flatTool({ name: 'js', inputSchema: LIVE_JS }, log);
  assert.equal(lines.length, 1, 'no line for a plain schema or one it flattens');
  flatTool({ name: 'pick', inputSchema: { anyOf: [{ $ref: '#/defs/a' }] } }, log);
  assert.match(lines[1], /^sleight: pick .*anyOf/);
});

test('flatTool copies and leaves the engine tool untouched', () => {
  const tool = { name: 'js', description: 'Run code.', inputSchema: structuredClone(ENGINE_JS) };
  const before = structuredClone(tool);
  const out = flatTool(tool);
  assert.deepEqual(tool, before);
  assert.equal(out.description, 'Run code.');
  assert.equal(out.inputSchema.oneOf, undefined);
});

test('fitBranch keeps the first branch whose required fields are present and drops what it forbids', () => {
  assert.deepEqual(fitBranch(ENGINE_JS, { code: 'x', title: 't', completion_summary: 's' }), { args: { code: 'x', title: 't' }, dropped: ['completion_summary'] });
  assert.deepEqual(fitBranch(ENGINE_JS, { completion_summary: 's', title: 't' }), { args: { completion_summary: 's' }, dropped: ['title'] });
  const ok = { code: 'x', timeout_ms: 5 };
  assert.equal(fitBranch(ENGINE_JS, ok).args, ok);
  const neither = { title: 't' };
  assert.equal(fitBranch(ENGINE_JS, neither).args, neither);
  assert.equal(fitBranch({ type: 'object' }, ok).args, ok);
});

test('fitBranch fits against the branch on the engine\'s live schema, whose root lists every field', () => {
  assert.deepEqual(fitBranch(LIVE_JS, { code: 'x', title: 't', completion_summary: 's' }), { args: { code: 'x', title: 't' }, dropped: ['completion_summary'] });
  assert.deepEqual(fitBranch(LIVE_JS, { completion_summary: 's', timeout_ms: 5 }), { args: { completion_summary: 's' }, dropped: ['timeout_ms'] });
});

test('fitBranch keeps relay-private sleight_ fields, which the relay removes itself', () => {
  const args = { code: 'x', title: 't', sleight_stats: { internal: 'token' }, sleight_say: 'hi' };
  assert.deepEqual(fitBranch(LIVE_JS, args), { args, dropped: [] });
  assert.deepEqual(fitBranch(LIVE_JS, { ...args, completion_summary: 's' }).args, args);
});

test('fitBranch fits anyOf schemas the same way and reports a call that matches no branch', () => {
  const schema = { type: 'object', anyOf: LIVE_JS.oneOf, properties: LIVE_JS.properties, additionalProperties: false };
  assert.deepEqual(fitBranch(schema, { code: 'x', completion_summary: 's' }), { args: { code: 'x' }, dropped: ['completion_summary'] });
  for (const s of [LIVE_JS, schema]) {
    assert.deepEqual(fitBranch(s, { title: 't' }).missing, ['code', 'completion_summary']);
    assert.equal(fitBranch(s, {}).missing.length, 2);
    assert.equal(fitBranch(s, { code: 'x' }).missing, undefined);
  }
  assert.equal(fitBranch({ type: 'object' }, {}).missing, undefined);
});

function harness(options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const toClient = [], toServer = [];
  clientOut.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  serverIn.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'session-1', changeReview: false, ...options });
  return { relay, toClient, toServer, fromClient: m => clientIn.write(JSON.stringify(m) + '\n'), fromServer: m => serverOut.write(JSON.stringify(m) + '\n') };
}
const tick = () => new Promise(r => setImmediate(r));

test('the relay advertises a flat js schema and forwards calls unchanged for the engine to check', async () => {
  const h = harness();
  try {
    h.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
    await tick();
    h.fromServer({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js', description: 'Run code.', inputSchema: ENGINE_JS }] } });
    await tick(); await tick();
    const js = h.toClient.find(m => m.id === 'list').result.tools.find(t => t.name === 'js');
    assert.ok(js, 'js is advertised');
    assert.equal(js.inputSchema.oneOf, undefined);
    assert.deepEqual(Object.keys(js.inputSchema.properties).sort(), ['code', 'completion_summary', 'timeout_ms', 'title']);
    h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { completion_summary: 'Opened a file' } } });
    await tick(); await tick();
    const call = h.toServer.find(m => m.method === 'tools/call');
    assert.deepEqual(call.params.arguments, { completion_summary: 'Opened a file' });
    h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } });
    await tick(); await tick();
    h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: '1', title: 'Reading', completion_summary: 'Done' } } });
    await tick(); await tick();
    const mixed = h.toServer.filter(m => m.method === 'tools/call').at(-1);
    assert.equal(mixed.id, 2);
    assert.equal(mixed.params.arguments.completion_summary, undefined, 'a mixed call is fitted to the code form');
    assert.equal(mixed.params.arguments.title, 'Reading');
    assert.equal(typeof mixed.params.arguments.code, 'string');
  } finally { h.relay.dispose(); }
});

async function listJs(h, inputSchema = LIVE_JS) {
  h.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js', description: 'Run code.', inputSchema }] } });
  await tick(); await tick();
}

test('the relay fits mixed calls on the engine\'s live schema', async () => {
  const h = harness();
  try {
    await listJs(h);
    h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: '1', title: 'Reading', completion_summary: 'Done' } } });
    await tick(); await tick();
    assert.deepEqual(Object.keys(h.toServer.find(m => m.id === 2).params.arguments).sort(), ['code', 'title']);
  } finally { h.relay.dispose(); }
});

test('a flat js call with neither code nor completion_summary is refused in the relay, not forwarded', async () => {
  const lines = [];
  const h = harness({ stderr: { write: line => lines.push(String(line)) } });
  try {
    await listJs(h);
    for (const [id, args] of [[3, { title: 'Reading' }], [4, {}]]) {
      h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: args } });
      await tick(); await tick();
      assert.equal(h.toServer.some(m => m.id === id), false, 'the engine never sees it');
      const reply = h.toClient.find(m => m.id === id);
      assert.equal(reply?.result?.isError, true);
      assert.equal(reply.result.content[0].text, 'js needs code or completion_summary.');
    }
  } finally { h.relay.dispose(); }
});

test('a pane snapshot on a flat js engine stays out of turn stats and no sleight_ field reaches the engine', async () => {
  const lines = [];
  const h = harness({ stderr: { write: line => lines.push(String(line)) } });
  const mod = (id, args) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'turn_ended', arguments: args, _meta: MOD_META } });
  try {
    await listJs(h);
    mod('begin', { sleight_stats_begin: 'turn-1' }); await tick();
    h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'nodeRepl.write(1)' } } });
    await tick(); h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'main' }] } }); await tick(); await tick();
    mod('skip', { sleight_stats_skip: { snapshot: true } }); await tick();
    const token = JSON.parse(h.toClient.find(m => m.id === 'skip').result.content[0].text).sleightStatsSkip;
    h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: 'nodeRepl.write(3)', title: 'Snapshot', sleight_stats: { internal: token } } } });
    await tick(); h.fromServer({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'snapshot' }] } }); await tick(); await tick();
    mod('end', { hook_event_name: 'Stop', sleight_stats: 'turn-1' }); await tick();
    h.fromServer({ jsonrpc: '2.0', id: 'end', result: { content: [] } }); await tick(); await tick();
    assert.equal(h.toClient.find(m => m.id === 'end').result._meta['sleight/stats'].calls, 1, 'the snapshot is excluded');
    assert.deepEqual(Object.keys(h.toServer.find(m => m.id === 2).params.arguments).sort(), ['code', 'title']);
    assert.ok(!JSON.stringify(h.toServer).includes('sleight_stats'));
    assert.ok(!JSON.stringify(h.toServer).includes(token));
    assert.equal(lines.filter(l => l.includes('dropped')).length, 0, 'no drop line for a snapshot');
  } finally { h.relay.dispose(); }
});
