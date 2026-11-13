import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';

const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const vendor = new URL('../plugins/sleight/vendor/playwright-core/', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('browsers.json', vendor))).browsers.find(b => b.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executable = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');

// Only sleight-arch's host runner executes the headless fixture. Opted-in runs
// fail if Chromium is missing; a skipped page test never qualifies V1.
test('real Chromium over filtered CDP hides foreign tabs, owns background creates and refuses activation', {
  skip: !live ? 'real Chromium qualification belongs to the host runner' : false, timeout: 60000,
}, async t => {
  assert.ok(existsSync(executable), 'pinned headless Chromium must be installed');
  const { chromium } = await import(new URL('index.mjs', vendor));
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-v3-cdp-'))));
  let context, socket, filter, bridge, browser, filterCollected = false;
  t.after(async () => {
    try {
      await browser?.close();
      if (filter) { filterCollected = await filter.dispose(); assert.equal(filterCollected, true, 'filter routes must detach before raw connection closure'); }
    } finally {
      await bridge?.close();
      if (socket && socket.readyState !== 3) await new Promise(resolve => { socket.once('close', resolve); socket.terminate(); });
      await context?.close();
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
      t.diagnostic('Cleanup: browserClosed=true profileDeleted=true socketsClosed=true filterCollected=' + filterCollected);
    }
  });
  context = await chromium.launchPersistentContext(root, { executablePath: executable, headless: true,
    args: ['--remote-debugging-port=0', '--site-per-process'], viewport: null });
  const first = context.pages()[0], foreign = await context.newPage();
  await first.setContent('<title>Owned local fixture</title><button>Owned</button>');
  await foreign.setContent('<title>Foreign private fixture</title><button>Private</button>');
  const cookieURL = 'http://foreign.fixture.invalid';
  await context.addCookies([{ url: cookieURL, name: 'private-fixture', value: 'retained' }]);
  const cookies = await context.cookies(cookieURL);
  const ownerCDP = await context.newCDPSession(first);
  const { targetInfo: owner } = await ownerCDP.send('Target.getTargetInfo'); await ownerCDP.detach();
  const port = readFileSync(join(root, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  const { ws } = createRequire(import.meta.url)(new URL('lib/utilsBundle.js', vendor).pathname);
  socket = new ws('ws://127.0.0.1:' + port[0] + port[1]);
  const pending = new Map(), listeners = new Set();
  const wire = []; let serial = 0;
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('close', () => { for (const wait of pending.values()) wait.reject(Error('fixture connection closed')); pending.clear(); });
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.id) {
      const wait = pending.get(frame.id); pending.delete(frame.id);
      if (frame.error) wait.reject(Error(frame.error.message)); else wait.resolve(frame.result);
    } else for (const listener of listeners) listener(frame);
  });
  const upstream = { sessionId: 'root', on: (_name, fn) => listeners.add(fn), off: (_name, fn) => listeners.delete(fn),
    send(method, params = {}, route = 'root') {
      if (socket.readyState !== 1) return Promise.reject(Error('fixture connection closed'));
      wire.push(method); const id = ++serial;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(route === 'root' ? {} : { sessionId: route }) })); });
    } };
  filter = createCDPFilter({ session: upstream, ownedTargets: [owner.targetId], protectedPort: Number(port[0]) });
  bridge = await filter.listen();
  browser = await chromium.connectOverCDP(bridge.endpoint, { timeout: 10000, noDefaults: true });
  const pages = browser.contexts()[0].pages(); assert.equal(pages.length, 1);
  assert.equal(await pages[0].title(), 'Owned local fixture');
  const rootCDP = await browser.newBrowserCDPSession();
  const before = wire.length;
  for (const method of ['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds', 'Browser.setContentsSize'])
    await assert.rejects(rootCDP.send(method, { targetId: owner.targetId, windowId: 1, bounds: { windowState: 'maximized' } }), /CDP_COMMAND_REFUSED/);
  assert.equal(wire.length, before, 'no activation or window command reaches Chromium');
  const { targetId } = await rootCDP.send('Target.createTarget', { url: 'about:blank' });
  assert.equal(filter.owns(targetId), true);
  assert.equal((await rootCDP.send('Target.getTargets')).targetInfos.length, 2);
  assert.equal(context.pages().some(page => page === foreign), true);
  const pageCDP = await browser.contexts()[0].newCDPSession(pages[0]);
  // Unfiltered fixture setContent carried Playwright's normal user gesture.
  // A fresh document removes that earlier activation before testing this boundary.
  await pages[0].goto('about:blank');
  const gesture = await pageCDP.send('Runtime.evaluate', { expression: 'navigator.userActivation.isActive', returnByValue: true, userGesture: true });
  assert.equal(gesture.result.value, false, 'FD3 evaluation cannot manufacture user activation');
  const object = await pageCDP.send('Runtime.evaluate', { expression: 'document', userGesture: true });
  const callGesture = await pageCDP.send('Runtime.callFunctionOn', { objectId: object.result.objectId,
    functionDeclaration: 'function () { return navigator.userActivation.isActive; }', returnByValue: true, userGesture: true });
  assert.equal(callGesture.result.value, false, 'FD3 function calls cannot manufacture user activation');
  await pageCDP.send('Runtime.releaseObject', { objectId: object.result.objectId });
  await pageCDP.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await assert.rejects(pageCDP.send('Page.bringToFront'), /CDP_COMMAND_REFUSED/);
  const beforeGlobal = wire.length;
  const profileCommands = ['Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.getAllCookies',
    'Network.deleteCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies',
    'Network.enableDeviceBoundSessions', 'Network.deleteDeviceBoundSession', 'Page.deleteCookie', 'Page.setDownloadBehavior'];
  for (const method of profileCommands)
    await assert.rejects(pageCDP.send(method, { urls: [cookieURL], url: cookieURL }), /CDP_COMMAND_REFUSED/, method);
  const concurrent = wire.slice(beforeGlobal);
  assert.deepEqual(concurrent.filter(method => profileCommands.includes(method)), [], 'browser profile commands never reach Chromium through the page session');
  t.diagnostic('Concurrent allowed setup commands: ' + JSON.stringify(concurrent));
  assert.deepEqual(await context.cookies(cookieURL), cookies, 'the foreign fixture cookie remains unchanged');
  await pageCDP.detach(); await rootCDP.send('Target.closeTarget', { targetId });
  assert.equal(filter.owns(targetId), false);

  // Cross-site child navigation must reach the owned parent's reporter too.
  // Both sites are this test's loopback server, never an external page.
  const sockets = new Set();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/child' ? '<p>Owned child</p>' : '<iframe src="http://localhost:' + server.address().port + '/child"></iframe>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const navigations = [], watcher = await filter.frames.watchNavigations(owner.targetId, (event, cancel) => {
    if (event.url.startsWith('zoommtg:')) { navigations.push(event.url); cancel().catch(() => {}); }
  });
  await pages[0].goto('http://127.0.0.1:' + server.address().port + '/parent');
  const until = Date.now() + 5000;
  while (!filter.frames.sessions(owner.targetId).length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(filter.frames.sessions(owner.targetId).length, 'fixture must create an owned out-of-process iframe');
  let child;
  while (!(child = pages[0].frames().find(frame => frame.url().endsWith('/child'))) && Date.now() < until)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(child, JSON.stringify(pages[0].frames().map(frame => frame.url())));
  await child.evaluate(() => { location.href = 'zoommtg://fixture.invalid'; });
  while (!navigations.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(navigations, ['zoommtg://fixture.invalid']);
  await watcher.remove();
  t.diagnostic('owned out-of-process iframe native navigation reported and cancellation requested');
});
