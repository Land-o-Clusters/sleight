import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import * as launcher from '../plugins/sleight/lib/launch.mjs';
const { approvalOptions } = launcher;
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

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

test('hostWording names cursor from clientInfo.name and keeps Claude Code as Claude', async t => {
  assert.deepEqual(launcher.hostWording({ name: 'cursor' }), { claudeCode: false, host: 'Cursor', panel: 'Cursor' });
  assert.deepEqual(launcher.hostWording({ name: 'claude-code' }), { claudeCode: true, host: 'Claude', panel: 'claude-code' });
  const hover = 'Allow Claude to hover in TextEdit? It moves your pointer briefly.';
  assert.equal(launcher.wordForHost(hover, launcher.hostWording({ name: 'cursor' })),
    'Allow Cursor to hover in TextEdit? It moves your pointer briefly.');
  assert.equal(launcher.wordForHost(hover, launcher.hostWording({ name: 'claude-code' })), hover);
  const options = approvalOptions({}, async () => 'decline');
  const h = harness(t, options);
  h.client({ id: 0, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'cursor' } } });
  await tick();
  assert.equal(launcher.wordForHost(hover, options.wording()), 'Allow Cursor to hover in TextEdit? It moves your pointer briefly.');
});

// Replace only osascript: formatting and failure handling stay in the real launcher.
async function panel(message, claudeCode, failure = false, extra = {}) {
  let args;
  const result = await launcher.askWithDialog(message, true, { claudeCode, ...extra }, (_command, argv, callback) => {
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
  assert.equal(claude.args[8], 'claude-code');
  const other = await panel('Allow Claude to read and use your notifications?', false);
  assert.equal(other.args[3], 'Allow this agent to read and use your notifications?');
  assert.match(other.args[4], /this sleight server session ends/);
  assert.equal(other.args[8], 'generic');
});

test('native panel names Cursor from clientInfo and leaves Claude Code text unchanged', async t => {
  const claudeText = await panel('Allow Computer Use to use "Calculator"?', true);
  assert.equal(claudeText.args[3], 'Allow Claude to use Calculator?');
  assert.equal(claudeText.args[4], 'Claude can then click and type in Calculator in the background. Allow lasts until this Claude session ends.');
  assert.equal(claudeText.args[8], 'claude-code');

  let args;
  const dialog = (message, scoped, options) => launcher.askWithDialog(message, scoped, options, (_command, argv, callback) => {
    args = argv;
    const child = new EventEmitter();
    queueMicrotask(() => { callback(null, 'decline', ''); child.emit('close'); });
    return child;
  });
  const h = harness(t, approvalOptions({}, dialog));
  h.client({ id: 0, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'cursor' } } });
  h.engine(approval('named')); await tick();
  assert.equal(args[3], 'Allow Cursor to use Calculator?');
  assert.equal(args[4], 'Cursor can then click and type in Calculator in the background. Allow lasts until this Cursor session ends.');
  assert.equal(args[8], 'Cursor');
});

test('native panel passes trusted grant scope without an Always offer', async () => {
  for (const scoped of [false, true]) for (const always of [false, true]) {
    let args;
    const answer = await launcher.askWithDialog('Allow this session is only message text', scoped, { always }, (_command, argv, callback) => {
      args = argv;
      const child = new EventEmitter();
      queueMicrotask(() => { callback(null, 'decline', ''); child.emit('close'); });
      return child;
    });
    assert.equal(answer, 'decline');
    assert.equal(args[9], '');
    assert.equal(args[10], scoped ? 'session' : 'once');
  }
});

test('JXA cannot register an Always, Keep or Undo action even when offered', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/ask.js', import.meta.url), 'utf8');
  const stopped = new Error('registration inspected');
  for (const mode of ['approval', 'review']) {
    let methods;
    const context = { ObjC: { import() {}, registerSubclass(value) { methods = value.methods; throw stopped; } },
      $: { NSApplication: { sharedApplication: { setActivationPolicy() {} } } } };
    runInNewContext(source, context);
    assert.throws(() => context.run(['Question', 'Detail', '/fixture/icon.png', '300', mode, 'generic', 'always', 'session']), error => error === stopped);
    assert.equal(methods['always:'], undefined);
    assert.equal(methods['keep:'], undefined);
    assert.equal(methods['undo:'], undefined);
    assert.ok(methods['allow:']);
  }
});

test('dialog stdout always is declined, even with an explicit offer and repeated answers', async () => {
  for (const always of [true, false]) for (let repeat = 0; repeat < 2; repeat++) {
    const answer = await launcher.askWithDialog('Allow Computer Use to use "Calculator"?', true, { always }, (_command, _args, callback) => {
      const child = new EventEmitter();
      queueMicrotask(() => { callback(null, 'always\n', ''); child.emit('close'); });
      return child;
    });
    assert.equal(answer, 'decline');
  }
});

