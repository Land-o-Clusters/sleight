import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { setTimeout as tick } from 'node:timers/promises';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { approvalCardText, shellRelayOptions } from '../plugins/sleight/lib/launch.mjs';
import { hostLabel } from '../plugins/sleight/lib/host-label.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { createPaymentCard } from '../plugins/sleight/lib/payment-card.mjs';

function fixture(t, { answer = 'accept', ...relayOptions } = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], panels = [], writes = [];
  for (const [stream, list] of [[serverIn, sent], [clientOut, received]]) stream.on('data', chunk => list.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const { wording, ...options } = shellRelayOptions(async (...args) => { panels.push(args); return answer; });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false,
    alwaysAllow: (...args) => writes.push(args), ...options, resolveApprovalApp: async () => '', ...relayOptions });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const client = msg => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const engine = msg => serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  client({ id: 0, method: 'initialize', params: { clientInfo: { name: 'Grok Bot', version: '1' }, capabilities: {} } });
  return { client, engine, sent, received, panels, writes, wording, relay };
}
const card = (id, message, meta = {}) => ({ id, method: 'elicitation/create', params: {
  message, requestedSchema: { type: 'object', properties: {} }, _meta: meta,
} });

test('shell matches the engine display name to its bundle ID before preapproval or session memory', async t => {
  const audited = [], resolutions = [];
  const preapproved = new PreapprovedApps({ version: 1, apps: [{ app: 'com.apple.calculator', riskLevel: 'high' }] });
  const f = fixture(t, { preapproved, grantAudit: grant => audited.push(grant),
    resolveApprovalApp: async name => { resolutions.push(name); return name === 'Calculator' ? 'com.apple.calculator' : ''; } });
  const meta = { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'com.apple.calculator' } };
  f.engine(card('listed', 'Allow Computer Use to use "Calculator"?', meta)); await tick(0);
  assert.equal(f.panels.length, 0);
  assert.equal(f.sent.find(m => m.id === 'listed').result.action, 'accept');
  assert.equal(audited[0].app, 'com.apple.calculator');
  assert.deepEqual(resolutions, ['Calculator']);
  f.engine(card('payment', 'Pay $364?', meta)); await tick(0);
  assert.equal(f.panels.length, 1, 'a payment with app metadata still asks');
  f.engine(card('mismatch', 'Allow Computer Use to use "Mail"?', meta)); await tick(0);
  assert.equal(f.panels.length, 2, 'unresolved or mismatched names still ask');
});

test('a resolved app Allow covers later app requests in the same shell session', async t => {
  const f = fixture(t, { resolveApprovalApp: async () => 'com.apple.calculator' });
  const meta = { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'com.apple.calculator' } };
  for (const id of ['first', 'second']) {
    f.engine(card(id, 'Allow Computer Use to use "Calculator"?', meta)); await tick(0);
    assert.equal(f.sent.find(m => m.id === id).result._meta.persist, 'session');
  }
  assert.equal(f.panels.length, 1);
});

for (const failure of ['missing', 'wrong', 'throws', 'risk', 'audit']) test(`shell resolution fails closed for ${failure}`, async t => {
  const listed = new PreapprovedApps({ version: 1, apps: [{ app: 'com.apple.calculator', riskLevel: failure === 'risk' ? 'low' : 'high' }] });
  const f = fixture(t, { preapproved: listed, grantAudit: () => { if (failure === 'audit') throw new Error('audit unavailable'); },
    resolveApprovalApp: async () => {
      if (failure === 'throws') throw new Error('lookup unavailable');
      return failure === 'missing' ? '' : failure === 'wrong' ? 'com.example.other' : 'com.apple.calculator';
    } });
  const meta = { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'com.apple.calculator' } };
  f.engine(card('app', 'Allow Computer Use to use "Calculator"?', meta)); await tick(0);
  assert.equal(f.panels.length, 1);
  assert.equal(f.sent.find(m => m.id === 'app').result.action, 'accept');
  if (!['risk', 'audit'].includes(failure)) {
    assert.equal(f.panels[0][1], false);
    assert.equal(f.sent.find(m => m.id === 'app').result._meta, undefined);
  }
  assert.deepEqual(f.writes, []);
});

