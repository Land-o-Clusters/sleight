import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-relay-review-')));
const fixturePath = join(fixtureRoot, 'a.txt');
const fixtureURL = pathToFileURL(fixturePath).href;
writeFileSync(fixturePath, 'before\n');
const relays = [];
after(() => { for (const relay of relays) relay.dispose(); rmSync(fixtureRoot, { recursive: true, force: true }); });

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
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'session-1', changeReview: true, ...options });
  relays.push(relay);
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

const flowFixture = () => new FlowRules({ version: 1, rules: [{ id: 'private', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
const flowCall = (h, id, code = 'await app.typeText("SECRET")', name = 'js', args) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args ?? { code } } });
const flowAnswer = (h, id, text = 'Window: "Test", App: TextEdit\n0 standard window Test\n1 text entry area Value: safe') => h.fromServer({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

test('flow rules refuse before engine forwarding and local tool effects', async () => {
  let effects = 0;
  const h = harness({ flowRules: flowFixture(), localTools: { tools: [{ name: 'drag' }], call: async () => { effects++; return { content: [] }; } } });
  flowCall(h, 1); flowCall(h, 2, '', 'drag', { app: 'TextEdit', note: 'SECRET' }); await tick();
  assert.equal(h.toServer.length, 0); assert.equal(effects, 0);
  assert.match(h.toClient[0].result.content[0].text, /private.*flow_exception/s);
  assert.equal(h.toClient[0].result.isError, true);
});

test('flow exception is a user decision for one identical retry, never a session grant', async () => {
  const prompts = [];
  const h = harness({ flowRules: flowFixture(), ask: async (...args) => { prompts.push(args); return 'accept'; } });
  flowCall(h, 1); flowCall(h, 2, '', 'flow_exception', { action: 'accept' }); await tick();
  assert.equal(prompts.length, 0);
  flowCall(h, 3, '', 'flow_exception', {}); await tick(); await tick();
  assert.equal(prompts.length, 1); assert.equal(prompts[0][1], false);
  assert.equal(prompts[0][2].kind, 'flow'); assert.match(prompts[0][2].detail, /SECRET/);
  flowCall(h, 4); await tick(); assert.equal(h.toServer.length, 1);
  flowAnswer(h, 4); await tick();
  flowCall(h, 5); await tick(); assert.equal(h.toServer.length, 1);
  assert.equal(h.toClient.find(m => m.id === 5).result.isError, true);
});

test('flow exception elicitation declines and cancels without forwarding or permission', async () => {
  for (const action of ['decline', 'cancel']) {
    const h = harness({ flowRules: flowFixture() }); flowCall(h, 1); flowCall(h, 2, '', 'flow_exception', {}); await tick();
    const prompt = h.toClient.find(m => m.method === 'elicitation/create');
    assert.match(prompt.params.message, /SECRET/);
    h.fromClient({ jsonrpc: '2.0', id: prompt.id, result: { action } }); await tick(); await tick();
    flowCall(h, 3); await tick(); assert.equal(h.toServer.length, 0);
  }
});

test('different calls invalidate an exception and calls wait while its prompt is open', async () => {
  let answer;
  const h = harness({ flowRules: flowFixture(), ask: () => new Promise(r => { answer = r; }) });
  flowCall(h, 1); flowCall(h, 2, '', 'flow_exception', {}); await tick();
  flowCall(h, 3, 'await app.typeText("safe")'); await tick(); assert.equal(h.toServer.length, 0);
  answer('accept'); await tick(); await tick();
  flowCall(h, 4, 'await app.typeText("safe")'); await tick(); flowAnswer(h, 4); await tick();
  flowCall(h, 5); await tick(); assert.equal(h.toServer.length, 1);
});

test('flow rules serialize reads and record protected values before the next call', async () => {
  const h = harness({ flowRules: new FlowRules({ version: 1, rules: [{ id: 'source', kind: 'source', sources: ['TextEdit'], destinations: ['TextEdit'] }] }) });
  flowCall(h, 1, 'let app=await cua.getApp("TextEdit")'); flowCall(h, 2, 'await app.typeText("safe")'); await tick();
  assert.equal(h.toServer.length, 1);
  flowAnswer(h, 1, 'Window: "Source", App: TextEdit\n0 standard window Source\n1 text entry area Value: private value'); await tick();
  flowCall(h, 3, 'await app.typeText("private value")'); await tick();
  assert.equal(h.toServer.length, 1); assert.match(h.toClient.find(m => m.id === 3).result.content[0].text, /source/);
});

test('enabled flow tools are advertised and engine failure consumes a user exception', async () => {
  const h = harness({ flowRules: flowFixture(), ask: async () => 'accept' });
  h.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  h.fromServer({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js' }] } }); await tick();
  assert.ok(h.toClient.find(m => m.id === 'list').result.tools.some(t => t.name === 'flow_exception'));
  flowCall(h, 1); flowCall(h, 2, '', 'flow_exception', {}); await tick(); await tick();
  flowCall(h, 3); await tick();
  h.fromServer({ jsonrpc: '2.0', id: 3, result: { isError: true, content: [{ type: 'text', text: 'failed action' }] } }); await tick();
  flowCall(h, 4); await tick();
  assert.equal(h.toServer.filter(m => m.method === 'tools/call').length, 1);
  assert.equal(h.toClient.find(m => m.id === 4).result.isError, true);
});

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
  assert.deepEqual(tools.map(t => t.name), ['js', 'js_reset', 'turn_ended', 'review_changes']);
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

const preapproved = () => new PreapprovedApps({ version: 1, apps: [
  { app: 'com.apple.calculator', riskLevel: 'medium' }, { app: 'Calculator', riskLevel: 'high' },
] });
for (const approvalScope of ['session', 'once']) {
  test(`user list approves engine calls in ${approvalScope} mode and reports each grant`, async () => {
    const traces = [], logs = [], prompts = [];
    const h = harness({ approvalScope, preapproved: preapproved(),
      ask: async message => { prompts.push(message); return 'decline'; },
      trace: (event, data) => traces.push([event, data]), stderr: { write: text => logs.push(text) } });
    flowCall(h, 1, 'let app = await cua.getApp("com.apple.calculator")'); await tick();
    h.fromServer(appApproval(11)); h.fromServer(appApproval(12, [])); await tick();
    assert.equal(prompts.length, 0);
    assert.equal(h.toServer.filter(m => m.result?.action === 'accept').length, 2);
    assert.ok(h.toServer.filter(m => m.result).every(m => m.result._meta?.persist !== 'always'));
    flowAnswer(h, 1, 'Calculator state'); await tick();
    assert.match(h.toClient.find(m => m.id === 1).result.content.at(-1).text, /pre-approved.*user.*list/i);
    assert.equal(traces.filter(([event]) => event === 'preapproved-app').length, 2);
    assert.equal(logs.length, 2); assert.match(logs[0], /com.apple.calculator.*low/);
    flowCall(h, 2); await tick(); flowAnswer(h, 2); await tick();
    assert.doesNotMatch(h.toClient.find(m => m.id === 2).result.content.at(-1).text, /pre-approved/);
  });
}
test('unlisted and higher or unknown engine risk still prompt, including without session persistence', async () => {
  const h = harness({ preapproved: preapproved() });
  h.fromServer(appApproval(1, undefined, 'Mail'));
  h.fromServer(appApproval(2, [], 'com.apple.calculator', 'high'));
  h.fromServer(appApproval(3, [], 'com.apple.calculator', 'unknown'));
  await tick(); assert.deepEqual(h.toClient.map(m => m.id), [1, 2, 3]);
  assert.equal(h.toServer.length, 0);
});
for (const name of ['drag', 'menu_bar', 'hover']) {
  test(`user list covers ${name} at high risk, reports even failures, and prompts below that ceiling`, async () => {
    const prompts = [], logs = [];
    const h = harness({ preapproved: preapproved(), stderr: { write: text => logs.push(text) },
      ask: async message => { prompts.push(message); return 'decline'; },
      localTools: { tools: [{ name }], call: async (_name, args, approve) => {
        const allowed = await approve([name, args.app], 'Allow local action?');
        return { isError: true, content: [{ type: 'text', text: allowed ? 'action failed' : 'refused' }] };
      } } });
    for (let id = 1; id <= 2; id++) { flowCall(h, id, '', name, { app: 'Calculator' }); await tick(); await tick(); }
    assert.equal(prompts.length, 0); assert.equal(logs.length, 2);
    for (const msg of h.toClient) assert.match(msg.result.content.at(-1).text, /pre-approved.*user.*list/i);
    flowCall(h, 3, '', name, { app: 'com.apple.calculator' }); await tick(); await tick();
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(h.toClient.find(m => m.id === 3).result.content.at(-1).text, /pre-approved/);
  });
}
test('the user list does not approve notifications, document grants, or unrelated elicitations', async () => {
  const h = harness({ preapproved: preapproved(), localTools: { tools: [{ name: 'notifications' }],
    call: async (_name, _args, approve) => ({ content: [{ type: 'text', text: String(await approve(['notifications'], 'Allow notifications?')) }] }) } });
  flowCall(h, 1, '', 'notifications', {}); await tick();
  assert.equal(h.toClient[0].method, 'elicitation/create');
  const other = { jsonrpc: '2.0', id: 22, method: 'elicitation/create', params: { message: 'Other', _meta: { connector_id: 'other', tool_params: { app: 'Calculator' }, riskLevel: 'low' } } };
  h.fromServer(other); await tick(); assert.deepEqual(h.toClient.at(-1), other);
  const d = harness({ approvalScope: 'document', preapproved: preapproved(), ask: async () => 'decline' });
  flowCall(d, 2); await tick(); assert.equal(d.toServer.length, 0);
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

// Local tools: sleight's own tools, answered by the relay.
function localTools(calls = []) {
  return {
    tools: [{ name: 'menu_bar', description: 'local', inputSchema: { type: 'object' } }],
    call: async (name, args, approve) => {
      calls.push({ name, args });
      if (args.app) {
        const ok = await approve(['menu_bar', args.app], `Allow Claude to use ${args.app}'s menu bar item?`);
        if (!ok) return { content: [{ type: 'text', text: 'declined' }], isError: true };
      }
      return { content: [{ type: 'text', text: `did ${args.op}` }] };
    },
  };
}
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

test('lists local tools after the server tools', async () => {
  const h = harness({ localTools: localTools() });
  h.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js' }] } });
  await tick();
  assert.deepEqual(h.toClient[0].result.tools.map(t => t.name), ['js', 'menu_bar', 'review_changes']);
});

test('answers a local tool call itself and never forwards it', async () => {
  const calls = [];
  const h = harness({ localTools: localTools(calls) });
  h.fromClient({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'apps' } } });
  await settle();
  assert.equal(h.toServer.length, 0);
  assert.deepEqual(calls, [{ name: 'menu_bar', args: { op: 'apps' } }]);
  assert.deepEqual(h.toClient[0], { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'did apps' }] } });
});

test('local approvals go through ask, are remembered when accepted, never when declined', async () => {
  const a = asker('accept', 'decline', 'accept');
  const h = harness({ ask: a.ask, localTools: localTools() });
  const call = (id, app) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app } } });
  call(1, 'Magnet'); await settle();
  call(2, 'Magnet'); await settle();
  call(3, 'LogiJuice'); await settle();
  call(4, 'LogiJuice'); await settle();
  assert.deepEqual(a.asked.map(q => q.message), [
    "Allow Claude to use Magnet's menu bar item?",
    "Allow Claude to use LogiJuice's menu bar item?",
    "Allow Claude to use LogiJuice's menu bar item?",
  ]);
  assert.deepEqual(h.toClient.map(m => m.result.isError ?? false), [false, false, true, false]);
});