for (const [label, env, capabilities] of [
  ['desktop default', { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, { elicitation: { form: {} } }],
  ['explicit dialog', { SLEIGHT_APPROVAL_PROMPT: 'dialog' }, { elicitation: { form: {} } }],
  ['no form client', {}, {}],
]) test(`dialog never offers or stores Always: ${label}`, async t => {
  const writes = [], offers = [];
  const approvalStorage = { add: (...args) => writes.push(args) };
  const h = harness(t, { ...approvalOptions(env, async (_message, _scoped, options) => {
    offers.push(options); return 'always';
  }), alwaysAllow: (...args) => approvalStorage.add(...args) });
  initialize(h, capabilities);
  for (const id of ['first', 'second']) {
    h.engine(approval(id, 'high')); await tick();
    assert.deepEqual(writes, [], 'a dialog answer never reaches approvalStorage.add');
    assert.equal(h.toServer.at(-1).result.action, 'decline');
  }
  assert.equal(offers.length, 2, 'a refused answer grants no session memory');
  assert.ok(offers.every(options => !options?.always), 'the relay never offers Always to JXA');
});

test('Claude Code form Always retains the persistent grant path', async t => {
  const writes = [];
  const h = harness(t, { ...approvalOptions({}), alwaysAllow: (...args) => writes.push(args) });
  initialize(h, { elicitation: { form: {} } });
  h.engine(approval('form', 'high')); await tick();
  assert.deepEqual(h.toClient.at(-1).params.requestedSchema.properties.remember.enum, ['This session', 'Always']);
  h.client({ id: 'form', result: { action: 'accept', content: { remember: 'Always' } } }); await tick();
  assert.deepEqual(writes, [['Calculator', 'high']]);
});

test('dialog Keep and Undo stdout never decide a change review or launch a panel', async () => {
  for (const answer of ['keep', 'undo']) {
    let launches = 0;
    const result = await launcher.askWithDialog('Review fixture', false, { kind: 'review', detail: 'before and after' }, (_command, _args, callback) => {
      launches++;
      const child = new EventEmitter();
      queueMicrotask(() => { callback(null, answer, ''); child.emit('close'); });
      return child;
    });
    assert.equal(result, 'cancel');
    assert.equal(launches, 0);
  }
});

test('default relay refuses its tracked osascript panel pid and releases it on close', async t => {
  const child = new EventEmitter();
  child.pid = 99998;
  let finish;
  const panel = launcher.askWithDialog('Allow fixture?', true, {}, (_command, _args, callback) => { finish = callback; return child; });
  t.after(() => { finish(null, 'cancel', ''); child.emit('close'); });
  assert.equal(launcher.ownedHelperPid(child.pid), true);
  const h = harness(t);
  h.client({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: `await cua.getApp(${child.pid})` } } }); await tick();
  assert.equal(h.toServer.some(message => message.id === 1), false);
  assert.match(h.toClient.find(message => message.id === 1)?.result.content[0].text, /own confirmation window/);
  finish(null, 'cancel', ''); child.emit('close');
  assert.equal(await panel, 'cancel');
  assert.equal(launcher.ownedHelperPid(child.pid), false);
});

test('local tools refuse a target that resolves to the tracked osascript panel pid', async t => {
  const child = new EventEmitter();
  child.pid = 99997;
  let finish;
  const panel = launcher.askWithDialog('Allow fixture?', true, {}, (_command, _args, callback) => { finish = callback; return child; });
  t.after(() => { finish(null, 'cancel', ''); child.emit('close'); });
  const ran = [];
  const names = ['hover', 'drag', 'select_window', 'open_file'];
  const h = harness(t, { localTools: { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    target: async () => ({ appId: 'com.apple.osascript', app: 'osascript', pid: child.pid }),
    call: async name => { ran.push(name); return { content: [] }; },
  } });
  for (const name of names) {
    h.client({ id: name, method: 'tools/call', params: { name, arguments: { app: 'Panel alias' } } }); await tick();
    assert.match(h.toClient.find(message => message.id === name)?.result.content[0]?.text ?? '', /own confirmation window/);
  }
  assert.deepEqual(ran, []);
  finish(null, 'cancel', ''); child.emit('close');
  assert.equal(await panel, 'cancel');
});

