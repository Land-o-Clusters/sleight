// Headless loopback fixtures only. No engine, installed browser profile or native UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { newHook, hookSource } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { readWhole } from '../plugins/sleight/lib/direct-browser/whole.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright',
  'chromium_headless_shell-' + pin.revision, 'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'requires headless fixture opt-in' :
  !existsSync(executablePath) ? 'pinned headless shell unavailable' : false;
const fixtureFiles = new Map(['chat.html', 'feed.html', 'virtual.html', 'fixture.js', 'fixture.css']
  .map(name => ['/' + name, readFileSync(new URL('../bench/threads/' + name, import.meta.url))]));
const ids = text => new Set([...text.matchAll(/row-(\d{4})/g)].map(match => Number(match[1])));
const itemLines = text => [...text.matchAll(/^item (\d+) of (\d+): (.+)$/gm)]
  .map(match => ({ index: Number(match[1]), text: JSON.parse(match[3]) }));

async function fixture(t, kind) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    const file = fixtureFiles.get(req.url);
    res.writeHead(file ? 200 : 404, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(file);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } }), hook = newHook();
  await context.addInitScript({ content: hookSource(hook) });
  const page = await context.newPage(), url = `http://127.0.0.1:${server.address().port}/${kind}.html`;
  // No external resources are permitted, even if a fixture is edited later.
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  await page.goto(url);
  let steps = 0;
  const wheel = page.mouse.wheel.bind(page.mouse);
  page.mouse.wheel = (...args) => { steps++; return wheel(...args); };
  return { page, url, context, requests, entry: { page, hook, state: {}, popups: [] }, steps: () => steps };
}

for (const kind of ['chat', 'feed', 'virtual']) test('TL1 coverage: ' + kind, { skip, timeout: 150000 }, async t => {
  const h = await fixture(t, kind), total = kind === 'virtual' ? 1000 : 100;
  const started = performance.now(), plain = await snapshot(h.page);
  const baseline = { rows: ids(plain.text).size, fraction: ids(plain.text).size / total,
    steps: h.steps(), ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(plain.text) };
  assert.ok(baseline.rows > 0 && baseline.rows < total);
  assert.equal(baseline.steps, 0);
  assert.equal(await h.page.evaluate(() => fixtureStats.loads), 0);
  const wholeStarted = performance.now();
  // Leave room above the 1,000-row fixture to prove both ends before the item cap.
  const whole = await readWhole(h.entry, { max_items: 1100, max_seconds: 110 });
  const metric = { fixture: kind, total, baseline, whole: { acquired: Number(/Items read: (\d+)/.exec(whole.text)?.[1]),
    firstResponseRows: ids(whole.text).size, firstResponseFraction: ids(whole.text).size / total,
    steps: h.steps(), ms: Math.round(performance.now() - wholeStarted), bytes: Buffer.byteLength(whole.text),
    complete: whole.text.includes('Complete: yes.') } };
  console.log('TL1 ' + JSON.stringify(metric));
  assert.match(whole.text, /Complete: yes\./, whole.text.slice(0, 1000));
  assert.equal(metric.whole.acquired, total);
  assert.match(whole.text, new RegExp(`Steps: ${metric.whole.steps}\\.`));
  const held = new Map(itemLines(whole.text).map(row => [row.index, row.text]));
  let text = whole.text, responses = 1, totalBytes = metric.whole.bytes, lastFrom = 0;
  while (/More held items: whole.from=(\d+)/.test(text)) {
    const from = Number(/More held items: whole.from=(\d+)/.exec(text)[1]);
    assert.ok(from > lastFrom, 'held transcript pagination advances'); lastFrom = from;
    text = (await readWhole(h.entry, { from })).text;
    for (const row of itemLines(text)) held.set(row.index, row.text);
    totalBytes += Buffer.byteLength(text); responses++;
    assert.ok(responses <= 20);
  }
  assert.deepEqual([...held].sort((a, b) => a[0] - b[0]).map(([index, value]) => [index, [...ids(value)][0]]),
    Array.from({ length: total }, (_, i) => [i + 1, i + 1]));
  console.log('TL1 held ' + JSON.stringify({ fixture: kind, responses, totalBytes, rows: held.size, steps: h.steps() }));
  assert.equal(h.page.url(), h.url);
  assert.equal(h.context.pages().length, 1);
  assert.equal(h.requests.filter(request => request.method !== 'GET').length, 0);
  assert.equal(h.requests.filter(request => !fixtureFiles.has(request.path)).length, 0);
  assert.equal(metric.whole.steps, h.steps(), 'held continuations never scroll');
  if (kind === 'virtual') assert.equal(await h.page.locator('article').count(), 32, 'recycled DOM stays bounded');
});

