import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { screenshot, jpegSize } from '../plugins/sleight/lib/direct-browser/screenshot.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'needs SLEIGHT_LIVE_DOM_TEST=1 (headless fixtures only)';

async function fixture(t, html, { routes = {}, dpr = 1, width = 1440, height = 900, nativeDpr, zoom = 1 } = {}) {
  assert.ok(existsSync(executablePath), 'pinned headless Chromium must be installed');
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html'); response.end(routes[request.url] ?? html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  let browser, context, profile;
  t.after(async () => {
    try { await browser?.close(); }
    finally { if (profile) { rmSync(profile, { recursive: true, force: true }); assert.equal(existsSync(profile), false); } }
    t.diagnostic('Cleanup: owned headless Chromium and loopback fixture server closed; private zoom profile removed when used.');
  });
  if (nativeDpr) {
    // Headless Chrome for Testing reads real browser zoom from its private profile.
    // No device-metrics override, CSS zoom, page getter or keyboard shortcut stands in for it.
    profile = mkdtempSync('/tmp/sleight-fd1b-zoom-');
    mkdirSync(join(profile, 'Default'));
    writeFileSync(join(profile, 'Default/Preferences'), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) } } }));
    const fullExecutable = join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + pin.revision,
      'chrome-' + platform, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    assert.ok(existsSync(fullExecutable), 'pinned full Chromium must be installed for browser zoom');
    context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: fullExecutable, viewport: null,
      args: ['--site-per-process', '--force-device-scale-factor=' + nativeDpr, '--window-size=' + width + ',' + height] });
    browser = context.browser();
  } else {
    browser = await chromium.launch({ headless: true, executablePath, args: ['--site-per-process'] });
    context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  }
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const entry = { page, state: { snapshotNo: 0 }, openedBySleight: true };
  const calls = [], sessions = new Set(), errors = [];
  const attach = context.newCDPSession.bind(context);
  context.newCDPSession = async frame => {
    const cdp = await attach(frame), send = cdp.send.bind(cdp), detach = cdp.detach.bind(cdp);
    sessions.add(cdp);
    cdp.send = async (method, params) => {
      calls.push({ frame, method, params });
      try { return await send(method, params); } catch (error) { errors.push([method, error.message]); throw error; }
    };
    cdp.detach = async () => { try { return await detach(); } finally { sessions.delete(cdp); } };
    return cdp;
  };
  return { entry, page, context, calls, sessions, errors };
}

for (const dpr of [1, 2]) test(`FD1 viewport JPEG stays within 1000 pixels at DPR ${dpr}, without focus, scrolling or foreign capture`, { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{margin:0;background:#456}canvas{background:#ef9}main{height:5000px}</style><canvas width="500" height="200"></canvas><main>Owned fixture</main>', { dpr });
  await f.page.evaluate(() => scrollTo(0, 700));
  const foreign = await f.context.newPage(); await foreign.goto(f.page.url());
  const result = await screenshot(f.entry);
  assert.ok(result.images, JSON.stringify({ note: result.note, errors: f.errors, methods: f.calls.map(c => c.method) }));
  assert.match(result.note, /1000x625.*downscaled.*untrusted/);
  assert.deepEqual(jpegSize(result.images[0].data), { width: 1000, height: 625 });
  assert.equal(await f.page.evaluate(() => scrollY), 700);
  const captures = f.calls.filter(call => call.method === 'Page.captureScreenshot');
  assert.equal(captures.length, 1); assert.equal(captures[0].frame, f.page.mainFrame());
  assert.equal(captures[0].params.captureBeyondViewport, false);
  assert.equal(captures[0].params.quality, 80);
  assert.ok(f.calls.filter(c => c.method === 'Debugger.enable').every(c => c.params.maxScriptsCacheSize === 0));
  assert.ok(!f.calls.some(call => /bringToFront|activateTarget|Input\.|setDeviceMetricsOverride/.test(call.method)));
  assert.equal(f.sessions.size, 0);
  // The renderer is running again after the guarded transaction.
  assert.equal(await f.page.evaluate(() => 6 * 7), 42);
});

test('FD1B a deadline during a paused native audit still releases the real renderer', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, '<button>Owned deadline fixture</button>');
  const attach = f.context.newCDPSession.bind(f.context);
  f.context.newCDPSession = async frame => {
    const cdp = await attach(frame), send = cdp.send.bind(cdp);
    cdp.send = (method, params) => method === 'DOMSnapshot.captureSnapshot' ? new Promise(() => {}) : send(method, params);
    return cdp;
  };
  const started = performance.now(), result = await screenshot(f.entry);
  assert.ok(performance.now() - started < 3600, result.note);
  assert.equal(result.images, undefined);
  assert.equal(await f.page.evaluate(() => 42), 42, 'the page must run again after timeout');
  assert.equal(f.sessions.size, 0);
  assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 0);
  f.context.newCDPSession = attach;
  const next = await screenshot(f.entry);
  assert.equal(next.images?.length, 1, 'a collected timeout must release the capture lock');
});

