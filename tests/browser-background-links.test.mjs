import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { backgroundLinksCode, inspectBackgroundLink } from '../plugins/sleight/lib/browser-background-links.mjs';

function fixture(candidate = { url: 'https://example.test/next' }, element) {
  const calls = [], notes = [];
  const strict = value => new Proxy(value, { get(target, key) {
    if (key === 'then' || typeof key === 'symbol') return target[key];
    if (!(key in target)) throw new Error(`unsupported engine API ${String(key)}`);
    return target[key];
  } });
  const locator = strict({ evaluate: async inspect => element ? inspect(element) : candidate, click: async () => calls.push('click'),
    first() { return this; }, count: async () => 1 });
  const child = strict({ id: '2', goto: async url => { calls.push(['goto', url]); } });
  const tab = strict({ id: '1', playwright: strict({ locator: () => locator, getByRole: () => locator }),
    click: async () => calls.push('tab.click'), getAXState: async () => '1 link Next, ID: next' });
  const browser = strict({ browserId: 'b', tabs: strict({ new: async () => { calls.push('new'); return child; }, get: async () => tab }) });
  const cua = { getBrowser: async () => browser, getTab: async () => tab, createBrowserTab: async () => tab };
  const context = createContext({ cua, URL, URLSearchParams, nodeRepl: { write: note => notes.push(note) } });
  const run = code => runInContext(`(async () => { ${backgroundLinksCode(code)} })()`, context);
  return { run, calls, notes, child, browser, tab };
}

test('a locator click creates and navigates one owned tab, reporting its id', async () => {
  const f = fixture();
  await f.run('var b = await cua.getBrowser({id:"b"}); var t = await b.tabs.get("1"); await t.playwright.locator("a").first().click();');
  assert.deepEqual(f.calls, ['new', ['goto', 'https://example.test/next']]);
  assert.match(f.notes.join('\n'), /tab 2/);
});

for (const source of ['await cua.getTab("1", {browser:"b"})', 'await cua.createBrowserTab("b", "https://example.test")']) {
  test(`redirect survives ${source}`, async () => {
    const f = fixture(); await f.run(`var t = ${source}; await t.playwright.getByRole("link").click();`);
    assert.equal(f.calls[0], 'new');
  });
}

for (const candidate of [null, { fallback: 'window.opener is required' }, { fallback: 'form submission needs the original click' }]) {
  test(`fallback preserves the original click: ${JSON.stringify(candidate)}`, async () => {
    const f = fixture(candidate); await f.run('var t = await cua.getTab("1", {browser:"b"}); await t.playwright.locator("a").click();');
    assert.deepEqual(f.calls, ['click']);
    if (candidate) assert.match(f.notes.join('\n'), /original click/);
  });
}

test('modified or secondary clicks retain the engine action', async () => {
  for (const options of ['{button:"right"}', '{modifiers:["Control"]}']) {
    const f = fixture(); await f.run(`var t = await cua.getTab("1", {browser:"b"}); await t.playwright.locator("a").click(${options});`);
    assert.deepEqual(f.calls, ['click']);
  }
});

test('navigation refusal propagates without repeating the original click', async () => {
  const f = fixture(); f.child.goto = async () => { throw new Error('navigation policy refused'); };
  await assert.rejects(f.run('var t = await cua.getTab("1", {browser:"b"}); await t.playwright.locator("a").click();'), /navigation policy refused/);
  assert.deepEqual(f.calls, ['new']);
});

function anchor(attributes = {}) {
  const link = { tagName: 'A', href: 'https://example.test/next', target: '_blank', rel: '',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
    closest() { return this; }, hasAttribute: name => name in attributes,
    getAttribute: name => attributes[name] ?? null, ...attributes };
  link.ownerDocument = { querySelector: () => null, elementFromPoint: () => link,
    defaultView: { getComputedStyle: () => ({ visibility: 'visible', pointerEvents: 'auto' }) } };
  link.contains = element => element === link;
  return link;
}

