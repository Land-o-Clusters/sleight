import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readIsolatedGeometry } from '../plugins/sleight/lib/direct-browser/electron-targets.mjs';
// Real headless Chromium stands in for an Electron renderer: the page redefines the geometry getters in its main world
// before any of its own script runs, and the isolated-world read must not see that. No Electron app is launched.
// Runs through the host runner.
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'real-page geometry qualification runs through sleight-arch host runner' : false;
const spoof = `Object.defineProperty(window, 'screenX', { get: () => -12345 }); Object.defineProperty(window, 'outerWidth', { get: () => 1 });
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 9 }); Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'hidden' });`;

test('a page that spoofs screenX, outerWidth, devicePixelRatio and visibility in its main world does not change the isolated-world geometry', { skip }, async t => {
  const { chromium } = await import('../plugins/sleight/vendor/playwright-core/index.mjs');
  const spec = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url))).browsers.find(b => b.name === 'chromium-headless-shell');
  const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
  const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision, 'chrome-headless-shell-' + platform, 'chrome-headless-shell');
  assert.ok(existsSync(executablePath), 'pinned headless Chromium required; host tests must not skip');
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); });
  const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
  const page = await context.newPage();
  await page.addInitScript(spoof);
  await page.goto('data:text/html,<main>renderer</main>');
  const main = await page.evaluate(() => ({ x: window.screenX, width: window.outerWidth, scale: window.devicePixelRatio, visible: document.visibilityState }));
  assert.deepEqual(main, { x: -12345, width: 1, scale: 9, visible: 'hidden' }, 'the spoof is live in the main world');
  const cdp = await context.newCDPSession(page);
  const geometry = await readIsolatedGeometry((method, params) => cdp.send(method, params));
  assert.notEqual(geometry.x, -12345);
  assert.ok(geometry.width > 1, JSON.stringify(geometry));
  assert.notEqual(geometry.scale, 9);
  assert.equal(geometry.visible, true);
});
