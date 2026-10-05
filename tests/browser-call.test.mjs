import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { guardedCode, readCode } from '../plugins/sleight/lib/document-scope.mjs';
import { browserCall } from '../plugins/sleight/lib/browser-call.mjs';

test('literal browser calls are classified as browser', () => {
  assert.ok(browserCall('await cua.listBrowsers()'));
  assert.ok(browserCall('let tab = await cua.createBrowserTab("abc", "https://example.com")'));
  assert.ok(browserCall('await tab.getByRole("link", { name: "More" }).click()', new Set(['tab'])));
  assert.ok(browserCall('const rows = [1, 2]; await tab.goto("https://example.com")', new Set(['tab'])));
  assert.ok(browserCall('const tabs = await cua.listTabs(); nodeRepl.write(tabs[0])'));
});

const bypasses = [
    'await cua.getApp("TextEdit"); await tab.reload()',
    'await cua["getApp"]("TextEdit"); await tab.reload()',
    'const { getApp } = cua; await getApp("TextEdit"); await tab.reload()',
    'const c = cua; await c.getApp("TextEdit"); await tab.reload()',
    'await globalThis.cua.getApp("TextEdit"); await tab.reload()',
    'await eval("cua.getApp(\\"TextEdit\\")"); await tab.reload()',
    'await Function("return cua")().getApp("TextEdit"); await tab.reload()',
    'await app.click(3); await tab.reload()',
    'const t = `${await cua.getApp("TextEdit")}`; await tab.reload()',
    'await tab.constructor.constructor("return cua")().getApp("TextEdit"); await tab.reload()',
    'await tab.__proto__.reload.call(tab)',
    'const k = "con" + "structor"; await tab[k][k]("return cua")().getApp("TextEdit")',
    'await tab["con" + "structor"]; await tab.reload()',
    'const k = "con" + "structor"; await tab/**/[k]; await tab.reload()',
    'const k = "con" + "structor"; await tab?.[k]; await tab.reload()',
    'const k = "x"; await tab /* a */ [k]; await tab.reload()',
    'const k = "con" + "structor"; const { [k]: c } = tab; await tab.reload()',
    'const { a, [k]: c } = tab; await tab.reload()',
    'await Object.getPrototypeOf(tab).reload.call(tab)',
];

test('native access in any form keeps the call on the native path', () => {
  for (const code of bypasses) assert.equal(browserCall(code, new Set(['tab'])), undefined, code);
});

function runtime(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-browser-runtime-'));
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  for (const [stream, rows] of [[serverIn, sent], [clientOut, received]]) {
    stream.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => rows.push(JSON.parse(line))));
  }
  const lease = new InputLease({ directory });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: lease, changeReview: false, ...options });
  t.after(() => { relay.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, result) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const context = createContext({});
  runInContext(`
    var writes = [], nativeReads = 0, outputs = [];
    var raw = { getAXState: async () => { nativeReads++; return 'Window: "b.txt", App: TextEdit'; },
      typeText: async value => writes.push(value), click: async value => writes.push(value) };
    var tab = Object.assign(Object.create({ reload: async () => {} }), { reload: async () => {}, getAXState: async () => 'Browser tab: 1' });
    var cua = { getApp: async () => raw, listTabs: async () => [], getTab: async () => tab };
    var nodeRepl = { write: value => outputs.push(value) };
    var app;
  `, context);
  const run = code => runInContext(`(async () => { ${code} })()`, context, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { sent, received, lease, call, reply, context, run, directory };
}

const missed = [
  'await nativeAction(); await tab.reload()',
  'tab = app; await tab.typeText("blocked")',
  'const tabs = [app]; await tabs[0].typeText("blocked"); await cua.listTabs()',
  'await cua.listTabs(); await JSON.nativeAction()',
  'await cua.listTabs(); await ({ go: nativeAction }).go()',
  'await cua.listTabs(); await clipboard.typeText("blocked")',
];

for (const [index, code] of [...bypasses, ...missed].entries()) {
  test(`native runtime guard stops bypass ${index + 1}: ${code}`, async t => {
    const h = runtime(t);
    // Previous native authorization must not survive a later read of another window.
    await h.run(guardedCode('app = await cua.getApp("TextEdit")', { title: 'b.txt', app: 'TextEdit', url: null }));
    h.call(1, 'app = await cua.getApp("TextEdit")');
    await h.run(h.sent.at(-1).params.arguments.code);
    h.reply(1, { content: [{ type: 'text', text: 'Window: "a.txt", App: TextEdit' }],
      _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId: 'com.apple.TextEdit' } } } });
    h.call(2, 'let tab = await cua.getTab("1")');
    h.reply(2, { content: [{ type: 'text', text: 'Browser tab: 1' }], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
    runInContext('var k = "constructor"; var nativeAction = () => app.typeText("blocked"); JSON.nativeAction = nativeAction; var clipboard = app;', h.context);
    h.call(3, code + '; await app.typeText("blocked")');
    const forwarded = h.sent.find(msg => msg.id === 3);
    assert.ok(forwarded, JSON.stringify(h.received));
    await assert.rejects(h.run(forwarded.params.arguments.code), /window or URL changed/);
    assert.deepEqual(Array.from(h.context.writes), [], 'native input never happens');
  });
}

