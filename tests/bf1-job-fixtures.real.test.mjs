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

async function openFixture(t, kind, { seed = 'real-page-bf1', colorScheme = 'light', reducedMotion = 'no-preference', pausedRaf = false } = {}) {
  const fixture = createJobFixture(kind, { nonce: kind, seed });
  let origin, browser;
  const server = createServer((req, res) => Promise.resolve(jobHandler(fixture, origin)(req, res)).catch(() => res.writeHead(500).end()));
  t.after(async () => {
    try { await browser?.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    t.diagnostic('Cleanup: owned headless browser and loopback server closed; no screen capture');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, colorScheme, reducedMotion });
  if (pausedRaf) await page.addInitScript(() => { window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {}; });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const requests = []; page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.goto(`${origin}/${fixture.nonce}/`);
  await page.waitForFunction(() => document.querySelector('h1'));
  const waitForEvent = async predicate => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (fixture.events.some(predicate)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('fixture event missing');
  };
  await waitForEvent(e => e.kind === 'media');
  const input = () => ({ task: { worldFixture: kind }, site: JSON.parse(JSON.stringify({ kind, views: fixture.views, events: fixture.events, kanban: fixture.kanban })), expected: fixture.expected, answer: JSON.stringify(fixture.expected) });
  return { fixture, page, errors, requests, waitForEvent, input, origin };
}

for (const kind of jobKinds) test(`BF1 headless fixture: ${kind}`, { skip, timeout: 20000 }, async t => {
  const { fixture, page, errors, waitForEvent, input } = await openFixture(t, kind);
  if (kind === 'job-canvas') {
    assert.ok(!(await page.content()).includes(fixture.expected.code), 'answer is absent from page source');
    const filledPixels = await page.locator('#slip').evaluate(async image => {
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 160;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return [...context.getImageData(90, 50, 300, 60).data].filter((n, i) => i % 4 === 0 && n < 100).length;
    });
    assert.ok(filledPixels > 100, 'server PNG has ink and decodes in Chromium; no screenshot is taken');
  }
  if (kind === 'job-kanban') {
    const grip = await page.locator('#grip').boundingBox(), review = await page.locator('#review').boundingBox();
    // These are virtual pointer events inside the pinned headless shell, never the host pointer.
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(review.x + review.width / 2, review.y + review.height / 2, { steps: 8 });
    await page.mouse.up();
    await waitForEvent(e => e.kind === 'drag');
    await waitForEvent(() => fixture.kanban?.column === 'Review');
    assert.equal(await page.locator('#review #card').count(), 1);
  }
  if (kind === 'job-phone') {
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForEvent(e => e.kind === 'media' && e.width === 390);
    const box = await page.locator('#reserve').boundingBox();
    assert.equal(box.y >= 0 && box.y + box.height <= 844, fixture.expected.actionVisible);
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
    assert.deepEqual(await pixel(), { amber: [255, 191, 38, 255], teal: [19, 141, 134, 255], violet: [135, 83, 216, 255] }[fixture.expected.badge]);
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

test('BF2 headless media fixtures render both phone outcomes and all three dark badges', { skip, timeout: 20000 }, async t => {
  const seeds = new Map();
  for (let n = 0; n < 64; n++) {
    for (const kind of ['job-phone', 'job-dark']) {
      const seed = `bf2-${n}`, expected = createJobFixture(kind, { nonce: 'trial', seed }).expected;
      const key = kind === 'job-phone' ? `${kind}:${expected.actionVisible}` : `${kind}:${expected.badge}`;
      if (!seeds.has(key)) seeds.set(key, { kind, seed });
    }
  }
  assert.equal(seeds.size, 5);
  for (const { kind, seed } of seeds.values()) await t.test(`${kind} ${seed}`, async child => {
    const { fixture, page, errors, waitForEvent, input } = await openFixture(child, kind, { seed });
    if (kind === 'job-phone') {
      await page.setViewportSize({ width: 390, height: 844 });
      await waitForEvent(e => e.kind === 'media' && e.width === 390);
      const box = await page.locator('#reserve').boundingBox();
      assert.equal(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, fixture.expected.actionVisible);
      assert.equal(await page.evaluate(() => scrollY), 0);
      await page.setViewportSize({ width: 1200, height: 900 });
      await waitForEvent(() => fixture.events.filter(e => e.kind === 'media' && e.width === 1200).length === 2);
    } else {
      await page.emulateMedia({ colorScheme: 'dark' });
      await waitForEvent(e => e.kind === 'media' && e.scheme === 'dark');
      const pixel = await page.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(140, 90, 1, 1).data]);
      assert.deepEqual(pixel, { amber: [255, 191, 38, 255], teal: [19, 141, 134, 255], violet: [135, 83, 216, 255] }[fixture.expected.badge]);
      await page.emulateMedia({ colorScheme: 'light' });
      await waitForEvent(() => fixture.events.filter(e => e.kind === 'media' && e.scheme === 'light').length === 2);
    }
    assert.equal(gradeJob(input()).ok, true);
    assert.deepEqual(errors, []);
  });
});

test('BF2 headless initially dark profile is unavailable even after a dark-light cycle', { skip, timeout: 20000 }, async t => {
  const { page, fixture, waitForEvent, input } = await openFixture(t, 'job-dark', { colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await waitForEvent(e => e.kind === 'media' && e.scheme === 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await waitForEvent(() => fixture.events.filter(e => e.kind === 'media' && e.scheme === 'dark').length === 2);
  assert.deepEqual(gradeJob(input()).problems, ['JOB_FIXTURE_UNAVAILABLE']);
});

test('BF2 headless synthetic pointer events cannot move a card; moving it back invalidates a real drag', { skip, timeout: 20000 }, async t => {
  const { page, fixture, waitForEvent, input, origin } = await openFixture(t, 'job-kanban');
  await waitForEvent(() => fixture.kanban?.column === 'Queue');
  assert.equal(await page.evaluate(() => typeof emit), 'undefined');
  const grip = await page.locator('#grip').boundingBox(), review = await page.locator('#review').boundingBox();
  const target = { x: review.x + review.width / 2, y: review.y + review.height / 2 };
  const synthetic = () => page.evaluate(target => {
    const grip = document.querySelector('#grip');
    for (const [type, count] of [['pointerdown', 1], ['pointermove', 8], ['pointerup', 1]]) {
      for (let n = 0; n < count; n++) grip.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: target.x + n, clientY: target.y }));
    }
  }, target);
  await synthetic();
  assert.equal(await page.locator('#queue #card').count(), 1);
  assert.ok(!fixture.events.some(e => e.kind === 'drag'));
  // A real down plus synthetic moves and a real up must also fail the movement count.
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down(); await synthetic(); await page.mouse.up();
  assert.equal(await page.locator('#queue #card').count(), 1);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 }); await page.mouse.up();
  await waitForEvent(() => fixture.kanban?.column === 'Review');
  const readSite = () => page.evaluate(url => fetch(url).then(response => response.json()), `${origin}/${fixture.nonce}/api/log`);
  assert.equal(gradeJob({ ...input(), site: await readSite() }).ok, true);
  await page.evaluate(() => document.querySelector('#queue').append(document.querySelector('#card')));
  await waitForEvent(() => fixture.kanban?.column === 'Queue');
  assert.deepEqual(gradeJob({ ...input(), site: await readSite() }).problems, ['JOB_DRAG_NOT_PROVED']);
});

