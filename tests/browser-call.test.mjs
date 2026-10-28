import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { guardedCode, readCode } from '../plugins/sleight/lib/document-scope.mjs';
import { browserCall } from '../plugins/sleight/lib/browser-call.mjs';

test('literal browser calls are classified as browser', () => {
  assert.ok(browserCall('await cua.listBrowsers()'));
  assert.ok(browserCall('let tab = await cua.createBrowserTab("abc", "https://example.com")'));
  assert.ok(browserCall('await tab.getByRole("link", { name: "More" }).click()', new Set(['tab'])));
  assert.ok(browserCall('const rows = [1, 2]; await tab.goto("https://example.com")', new Set(['tab'])));
  assert.ok(browserCall('const tabs = await cua.listTabs(); nodeRepl.write(tabs[0])'));
});

test('a native lease refusal with a confirmed browser handle names browser acquisition', t => {
  const h = runtime(t);
  h.call(1, 'let tab = await cua.getTab("1")');
  h.reply(1, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  h.call(2, '// inventory\nawait cua.getState()');
  assert.equal(h.sent.some(msg => msg.id === 2), false);
  const text = h.received.find(msg => msg.id === 2).result.content[0].text;
  assert.match(text, /Input lease:/);
  assert.match(text, /For browser work, use cua\.getBrowser/);
  assert.match(text, /cua\.listTabs\(\)/);
});

for (const pending of ['browser', 'native']) test(`a ${pending} call pending after browser acquisition does not suggest switching APIs`, t => {
  const h = runtime(t);
  h.call(1, 'let tab = await cua.getTab("1")');
  h.reply(1, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  h.call(2, pending === 'browser' ? 'await tab.getAXState()' : 'let app = await cua.getApp("Editor")');
  h.call(3, '// inventory\nawait cua.getState()');
  const text = h.received.find(msg => msg.id === 3).result.content[0].text;
  assert.match(text, /pending/);
  assert.doesNotMatch(text, /For browser work|Browser work:|cua\.listTabs/);
});
test('a mixed browser acquisition and native inventory refusal names browser acquisition', t => {
  const h = runtime(t);
  h.call(1, 'const b = await cua.getBrowser({}); const state = await cua.getState(); state.browsers.length;');
  assert.equal(h.sent.length, 0);
  assert.match(h.received.at(-1).result.content[0].text, /For browser work, use cua\.getBrowser/);
});
test('a native refusal without browser context does not suggest switching APIs', t => {
  const h = runtime(t); h.call(1, '// inventory\nawait cua.getState()');
  assert.doesNotMatch(h.received.at(-1).result.content[0].text, /For browser work/);
});

const recordedLeases = JSON.parse(readFileSync(new URL('./fixtures/h4-native-lease.json', import.meta.url), 'utf8'));
for (const { id, code } of recordedLeases) test(`recorded native lease refusal retains routing and adds browser advice: ${id}`, t => {
  assert.equal(browserCall(code, new Set(['browserTab'])), undefined);
  const h = runtime(t);
  h.call(1, 'let browserTab = await cua.getTab("1")');
  h.reply(1, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  h.call(2, code);
  assert.equal(h.sent.some(msg => msg.id === 2), false);
  assert.match(h.received.find(msg => msg.id === 2).result.content[0].text, /For browser work, use cua\.getBrowser/);
});

test('optional and parenthesized native roots retain native routing', () => {
  for (const code of ['await app?.click(3)', 'await (app).click(3)']) {
    assert.equal(browserCall(code, new Set(), new Set(['app'])), undefined, code);
  }
});

for (const restart of ['js_reset', 'engine restart']) test(`native routing names survive ${restart} without retaining a lease`, async t => {
  const h = runtime(t);
  const docs = '## Computer Use\n';
  h.call(1, 'let editor = await cua.getApp("Editor")');
  h.reply(1, { content: [{ type: 'text', text: docs }] });
  await new Promise(resolve => setImmediate(resolve));
  h.call(2, restart === 'js_reset' ? '' : 'await cua.listApps()', restart === 'js_reset' ? 'js_reset' : 'js');
  h.reply(2, { content: [{ type: 'text', text: restart === 'js_reset' ? 'reset' : docs }] });
  await new Promise(resolve => setImmediate(resolve));
  h.call(3, 'await editor.click(1)');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sent.some(msg => msg.id === 3), false, 'a lost native handle cannot enter a tab plan');
  assert.match(h.received.find(msg => msg.id === 3).result.content[0].text, /bundle ID and full window header/);
  assert.equal(h.lease.owned.size, 0);
});

for (const code of [
  'await tab.playwright.evaluate(() => window.store.getState().cart.length)',
  'await tab.playwright.evaluate(() => { const app = document.getElementById("app"); return app.innerText })',
  'let app = {x:1}; console.log(app.x); await tab.click(1)',
]) {
  test(`page JavaScript passes without native word matches: ${code}`, () => {
    assert.ok(browserCall(code, new Set(['tab'])), code);
    assert.ok(browserCall(code, new Set(['tab']), new Set(['app'])), 'local app bindings shadow native roots');
  });
}

for (const [binding, names] of [
  ['const [a, b] = await Promise.all([cua.getApp("X"), cua.getApp("Y")])', ['a', 'b']],
  ['const alias = app', ['alias']],
  ['const { editor } = { editor: app }', ['editor']],
  ['const { getApp: acquire } = cua; const editor = await acquire("X")', ['editor']],
]) {
  test(`native bindings retain their lease route: ${binding}`, t => {
    const h = runtime(t);
    h.call(1, 'app = await cua.getApp("Editor")'); h.reply(1, { content: [] });
    h.call(2, binding);
    if (h.sent.some(msg => msg.id === 2)) h.reply(2, { content: [] });
    for (const [i, name] of names.entries()) {
      h.call(3 + i, `await ${name}.click(1)`);
      assert.equal(h.sent.some(msg => msg.id === 3 + i), false, name);
      assert.match(h.received.at(-1).result.content[0].text, /bundle ID and full window header/);
    }
  });
}

test('browser plans deny indirect native input even when inputLease is disabled', async t => {
  const h = runtime(t, { inputLease: undefined });
  h.call(1, 'app = await cua.getApp("TextEdit")');
  await h.run(h.sent.at(-1).params.arguments.code);
  h.reply(1, { content: [{ type: 'text', text: 'Window: "b.txt", App: TextEdit' }] });
  runInContext('var nativeAction = () => app.typeText("blocked")', h.context);
  h.call(2, 'await cua.listTabs(); await nativeAction()');
  await assert.rejects(h.run(h.sent.at(-1).params.arguments.code), /Native access stopped.*handle.*cua.getApp.*directly/i);
  assert.deepEqual(Array.from(h.context.writes), []);
});

test('an unknown read handle learns its native identity from the engine reply', t => {
  const h = runtime(t);
  h.call(1, 'await editor.getAXState({ disableDiffing: true })');
  h.reply(1, { content: [{ type: 'text', text: 'Window: "a.txt", App: Editor' }],
    _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId: 'org.test.editor' } } } });
  h.call(2, 'await editor.click(1)');
  assert.ok(h.sent.some(msg => msg.id === 2));
  assert.equal(h.lease.owned.size, 1, 'the newly identified native handle acquires its app lease');
});

