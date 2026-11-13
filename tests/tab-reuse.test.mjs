import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { tabCleanupCode } from '../plugins/sleight/lib/browser-tab-cleanup.mjs';
import {
  openedTabNote, tabReuseCode, createOpenedTabs, parseOpenedPayload, readOpened,
} from '../plugins/sleight/lib/tab-reuse.mjs';

const REPLAY = [
  { task: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Mount_Kilimanjaro', error: 'tab.evaluate is not a function' },
  { task: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status', error: 'cua.getTabState is not a function' },
  { task: 'size-guide', url: 'http://127.0.0.1:5420/t/size-guide/shop/', error: 'tab.readState is not a function' },
  { task: 'inject-mail', url: 'http://127.0.0.1:5420/t/inject-mail/mail/', error: 'cua.getAXState is not a function' },
  { task: 'demoid', url: 'http://127.0.0.1:5420/t/demoid/shop/account', error: 'cua.getAXState is not a function' },
];

function fixture() {
  const closed = [];
  let next = 0;
  const cua = {
    createBrowserTab: async (_browser, url = 'about:blank') => {
      const id = String(++next);
      const tab = { id, url, browserId: String(_browser), close: async () => { closed.push(id); }, goto: async nextUrl => { tab.url = nextUrl; } };
      return tab;
    },
    getBrowser: async ({ id }) => ({
      browserId: id,
      tabs: {
        new: async url => cua.createBrowserTab(id, url),
        close: async tabId => { closed.push(String(tabId)); },
      },
    }),
  };
  const writes = [];
  const context = createContext({ cua, URL, nodeRepl: { write: value => writes.push(String(value)) } });
  const run = code => runInContext(`(async () => { ${code} })()`, context);
  return { cua, closed, run, context, writes };
}

function relayStreams(t) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], replies = [];
  serverIn.on('data', bytes => { for (const line of bytes.toString().trim().split('\n')) sent.push(JSON.parse(line)); });
  clientOut.on('data', bytes => { for (const line of bytes.toString().trim().split('\n')) replies.push(JSON.parse(line)); });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  return { clientIn, serverOut, sent, replies };
}

test('a const tab declared in the call is still defined in the next call', () => {
  const ctx = createContext({ cua: { createBrowserTab() { return { id: '1' }; } } });
  const wrapped = tabReuseCode('const tab = cua.createBrowserTab("b", "https://example.test/")');
  assert.doesNotMatch(wrapped, /try \{[\s\S]*const tab = cua\.createBrowserTab[\s\S]*\}\s*catch/);
  runInContext(wrapped, ctx);
  assert.notEqual(runInContext('typeof tab', ctx), 'undefined');
  const lost = createContext({ cua: { createBrowserTab() { return { id: '1' }; } } });
  runInContext('try {\nconst tab = cua.createBrowserTab("b", "https://example.test/")\n} catch (error) {}\n', lost);
  assert.throws(() => runInContext('tab', lost), /tab is not defined/);
});

test('openedTabNote names cua.getTab with a quoted id and quoted browser id', () => {
  const opened = createOpenedTabs();
  opened.record('898969305', 'https://en.wikipedia.org/wiki/Mount_Kilimanjaro', 'browser-one', '9');
  const out = openedTabNote('tab.evaluate is not a function', {
    code: 'const tab = await cua.createBrowserTab(b.browserId, "https://en.wikipedia.org/wiki/Mount_Kilimanjaro")',
    opened,
  });
  assert.match(out, /This call opened tab 898969305 \(https:\/\/en\.wikipedia\.org\/wiki\/Mount_Kilimanjaro\)/);
  assert.match(out, /cua\.getTab\("898969305", \{ browser: "browser-one" \}\)/);
  assert.doesNotMatch(out, /\{ browser \}/);
  assert.doesNotMatch(out, /b\.tabs\.get/);
});

test('closing via tab.close or tabs.close clears the record', async () => {
  const f = fixture();
  await f.run(tabReuseCode('var tab = await cua.createBrowserTab("b", "https://example.test/"); await tab.close();'));
  assert.equal(f.context.__sleightOpenedThisCall.length, 0);
  const g = fixture();
  await g.run(tabReuseCode('var b = await cua.getBrowser({ id: "b" }); var tab = await b.tabs.new("https://example.test/"); await b.tabs.close(tab.id);'));
  assert.equal(g.context.__sleightOpenedThisCall.length, 0);
});

