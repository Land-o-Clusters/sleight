import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { snapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { hookSource, backgroundClick, newHook } from '../plugins/sleight/lib/direct-browser/page.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'CR3 measurements belong to sleight-arch host runner'
  : !existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;

test('CR3 measures 20 snapshot reads per shape and 20 plain prepare+click calls', { skip, timeout: 120000 }, async t => {
  const simple = '<main><h1>Latency fixture</h1><label>City<input value="Portland"></label><button>Continue</button></main>';
  const routes = {
    '/simple': simple,
    '/frames': '<main>' + Array.from({ length: 5 }, () => '<iframe src="/simple"></iframe>').join('') + '</main>',
    '/closed': '<custom-controls></custom-controls><script>document.querySelector("custom-controls").attachShadow({mode:"closed"})'
      + '.innerHTML = ' + JSON.stringify('<button>Closed command</button><input aria-label="Private field" value="fixture-secret">') + ';</script>',
    '/click': '<button>Increment</button><output>0</output><script>window.count = 0;document.querySelector("button").onclick = event => {'
      + 'window.modifiers = [event.ctrlKey,event.metaKey];document.querySelector("output").textContent = ++window.count;};</script>',
  };
  const sockets = new Set(), server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html'); response.end(routes[request.url] ?? simple);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    t.diagnostic('cleanup: measurement browser, local server and sockets closed; no persistent profile');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage(), origin = 'http://127.0.0.1:' + server.address().port;
  const measurements = {};
  const measure = async (name, action) => {
    await action(); // Same warm-up on both revisions; not counted.
    const samplesMs = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now(); await action(); samplesMs.push(performance.now() - start);
    }
    const sorted = samplesMs.toSorted((a, b) => a - b);
    measurements[name] = { n: 20, medianMs: (sorted[9] + sorted[10]) / 2, p90Ms: sorted[17] };
    t.diagnostic('CR3 samples ' + JSON.stringify({ name, samplesMs }));
  };
  for (const name of ['simple', 'frames', 'closed']) {
    await page.goto(origin + '/' + name); await page.waitForLoadState('load');
    await measure(name, async () => {
      const result = await snapshot(page);
      assert.match(result.text, /Snapshot/); assert.doesNotMatch(result.text, /fixture-secret/);
    });
  }
  const hook = newHook();
  await page.goto(origin + '/click'); assert.equal(await page.evaluate(hookSource(hook)), true);
  const locator = page.getByRole('button', { name: 'Increment' });
  await measure('plainClick', () => backgroundClick({ page, hook }, locator));
  assert.deepEqual(await page.evaluate(() => ({ count: window.count, modifiers: window.modifiers })),
    { count: 21, modifiers: [false, false] });
  t.diagnostic('CR3 latency ' + JSON.stringify({ platform: process.platform, arch: process.arch, measurements }));
});
