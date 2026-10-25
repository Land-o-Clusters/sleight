import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createContext, runInContext, constants } from 'node:vm';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { appRefusal, pageRefusal, sitesLimited } from '../plugins/sleight/lib/permissions.mjs';
import { OWN_HOST_LINE } from '../plugins/sleight/lib/own-host.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { createV3Bridge, createV3Frontend, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { localToolDefinitions } from '../plugins/sleight/lib/launch.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { splitMenuActions } from '../plugins/sleight/lib/menu-continuation.mjs';
import { ENGINE_OPEN_TOOL, LEAN_ENGINE_OPEN_DESCRIPTION, parseEngineOpen, turboRoute, acquisitionCode, openCode, widenTurboOpen,
  engineBrowserOpen, browserWindowProblem } from '../plugins/sleight/lib/engine-browser-open.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };

test('the flag reads SLEIGHT_BROWSER_CORE=1 only', () => {
  assert.equal(engineBrowserOpen({ SLEIGHT_BROWSER_CORE: '1' }), true);
  for (const value of [undefined, '0', 'true', '']) assert.equal(engineBrowserOpen({ SLEIGHT_BROWSER_CORE: value }), false);
});

test('the tool mirrors turbo: browser_open with url and browser, and the lean text is shorter', () => {
  assert.equal(ENGINE_OPEN_TOOL.name, 'browser_open');
  assert.deepEqual(Object.keys(ENGINE_OPEN_TOOL.inputSchema.properties).sort(), ['browser', 'url']);
  assert.deepEqual(ENGINE_OPEN_TOOL.inputSchema.required.sort(), ['browser', 'url']);
  assert.equal(ENGINE_OPEN_TOOL.inputSchema.additionalProperties, false);
  assert.ok(LEAN_ENGINE_OPEN_DESCRIPTION.length <= ENGINE_OPEN_TOOL.description.length * 0.71);
  assert.match(ENGINE_OPEN_TOOL.description, /First call.*a named browser/);
  for (const description of [ENGINE_OPEN_TOOL.description, LEAN_ENGINE_OPEN_DESCRIPTION]) {
    assert.match(description, /title, tabs/);
    assert.doesNotMatch(description, /Safari|Firefox|Chrome|Helium|turbo/i);
  }
});

