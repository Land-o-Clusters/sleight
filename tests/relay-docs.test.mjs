import { fixtureDocumentation } from './helpers/canonical-docs.mjs';
// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { RESULT_LIMIT } from '../plugins/sleight/lib/result-budget.mjs';
import { createRelay, beforeFirstTree } from '../plugins/sleight/lib/relay.mjs';
import { GUARD_MARK } from '../plugins/sleight/lib/compact-reads.mjs';

const text = text => ({ type: 'text', text });
const docs = '## Computer Use\nNative API reference.\n\n' + readFileSync(new URL('fixtures/engine-confirmations-policy.txt', import.meta.url), 'utf8');
const tree = 'Window: "note.txt", App: Example.\n0 standard window note.txt\n\t1 text area Value: draft';
const rules = 'Keep the existing skill rules.';
const ownedDocs = readFileSync(new URL('fixtures/native-api-docs.txt', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = options.clientOut ?? new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], traces = [];
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false, openShot: false,
    documentationTrust: fixtureDocumentation(docs, ownedDocs, '# Other Browser APIs\nBrowser reference.', '# Browser Safety\nKeep user tabs.'), firstCallRules: rules, trace: (kind, detail) => traces.push({ kind, detail }),
    localTools: { tools: [{ name: 'open_file' }], call: async () => ({ content: [text('Opened note.txt.')],
      _meta: { 'sleight/openedApp': 'org.example.editor' } }) }, ...options });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
  const reply = msg => serverOut.write(JSON.stringify(msg) + '\n');
  return { sent, received, traces, send,
    tool: (id, name, args = {}) => send({ id, method: 'tools/call', params: { name, arguments: args } }),
    call: (id, code = 'nodeRepl.write(4)') => send({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }),
    reset: id => send({ id, method: 'tools/call', params: { name: 'js_reset', arguments: {} } }),
    reply: (id, content, isError = false, _meta) => reply({ id, result: { content, isError, ...(_meta ? { _meta } : {}) } }),
    error: (id, message) => reply({ id, error: { code: -32603, message } }),
    async warm() {
      send({ id: -1, method: 'initialize', params: { capabilities: {} } });
      reply({ id: -1, result: {} });
      send({ method: 'notifications/initialized' }); await tick();
      const warm = sent.find(m => String(m.id).startsWith('sleight-warm-'));
      assert.ok(warm);
      reply({ id: warm.id, result: { content: [text(docs)] } }); await tick();
    },
    async open(id = 1, content = [text(docs), text(tree), text('')], isError = false) {
      send({ id, method: 'tools/call', params: { name: 'open_file', arguments: { app: 'Example', path: '/tmp/note.txt' } } });
      await tick();
      reply({ id: sent.at(-1).id, result: { content, isError } }); await tick();
      return received.find(m => m.id === id).result;
    },
  };
}
const body = result => result.content.map(c => c.text ?? '').join('\n');
const result = (h, id) => h.received.find(m => m.id === id).result;