test('TL1 loader scope and scroll-step cap', { skip, timeout: 15000 }, async t => {
  const h = await fixture(t, 'feed');
  await h.page.evaluate(() => {
    window.pressed = [];
    const thread = document.querySelector('#thread');
    const sidebar = document.createElement('aside');
    sidebar.innerHTML = '<button type="button">Load more</button>';
    document.body.prepend(sidebar);
    sidebar.querySelector('button').onclick = () => pressed.push('sidebar');
    thread.insertAdjacentHTML('afterbegin', '<button type="button" id="older">Load older messages</button><a href="/never">Show more</a><form><button>Show more</button></form>');
    document.querySelector('#older').onclick = event => { pressed.push('older'); event.currentTarget.remove(); };
    thread.querySelector('form').onsubmit = event => { pressed.push('submit'); event.preventDefault(); };
  });
  const result = await readWhole(h.entry, { direction: 'up', max_steps: 1, max_seconds: 10 });
  assert.match(result.text, /Complete: NO\./);
  assert.match(result.text, /step cap/);
  assert.match(result.text, /Steps: 1\./);
  assert.match(result.text, /Clicks: 1\./);
  assert.match(result.text, /Show more \(link\)/);
  assert.match(result.text, /Show more \(form or submit\)/);
  assert.deepEqual(await h.page.evaluate(() => pressed), ['older']);
  assert.equal(h.steps(), 1);
  const rows = itemLines(result.text);
  assert.ok(rows.length > 0, 'the step cap keeps the rows already read');
  const held = await readWhole(h.entry, { from: 1 });
  assert.deepEqual(itemLines(held.text), rows, 'whole.from returns the capped transcript');
  assert.match(held.text, /step cap/);
  assert.equal(h.steps(), 1, 'paging the capped transcript never scrolls');
  assert.equal(h.page.url(), h.url);
  assert.equal(h.context.pages().length, 1);
  assert.equal(h.requests.filter(request => !fixtureFiles.has(request.path) || request.method !== 'GET').length, 0);
});

for (const bound of [false, true]) test('TL1 bare-div scroller inside main never clicks a sidebar loader ' + (bound ? 'with a ref' : 'without a ref'), { skip, timeout: 15000 }, async t => {
  const h = await fixture(t, 'feed');
  await h.page.evaluate(() => {
    window.pressed = [];
    document.body.innerHTML = '<main style="display:flex"><div id="bare" style="width:780px;height:560px;overflow:auto"></div><aside><button type="button">Load more</button></aside></main>';
    const box = document.querySelector('#bare');
    for (let n = 1; n <= 80; n++) {
      const row = document.createElement('div');
      row.style.height = '24px';
      row.dataset.messageId = String(n);
      row.textContent = `plain row ${n}`;
      if (n === 1) row.innerHTML += '<button type="button">Thread anchor</button>';
      box.append(row);
    }
    document.querySelector('aside button').onclick = () => pressed.push('sidebar');
  });
  // Bind the bare scroller through a delivered child ref, without adding list roles.
  let ref;
  if (bound) {
    const plain = await snapshot(h.page);
    ref = /button "Thread anchor" \[ref=(e\d+)\]/.exec(plain.text)?.[1];
    assert.ok(ref, plain.text);
    acknowledgeSnapshot(h.page, plain.number);
  }
  const result = await readWhole(h.entry, { direction: 'down', max_steps: 1, max_seconds: 10 }, { ref });
  assert.match(result.text, /step cap/);
  assert.deepEqual(await h.page.evaluate(() => pressed), []);
  assert.ok(itemLines(result.text).some(row => row.text.startsWith('plain row ')), result.text);
  assert.match(result.text, /Clicks: 0\./);
  assert.equal(h.steps(), 1);
  assert.equal(h.page.url(), h.url);
  assert.equal(h.context.pages().length, 1);
  assert.equal(h.requests.filter(request => !fixtureFiles.has(request.path) || request.method !== 'GET').length, 0);
});