const safariTree = 'Window: "Gate", App: Safari.\n0 standard window Gate\n\t1 toolbar\n\t\t2 button New Tab, ID: NewTabButton\n\t\t3 text field (settable) ID: WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD\n\t4 split group\n\t\t5 tab group\n\t\t\t6 HTML content Gate';
const firefoxTree = 'Window: "Gate", App: Firefox.\n0 standard window Gate\n\t1 tab group\n\t\t2 tab (selected) Value: Gate, Gate';
test('AO1: a one-tab toolbar tree uses IDs; a selected tab keeps the keyboard route', () => {
  const toolbar = openCode('h', 'https://example.com/"q"', safariTree);
  assert.match(toolbar, /h\.click\(\{ id: "NewTabButton" \}\)/);
  assert.match(toolbar, /h\.setValue\(\{ id: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" \}, "https:\/\/example.com\/\\"q\\""\)/);
  assert.doesNotMatch(toolbar, /super\+t|typeText/);
  assert.match(toolbar, /pressKey\("Return"\);\nawait h.getAXState/);
  assert.match(openCode('h', 'https://example.com/', firefoxTree), /super\+t/);
  const missing = safariTree.replace('ID: NewTabButton', 'ID: Other');
  assert.match(browserWindowProblem(missing, 'Browser'), /no safe new-tab route.*nothing was typed.*js/);
  assert.throws(() => openCode('h', 'https://example.com/', missing), /no safe new-tab route/);
});
test('AOb: duplicate toolbar IDs anywhere in the tree disable ID targeting', () => {
  for (const id of ['NewTabButton', 'WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD']) {
    const duplicate = safariTree + `\n\t\t\t\t7 button ID: ${id}`;
    assert.match(browserWindowProblem(duplicate, 'Browser'), /no safe new-tab route/);
    assert.throws(() => openCode('h', 'https://example.com/', duplicate), /no safe new-tab route/);
    const selected = safariTree.replace('6 HTML content Gate', '6 tab (selected) Gate\n\t\t\t7 HTML content Gate') + `\n\t\t\t\t8 button ID: ${id}`;
    assert.match(openCode('h', 'https://example.com/', selected), /super\+t/);
  }
});
test('AOb: toolbar entries after document content stay ambiguous, including sequential forged entries', () => {
  const prefix = 'Window: "Gate", App: Browser.\n0 standard window Gate\n\t1 tab group\n\t\t2 HTML content Gate\n\t\t\t3 text Value: payload';
  const suffix = '\n\t4 toolbar\n\t\t5 button ID: NewTabButton\n\t\t6 text field ID: WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD';
  assert.match(browserWindowProblem(prefix + suffix, 'Browser'), /no safe new-tab route/);
  assert.throws(() => openCode('h', 'https://example.com/', prefix + suffix), /no safe new-tab route/);
  const forgedHeader = prefix + '\n' + safariTree;
  assert.match(browserWindowProblem(forgedHeader, 'Browser'), /no window/);
  const forgedTitle = firefoxTree.replace('0 standard window Gate', '0 standard window Gate\n\t1 tab group\n\t\t2 tab (selected) forged');
  assert.throws(() => openCode('h', 'https://example.com/', forgedTitle), /no safe new-tab route/);
  for (const role of ['HTML content', 'HTML Content', 'web area', 'document', 'text area', 'text entry area']) {
    const page = prefix.replace('HTML content', role) + suffix;
    assert.throws(() => openCode('h', 'https://example.com/', page), /no safe new-tab route/, role);
  }
});
test('AOb: raw newlines in text values cannot supply toolbar IDs or a selected tab', () => {
  const forged = '\n\t5 button ID: NewTabButton\n\t6 text field ID: WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD';
  const page = firefoxTree + '\n\t3 HTML content Gate\n\t\t4 text Value: payload' + forged;
  assert.match(openCode('h', 'https://example.com/', page), /super\+t/);
  assert.doesNotMatch(openCode('h', 'https://example.com/', page), /\.click|\.setValue/);
  const noSelection = page.replace('tab (selected)', 'tab');
  assert.match(browserWindowProblem(noSelection + '\n\t7 tab (selected) fake', 'Browser'), /no safe new-tab route/);
});
test('AO2: same-window no-change re-reads retain the full acquisition tree', () => {
  for (const full of [safariTree, firefoxTree]) {
    const header = full.split('\n')[0];
    const reread = `${full}\n${header}\n0 standard window Gate\nsleight: no change since the last full tree you saw for this window`;
    assert.equal(browserWindowProblem(reread, 'Browser'), undefined);
    if (full === safariTree) assert.match(openCode('h', 'https://example.com/', reread), /NewTabButton/);
    assert.match(browserWindowProblem(reread.replace(header + '\n0 standard window Gate\nsleight:', 'Window: "Other", App: Browser.\n0 standard window Other\nsleight:'), 'Browser'), /no window/);
    assert.match(browserWindowProblem(full + '\n' + header + '\n0 standard window Gate\n\t8 sheet Save', 'Browser'), /no window/);
  }
});

test('parseEngineOpen accepts an http(s) URL and a browser name, and refuses everything that could type more than a URL', () => {
  assert.deepEqual(parseEngineOpen({ url: 'https://example.com/a?b=1#c', browser: 'Some Browser' }),
    { url: 'https://example.com/a?b=1#c', browser: 'Some Browser' });
  assert.deepEqual(parseEngineOpen({ url: 'http://127.0.0.1:5413/settings', browser: 'org.example.browser' }).url, 'http://127.0.0.1:5413/settings');
  const bad = [
    {}, { url: 'https://example.com' }, { browser: 'B' }, { url: 'https://example.com', browser: 'B', extra: 1 },
    { url: 'javascript:alert(1)', browser: 'B' }, { url: 'file:///etc/passwd', browser: 'B' }, { url: 'ftp://example.com', browser: 'B' },
    { url: 'https://user:pass@example.com/', browser: 'B' }, { url: 'https://example.com/a b', browser: 'B' },
    { url: 'https://example.com/\nrm -rf ~', browser: 'B' }, { url: 'https://example.com/\t', browser: 'B' },
    { url: 'https://example.com/\u0007', browser: 'B' }, { url: 'https://example.com/ ', browser: 'B' }, { url: 'not a url', browser: 'B' },
    { url: `https://example.com/${'a'.repeat(2048)}`, browser: 'B' }, { url: 'https://example.com', browser: '' },
    { url: 'https://example.com', browser: 7 }, { url: 'https://example.com', browser: 'B'.repeat(129) },
    { url: 'https://example.com', browser: 'B\nC' }, { url: 7, browser: 'B' }, null, 'https://example.com',
    { url: 'https:example.com', browser: 'B' }, { url: 'https:\\\\example.com', browser: 'B' }, { url: 'https://example.com\\@evil.test/', browser: 'B' },
    { url: 'https:/example.com', browser: 'B' }, { url: 'https://example.com/\u200b', browser: 'B' }, { url: 'https://example.com/\u00a0', browser: 'B' },
    { url: 'https://example.com/\ufeff', browser: 'B' },
  ];
  for (const args of bad) assert.throws(() => parseEngineOpen(args), /^Error: browser_open: /, JSON.stringify(args));
});

test('the code is one acquisition and then Cmd+T, the URL as text, Return and a read, every value JSON-quoted', () => {
  assert.equal(acquisitionCode('sleightBrowser1', 'Some "Browser"'), 'let sleightBrowser1 = await cua.getApp("Some \\"Browser\\"");');
  assert.equal(openCode('sleightBrowser1', 'https://example.com/"x"', firefoxTree), 'await sleightBrowser1.pressKey("super+t");\n' +
    'await sleightBrowser1.typeText("https://example.com/\\"x\\"");\nawait sleightBrowser1.pressKey("Return");\nawait sleightBrowser1.getAXState();');
});

test('turboRoute sends turbo its own browser, by its value or app name, and every other browser to the engine path', () => {
  const turbo = { browser: 'bfixture', application: 'Fixture Browser' };
  assert.deepEqual(turboRoute({ url: 'https://e.test' }, turbo), { url: 'https://e.test' });
  assert.deepEqual(turboRoute({ url: 'https://e.test', browser: 'bfixture' }, turbo), { url: 'https://e.test', browser: 'bfixture' });
  assert.deepEqual(turboRoute({ url: 'https://e.test', browser: 'fixture browser' }, turbo), { url: 'https://e.test', browser: 'bfixture' });
  assert.equal(turboRoute({ url: 'https://e.test', browser: 'Other' }, turbo), undefined);
  assert.equal(turboRoute({ url: 'https://e.test', browser: 'bfixture' }, undefined), undefined);
  assert.deepEqual(turboRoute({ url: 'https://e.test', browser: 'Fixture Browser' }, { application: 'Fixture Browser' }), { url: 'https://e.test' });
});

test('the widened turbo tool keeps its url field and description, and takes any browser name', () => {
  const tool = { name: 'browser_open', description: 'Open an owned background tab.', inputSchema: { type: 'object',
    properties: { url: { type: 'string', maxLength: 65536 }, browser: { type: 'string', enum: ['bfixture'] } }, required: ['url'], additionalProperties: false } };
  const wide = widenTurboOpen(tool, 'bfixture');
  assert.ok(wide.description.startsWith('Open an owned background tab. '));
  assert.match(wide.description, /bfixture/);
  assert.deepEqual(wide.inputSchema.properties.url, tool.inputSchema.properties.url);
  assert.equal(wide.inputSchema.properties.browser.enum, undefined);
  assert.deepEqual(wide.inputSchema.required, ['url']);
  assert.deepEqual(tool.inputSchema.properties.browser.enum, ['bfixture'], 'the original is not changed');
  assert.equal(widenTurboOpen({ name: 'browser_read' }, 'bfixture').name, 'browser_read');
});

// Relay: a fake engine and client, the input lease on, the user's permissions as the launcher gives them.
const LINE = 'You blocked sleight in Blocked App (sleight-mcp permissions unblock com.example.blocked lifts it).';
const BROWSERS = new Set(['com.example.browser']);
function blocks(perms = { state: 'ok', apps: [{ id: 'com.example.blocked', name: 'Blocked App' }], sites: [] }) {
  return { app: query => appRefusal(perms, query), page: page => pageRefusal(perms, page), sitesLimited: () => sitesLimited(perms), noteApp() {} };
}
function harness(t, options = {}) {
  const [clientIn, clientOut, serverIn, serverOut] = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  const toServer = [], toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const directory = mkdtempSync(join(tmpdir(), 'sleight-engine-open-'));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's', permissions: blocks(),
    inputLease: new InputLease({ directory, holder: 'A' }), webBrowser: id => BROWSERS.has(id) ? true : id === 'com.example.pending' ? undefined : false,
    engineBrowserOpen: true, ownHostPid: () => false, ...options });
  t.after(() => { relay.close(); removeTemp(directory); });
  const call = (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return {
    toServer, toClient, call, relay,
    open: (id, args) => call(id, 'browser_open', args),
    list: id => { clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n'); },
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
    reply: id => toClient.find(m => m.id === id),
    engineCalls: () => toServer.filter(m => m.method === 'tools/call'),
  };
}
const tree = (id, app, appId, title, body = '\t1 tab group\n\t\t2 tab (selected) Start\n\t3 text field Address') => ({ jsonrpc: '2.0', id, result: {
  content: [{ type: 'text', text: `Window: ${JSON.stringify(title)}, App: ${app}.\n0 standard window ${title}\n${body}` }],
  _meta: { 'codex/toolSurface': { app: { appId } } } } });
const code = msg => msg.params.arguments.code;
const text = msg => msg.result.content.map(item => item.text ?? '').join('\n');
const firefoxSmoke = JSON.parse(readFileSync(new URL('./fixtures/browser-open-firefox-smoke.json', import.meta.url)));

async function listed(t, options) {
  const h = harness(t, options);
  h.list(1); await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js', description: 'Run JavaScript.', inputSchema: { type: 'object' } }] } });
  await settle();
  return h.reply(1).result.tools;
}

test('relay: the flag adds browser_open to the tool list; without it the list is unchanged', async t => {
  const on = await listed(t), off = await listed(t, { engineBrowserOpen: false });
  // Under the mod host the relay admits its private sleight_stats object (turn stats); the rest is the tool's own schema.
  const { sleight_stats: stats, ...properties } = on.find(tool => tool.name === 'browser_open').inputSchema.properties;
  if (stats !== undefined) assert.deepEqual(stats, { type: 'object' });
  assert.deepEqual({ ...on.find(tool => tool.name === 'browser_open').inputSchema, properties }, ENGINE_OPEN_TOOL.inputSchema);
  assert.equal(off.some(tool => tool.name === 'browser_open'), false);
  assert.deepEqual(on.filter(tool => tool.name !== 'browser_open').map(tool => tool.name === 'js' ? { ...tool, description: tool.description.replace(' For a web page in a named browser, call browser_open first; it returns the window.', '') } : tool), off);
  const lean = await listed(t, { prompt: 'lean' });
  assert.equal(lean.find(tool => tool.name === 'browser_open').description, LEAN_ENGINE_OPEN_DESCRIPTION);
  assert.equal(localToolDefinitions({ SLEIGHT_BROWSER_CORE: '1' }).some(tool => tool.name === 'browser_open'), false,
    'the relay owns the tool, not the local tool server');
});

test('relay: a browser opens in two engine calls, the acquisition then the tab keys, and Claude gets one result naming the handle', async t => {
  const h = harness(t);
  h.open(7, { url: 'https://example.com/a?b=1', browser: 'Example Browser' }); await settle();
  const [first] = h.engineCalls();
  assert.notEqual(first.id, 7, 'the acquisition is the relay\'s own call');
  assert.match(code(first), /let sleightBrowser\d+ = await cua\.getApp\("Example Browser"\)/);
  assert.equal(h.reply(7), undefined);
  h.fromServer(tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  const second = h.engineCalls().find(m => m.id === 7);
  assert.ok(second, 'the tab keys go out under Claude\'s call id');
  assert.equal(second.params.name, 'js');
  const handle = /let (sleightBrowser\d+)/.exec(code(first))[1];
  for (const part of [`${handle}.pressKey("super+t")`, `${handle}.typeText("https://example.com/a?b=1")`, `${handle}.pressKey("Return")`]) {
    assert.ok(code(second).includes(part), part);
  }
  assert.notEqual(code(second), openCode(handle, 'https://example.com/a?b=1', firefoxTree), 'the second call is wrapped by the guard like any js call');
  h.fromServer(tree(7, 'Example Browser', 'com.example.browser', 'Example Domain',
    '\t1 tab Start\n\t2 tab (selected) Example Domain\n\t3 HTML content URL: https://example.com/a?b=1\n\t\t4 link More')); await settle();
  const result = h.reply(7).result;
  assert.notEqual(result.isError, true);
  assert.match(text(h.reply(7)), new RegExp(`\`${handle}\``));
  assert.match(text(h.reply(7)), /Start Page/, 'the acquisition\'s tree comes first');
  assert.match(text(h.reply(7)), /4 link More/);
});

test('relay: an app that is not a web browser gets no keys or text, and pending browser lookups refuse too', async t => {
  for (const [appId, pattern] of [['com.example.terminal', /isn't a web browser/], ['com.example.pending', /doesn't know yet/], [undefined, /isn't a web browser/]]) {
    const h = harness(t);
    h.open(1, { url: 'https://example.com/', browser: 'Some App' }); await settle();
    const [first] = h.engineCalls();
    h.fromServer(tree(first.id, 'Some App', appId, 'Shell')); await settle();
    assert.equal(h.engineCalls().length, 1, `${appId}: nothing after the acquisition`);
    assert.equal(h.reply(1).result.isError, true);
    assert.match(text(h.reply(1)), pattern);
    assert.doesNotMatch(text(h.reply(1)), /sleightBrowser/);
  }
});

test('relay: a failed acquisition answers Claude with its error and sends nothing more', async t => {
  const h = harness(t);
  h.open(1, { url: 'https://example.com/', browser: 'Missing' }); await settle();
  const [first] = h.engineCalls();
  h.fromServer({ jsonrpc: '2.0', id: first.id, result: { isError: true, content: [{ type: 'text', text: 'App not found: Missing' }] } }); await settle();
  assert.equal(h.engineCalls().length, 1);
  assert.equal(h.reply(1).result.isError, true);
  assert.match(text(h.reply(1)), /App not found/);
});

test('AOd: the recorded invalid-app response puts the browser retry before the engine documentation', async t => {
  const h = harness(t);
  h.open(1, firefoxSmoke.request); await settle();
  h.fromServer({ jsonrpc: '2.0', id: h.engineCalls()[0].id, result: structuredClone(firefoxSmoke.invalidApp) }); await settle();
  const reply = h.reply(1);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /^browser_open: .*nothing was opened or typed/);
  assert.match(reply.result.content[0].text, /browser.*app name or bundle ID.*window title/);
  assert.match(reply.result.content[0].text, /Retry browser_open directly/);
  assert.deepEqual(reply.result.content.slice(1), firefoxSmoke.invalidApp.content.filter(item => item.text), 'retain engine errors and first-call instructions');
  assert.doesNotMatch(text(reply), /Complete the documented initialization/);
  assert.equal(h.engineCalls().length, 1, 'no guessed app, inventory or input');
  h.open(2, { ...firefoxSmoke.request, browser: 'Firefox' }); await settle();
  const acquired = tree(h.engineCalls().at(-1).id, 'Firefox', 'com.example.browser', 'Gate');
  acquired.result.content[0].text = firefoxSmoke.acquired;
  h.fromServer(acquired); await settle();
  const keys = h.engineCalls().at(-1);
  assert.equal(keys.id, 2, 'a corrected browser_open retries directly in the same session');
  assert.match(code(keys), /pressKey\("super\+t"\)/);
  const landed = tree(2, 'Firefox', 'com.example.browser', 'Tidewell Demo Shop');
  landed.result.content[0].text = firefoxSmoke.landed;
  h.fromServer(landed); await settle();
  assert.notEqual(h.reply(2).result.isError, true);
  assert.match(text(h.reply(2)), /Ember mug[\s\S]*red · \$16\.00/);
});

test('AOd: an app permission refusal keeps its error without a retry instruction', async t => {
  const h = harness(t);
  h.open(1, firefoxSmoke.request); await settle();
  const result = { isError: true, content: [{ type: 'text', text: 'Computer Use is not allowed to use this app for safety reasons.' }] };
  h.fromServer({ jsonrpc: '2.0', id: h.engineCalls()[0].id, result }); await settle();
  assert.deepEqual(h.reply(1).result, result);
  assert.equal(h.engineCalls().length, 1);
});

test('AOd: invalid-app advice requires the exact standalone target error', async t => {
  for (const error of ['Invalid app: Other', `Example error mentions Invalid app: ${firefoxSmoke.request.browser}`]) {
    const h = harness(t);
    h.open(1, firefoxSmoke.request); await settle();
    const result = { isError: true, content: [{ type: 'text', text: '## Computer Use\nReference.' }, { type: 'text', text: error }] };
    h.fromServer({ jsonrpc: '2.0', id: h.engineCalls()[0].id, result }); await settle();
    assert.doesNotMatch(text(h.reply(1)), /Retry browser_open directly/);
    assert.match(text(h.reply(1)), /Complete the documented initialization/);
    assert.equal(h.engineCalls().length, 1);
  }
});

test('relay: a bad URL, a blocked app, sleight\'s own host and a blocked site never reach the engine', async t => {
  const h = harness(t, { permissions: blocks({ state: 'ok', apps: [{ id: 'com.example.blocked', name: 'Blocked App' }], sites: ['https://bestbuy.com'] }) });
  h.open(1, { url: 'javascript:alert(1)', browser: 'Example Browser' });
  h.open(2, { url: 'https://example.com/', browser: 'Blocked App' });
  h.open(3, { url: 'https://example.com/', browser: 'consent-host' });
  h.open(4, { url: 'https://www.bestbuy.com/site/x', browser: 'Example Browser' });
  await settle();
  assert.deepEqual(h.engineCalls(), []);
  assert.match(text(h.reply(1)), /^browser_open: /);
  assert.equal(text(h.reply(2)), LINE);
  assert.equal(text(h.reply(3)), OWN_HOST_LINE);
  assert.match(text(h.reply(4)), /You blocked sleight on https:\/\/bestbuy\.com/);
  for (const id of [1, 2, 3, 4]) assert.equal(h.reply(id).result.isError, true);
});

test('relay: an allow-only list refuses a destination outside it before the engine', async t => {
  const h = harness(t, { permissions: blocks({ state: 'ok', apps: [], sites: [], only: ['https://allowed.example'] }) });
  h.open(1, { url: 'https://other.example/', browser: 'Example Browser' }); await settle();
  assert.deepEqual(h.engineCalls(), []);
  assert.match(text(h.reply(1)), /You allow sleight only on/);
});

test('relay: document scope refuses browser_open', async t => {
  const h = harness(t, { approvalScope: 'document', ask: async () => 'accept' });
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  assert.deepEqual(h.engineCalls(), []);
  assert.match(text(h.reply(1)), /document scope/);
});

test('relay: a flow rule stops the typed URL, and a flow exception lets the identical browser_open retry once', async t => {
  const h = harness(t, { flowRules: new FlowRules({ version: 1, rules: [{ id: 'private', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] }),
    ask: async () => 'accept' });
  const args = { url: 'https://example.com/?q=SECRET', browser: 'Example Browser' };
  h.open(1, args); await settle();
  const [first] = h.engineCalls();
  h.fromServer(tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  assert.equal(h.engineCalls().some(m => m.id === 1), false, 'the typed URL never reached the engine');
  assert.match(text(h.reply(1)), /private.*flow_exception/s);
  h.call(2, 'flow_exception', {}); await settle(); await settle();
  h.open(3, args); await settle();
  const again = h.engineCalls().at(-1);
  h.fromServer(tree(again.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  assert.ok(h.engineCalls().some(m => m.id === 3), 'the identical retry goes through once');
  h.fromServer(tree(3, 'Example Browser', 'com.example.browser', 'Example', '\t1 tab (selected) Example\n\t2 HTML content URL: https://example.com/?q=SECRET'));
  await settle();
  h.open(4, args); await settle();
  const third = h.engineCalls().at(-1);
  h.fromServer(tree(third.id, 'Example Browser', 'com.example.browser', 'Example')); await settle();
  assert.equal(h.engineCalls().some(m => m.id === 4), false, 'the exception was for one retry');
});

test('relay: Stop between the two calls ends browser_open without the tab keys', async t => {
  const h = harness(t, { stopEngine: async () => {} });
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  const [first] = h.engineCalls();
  h.call(2, 'turn_ended', { sleight_stop: true }); await settle();
  h.fromServer(tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  assert.equal(h.engineCalls().some(m => m.id === 1), false);
  assert.equal(h.toClient.filter(m => m.id === 1).length, 1, 'Claude\'s call is answered once');
});

// Turbo on: its own browser stays on turbo, any other browser takes the engine path.
async function v3Frontend(t, calls) {
  const child = new EventEmitter(), endpoint = new EventEmitter();
  child.connected = endpoint.connected = true;
  child.send = value => { queueMicrotask(() => endpoint.emit('message', structuredClone(value))); };
  endpoint.send = value => { queueMicrotask(() => child.emit('message', structuredClone(value))); };
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const session = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin() {
    return { call: async request => { calls.push(request); return { text: 'turbo result', isError: false }; }, delivered: () => true,
      async end() { return { revoked: true, cleanup: [] }; } };
  } });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker() { queueMicrotask(() => session.ready()); return child; } });
  t.after(() => bridge.detach());
  assert.equal(await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'turn1', text: 'open the page' }), true);
  return createV3Frontend(bridge);
}

test('relay with turbo: turbo keeps its browser, another browser goes to the engine path, and the list shows one widened tool', async t => {
  const calls = [];
  const directBrowser = await v3Frontend(t, calls);
  const h = harness(t, { directBrowser });
  h.list(1); await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js', description: 'Run JavaScript.', inputSchema: { type: 'object' } }] } });
  await settle();
  const opens = h.reply(1).result.tools.filter(tool => tool.name === 'browser_open');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].inputSchema.properties.browser.enum, undefined);
  h.open(2, { url: 'https://example.com/', browser: 'bfixture' }); await settle(); await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name ?? calls[0].request?.name, 'browser_open');
  assert.deepEqual(h.engineCalls(), []);
  h.open(3, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  assert.equal(calls.length, 1);
  assert.match(code(h.engineCalls()[0]), /cua\.getApp\("Example Browser"\)/);
});

test('relay: with the window helper, the tab keys wait for the lease admission on the window the acquisition showed', async t => {
  const asked = [];
  const h = harness(t, { changeReview: false, windowIdentity: async window => { asked.push(window);
    return { ...window, status: 'ok', matches: 1, epoch: 'helper', windowNumber: 4, pid: 123, processStart: 1 }; } });
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  const [first] = h.engineCalls();
  h.fromServer(tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  assert.ok(asked.some(window => window.appId === 'com.example.browser' && window.title === 'Start Page'), JSON.stringify(asked));
  assert.ok(h.engineCalls().some(m => m.id === 1), 'the keys go out after the admission');
});

test('relay: as the first call of a session, browser_open still delivers the skill rules with every pinned safety passage', async t => {
  const { skillRules } = await import('../plugins/sleight/lib/launch.mjs');
  const { readFileSync } = await import('node:fs');
  const safety = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url))).skillSafety;
  const h = harness(t, { firstCallRules: skillRules(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url)) });
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  const [first] = h.engineCalls();
  const reply = tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page');
  reply.result.content[0].text = '## Computer Use\nNative reference.\n' + reply.result.content[0].text;
  h.fromServer(reply); await settle();
  h.fromServer(tree(1, 'Example Browser', 'com.example.browser', 'Example', '\t1 tab (selected) Example\n\t2 HTML content URL: https://example.com/')); await settle();
  const all = text(h.reply(1));
  assert.match(all, /Top-level `await`, no `return`/);
  for (const passage of safety) assert.ok(all.includes(passage), passage);
});