async function beginOwnedWarm(h) {
  h.send({ id: -1, method: 'initialize', params: { capabilities: {} } });
  h.reply(-1, []);
  h.send({ method: 'notifications/initialized' }); await tick();
  return h.sent.find(m => m.params?.arguments?.title === 'Prepare sleight REPL');
}
test('private mod frames leave the docs fixture reply byte-identical, even with private metadata', async t => {
  const replies = [];
  for (const frame of [undefined, { sleight_stats_begin: 'turn-1' },
    { sleight_say: { toolUseId: 'toolu_first', text: 'Opening the app.' } },
    { sleight_stats_skip: 'toolu_child' }, { sleight_stats_skip: { snapshot: true } }]) {
    const h = harness(t, { warmRepl: true });
    if (frame) h.send({ id: 'stats', method: 'tools/call', params: { name: 'turn_ended',
      arguments: frame, _meta: { privateFrame: true } } });
    const warm = await beginOwnedWarm(h);
    h.reply(warm.id, [text(ownedDocs), text('[sleight:guard-ready]\n')]); await tick();
    h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('ordinary output')]); await tick();
    const reply = result(h, 1);
    const delivered = reply.content.find(c => c.text?.startsWith('## Computer Use\n'));
    assert.equal(ownedDocs.length - delivered.text.length, 201);
    replies.push(Buffer.from(JSON.stringify(reply)));
  }
  for (const reply of replies) assert.deepEqual(reply, replies[0]);
});
test('only the isolated app-free warmup projects the known native fence, once', async t => {
  const h = harness(t, { warmRepl: true });
  const warm = await beginOwnedWarm(h);
  h.reply(warm.id, [text(ownedDocs), text('[sleight:guard-ready]\n')]); await tick();
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('ordinary output')]); await tick();
  const delivered = result(h, 1).content.find(c => c.text?.startsWith('## Computer Use\n'));
  assert.ok(delivered, JSON.stringify(result(h, 1)));
  assert.equal(ownedDocs.length - delivered.text.length, 201);
  assert.ok(delivered.text.endsWith(ownedDocs.slice(ownedDocs.indexOf('## Output'))));
  h.call(2, 'await cua.rewriteDocumentation()'); h.reply(2, [{ ...text(ownedDocs), _meta: { source: 'cua.core' } }]);
  assert.ok(result(h, 2).content.some(c => c.text === ownedDocs), 'printed copies remain whole');
});
for (const duration of [0, 1.25]) test(`owned warmup accepts the observed timing singleton: ${duration}`, async t => {
  const h = harness(t, { warmRepl: true }); const warm = await beginOwnedWarm(h);
  h.reply(warm.id, [text(ownedDocs), text('[sleight:guard-ready]\n')], false, { 'codex/nodeReplExecutionDurationMs': duration }); await tick();
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('output')]); await tick();
  const delivered = result(h, 1).content.find(c => c.text?.startsWith('## Computer Use\n'));
  assert.equal(ownedDocs.length - delivered.text.length, 201);
  assert.ok(delivered.text.endsWith(ownedDocs.slice(ownedDocs.indexOf('## Output'))));
});
test('owned warmup compacts the observed Notes format while preserving its complete suffix', async t => {
  const notes = '\n## Notes\n\nLiteral note: `a  b`.\n  Preserve indentation and Unicode: café.\n\n';
  const full = ownedDocs.replace('\n# Computer Use Confirmations Policy', notes + '\n# Computer Use Confirmations Policy');
  const h = harness(t, { warmRepl: true, documentationTrust: fixtureDocumentation(full) }); const warm = await beginOwnedWarm(h);
  h.reply(warm.id, [text(full), text('[sleight:guard-ready]\n')], false, { 'codex/nodeReplExecutionDurationMs': 0 }); await tick();
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('ordinary output')]); await tick();
  const delivered = result(h, 1).content.find(c => c.text?.startsWith('## Computer Use\n')).text;
  assert.equal(full.length - delivered.length, 201);
  assert.equal(delivered.slice(delivered.indexOf('\n## Notes\n')), full.slice(full.indexOf('\n## Notes\n')));
});
test('a client ID collision cannot complete or impersonate the private warmup', async t => {
  const h = harness(t, { warmRepl: true });
  const warm = await beginOwnedWarm(h);
  h.tool(warm.id, 'open_file', { app: 'Example', path: '/tmp/note.txt' }); await tick();
  assert.ok(h.received.some(m => m.id === warm.id && (m.error || m.result?.isError)), 'collision is refused');
  assert.equal(h.sent.filter(m => m.id === warm.id && m.method === 'tools/call').length, 1);
  h.reply(warm.id, [text(ownedDocs)]); await tick();
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('output')]);
  assert.ok(result(h, 1).content.some(c => c.text === ownedDocs));
});
test('private warmup IDs avoid a prior client request that is still in flight', async t => {
  const h = harness(t, { warmRepl: true });
  h.tool('sleight-warm-1', 'unknown_tool');
  const warm = await beginOwnedWarm(h);
  assert.notEqual(warm.id, 'sleight-warm-1');
  h.reply(warm.id, [text(ownedDocs)]); await tick();
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('output')]);
  assert.ok(result(h, 1).content.some(c => c.text === ownedDocs));
});
for (const overlap of ['open_file', 'unknown_tool', 'js_reset']) test(`warmup overlap from ${overlap} keeps full docs`, async t => {
  const h = harness(t, { warmRepl: true });
  const warm = await beginOwnedWarm(h);
  h.tool(10, overlap, { app: 'Example', path: '/tmp/note.txt' }); await tick();
  h.reply(warm.id, [text(ownedDocs)]); await tick();
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('output')]);
  assert.ok(result(h, 1).content.some(c => c.text === ownedDocs));
});
test('warmup ownership cannot cross a client kernel metadata change', async t => {
  const h = harness(t, { warmRepl: true }); const warm = await beginOwnedWarm(h);
  h.reply(warm.id, [text(ownedDocs)]); await tick();
  h.send({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getApp("Example")' },
    _meta: { 'codex/sandbox-state': { mode: 'other' } } } });
  h.reply(1, [text('output')]);
  assert.ok(result(h, 1).content.some(c => c.text === ownedDocs));
});
test('a failed write retries full guidance and keeps the projection eligible', async t => {
  const clientOut = new PassThrough();
  const write = clientOut.write.bind(clientOut); let fail = false;
  clientOut.write = (line, callback) => {
    if (fail && JSON.parse(line).id === 1) { fail = false; callback?.(Error('synthetic failed write')); return true; }
    return write(line, callback);
  };
  const h = harness(t, { warmRepl: true, clientOut, dedupeRules: true }); const warm = await beginOwnedWarm(h);
  h.reply(warm.id, [text(ownedDocs)]); await tick(); fail = true;
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('first action output')]); await tick();
  assert.equal(h.received.some(m => m.id === 1), false);
  h.call(2, 'await app.getAXState()'); h.reply(2, [text('second output')]); await tick();
  const out = result(h, 2);
  assert.ok(out.content.some(c => c.text?.startsWith('## Computer Use\n') && ownedDocs.length - c.text.length === 201));
  assert.match(body(out), /Keep the existing skill rules\./);
  assert.doesNotMatch(body(out), /first action output/);
});
test('a temporarily closed client output retains guidance before any projection is spent', async t => {
  const clientOut = new PassThrough(); let blocked = false;
  Object.defineProperty(clientOut, 'writableEnded', { get: () => blocked });
  const h = harness(t, { warmRepl: true, clientOut }); const warm = await beginOwnedWarm(h);
  h.reply(warm.id, [text(ownedDocs)]); await tick();
  h.call(1, 'await cua.getApp("Example")'); blocked = true; h.reply(1, [text('first output')]);
  blocked = false; h.call(2, 'await app.getAXState()'); h.reply(2, [text('second output')]); await tick();
  assert.ok(result(h, 2).content.some(c => c.text?.startsWith('## Computer Use\n') && ownedDocs.length - c.text.length === 201));
  assert.match(body(result(h, 2)), /Keep the existing skill rules\./);
  assert.doesNotMatch(body(result(h, 2)), /first output/);
});
test('Grok cap failures retain full guidance and do not consume documentation projection', async t => {
  const h = harness(t, { warmRepl: true });
  h.send({ id: -1, method: 'initialize', params: { clientInfo: { name: 'grok-shell-test' }, capabilities: {} } });
  h.reply(-1, []); h.send({ method: 'notifications/initialized' }); await tick();
  const warm = h.sent.find(m => String(m.id).startsWith('sleight-warm-'));
  h.reply(warm.id, [text(ownedDocs)]); await tick();
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('x'.repeat(30000))]); await tick();
  const failure = result(h, 1);
  assert.equal(failure.isError, true);
  assert.ok(failure.content.some(c => c.text === ownedDocs), 'failure returns full docs when they fit');
  h.call(2, 'await app.getAXState()'); h.reply(2, [text('small result')]); await tick();
  assert.ok(result(h, 2).content.some(c => c.text?.startsWith('## Computer Use\n') && ownedDocs.length - c.text.length === 201));
});
for (const mode of ['request', 'env', 'error', 'warm-error', 'unknown-shape', 'duplicate'])
  test(`owned warmup keeps full documentation or suppresses duplicate private delivery: ${mode}`, async t => {
    const previous = process.env.SLEIGHT_ENGINE_DOCS;
    if (mode === 'env') process.env.SLEIGHT_ENGINE_DOCS = 'full';
    t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_ENGINE_DOCS; else process.env.SLEIGHT_ENGINE_DOCS = previous; });
    const h = harness(t, { warmRepl: true }); const warm = await beginOwnedWarm(h);
    h.reply(warm.id, [text(ownedDocs), ...(mode === 'unknown-shape' ? [text('unexpected output')] : [])], mode === 'warm-error'); await tick();
    if (mode === 'duplicate') h.reply(warm.id, [text(ownedDocs)]);
    h.call(1, mode === 'request' ? 'await cua.rewriteDocumentation()' : 'await cua.getApp("Example")');
    h.reply(1, [text('output')], mode === 'error'); await tick();
    const doc = result(h, 1).content.find(c => c.text?.startsWith('## Computer Use\n'));
    assert.ok(doc);
    assert.equal(ownedDocs.length - doc.text.length, mode === 'duplicate' ? 201 : 0);
    assert.equal(h.received.some(m => m.id === warm.id), false);
  });