test('a late app resolution cannot answer after disposal', async t => {
  let resolve;
  const f = fixture(t, { resolveApprovalApp: () => new Promise(done => { resolve = done; }) });
  f.engine(card('late', 'Allow Computer Use to use "Calculator"?', { connector_id: 'computer-use', persist: ['session'],
    tool_params: { app: 'com.apple.calculator' } }));
  await tick(0); f.relay.dispose();
  resolve('com.apple.calculator'); await tick(0);
  assert.equal(f.panels.length, 0);
  assert.equal(f.sent.some(m => m.id === 'late'), false);
});

for (const choice of ['accept', 'decline', 'cancel']) test(`retries of one engine request join one pending ${choice} decision`, async t => {
  const shown = [];
  let answer;
  const f = fixture(t, { ask: (...args) => { shown.push(args); return new Promise(resolve => { answer = resolve; }); } });
  const meta = { connector_id: 'computer-use', riskLevel: 'high', tool_params: { app: 'Calculator' } };
  for (let n = 0; n < 7; n++) f.engine(card('repeat-request', 'Confirm this action?', meta));
  await tick(0);
  assert.equal(shown.length, 1);
  answer(choice); await tick(0);
  assert.equal(f.sent.filter(m => /^repeat-/.test(m.id)).length, 7);
  assert.ok(f.sent.filter(m => /^repeat-/.test(m.id)).every(m => m.result.action === choice && m.result._meta === undefined));
  f.engine(card('repeat-request', 'Confirm this action?', meta)); await tick(0);
  assert.equal(shown.length, 2, 'a later action needs its own decision');
  answer('cancel'); await tick(0);
});

for (const message of ['Pay $364?', 'Confirm this action?']) {
  for (const ids of [['independent-A', 'independent-B'], [7, '7']]) {
    test(`identical terms need separate decisions for ${JSON.stringify(ids)}: ${message}`, async t => {
      const answers = [];
      const f = fixture(t, { ask: () => new Promise(resolve => answers.push(resolve)) });
      const meta = { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'Calculator' } };
      for (const id of ids) f.engine(card(id, message, meta));
      await tick(0);
      assert.equal(answers.length, 1);
      answers[0]('accept'); await tick(0);
      assert.equal(f.sent.find(m => m.id === ids[0]).result.action, 'accept');
      assert.equal(f.sent.some(m => m.id === ids[1]), false, 'one Allow cannot answer a distinct request');
      assert.equal(answers.length, 2);
      answers[1]('cancel'); await tick(0);
      assert.equal(f.sent.find(m => m.id === ids[1]).result.action, 'cancel');
      assert.ok(f.sent.filter(m => ids.includes(m.id)).every(m => m.result._meta === undefined));
      assert.deepEqual(f.writes, []);
    });
  }
}

test('concurrent verified app requests share session memory after one Allow', async t => {
  const answers = [];
  const f = fixture(t, { resolveApprovalApp: async () => 'com.apple.calculator',
    ask: () => new Promise(resolve => answers.push(resolve)) });
  const meta = { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'com.apple.calculator' } };
  for (const id of ['app-A', 'app-B']) f.engine(card(id, 'Allow Computer Use to use "Calculator"?', meta));
  await tick(0);
  assert.equal(answers.length, 1);
  answers[0]('accept'); await tick(0);
  assert.equal(answers.length, 1);
  for (const id of ['app-A', 'app-B']) assert.deepEqual(f.sent.find(m => m.id === id).result,
    { action: 'accept', content: {}, _meta: { persist: 'session' } });
});

test('same request ID with changed terms cannot reuse a waiting decision', async t => {
  const answers = [];
  const f = fixture(t, { ask: () => new Promise(resolve => answers.push(resolve)) });
  f.engine(card('reused', 'Pay $364?'));
  f.engine(card('reused', 'Pay $365?'));
  await tick(0);
  answers[0]('accept'); await tick(0);
  assert.equal(answers.length, 2);
  assert.equal(f.sent.filter(m => m.id === 'reused').length, 1);
  answers[1]('cancel'); await tick(0);
  assert.deepEqual(f.sent.filter(m => m.id === 'reused').map(m => m.result.action), ['accept', 'cancel']);
});

