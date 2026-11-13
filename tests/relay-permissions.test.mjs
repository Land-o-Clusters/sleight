import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { appRefusal, pageRefusal, sitesLimited } from '../plugins/sleight/lib/permissions.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const LINE = 'You blocked sleight in Blocked App (sleight-mcp permissions unblock com.example.blocked lifts it).';

// The user's blocks, as the launcher's permission check gives them: only com.example.blocked ("Blocked App").
function blocks() {
  const perms = { state: 'ok', apps: [{ id: 'com.example.blocked', name: 'Blocked App' }], sites: [] }, noted = [];
  return { noted, app: query => appRefusal(perms, query), noteApp: app => noted.push(app) };
}

function harness(t, options = {}) {
  const [clientIn, clientOut, serverIn, serverOut] = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  const toServer = [], toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const directory = mkdtempSync(join(tmpdir(), 'sleight-permissions-relay-'));
  const permissions = 'permissions' in options ? options.permissions : blocks();
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's', permissions,
    inputLease: new InputLease({ directory, holder: 'A' }), ...options });
  t.after(() => { relay.close(); removeTemp(directory); });
  const call = (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return {
    toServer, toClient, permissions,
    js: (id, code) => call(id, 'js', { code }), call,
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
    reply: id => toClient.find(m => m.id === id),
    sent: id => toServer.some(m => m.id === id),
  };
}
const read = (id, app, appId, title = 'Doc') => ({ jsonrpc: '2.0', id, result: {
  content: [{ type: 'text', text: `Window: ${JSON.stringify(title)}, App: ${app}.\n0 standard window ${title}\n\t1 button Save` }],
  _meta: { 'codex/toolSurface': { app: { appId } } } } });

test('a call that names a blocked app, by bundle id or name, gets the user\'s line and never reaches the engine', async t => {
  const h = harness(t);
  for (const [id, code] of [[1, 'let app = await cua.getApp("com.example.blocked")'], [2, "let app = await cua.getApp('Blocked App')"],
    [3, 'let a = await cua.getApp("com.example.fine"); let b = await cua.getApp("blocked app"); await b.click(1)']]) {
    h.js(id, code);
    await settle();
    assert.equal(h.sent(id), false, code);
    assert.deepEqual(h.reply(id).result, { isError: true, content: [{ type: 'text', text: LINE }] }, code);
  }
});

test('getApp spellings the engine accepts are read like plain strings: spacing, brackets, template literals, joined strings and .app', async t => {
  const h = harness(t);
  const codes = ['let a = await cua.getApp ("Blocked App")', 'let a = await cua["getApp"]("Blocked App")', 'let a = await cua.getApp(`Blocked App`)',
    'let a = await cua.getApp("Blocked" + " App")', 'let a = await cua.getApp("Blocked App.app")', 'let a = await cua.getApp("/Applications/Blocked App.app")'];
  for (const [i, code] of codes.entries()) {
    h.js(i + 1, code); await settle();
    assert.equal(h.sent(i + 1), false, code);
    assert.equal(h.reply(i + 1).result.content[0].text, LINE, code);
  }
});

test('in document scope the engine\'s approval for a blocked app is declined too, before the document path answers it', async t => {
  const asked = [];
  const h = harness(t, { approvalScope: 'document', ask: async message => { asked.push(message); return 'accept'; } });
  h.js(1, 'let app = await cua.getApp("Alias")'); await settle();
  assert.equal(h.sent(1), true, 'a read in document scope, whose approval the document path would ask about');
  h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "Blocked App"?',
    _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'high', tool_params: { app: 'Blocked App' } } } });
  await settle();
  assert.deepEqual(asked, []);
  assert.deepEqual(h.toServer.find(m => m.id === 'e1').result, { action: 'decline' });
});

test('a read that turns out to be a blocked app shows Claude only the line, and the next action stops before the engine', async t => {
  const h = harness(t);
  h.js(1, 'let app = await cua.getApp("Some Alias")');
  await settle();
  assert.equal(h.sent(1), true, 'an unknown name still goes to the engine');
  h.fromServer(read(1, 'Blocked App', 'com.example.blocked'));
  await settle();
  assert.deepEqual(h.reply(1).result, { isError: true, content: [{ type: 'text', text: LINE }] });
  assert.doesNotMatch(JSON.stringify(h.reply(1)), /button Save/, 'nothing of the window reaches Claude');
  h.js(2, 'await app.click(1)');
  await settle();
  assert.equal(h.sent(2), false);
  assert.equal(h.reply(2).result.content[0].text, LINE);
  assert.deepEqual(h.permissions.noted, [], 'a blocked app is never offered as the current app');
});