test('BF2 headless motion fetches only on trusted Play and completes every phase with rAF paused', { skip, timeout: 20000 }, async t => {
  const { page, fixture, requests, waitForEvent, input, errors } = await openFixture(t, 'job-motion', { pausedRaf: true });
  assert.equal(requests.filter(path => path.endsWith('/phases')).length, 0);
  assert.ok(!(await page.content()).includes(JSON.stringify(fixture.expected.phases)));
  await page.evaluate(() => {
    document.querySelector('#play').click();
    dispatchEvent(new Event('resize'));
    window.phasePaints = [];
    new MutationObserver(() => window.phasePaints.push(document.querySelector('#signal').style.background))
      .observe(document.querySelector('#signal'), { attributes: true, attributeFilter: ['style'] });
  });
  assert.equal(requests.filter(path => path.endsWith('/phases')).length, 0);
  assert.equal(fixture.events.length, 1, 'synthetic resize adds no media evidence');
  const play = await page.locator('#play').boundingBox();
  await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
  await waitForEvent(e => e.kind === 'motion');
  const palette = { amber: 'rgb(255, 191, 38)', teal: 'rgb(19, 141, 134)', violet: 'rgb(135, 83, 216)' };
  assert.deepEqual(await page.evaluate(() => phasePaints), [...fixture.expected.phases.map(color => palette[color]), 'rgb(119, 119, 119)']);
  assert.equal(requests.filter(path => path.endsWith('/phases')).length, 1);
  assert.equal(fixture.events.filter(e => e.kind === 'motion').length, 1);
  assert.equal(gradeJob(input()).ok, true);
  await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
  assert.equal(requests.filter(path => path.endsWith('/phases')).length, 1);
  assert.deepEqual(errors, []);
});