for (const [nativeDpr, zoom] of [[2, 1], [1, 1.25], [2, 1.25]])
  test(`FD1B native DPR ${nativeDpr} and ${zoom * 100}% browser zoom downscale the owned viewport`, { skip, timeout: 30000 }, async t => {
    const f = await fixture(t, '<style>body{margin:0;background:blue}main{height:5000px}</style><main>Owned zoom fixture</main>', { nativeDpr, zoom });
    const probe = await f.context.newCDPSession(f.page);
    const metrics = await probe.send('Page.getLayoutMetrics'); await probe.detach();
    assert.ok(Math.abs(metrics.cssVisualViewport.zoom - zoom) < 0.01, JSON.stringify(metrics));
    assert.ok(Math.abs(await f.page.evaluate(() => devicePixelRatio) - nativeDpr * zoom) < 0.02);
    await f.page.evaluate(() => scrollTo(0, 700));
    for (const maxSide of [1000, 480]) {
      const result = await screenshot(f.entry, { maxSide });
      assert.ok(result.images, result.note + JSON.stringify(f.errors));
      const size = jpegSize(result.images[0].data);
      assert.equal(Math.max(size.width, size.height), maxSide);
      assert.ok(Buffer.from(result.images[0].data, 'base64').length <= 512000);
      assert.match(result.note, /downscaled/);
      assert.equal(await f.page.evaluate(() => scrollY), 700);
      t.diagnostic(`Native DPR ${nativeDpr}, browser zoom ${metrics.cssVisualViewport.zoom}, encoded ${size.width}x${size.height}`);
    }
    assert.equal(f.sessions.size, 0);
    assert.equal(await f.page.evaluate(() => 6 * 7), 42);
    assert.ok(!f.calls.some(c => /bringToFront|activateTarget|Input\.|setDeviceMetricsOverride/.test(c.method)));
  });

for (const field of [
  '<input type="password" aria-label="Account" value="fixture-secret">',
  '<label>Security code<input value="123"></label>',
  '<input autocomplete="cc-number" value="4111111111111111">',
  '<input autocomplete="one-time-code" value="987654">',
  '<span id="label">Password</span><div role="textbox" aria-labelledby="label" contenteditable>fixture-secret</div>',
  '<input type="password" style="display:none">',
  '<input type="password" style="position:absolute;top:6000px">',
  '<custom-field></custom-field><script>document.querySelector("custom-field").attachShadow({mode:"closed"}).innerHTML="<input value=fixture-secret>"</script>',
  '<input type="password"><script>Object.defineProperty(HTMLInputElement.prototype,"type",{get(){return "text"}});Object.defineProperty(window,"devicePixelRatio",{get(){return 0.1}})</script>',
]) test('FD1 native protection skips pixels for ' + field.slice(0, 65), { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<main>Safe layout</main>' + field);
  const result = await screenshot(f.entry);
  assert.match(result.note, /protected fields/); assert.equal(result.images, undefined);
  assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 0);
  assert.equal(f.sessions.size, 0);
  assert.equal(await f.page.evaluate(() => 42), 42);
});

test('FD1 protected cross-origin frame refuses the entire viewport', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<main>Layout</main><iframe></iframe>');
  // Two loopback hostnames put the child in another renderer process.
  await f.page.route('http://localhost:' + new URL(f.page.url()).port + '/card', route => route.fulfill({
    contentType: 'text/html', body: '<input autocomplete="cc-number" value="4111111111111111">',
  }));
  const url = 'http://localhost:' + new URL(f.page.url()).port + '/card';
  const navigated = f.page.waitForEvent('framenavigated', frame => frame.url() === url);
  await f.page.locator('iframe').evaluate((el, url) => { el.src = url; }, url);
  await (await navigated).waitForLoadState();
  const result = await screenshot(f.entry);
  assert.match(result.note, /protected fields/, JSON.stringify({ errors: f.errors, methods: f.calls.map(c => c.method) })); assert.equal(result.images, undefined);
  assert.ok(f.calls.some(c => c.frame !== f.page.mainFrame() && c.method === 'DOMSnapshot.captureSnapshot'));
  assert.equal(f.sessions.size, 0);
});

test('FD1 read and post-action capture stay opt-in and preserve delivered refs', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<button onclick="document.querySelector(\'p\').textContent=\'Changed\'">Animate</button><p>Ready</p>', { width: 640, height: 480 });
  const pages = { enqueue: async (_id, run) => run(f.entry) };
  const runner = createActionRunner({ check: () => 'allow', snapshot });
  const dispatcher = createToolDispatcher({ pages, snapshot, runSteps: runner, fillFields: async () => assert.fail('no fill'),
    deliverSnapshot: (state, capture) => { state.snapshotNo = capture.number; return acknowledgeSnapshot(capture.page, capture.number); } });
  const read = await dispatcher.call({ name: 'browser_read', arguments: { tab: 't1' } });
  assert.equal(read.images, undefined); assert.equal(f.calls.filter(c => c.method === 'Page.captureScreenshot').length, 0);
  assert.equal(dispatcher.delivered(read), true);
  const ref = /button "Animate" \[ref=(\w+)\]/.exec(read.text)[1];
  const act = await dispatcher.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click', ref }], observe: 'screenshot' } });
  assert.equal(act.isError, false, act.text); assert.match(act.text, /Changed.*Screenshot 640x480/s);
  assert.equal(act.images.length, 1); assert.equal(dispatcher.delivered(act), true);
  assert.equal(f.sessions.size, 0);
});