test('an allowed app is noted for the menu, and a handle to a blocked app is refused while another app holds the lease', async t => {
  const h = harness(t);
  h.js(1, 'let other = await cua.getApp("com.example.fine")');
  await settle();
  h.fromServer(read(1, 'Fine App', 'com.example.fine'));
  await settle();
  assert.equal(h.reply(1).result.isError, undefined);
  assert.deepEqual(h.permissions.noted.at(-1), { bundleId: 'com.example.fine', name: 'Fine App' });
  h.js(2, 'await other.click(1)');
  await settle();
  assert.equal(h.sent(2), true);
  h.fromServer(read(2, 'Fine App', 'com.example.fine'));
  await settle();
  // An action on a handle that an earlier read bound to the blocked app.
  h.js(3, 'let held = await cua.getApp("Alias Two")');
  await settle();
  h.fromServer(read(3, 'Blocked App', 'com.example.blocked'));
  await settle();
  h.js(4, 'let x = await cua.getApp("com.example.fine"); await held.click(1)');
  await settle();
  assert.equal(h.sent(4), false);
  assert.equal(h.reply(4).result.content[0].text, LINE);
});

test('the engine\'s approval for a blocked app is declined without asking, and the call answers with the line', async t => {
  const asked = [];
  const h = harness(t, { ask: async message => { asked.push(message); return 'accept'; } });
  h.js(1, 'let app = await cua.getApp("Alias")');
  await settle();
  h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "Blocked App"?',
    _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'high', tool_params: { app: 'Blocked App' } } } });
  await settle();
  assert.deepEqual(asked, []);
  assert.deepEqual(h.toServer.find(m => m.id === 'e1').result, { action: 'decline' });
  h.fromServer({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'The user declined.' } });
  await settle();
  assert.deepEqual(h.reply(1).result, { isError: true, content: [{ type: 'text', text: LINE }] });
});

test('a local tool naming a blocked app is refused before it runs', async t => {
  const ran = [];
  const h = harness(t, { localTools: { tools: [{ name: 'menu_bar', description: 'x', inputSchema: { type: 'object' } }],
    call: async name => { ran.push(name); return { content: [{ type: 'text', text: 'ok' }] }; } } });
  h.call(1, 'menu_bar', { op: 'open', app: 'com.example.blocked' });
  await settle();
  assert.deepEqual(ran, []);
  assert.equal(h.reply(1).result.content[0].text, LINE);
});

test('a revoke that takes an app off the always list also ends this session\'s own approval of it', async t => {
  const asked = [];
  let removed;
  const preapproved = { size: 0, allows: () => false, list: () => [], add() {}, onRemoved: listener => { removed = listener; } };
  const h = harness(t, { preapproved, ask: async message => { asked.push(message); return 'accept'; } });
  const approval = id => h.fromServer({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message: 'Allow Computer Use to use "com.example.notes"?',
    _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'low', tool_params: { app: 'com.example.notes' } } } });
  approval('e1'); await settle();
  approval('e2'); await settle();
  assert.equal(asked.length, 1, 'the session remembers the first answer');
  removed(['com.example.other']); approval('e3'); await settle();
  assert.equal(asked.length, 1, 'another app\'s revoke changes nothing here');
  removed(['com.example.notes']); approval('e4'); await settle();
  assert.equal(asked.length, 2, 'after the revoke the app asks again');
});

test('without the launcher\'s permissions nothing is blocked', async t => {
  const h = harness(t, { permissions: null });
  h.js(1, 'let app = await cua.getApp("com.example.blocked")');
  await settle();
  assert.equal(h.sent(1), true);
});

// Site limits on the engine path, with tree shapes recorded from real reads (see permissions.test.mjs).
function siteLimits(perms) {
  return { app: query => appRefusal(perms, query), page: page => pageRefusal(perms, page), sitesLimited: () => sitesLimited(perms), noteApp() {} };
}
const safariTree = url => 'Window: "Best Buy", App: Safari.\n0 standard window Best Buy, ID: SafariWindow, Secondary Actions: Raise\n' +
  `\t5 HTML content Description: HP monitor, URL: ${url}\n\t\t13 link Shop now, Value: bestbuy.com/top-deals`;
const firefoxTree = 'Window: "Mozilla Firefox", App: Firefox.\n0 standard window Mozilla Firefox\n\t14 container\n' +
  '\t\t17 combo box (settable) Description: Search with Google or enter address, Value: https://example.test/';