test('owned documentation preserves the ordinary policy rewrites byte for byte', async t => {
  const full = ownedDocs.slice(0, ownedDocs.indexOf('# Computer Use Confirmations Policy')) +
    readFileSync(new URL('fixtures/engine-confirmations-policy.txt', import.meta.url), 'utf8');
  const policy = value => value.slice(value.indexOf('# Computer Use Confirmations Policy'));
  for (const confirmPayments of ['always', 'requested', 'never']) for (const rs of ['0', '1']) {
    const baseline = harness(t, { confirmPayments, rs, documentationTrust: fixtureDocumentation(full) });
    baseline.call(1, 'await cua.getApp("Example")'); baseline.reply(1, [text(full)]);
    const expected = result(baseline, 1).content.find(c => c.text?.startsWith('## Computer Use\n')).text;
    const h = harness(t, { warmRepl: true, confirmPayments, rs, documentationTrust: fixtureDocumentation(full) }); const warm = await beginOwnedWarm(h);
    h.reply(warm.id, [text(full)]); await tick();
    h.call(1, 'await cua.getApp("Example")'); h.reply(1, [text('output')]); await tick();
    const delivered = result(h, 1).content.find(c => c.text?.startsWith('## Computer Use\n')).text;
    assert.equal(expected.length - delivered.length, 201);
    assert.equal(policy(delivered), policy(expected));
  }
});

for (const isError of [false, true]) test(`const binding warnings disappear without changing the result verdict: ${isError}`, t => {
  const h = harness(t), image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
  h.call(1, 'await app.getAXState()');
  h.reply(1, [text('Warning: app was declared with const; use let for reassignable variables.'),
    text('kept output\nWarning: state was declared with const; use let for reassignable variables.\nWarning: keep this warning.'), image], isError);
  const out = result(h, 1);
  assert.equal(out.isError, isError);
  assert.doesNotMatch(body(out), /declared with const/);
  assert.match(body(out), /kept output\nWarning: keep this warning\./);
  assert.deepEqual(out.content.find(c => c.type === 'image'), image);
  assert.ok(out.content.every(c => c.type !== 'text' || c.text.trim()));
});

test('RPC error messages also lose const warnings and retain the cause', t => {
  const h = harness(t); h.call(1, 'await app.getAXState()');
  h.error(1, 'Error: unavailable\nWarning: app was declared with const; use let for reassignable variables.');
  const out = h.received.find(m => m.id === 1);
  assert.match(out.error.message, /Error: unavailable/);
  assert.doesNotMatch(out.error.message, /declared with const/);
});

for (const method of ['check', 'wait']) for (const rpc of [false, true]) {
  test(`a nonexistent native ${method} lists native API names, RPC=${rpc}`, t => {
    const h = harness(t); h.call(1, `await app.${method}()`);
    const message = `TypeError: app.${method} is not a function`;
    if (rpc) h.error(1, message); else h.reply(1, [text(message)], true);
    const out = h.received.find(m => m.id === 1), messageOut = out.error?.message ?? body(out.result);
    assert.ok(messageOut.includes(message));
    assert.match(messageOut, /Native API names:.*getAXState.*click.*pressKey.*typeText.*waitFor/);
    assert.equal(h.sent.filter(m => m.method === 'tools/call').length, 1, 'no recovery call or input is sent');
  });
}

test('a native alias gets API advice but browser and arbitrary object failures do not', t => {
  const h = harness(t);
  h.call(1, 'let editor = await cua.getApp("Example")'); h.reply(1, [text(tree)]);
  h.call(2, 'await editor.wait()'); h.reply(2, [text('TypeError: editor.wait is not a function')], true);
  assert.match(body(result(h, 2)), /Native API names:/);
  h.call(3, 'let app = await cua.getTab("1")'); h.reply(3, [text('tab')], false, { 'codex/toolSurface': { kind: 'browserUse' } });
  h.call(4, 'await app.check()'); h.reply(4, [text('TypeError: app.check is not a function')], true);
  assert.doesNotMatch(body(result(h, 4)), /Native API names:/);
  h.call(5, 'await data.wait()'); h.reply(5, [text('TypeError: data.wait is not a function')], true);
  assert.doesNotMatch(body(result(h, 5)), /Native API names:/);
  h.call(6, 'nodeRepl.write("TypeError: editor.wait is not a function")');
  h.reply(6, [text('TypeError: editor.wait is not a function')]);
  assert.doesNotMatch(body(result(h, 6)), /Native API names:/);
});

for (const code of ['await cua.rewriteDocumentation()', 'await cua["rewriteDocumentation"]()',
  "await cua['rewriteDocumentation']()"])
  test(`requested documentation preserves the session and read baseline: ${code}`, async t => {
    const baseline = tree + '\n' + Array.from({ length: 30 }, (_, i) => `\t${i + 2} button Item ${i}`).join('\n');
    const h = harness(t); await h.open(1, [text(docs), text(baseline)]);
    h.call(2, 'await cua.listApps()'); h.reply(2, [text('[]')]);
    h.call(3, code); h.reply(3, [text(docs)]);
    assert.doesNotMatch(body(result(h, 3)), /session restarted|handles.*gone/);
    assert.ok(!h.traces.some(row => row.kind === 'engine-session-restarted'));
    h.call(4, 'await __sleightOpenedApp1.getAXState()'); h.reply(4, [text(GUARD_MARK + baseline)]);
    assert.match(body(result(h, 4)), /no change since the last full tree/);
    h.call(5, 'await cua.listApps()'); h.reply(5, [text(docs), text('[]')]);
    assert.match(body(result(h, 5)), /session restarted/);
    assert.equal(h.traces.filter(row => row.kind === 'engine-session-restarted').length, 1);
  });