test('tabs.new records the URL from a later goto', async () => {
  const f = fixture();
  await f.run(tabReuseCode('var b = await cua.getBrowser({ id: "b" }); var tab = await b.tabs.new(); await tab.goto("https://example.test/after");'));
  assert.equal(f.context.__sleightOpenedThisCall[0].url, 'https://example.test/after');
});

test('replayed create-then-throw cases name the opened tab with a quoted browser id', () => {
  for (const row of REPLAY) {
    const opened = createOpenedTabs();
    opened.record('1', row.url, 'b');
    const out = openedTabNote(row.error, {
      code: `const tab = await cua.createBrowserTab("b", ${JSON.stringify(row.url)});`,
      opened,
    });
    assert.match(out, new RegExp(row.error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(out, new RegExp(`This call opened tab 1 \\(${row.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    assert.match(out, /cua\.getTab\("1", \{ browser: "b" \}\)/);
    assert.doesNotMatch(out, /\{ browser \}/);
  }
});

test('the relay reads the opened-tab record after an error', t => {
  const h = relayStreams(t);
  h.clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {
    code: "const tab = await cua.createBrowserTab(b.browserId, 'https://en.wikipedia.org/wiki/Mount_Kilimanjaro'); tab.evaluate()",
  } } }) + '\n');
  assert.match(h.sent[0].params.arguments.code, /__sleightOpenedThisCall/);
  assert.match(h.sent[0].params.arguments.code, /__sleightOpenedCall = "1"/);
  assert.doesNotMatch(h.sent[0].params.arguments.code, /try \{[\s\S]*const tab = await cua\.createBrowserTab[\s\S]*\}\s*catch/);
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'tab.evaluate is not a function' }] } }) + '\n');
  assert.equal(h.replies.length, 0);
  assert.match(h.sent.at(-1).params.arguments.code, new RegExp(readOpened(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: h.sent.at(-1).id, result: { content: [{ type: 'text', text: JSON.stringify([{ id: '898969305', url: 'https://en.wikipedia.org/wiki/Mount_Kilimanjaro', browser: 'browser-one', call: '1' }]) }] } }) + '\n');
  assert.match(h.replies.at(-1).result.content[0].text, /cua\.getTab\("898969305", \{ browser: "browser-one" \}\)/);
  assert.doesNotMatch(h.replies.at(-1).result.content[0].text, /\{ browser \}/);
});

test('a throw without opening a tab never names one', () => {
  const opened = createOpenedTabs();
  opened.record('99', 'https://other.test/');
  assert.equal(openedTabNote('TypeError: boom', { code: 'await tab.click(1)', opened }), 'TypeError: boom');
  assert.equal(tabReuseCode('await tab.getAXState()'), 'await tab.getAXState()');
  assert.deepEqual(parseOpenedPayload('not json').list, []);
});

test('turn-end cleanup clears the opened-tab record', async () => {
  const f = fixture();
  await f.run(tabReuseCode(tabCleanupCode('await cua.createBrowserTab("b", "https://example.test/");')));
  assert.equal(f.context.__sleightOpenedThisCall.length, 1);
  await f.run('await globalThis.__sleightTabs.cleanup();');
  assert.equal(f.context.__sleightOpenedThisCall.length, 0);
});

test('the skill does not tell Claude to reuse with goto or mention an idle tab', () => {
  const skill = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url), 'utf8');
  const lean = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.lean.md', import.meta.url), 'utf8');
  for (const text of [skill, lean]) {
    assert.doesNotMatch(text, /idle tab/);
    assert.doesNotMatch(text, /Reuse that tab with tab\.goto/);
  }
});

test('a later CREATED call that never ran the wrapper does not name the previous tab', async () => {
  const f = fixture();
  await f.run(tabReuseCode('var tab = await cua.createBrowserTab("b", "https://form.test/checkout");', '9'));
  assert.equal(f.context.__sleightOpenedThisCall[0].id, '1');
  assert.equal(f.context.__sleightOpenedThisCall[0].call, '9');
  f.writes.length = 0;
  runInContext(readOpened('10'), f.context);
  assert.equal(f.writes.at(-1), '[]');
  assert.deepEqual(parseOpenedPayload(JSON.stringify(f.context.__sleightOpenedThisCall), '10').list, []);
});

test('a native ArrowDown error never gets a browser reorder hint', t => {
  const h = relayStreams(t);
  h.clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {
    code: 'await app.pressKey("ArrowDown")',
  } } }) + '\n');
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Error: timeout' }] } }) + '\n');
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].result.content[0].text, 'Error: timeout');
  assert.doesNotMatch(h.replies[0].result.content[0].text, /sleight\.reorder/);
  assert.equal(h.sent.filter(m => String(m.id).startsWith('sleight-opened-tabs-')).length, 0);
});

test('an unanswered opened-tab probe delivers the original error after 1.5 s', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = relayStreams(t);
  h.clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {
    code: 'const tab = await cua.createBrowserTab("b", "https://example.test/"); throw new Error("parse failed")',
  } } }) + '\n');
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'SyntaxError: unexpected token' }] } }) + '\n');
  assert.equal(h.replies.length, 0);
  assert.ok(h.sent.some(m => String(m.id).startsWith('sleight-opened-tabs-')));
  t.mock.timers.tick(1499);
  assert.equal(h.replies.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].result.content[0].text, 'SyntaxError: unexpected token');
  assert.equal(h.replies[0].result.isError, true);
});

test('a frozen tab still returns from createBrowserTab', async () => {
  const cua = {
    createBrowserTab: async () => Object.freeze({
      id: '1', url: 'https://example.test/', browserId: 'b',
      close: async () => {}, goto: async () => {},
    }),
  };
  const context = createContext({ cua, URL, nodeRepl: { write() {} } });
  const tab = await runInContext(
    `(async () => { 'use strict'; ${tabReuseCode('return await cua.createBrowserTab("b", "https://example.test/")')} })()`,
    context);
  assert.equal(tab.id, '1');
  assert.equal(context.__sleightOpenedThisCall[0].id, '1');
});

test('openedTabNote skips when the error already has the engine tab line', () => {
  const opened = createOpenedTabs();
  opened.record('1', 'https://example.test/', 'b');
  const text = 'Browser tab: 1, Title: "x", URL: "https://example.test/".\nError: click failed';
  assert.equal(openedTabNote(text, {
    code: 'const tab = await cua.createBrowserTab("b", "https://example.test/")',
    opened,
  }), text);
});

test('the opened-tab note is appended only to the last text item', t => {
  const h = relayStreams(t);
  h.clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {
    code: "const tab = await cua.createBrowserTab(b.browserId, 'https://en.wikipedia.org/wiki/Mount_Kilimanjaro'); tab.evaluate()",
  } } }) + '\n');
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [
    { type: 'text', text: '## Computer Use\nAlways ask.' },
    { type: 'text', text: 'tab.evaluate is not a function' },
  ] } }) + '\n');
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: h.sent.at(-1).id, result: { content: [{ type: 'text', text: JSON.stringify([{ id: '898969305', url: 'https://en.wikipedia.org/wiki/Mount_Kilimanjaro', browser: 'browser-one', call: '1' }]) }] } }) + '\n');
  const content = h.replies.at(-1).result.content;
  assert.equal(content[0].text, '## Computer Use\nAlways ask.');
  assert.doesNotMatch(content[0].text, /This call opened tab/);
  assert.match(content[1].text, /This call opened tab 898969305/);
});

test('a stale probe payload from an earlier call is ignored', t => {
  const h = relayStreams(t);
  h.clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'js', arguments: {
    code: 'const tab = await cua.createBrowserTab("b", "https://form.test/nine"); tab.evaluate()',
  } } }) + '\n');
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 9, result: { isError: true, content: [{ type: 'text', text: 'tab.evaluate is not a function' }] } }) + '\n');
  const firstProbe = h.sent.findLast(m => String(m.id).startsWith('sleight-opened-tabs-'));
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: firstProbe.id, result: { content: [{ type: 'text', text: JSON.stringify([{ id: '9', url: 'https://form.test/nine', browser: 'b', call: '9' }]) }] } }) + '\n');
  assert.match(h.replies.at(-1).result.content[0].text, /This call opened tab 9/);
  h.clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'js', arguments: {
    code: 'const tab = await cua.createBrowserTab("b", "https://form.test/ten"); missing()',
  } } }) + '\n');
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 10, result: { isError: true, content: [{ type: 'text', text: 'SyntaxError: unexpected token' }] } }) + '\n');
  const secondProbe = [...h.sent].reverse().find(m => String(m.id).startsWith('sleight-opened-tabs-') && m.id !== firstProbe.id);
  h.serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: secondProbe.id, result: { content: [{ type: 'text', text: JSON.stringify([{ id: '9', url: 'https://form.test/nine', browser: 'b', call: '9' }]) }] } }) + '\n');
  assert.equal(h.replies.at(-1).result.content[0].text, 'SyntaxError: unexpected token');
  assert.doesNotMatch(h.replies.at(-1).result.content[0].text, /opened tab 9/);
});
