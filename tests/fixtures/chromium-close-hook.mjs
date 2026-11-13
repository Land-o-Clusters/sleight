// Runs only as a subprocess of chromium-close.test.mjs, with no real browser.
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { boundTestChromium } from './chromium-close.mjs';

test('fake Chromium teardown', async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./chromium-close-child.mjs', import.meta.url))],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const browser = { contexts: () => [], async newContext() { throw Error('unused'); },
    async close() {
      if (process.env.SLEIGHT_TEST_CLOSE_HANG === '1') return new Promise(() => {});
      child.stdin.end(); await exited;
    } };
  boundTestChromium(browser, child, { timeoutMs: 100 });
  t.after(async () => {
    try { await browser.close(); }
    finally { child.stdin.end(); await exited; }
  });
  await once(child.stdout, 'data');
});
