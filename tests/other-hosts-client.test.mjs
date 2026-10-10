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
  await tick(70);
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
