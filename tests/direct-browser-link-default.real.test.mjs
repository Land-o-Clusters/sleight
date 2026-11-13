import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createPageRegistry, backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';

const require = createRequire(import.meta.url);
const { inprocess } = require('../plugins/sleight/vendor/playwright-core/lib/coreBundle.js');
const spec = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(b => b.name === 'chromium');
const executable = process.platform === 'darwin'
  ? join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + spec.revision, 'chrome-mac-' + process.arch,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  : join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + spec.revision, 'chrome-linux64/chrome');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'default-link qualification belongs to the host runner'
  : !existsSync(executable) ? 'pinned Chromium executable unavailable' : false;

for (const handler of ['plain', 'stopPropagation', 'stopImmediatePropagation', 'preventDefault', 'stopAndPrevent',
  'returnFalse', 'returnValue', 'lateReturnFalse'])
test(`real new-tab link stays background-only with ${handler}`, {
  skip, timeout: 60000,
}, async t => {
  const profile = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-v2-link-')));
  const sockets = new Set();
  let context, registry;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    const code = `window.handled = (window.handled || 0) + 1;
      window.clickState = {ctrl:event.ctrlKey,meta:event.metaKey,before:event.defaultPrevented};
      ${handler === 'stopPropagation' || handler === 'stopAndPrevent' ? 'event.stopPropagation();' : ''}
      ${handler === 'stopImmediatePropagation' ? 'event.stopImmediatePropagation();' : ''}
      ${handler === 'preventDefault' || handler === 'stopAndPrevent' ? 'event.preventDefault();' : ''}
      ${handler === 'returnValue' ? 'event.stopImmediatePropagation(); event.returnValue = false;' : ''}
      window.clickState.after = event.defaultPrevented;
      ${['returnFalse', 'lateReturnFalse'].includes(handler) ? 'event.stopPropagation(); return false;' : ''}`;
    response.end(request.url === '/parent'
      ? `<a target="_blank" href="/child" onclick="${handler === 'lateReturnFalse' ? '' : code}">Open child</a>
        ${handler === 'lateReturnFalse' ? `<script>document.querySelector('a').addEventListener('pointerdown', () => {
          document.querySelector('a').onclick = function(event) { ${code} };
        });</script>` : ''}`
      : '<h1>Owned fixture</h1>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    try { await registry?.endTurn(); await context?.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      rmSync(profile, { recursive: true, force: true });
    }
    assert.equal(existsSync(profile), false);
    t.diagnostic('cleanup: owned browser closed, private profile removed, fixture server and sockets closed');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  context = await inprocess.playwright.chromium.launchPersistentContext(profile, { executablePath: executable, headless: true,
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
  const browser = context.browser(), session = await browser.newBrowserCDPSession(), calls = [];
  const send = session.send.bind(session);
  session.send = (method, params) => { calls.push({ method, params }); return send(method, params); };
  const user = context.pages()[0];
  await user.goto(origin + '/sentinel');
  const focusBefore = await user.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState }));
  registry = createPageRegistry({ browser, session, timeoutMs: 10000 });
  const { tab } = await registry.openTab({ url: origin + '/parent' });
  const entry = registry.tab(tab);
  const cancelled = ['preventDefault', 'stopAndPrevent', 'returnFalse', 'returnValue', 'lateReturnFalse'].includes(handler);
  const nextPage = cancelled ? undefined : context.waitForEvent('page', { timeout: 10000 });
  const locator = entry.page.getByRole('link', { name: 'Open child' }), clicks = [];
  await backgroundClick(entry, locator, options => { clicks.push(options); return locator.click({ ...options, timeout: 5000 }); },
    { timeoutMs: 5000 });
  const child = await nextPage;
  await child?.waitForLoadState('domcontentloaded');
  await registry.idle();
  const state = await entry.page.evaluate(() => ({ handled: window.handled, click: window.clickState }));
  assert.deepEqual(state, { handled: 1, click: { ctrl: false, meta: false, before: false,
    after: cancelled && !['returnFalse', 'lateReturnFalse'].includes(handler) } });
  assert.equal(clicks.length, 1);
  const rows = await registry.list();
  const cleanup = await registry.endTurn();
  const backgroundAllocations = calls.filter(call => call.method === 'Target.createTarget' && call.params.background === true).length;
  const focusAfter = await user.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState }));
  t.diagnostic(JSON.stringify({ handler, ownedTabs: rows.length, cleanup, backgroundAllocations, clicks, state, focusBefore, focusAfter,
    pagesRemaining: context.pages().length, childClosed: child?.isClosed(), userClosed: user.isClosed() }));
  if (!cancelled) assert.equal(backgroundAllocations, 2, 'a new-tab default must use an explicit background target');
  else assert.equal(backgroundAllocations, 1);
  assert.deepEqual(focusAfter, focusBefore);
  assert.equal(rows.length, cancelled ? 1 : 2, 'the default child must be owned, and cancellation must create none');
  assert.equal(cleanup.cleanedUp, true);
  if (child) assert.equal(child.isClosed(), true);
  assert.equal(context.pages().length, 1);
  assert.equal(user.isClosed(), false);
});