test('one unavailable card does not fail a distinct request with identical terms', async t => {
  const decisions = [];
  const f = fixture(t, { ask: () => new Promise((resolve, reject) => decisions.push({ resolve, reject })) });
  for (const id of ['failed-panel', 'other-panel']) f.engine(card(id, 'Pay $364?'));
  await tick(0);
  decisions[0].reject(Object.assign(new Error('panel unavailable'), { code: 'SLEIGHT_PROMPT_UNAVAILABLE' }));
  await tick(0);
  assert.equal(f.sent.find(m => m.id === 'failed-panel').error.code, -32603);
  assert.equal(f.sent.some(m => m.id === 'other-panel'), false);
  assert.equal(decisions.length, 2);
  decisions[1].resolve('accept'); await tick(0);
  assert.deepEqual(f.sent.find(m => m.id === 'other-panel').result, { action: 'accept', content: {} });
  assert.equal(f.received.some(m => m.error), false, 'the engine retains attribution to the parent call');
});

test('engine loss invalidates the active and queued decisions before a late Allow', async t => {
  const answers = [];
  const f = fixture(t, { ask: () => new Promise(resolve => answers.push(resolve)) });
  for (const id of ['active', 'queued']) f.engine(card(id, 'Pay $364?'));
  await tick(0);
  assert.equal(answers.length, 1);
  f.relay.engineEnded('offline engine ended');
  answers[0]('accept'); await tick(0);
  assert.equal(answers.length, 1, 'the queued card is never opened after engine loss');
  assert.equal(f.sent.some(m => ['active', 'queued'].includes(m.id) && m.result?.action === 'accept'), false);
  assert.deepEqual(f.writes, []);
});

test('different pending engine confirmations keep separate decisions', async t => {
  const answers = [];
  const f = fixture(t, { ask: () => new Promise(resolve => answers.push(resolve)) });
  f.engine(card('first', 'Pay $364?', { connector_id: 'computer-use' }));
  f.engine(card('second', 'Pay $365?', { connector_id: 'computer-use' }));
  await tick(0);
  assert.equal(answers.length, 1);
  answers[0]('accept'); await tick(0);
  assert.equal(f.sent.find(m => m.id === 'first').result.action, 'accept');
  assert.equal(f.sent.some(m => m.id === 'second'), false);
  assert.equal(answers.length, 2);
  answers[1]('cancel'); await tick(0);
  assert.equal(f.sent.find(m => m.id === 'second').result.action, 'cancel');
});

test('the production shell prompt accepts only the native consent channel answer', async t => {
  let shown, deliver, closed = 0;
  const panel = createPaymentCard({ open: async () => ({
    present: (id, data, choices, callback) => { shown = { data, choices }; deliver = callback; },
    authenticate: event => event.person === true,
    close: () => { closed++; },
  }) });
  t.after(() => panel.close());
  const options = shellRelayOptions(undefined, panel);
  let answered = false;
  const pending = options.ask('Allow Grok Bot to use Calculator?', true).then(value => { answered = true; return value; });
  await tick(0);
  assert.deepEqual(shown.choices, ['once', 'cancel']);
  assert.deepEqual(shown.data.operation, { request: 'Allow Grok Bot to use Calculator?', scope: 'Allow for this Grok Bot session only' });
  assert.equal(shown.data.view.scope, 'Allow for this Grok Bot session only');
  const { question, detail } = approvalCardText('Allow Grok Bot to use Calculator?', true, options.wording());
  assert.deepEqual(shown.data.presentation, { question, detail,
    style: 'ask', host: 'Grok Bot', icon: shown.data.presentation.icon, kind: 'action' });
  deliver({ choice: 'once', person: false }); await tick(0);
  assert.equal(answered, false);
  deliver({ choice: 'once', person: true });
  assert.equal(await pending, 'accept');
  await panel.close();
  assert.equal(closed, 1);
});