test('relay: keys go only to a standard browser window with a tab strip and no sheet or dialog', async t => {
  for (const [label, title, body] of [
    ['no tab strip', 'General', '\t1 toolbar\n\t\t2 button General\n\t3 text field Homepage'],
    ['a sheet', 'Start Page', '\t1 tab group\n\t\t2 tab (selected) Start\n\t3 sheet Save changes?\n\t\t4 button Save'],
    ['a dialog', 'Start Page', '\t1 tab group\n\t\t2 tab (selected) Start\n\t3 dialog Allow notifications?'],
    ['a tab strip only inside the page', 'Docs', '\t1 HTML content URL: https://docs.test/\n\t\t2 tab group\n\t\t\t3 tab (selected) Intro'],
    ['no safe new-tab route', 'Start Page', '\t1 tab group\n\t\t2 HTML content Start'],
  ]) {
    const h = harness(t);
    h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
    const [first] = h.engineCalls();
    h.fromServer(tree(first.id, 'Example Browser', 'com.example.browser', title, body)); await settle();
    assert.equal(h.engineCalls().length, 1, label);
    assert.equal(h.reply(1).result.isError, true, label);
    assert.match(text(h.reply(1)), /browser_open: .*nothing was typed/, label);
  }
  const h = harness(t);
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  const [first] = h.engineCalls();
  const dialogRoot = tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page');
  dialogRoot.result.content[0].text = dialogRoot.result.content[0].text.replace('0 standard window', '0 dialog');
  h.fromServer(dialogRoot); await settle();
  assert.equal(h.engineCalls().length, 1, 'a dialog root');
});

