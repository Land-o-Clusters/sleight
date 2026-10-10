import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';

function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-browser-test-'));
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  for (const [stream, out] of [[serverIn, sent], [clientOut, received]]) stream.on('data', d => d.toString().trim().split('\n').forEach(l => out.push(JSON.parse(l))));
  const lease = new InputLease({ directory });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: lease, ...options });
  t.after(() => { relay.close(); rmSync(directory, { recursive: true, force: true }); });
  return { relay, sent, received, lease,
    call: (id, code, name = 'js') => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n'),
    reply: (id, result = { content: [], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } }) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'),
    engine: msg => serverOut.write(JSON.stringify(msg) + '\n') };
}

test('browser inventory, acquisition and DOM actions carry native guards without a native target', t => {
  const h = harness(t);
  for (const [id, code] of [[1, 'await cua.listBrowsers()'], [2, 'let tab = await cua.createBrowserTab("instance-1", "https://example.com")'],
    [3, 'await tab.playwright.getByRole("link", { name: "Learn more" }).click()'], [4, 'await tab.getAXState()'], [5, 'await tab.close()']]) {
    h.call(id, code);
    assert.equal(h.sent.at(-1)?.id, id, JSON.stringify(h.received));
    assert.ok(h.sent.at(-1).params.arguments.code.includes(code));
    assert.match(h.sent.at(-1).params.arguments.code, /Native access stopped/);
    h.reply(id);
  }
  assert.equal(h.lease.owned.size, 0);
  h.call(6, 'await app.typeText("native")');
  assert.equal(h.received.at(-1).result.isError, true, 'browser discovery never approves a native target');
});

test('browser approvals reach the dialog and are never remembered or preapproved', async t => {
  const prompts = [];
  const h = harness(t, { ask: async message => { prompts.push(message); return 'decline'; } });
  for (let i = 1; i <= 2; i++) {
    h.engine({ jsonrpc: '2.0', id: `approval-${i}`, method: 'elicitation/create', params: { message: 'Allow browser origin?',
      _meta: { connector_id: 'browser-use', persist: ['session'], tool_params: { app: 'Chrome' } } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.sent.at(-1)?.result?.action, 'decline');
  }
  assert.equal(prompts.length, 2);
});

test('ending a browser turn forwards the same session and turn coordinates', t => {
  const h = harness(t);
  h.call(1, 'let tab = await cua.createBrowserTab("instance-1", "https://example.com")'); h.reply(1);
  const metadata = JSON.parse(h.sent.at(-1)?.params._meta?.['x-codex-turn-metadata'] ?? '{}');
  h.call(2, undefined, 'turn_ended');
  assert.equal(h.sent.at(-1).params.arguments.session_id, metadata.session_id);
  assert.equal(h.sent.at(-1).params.arguments.turn_id, metadata.turn_id);
});

test('flow rules attribute browser literals and DOM fill to browser instead of a stale native app', () => {
  const flow = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['browser'], except: ['TextEdit'] }] });
  const plan = flow.analyze('js', { code: 'let tab = await cua.createBrowserTab("instance-1", "https://example.com")' }, { app: 'TextEdit' }); flow.forward(plan);
  for (const code of ['await tab.playwright.getByRole("textbox").fill("SECRET")', 'await tab.typeText(null, "SECRET")', 'await tab.goto("https://example.com/?SECRET")', 'let other = await cua.createBrowserTab("instance-2", "https://example.com/?SECRET")']) {
    assert.deepEqual(flow.analyze('js', { code }, { app: 'TextEdit' }).violations.map(v => v.rule), ['secret']);
  }
});

test('browser tab inventory remains usable after ending a turn', t => {
  const h = harness(t);
  h.call(1, 'let browser = await cua.getBrowser({extensionInstanceId: "instance-1"})'); h.reply(1);
  h.call(2, undefined, 'turn_ended'); h.reply(2);
  h.call(3, 'nodeRepl.write(await browser.tabs.list())');
  assert.equal(h.sent.at(-1)?.id, 3, JSON.stringify(h.received));
});

test('reassigning a browser handle to a native app restores native leasing', t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getBrowser({extensionInstanceId: "instance-1"})'); h.reply(1);
  h.call(2, 'app = await cua.getApp("TextEdit")');
  h.reply(2, { content: [{ type: 'text', text: 'Window: "Untitled", App: TextEdit' }], _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } });
  h.call(3, 'await app.typeText("native")');
  assert.equal(h.lease.owned.size, 1);
});