const treeReply = (id, text, appId) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], _meta: { 'codex/toolSurface': { app: { appId } } } } });
const BLOCKED_SITE = 'You blocked sleight on https://bestbuy.com (sleight-mcp permissions unblock https://bestbuy.com lifts it).';

test('engine path: a browser window showing a blocked site gives Claude only the line, and its actions stop before the engine', async t => {
  const h = harness(t, { permissions: siteLimits({ state: 'ok', apps: [], sites: ['https://bestbuy.com'] }) });
  h.js(1, 'let app = await cua.getApp("com.apple.Safari")'); await settle();
  h.fromServer(treeReply(1, safariTree('bestbuy.com/product/hp-24yh'), 'com.apple.Safari')); await settle();
  assert.deepEqual(h.reply(1).result, { isError: true, content: [{ type: 'text', text: BLOCKED_SITE }] });
  h.js(2, 'await app.click(13)'); await settle();
  assert.equal(h.sent(2), false);
  assert.equal(h.reply(2).result.content[0].text, BLOCKED_SITE);
});

test('engine path: allow-only refuses an unlisted site and passes a listed one', async t => {
  const h = harness(t, { permissions: siteLimits({ state: 'ok', apps: [], sites: [], only: ['https://www.bestbuy.com'] }) });
  h.js(1, 'let app = await cua.getApp("com.apple.Safari")'); await settle();
  h.fromServer(treeReply(1, safariTree('https://www.bestbuy.com/x'), 'com.apple.Safari')); await settle();
  assert.equal(h.reply(1).result.isError, undefined);
  h.js(2, 'await app.click(13)'); await settle();
  assert.equal(h.sent(2), true, 'a listed site acts');
  h.fromServer(treeReply(2, safariTree('https://other.example/y'), 'com.apple.Safari')); await settle();
  assert.match(h.reply(2).result.content[0].text, /^You allow sleight only on https:\/\/www\.bestbuy\.com, not https:\/\/other\.example/);
  h.js(3, 'await app.click(13)'); await settle();
  assert.equal(h.sent(3), false);
});

