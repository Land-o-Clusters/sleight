import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { createJobFixture, gradeJob, jobHandler, jobKinds } from '../bench/world/job-fixtures.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'requires headless DOM opt-in' : !existsSync(executablePath) && 'pinned headless shell absent';

for (const kind of jobKinds) test(`BF1 headless fixture: ${kind}`, { skip, timeout: 20000 }, async t => {
  const fixture = createJobFixture(kind, { nonce: kind, seed: 'real-page-bf1' });
  let origin, browser;
  const server = createServer((req, res) => Promise.resolve(jobHandler(fixture, origin)(req, res)).catch(() => res.writeHead(500).end()));
  t.after(async () => {
    try { await browser?.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    t.diagnostic('Cleanup: owned headless browser and loopback server closed; no screen capture');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, colorScheme: 'light', reducedMotion: 'no-preference' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/${fixture.nonce}/`);
  await page.waitForFunction(() => document.querySelector('h1'));
  const waitForEvent = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (fixture.events.some(predicate)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('fixture event missing');
  };
  await waitForEvent(e => e.kind === 'media');
  const input = () => ({ task: { worldFixture: kind }, site: JSON.parse(JSON.stringify({ kind, views: fixture.views, events: fixture.events })), expected: fixture.expected, answer: JSON.stringify(fixture.expected) });
  if (kind === 'job-canvas') {
    assert.ok(!(await page.locator('body').innerText()).includes(fixture.expected.code), 'code is drawn, not DOM text');
    const filledPixels = await page.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(90, 50, 300, 60).data].filter((n, i) => i % 4 === 0 && n < 100).length);
    assert.ok(filledPixels > 100, 'canvas has ink; no screenshot is taken');
  }
  if (kind === 'job-kanban') {
    const grip = await page.locator('#grip').boundingBox(), review = await page.locator('#review').boundingBox();
    // These are virtual pointer events inside the pinned headless shell, never the host pointer.
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(review.x + review.width / 2, review.y + review.height / 2, { steps: 8 });
    await page.mouse.up();
    await waitForEvent(e => e.kind === 'drag');
    assert.equal(await page.locator('#review #card').count(), 1);
  }
  if (kind === 'job-phone') {
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForEvent(e => e.kind === 'media' && e.width === 390);
    const box = await page.locator('#reserve').boundingBox();
    assert.ok(box.y >= 844);
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.equal(gradeJob(input()).ok, false, 'viewport must be restored');
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForFunction(() => innerWidth === 1200);
    await waitForEvent(() => fixture.events.filter(e => e.kind === 'media' && e.width === 1200).length === 2);
  }
  if (kind === 'job-dark') {
    const pixel = () => page.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(140, 90, 1, 1).data]);
    assert.deepEqual(await pixel(), [19, 141, 134, 255]);
    await page.emulateMedia({ colorScheme: 'dark' });
    await waitForEvent(e => e.kind === 'media' && e.scheme === 'dark');
    assert.deepEqual(await pixel(), [255, 191, 38, 255]);
    assert.equal(gradeJob(input()).ok, false, 'color scheme must be restored');
    await page.emulateMedia({ colorScheme: 'light' });
    await waitForEvent(() => fixture.events.filter(e => e.kind === 'media' && e.scheme === 'light').length === 2);
    assert.deepEqual(await pixel(), [19, 141, 134, 255]);
  }
  if (kind === 'job-motion') {
    await page.getByRole('button', { name: 'Play' }).click();
    await waitForEvent(e => e.kind === 'motion');
    assert.equal(await page.locator('#status').innerText(), 'Finished');
    assert.deepEqual(fixture.events.find(e => e.kind === 'motion').phases, fixture.expected.phases);
    assert.equal(await page.locator('#signal').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(119, 119, 119)');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(gradeJob(input()).problems, []);
  assert.equal(gradeJob({ ...input(), answer: '{}' }).ok, false);
});
