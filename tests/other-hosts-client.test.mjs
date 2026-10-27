import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { baseClient } from '../bench/other-hosts-client.mjs';

const fixture = fileURLToPath(new URL('./fixtures/other-hosts-stdio.mjs', import.meta.url));
const server = mode => ({ command: process.execPath, args: [fixture, mode], env: {} });
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('stdio client uses only base MCP and the real relay supplies approvals and idle cleanup', async t => {
  const events = [];
  const client = await baseClient(server('relay'), { record: e => events.push(e) });
  t.after(() => client.close());
  const tools = await client.request('tools/list', {});
  assert.ok(tools.tools.some(tool => tool.name === 'js'));
  const first = await client.call('js', { code: 'var app = await cua.getApp("Calculator")' });
  assert.equal(first.isError, undefined);
  const before = first._meta.fixture;
  assert.equal(before.dialogs, 1);
  assert.equal(before.engineCapabilities.elicitation.form !== undefined, true);
  const deadline = Date.now() + 10000;
  while (!(await client.request('tools/list', {}))._meta.fixture.turnEnds.length) {
    assert.ok(Date.now() < deadline, 'idle turn did not end within 10 seconds');
    await tick(25);
  }
  const second = await client.call('js', { code: 'await app.getAXState({ disableDiffing: true })' });
  const after = second._meta.fixture;
  assert.equal(after.turnEnds.length, 1);
  assert.equal(after.turnEnds[0].session_id, before.session_id);
  assert.equal(after.turnEnds[0].turn_id, before.turn_id);
  assert.equal(after.session_id, before.session_id);
  assert.notEqual(after.turn_id, before.turn_id);
  assert.equal(after.dialogs, 1, 'accepted app is remembered across idle turns');
  const submitted = events.filter(e => e.direction === 'submitted').map(e => e.msg);
  assert.deepEqual(submitted[0].params.capabilities, {});
  assert.equal(submitted.some(m => m.params?.name === 'turn_ended'), false);
  assert.equal(submitted.some(m => m.params?._meta), false);
  assert.equal(events.some(e => e.msg?.method === 'elicitation/create'), false);
  await client.close();
  assert.deepEqual(events.at(-1), { event: 'server-close', code: 0, signal: null });
});

test('base client refuses optional server requests and preserves JSON-RPC errors', async t => {
  const events = [];
  const client = await baseClient(server('unsupported'), { record: e => events.push(e) });
  t.after(() => client.close());
  await assert.rejects(client.request('tools/list', {}), /optional request refused/);
  const refusal = events.find(e => e.direction === 'submitted' && e.msg.error);
  assert.equal(refusal.msg.error.code, -32601);
  assert.equal(refusal.msg.id, 'optional');
});

test('a hung stdio request times out and close collects the owned child', async () => {
  const events = [];
  await assert.rejects(baseClient(server('hang'), {
    timeoutMs: 30, closeGraceMs: 40, record: e => events.push(e),
  }), /timed out/);
  assert.equal(events.at(-1).event, 'server-close');
});

test('failure to spawn is reported without an unhandled stream error', async () => {
  await assert.rejects(baseClient({ command: '/no-such-sleight-server' }), /ENOENT/);
});

test('interrupting a pending client collects its child before returning', async () => {
  const signal = new AbortController(), events = [];
  const timer = setTimeout(() => signal.abort(), 30);
  try {
    await assert.rejects(baseClient(server('hang'), {
      signal: signal.signal, closeGraceMs: 40, record: e => events.push(e),
    }), /interrupted/);
    assert.equal(events.at(-1).event, 'server-close');
  } finally { clearTimeout(timer); }
});