test('engine path: a browser window whose site no read proves is refused while site limits exist, and acts without them', async t => {
  for (const [sites, sent] of [[['https://bestbuy.com'], false], [[], true]]) {
    const h = harness(t, { permissions: siteLimits({ state: 'ok', apps: [], sites }), webBrowser: id => id === 'org.mozilla.firefox' });
    h.js(1, 'let app = await cua.getApp("org.mozilla.firefox")'); await settle();
    h.fromServer(treeReply(1, firefoxTree, 'org.mozilla.firefox')); await settle();
    assert.equal(h.reply(1).result.isError, undefined, 'the read itself still reaches Claude');
    h.js(2, 'await app.click(17)'); await settle();
    assert.equal(h.sent(2), sent, JSON.stringify(sites));
    if (!sent) assert.match(h.reply(2).result.content[0].text, /^You limited the sites sleight acts on, and it can't tell which site this window shows/);
  }
});

test('engine path: until sleight knows which apps are browsers, an app with no proven site is refused under site limits (the launcher\'s default)', async t => {
  const h = harness(t, { permissions: siteLimits({ state: 'ok', apps: [], sites: ['https://bestbuy.com'] }) });
  h.js(1, 'let app = await cua.getApp("org.mozilla.firefox")'); await settle();
  h.fromServer(treeReply(1, firefoxTree, 'org.mozilla.firefox')); await settle();
  assert.equal(h.reply(1).result.isError, undefined, 'the read still reaches Claude');
  h.js(2, 'await app.click(17)'); await settle();
  assert.equal(h.sent(2), false);
  assert.match(h.reply(2).result.content[0].text, /^You limited the sites sleight acts on, and it doesn't know yet whether this app is a web browser/);
  // A proven blocked site still names the block while the list is unknown.
  h.js(3, 'let s = await cua.getApp("com.apple.Safari")'); await settle();
  h.fromServer(treeReply(3, safariTree('bestbuy.com/x'), 'com.apple.Safari')); await settle();
  assert.equal(h.reply(3).result.content[0].text, BLOCKED_SITE);
});

test('engine path: a title or description that names an allowed site proves nothing, so allow-only refuses the action', async t => {
  const h = harness(t, { permissions: siteLimits({ state: 'ok', apps: [], sites: [], only: ['https://allowed.example'] }), webBrowser: () => true });
  const title = 'Deals URL: https://allowed.example/';
  h.js(1, 'let app = await cua.getApp("com.apple.Safari")'); await settle();
  h.fromServer(treeReply(1, `Window: "${title}", App: Safari.\n0 standard window ${title}, ID: SafariWindow\n\t5 HTML content URL: evil.example/x\n\t\t6 button Buy`, 'com.apple.Safari')); await settle();
  assert.match(h.reply(1).result.content[0].text, /^You allow sleight only on https:\/\/allowed\.example, not evil\.example/);
  h.js(2, 'await app.click(6)'); await settle();
  assert.equal(h.sent(2), false);
  h.js(3, 'let b = await cua.getApp("com.apple.Safari")'); await settle();
  h.fromServer(treeReply(3, 'Window: "x", App: Safari.\n0 standard window x\n\t5 HTML content Description: x URL: allowed.example, URL: evil.example/x\n\t\t6 button Buy', 'com.apple.Safari')); await settle();
  h.js(4, 'await b.click(6)'); await settle();
  assert.equal(h.sent(4), false);
  assert.match(h.reply(4).result.content[0].text, /can't tell which site this window shows/);
});

test('engine path: when the browser list failed, an app is judged by its read, so a native app acts and web content without a site does not', async t => {
  const h = harness(t, { permissions: siteLimits({ state: 'ok', apps: [], sites: ['https://bestbuy.com'] }), webBrowser: () => null });
  h.js(1, 'let notes = await cua.getApp("com.example.notes")'); await settle();
  h.fromServer(read(1, 'Notes', 'com.example.notes')); await settle();
  h.js(2, 'await notes.click(1)'); await settle();
  assert.equal(h.sent(2), true, 'a native window with no web content acts');
  h.fromServer(read(2, 'Notes', 'com.example.notes')); await settle();
  h.js(3, 'let web = await cua.getApp("com.example.browserlike")'); await settle();
  h.fromServer(treeReply(3, 'Window: "x", App: B.\n0 standard window x\n\t5 HTML content URL: a.example/x\n\t5 HTML content URL: b.example/y\n\t\t6 button Go', 'com.example.browserlike')); await settle();
  h.js(4, 'await web.click(6)'); await settle();
  assert.equal(h.sent(4), false);
  assert.match(h.reply(4).result.content[0].text, /can't tell which site this window shows/);
});

test('engine path: a confirmed browser\'s read of a page whose site can\'t be proven is withheld, and a page-less read is not', async t => {
  const h = harness(t, { permissions: siteLimits({ state: 'ok', apps: [], sites: ['https://bestbuy.com'] }), webBrowser: () => true });
  h.js(1, 'let b = await cua.getApp("com.apple.Safari")'); await settle();
  h.fromServer(treeReply(1, 'Window: "x", App: Safari.\n0 standard window x\n\t5 HTML content Description: x URL: allowed.example, URL: evil.example/x\n\t\t6 text secret page text', 'com.apple.Safari')); await settle();
  assert.match(h.reply(1).result.content[0].text, /^You limited the sites sleight acts on, and it can't tell which site this window shows/);
  assert.doesNotMatch(JSON.stringify(h.reply(1)), /secret page text/);
  h.js(2, 'let f = await cua.getApp("org.mozilla.firefox")'); await settle();
  h.fromServer(treeReply(2, firefoxTree, 'org.mozilla.firefox')); await settle();
  assert.equal(h.reply(2).result.isError, undefined, 'a start page with no web area still reads');
});

test('engine path: an app that is no web browser acts with site limits, web content or not', async t => {
  const h = harness(t, { permissions: siteLimits({ state: 'ok', apps: [], sites: ['https://bestbuy.com'] }), webBrowser: () => false });
  h.js(1, 'let app = await cua.getApp("com.example.webview")'); await settle();
  h.fromServer(treeReply(1, safariTree('bestbuy.com/embedded').replace('App: Safari', 'App: Webview App'), 'com.example.webview')); await settle();
  assert.equal(h.reply(1).result.isError, undefined);
  h.js(2, 'await app.click(13)'); await settle();
  assert.equal(h.sent(2), true);
});

test('engine path: a browser-surface call is refused while site limits exist, since it names no page sleight can check', async t => {
  const h = harness(t, { permissions: siteLimits({ state: 'ok', apps: [], sites: ['https://bestbuy.com'] }) });
  h.js(1, 'let tab = await cua.createBrowserTab("abc", "https://example.com")'); await settle();
  assert.equal(h.sent(1), false);
  assert.match(h.reply(1).result.content[0].text, /can't check the site of an engine browser call/);
});