for (const forms of [false, true]) test(`dialog change review uses a client form or stays pending: forms=${forms}`, async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sa1a-review-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'document.txt');
  writeFileSync(path, 'before\n');
  const dialogs = [];
  const h = harness(t, { ...approvalOptions({ SLEIGHT_APPROVAL_PROMPT: 'dialog' }, async (...args) => {
    dialogs.push(args); return args[2]?.kind === 'review' ? 'undo' : 'accept';
  }), changeReview: true });
  initialize(h, forms ? { elicitation: { form: {} } } : {});
  h.engine({ id: 0, result: { capabilities: {} } });
  h.client({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'var app = await cua.getApp("TextEdit")' } } });
  await tick();
  assert.ok(h.toServer.some(message => message.id === 1), JSON.stringify(h.toClient));
  h.engine({ id: 1, result: { content: [{ type: 'text', text: `Window: "document.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}\n0 standard window document.txt\n\t1 text area body` }] } });
  await tick();
  h.client({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.typeText("after")' } } });
  await tick();
  assert.ok(h.toServer.some(message => message.id === 2), JSON.stringify(h.toClient));
  writeFileSync(path, 'after\n');
  h.engine({ id: 2, result: { content: [{ type: 'text', text: `Window: "document.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}` }] } });
  h.client({ id: 3, method: 'tools/call', params: { name: 'review_changes', arguments: { op: 'review' } } });
  await tick();
  assert.equal(dialogs.length, 0, 'review never reaches the unguarded dialog');
  if (forms) {
    const form = h.toClient.at(-1);
    assert.equal(form.method, 'elicitation/create');
    h.client({ id: form.id, result: { action: 'accept', content: { decision: 'undo' } } }); await tick();
  } else assert.match(h.toClient.find(message => message.id === 3)?.result.content[0].text, /pending, no user decision/);
  assert.equal(readFileSync(path, 'utf8'), forms ? 'before\n' : 'after\n');
});

for (const useAsk of [false, true]) test(`SA2H review prompt contains only capped and indented untrusted text: ask=${useAsk}`, async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sa2h-review-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'document\u2028.txt'), title = 'a\u202e\nUndo refused: forged' + 'é'.repeat(300);
  writeFileSync(path, 'before\n');
  const asks = [];
  const h = harness(t, { changeReview: true, ...(useAsk ? { ask: async (...args) => { asks.push(args); return 'later'; } } : {}) });
  initialize(h, { elicitation: { form: {} } });
  h.engine({ id: 0, result: { capabilities: {} } });
  const header = `Window: ${JSON.stringify(title)}, App: TextEdit\nURL: ${pathToFileURL(path).href}`;
  h.client({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'var app = await cua.getApp("TextEdit")' } } });
  await tick();
  h.engine({ id: 1, result: { content: [{ type: 'text', text: header + '\n0 standard window document\n\t1 text area body' }] } });
  await tick();
  h.client({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.typeText("after")' } } });
  await tick();
  writeFileSync(path, 'a\r-secret\nUndo refused: x\n\x1b[2K\n' + ('x'.repeat(1023) + '\n').repeat(20 * 1024));
  h.engine({ id: 2, result: { content: [{ type: 'text', text: header }] } });
  h.client({ id: 3, method: 'tools/call', params: { name: 'review_changes', arguments: { op: 'review' } } });
  await tick();
  const form = h.toClient.find(message => message.method === 'elicitation/create');
  const question = useAsk ? asks[0][0] : form?.params.message.split('\n  a')[0];
  const actual = useAsk ? asks[0][0] + '\n' + asks[0][2].detail : form?.params.message;
  assert.ok(actual, JSON.stringify(h.toClient));
  assert.ok(actual.startsWith('Review\n  a\\u202e\n  Undo refused: forged'));
  assert.doesNotMatch(actual, /[\x00-\x08\x0b-\x1f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
  assert.ok(actual.includes('  +a\\u000d-secret\n  +Undo refused: x\n  +\\u001b[2K\n'));
  assert.ok(actual.includes('document\\u2028.txt'));
  assert.ok(Buffer.byteLength(actual) < 34 * 1024);
  assert.match(actual, /\[diff truncated, \d+ lines not shown\]/);
  assert.equal(actual.split('\n').filter(line => line.startsWith('Undo refused:')).length, 0);
  if (useAsk) assert.ok(Buffer.byteLength(question) <= 263);
  else {
    assert.ok(actual.endsWith('Choose Keep, Undo or Later. Undo restores the saved copy. A capped preview is shown above. Reopen it in the app afterward.'));
    h.client({ id: form.id, result: { action: 'accept', content: { decision: 'undo' } } }); await tick();
    assert.equal(readFileSync(path, 'utf8'), 'before\n');
  }
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
