import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { approvalOptions } from '../plugins/sleight/lib/launch.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const toServer = [], toClient = [];
  for (const [stream, records] of [[serverIn, toServer], [clientOut, toClient]]) {
    stream.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => records.push(JSON.parse(line))));
  }
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, ...options });
  t.after(() => relay.close());
  const send = (stream, msg) => stream.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  return { relay, toServer, toClient, client: msg => send(clientIn, msg), engine: msg => send(serverOut, msg) };
}
const initialize = (h, capabilities = {}) => h.client({ id: 0, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'plain-client', version: '1' },
} });
const approval = (id, riskLevel = 'low', connector_id = 'computer-use') => ({ id, method: 'elicitation/create', params: {
  mode: 'form', message: 'Allow Computer Use to use "Calculator"?', requestedSchema: { type: 'object', properties: {} },
  _meta: { connector_id, persist: ['session', 'always'], riskLevel, tool_params: { app: 'Calculator' } },
} });

test('launcher prompt options preserve explicit overrides and the desktop workaround', async t => {
  for (const [env, want] of [
    [{}, 'dialog'], [{ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, 'dialog'],
    [{ SLEIGHT_APPROVAL_PROMPT: 'dialog' }, 'dialog'],
    [{ SLEIGHT_APPROVAL_PROMPT: 'client', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, 'cancel'],
  ]) {
    let dialogs = 0;
    const h = harness(t, approvalOptions(env, async () => { dialogs++; return 'accept'; }));
    initialize(h);
    h.engine(approval('configured')); await tick();
    assert.equal(h.toServer.at(-1).result.action, want === 'dialog' ? 'accept' : 'cancel');
    assert.equal(dialogs, want === 'dialog' ? 1 : 0);
    assert.equal(h.toClient.length, 0);
  }
});

// Losing capability negotiation would send a request the base client cannot answer.
for (const capabilities of [{}, { elicitation: { url: {} } }]) {
  test(`a client without form elicitation uses the dialog: ${JSON.stringify(capabilities)}`, async t => {
    const questions = [];
    const h = harness(t, { fallbackAsk: async (...args) => { questions.push(args); return 'accept'; } });
    initialize(h, capabilities);
    assert.deepEqual(h.toServer[0].params.capabilities.elicitation?.form, {});
    h.engine(approval('first')); await tick();
    assert.equal(h.toClient.length, 0, 'no unsupported request reaches the client');
    assert.equal(h.toServer.at(-1).result.action, 'accept');
    assert.equal(h.toServer.at(-1).result._meta.persist, 'session');
    h.engine(approval('repeat')); await tick();
    assert.equal(questions.length, 1, 'accepted app is remembered');
    h.engine(approval('riskier', 'high')); await tick();
    assert.equal(questions.length, 2, 'a riskier request asks again');
  });
}

for (const elicitation of [{}, { form: {} }, { form: {}, url: {} }]) {
  test(`a form-capable client keeps its own prompts: ${JSON.stringify(elicitation)}`, async t => {
    const h = harness(t, { fallbackAsk: async () => assert.fail('unexpected dialog') });
    initialize(h, { elicitation });
    h.engine(approval('client')); await tick();
    assert.equal(h.toClient.at(-1).method, 'elicitation/create');
    h.client({ id: 'client', result: { action: 'decline' } });
    h.engine(approval('again')); await tick();
    assert.equal(h.toClient.at(-1).id, 'again', 'a decline is never remembered');
  });
}

test('dialog declines, cancellations and failures never become session approvals', async t => {
  const answers = ['decline', 'cancel', new Error('dialog unavailable'), 'accept'];
  const h = harness(t, { fallbackAsk: async () => { const answer = answers.shift(); if (answer instanceof Error) throw answer; return answer; } });
  initialize(h);
  for (const [id, want] of [['a', 'decline'], ['b', 'cancel'], ['c', 'cancel'], ['d', 'accept']]) {
    h.engine(approval(id)); await tick();
    assert.equal(h.toServer.at(-1).result?.action, want);
  }
  assert.equal(answers.length, 0);
  assert.equal(h.toClient.length, 0);
});

test('an explicit dialog also advertises form support to the engine', async t => {
  const h = harness(t, { ask: async () => 'accept' });
  initialize(h, { roots: { listChanged: true } });
  assert.deepEqual(h.toServer[0].params.capabilities, { roots: { listChanged: true }, elicitation: { form: {} } });
  h.engine(approval('browser', 'low', 'browser-use')); await tick();
  assert.equal(h.toServer.at(-1).result.action, 'accept');
  assert.equal(h.toClient.length, 0);
});

test('without any prompt provider a base client cancels instead of hanging', async t => {
  const h = harness(t);
  initialize(h);
  h.engine(approval('no-ui')); await tick();
  assert.equal(h.toClient.length, 0);
  assert.equal(h.toServer.at(-1).result.action, 'cancel');
});

test('an audit failure cancels when explicit client mode has no form support', async t => {
  const h = harness(t, { ...approvalOptions({ SLEIGHT_APPROVAL_PROMPT: 'client' }),
    preapproved: new PreapprovedApps({ version: 1, apps: [{ app: 'Calculator', riskLevel: 'low' }] }),
    grantAudit: () => { throw new Error('disk full'); },
  });
  initialize(h);
  h.engine(approval('audit-failed')); await tick();
  assert.equal(h.toClient.length, 0, 'audit failure must not bypass capability checks');
  assert.equal(h.toServer.at(-1).result.action, 'cancel');
});

test('base clients get session IDs and idle turn cleanup without a mod or skill', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { idleTurnEndMs: 30000 });
  initialize(h);
  const call = id => h.client({ id, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } });
  call(1);
  const before = JSON.parse(h.toServer.at(-1).params._meta['x-codex-turn-metadata']);
  t.mock.timers.tick(60000);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0, 'pending calls hold the turn');
  h.engine({ id: 1, result: { content: [{ type: 'text', text: '2' }] } });
  t.mock.timers.tick(30000);
  const end = h.toServer.at(-1);
  assert.equal(end.params.name, 'turn_ended');
  assert.equal(end.params.arguments.session_id, before.session_id);
  assert.equal(end.params.arguments.turn_id, before.turn_id);
  h.engine({ id: end.id, result: { content: [] } });
  assert.deepEqual(h.toClient.map(m => m.id), [1], 'internal cleanup reply stays internal');
  call(2);
  const after = JSON.parse(h.toServer.at(-1).params._meta['x-codex-turn-metadata']);
  assert.equal(after.session_id, before.session_id);
  assert.notEqual(after.turn_id, before.turn_id);
  h.engine({ id: 2, result: { content: [{ type: 'text', text: '2' }] } });
  assert.equal(h.toClient.at(-1).result.isError, undefined);
});
