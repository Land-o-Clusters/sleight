import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { loadPlaywrightCore } from '../plugins/sleight/lib/direct-browser/worlds.mjs';

const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'requires the owned headless Chromium';

test('a hidden frame with held animation callbacks uses the host timer fallback', { skip, timeout: 15000 }, async t => {
  const spec = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
    .browsers.find(b => b.name === 'chromium-headless-shell');
  const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
  const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision,
    'chrome-headless-shell-' + platform, 'chrome-headless-shell');
  const runtime = loadPlaywrightCore({ turbo: true });
  const browser = await runtime.inprocess.playwright.chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<iframe hidden srcdoc="<p>Hidden page</p>"></iframe>');
  assert.equal(await page.locator('iframe').isVisible(), false);
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  assert.ok(frame, 'hidden frame missing');
  // Hold callbacks in the browser to reproduce frame suspension independently of host throttling.
  await frame.evaluate(() => { window.heldFrames = []; window.requestAnimationFrame = callback => window.heldFrames.push(callback); });
  // Route the settle evaluation to the actual hidden document. Viewport changes still use the owned Page.
  page.evaluate = frame.evaluate.bind(frame);
  const run = createActionRunner({ check: () => 'allow', snapshot: () => assert.fail('observe:none must skip its read') });
  const start = performance.now();
  const result = await run({ page, state: { snapshotNo: 0 } }, [{ do: 'viewport', width: 390, height: 844 }], {}, { observe: 'none' });
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs < 1500, `hidden viewport took ${elapsedMs} ms`);
  assert.equal(await frame.evaluate(() => window.heldFrames.length), 1);
  assert.equal(result.observe, undefined);
  t.diagnostic(JSON.stringify({ hiddenFrame: true, elapsedMs, heldFrames: 1 }));
});
