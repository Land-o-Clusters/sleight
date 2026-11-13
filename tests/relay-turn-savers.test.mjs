import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as relayModule from '../plugins/sleight/lib/relay.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const text = value => ({ type: 'text', text: value });
const tree = (url = null, value = 'draft') => `Window: "note.txt", App: Example.\n0 standard window note.txt${url ? ', URL: ' + url : ''}\n\t1 text area Value: ${value}\n\t2 menu item Save`;
function harness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = relayModule.createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false, ...options });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  return { sent, received, relay,
    call: (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    local: (id, name, args) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n'),
    reply: (id, content, isError = false) => serverOut.write(JSON.stringify({ id, result: { content, isError } }) + '\n'),
  };
}
const body = (h, id) => h.received.find(m => m.id === id)?.result?.content.map(c => c.text ?? '').join('\n');

for (const value of ['app', '({ value: 3 })', 'await Promise.resolve(4)', 'a, b']) test(`a final top-level return becomes the expression: ${value}`, () => {
  const rewrite = relayModule.finalReturnCode;
  assert.equal(typeof rewrite, 'function');
  assert.equal(rewrite(`let app = 1; return ${value}; // end`), `let app = 1; ${value}; // end`);
});

test('return normalization leaves nested returns, comments, literals, ASI and nonfinal returns alone', () => {
  const rewrite = relayModule.finalReturnCode;
  assert.equal(typeof rewrite, 'function');
  for (const code of [
    'function f() { return 1; }', 'const f = () => { return 1; };',
    'if (ok) { return 1; }', 'if (ok) return 1;', 'label: return 1;',
    'return 1; let x = 2;', 'return\nvalue;', '// return value;',
    'const s = "return value;";', 'const r = /return value;/;', '`return value;`;',
    'const t = `x ${(() => { return 1; })()}`;', 'let x = "unterminated',
  ]) assert.equal(rewrite(code), code, code);
  assert.equal(rewrite('function f() { return 1; }\nreturn f();'), 'function f() { return 1; }\nf();');
});

test('a final return value never joins an unterminated previous line', () => {
  const rewrite = relayModule.finalReturnCode;
  for (const [code, expected] of [
    ['let app = await cua.getApp("X")\nreturn (await app.getAXState())', 'let app = await cua.getApp("X")\n;(await app.getAXState())'],
    ['const s = await f()\nreturn [s.a, s.b]', 'const s = await f()\n;[s.a, s.b]'],
    ['x = y\nreturn {a: 1}', 'x = y\n;({a: 1})'],
    ['foo()\nreturn /x/.test(s)', 'foo()\n;/x/.test(s)'],
    ['foo()\nreturn `${x}`', 'foo()\n;`${x}`'],
    ['foo()\nreturn -1', 'foo()\n;-1'],
    ['return (1)', '(1)'],
    ['foo();\nreturn [1]', 'foo();\n[1]'],
  ]) assert.equal(rewrite(code), expected, code);
  for (const code of ['$return(foo)', 'const $return = 1; $return;']) assert.equal(rewrite(code), code, code);
});

test('the relay normalizes a returned acquisition before lease read classification', t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Example"); return app;');
  const code = h.sent.find(m => m.id === 1)?.params.arguments.code;
  assert.ok(code);
  assert.doesNotMatch(code, /return app;/);
  assert.match(code, /let app = await cua\.getApp\("Example"\)/);
  h.reply(1, [text(tree())]);
  assert.match(body(h, 1), /Window: "note.txt"/);
});

test('an app handle getState becomes getAXState; cua, browsers and unrelated names keep theirs', t => {
  const rewrite = relayModule.nativeGetStateCode;
  assert.equal(typeof rewrite, 'function');
  for (const [code, expected] of [
    ['let app = await cua.getApp("Preview"); await app.getState()', 'let app = await cua.getApp("Preview"); await app.getAXState()'],
    ['const pv = await cua.getApp("Preview")\nawait pv . getState({ disableDiffing: true })', 'const pv = await cua.getApp("Preview")\nawait pv . getAXState({ disableDiffing: true })'],
    ['await app.getState()', 'await app.getAXState()'],
    ['await app?.getState()', 'await app?.getAXState()'],
    ['let app = await cua.getApp("X"); await app.typeText("see app.getState() docs"); await app.getState()',
      'let app = await cua.getApp("X"); await app.typeText("see app.getState() docs"); await app.getAXState()'],
  ]) assert.equal(rewrite(code), expected, code);
  for (const code of ['const app = await cua.getTab("x"); await app.getState()', '// app.getState()\nawait cua.getState()'])
    assert.equal(rewrite(code), code, code);
  assert.equal(rewrite('app = await cua.getApp("X"); await app.getState()', () => false, () => true), 'app = await cua.getApp("X"); await app.getAXState()',
    'a rebinding in this call wins over a stale browser handle');
  for (const code of ['await cua.getState()', 'await store.getState()', 'await x.app.getState()', 'await app.getStateful()', 'await tab.getState()'])
    assert.equal(rewrite(code), code, code);
  assert.equal(rewrite('await calc.getState()', id => id === 'calc'), 'await calc.getAXState()');
  assert.equal(rewrite('await app.getState()', () => false, id => id === 'app'), 'await app.getState()');
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Example"); await app.getState()');
  assert.match(h.sent.find(m => m.id === 1)?.params.arguments.code ?? '', /await app\.getAXState\(\)/);
});