test('only a verified session app approval selects the host-answerable card kind', async () => {
  const shown = [];
  const options = shellRelayOptions(undefined, { ask: async request => { shown.push(request); return 'cancel'; } });
  await options.ask('Allow Computer Use to use "Calculator"?', true, { appApproval: true });
  await options.ask('Allow Computer Use to use "Calculator"?', false, { appApproval: true });
  await options.ask('Pay $364?', true, { appApproval: false });
  assert.deepEqual(shown.map(request => request.presentation.kind), ['app', 'action', 'action']);
  assert.equal(shown[0].presentation.question, 'Allow Grok Bot to use Calculator?');
  assert.match(shown[0].presentation.detail, /this Grok Bot session ends/);
});

for (const message of ['Pay $268?', 'Book this trip?', 'Submit this form?', 'Save these settings?']) {
  test(`a Grok Bot engine confirmation uses sleight's panel every time: ${message}`, async t => {
    const f = fixture(t);
    for (const id of ['first', 'second']) {
      f.engine(card(id, message, { connector_id: 'computer-use', riskLevel: 'high' }));
      await tick(0);
      assert.equal(f.sent.at(-1).result.action, 'accept');
      assert.equal(f.sent.at(-1).result._meta, undefined);
    }
    assert.equal(f.panels.length, 2);
    assert.equal(f.panels[0][2].host, 'Grok Bot');
    assert.equal(f.panels[0][2].always, false);
    assert.equal(f.received.some(m => m.method === 'elicitation/create'), false);
  });
}

test('unknown connector cards also reach the panel without a host form', async t => {
  const f = fixture(t);
  f.engine(card('unknown', 'Confirm this action?'));
  await tick(0);
  assert.equal(f.panels.length, 1);
  assert.equal(f.sent.at(-1).result.action, 'accept');
});

test('an app pre-approval never answers a shell action confirmation', async t => {
  const preapproved = new PreapprovedApps({ version: 1, apps: [{ app: 'Firefox', riskLevel: 'high' }] });
  const f = fixture(t, { preapproved });
  for (const id of ['payment', 'booking', 'submit']) {
    f.engine(card(id, `Confirm ${id}?`, { connector_id: 'computer-use', persist: [], riskLevel: 'high',
      tool_params: { app: 'Firefox' } }));
    await tick(0);
    assert.equal(f.sent.at(-1).result.action, 'accept');
    assert.equal(f.sent.at(-1).result._meta, undefined);
  }
  assert.equal(f.panels.length, 3);
});

for (const grant of ['session', 'preapproved']) test(`${grant} app grant cannot answer payment or action cards with persist session`, async t => {
  const preapproved = grant === 'preapproved'
    ? new PreapprovedApps({ version: 1, apps: [{ app: 'Firefox', riskLevel: 'high' }] }) : undefined;
  const f = fixture(t, { preapproved });
  const meta = { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'Firefox' } };
  f.engine(card('app', 'Allow Computer Use to use "Firefox"?', meta));
  await tick(0);
  const initial = f.panels.length;
  for (const [index, message] of ['Pay $268?', 'Confirm this action?', 'Book this trip?', 'Save these settings?', 'Submit this form?'].entries()) {
    f.engine(card(`action-${index}`, message, meta));
    await tick(0);
    assert.equal(f.panels.length, initial + index + 1);
    assert.equal(f.panels.at(-1)[1], false);
    assert.equal(f.sent.at(-1).result._meta, undefined);
  }
  f.engine(card('app-again', 'Allow Computer Use to use "Firefox"?', meta));
  await tick(0);
  assert.equal(f.panels.length, initial + 5);
});

for (const grant of ['session', 'preapproved']) test(`${grant} grant cannot answer a plain app card naming a different app`, async t => {
  const preapproved = grant === 'preapproved'
    ? new PreapprovedApps({ version: 1, apps: [{ app: 'Firefox', riskLevel: 'high' }] }) : undefined;
  const f = fixture(t, { preapproved });
  const meta = { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'Firefox' } };
  f.engine(card('original', 'Allow Computer Use to use "Firefox"?', meta));
  await tick(0);
  const initial = f.panels.length;
  for (let n = 0; n < 2; n++) {
    f.engine(card(`mismatch-${n}`, 'Allow Computer Use to use "Calculator"?', meta));
    await tick(0);
    assert.equal(f.panels.length, initial + n + 1);
    assert.equal(f.panels.at(-1)[1], false);
    assert.equal(f.sent.at(-1).result._meta, undefined);
  }
});

