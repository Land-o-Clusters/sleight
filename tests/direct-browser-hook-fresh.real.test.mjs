import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { testChromiumExecutable, launchTestChromiumContext, closeTestChromium } from './fixtures/chromium-isolated.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { callHook } from './adversarial/fixtures/hook.mjs';

// Expose the internal arm for a no-input check, without widening the product API.
const pageURL = new URL('../plugins/sleight/lib/direct-browser/page.mjs', import.meta.url);
let source = readFileSync(pageURL, 'utf8');
const variants = {
  'late-document-start': ['const source = hookSource(entry.hook);', 'const source = hookSource(entry.hook, { late: true });'],
  'live-install-fresh': ['expression: hookSource(entry.hook, { late: true })', 'expression: hookSource(entry.hook)'],
  'skip-navigation': ['() => page.goto(parsed.href, { waitUntil: \'domcontentloaded\', timeout: timeoutMs })', '() => Promise.resolve()'],
  'skip-key-freshness': ['node.id !== null && node.fresh === true', 'node.id !== null'],
  'refuse-key-arm': ['const found = await reached(timeoutMs);', 'const found = undefined;'],
};
if (process.env.SA2L_REAL_BROKEN_VARIANT) {
  const change = variants[process.env.SA2L_REAL_BROKEN_VARIANT];
  assert.ok(change && source.includes(change[0]), 'known real-browser mutation site');
  source = source.replace(change[0], change[1]);
}
source = source.replace(/from (['"])(\.[^'"]+)\1/g,
  (_, quote, path) => 'from ' + quote + new URL(path, pageURL).href + quote);
const { createPageRegistry, popupHook, keyFrames } = await import('data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { keyFrames };').toString('base64'));

const require = createRequire(import.meta.url);
const { inprocess } = require('../plugins/sleight/vendor/playwright-core/lib/coreBundle.js');
const executablePath = testChromiumExecutable();
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'needs the isolated headless DOM harness'
  : !existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;

test('SA2L about:blank navigation creates a fresh hook; handoff resume refuses a key-frame arm', { skip, timeout: 30000 }, async t => {
  const profile = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-hook-fresh-')));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Hook fixture</title><button type="button">Continue</button>');
  });
  let context, registry;
  t.after(async () => {
    try {
      await closeTestChromium(context, async () => {
        try { if (registry) assert.equal((await registry.endTurn()).cleanedUp, true); }
        finally { await context?.close(); }
      });
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      rmSync(profile, { recursive: true, force: true });
    }
    assert.equal(existsSync(profile), false);
    t.diagnostic('cleanup: owned browser closed, private profile removed, loopback server closed');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await launchTestChromiumContext(inprocess.playwright.chromium, profile, { executablePath, headless: true });
  const browser = context.browser(), session = await browser.newBrowserCDPSession();
  t.diagnostic('Chromium ' + browser.version() + ', headless shell, isolated temporary profile');
  // Mark the actual initial Window after the registry installs its late hook.
  // Navigation must discard this marker as well as that hook.
  const newCDPSession = context.newCDPSession.bind(context), initial = [];
  context.newCDPSession = async page => {
    const cdp = await newCDPSession(page), send = cdp.send.bind(cdp);
    cdp.send = async (method, params) => {
      const result = await send(method, params);
      if (method === 'Runtime.evaluate' && params.expression.startsWith('(' + popupHook) && page.url() === 'about:blank') {
        initial.push(page.url());
        await send('Runtime.evaluate', { expression: 'window.__sa2lInitialWindow = true' });
      }
      return result;
    };
    return cdp;
  };
  registry = createPageRegistry({ browser, context, session, timeoutMs: 5000, popupWaitMs: 5 });
  const { tab } = await registry.openTab({ url: 'http://127.0.0.1:' + server.address().port + '/honest' });
  const entry = registry.tab(tab);
  assert.deepEqual(initial, ['about:blank']);
  assert.equal(await entry.page.evaluate(() => window.__sa2lInitialWindow), undefined, 'initial Window state was discarded');
  assert.equal((await callHook(entry, 'api.info()')).fresh, true);
  const attempt = async () => {
    const frames = keyFrames(entry, entry.page.mainFrame(), { hook: entry.hook, token: 'sa2l-arm', capMs: 5000, timeoutMs: 1000 });
    try { return await frames.arm(); }
    finally { await frames.release(); }
  };
  assert.equal(await attempt(), true);
  t.diagnostic('honest: initial Window discarded, fresh=true, key-frame arm succeeded, input dispatches=0');
  const handoff = await registry.beginHandoff(tab);
  await handoff.finish(false);
  assert.equal((await callHook(entry, 'api.info()')).fresh, false);
  await assert.rejects(attempt(), error => error.code === 'KEY_FRAMES');
  t.diagnostic('late handoff resume: fresh=false, key-frame arm refused, input dispatches=0');
});