test('relay: a stage-one failure uses up a flow exception, so only the identical retry that reaches the keys was allowed', async t => {
  const h = harness(t, { flowRules: new FlowRules({ version: 1, rules: [{ id: 'private', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] }),
    ask: async () => 'accept' });
  const args = { url: 'https://example.com/?q=SECRET', browser: 'Example Browser' };
  h.open(1, args); await settle();
  h.fromServer(tree(h.engineCalls()[0].id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  h.call(2, 'flow_exception', {}); await settle(); await settle();
  h.open(3, args); await settle();
  h.fromServer(tree(h.engineCalls().at(-1).id, 'Shell', 'com.example.terminal', 'Shell')); await settle();
  assert.match(text(h.reply(3)), /isn't a web browser/);
  h.open(4, args); await settle();
  h.fromServer(tree(h.engineCalls().at(-1).id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  assert.equal(h.engineCalls().some(m => m.id === 4), false);
  assert.match(text(h.reply(4)), /private.*flow_exception/s);
});

test('relay: an engine that ends during the acquisition answers Claude\'s call once', async t => {
  const h = harness(t);
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  assert.equal(h.engineCalls().length, 1);
  h.relay.engineEnded('Engine exited (25).'); await settle();
  assert.equal(h.toClient.filter(m => m.id === 1).length, 1);
  assert.equal(h.reply(1).result?.isError ?? !!h.reply(1).error, true);
  assert.equal(h.engineCalls().some(m => m.id === 1), false);
});

test('relay: browser_open waits for a pending tab cleanup like js does', async t => {
  const h = harness(t, { stopGraceMs: 50 });
  h.call(1, 'js', { code: 'let tab = await cua.createBrowserTab("chrome", "https://example.com/")' }); await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Browser tab: Example' }], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } } });
  await settle();
  h.call(2, 'turn_ended', {}); await settle();
  assert.ok(h.engineCalls().some(m => String(m.id).startsWith('sleight-tab-cleanup-')), 'the cleanup is pending');
  h.open(3, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  assert.match(text(h.reply(3)), /tab cleanup is pending/);
  assert.equal(h.engineCalls().some(m => String(m.id).startsWith('sleight-browser-open-')), false);
});

// End to end with the guard: the relay's injected code runs in a VM against a fake browser (tt1n-input-lease's fixture,
// trimmed). Cmd+T adds a selected tab and retitles the window, so the guard stops and the tab continuation types the rest.
const startTree = 'Window: "Marker", App: Fixture Browser.\n0 standard window Marker, Secondary Actions: Raise\n\t1 tab group\n' +
  '\t\t2 tab (selected) Value: Marker, Marker\nClose tab\n\t\t3 button Open a new tab\n\t4 combo box (settable) Address\n' +
  '\t5 HTML Content Description: Marker\n\t\t6 link Home\n\nThe focused UI element is 1 tab group';
const newTabTree = 'Window: "New Tab", App: Fixture Browser.\n0 standard window New Tab, Secondary Actions: Raise\n\t1 tab group\n' +
  '\t\t2 tab (selectable) Value: Marker, Marker\nClose tab\n\t\t3 tab (selected) Value: New Tab, New Tab\nClose tab\n\t\t4 button Open a new tab\n' +
  '\t5 combo box (settable) Address\n\t6 HTML Content Description: New Tab\n\t\t7 link Shortcuts\n\nThe focused UI element is 5 combo box (settable) Address';
const shopTree = newTabTree.replaceAll('New Tab', 'Shop').replace(/The focused UI element is .*/, 'The focused UI element is 7 link Shortcuts');
async function guarded(t, options = {}) {
  const { trees = { acquired: startTree, opened: newTabTree, landed: shopTree }, ...relayOptions } = options;
  let text = trees.acquired, writes = [];
  const keys = [], typed = [], sent = [], received = [];
  const app = { getAXState: async () => text, getAXStateAndScreenshot: async () => ({ state: text }), click: async () => {},
    pressKey: async key => { keys.push(key); text = key === 'super+t' ? trees.opened : key === 'Return' ? trees.landed : text; },
    setValue: async () => {}, typeText: async value => { typed.push(value); } };
  const context = createContext({ cua: { getApp: async () => app, listApps: async () => [{ id: 'com.example.browser', windows: [{ title: 'Marker' }] }] },
    nodeRepl: { write: value => writes.push(String(value)) } });
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const directory = mkdtempSync(join(tmpdir(), 'sleight-engine-open-vm-'));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: new InputLease({ directory, holder: 'engine open' }),
    changeReview: false, engineBrowserOpen: true, webBrowser: id => id === 'com.example.browser', ownHostPid: () => false,
    runningProbe: () => ({ status: 'responding' }),
    windowIdentity: async expected => ({ ...expected, windowNumber: 22, hidIdleSeconds: 1000, status: 'ok', matches: 1, epoch: 'helper', window: 1, pid: 123,
      processStart: 1, focus: { sheets: 0, role: 'AXComboBox', subrole: null, inWindow: true, inPage: false } }), ...relayOptions });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); removeTemp(directory); });
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let cursor = 0;
  const call = async (id, name, args) => {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    for (let i = 0; i < 200; i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
      while (cursor < sent.length) {
        const request = sent[cursor++]; writes = [];
        if (request.method !== 'tools/call') continue;
        // The engine's REPL keeps a top-level let across calls; the VM wrapper would scope it to the call.
        const code = request.params.arguments.code.replace(/\blet (sleightBrowser\d+) =/g, 'globalThis.$1 =');
        let error;
        try { await runInContext(`(async () => { ${code} })()`, context, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (e) { error = e; }
        if (/cua\.getApp\(/.test(code) && !error) writes.push(text);
        if (error) writes.push(String(error));
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: !!error, content: [{ type: 'text', text: writes.join('\n') }],
          _meta: { 'codex/toolSurface': { app: { appId: 'com.example.browser' } } } } }) + '\n');
      }
      const reply = received.find(msg => msg.id === id);
      if (reply) return reply.result;
    }
    throw new Error('no client result');
  };
  return { keys, typed, sent, call };
}

test('guard: browser_open as the first call opens the tab and types the URL in the same model turn', async t => {
  const h = await guarded(t);
  const result = await h.call(1, 'browser_open', { url: 'http://127.0.0.1:5420/shop', browser: 'Fixture Browser' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.keys, ['super+t', 'Return']);
  assert.deepEqual(h.typed, ['http://127.0.0.1:5420/shop']);
  assert.match(result.content.map(item => item.text).join('\n'), /^Window: "Shop"/m);
});

test('AOd: recorded Firefox trees open through the keyboard continuation in one model call', async t => {
  const h = await guarded(t, { trees: firefoxSmoke });
  const result = await h.call(1, 'browser_open', { ...firefoxSmoke.request, browser: 'Firefox' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.keys, ['super+t', 'Return']);
  assert.deepEqual(h.typed, [firefoxSmoke.request.url]);
  assert.match(result.content.map(item => item.text).join('\n'), /Ember mug[\s\S]*red · \$16\.00/);
  assert.equal(h.sent.filter(msg => msg.method === 'tools/call').length, 3, 'acquisition, new tab stop, guarded URL continuation');
  const manual = 'await ff.pressKey("super+t"); await ff.typeText("https://example.com/"); await ff.pressKey("Return"); await new Promise(r => setTimeout(r, 2000)); await ff.getAXState()';
  assert.equal(splitMenuActions(manual), undefined, 'the recorded sleep prevents admission of the manual batch');
  assert.ok(splitMenuActions(openCode('ff', firefoxSmoke.request.url, firefoxSmoke.acquired)));
});

test('guard: a flow exception covers the identical browser_open through the tab continuation', async t => {
  const h = await guarded(t, { flowRules: new FlowRules({ version: 1, rules: [{ id: 'private', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] }),
    ask: async () => 'accept' });
  const args = { url: 'http://127.0.0.1:5420/shop?q=SECRET', browser: 'Fixture Browser' };
  const refused = await h.call(1, 'browser_open', args);
  assert.match(refused.content.map(item => item.text).join('\n'), /private.*flow_exception/s);
  assert.deepEqual(h.keys, []);
  await h.call(2, 'flow_exception', {});
  const result = await h.call(3, 'browser_open', args);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.typed, ['http://127.0.0.1:5420/shop?q=SECRET']);
  assert.deepEqual(h.keys, ['super+t', 'Return']);
});


test('AO2/AOc: recorded re-reads retain keyboard and content-first toolbar routes', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/browser-open-rereads.json', import.meta.url)));
  assert.equal(fixtures.length, 5);
  for (const fixture of fixtures) {
    if (fixture.source.includes('safari')) {
      assert.equal(browserWindowProblem(fixture.tree, 'Browser'), undefined, fixture.source);
      assert.match(openCode('h', 'https://example.com/', fixture.tree), /NewTabButton/, fixture.source);
    } else {
      assert.equal(browserWindowProblem(fixture.tree, 'Browser'), undefined, fixture.source);
      assert.match(openCode('h', 'https://example.com/', fixture.tree), /super\+t/, fixture.source);
    }
  }
});

const realTrees = JSON.parse(readFileSync(new URL('./fixtures/browser-open-real-trees.json', import.meta.url)));
const realSafari = realTrees.find(fixture => fixture.source.startsWith('safari')).tree;
const realFirefox = realTrees.find(fixture => fixture.source.startsWith('firefox')).tree;
// Reorder whole fixture subtrees, retaining their raw value continuations and contiguous engine numbering.
function moveTreeEntries(tree, first, last, before) {
  const lines = tree.split('\n');
  const at = number => lines.findIndex(line => new RegExp(`^\\t*${number} `).test(line));
  const block = lines.splice(at(first), at(last + 1) - at(first));
  lines.splice(at(before), 0, ...block);
  let number = 0;
  return lines.join('\n').replace(/^(\t*)\d+ /gm, (_, depth) => `${depth}${number++} `);
}

test('AOc: real Safari toolbar controls work in either subtree and control order', () => {
  const addressLast = moveTreeEntries(realSafari, 14, 18, 21);
  for (const tree of [realSafari, addressLast, moveTreeEntries(realSafari, 8, 21, 1), moveTreeEntries(addressLast, 8, 21, 1)]) {
    assert.equal(browserWindowProblem(tree, 'Browser'), undefined);
    const code = openCode('h', 'https://example.com/', tree);
    assert.match(code, /h\.click\(\{ id: "NewTabButton" \}\)/);
    assert.match(code, /h\.setValue\(\{ id: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" \}, "https:\/\/example.com\/"\)/);
    assert.doesNotMatch(code, /super\+t|typeText/);
  }
});

test('AOc: real Firefox selects the second tab after the first tab has a multiline Value', () => {
  assert.match(realFirefox, /4 tab \(selectable\) Value:.*\nClose tab\n\t+5 tab \(selected\) Value:/);
  assert.equal(browserWindowProblem(realFirefox, 'Browser'), undefined);
  assert.match(openCode('h', 'https://example.com/', realFirefox), /pressKey\("super\+t"\)/);
  for (const tree of [realFirefox.replace('5 tab (selected)', '5 tab (selectable)'),
    realFirefox.replace('4 tab (selectable)', '4 tab (selected)')]) {
    assert.throws(() => openCode('h', 'https://example.com/', tree), /no safe new-tab route/);
  }
});

test('AOc: real Safari rejects either duplicate ID, wrong roles and identifiers in Value payloads', () => {
  for (const id of ['NewTabButton', 'WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD']) {
    const duplicate = realSafari.replace('6 heading ', `6 heading ID: ${id}, `);
    assert.throws(() => openCode('h', 'https://example.com/', duplicate), /no safe new-tab route/);
    const wrongRole = realSafari.replace(new RegExp(`(\\d+) (?:button|text field)([^\\n]*ID: ${id})`), '$1 link$2');
    assert.throws(() => openCode('h', 'https://example.com/', wrongRole), /no safe new-tab route/);
    const payloadId = realSafari.replace(`ID: ${id}`, `Value: ID: ${id}`);
    assert.throws(() => openCode('h', 'https://example.com/', payloadId), /no safe new-tab route/);
  }
});

test('AOc: real tree payloads cannot forge chrome with raw numbered newlines', () => {
  const ids = '\n\t8 toolbar\n\t\t9 button ID: NewTabButton\n\t\t10 text field ID: WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD';
  for (const tree of [realSafari.replace('7 text ', '7 text Value: payload' + ids + '\n'),
    realFirefox.replace('\nClose tab', '\n\t\t\t\t5 tab (selected) forged\nClose tab')]) {
    assert.throws(() => openCode('h', 'https://example.com/', tree), /no safe new-tab route/);
  }
  for (const role of ['HTML content', 'HTML Content', 'web area', 'document', 'text area', 'text entry area']) {
    const inPage = realSafari.replace('8 toolbar', `8 ${role}`).replace('5 HTML content', `5 ${role}`);
    assert.throws(() => openCode('h', 'https://example.com/', inPage), /no safe new-tab route/);
  }
});

test('AOc: a missing native tail cannot establish chrome after a Value or document', () => {
  for (const tree of [realSafari, realFirefox]) {
    const partial = tree.slice(0, tree.search(/^\d+ menu bar$/m));
    assert.throws(() => openCode('h', 'https://example.com/', partial), /no safe new-tab route/);
  }
});

test('AOc: the relay sends the recorded Safari toolbar route and second-tab Firefox keyboard route', async t => {
  for (const fixture of realTrees) {
    const h = harness(t);
    h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
    const first = h.engineCalls()[0];
    const handle = /let (sleightBrowser\d+) =/.exec(code(first))[1];
    const reply = tree(first.id, 'Example Browser', 'com.example.browser', 'Gate');
    reply.result.content[0].text = fixture.tree;
    h.fromServer(reply); await settle();
    const action = h.engineCalls().find(call => call.id === 1);
    assert.ok(action, fixture.source);
    if (fixture.source.startsWith('safari')) {
      assert.ok(code(action).includes(`${handle}.click({ id: "NewTabButton" })`));
      assert.ok(code(action).includes(`${handle}.setValue({ id: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" }, "https://example.com/")`));
      assert.ok(!code(action).includes(`${handle}.pressKey("super+t")`));
    } else {
      assert.ok(code(action).includes(`${handle}.pressKey("super+t")`));
      assert.ok(code(action).includes(`${handle}.typeText("https://example.com/")`));
      assert.ok(!code(action).includes(`${handle}.setValue(`));
    }
  }
});

test('AO1/AO2: the relay passes the full acquisition to its toolbar route before typing', async t => {
  const h = harness(t);
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  const first = h.engineCalls()[0];
  const reply = tree(first.id, 'Example Browser', 'com.example.browser', 'Gate');
  reply.result.content[0].text = safariTree + '\n' + safariTree.split('\n')[0] + '\n0 standard window Gate\nsleight: no change since the last full tree you saw for this window.';
  h.fromServer(reply); await settle();
  const action = h.engineCalls().find(call => call.id === 1);
  assert.ok(action);
  assert.match(code(action), /NewTabButton/);
  assert.doesNotMatch(code(action), /super\+t/);
});
