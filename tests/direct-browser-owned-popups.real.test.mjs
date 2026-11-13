import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createPageRegistry, backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { hookState } from './adversarial/fixtures/hook.mjs';

const require = createRequire(import.meta.url);
const { inprocess } = require('../plugins/sleight/vendor/playwright-core/lib/coreBundle.js');
const spec = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url))).browsers.find(b => b.name === 'chromium');
const executable = process.platform === 'darwin'
  ? join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + spec.revision, 'chrome-mac-' + process.arch,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  : join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + spec.revision, 'chrome-linux64/chrome');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'opt-in popup qualification belongs to sleight-arch'
  : !existsSync(executable) ? 'the pinned Chromium executable is missing' : false;

async function fixture(t) {
  const profile = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-v3-popup-')));
  const events = [], calls = [], sockets = new Set();
  let launched, browser, registry, origin;
  const server = createServer(async (request, response) => {
    if (request.url === '/events') {
      let body = ''; for await (const chunk of request) body += chunk;
      events.push(JSON.parse(body)); response.end('ok'); return;
    }
    const route = new URL(request.url, 'http://fixture.invalid').pathname;
    if (route === '/external.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(`document.querySelector('button').addEventListener('click', event => {
        window.clickState = {ctrl:event.ctrlKey,meta:event.metaKey}; window.open('/size', 'external-child');
      });`);
      return;
    }
    // A different host spelling makes the identity popup cross-origin without
    // another fixed port. Every resource stays on this owned loopback fixture.
    const identity = origin?.replace('127.0.0.1', 'localhost');
    const pages = {
      '/shop': `<a target="_blank" href="/shipping">Shipping rates</a><button type="button" onclick="window.open('/size', 'guide', 'popup,width=420,height=560')">Size guide</button><a href="/checkout">Checkout</a>`,
      '/shipping': '<h1>Shipping rates</h1><p>Express: 12.40</p>',
      '/size': '<h1>Size guide</h1><p>11 cm</p>',
      '/checkout': '<h1>Checkout</h1>',
      '/account': `<button type="button" id="identity">Sign in with DemoID</button><p id="signed">Signed out</p><script>
        document.querySelector('#identity').onclick = event => {
          fetch('/events', {method:'POST',body:JSON.stringify({kind:'click',ctrl:event.ctrlKey,meta:event.metaKey})});
          window.open('${identity}/authorize', 'identity', 'popup,width=480,height=640');
        };
        window.addEventListener('message', event => {
          if (event.origin === '${identity}' && event.data.name) document.querySelector('#signed').textContent = 'Signed in as ' + event.data.name;
        });</script>`,
      '/authorize': `<button type="button" onclick="window.opener.postMessage({name:'Fixture User'}, '${origin}'); window.close()">Continue</button>`,
      '/sentinel': '<h1>User page</h1>',
      '/external': '<button>External command</button><script src="/external.js"></script>',
      '/plain': `<button>Plain command</button><script>document.querySelector('button').onclick = event => {
        window.clickState = {ctrl:event.ctrlKey,meta:event.metaKey}; window.handled = (window.handled || 0) + 1;
      };</script>`,
      '/same-bare': '<a href="/checkout" rel="noopener">Continue here</a>',
      '/same-self': '<a href="/checkout" target="_self" rel="noreferrer">Continue here</a>',
      '/same-named': '<iframe name="content" src="/sentinel"></iframe><a href="/checkout" target="content" rel="noopener">Continue here</a>',
      '/same-base': '<base target="content"><iframe name="content" src="/sentinel"></iframe><a href="/checkout" rel="noopener">Continue here</a>',
    };
    response.writeHead(pages[route] ? 200 : 404, { 'content-type': 'text/html' });
    response.end(`<html><head><title>${route}</title></head><body>${pages[route] ?? 'missing'}<script>
      window.focusCount = 0; window.addEventListener('focus', () => { window.focusCount++; });
    </script></body></html>`);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    try { await registry?.endTurn(); await browser?.close(); await launched?.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      rmSync(profile, { recursive: true, force: true });
    }
    assert.equal(existsSync(profile), false);
    t.diagnostic('cleanup: owned Chromium closed, profile deleted, fixture server and sockets closed');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  launched = await inprocess.playwright.chromium.launchPersistentContext(profile, { headless: true, executablePath: executable,
    viewport: { width: 1200, height: 900 }, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
  // One Playwright driver owns this disposable browser. A second driver can
  // compete over popup auto-attachment and leave the new target paused.
  browser = launched.browser();
  const session = await browser.newBrowserCDPSession(), send = session.send.bind(session);
  session.send = (method, params) => { calls.push({ method, params }); return send(method, params); };
  const context = browser.contexts()[0], user = context.pages()[0];
  context.on('page', page => page.on('pageerror', error => t.diagnostic('fixture page error: ' + error.message)));
  await user.goto(origin + '/sentinel');
  const focusBefore = await user.evaluate(() => ({ count: window.focusCount, visibility: document.visibilityState }));
  registry = createPageRegistry({ browser, session, timeoutMs: 10000 });
  const open = route => registry.openTab({ url: origin + route });
  async function click(tab, name) {
    const entry = registry.tab(tab), before = entry.popups.length;
    try {
      await backgroundClick(entry, entry.page.getByRole(name === 'Shipping rates' || name === 'Checkout' ? 'link' : 'button', { name }), undefined, { timeoutMs: 5000 });
    } catch (error) {
      t.diagnostic('popup failure: ' + JSON.stringify({ name, windows: entry.windowOpenNo, popups: entry.popups,
        urls: context.pages().map(page => page.url()), events }));
      throw error;
    }
    if (['Shipping rates', 'Size guide', 'Sign in with DemoID'].includes(name)) {
      const end = Date.now() + 5000;
      while (entry.popups.length === before && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    }
    await registry.idle();
    return entry.popups.at(-1);
  }
  async function focusUnchanged() {
    assert.deepEqual(await user.evaluate(() => ({ count: window.focusCount, visibility: document.visibilityState })), focusBefore);
    for (const row of await registry.list()) assert.equal(await registry.tab(row.tab).page.evaluate(() => window.focusCount), 0);
    assert.equal(calls.some(c => ['Target.activateTarget', 'Page.bringToFront'].includes(c.method)), false);
    t.diagnostic('focus: sentinel visibility unchanged; zero fixture window focus events; zero activation commands');
  }
  return { registry, calls, open, click, user, events, focusUnchanged, context };
}

test('real v3 Shipping rates opens in the background and preserves user tabs', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t), { tab } = await f.open('/shop'), popup = await f.click(tab, 'Shipping rates');
  assert.ok(popup); assert.equal(popup.opener, tab);
  const page = f.registry.tab(popup.tab).page;
  assert.match(await page.locator('body').innerText(), /12\.40/);
  await f.focusUnchanged();
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
  assert.equal(f.context.pages().length, 1); assert.equal(f.user.isClosed(), false);
});

test('real v3 named popup keeps its opener and reuses the same owned handle', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t), { tab } = await f.open('/shop'), popup = await f.click(tab, 'Size guide');
  assert.ok(popup); const page = f.registry.tab(popup.tab).page;
  assert.match(await page.locator('body').innerText(), /11 cm/);
  assert.equal(await page.evaluate(() => !!window.opener), true);
  await f.click(tab, 'Size guide');
  assert.equal(f.registry.tab(tab).popups.length, 1);
  assert.equal((await f.registry.list()).length, 2);
  await f.focusUnchanged();
});

test('real v3 DemoID signs in through its cross-origin opener and self-closes without focus change', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t), { tab } = await f.open('/account'), popup = await f.click(tab, 'Sign in with DemoID');
  assert.ok(popup); const parent = f.registry.tab(tab), child = f.registry.tab(popup.tab);
  assert.equal(await child.page.evaluate(() => !!window.opener), true);
  await f.click(popup.tab, 'Continue');
  await parent.page.getByText('Signed in as Fixture User').waitFor();
  assert.equal(popup.closed, true);
  assert.deepEqual(f.events.find(e => e.kind === 'click'), { kind: 'click', ctrl: false, meta: false });
  await f.focusUnchanged();
});

test('real v3 same-tab link uses plain click and no popup preparation', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t), { tab } = await f.open('/shop');
  await f.click(tab, 'Checkout');
  assert.match(f.registry.tab(tab).page.url(), /\/checkout$/);
  assert.equal((await f.registry.list()).length, 1);
  await f.focusUnchanged();
});

test('real v3 keep and handoff remove hooks and survive turn-end cleanup', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t), a = await f.open('/shop'), b = await f.open('/account');
  const kept = f.registry.tab(a.tab).page, handed = f.registry.tab(b.tab).page, hook = f.registry.tab(a.tab).hook;
  assert.equal(await hookState(kept, hook), 'live'); assert.equal(await hookState(handed, hook), 'live');
  await f.registry.keep(a.tab); await f.registry.handoff(b.tab);
  assert.equal(await hookState(kept, hook), 'off');
  assert.equal(await hookState(handed, hook), 'off');
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
  assert.equal(f.context.pages().length, 3);
  assert.equal(kept.isClosed(), false); assert.equal(handed.isClosed(), false);
});

for (const kind of ['external', 'plain']) test('CR3 real ' + kind + ' command preserves plain page modifiers and focus', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t), { tab } = await f.open('/' + kind), entry = f.registry.tab(tab);
  const nextPage = kind === 'external' ? f.context.waitForEvent('page', { timeout: 5000 }) : undefined;
  const locator = entry.page.getByRole('button');
  const clicks = [];
  await backgroundClick(entry, locator, options => { clicks.push(options); return locator.click({ ...options, timeout: 3000 }); });
  const child = await nextPage;
  await child?.waitForLoadState('load'); await f.registry.idle();
  assert.deepEqual(await entry.page.evaluate(() => window.clickState), { ctrl: false, meta: false });
  assert.deepEqual(clicks, [{ modifiers: ['ControlOrMeta'] }]);
  if (kind === 'plain') assert.equal(await entry.page.evaluate(() => window.handled), 1);
  assert.equal((await f.registry.list()).length, kind === 'external' ? 2 : 1);
  await f.focusUnchanged();
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
  assert.equal(f.context.pages().length, 1);
});

for (const kind of ['bare', 'self', 'named', 'base']) test('CR3 real same-context rel link navigates its existing context: ' + kind,
  { skip, timeout: 90000 }, async t => {
    const f = await fixture(t), { tab } = await f.open('/same-' + kind), entry = f.registry.tab(tab);
    const framed = kind === 'named' || kind === 'base';
    const target = framed ? entry.page.frames()[1] : entry.page;
    await target.waitForLoadState('load');
    const navigated = target.waitForURL('**/checkout');
    const locator = entry.page.getByRole('link', { name: 'Continue here' }), clicks = [];
    await backgroundClick(entry, locator, options => { clicks.push(options); return locator.click({ ...options, timeout: 3000 }); });
    await navigated;
    assert.deepEqual(clicks, [{}]);
    assert.equal((await f.registry.list()).length, 1);
    await f.focusUnchanged();
  });
