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
  await t.test('a cut continuation ends in a complete rendered view', async () => {
    await page.setContent('<main>' + Array.from({ length: 90 }, (_, i) => `<button>Choice ${i}</button>`).join('') + '</main>');
    let result = await snapshot(page, { maxChars: 1000 }), reads = 1;
    assert.match(result.text, /# cut at 1000 chars; Continue with ref=/);
    while (!result.text.endsWith('# complete (returned view)')) {
      assert.ok(reads++ < 20);
      assert.ok(result.text.length <= 1000);
      const ref = /Continue with ref="([^"]+)"/.exec(result.text)?.[1];
      assert.ok(ref);
      result = await snapshot(page, { ref, maxChars: 1000 });
    }
  });
});
