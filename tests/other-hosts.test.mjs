import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import * as launcher from '../plugins/sleight/lib/launch.mjs';
const { approvalOptions } = launcher;
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
  assert.deepEqual(h.toServer[0].params.capabilities, { elicitation: { form: {} } });
  h.engine(approval('no-ui')); await tick();
  assert.equal(h.toClient.length, 0);
  assert.equal(h.toServer.at(-1).result.action, 'cancel');
});

test('Claude Code form and URL capabilities reach the engine unchanged', t => {
  // initialize captured in 2026-10-04T15-03-12-682Z-preapproved-listed.json.
  const capabilities = { roots: { listChanged: true }, elicitation: { form: {}, url: {} } };
  const h = harness(t, approvalOptions({}));
  h.client({ id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities,
    clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.289',
      description: "Anthropic's agentic coding tool", websiteUrl: 'https://claude.com/claude-code' },
  } });
  assert.deepEqual(h.toServer[0].params.capabilities, capabilities);
});

test('dialog wording follows clientInfo before the Claude environment fallback', async t => {
  for (const [clientInfo, env, want] of [
    [{ name: 'claude-code' }, {}, true], [{ name: 'cursor' }, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, false],
    [undefined, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, true], [undefined, {}, false],
  ]) {
    let context;
    const h = harness(t, approvalOptions(env, async (_message, _scoped, options) => { context = options; return 'decline'; }));
    h.client({ id: 0, method: 'initialize', params: { capabilities: {}, ...(clientInfo ? { clientInfo } : {}) } });
    h.engine(approval('wording')); await tick();
    assert.equal(context?.claudeCode, want);
  }
});

// Replace only osascript: formatting and failure handling stay in the real launcher.
async function panel(message, claudeCode, failure = false) {
  let args;
  const result = await launcher.askWithDialog(message, true, { claudeCode }, (_command, argv, callback) => {
    args = argv;
    const child = new EventEmitter();
    queueMicrotask(() => { callback(failure ? new Error('no GUI session') : null, failure ? '' : 'decline', ''); child.emit('close'); });
    return child;
  }).then(action => ({ action }), error => ({ error }));
  return { args, ...result };
}

test('native panel keeps Claude branding and rewrites other hosts at the prompt boundary', async () => {
  const claude = await panel('Allow Computer Use to use "Calculator"?', true);
  assert.equal(claude.args[3], 'Allow Claude to use Calculator?');
  assert.match(claude.args[4], /Claude can then click.*this Claude session ends/);
  assert.equal(claude.args.at(-1), 'claude-code');
  const other = await panel('Allow Claude to read and use your notifications?', false);
  assert.equal(other.args[3], 'Allow this agent to read and use your notifications?');
  assert.match(other.args[4], /this sleight server session ends/);
  assert.equal(other.args.at(-1), 'generic');
});

test('a failed native panel returns an elicitation error without replacing unrelated successful calls', async t => {
  const failure = await panel('Allow Computer Use to use "Calculator"?', false, true);
  assert.equal(failure.error?.code, 'SLEIGHT_PROMPT_UNAVAILABLE');
  const h = harness(t, { fallbackAsk: async () => { throw failure.error; } });
  initialize(h);
  h.client({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } });
  h.client({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: '2 + 2' } } });
  h.engine(approval('panel-failed')); await tick();
  const refusal = h.toServer.at(-1);
  h.engine({ id: 2, result: { content: [{ type: 'text', text: '4' }] } });
  assert.equal(h.toClient.at(-1).result.isError, undefined);
  assert.equal(h.toClient.at(-1).result.content[0].text, '4');
  assert.equal(refusal.id, 'panel-failed');
  assert.equal(refusal.error?.code, -32603);
  assert.match(refusal.error.message, /prompt couldn't be shown/);
  // The engine associates its failed elicitation with the originating tool call.
  h.engine({ id: 1, error: { code: -32603, message: "The approval prompt couldn't be shown." } });
  assert.match(h.toClient.at(-1).error.message, /prompt couldn't be shown/);
});

test('a failed native panel for a local tool reports no user decision and grants nothing', async t => {
  const h = harness(t, { fallbackAsk: async () => {
    throw Object.assign(new Error('panel unavailable'), { code: 'SLEIGHT_PROMPT_UNAVAILABLE' });
  }, localTools: { tools: [{ name: 'local', inputSchema: { type: 'object' } }],
    call: async (_name, _args, approve) => ({ content: [{ type: 'text', text: 'User declined' }], isError: !await approve(['local'], 'Allow Claude to use local?') }),
  } });
  initialize(h);
  h.client({ id: 1, method: 'tools/call', params: { name: 'local', arguments: {} } }); await tick();
  assert.equal(h.toClient.at(-1).result.isError, true);
  assert.match(h.toClient.at(-1).result.content[0].text, /prompt couldn't be shown/);
  assert.doesNotMatch(h.toClient.at(-1).result.content[0].text, /User declined/);
});

test('an unanswered local form expires and a late acceptance cannot approve the next call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { localTools: { tools: [{ name: 'local', inputSchema: { type: 'object' } }],
    call: async (_name, _args, approve) => ({ content: [], isError: !await approve(['local'], 'Allow Claude to use local?') }),
  } });
  initialize(h, { elicitation: { form: {} } });
  const call = id => h.client({ id, method: 'tools/call', params: { name: 'local', arguments: {} } });
  call(1); await tick();
  const prompt = h.toClient.at(-1);
  t.mock.timers.tick(300000); await tick();
  assert.equal(h.toClient.find(m => m.id === 1)?.result.isError, true, 'timeout refuses the tool');
  h.client({ id: prompt.id, result: { action: 'accept' } });
  assert.equal(h.toServer.some(m => m.id === prompt.id), false, 'expired reply stays internal');
  call(2); await tick();
  const next = h.toClient.at(-1);
  assert.equal(next.method, 'elicitation/create');
  assert.notEqual(next.id, prompt.id);
  h.client({ id: next.id, result: { action: 'decline' } }); await tick();
  assert.equal(h.toClient.find(m => m.id === 2)?.result.isError, true);
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