test('accepting a mismatched app card never seeds session memory', async t => {
  const f = fixture(t);
  const meta = { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'Firefox' } };
  f.engine(card('mismatch', 'Allow Computer Use to use "Calculator"?', meta)); await tick(0);
  f.engine(card('matching', 'Allow Computer Use to use "Firefox"?', meta)); await tick(0);
  assert.equal(f.panels.length, 2);
  assert.equal(f.sent.find(msg => msg.id === 'mismatch').result._meta, undefined);
});

for (const tool of ['drag', 'open_file']) for (const grant of ['session', 'preapproved']) {
  test(`shell ${tool} asks the panel each time despite ${grant} grants`, async t => {
    const app = 'Calculator';
    const preapproved = grant === 'preapproved'
      ? new PreapprovedApps({ version: 1, apps: [{ app, riskLevel: 'high' }] }) : undefined;
    let actions = 0;
    const f = fixture(t, { preapproved, localTools: { tools: [{ name: tool }],
      call: async (name, args, approve) => {
        if (await approve([name, app], `Allow ${name} in ${app}?`)) actions++;
        return { content: [] };
      } } });
    f.engine(card('app', `Allow Computer Use to use "${app}"?`, { connector_id: 'computer-use', persist: ['session'],
      riskLevel: 'high', tool_params: { app } }));
    await tick(0);
    const initial = f.panels.length;
    for (let n = 0; n < 2; n++) {
      f.client({ id: `local-${n}`, method: 'tools/call', params: { name: tool, arguments: { app, from: [1, 2], to: [3, 4] } } });
      await tick(0);
      assert.equal(actions, n + 1);
      assert.equal(f.panels.length, initial + n + 1);
      assert.equal(f.panels.at(-1)[1], false);
      assert.equal(f.panels.at(-1)[2].always, false);
    }
    assert.deepEqual(f.writes, []);
  });
}

test('shell panel bounds the request while keeping the session scope visible', async t => {
  let shown;
  const panel = createPaymentCard({ open: async () => ({
    present: (id, data, choices, answer) => { shown = { data, choices }; answer({ choice: 'once' }); },
    authenticate: () => true,
  }) });
  t.after(() => panel.close());
  for (const request of ['x'.repeat(65536), '🧾'.repeat(16384)]) {
    assert.equal(await shellRelayOptions(undefined, panel).ask(request, true), 'accept');
    assert.ok(Buffer.byteLength(shown.data.operation.request) <= 2048);
    assert.match(shown.data.operation.request, /\[request truncated\]$/);
    assert.ok(Buffer.byteLength(shown.data.presentation.question) <= 2048);
    assert.match(shown.data.presentation.question, /\[request truncated\]$/);
    assert.ok(Buffer.byteLength(shown.data.presentation.detail) <= 2048);
    assert.equal(shown.data.view.scope, 'Allow for this Grok Bot session only');
  }
});

test('shell panel distinguishes a declined card from an unavailable host', async () => {
  const unavailable = shellRelayOptions(undefined, { ask: async () => undefined });
  await assert.rejects(unavailable.ask('Pay?', false), error => error.code === 'SLEIGHT_PROMPT_UNAVAILABLE' && /unavailable/i.test(error.message));
  assert.equal(await shellRelayOptions(undefined, { ask: async () => 'cancel' }).ask('Pay?', false), 'cancel');
});

test('unavailable shell consent returns an explicit error to the engine', async t => {
  const options = shellRelayOptions(undefined, { ask: async () => undefined });
  const f = fixture(t, { ask: options.ask });
  f.engine(card('payment', 'Pay $268?', { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'Firefox' } }));
  await tick(0);
  assert.equal(f.sent.at(-1).error.code, -32603);
  assert.match(f.sent.at(-1).error.message, /panel unavailable; no approval was granted/);
});

