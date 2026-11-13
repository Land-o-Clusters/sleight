// IN1's design boundary on a real page: Playwright resolves aria-ref against the latest aria snapshot taken in a frame,
// whoever took it. A read the model never sees (a background prefetch that gets discarded) can retire a ref the model
// already holds: a button that is briefly renamed during that read gets a new ref, and the old one stops resolving.
// RM1 makes sleight's ref check refuse such a ref at once with a re-read hint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { snapshot, acknowledgeSnapshot, snapshotRefBinding } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';

const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = !live ? 'real-page qualification belongs to sleight-arch host runner'
  : !existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;

const HTML = `<main><button id="save">Save</button><button>Other</button></main>
<script>window.rename = name => { document.getElementById('save').textContent = name; };</script>`;

async function fixture(t) {
  const sockets = new Set();
  const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(HTML); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  return page;
}
// The model's view: a delivered read and the ref it shows for Save.
async function delivered(page) {
  const read = await snapshot(page);
  assert.equal(acknowledgeSnapshot(page, read.number), true);
  return /button "Save" \[ref=([^\]]+)\]/.exec(read.text)[1];
}

test('without a hidden read, a held ref survives a transient rename', { skip, timeout: 30000 }, async t => {
  const page = await fixture(t), ref = await delivered(page);
  await page.evaluate(() => window.rename('Saving'));
  await page.evaluate(() => window.rename('Save'));
  assert.equal(await snapshotRefBinding(page, ref).count(), 1);
});

test('a hidden read during a transient rename retires the held ref, and sleight refuses it at once', { skip, timeout: 30000 }, async t => {
  const page = await fixture(t), ref = await delivered(page);
  await page.evaluate(() => window.rename('Saving'));
  const hidden = await snapshot(page); // never acknowledged, as a discarded prefetch or a find read's other rows are
  assert.match(hidden.text, /button "Saving" \[ref=/);
  assert.doesNotMatch(hidden.text, new RegExp('button "Saving" \\[ref=' + ref + '\\]'));
  await page.evaluate(() => window.rename('Save'));
  // Inside Playwright the ref resolves to nothing (first-generation public refs equal the raw ones)...
  assert.equal(await page.locator('aria-ref=' + ref).count(), 0);
  // ...and sleight's own check now says so instead of letting the action wait for its locator.
  assert.throws(() => snapshotRefBinding(page, ref), /changed on the page since it was read; use browser_read again/);
});

// RM1: a moved ref never lands on another element. Playwright mints refs from one counter per document and never reuses
// one, so after two buttons swap names both held refs resolve to nothing, never to the other button.
test('after two controls swap names under a hidden read, neither held ref reaches the other control', { skip, timeout: 30000 }, async t => {
  const page = await fixture(t), first = await snapshot(page);
  assert.equal(acknowledgeSnapshot(page, first.number), true);
  const save = /button "Save" \[ref=([^\]]+)\]/.exec(first.text)[1], other = /button "Other" \[ref=([^\]]+)\]/.exec(first.text)[1];
  await page.evaluate(() => { const [a, b] = document.querySelectorAll('button'); a.textContent = 'Other'; b.textContent = 'Save'; });
  const hidden = await snapshot(page);
  for (const ref of [save, other]) {
    assert.doesNotMatch(hidden.text, new RegExp('\\[ref=' + ref + '\\]'));
    assert.equal(await page.locator('aria-ref=' + ref).count(), 0);
    assert.throws(() => snapshotRefBinding(page, ref), /changed on the page/);
  }
});