test('without ask, local approvals ask the client with an elicitation', async () => {
  const h = harness({ localTools: localTools() });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app: 'Magnet' } } });
  await settle();
  const elicit = h.toClient[0];
  assert.equal(elicit.method, 'elicitation/create');
  assert.equal(elicit.params.message, "Allow Claude to use Magnet's menu bar item?");
  h.fromClient({ jsonrpc: '2.0', id: elicit.id, result: { action: 'accept', content: {} } });
  await settle();
  assert.equal(h.toClient[1].id, 1);
  assert.equal(h.toClient[1].result.isError, undefined);
  // Remembered for the session: no second elicitation.
  h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app: 'Magnet' } } });
  await settle();
  assert.deepEqual(h.toClient.slice(2).map(m => m.id), [2]);
  assert.equal(h.toServer.length, 0);
});

test('a declined client elicitation refuses the local call', async () => {
  const h = harness({ localTools: localTools() });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app: 'Magnet' } } });
  await settle();
  h.fromClient({ jsonrpc: '2.0', id: h.toClient[0].id, result: { action: 'decline' } });
  await settle();
  assert.equal(h.toClient[1].result.isError, true);
  assert.equal(h.toServer.length, 0);
});

const wait = ms => new Promise(r => setTimeout(r, ms));