test('shell consent cannot write pre-approvals even if a panel returns Always', async t => {
  const f = fixture(t, { answer: 'always' });
  f.engine(card('app', 'Allow Computer Use to use "Calculator"?', { connector_id: 'computer-use', persist: ['session', 'always'],
    riskLevel: 'low', tool_params: { app: 'Calculator' } }));
  await tick(0);
  assert.deepEqual(f.writes, []);
  assert.equal(f.sent.at(-1).result.action, 'cancel');
  assert.equal(f.panels[0][2].always, false);
});

test('app Allow has no lasting grant across shell sessions', async t => {
  for (let n = 0; n < 2; n++) {
    const f = fixture(t);
    f.engine(card('app', 'Allow Computer Use to use "Calculator"?', { connector_id: 'computer-use', persist: ['session', 'always'],
      riskLevel: 'low', tool_params: { app: 'Calculator' } }));
    await tick(0);
    assert.equal(f.panels.length, 1);
    assert.equal(f.sent.at(-1).result._meta.persist, 'session');
    assert.deepEqual(f.writes, []);
  }
});

test('the native payment guard still opens a payment card without a bound user message', async t => {
  const asked = [];
  let answer;
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-shell-payment-')));
  t.after(() => removeTemp(directory));
  const f = fixture(t, { inputLease: new InputLease({ directory, holder: 'shell-payment-test' }),
    paymentCard: { ask: value => { asked.push(value); return new Promise(resolve => { answer = resolve; }); }, close() {} } });
  const before = readFileSync(new URL('fixtures/payment-gate/firefox-checkout-sol.txt', import.meta.url), 'utf8')
    .split('\n').filter(line => !/^\t*(?:89|9[0-7]) /.test(line)).join('\n');
  const call = (id, code) => f.client({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
  const reply = (id, text, isError = false) => f.engine({ id, result: { isError, content: [{ type: 'text', text }],
    _meta: { 'codex/toolSurface': { app: { appId: 'org.mozilla.firefox' } } } } });
  call('read', 'let app = await cua.getApp("Firefox")'); reply('read', before);
  call('pay', 'await app.click(88)');
  const sent = f.sent.find(m => m.id === 'pay');
  const setup = JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(sent.params.arguments.code)[1]);
  assert.deepEqual(setup.payment, { setting: 'always', message: null, spent: null, allow: null });
  const payment = { why: 'nocopy', site: '127.0.0.1:5413', shown: '$268.00', control: 'button Pay now' };
  const error = 'sleight stopped this payment: no copy of the user message';
  reply('pay', `Error: ${error}\n${before}\n${setup.guardStopMark}${JSON.stringify({ index: 0, attempts: 1, completed: 0,
    name: 'click', shown: 'click(88)', ran: [], error, payment })}`, true);
  await tick(0);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].session, 'Grok Bot');
  assert.equal(asked[0].shown, '$268.00');
  answer('cancel'); await tick(0);
  assert.equal(f.received.find(m => m.id === 'pay').result.isError, true);
});

test('shell policy preserves all engine confirmations and turbo stays unavailable', t => {
  const f = fixture(t);
  const policy = readFileSync(new URL('fixtures/engine-confirmations-policy.txt', import.meta.url), 'utf8').trimEnd();
  f.client({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'nodeRepl.write(4)' } } });
  f.engine({ id: 1, result: { content: [{ type: 'text', text: '## Computer Use\nNative reference.\n\n' + policy }] } });
  assert.ok(JSON.stringify(f.received.at(-1)).includes(JSON.stringify(policy).slice(1, -1)));
  f.client({ id: 2, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } });
  assert.match(JSON.stringify(f.received.at(-1)), /Turbo is off.*Grok Bot shell has no trusted user-turn binding/);
  assert.equal(f.sent.some(msg => msg.params?.name === 'browser_tabs'), false);
  assert.equal(f.wording().claudeCode, false);
  assert.equal(hostLabel({ name: 'Grok Bot', version: '1' }), 'Grok Bot');
});