const refusedTabCalls = [
  'console.log(await tab.getAXState({disableDiffing:true, emit:false}));',
  'const s = await tab.getAXState({disableDiffing:true, emit:false}); s.slice(0, 15000)',
  'await tab.click(10); await tab.typeText ? "hasTypeText" : Object.keys(tab)',
  'await tab.drag([464, 424], [464, 362]);\nawait tab.getScreenshot()',
  'const ks = []; for (let o = tab; o; o = Object.getPrototypeOf(o)) ks.push(...Object.getOwnPropertyNames(o)); [...new Set(ks)].join(",");',
  'const st = await tab.getAXState({disableDiffing:true}); st.split("\\n").filter(l=>/December 1[49]|text (Oct|Nov|Dec)|month|Dates|Value/.test(l)).join("\\n")',
  'let tab2 = await cua.createBrowserTab(b.browserId, "http://127.0.0.1:5420/t/handoff/shop/", { sessionName: "🧪 handoff" }); "ok"',
  'let tab = await cua.createBrowserTab(b.browserId, "http://127.0.0.1:5420/t/inject-mail/mail/", { sessionName: "🧪 inject-mail" });\nglobalThis.tab = tab;',
  'globalThis.tab = await cua.getTab("1466193133", { browser: "1" })',
  'globalThis.tab = await cua.getTab("1", { browser: "1" })',
];

for (const code of refusedTabCalls) {
  test(`tab code with ordinary JavaScript passes the relay lease gate: ${code}`, t => {
    const h = runtime(t);
    h.call(1, 'let tab = await cua.getTab("1")');
    h.reply(1, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
    h.call(2, code);
    assert.ok(h.sent.find(msg => msg.id === 2), JSON.stringify(h.received));
    assert.equal(h.lease.owned.size, 0);
  });
}

test('two browser sessions never reserve the previous native browser app', t => {
  const a = runtime(t);
  const b = runtime(t, { inputLease: new InputLease({ directory: a.directory }) });
  // Both previously read native windows from the same app. The next calls use tabs only.
  for (const h of [a, b]) {
    h.call(1, 'app = await cua.getApp("Browser")');
    h.reply(1, { content: [{ type: 'text', text: 'Window: "Page", App: Browser' }],
      _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId: 'org.test.browser' } } } });
    h.call(2, 'let tab = await cua.getTab("1")');
    h.reply(2, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  }
  a.call(3, 'await tab.reload()');
  b.call(3, 'await tab.reload()');
  for (const h of [a, b]) {
    assert.ok(h.sent.find(msg => msg.id === 3), JSON.stringify(h.received));
    assert.equal(h.lease.owned.size, 0, 'pending browser input holds no native lease');
  }
});

