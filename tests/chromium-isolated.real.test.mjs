import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { launchTestChromium } from './fixtures/chromium-isolated.mjs';

const skip = process.platform !== 'darwin' ? 'Mac sandbox control' :
  process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'requires the quiet headless real-page window';

test('a real page attempts an external protocol while its browser PID is denied OS opens', { skip, timeout: 30000 }, async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-browser-sandbox-control-')));
  let browser;
  try {
    const checker = join(root, 'sandbox-check');
    execFileSync('xcrun', ['clang', fileURLToPath(new URL('./fixtures/chromium-sandbox-check.c', import.meta.url)),
      '-o', checker, '-lsandbox'], { timeout: 30000, killSignal: 'SIGKILL' });
    browser = await launchTestChromium(chromium);
    const browserCdp = await browser.newBrowserCDPSession();
    const processes = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;
    const pid = processes.find(info => info.type === 'browser')?.id;
    assert.ok(Number.isInteger(pid) && pid > 0);
    const denied = () => {
      const actual = JSON.parse(execFileSync(checker, [String(pid)], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' }));
      assert.deepEqual(actual, { openServiceDenied: true, lsopenDenied: true, appleEventsDenied: true, registrationAllowed: true });
      return actual;
    };
    // Check the actual browser process before navigating, not a sibling probe.
    // A missing sandbox or inaccessible PID fails before any protocol attempt.
    denied();
    const context = await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('data:text/html,<title>Protocol positive control</title><p>Local fixture</p>');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    const scheme = 'sleight-unregistered-mt2-control://blocked/';
    const attempted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('external protocol navigation was not observed')), 5000);
      cdp.on('Page.frameRequestedNavigation', event => {
        if (event.url === scheme) { clearTimeout(timer); resolve(event); }
      });
    });
    // No product guard or hook suppresses this attempt. The only app-opening
    // boundary under test is the effective sandbox on the browser PID.
    await page.evaluate(url => location.assign(url), scheme);
    const event = await attempted;
    const permissions = denied();
    assert.equal(event.reason, 'scriptInitiated');
    assert.match(page.url(), /^data:text\/html,/);
    t.diagnostic(JSON.stringify({ browserPid: pid, navigation: event.url, permissions }));
    await cdp.detach();
    await browserCdp.detach();
  } finally {
    try { await browser?.close(); } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
