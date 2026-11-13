import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
const relaySource = process.env.PA1B_RELAY_MODULE ? pathToFileURL(process.env.PA1B_RELAY_MODULE) : new URL('../plugins/sleight/lib/relay.mjs', import.meta.url);
const { createRelay } = await import(relaySource.href);

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, alwaysAllow) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const replies = [], traces = [];
  serverIn.setEncoding('utf8').on('data', data => data.trim().split('\n').filter(Boolean).forEach(line => replies.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'pa1b-fixture', alwaysAllow,
    ask: async () => 'always', trace: (event, data) => traces.push([event, data]) });
  t.after(() => relay.close());
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'elicitation/create', params: {
    message: 'Allow Computer Use to use "org.fixture.App"?', mode: 'form', requestedSchema: { type: 'object', properties: {} },
    _meta: { connector_id: 'computer-use', persist: ['session'], riskLevel: 'low', tool_params: { app: 'org.fixture.App' } },
  } }) + '\n');
  return { replies, traces };
}
test('pending persistence leaves the relay responsive and traces success only after completion', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, () => pending);
  await tick(); await tick();
  assert.equal(f.replies.find(reply => reply.id === 1)?.result.action, 'accept');
  assert.equal(f.traces.filter(([event]) => event === 'always-allow').length, 0);
  finish(); await tick();
  assert.equal(f.traces.filter(([event]) => event === 'always-allow').length, 1);
  assert.equal(f.replies[0].result._meta.persist, 'session');
});
test('a rejected asynchronous save is handled and is never reported as persisted', async t => {
  const messages = [], original = process.stderr.write;
  t.mock.method(process.stderr, 'write', text => { messages.push(String(text)); return true; });
  try {
    const f = fixture(t, async () => { throw Error('fixture writer busy'); });
    await tick(); await tick();
    assert.equal(f.replies.find(reply => reply.id === 1)?.result.action, 'accept');
    assert.equal(f.traces.filter(([event]) => event === 'always-allow').length, 0);
    assert.ok(messages.some(message => message.includes('fixture writer busy')));
  } finally { t.mock.restoreAll(); assert.equal(process.stderr.write, original); }
});