function readonlyForm(formAttributes = {}, buttonAttributes = {}) {
  const link = anchor();
  const form = { target: '_blank', method: 'get', action: 'https://example.test/search', rel: '',
    getAttribute: name => formAttributes[name] ?? null, elements: [], ownerDocument: link.ownerDocument };
  const button = { tagName: 'BUTTON', type: 'submit', name: 'go', value: 'Search', form,
    matches: () => false, getAttribute: name => buttonAttributes[name] ?? null,
    getBoundingClientRect: link.getBoundingClientRect, contains: element => element === button,
    closest: selector => selector === 'button,input' ? button : null };
  form.elements.push(button);
  link.ownerDocument.elementFromPoint = () => button;
  return button;
}

for (const handler of ['event.preventDefault()', '']) {
  for (const kind of ['link click', 'submitter click', 'form submit']) {
    test(`read-only ${kind} handler attribute ${JSON.stringify(handler)} retains the injected original click`, async () => {
      let element;
      if (kind === 'link click') {
        element = anchor();
        element.getAttribute = name => name === 'onclick' ? handler : null;
      } else element = readonlyForm(kind === 'form submit' ? { onsubmit: handler } : {},
        kind === 'submitter click' ? { onclick: handler } : {});
      assert.equal('onclick' in element, false);
      if (element.form) assert.equal('onsubmit' in element.form, false);
      assert.match(inspectBackgroundLink(element)?.fallback ?? '', /handler|original click/);
      const f = fixture(null, element);
      await f.run('var t = await cua.getTab("1", {browser:"b"}); await t.playwright.locator("fixture").click();');
      assert.deepEqual(f.calls, ['click']);
      assert.match(f.notes.join('\n'), /original click retained/);
    });
  }
}

test('a read-only form with a non-UTF-8 charset retains its original click', async () => {
  const element = readonlyForm({ 'accept-charset': 'iso-8859-1' });
  assert.equal('acceptCharset' in element.form, false);
  assert.match(inspectBackgroundLink(element)?.fallback ?? '', /submission/);
  const f = fixture(null, element);
  await f.run('var t = await cua.getTab("1", {browser:"b"}); await t.playwright.locator("fixture").click();');
  assert.deepEqual(f.calls, ['click']);
});

test('a read-only UTF-8 form without inline handlers still creates the child tab', async () => {
  const element = readonlyForm({ 'accept-charset': 'UTF-8' });
  assert.equal(inspectBackgroundLink(element).url, 'https://example.test/search?go=Search');
  const f = fixture(null, element);
  await f.run('var t = await cua.getTab("1", {browser:"b"}); await t.playwright.locator("fixture").click();');
  assert.deepEqual(f.calls, ['new', ['goto', 'https://example.test/search?go=Search']]);
});

test('read-only inspection excludes downloads, same-context links and non-http URLs', () => {
  for (const element of [anchor({download:''}), anchor({target:'_self'}), anchor({href:'javascript:run()'}), anchor({target:''})]) {
    assert.equal(inspectBackgroundLink(element), null);
  }
  assert.equal(inspectBackgroundLink(anchor()).url, 'https://example.test/next');
});

test('explicit opener and named targets preserve opener semantics', () => {
  for (const element of [anchor({rel:'opener'}), anchor({target:'report'})]) {
    assert.match(inspectBackgroundLink(element).fallback, /opener/);
  }
  assert.equal(inspectBackgroundLink(anchor({target:'report',rel:'noopener'})).url, 'https://example.test/next');
});

test('an indexed click resolves a unique ID through a fresh tree', async () => {
  const f = fixture(); await f.run('var t = await cua.getTab("1", {browser:"b"}); await t.click(1);');
  assert.equal(f.calls[0], 'new');
});

test('unknown browser identity keeps the click and explains the focus risk', async () => {
  const f = fixture(); await f.run('var t = await cua.getTab("1"); await t.playwright.locator("a").click();');
  assert.deepEqual(f.calls, ['click']);
  assert.match(f.notes.join('\n'), /browser identity is unknown/);
});

test('new-context form clicks preserve submission behavior with a notice', () => {
  const form = { target: '_blank' };
  const button = { closest: selector => selector === 'button,input' ? { form } : null };
  assert.match(inspectBackgroundLink(button).fallback, /fields, validation and submit handlers/);
});