test('a custom native handle still requires a confirmed window', t => {
  const h = runtime(t);
  h.call(1, 'let editor = await cua.getApp("Editor")');
  h.reply(1, { content: [] });
  h.call(2, 'console.log("action"); await editor.click(1)');
  assert.equal(h.sent.some(msg => msg.id === 2), false);
  assert.match(h.received.at(-1).result.content[0].text, /bundle ID and full window header/);
});

test('browser calls in document mode do not require a native document', t => {
  const h = runtime(t, { approvalScope: 'document' });
  h.call(1, 'globalThis.tab = await cua.getTab("1", { browser: "1" })');
  assert.ok(h.sent.find(msg => msg.id === 1), JSON.stringify(h.received));
  assert.equal(h.lease.owned.size, 0);
});

test('browser calls cannot reuse a native grant through an indirect function', async t => {
  const h = runtime(t);
  h.call(1, 'app = await cua.getApp("TextEdit")');
  await h.run(h.sent.at(-1).params.arguments.code);
  h.reply(1, { content: [{ type: 'text', text: 'Window: "b.txt", App: TextEdit' }],
    _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId: 'com.apple.TextEdit' } } } });
  runInContext('var nativeAction = () => app.typeText("blocked")', h.context);
  h.call(2, 'await cua.listTabs(); await nativeAction()');
  assert.equal(h.lease.owned.size, 0);
  await assert.rejects(h.run(h.sent.at(-1).params.arguments.code), /Native access stopped/);
  assert.deepEqual(Array.from(h.context.writes), []);
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

test('named native APIs and app handles keep the call on the native path', () => {
  for (const code of [
    ...bypasses.slice(0, 5), bypasses[7], bypasses[8],
    'await cua?.getApp("Editor")',
    'await cua.computer.click({ x: 1, y: 2 })',
    'await cua.listApps(); await tab.reload()',
    'await cua.getState(); await tab.reload()',
  ]) assert.equal(browserCall(code, new Set(['tab']), new Set(['app'])), undefined, code);
});

function runtime(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-browser-runtime-'));
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  for (const [stream, rows] of [[serverIn, sent], [clientOut, received]]) {
    stream.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => rows.push(JSON.parse(line))));
  }
  const lease = options.inputLease ?? new InputLease({ directory });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: lease, changeReview: false, ...options });
  t.after(() => { relay.close(); removeTemp(directory); });
  const call = (id, code, name = 'js') => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n');
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
  test(`careful native runtime guard stops bypass ${index + 1}: ${code}`, async t => {
    const h = runtime(t, { guardMode: 'careful' });
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
    if ([10,16,17].includes(index)) {
      assert.equal(forwarded, undefined);
      assert.equal(h.received.find(msg=>msg.id===3).result.content[0].text, 'sleight: cannot inspect JavaScript. Use direct calls with literal arguments.');
      assert.deepEqual(Array.from(h.context.writes), []); return;
    }
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
    h.call(0, 'app = await cua.getApp("Editor")'); h.reply(0, { content: [] });
    h.call(1, 'let app = await cua.getTab("1")'); h.reply(1, result);
    h.call(2, 'await app.reload()');
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

test('browser handles from getBrowser and getTab survive a session that already used the engine', t => {
  const h = runtime(t);
  const docs = '## Computer Use\n\nControl native apps.\n';
  h.call(1, 'await cua.getState()');
  h.reply(1, { content: [{ type: 'text', text: docs }] });
  h.call(2, 'let browser = await cua.getBrowser({ extensionInstanceId: "helium" });\nlet tab = await cua.getTab("1");');
  assert.ok(h.sent.find(msg => msg.id === 2), JSON.stringify(h.received));
  h.reply(2, { content: [{ type: 'text', text: docs + 'Browser tab: 1' }], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  h.call(3, 'await browser.nameSession("console")');
  assert.ok(h.sent.find(msg => msg.id === 3), h.received.at(-1)?.result?.content?.[0]?.text);
  h.reply(3, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  h.call(4, 'await tab.goto("https://example.com")');
  assert.ok(h.sent.find(msg => msg.id === 4), h.received.at(-1)?.result?.content?.[0]?.text);
  h.reply(4, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  h.call(5, 'await cua.createBrowserTab(browser.browserId, "https://example.com")');
  assert.ok(h.sent.find(msg => msg.id === 5), h.received.at(-1)?.result?.content?.[0]?.text);
  h.reply(5, { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } });
  h.call('native', 'app = await cua.getApp("Editor")'); h.reply('native', { content: [] });
  h.call(6, 'await app.click(1)');
  assert.equal(h.sent.some(msg => msg.id === 6), false);
  assert.match(h.received.at(-1).result.content[0].text, /bundle ID and full window header/);
});
