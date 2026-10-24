import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { snapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { pickFromList } from '../plugins/sleight/lib/pick-from-list.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(row => row.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'headless DOM tests are opt-in'
  : !existsSync(executablePath) ? 'pinned headless Chromium unavailable' : false;

test('honest reads and selection on a loopback page in headless Chromium', { skip }, async t => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<main><h1>Fixture</h1><div role="grid" aria-rowcount="100">
      <div role="row" aria-rowindex="1">Visible row</div>
      <div role="row" aria-rowindex="2" hidden>Hidden row</div></div>
      <div role="listbox" aria-label="Choices" aria-setsize="50">
        <div role="option" aria-selected="false">Alpha</div>
        <div role="option" aria-selected="false">Beta</div>
        <div role="option" aria-selected="false">Gamma</div></div></main>
      <script>document.querySelectorAll('[role=option]').forEach(row => row.onclick = () => row.setAttribute('aria-selected','true'));</script>`);
  });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);

  await t.test('virtual totals exclude hidden rows and name the source of the total', async () => {
    const result = await snapshot(page);
    assert.match(result.text, /# 146 rows not rendered \(page-declared total\)$/);
    assert.doesNotMatch(result.text, /Hidden row/);
  });
  await t.test('a successful pick reports selection readback separately from collection completeness', async () => {
    const result = await pickFromList({ playwright: page, cua: { scroll: async () => { throw Error('unexpected scroll'); } } }, 'Choices', 'Beta');
    assert.equal(result.verified, true);
    assert.match(result.completeness, /complete \(selection readback\); 47 rows not rendered/);
  });
  await t.test('page declarations on virtual options are recognized', async () => {
    await page.setContent('<div role="listbox"><div role="option" aria-setsize="10" aria-posinset="4">Fourth</div></div>');
    assert.match((await snapshot(page)).text, /# 9 rows not rendered/);
  });
  await t.test('a cut continuation ends in a filtered view', async () => {
    await page.setContent('<main>' + Array.from({ length: 90 }, (_, i) => `<button>Choice ${i}</button>`).join('') + '</main>');
    let result = await snapshot(page, { maxChars: 1000 }), reads = 1;
    assert.match(result.text, /# cut at 1000 chars; Continue with ref=/);
    while (!result.text.endsWith('# complete (filtered view)')) {
      assert.ok(reads++ < 20);
      assert.ok(result.text.length <= 1000);
      const ref = /Continue with ref="([^"]+)"/.exec(result.text)?.[1];
      assert.ok(ref);
      result = await snapshot(page, { ref, maxChars: 1000 });
    }
  });
  await t.test('closed shadow roots expose controls and state the missing content scope', async () => {
    await page.setContent('<custom-control></custom-control>');
    await page.evaluate(() => {
      document.querySelector('custom-control').attachShadow({ mode: 'closed' }).innerHTML =
        '<p>Unreturned closed-root prose</p><button>Closed button</button>';
    });
    const result = await snapshot(page);
    assert.match(result.text, /Closed button/);
    assert.doesNotMatch(result.text, /Unreturned closed-root prose/);
    assert.match(result.text, /closed shadow roots: controls only/);
  });
  await t.test('plain iframe lists omit the lazy-row warning', async () => {
    await page.setContent('<main><iframe srcdoc="<ul><li>Rendered item</li></ul>"></iframe></main>');
    await page.frameLocator('iframe').getByText('Rendered item').waitFor();
    const result = await snapshot(page);
    assert.match(result.text, /Rendered item/);
    assert.match(result.text, /# complete \(returned view\)$/);
    assert.doesNotMatch(result.text, /lazy\/virtual/);
  });
  await t.test('lists inside scrolling containers retain unknown lazy-row scope', async () => {
    await page.setContent('<div style="overflow:auto;height:50px"><ul>' +
      Array.from({ length: 20 }, (_, i) => `<li>Item ${i}</li>`).join('') + '</ul></div>');
    assert.match((await snapshot(page)).text, /lazy\/virtual rows unknown/);
  });
  await t.test('delta reads and find continuation chunks keep their scope on a real page', async () => {
    await page.setContent('<main><button>Before</button></main>');
    const first = await snapshot(page);
    await page.getByRole('button').evaluate(node => { node.textContent = 'After'; });
    assert.match((await snapshot(page, { since: first.number })).text, /# complete \(changes only\)$/);
    await page.setContent('<main>' + Array.from({ length: 80 }, (_, i) => `<button>Choice ${i}</button>`).join('') + '</main>');
    let result = await snapshot(page, { find: 'Choice', maxChars: 1000 }), chunks = 0;
    for (;;) {
      const ref = /Continue with ref="([^"]+)"/.exec(result.text)?.[1];
      if (!ref) break;
      assert.ok(chunks++ < 20);
      result = await snapshot(page, { ref, maxChars: 1000 });
    }
    assert.ok(chunks > 0);
    assert.match(result.text, /# complete \(filtered view\)$/);
  });
});