for (const code of missed) {
  test(`misclassified call stays guarded: ${code}`, async t => {
    const h = runtime(t);
    await h.run(guardedCode('app = await cua.getApp("TextEdit")', { title: 'b.txt', app: 'TextEdit', url: null }));
    h.call(1, 'let tab = await cua.getTab("1")');
    h.reply(1, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
    assert.ok(browserCall(code, new Set(['tab'])), 'regression actually passes the first filter');
    // A prior read's native handle is deliberately reachable in the persistent realm.
    await h.run(readCode('app = await cua.getApp("TextEdit");'));
    runInContext('var nativeAction = () => app.typeText("blocked"); JSON.nativeAction = nativeAction; var clipboard = app;', h.context);
    h.call(2, code);
    const forwarded = h.sent.find(msg => msg.id === 2);
    assert.ok(forwarded, JSON.stringify(h.received));
    await assert.rejects(h.run(forwarded.params.arguments.code), /native access.*standalone.*read/i);
    assert.deepEqual(Array.from(h.context.writes), []);
  });
}

test('browser candidates never emit an earlier native app observation', async t => {
  const h = runtime(t);
  await h.run(guardedCode('app = await cua.getApp("TextEdit")', { title: 'b.txt', app: 'TextEdit', url: null }));
  const before = h.context.nativeReads;
  h.call(1, 'let tab = await cua.getTab("1")');
  await h.run(h.sent.at(-1).params.arguments.code);
  assert.equal(h.context.nativeReads, before);
});

for (const result of [
  { content: [] },
  { content: [], _meta: { 'codex/toolSurface': { kind: 'computerUse' } } },
  { content: [], _meta: { 'codex/toolSurface': { kind: 'browser' } } },
  { content: [], isError: true, _meta: { 'codex/toolSurface': { kind: 'browserUse' } } },
]) {
  test(`unconfirmed engine reply never teaches browser handles: ${JSON.stringify(result)}`, t => {
    const h = runtime(t);
    h.call(1, 'let tab = await cua.getTab("1")'); h.reply(1, result);
    h.call(2, 'await tab.reload()');
    assert.equal(h.sent.some(msg => msg.id === 2), false);
    assert.equal(h.received.at(-1).result.isError, true);
  });
}

test('a pending browser candidate cannot lose its native denial to a concurrent read', async t => {
  const h = runtime(t);
  await h.run(guardedCode('app = await cua.getApp("TextEdit")', { title: 'b.txt', app: 'TextEdit', url: null }));
  h.call(1, 'let tab = await cua.getTab("1")');
  h.call(2, 'app = await cua.getApp("TextEdit")');
  assert.equal(h.sent.some(msg => msg.id === 2), false);
  assert.match(h.received.at(-1).result.content[0].text, /pending/);
  await h.run(h.sent.find(msg => msg.id === 1).params.arguments.code);
  await assert.rejects(h.run('await app.typeText("blocked")'), /Native access stopped/);
  h.reply(1, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  h.call(3, 'app = await cua.getApp("TextEdit")');
  await h.run(h.sent.find(msg => msg.id === 3).params.arguments.code);
  assert.deepEqual(Array.from(h.context.writes), []);
});

test('a missing stale native file denies native access without blocking browser inventory', async t => {
  const h = runtime(t, { changeReview: true });
  const file = join(h.directory, 'saved.txt'); writeFileSync(file, 'before');
  h.call(1, 'app = await cua.getApp("TextEdit")');
  h.reply(1, { content: [{ type: 'text', text: `Window: "saved.txt", App: TextEdit\nURL: ${pathToFileURL(file).href}` }],
    _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId: 'com.apple.TextEdit' } } } });
  unlinkSync(file);
  h.call(2, 'await cua.listTabs()');
  const sent = h.sent.find(msg => msg.id === 2);
  assert.ok(sent, JSON.stringify(h.received));
  await h.run(sent.params.arguments.code);
  await assert.rejects(h.run('await cua.getApp("TextEdit")'), /Native access stopped.*snapshot/);
});

test('browser handles named app retain browser behavior across guarded calls', async t => {
  const h = runtime(t);
  h.call(1, 'app = await cua.getTab("1")');
  await h.run(h.sent.at(-1).params.arguments.code);
  h.reply(1, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  h.call(2, 'await app.getAXState()');
  await h.run(h.sent.at(-1).params.arguments.code);
  assert.equal(h.context.nativeReads, 0);
});

test('a new const browser app binding does not enter the native wrapper before initialization', async t => {
  const h = runtime(t);
  h.call(1, 'const app = await cua.getTab("1")');
  await h.run(h.sent.at(-1).params.arguments.code);
  assert.equal(h.context.nativeReads, 0);
});
