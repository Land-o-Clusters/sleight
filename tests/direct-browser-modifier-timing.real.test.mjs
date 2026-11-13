import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'modifier timing belongs to sleight-arch host runner'
  : !existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;

test('CR2 measures 20 ControlOrMeta keydown-to-click intervals on a local page', { skip, timeout: 90000 }, async t => {
  const sockets = new Set();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<button>Measure</button><script>
      window.intervals = [];
      window.addEventListener('keydown', event => {
        if (event.key === 'Meta' || event.key === 'Control') window.started = performance.now();
      });
      document.querySelector('button').onclick = () => window.intervals.push(performance.now() - window.started);
    </script>`);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    t.diagnostic('cleanup: timing browser closed; local server and sockets closed; no persistent profile');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  for (let i = 0; i < 20; i++) await page.getByRole('button', { name: 'Measure' }).click({ modifiers: ['ControlOrMeta'], timeout: 1000 });
  const samplesMs = await page.evaluate(() => window.intervals);
  assert.equal(samplesMs.length, 20);
  assert.ok(samplesMs.every(ms => Number.isFinite(ms) && ms >= 0 && ms < 1000));
  const maxMs = Math.max(...samplesMs);
  t.diagnostic('CR2 modifier timing ' + JSON.stringify({ samplesMs, maxMs, capMs: 1000,
    proposedWindowMs: Math.ceil((maxMs * 2 + 50) / 100) * 100 }));
  assert.ok(maxMs < 100, 'the measured clicks must fit the chosen 100 ms masking window');
});