test('ends a used turn after the session goes idle', async () => {
  const h = harness({ idleTurnEndMs: 30 });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  await wait(60);
  const ended = h.toServer.find(m => m.params?.name === 'turn_ended');
  assert.ok(ended, 'turn_ended was sent');
  assert.equal(ended.params.arguments.session_id, 'session-1');
});

test('does not end the turn while a call is still running, or before the idle time', async () => {
  const h = harness({ idleTurnEndMs: 40 });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await wait(70);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0, 'not while the call runs');
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  await wait(10);
  h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js', arguments: {} } });
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { content: [] } });
  await wait(20);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0, 'a new call restarts the wait');
  await wait(50);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 1);
});

test('without idleTurnEndMs, an idle turn stays open', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  await wait(40);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0);
});

const documentRead = (h, id, title = 'a.txt', url = fixtureURL) => {
  h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit")' } } });
  h.fromServer({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Window: "${title}", App: TextEdit\nURL: ${url}\n1 text area` }] } });
};
const documentCall = (h, id) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.typeText("hello")' } } });
const documentApprove = (h, id) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'document_scope', arguments: {} } });

test('document mode blocks action code until the observed document is approved', async () => {
  const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
  documentCall(h, 1);
  await settle();
  assert.equal(h.toServer.length, 0);
  assert.match(h.toClient[0].result.content[0].text, /document_scope/);
  documentRead(h, 2);
  documentApprove(h, 3);
  await settle();
  documentCall(h, 4);
  await settle();
  assert.ok(h.toServer.find(m => m.id === 4));
  assert.match(h.toServer.find(m => m.id === 4).params.arguments.code, /getAXState/);
});

test('document approval names the observed window and URL, through client elicitation', async () => {
  const h = harness({ approvalScope: 'document' });
  documentRead(h, 1);
  documentApprove(h, 2);
  await settle();
  const prompt = h.toClient.find(m => m.method === 'elicitation/create');
  assert.match(prompt.params.message, /a.txt/);
  assert.ok(prompt.params.message.includes(fixtureURL));
  h.fromClient({ jsonrpc: '2.0', id: prompt.id, result: { action: 'accept' } });
  await settle();
  documentCall(h, 3);
  assert.ok(h.toServer.find(m => m.id === 3));
});

test('another document stops further actions before forwarding them', async () => {
  const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
  documentRead(h, 1);
  documentApprove(h, 2);
  await settle();
  documentRead(h, 3, 'b.txt', 'file:///tmp/b.txt');
  documentCall(h, 4);
  await settle();
  assert.equal(h.toServer.some(m => m.id === 4), false);
  assert.equal(h.toClient.find(m => m.id === 4).result.isError, true);
  assert.match(h.toClient.find(m => m.id === 4).result.content[0].text, /b.txt.*document_scope/s);
});

test('equal titles with different URLs do not share a grant', async () => {
  const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
  documentRead(h, 1);
  documentApprove(h, 2);
  await settle();
  documentRead(h, 3, 'a.txt', 'file:///other/a.txt');
  documentCall(h, 4);
  assert.equal(h.toServer.some(m => m.id === 4), false);
});

test('mismatched or missing action-result headers close the relay gate', async () => {
  for (const text of ['Window: "b.txt", App: TextEdit\nURL: file:///tmp/b.txt', 'no window header']) {
    const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
    documentRead(h, 1);
    documentApprove(h, 2);
    await settle();
    documentCall(h, 3);
    h.fromServer({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text }] } });
    documentCall(h, 4);
    assert.equal(h.toClient.find(m => m.id === 3).result.isError, true);
    assert.equal(h.toServer.some(m => m.id === 4), false);
  }
});

test('decline and cancel do not approve the document', async () => {
  for (const answer of ['decline', 'cancel']) {
    const h = harness({ approvalScope: 'document', ask: async () => answer });
    documentRead(h, 1);
    documentApprove(h, 2);
    await settle();
    documentCall(h, 3);
    assert.equal(h.toServer.some(m => m.id === 3), false);
  }
});

test('document mode refuses concurrent calls and local tools outside the scope', async () => {
  const calls = [];
  const h = harness({ approvalScope: 'document', ask: async () => 'accept', localTools: localTools(calls) });
  documentRead(h, 1);
  documentApprove(h, 2);
  await settle();
  documentCall(h, 3);
  documentCall(h, 4);
  h.fromClient({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app: 'TextEdit' } } });
  assert.equal(h.toServer.some(m => m.id === 4), false);
  assert.equal(calls.length, 0);
  assert.equal(h.toClient.find(m => m.id === 5).result.isError, true);
});

test('document engine approvals stay tied to the observed app and risk without persistence', async () => {
  const a = asker('accept', 'accept', 'decline');
  const h = harness({ approvalScope: 'document', ask: a.ask });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit")' } } });
  h.fromServer(appApproval('read', undefined, 'com.apple.TextEdit'));
  await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `Window: "a.txt", App: TextEdit\nURL: ${fixtureURL}` }] } });
  documentApprove(h, 2);
  await settle();
  documentCall(h, 3);
  h.fromServer(appApproval('action', undefined, 'com.apple.TextEdit'));
  await settle();
  assert.deepEqual(h.toServer.find(m => m.id === 'action').result, { action: 'accept', content: {} });
  assert.equal(a.asked.length, 2);
  h.fromServer(appApproval('higher', undefined, 'com.apple.TextEdit', 'high'));
  await settle();
  assert.equal(h.toServer.find(m => m.id === 'higher').result.action, 'decline');
  assert.match(a.asked.at(-1).message, /a.txt.*high/);
  h.fromServer(appApproval('wrong-app', undefined, 'com.apple.calculator'));
  await settle();
  assert.equal(h.toServer.find(m => m.id === 'wrong-app').result.action, 'decline');
});

test('discovery allows no trailing action, and grants do not cross relay sessions', async () => {
  const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit"); await app.typeText("oops")' } } });
  assert.equal(h.toServer.length, 0);
  documentRead(h, 2);
  documentApprove(h, 3);
  await settle();
  const fresh = harness({ approvalScope: 'document' });
  documentRead(fresh, 1);
  documentCall(fresh, 2);
  assert.equal(fresh.toServer.some(m => m.id === 2), false);
});

test('document tools/list advertises only tools supported in this mode', () => {
  const h = harness({ approvalScope: 'document', localTools: localTools() });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js' }, { name: 'js_reset' }, { name: 'turn_ended' }] } });
  assert.deepEqual(h.toClient[0].result.tools.map(t => t.name), ['js', 'turn_ended', 'document_scope', 'review_changes']);
});

function savedEdit(h, id, path, before, afterText) {
  writeFileSync(path, before);
  documentRead(h, id, path.split('/').pop(), pathToFileURL(path).href);
  documentCall(h, id + 1);
  assert.ok(h.toServer.some(m => m.id === id + 1), 'action forwarded after snapshot');
  writeFileSync(path, afterText);
  h.fromServer({ jsonrpc: '2.0', id: id + 1, result: { content: [{ type: 'text', text: `Window: "${path.split('/').pop()}", App: TextEdit\nURL: ${pathToFileURL(path).href}` }] } });
}
const reviewCall = (h, id, args = { op: 'review' }) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'review_changes', arguments: args } });

test('change review is off unless enabled: no snapshot, no window guard, no review tool', async () => {
  const path = join(fixtureRoot, 'off.txt');
  writeFileSync(path, 'before\n');
  const h = harness({ changeReview: false, trace: (direction, msg) => { if (direction === 'snapshot-before-call') throw new Error('snapshot taken'); } });
  documentRead(h, 1, 'off.txt', pathToFileURL(path).href);
  documentCall(h, 2);
  assert.equal(h.toServer.find(m => m.id === 2).params.arguments.code, 'await app.typeText("hello")');
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Window: "Open", App: TextEdit' }] } });
  documentCall(h, 3);
  assert.ok(h.toServer.some(m => m.id === 3), 'a changed window does not stop the next action');
  h.fromClient({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  h.fromServer({ jsonrpc: '2.0', id: 4, result: { tools: [{ name: 'js' }] } });
  assert.deepEqual(h.toClient.find(m => m.id === 4).result.tools.map(t => t.name), ['js']);
  assert.equal(h.relay.snapshotDirectory, undefined);
});

test('review lists two saved documents, asks for each user decision and never forwards undo', async () => {
  const a = join(fixtureRoot, 'review-a.txt'), b = join(fixtureRoot, 'review-b.txt');
  const h = harness();
  savedEdit(h, 1, a, 'before a\n', 'after a\n'); savedEdit(h, 3, b, 'before b\n', 'after b\n');
  reviewCall(h, 5, { op: 'list' });
  assert.match(h.toClient.at(-1).result.content[0].text, /-before a\n\+after a[\s\S]*-before b\n\+after b/);
  assert.equal(h.toClient.some(m => m.method === 'elicitation/create'), false);
  reviewCall(h, 6); await settle();
  const first = h.toClient.find(m => m.method === 'elicitation/create');
  assert.deepEqual(first.params.requestedSchema.properties.decision.enum, ['keep', 'undo', 'later']);
  h.fromClient({ jsonrpc: '2.0', id: first.id, result: { action: 'accept', content: { decision: 'undo' } } }); await settle();
  const second = h.toClient.filter(m => m.method === 'elicitation/create').at(-1);
  h.fromClient({ jsonrpc: '2.0', id: second.id, result: { action: 'accept', content: { decision: 'keep' } } }); await settle();
  assert.equal(readFileSync(a, 'utf8'), 'before a\n'); assert.equal(readFileSync(b, 'utf8'), 'after b\n');
  assert.match(h.toClient.find(m => m.id === 6).result.content[0].text, /undone[\s\S]*kept/);
  assert.equal(h.toServer.some(m => m.params?.name === 'review_changes'), false);
});

test('model decisions and a bare accept cannot undo or keep, and actions wait during review', async () => {
  const path = join(fixtureRoot, 'review-decision.txt');
  const h = harness(); savedEdit(h, 1, path, 'before\n', 'after\n');
  reviewCall(h, 3, { op: 'review', decision: 'undo' });
  assert.equal(h.toClient.at(-1).result.isError, true);
  reviewCall(h, 4); await settle();
  documentCall(h, 5);
  assert.equal(h.toServer.some(m => m.id === 5), false);
  const prompt = h.toClient.find(m => m.method === 'elicitation/create');
  h.fromClient({ jsonrpc: '2.0', id: prompt.id, result: { action: 'accept', content: {} } }); await settle();
  assert.equal(readFileSync(path, 'utf8'), 'after\n');
  assert.match(h.toClient.find(m => m.id === 4).result.content[0].text, /pending/);
});

test('desktop review uses ask with the before/after preview and rechecks edits during the prompt', async () => {
  const path = join(fixtureRoot, 'review-prompt.txt');
  const asked = [];
  const h = harness({ ask: async (message, scoped, options) => {
    asked.push({ message, scoped, options }); writeFileSync(path, 'user edit\n'); return 'undo';
  } });
  savedEdit(h, 1, path, 'before\n', 'agent edit\n'); reviewCall(h, 3); await settle();
  assert.equal(asked[0].options.kind, 'review');
  assert.match(asked[0].options.detail, /-before\n\+agent edit/);
  assert.equal(h.toClient.find(m => m.id === 3).result.isError, true);
  assert.equal(readFileSync(path, 'utf8'), 'user edit\n');
});

test('snapshot failures refuse forwarding and session disposal removes private backups', () => {
  const h = harness(); documentRead(h, 1, 'missing.txt', pathToFileURL(join(fixtureRoot, 'missing.txt')).href);
  documentCall(h, 2);
  assert.equal(h.toServer.some(m => m.id === 2), false);
  assert.match(h.toClient.at(-1).result.content[0].text, /cannot snapshot/);
  const path = join(fixtureRoot, 'review-cleanup.txt');
  savedEdit(h, 3, path, 'before\n', 'after\n');
  const bank = h.relay.snapshotDirectory;
  assert.ok(bank && existsSync(bank));
  h.relay.dispose(); assert.equal(existsSync(bank), false);
});

test('ambiguous action results list newly observed files without inventing before copies', () => {
  const a = join(fixtureRoot, 'ambiguous-a.txt'), b = join(fixtureRoot, 'ambiguous-b.txt');
  writeFileSync(a, 'a before\n'); writeFileSync(b, 'b before\n');
  const h = harness(); documentRead(h, 1, 'a.txt', pathToFileURL(a).href); documentCall(h, 2);
  writeFileSync(a, 'a after\n'); writeFileSync(b, 'b after\n');
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text:
    `Window: "a.txt", App: TextEdit\nURL: ${pathToFileURL(a).href}\nWindow: "b.txt", App: TextEdit\nURL: ${pathToFileURL(b).href}` }] } });
  reviewCall(h, 3, { op: 'list' });
  const listing = h.toClient.at(-1).result.content[0].text;
  assert.ok(listing.includes(a) && listing.includes(b));
  assert.match(listing, /Undo refused.*action was not confirmed/s);
  assert.match(listing, /No snapshot before the action/);
});

test('cancelled review leaves changes pending and an engine failure cannot authorize undo', async () => {
  const path = join(fixtureRoot, 'failed-action.txt'); writeFileSync(path, 'before\n');
  const h = harness({ ask: async () => 'cancel' });
  documentRead(h, 1, 'failed.txt', pathToFileURL(path).href); documentCall(h, 2);
  writeFileSync(path, 'partial change\n');
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text:
    `Window: "failed.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}` }] } });
  reviewCall(h, 3); await settle();
  assert.match(h.toClient.find(m => m.id === 3).result.content[0].text, /pending/);
  reviewCall(h, 4, { op: 'list' });
  assert.match(h.toClient.at(-1).result.content[0].text, /Undo refused/);
  assert.equal(readFileSync(path, 'utf8'), 'partial change\n');
});