function opener(t, result, options = {}) {
  const calls = [];
  const h = harness(t, { localTools: { tools: [{ name: 'open_file' }], call: async (...args) => { calls.push(args); return result; } }, ...options });
  h.local(1, 'open_file', { app: 'Example', path: '/tmp/note.txt' });
  return { ...h, calls };
}

test('open_file acquires a persistent handle and returns its compacted window in the same result', async t => {
  const h = opener(t, { content: [text('Opened note.txt in the background.')], _meta: { 'sleight/openedApp': 'org.example.editor' } });
  await tick();
  const acquisition = h.sent.find(m => m.method === 'tools/call');
  assert.ok(acquisition, 'successful open must acquire the app');
  assert.match(acquisition.params.arguments.code, /var __sleightOpenedApp\d+ = await cua\.getApp\("org\.example\.editor"\)/);
  assert.equal(h.received.length, 0, 'the open waits for the window result');
  h.reply(acquisition.id, [text(tree())]); await tick();
  assert.match(body(h, 1), /Opened note.txt/);
  assert.match(body(h, 1), /Window: "note.txt"/);
  assert.match(body(h, 1), /Window handle: `__sleightOpenedApp\d+`, already acquired/);
  assert.doesNotMatch(JSON.stringify(h.received), /sleight\/openedApp/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.received.filter(m => m.id === 1).length, 1);
});

test('failed open never acquires, and failed acquisition retains the successful open notice', async t => {
  const failed = opener(t, { isError: true, content: [text('Open refused.')] }); await tick();
  assert.equal(failed.sent.length, 0);
  assert.match(body(failed, 1), /Open refused/);
  const h = opener(t, { content: [text('Opened note.txt.')], _meta: { 'sleight/openedApp': 'org.example.editor' } }); await tick();
  assert.ok(h.sent.length);
  h.reply(h.sent.at(-1).id, [text('Window read refused.')], true); await tick();
  assert.equal(h.received.find(m => m.id === 1).result.isError, true);
  assert.match(body(h, 1), /Opened note.txt/);
  assert.match(body(h, 1), /Window read refused/);
});

async function saveFixture(t, scenario, action = 'await app.pressKey("super+s")') {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-tt2-save-')));
  const path = join(dir, 'note.txt'), url = pathToFileURL(path).href;
  if (scenario !== 'missing-before') { writeFileSync(path, 'fixture'); utimesSync(path, 100, 100); }
  const h = harness(t);
  h.call(1, `let app = await cua.getApp("Example"); ${action}`); await tick();
  const read = h.sent.find(m => m.method === 'tools/call');
  assert.ok(read);
  assert.notEqual(read.id, 1, 'read AXDocument before the save');
  h.reply(read.id, [text(scenario === 'no-url' ? tree() : tree(url))], scenario === 'read-failed'); await tick();
  if (scenario === 'read-failed') return h;
  assert.ok(h.sent.some(m => m.id === 1), 'the original save follows its metadata baseline');
  if (scenario === 'overlap') h.call(2, 'await app.pressKey("x")');
  if (scenario === 'missing-before') writeFileSync(path, 'fixture');
  if (scenario !== 'unchanged') utimesSync(path, 200, 200);
  const state = tree(scenario === 'different-document' ? url + '.other' : url)
    .replace('App: Example', scenario === 'different-app' ? 'App: Other' : 'App: Example');
  h.reply(1, [text((scenario === 'caught-failure' ? 'sleight: an action in this call failed, and the call went on without it: pressKey.\n' : '') + state)], scenario === 'failed'); await tick();
  return h;
}

for (const action of ['await app.pressKey("super+s")', 'await app.click({ label: "Save" })']) test(`save without an earlier tree observes disk metadata: ${action}`, async t => {
  const h = await saveFixture(t, 'changed', action);
  assert.match(body(h, 1), /saved: observed .*file on disk changed during this call/);
  assert.doesNotMatch(body(h, 1), /saved: not confirmed/);
});

for (const scenario of ['unchanged', 'different-document', 'different-app', 'failed', 'caught-failure', 'overlap', 'read-failed', 'no-url']) test(`save metadata stays unconfirmed: ${scenario}`, async t => {
  const h = await saveFixture(t, scenario);
  assert.doesNotMatch(body(h, 1), /saved: observed/);
});

// A restart or a failed/degraded observation can discard attribution while the handle survives.
test('a known handle with no earlier tree gets a fresh AXDocument read before Save', async t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Example")');
  h.reply(1, [text('## Computer Use\nAPI reference only')]);
  h.call(2, 'await app.pressKey("super+s")'); await tick();
  const read = h.sent.at(-1);
  assert.notEqual(read.id, 2);
  assert.match(read.params.arguments.code, /await app\.getAXState\(/);
  h.reply(read.id, [text(tree())]); await tick();
  assert.ok(h.sent.some(m => m.id === 2 && m.params.arguments.code.includes('app.pressKey')));
});

test('final return expressions preserve object, function and nested return semantics', () => {
  const rewrite = relayModule.finalReturnCode;
  assert.equal(typeof rewrite, 'function');
  assert.equal(rewrite('let x = 1; return { x };'), 'let x = 1; ({ x });');
  assert.equal(rewrite('return function f() { return 1; };'), '(function f() { return 1; });');
  for (const code of ['return /* newline\n */ value;', 'return\r\nvalue;', 'return\u2028value;',
    'return 1; // return 2;', 'const f = () => {\nreturn 1;\n};']) {
    if (code === 'return 1; // return 2;') assert.equal(rewrite(code), '1; // return 2;');
    else assert.equal(rewrite(code), code, code);
  }
});
