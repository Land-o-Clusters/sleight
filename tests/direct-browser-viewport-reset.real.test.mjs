import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { createPageRegistry } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { setViewport } from '../plugins/sleight/lib/direct-browser/viewport.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium');
const executablePath = process.platform === 'darwin'
  ? join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + pin.revision,
    'chrome-mac-' + process.arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  : join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + pin.revision, 'chrome-linux64/chrome');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'requires opt-in headless Chromium';
const state = page => page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
  dark: matchMedia('(prefers-color-scheme: dark)').matches,
  reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, touch: navigator.maxTouchPoints }));
const restored = async (page, before) => {
  await page.waitForFunction(({ width, height, dpr, dark, reduced, touch }) => innerWidth === width && innerHeight === height
    && devicePixelRatio === dpr && navigator.maxTouchPoints === touch
    && matchMedia('(prefers-color-scheme: dark)').matches === dark
    && matchMedia('(prefers-reduced-motion: reduce)').matches === reduced, before, { polling: 20, timeout: 2000 });
  assert.deepEqual(await state(page), before);
};

async function fixture(t) {
  assert.ok(existsSync(executablePath), 'pinned full Chromium must be installed');
  const profile = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-vp1-')));
  let launcher, browser, registry;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<p>Owned viewport fixture</p><iframe srcdoc="<p>Child fixture</p>"></iframe>');
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try { if (registry) assert.equal((await registry.endTurn()).cleanedUp, true); }
    finally {
      try { await browser?.close(); await launcher?.close(); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
    assert.equal(existsSync(profile), false);
    t.diagnostic('cleanup: owned headless browser closed and private profile removed');
  });
  launcher = await chromium.launchPersistentContext(profile, { headless: true, executablePath, viewport: null,
    colorScheme: null, reducedMotion: null,
    args: ['--remote-debugging-port=0', '--force-device-scale-factor=2', '--force-dark-mode', '--window-size=1200,900'] });
  const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  // Installed turbo connects without Playwright's default media or viewport overrides.
  browser = await chromium.connectOverCDP('ws://127.0.0.1:' + port + path, { noDefaults: true });
  const session = await browser.newBrowserCDPSession();
  registry = createPageRegistry({ browser, session, timeoutMs: 5000 });
  const { tab } = await registry.openTab({ url: 'http://127.0.0.1:' + server.address().port });
  const page = registry.tab(tab).page;
  page.setDefaultTimeout(3000);
  return { registry, tab, page };
}

for (const exit of ['reset', 'keep', 'handoff', 'reset then keep']) test(`VP1 ${exit} clears native DPR and media overrides`,
  { skip, timeout: 30000 }, async t => {
    const { registry, tab, page } = await fixture(t);
    const before = await state(page);
    assert.equal(before.dpr, 2); assert.equal(before.dark, true); assert.equal(before.touch, 0);
    await setViewport(page, { width: 640, height: 480, color_scheme: 'light', reduced_motion: true, touch: true });
    assert.deepEqual(await state(page), { width: 640, height: 480, dpr: 1, dark: false, reduced: true, touch: 1 });
    if (exit.startsWith('reset')) {
      await setViewport(page, {});
      await restored(page, before);
    }
    if (exit !== 'reset') await registry[exit === 'reset then keep' ? 'keep' : exit](tab);
    await restored(page, before);
    assert.equal(page.viewportSize(), null);
    const impl = page._connection.toImpl(page);
    assert.equal(impl.emulatedSize(), undefined);
    assert.equal(impl.delegate._mainFrameSession._metricsOverride, undefined);
    // A renderer reload and a repeated viewport size must not resurrect stale overrides.
    await page.reload();
    await restored(page, before);
    await setViewport(page, { width: 640, height: 480 });
    assert.equal((await state(page)).width, 640);
    await setViewport(page, {});
    await restored(page, before);
  });