import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { skillRules } from '../plugins/sleight/lib/launch.mjs';
import { rewritePaymentPolicy } from '../plugins/sleight/lib/payment-policy.mjs';
const grokInfo = JSON.parse(readFileSync(new URL('fixtures/grok/host-client-info.json', import.meta.url)));
const grokDirect = JSON.parse(readFileSync(new URL('fixtures/grok/host-client-info-direct.json', import.meta.url)));
function grokRelay(t, { clientInfo = grokInfo, ...options } = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  for (const [stream, records] of [[serverIn, sent], [clientOut, received]]) stream.on('data', data => records.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false, ...options });
  t.after(() => { relay.dispose(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  const client = msg => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const engine = msg => serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  client({ id: 0, method: 'initialize', params: { capabilities: { elicitation: { form: {} } }, clientInfo } });
  return { client, engine, sent, received };
}
const grokApproval = id => ({ id, method: 'elicitation/create', params: {
  message: 'Allow Calculator?', requestedSchema: { type: 'object', properties: {} },
  _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'low', tool_params: { app: 'Calculator' } },
} });
for (const native of [false, true]) for (const dedupeRules of [false, true]) test(`Grok retries held first-call guidance after oversized image delivery: native=${native}, dedupe=${dedupeRules}`, async t => {
  const h = grokRelay(t, { firstCallRules: skillRules(), dedupeRules, warmRepl: true });
  const policy = readFileSync(new URL('fixtures/engine-confirmations-policy.txt', import.meta.url), 'utf8').trimEnd();
  const docs = '## Computer Use\nNative reference.\n\n' + policy;
  h.engine({ id: 0, result: {} });
  h.client({ method: 'notifications/initialized' }); await tick(0);
  const warm = h.sent.find(msg => msg.params?.arguments?.title === 'Prepare sleight REPL');
  assert.ok(warm);
  h.engine({ id: warm.id, result: { content: [{ type: 'text', text: docs }] } }); await tick(0);
  const call = id => h.client({ id, method: 'tools/call', params: { name: 'js', arguments: { code: id === 1 && native ? 'var app = await cua.getApp("Calculator")' : 'nodeRepl.write(4)' } } });
  call(1);
  h.engine({ id: 1, result: { content: [{ type: 'image', data: 'A'.repeat(30000), mimeType: 'image/png' }] } });
  assert.equal(h.received.at(-1).result.isError, true);
  assert.match(h.received.at(-1).result.content[0].text, /Do not replay input automatically/);
  assert.match(JSON.stringify(h.received.at(-1).result.content), /computer__js/);
  assert.ok(h.received.at(-1).result.content.some(c => c.text?.includes('# Computer Use Confirmations Policy')), 'delivery error keeps trusted policy when it fits');
  call(2);
  h.engine({ id: 2, result: { content: [{ type: 'image', data: 'A'.repeat(30000), mimeType: 'image/png' }] } });
  assert.equal(h.received.at(-1).result.isError, true, 'a second delivery failure retains the guidance');
  call(3);
  h.engine({ id: 3, result: { content: [{ type: 'text', text: '4' }] } });
  const next = h.received.at(-1).result;
  assert.equal(next.isError, undefined, JSON.stringify(next));
  const text = next.content.map(c => c.text ?? '').join('\n');
  const expected = rewritePaymentPolicy(docs, 'requested');
  assert.ok(text.includes(native ? expected : expected.slice(expected.indexOf('# Computer Use Confirmations Policy'))), 'undelivered docs and payment policy are retried');
  if (!native) assert.match(text, /Read the native reference/);
  assert.match(text, /computer__js/);
  assert.match(text, /Never create or edit/);
  assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 20000);
  call(4);
  h.engine({ id: 4, result: { content: [{ type: 'text', text: '4' }] } });
  assert.doesNotMatch(JSON.stringify(h.received.at(-1)), /Native reference|computer__js/);
});

for (const key of ['server.key', 'a'.repeat(65)]) test(`unusual Grok server keys keep restricted delivery and approvals: ${key}`, t => {
  const h = grokRelay(t, { clientInfo: { name: 'grok-shell-' + key } });
  h.engine(grokApproval('card'));
  assert.equal(h.received.at(-1).params.requestedSchema.properties.remember, undefined);
  h.client({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'nodeRepl.write(4)' } } });
  h.engine({ id: 1, result: { content: [{ type: 'image', data: 'A'.repeat(30000), mimeType: 'image/png' }] } });
  assert.equal(h.received.at(-1).result.isError, true);
  assert.ok(Buffer.byteLength(JSON.stringify(h.received.at(-1).result)) <= 20000);
});

test('Grok persistence clamping is limited to accepted replies to forwarded elicitations', t => {
  const h = grokRelay(t);
  h.engine(grokApproval('declined'));
  h.client({ id: 'declined', result: { action: 'decline', _meta: { persist: 'always' } } });
  assert.equal(h.sent.at(-1).result._meta.persist, 'always');
  h.client({ id: 'unrelated', result: { action: 'accept', _meta: { persist: 'always' } } });
  assert.equal(h.sent.at(-1).result._meta.persist, 'always');
});