test('browser approvals accepted by a person prompt again without granting persistence', async t => {
  const prompts = [];
  const h = harness(t, { ask: async message => { prompts.push(message); return 'accept'; } });
  for (let id = 1; id <= 2; id++) {
    h.engine({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message: 'Allow browser origin?', _meta: { connector_id: 'browser-use', persist: ['session', 'always'], tool_params: { app: 'Chrome' } } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.sent.at(-1).result, { action: 'accept', content: {} });
  }
  assert.equal(prompts.length, 2);
});

test('browser source values stop literal transfers to native apps and keyboard typing stays checked', () => {
  const flow = new FlowRules({ version: 1, rules: [
    { id: 'browser-source', kind: 'source', sources: ['browser'], destinations: ['Mail'] },
    { id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['browser'] },
  ] });
  const plan = flow.analyze('js', { code: 'let tab = await cua.getTab("1", {browser: "instance-1"})' });
  flow.forward(plan); flow.observe({ content: [{ type: 'text', text: 'PRIVATE VALUE' }] }, plan);
  assert.equal(flow.analyze('js', { code: 'let mail = await cua.getApp("Mail"); await mail.typeText("PRIVATE VALUE")' }).violations[0].rule, 'browser-source');
  assert.equal(flow.analyze('js', { code: 'await tab.playwright.getByRole("textbox").pressSequentially("SECRET")' }).violations[0].rule, 'secret');
});

test('a browser handle mentioned in native input does not change its destination', () => {
  const flow = new FlowRules({ version: 1, rules: [{ id: 'mail-secret', kind: 'pattern', pattern: 'SECRET', destinations: ['Mail'] }] });
  flow.forward(flow.analyze('js', { code: 'let tab = await cua.getTab("1")' }));
  flow.forward(flow.analyze('js', { code: 'let mail = await cua.getApp("Mail")' }));
  assert.equal(flow.analyze('js', { code: 'await mail.typeText(tab.id + "SECRET")' }).violations[0].rule, 'mail-secret');
});

test('browser rereads preserve source attribution and capture actual AX text values', () => {
  const flow = new FlowRules({ version: 1, rules: [{ id: 'browser-mail', kind: 'source', sources: ['browser'], destinations: ['Mail'] }] });
  flow.forward(flow.analyze('js', { code: 'let tab = await cua.getTab("1")' }));
  for (const code of ['await tab.getAXState()', 'await tab.playwright.domSnapshot()']) {
    const plan = flow.analyze('js', { code }, { app: 'TextEdit' });
    flow.forward(plan);
    flow.observe({ content: [{ type: 'text', text: 'Browser tab: 1, Title: "Test", URL: "https://example.com".\n0 AXWebArea Test\n\t1 text PRIVATE VALUE\n\t2 text entry Value: secret@example.org' }] }, plan);
  }
  for (const value of ['PRIVATE VALUE', 'secret@example.org']) {
    const plan = flow.analyze('js', { code: `let mail = await cua.getApp("Mail"); await mail.typeText(${JSON.stringify(value)})` });
    assert.equal(plan.violations[0]?.rule, 'browser-mail');
  }
});

test('browser DOM snapshots capture readable values without their role markup', () => {
  const flow = new FlowRules({ version: 1, rules: [{ id: 'browser-mail', kind: 'source', sources: ['browser'], destinations: ['Mail'] }] });
  flow.forward(flow.analyze('js', { code: 'let tab = await cua.getTab("1")' }));
  const plan = flow.analyze('js', { code: 'nodeRepl.write(await tab.playwright.domSnapshot())' }); flow.forward(plan);
  flow.observe({ content: [{ type: 'text', text: '- paragraph: PRIVATE VALUE\n- textbox "Email": secret@example.org\n- link "Private link":\n  - /url: https://example.com/private' }] }, plan);
  for (const value of ['PRIVATE VALUE', 'secret@example.org', 'Private link']) {
    assert.equal(flow.analyze('js', { code: `let mail = await cua.getApp("Mail"); await mail.typeText(${JSON.stringify(value)})` }).violations[0]?.rule, 'browser-mail');
  }
});

test('stored DOM locators remain browser handles within and across calls', t => {
  const h = harness(t);
  h.call(1, 'let tab = await cua.getTab("1")'); h.reply(1);
  h.call(2, 'let link = tab.playwright.getByRole("link"); await link.click()');
  assert.equal(h.sent.at(-1)?.id, 2, JSON.stringify(h.received)); h.reply(2);
  h.call(3, 'await link.click()'); assert.equal(h.sent.at(-1)?.id, 3, JSON.stringify(h.received));
});

test('stored DOM locators keep browser flow destinations within and across calls', () => {
  const flow = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['browser'], except: ['TextEdit'] }] });
  flow.forward(flow.analyze('js', { code: 'let tab = await cua.getTab("1")' }));
  const plan = flow.analyze('js', { code: 'let field = tab.playwright.getByRole("textbox"); await field.fill("SECRET")' }, { app: 'TextEdit' });
  assert.equal(plan.violations[0]?.rule, 'secret');
  flow.forward(plan);
  assert.equal(flow.analyze('js', { code: 'await field.fill("SECRET")' }, { app: 'TextEdit' }).violations[0]?.rule, 'secret');
});

test('a site rule refuses browser input before the relay sends it to the engine', async t => {
  const flow = new FlowRules({ version: 1, rules: [{ id: 'private-site', kind: 'pattern', pattern: 'SECRET', destinations: ['site:example.com'] }] });
  const h = harness(t, { flowRules: flow });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  h.call(1, 'let tab = await cua.getTab("1")'); await tick();
  h.reply(1, { content: [{ type: 'text', text: 'Browser tab: 1, Title: "Test", URL: "https://example.com".\n0 AXWebArea Test' }],
    _meta: { 'codex/toolSurface': { kind: 'browserUse' } } }); await tick();
  h.call(2, 'await tab.playwright.getByRole("textbox").fill("SECRET")'); await tick();
  assert.equal(h.sent.some(m => m.id === 2), false);
  assert.equal(h.received.find(m => m.id === 2)?.result.isError, true);
  assert.match(h.received.find(m => m.id === 2)?.result.content[0].text, /private-site/);
  h.call(3, 'await tab.playwright.getByRole("textbox").fill("public value")'); await tick();
  assert.equal(h.sent.some(m => m.id === 3), true);
});