test('real page redirects a blank-target link and retains a script popup', {
  skip: process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'live browser test is reserved for sleight-arch',
}, async t => {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { chromium } = await import(pathToFileURL(join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs')).href);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('https://fixture.test/**', route => route.fulfill({ body: '<p>destination</p>', contentType: 'text/html' }));
  const page = await context.newPage();
  await page.setContent('<a id="next" target="_blank" href="https://fixture.test/next">Next</a><button onclick="window.open(\'https://fixture.test/script\')">Script</button>');
  const tab = { id: '1', playwright: page };
  const engineBrowser = { browserId: 'b', tabs: { get: async () => tab, new: async () => {
    const child = await context.newPage();
    return { id: String(context.pages().length), goto: url => child.goto(url) };
  } } };
  const cua = { getBrowser: async () => engineBrowser };
  const vm = createContext({ cua, nodeRepl: { write() {} } });
  await runInContext(`(async () => { ${backgroundLinksCode('var b = await cua.getBrowser({id:"b"}); var tab = await b.tabs.get("1"); await tab.playwright.locator("#next").click();')} })()`, vm);
  assert.equal(context.pages().length, 2);
  assert.equal(context.pages()[1].url(), 'https://fixture.test/next');
  assert.equal(await context.pages()[1].evaluate(() => window.opener), null);
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Script' }).click();
  const child = await popup;
  await child.waitForLoadState();
  assert.equal(context.pages().length, 3);
  assert.equal(await child.evaluate(() => window.opener !== null), true);
});


test('relay collects a redirected tab at turn end without adding cleanup to inventory reads', async () => {
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const sent = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  const call = (id, name, args) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  const answer = (id, text = '') => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }] } }) + '\n');
  try {
    call(1, 'js', { code: 'var tab = await cua.getTab("1", {browser:"b"}); await tab.playwright.locator("a").click()' });
    assert.match(sent.at(-1).params.arguments.code, /__sleightBackgroundLinks/);
    assert.match(sent.at(-1).params.arguments.code, /__sleightTabs/);
    answer(1, 'sleight: new tab 2 created for this link.');
    call(2, 'turn_ended', {});
    assert.match(String(sent.at(-1).id), /^sleight-tab-cleanup-/);
    answer(sent.at(-1).id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.at(-1).params.name, 'turn_ended');
    answer(sent.at(-1).id);
  } finally { relay.dispose(); }
});

test('a covered or hidden link keeps the engine actionability checks', () => {
  const link = anchor();
  link.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  assert.match(inspectBackgroundLink(link).fallback, /actionability/);
});

test('GET form links retain successful fields and the clicked submitter', () => {
  const link = anchor();
  const form = { target: '_blank', method: 'get', action: 'https://example.test/search?old=1', rel: '',
    getAttribute: () => null, ownerDocument: link.ownerDocument, elements: [
      { tagName: 'INPUT', type: 'text', name: 'q', value: 'blue sky', matches: () => false },
      { tagName: 'INPUT', type: 'checkbox', name: 'on', value: 'yes', checked: true, matches: () => false },
      { tagName: 'INPUT', type: 'checkbox', name: 'off', value: 'no', checked: false, matches: () => false },
      { tagName: 'INPUT', type: 'text', name: 'disabled', value: 'no', matches: () => true },
      { tagName: 'SELECT', name: 'choice', selectedOptions: [{ value: 'one', matches: () => false }], matches: () => false },
    ] };
  const button = { tagName: 'BUTTON', type: 'submit', name: 'go', value: 'Search', form,
    matches: () => false, getAttribute: () => null,
    getBoundingClientRect: link.getBoundingClientRect, contains: element => element === button,
    closest: selector => selector === 'button,input' ? button : null };
  form.elements.push(button);
  link.ownerDocument.elementFromPoint = () => button;
  const result = inspectBackgroundLink(button);
  assert.equal(result.url, 'https://example.test/search?q=blue+sky&on=yes&choice=one&go=Search');
  form.method = 'post';
  assert.match(inspectBackgroundLink(button).fallback, /submission/);
});


test('an indexed link without a DOM ID resolves only through an exact unique role', async () => {
  const f = fixture(); f.tab.getAXState = async () => '1 link Next';
  await f.run('var t = await cua.getTab("1", {browser:"b"}); await t.click(1);');
  assert.equal(f.calls[0], 'new');
});