for (const approvalScope of ['session', 'once', 'document']) for (const keyed of [false, true]) {
  test(`all forwarded Grok approvals clamp persistence: scope=${approvalScope}, keyed=${keyed}`, t => {
    const h = grokRelay(t, { approvalScope });
    const card = grokApproval('unrestricted');
    if (approvalScope === 'document') card.params._meta.connector_id = 'browser-use';
    if (!keyed) delete card.params._meta.persist;
    h.engine(card);
    assert.equal(h.received.at(-1).method, 'elicitation/create');
    h.client({ id: card.id, result: { action: 'accept', content: {}, _meta: { persist: 'always', keep: true } } });
    assert.equal(h.sent.at(-1).result._meta.persist, 'session');
    assert.equal(h.sent.at(-1).result._meta.keep, true);
    h.engine({ ...card, id: 'second' });
    if (approvalScope !== 'session' || !keyed) assert.equal(h.received.at(-1).id, 'second', 'no session cache for unkeyed or non-session approvals');
  });
}
test('Grok browser and unknown connector elicitation replies also clamp persistence', t => {
  const h = grokRelay(t);
  for (const connector of ['browser-use', 'unknown']) {
    const card = grokApproval(connector);
    card.params._meta.connector_id = connector;
    h.engine(card);
    h.client({ id: card.id, result: { action: 'accept', content: {}, _meta: { persist: 'always' } } });
    assert.equal(h.sent.at(-1).result._meta.persist, 'session');
  }
});

for (const clientInfo of [grokInfo, grokDirect]) test(`Grok form Always answers grant only this session, including forged persistence metadata: ${clientInfo.name}`, t => {
  const writes = [];
  const h = grokRelay(t, { clientInfo, alwaysAllow: (...args) => writes.push(args) });
  h.engine(grokApproval('card'));
  assert.equal(h.received.at(-1).params.requestedSchema.properties.remember, undefined);
  h.client({ id: 'card', result: { action: 'accept', content: { remember: 'Always' }, _meta: { persist: 'always' } } });
  assert.deepEqual(writes, []);
  assert.equal(h.sent.at(-1).result.action, 'accept');
  assert.deepEqual(h.sent.at(-1).result.content, {});
  assert.equal(h.sent.at(-1).result._meta.persist, 'session');
  h.engine(grokApproval('again'));
  assert.equal(h.sent.at(-1).result.action, 'accept');
  assert.equal(h.received.length, 1);
});
test('only sleight panel Always writes a Grok pre-approval', async t => {
  const writes = [];
  const h = grokRelay(t, { ask: async () => 'always', alwaysAllow: (...args) => writes.push(args) });
  h.engine(grokApproval('card')); await tick(0);
  assert.deepEqual(writes, [['Calculator', 'low']]);
  assert.equal(h.sent.at(-1).result.action, 'accept');
});
for (const clientInfo of [grokInfo, grokDirect]) for (const mode of ['always', 'requested', 'never']) test(`every Grok result fits 20000 serialized bytes and first docs keep policy and host tool names: ${mode}, ${clientInfo.name}`, t => {
  const h = grokRelay(t, { clientInfo, firstCallRules: skillRules(), confirmPayments: mode });
  const policy = readFileSync(new URL('fixtures/engine-confirmations-policy.txt', import.meta.url), 'utf8').trimEnd();
  for (const [id, content, meta] of [
    [1, [{ type: 'text', text: '## Computer Use\nNative reference.\n\n' + policy },
      { type: 'text', text: 'Window: "Editor", App: Editor\n0 standard window\n' + '\t1 text area 界\\\"\n'.repeat(5000) }]],
    [2, [{ type: 'text', text: '界\\\"\n'.repeat(15000) }]],
    [3, [{ type: 'image', data: 'A'.repeat(30000), mimeType: 'image/png' }]],
    [4, [{ type: 'text', text: 'done' }], { huge: 'x'.repeat(30000) }],
    [5, [{ type: 'text', text: 'done' }]],
  ]) {
    h.client({ id, method: 'tools/call', params: { name: 'js', arguments: { code: 'nodeRepl.write(4)' } } });
    h.engine({ id, result: { content, ...(meta ? { _meta: meta } : {}) } });
    const result = h.received.find(r => r.id === id)?.result;
    assert.ok(result, `missing reply ${id}`);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 20000, `reply ${id} spilled`);
    if (id === 1) {
      const text = result.content.map(c => c.text ?? '').join('\n');
      assert.ok(text.includes(rewritePaymentPolicy(policy, mode)), 'effective confirmation policy stays whole');
      assert.match(text, /computer__js/);
      assert.doesNotMatch(text, /mcp__plugin_sleight/);
      assert.equal(result.isError, undefined);
    }
  }
});
