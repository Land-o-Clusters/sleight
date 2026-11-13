import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../../scripts/temp-leftovers.mjs';
const require = createRequire(import.meta.url);
const { inprocess } = require('../../plugins/sleight/vendor/playwright-core/lib/coreBundle.js');
import { createPageRegistry, backgroundClick } from '../../plugins/sleight/lib/direct-browser/page.mjs';

const pin = JSON.parse(readFileSync(new URL('../../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium');
const executablePath = process.platform === 'darwin'
  ? join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + pin.revision, 'chrome-mac-' + process.arch,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  : join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + pin.revision, 'chrome-linux64/chrome');
export const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'real-page qualification belongs to sleight-arch host runner'
  : !existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;

export async function fixture(t, html, routes = {}, { observeTabs = false, smoothScrolling = false, deviceScaleFactor, nativeViewport = false } = {}) {
  const sockets = new Set(), requests = [];
  const profile = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-cr4-')));
  let context, registry;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, body });
    response.setHeader('Content-Type', 'text/html');
    response.end(routes[new URL(request.url, 'http://fixture.invalid').pathname] ??
      (request.url.startsWith('/landed') ? '<h1>Landed</h1>' : html));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    try {
      if (registry) assert.equal((await registry.endTurn()).cleanedUp, true);
      await context?.close();
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      rmSync(profile, { recursive: true, force: true });
    }
    assert.equal(existsSync(profile), false);
    t.diagnostic('cleanup: owned browser and pages closed, private profile removed, loopback server and sockets closed');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const args = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
  if (smoothScrolling) args.push('--enable-smooth-scrolling');
  if (deviceScaleFactor !== undefined) args.push('--force-device-scale-factor=' + deviceScaleFactor);
  if (nativeViewport) args.push('--window-size=1280,807');
  if (observeTabs) {
    // Only this disposable browser loads the read-only observer. Chrome's tab
    // active bit distinguishes background disposition even in headless mode,
    // where every page reports visible and focus emulation changes hasFocus.
    const extension = join(profile, 'tab-observer'); mkdirSync(extension);
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture tab observer',
      version: '1.0', permissions: ['tabs'], background: { service_worker: 'worker.js' } }));
    writeFileSync(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    args.push('--disable-extensions-except=' + extension, '--load-extension=' + extension);
  }
  context = await inprocess.playwright.chromium.launchPersistentContext(profile, { headless: true, executablePath, args,
    ...(nativeViewport ? { viewport: null } : {}),
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
    ...(observeTabs ? { channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'] } : {}) });
  const worker = observeTabs ? context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 5000 }) : undefined;
  const tabState = () => worker.evaluate(async () => (await chrome.tabs.query({})).map(({ id, url, active }) => ({ id, url, active })));
  const browser = context.browser(), sentinel = context.pages()[0];
  await sentinel.goto('about:blank');
  const before = await sentinel.evaluate(() => document.visibilityState);
  const session = await browser.newBrowserCDPSession();
  registry = createPageRegistry({ browser, session, context, timeoutMs: 10000, popupWaitMs: 5000 });
  const { tab } = await registry.openTab({ url: 'http://127.0.0.1:' + server.address().port + '/start' });
  const entry = registry.tab(tab);
  // Activate only this disposable headless target for compositor gesture tests.
  if (smoothScrolling) await entry.page.bringToFront();
  return { registry, context, entry, requests, sentinel, before, session, tabState: observeTabs ? tabState : undefined };
}

export const controls = { button: '<button>Send</button>', submit: '<input type="submit" value="Send">',
  image: '<input type="image" alt="Send" width="30" height="30" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E">' };