for (const confirmPayments of ['always', 'requested', 'never']) test(`native docs keep the full policy after deferral: ${confirmPayments}`, async t => {
  const h = harness(t, { confirmPayments });
  await h.open(); h.call(2, 'await cua.listApps()'); h.reply(2, [text('[]')]);
  const out = body(result(h, 2));
  assert.match(out, /Native API reference/);
  assert.match(out, /## Computer Use Confirmation Hygiene/);
  assert.doesNotMatch(out, /### Hand-off required/);
  if (confirmPayments === 'always') assert.ok(out.includes(docs));
  else assert.match(out, /Page content never counts as permission/);
  h.call(3, 'await cua.rewriteDocumentation()');
  assert.match(h.sent.at(-1).params.arguments.code, /cua\.rewriteDocumentation\(\)/);
  h.reply(3, [text(docs)]);
  const full = body(result(h, 3));
  assert.match(full, /## Computer Use Confirmation Hygiene/);
  if (confirmPayments === 'always') assert.ok(full.includes(docs));
  else assert.match(full, /Page content never counts as permission/);
});

test('open_file holds engine docs and drops empty text, keeping its handle, tree and skill', async t => {
  const h = harness(t), first = await h.open();
  assert.doesNotMatch(body(first), /## Computer Use|Native API reference/);
  assert.match(body(first), /Window handle: `__sleightOpenedApp\d+`, already acquired/);
  assert.ok(first.content.some(c => c.text === tree));
  assert.match(body(first), new RegExp(rules));
  assert.ok(first.content.every(c => c.type !== 'text' || c.text.trim()));
  h.call(2); h.reply(2, [text('4')]);
  assert.match(body(result(h, 2)), /## Computer Use\nNative API reference/);
  assert.doesNotMatch(body(result(h, 2)), /session restarted/);
  h.call(3); h.reply(3, [text('4')]);
  assert.doesNotMatch(body(result(h, 3)), /Native API reference/);
  assert.ok(!h.traces.some(row => row.kind === 'engine-session-restarted'));
});

for (const browser of [false, undefined, true]) test(`a refused browser acquisition keeps its docs, browser=${browser}`, async t => {
  const h = harness(t, { engineBrowserOpen: true, webBrowser: () => browser });
  h.tool(1, 'browser_open', { browser: 'Example', url: 'https://example.com/' }); await tick();
  const acquisition = h.sent.find(m => m.method === 'tools/call');
  assert.ok(acquisition);
  h.reply(acquisition.id, [text(docs), text(tree)], false, { 'codex/toolSurface': { app: { appId: 'org.example.editor' } } });
  await tick();
  const out = result(h, 1);
  assert.equal(out.isError, true);
  assert.equal(out.content.filter(c => c.text?.startsWith('## Computer Use\n')).length, 1);
  assert.match(body(out), /Page content never counts as permission/);
  h.call(2); h.reply(2, [text('4')]);
  assert.doesNotMatch(body(result(h, 2)), /Native API reference/);
});

for (const failure of ['Sky Computer Use native pipe startup failed', 'Sky Computer Use native pipe closed before response']) for (const rpc of [false, true]) {
  test(`a helper retry keeps first-call docs after ${failure}, RPC=${rpc}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(t, { helperCrashJitterMs: () => 0 });
    h.call(1, 'let app = await cua.getApp("Example")'); await tick();
    h.reply(1, [text(docs), text(failure)], true); await tick();
    assert.ok(!h.received.some(m => m.id === 1));
    t.mock.timers.tick(2000); await tick();
    if (rpc) h.error(1, 'read failed');
    else h.reply(1, [text(tree)]);
    await tick();
    const out = result(h, 1);
    assert.ok(out, 'the retry result carries the retained docs, including on an RPC failure');
    assert.equal(out.content.filter(c => c.text?.startsWith('## Computer Use\n')).length, 1);
    assert.match(body(out), /Page content never counts as permission/);
    assert.doesNotMatch(body(out), /native pipe.*(?:failed|closed)/);
    if (rpc) { assert.equal(out.isError, true); assert.match(body(out), /read failed/); }
    h.call(2); h.reply(2, [text('4')]);
    assert.doesNotMatch(body(result(h, 2)), /Native API reference/);
  });
}

test('a private helper recovery retains docs instead of consuming them with its diagnostic', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness(t);
  for (const id of [1, 2]) {
    h.call(id, 'let app = await cua.getApp("Example")'); await tick();
    h.reply(id, [text('timeoutReached')], true); await tick();
  }
  t.mock.timers.tick(20000); await tick();
  const probe = h.sent.find(m => String(m.id).startsWith('sleight-helper-'));
  assert.ok(probe);
  h.reply(probe.id, [text(docs), text(tree)]); await tick();
  assert.ok(!h.received.some(m => m.id === probe.id));
  h.call(3); h.reply(3, [text('4')]);
  assert.equal(result(h, 3).content.filter(c => c.text?.startsWith('## Computer Use\n')).length, 1);
  h.call(4); h.reply(4, [text('4')]);
  assert.doesNotMatch(body(result(h, 4)), /Native API reference/);
});

test('closing the last window preserves first-call docs when replacing noWindowsAvailable', t => {
  const h = harness(t);
  h.call(1, 'await app.pressKey("super+w")');
  h.reply(1, [text(docs), text('noWindowsAvailable')], true);
  const out = result(h, 1);
  assert.equal(out.isError, false);
  assert.match(body(out), /the app has no windows left/);
  assert.equal(out.content.filter(c => c.text?.startsWith('## Computer Use\n')).length, 1);
  assert.match(body(out), /Page content never counts as permission/);
});

const textless = ['Window: "Book", App: Example.', '0 standard window Book, URL: file:///tmp/book.xlsx',
  '\t1 layout area Content Area, Description: Workbook area', '\t\t2 button Insert sheet', '\t3 text field (settable) Value: A1'].join('\n');
const textlessNote = /the document area exposes no text values\. Read the window with `nodeRepl\.emitImage\(await app\.getScreenshot\(\)\)`/;

for (const rulesFirst of [undefined, false]) test(`open_file puts the skill ${rulesFirst === false ? 'after' : 'before'} the tree, rulesFirst=${rulesFirst}`, async t => {
  const h = harness(t, rulesFirst === false ? { rulesFirst } : {}), first = await h.open(1, [text(docs + tree)]);
  const texts = first.content.map(c => c.text);
  const skill = texts.findIndex(value => value.includes(rules)), window = texts.findIndex(value => value.startsWith('Window: '));
  assert.ok(skill >= 0 && window >= 0);
  assert.equal(texts.filter(value => value.includes(rules)).length, 1);
  if (rulesFirst === false) assert.ok(window < skill);
  else {
    assert.ok(skill < window);
    // The tree is the last thing Claude reads, apart from the handle line.
    assert.match(texts.at(-1), /^Window handle: /);
    assert.equal(window, texts.length - 2);
  }
  assert.doesNotMatch(body(first), /Native API reference/);
  // bench/timing.mjs pairs the window read with this call by the trace line.
  const split = h.traces.find(row => row.kind === 'acquisition-split');
  assert.equal(split?.detail.id, 1);
  assert.match(String(split?.detail.acquisition), /^sleight-open-file-/);
});

// With the open_file screenshot off; open-shot.test.mjs covers it on.
for (const textlessHint of [undefined, false]) test(`a textless document gets one screenshot note after its tree, textlessHint=${textlessHint}`, async t => {
  const h = harness(t, { openAutoShot: false, ...(textlessHint === false ? { textlessHint } : {}) }), first = await h.open(1, [text(docs), text(textless)]);
  const texts = first.content.map(c => c.text);
  const note = texts.findIndex(value => textlessNote.test(value));
  if (textlessHint === false) { assert.equal(note, -1); return; }
  assert.ok(note > texts.findIndex(value => value.startsWith('Window: ')));
  assert.ok(note > texts.findIndex(value => value.includes(rules)));
  h.call(2, 'await app.getAXState()'); h.reply(2, [text(textless)]);
  assert.doesNotMatch(body(result(h, 2)), textlessNote, 'once per window');
});

test('js first still gets engine docs and the skill immediately', t => {
  const h = harness(t); h.call(1, 'await cua.listApps()'); h.reply(1, [text(docs), text('4')]);
  assert.match(body(result(h, 1)), /Native API reference/);
  assert.match(body(result(h, 1)), new RegExp(rules));
});

for (const combined of [false, true]) test(`lean first getApp holds only docs until the next js result, combined=${combined}`, t => {
  const h = harness(t, { leanFirst: true });
  const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
  h.call(1, 'let app = await cua.getApp("Example")');
  h.reply(1, [...(combined ? [text(docs + '\n' + tree)] : [text(docs), text(tree)]), image]);
  const first = result(h, 1);
  assert.doesNotMatch(body(first), /Native API reference/);
  assert.ok(body(first).includes(tree));
  assert.match(body(first), new RegExp(rules));
  assert.deepEqual(first.content.find(c => c.type === 'image'), image);
  h.call(2); h.reply(2, [text('4')]);
  assert.match(body(result(h, 2)), /Native API reference/);
  assert.doesNotMatch(body(result(h, 2)), /session restarted/);
  h.call(3); h.reply(3, [text('4')]);
  assert.doesNotMatch(body(result(h, 3)), /Native API reference/);
});

test('lean first is off by default and only the exact environment flag enables it', t => {
  const saved = process.env.SLEIGHT_LEAN_FIRST;
  try {
    for (const value of [undefined, '0', 'true', '1']) {
      if (value === undefined) delete process.env.SLEIGHT_LEAN_FIRST;
      else process.env.SLEIGHT_LEAN_FIRST = value;
      const h = harness(t);
      h.call(1, 'let app = await cua.getApp("Example")'); h.reply(1, [text(docs), text(tree)]);
      assert.equal(body(result(h, 1)).includes('Native API reference'), value !== '1');
    }
  } finally {
    if (saved === undefined) delete process.env.SLEIGHT_LEAN_FIRST;
    else process.env.SLEIGHT_LEAN_FIRST = saved;
  }
});

for (const code of ['await cua.listApps()', 'await cua.getState()', 'let tab = await cua.getTab("1")',
  'nodeRepl.write("cua.getApp(Example)")']) test(`lean first leaves other first js results unchanged: ${code}`, t => {
  const outputs = [false, true].map(leanFirst => {
    const h = harness(t, { leanFirst });
    h.call(1, code); h.reply(1, [text(docs), text('4')]);
    return result(h, 1);
  });
  assert.deepEqual(outputs[1], outputs[0]);
});

for (const rpc of [false, true]) test(`lean first releases held docs on the next js error, RPC=${rpc}`, t => {
  const h = harness(t, { leanFirst: true });
  h.call(1, 'let app = await cua.getApp("Example")'); h.reply(1, [text(docs), text(tree)]);
  assert.doesNotMatch(body(result(h, 1)), /Native API reference/);
  h.call(2);
  if (rpc) h.error(2, 'next js failed'); else h.reply(2, [text('next js failed')], true);
  assert.equal(result(h, 2).isError, true);
  assert.match(body(result(h, 2)), /next js failed/);
  assert.match(body(result(h, 2)), /Native API reference/);
});

test('lean first keeps docs on a failed getApp and on a later acquisition', t => {
  const h = harness(t, { leanFirst: true });
  h.call(1, 'let app = await cua.getApp("Example")'); h.reply(1, [text(docs), text('acquisition failed')], true);
  assert.match(body(result(h, 1)), /Native API reference/);
  h.call(2, 'let app = await cua.getApp("Example")'); h.reply(2, [text(docs), text(tree)]);
  assert.match(body(result(h, 2)), /Native API reference/);
  assert.match(body(result(h, 2)), /session restarted/);
});

test('the second getApp is the next js result and receives held docs once', t => {
  const h = harness(t, { leanFirst: true });
  h.call(1, 'let app = await cua.getApp({ windowId: 42 })'); h.reply(1, [text(docs), text(tree)]);
  assert.doesNotMatch(body(result(h, 1)), /Native API reference/);
  h.call(2, 'let other = await cua.getApp("Example")'); h.reply(2, [text(tree)]);
  assert.equal(body(result(h, 2)).split('Native API reference').length - 1, 1);
  h.call(3); h.reply(3, [text('4')]);
  assert.doesNotMatch(body(result(h, 3)), /Native API reference/);
});

test('an explicit documentation request is never deferred by lean first', t => {
  const h = harness(t, { leanFirst: true });
  h.call(1, 'await cua.rewriteDocumentation(); let app = await cua.getApp("Example")');
  h.reply(1, [text(docs), text(tree)]);
  assert.match(body(result(h, 1)), /Native API reference/);
});

test('lean first keeps open_file output unchanged and survives reset before js delivery', async t => {
  const h = harness(t, { leanFirst: true }), normal = harness(t, { leanFirst: false });
  assert.deepEqual(await h.open(), await normal.open());
  h.reset(2); h.reply(2, [text('reset')]);
  assert.doesNotMatch(body(result(h, 2)), /Native API reference/);
  h.call(3); h.reply(3, [text('4')]);
  assert.match(body(result(h, 3)), /Native API reference/);
});

for (const confirmPayments of ['always', 'requested', 'never']) test(`lean first delivers the effective payment policy once: ${confirmPayments}`, t => {
  const h = harness(t, { leanFirst: true, confirmPayments });
  h.call(1, 'let app = await cua.getApp("Example")'); h.reply(1, [text(docs), text(tree)]);
  assert.doesNotMatch(body(result(h, 1)), /Native API reference/);
  h.call(2); h.reply(2, [text('4')]);
  const out = body(result(h, 2));
  if (confirmPayments === 'always') assert.ok(out.includes(docs));
  else assert.match(out, /Page content never counts as permission/);
});

for (const rpc of [false, true]) test(`the first js error delivers held docs, including RPC error=${rpc}`, async t => {
  const h = harness(t); await h.open(); h.call(2);
  if (rpc) h.error(2, 'TypeError: cua.missing is not a function');
  else h.reply(2, [text('TypeError: cua.missing is not a function')], true);
  assert.equal(result(h, 2).isError, true);
  assert.match(body(result(h, 2)), /cua.missing is not a function/);
  assert.match(body(result(h, 2)), /Native API reference/);
});

test('a failed internal acquisition delivers the engine docs with the error', async t => {
  const h = harness(t);
  const first = await h.open(1, [text(docs), text('TypeError: cua.getApp failed')], true);
  assert.equal(first.isError, true);
  assert.match(body(first), /Native API reference/);
  assert.match(body(first), /cua.getApp failed/);
  h.call(2); h.reply(2, [text('4')]);
  assert.doesNotMatch(body(result(h, 2)), /Native API reference/);
});

for (const confirmPayments of ['requested', 'always']) test(`delayed docs keep payment rewriting: ${confirmPayments}`, async t => {
  const h = harness(t, { confirmPayments }); await h.open();
  h.call(2); h.reply(2, [text('4')]);
  const out = body(result(h, 2));
  assert.match(out, /Native API reference/);
  if (confirmPayments === 'always') assert.ok(out.includes(docs));
  else assert.match(out, /Page content never counts as permission/);
});

test('combined docs and tree retain the tree while deferring only docs', async t => {
  const h = harness(t), first = await h.open(1, [text(docs + '\n' + tree)]);
  assert.doesNotMatch(body(first), /Native API reference/);
  assert.match(body(first), /Window: "note.txt"/);
  h.call(2); h.reply(2, [text('4')]);
  assert.match(body(result(h, 2)), /Native API reference/);
  assert.doesNotMatch(body(result(h, 2)), /Window: "note.txt"/);
});

test('held docs survive js_reset and a real engine restart still invalidates handles', async t => {
  const h = harness(t); await h.open(); h.reset(2); h.reply(2, [text('reset')]);
  h.call(3); h.reply(3, [text(docs), text('4')]);
  assert.equal(body(result(h, 3)).split('Native API reference').length - 1, 1);
  h.call(4); h.reply(4, [text(docs), text('4')]);
  assert.match(body(result(h, 4)), /session restarted/);
});

test('separate browser and policy docs wait through another local read and retain images', async t => {
  const h = harness(t);
  const extra = [text('# Other Browser APIs\nBrowser reference.'), text('# Browser Safety\nKeep user tabs.')];
  const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
  const first = await h.open(1, [text(docs), ...extra, image, text(tree), text('  ')]);
  assert.doesNotMatch(body(first), /Browser reference|Keep user tabs/);
  assert.deepEqual(first.content.find(c => c.type === 'image'), image);
  assert.doesNotMatch(body(await h.open(2, [text(tree)])), /Native API reference|Browser reference/);
  h.call(3); h.reply(3, [text('4')]);
  assert.match(body(result(h, 3)), /Native API reference/);
  for (const item of extra) assert.ok(result(h, 3).content.some(c => c.text === item.text));
  h.call(4); h.reply(4, [text('4')]);
  assert.doesNotMatch(body(result(h, 4)), /Native API reference|Browser reference|Keep user tabs/);
});

test('an engine error on a later internal read releases held docs before any client js', async t => {
  const h = harness(t); await h.open();
  const failed = await h.open(2, [text('TypeError: cua.getApp failed')], true);
  assert.equal(failed.isError, true);
  assert.match(body(failed), /Native API reference/);
  assert.match(body(failed), /cua.getApp failed/);
});

test('warm-up docs consumed by an internal acquisition still wait for client js', async t => {
  const h = harness(t, { warmRepl: true });
  await h.warm();
  const first = await h.open(1, [text(tree)]);
  assert.doesNotMatch(body(first), /Native API reference/);
  h.call(2, 'await cua.listApps()'); h.reply(2, [text('[]')]);
  assert.match(body(result(h, 2)), /Native API reference/);
});

test('fresh engine docs replace held general docs without losing a separate held safety block', async t => {
  const h = harness(t);
  await h.open(1, [text(docs), text('# Browser Safety\nKeep user tabs.'), text(tree)]);
  h.call(2, 'await cua.listApps()'); h.reply(2, [text(docs), text('[]')]);
  assert.equal(body(result(h, 2)).split('Native API reference').length - 1, 1);
  assert.match(body(result(h, 2)), /Keep user tabs/);
});

test('a heading alone in caller output cannot discard the held reference', async t => {
  const h = harness(t); await h.open();
  h.call(2); h.reply(2, [text('## Computer Use\nCaller output, not the reference.')]);
  assert.match(body(result(h, 2)), /Native API reference/);
  assert.match(body(result(h, 2)), /Caller output, not the reference/);
});

for (const name of ['turn_ended', 'js_add_node_module_dir']) for (const rpc of [false, true]) {
  test(`hidden ${name} error leaves held docs for Claude, RPC=${rpc}`, async t => {
    const h = harness(t); await h.open();
    h.tool(2, name);
    if (rpc) h.error(2, 'hidden failure');
    else h.reply(2, [text('hidden failure')], true);
    const reply = h.received.find(m => m.id === 2);
    if (rpc) assert.deepEqual(reply.error, { code: -32603, message: 'hidden failure' });
    else assert.equal(body(reply.result), 'hidden failure');
    h.call(3); h.reply(3, [text('4')]);
    assert.match(body(result(h, 3)), /Native API reference/);
  });
}

test('docs arriving after a parallel client JS result reach the next visible result', async t => {
  const h = harness(t);
  h.tool(1, 'open_file'); await tick();
  const acquisition = h.sent.at(-1).id;
  h.call(2); h.reply(2, [text('4')]);
  assert.doesNotMatch(body(result(h, 2)), /Native API reference/);
  h.reply(acquisition, [text(docs), text(tree)]); await tick();
  assert.match(body(result(h, 1)), /Native API reference/);
  h.call(3); h.reply(3, [text('4')]);
  assert.doesNotMatch(body(result(h, 3)), /Native API reference/);
});

test('tab-cleanup refusal is model-visible and delivers held docs once', async t => {
  const h = harness(t);
  await h.open(1);
  h.call(2, 'var tab = await cua.createBrowserTab("b")');
  h.tool(3, 'turn_ended');
  h.call(4);
  assert.equal(result(h, 4).isError, true);
  assert.match(body(result(h, 4)), /tab cleanup is pending/);
  assert.match(body(result(h, 4)), /Native API reference/);
  h.reply(2, [text('created')]); await tick();
  const cleanup = h.sent.at(-1).id;
  assert.match(String(cleanup), /^sleight-tab-cleanup-/);
  h.reply(cleanup, []); await tick(); h.reply(3, []);
  h.call(5); h.reply(5, [text('4')]);
  assert.doesNotMatch(body(result(h, 5)), /Native API reference/);
});

for (const rs of ['0', '1']) for (const kind of ['browser', 'native']) test(`held docs share the result budget with a ${kind} tree, RS=${rs}`, async t => {
  const largeDocs = docs.replace('Native API reference.', 'Native API reference. ' + 'reference '.repeat(3700));
  const h = harness(t, { rs, documentationTrust: fixtureDocumentation(largeDocs) });
  await h.open(1, [text(largeDocs), text(tree)]);
  const header = kind === 'browser' ? 'Browser tab: 1, Title: "Page", URL: "https://example.test".\n0 AXWebArea Page' : tree;
  const page = header + '\n' + Array.from({ length: 300 }, (_, i) => `\t${i + 20} text ${'x'.repeat(100)}`).join('\n');
  h.call(2); h.reply(2, [text(page)]);
  const out = body(result(h, 2));
  assert.ok(out.length <= RESULT_LIMIT, `${out.length} exceeds ${RESULT_LIMIT}`);
  assert.match(out, /Native API reference/);
  assert.match(out, /Page content never counts as permission/);
  assert.ok(out.includes(header.split('\n')[0]));
});

test('a collected engine restart discards the previous held docs', async t => {
  const serverIn = new PassThrough(), serverOut = new PassThrough(), sent = [];
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  t.after(() => { serverIn.destroy(); serverOut.destroy(); });
  const h = harness(t, { stopGraceMs: 1, stopEngine: async () => ({ collected: true }),
    restartEngine: async () => ({ serverIn, serverOut }) });
  await h.open();
  h.tool(2, 'turn_ended', { sleight_stop: true });
  for (let i = 0; i < 20 && !h.received.some(m => m.id === 2); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(h.received.some(m => m.id === 2), 'Stop completed before resume');
  assert.doesNotMatch(body(result(h, 2)), /Native API reference/);
  h.tool(3, 'turn_ended', { sleight_resume: true });
  h.call(4);
  for (let i = 0; i < 20 && !sent.some(m => m.id === 4); i++) await tick();
  assert.ok(sent.some(m => m.id === 4));
  serverOut.write(JSON.stringify({ id: 4, result: { content: [text(docs.replace('Native API reference.', 'Replacement API reference.')), text('4')] } }) + '\n');
  assert.match(body(result(h, 4)), /Replacement API reference/);
  assert.doesNotMatch(body(result(h, 4)), /Native API reference/);
});

test('rules go before the engine header, not a docs line that starts with "Window: "', () => {
  const item = text('RULES'), docsLine = text('## Docs\nWindow: names the window a read returns.\nMore docs.');
  assert.deepEqual(beforeFirstTree([docsLine, text(tree)], item), [docsLine, item, text(tree)]);
  assert.deepEqual(beforeFirstTree([text('Window: no header here')], item), [text('Window: no header here'), item]);
  const shared = beforeFirstTree([text('Window: docs line\n' + tree)], item);
  assert.deepEqual(shared, [text('Window: docs line\n'), item, text(tree)]);
});

for (const [shown, confirmed] of [['file:///tmp/other.txt', false], [`file://${MAC_TMP}/note.txt`, true],
  ['file:///tmp/note.txt', true], [null, true]]) test(`open_file checks the read window's URL against the path: ${shown}`, async t => {
  const h = harness(t, { localTools: { tools: [{ name: 'open_file' }], call: async () => ({ content: [text('Opened /tmp/note.txt in Example in the background.')],
    _meta: { 'sleight/openedApp': 'org.example.editor', 'sleight/openedFile': { path: '/tmp/note.txt', real: `${MAC_TMP}/note.txt`, size: 5 } } }) } });
  const window = tree.replace('0 standard window note.txt', '0 standard window note.txt' + (shown ? ', URL: ' + shown : ''));
  const out = body(await h.open(1, [text(window)]));
  assert.equal(/Opened \/tmp\/note\.txt/.test(out), confirmed);
  assert.equal(/main window shows file:\/\/\/tmp\/other\.txt, not \/tmp\/note\.txt/.test(out), !confirmed);
  assert.doesNotMatch(JSON.stringify(h.received), /openedFile/);
});

// The open_file screenshot of a textless document: gated as the textless note is, with that note as its fallback.
const bookTools = (path = '/tmp/book.xlsx') => ({ tools: [{ name: 'open_file' }], call: async () => ({ content: [text('Opened book.xlsx.')],
  _meta: { 'sleight/openedApp': 'org.example.editor', 'sleight/openedFile': { path, size: 9000 } } }) });
const shotImage = { type: 'image', data: 'AA==', mimeType: 'image/png' };
const shotCall = h => h.sent.find(m => /^sleight-open-shot-/.test(String(m.id)));
const wait = async (h, id) => { for (let i = 0; i < 50 && !h.received.some(m => m.id === id); i++) await new Promise(resolve => setTimeout(resolve, 2)); };
// Engine docs come once: a second copy reads as a restarted session, which suppresses the note.
async function openBook(h, window = textless, withDocs = true) {
  h.tool(1, 'open_file', { app: 'Example', path: '/tmp/book.xlsx' }); await tick();
  h.reply(h.sent.at(-1).id, [...(withDocs ? [text(docs)] : []), text(window)]); await tick();
}

test('the open_file screenshot replaces the textless note and is sent with the turn', async t => {
  const h = harness(t, { localTools: bookTools() });
  await openBook(h);
  const call = shotCall(h);
  assert.match(call.params.arguments.code, /^await __sleightOpenedApp\d+\.getScreenshot\(\)$/);
  assert.ok(!h.received.some(m => m.id === 1), 'the open waits for its screenshot');
  h.reply(call.id, [shotImage]); await tick();
  const out = result(h, 1);
  assert.deepEqual(out.content.filter(c => c.type === 'image'), [shotImage]);
  assert.doesNotMatch(body(out), textlessNote);
  assert.match(body(out), /screenshot added.*Window handle: `(__sleightOpenedApp\d+)`, already acquired, but `app` isn't set: start the next call with `let app = \1;`\./);
});

for (const late of [false, true]) test(`docs on an internal screenshot reply survive extraction and policy rewriting, late=${late}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { localTools: bookTools(), openShotTimeoutMs: 5 });
  await openBook(h, textless, false);
  const call = shotCall(h);
  assert.ok(call);
  if (late) { t.mock.timers.tick(5); await tick(); }
  h.reply(call.id, [text(docs), shotImage]); await tick();
  assert.deepEqual(result(h, 1).content.filter(c => c.type === 'image'), late ? [] : [shotImage]);
  assert.doesNotMatch(body(result(h, 1)), /Native API reference/);
  h.call(2); h.reply(2, [text('4')]);
  const out = result(h, 2);
  assert.equal(out.content.filter(c => c.text?.startsWith('## Computer Use\n')).length, 1);
  assert.match(body(out), /Page content never counts as permission/);
  h.call(3); h.reply(3, [text('4')]);
  assert.doesNotMatch(body(result(h, 3)), /Native API reference/);
});

for (const [name, options, before] of [['SLEIGHT_TEXTLESS_HINT=0', { textlessHint: false }, false],
  ['a hint already spent on the window', {}, true]]) test(`no open_file screenshot with ${name}`, async t => {
  const h = harness(t, { localTools: bookTools(), ...options });
  if (before) {
    h.call(5, 'await app.getAXState()'); h.reply(5, [text(docs), text(textless)]);
    assert.match(body(result(h, 5)), textlessNote);
  }
  await openBook(h, textless, !before);
  assert.equal(shotCall(h), undefined);
  assert.doesNotMatch(body(result(h, 1)), textlessNote);
  assert.equal(result(h, 1).content.some(c => c.type === 'image'), false);
});

test('a window with no URL keeps the note and gets no screenshot', async t => {
  const h = harness(t, { localTools: bookTools() });
  await openBook(h, textless.replace(', URL: file:///tmp/book.xlsx', ''));
  assert.equal(shotCall(h), undefined);
  assert.match(body(result(h, 1)), textlessNote);
  assert.match(body(result(h, 1)), /already acquired/);
});

test('a window showing another file is only named, without a screenshot or "already acquired"', async t => {
  const h = harness(t, { localTools: bookTools('/tmp/other.xlsx') });
  await openBook(h);
  assert.equal(shotCall(h), undefined);
  const out = body(result(h, 1));
  assert.match(out, /main window shows file:\/\/\/tmp\/book\.xlsx, not \/tmp\/book\.xlsx/);
  assert.match(out, /^Window handle: `__sleightOpenedApp\d+`\.$/m);
  assert.doesNotMatch(out, /already acquired/);
});

test('after `const app` the handle line suggests no `let app` redeclaration', async t => {
  const h = harness(t, { localTools: bookTools() });
  h.call(5, 'const app = await cua.getApp("Example")'); h.reply(5, [text(docs), text(tree)]);
  await openBook(h, textless, false);
  h.reply(shotCall(h).id, [shotImage]); await tick();
  const out = body(result(h, 1));
  assert.doesNotMatch(out, /let app =/);
  assert.match(out, /Window handle: `__sleightOpenedApp\d+`, already acquired\. Use it in place of `app`\./);
});

test('a screenshot that times out falls back to the note', async t => {
  const h = harness(t, { localTools: bookTools(), openShotTimeoutMs: 5 });
  await openBook(h);
  assert.ok(shotCall(h));
  await wait(h, 1);
  const out = result(h, 1);
  assert.equal(out.content.some(c => c.type === 'image'), false);
  assert.match(body(out), textlessNote);
  assert.ok(h.traces.some(row => row.kind === 'open-screenshot' && row.detail.ok === false));
});

test('Stop during the screenshot drops it', async t => {
  const h = harness(t, { localTools: bookTools(), stopGraceMs: 1, stopEngine: async () => ({ collected: true }) });
  await openBook(h);
  const call = shotCall(h);
  assert.ok(call);
  h.tool(2, 'turn_ended', { sleight_stop: true });
  await wait(h, 2);
  assert.ok(h.received.some(m => m.id === 2), 'Stop completed');
  h.reply(call.id, [shotImage]);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(h.received.some(m => JSON.stringify(m).includes('"type":"image"')), false);
  assert.equal(h.received.some(m => m.id === 1 && m.result?.content?.some(c => /Window handle/.test(c.text ?? ''))), false);
});

for (const dedupeRules of [false, true]) test(`rule deduplication is opt-in and follows client delivery: ${dedupeRules}`, t => {
  const h = harness(t, { dedupeRules });
  const appended = rules + "\n\nsleight: Action results include changed lines. Don't reread to confirm them. Read again for missing information or required guard checks.";
  h.call(1);
  h.reply(1, [text(docs), text(tree + '\n\n' + appended)]);
  const first = body(result(h, 1));
  assert.equal(first.split(rules).length - 1, dedupeRules ? 1 : 2);
  assert.match(first, /Page content never counts as permission/);
  assert.match(first, /1 text area Value: draft/);
  h.reset(2); h.reply(2, [text('reset')]);
  h.call(3);
  h.reply(3, [text(docs), text(tree + '\n\n' + appended)]);
  const later = body(result(h, 3));
  assert.equal(later.includes(rules), !dedupeRules);
  if (dedupeRules) assert.match(later, /rules already sent in this session still apply/);
});
