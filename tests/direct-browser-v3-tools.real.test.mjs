import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium');
const executablePath = process.platform === 'darwin'
  ? join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + pin.revision, 'chrome-mac-' + process.arch,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  : join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + pin.revision, 'chrome-linux64/chrome');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'needs SLEIGHT_LIVE_DOM_TEST=1 through the host runner'
  : !existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;
test('five-tool dispatcher routes an owned local form and collects page resources', { skip, timeout: 30000 }, async () => {
  const server = createServer((req, res) => { res.end('<!doctype html><title>Local form</title><form><label>Name<input name="name"></label><button>Save</button></form><p id="state">Ready</p><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();document.querySelector("#state").textContent="Saved "+document.querySelector("input").value}</script>'); });
  let browser, context, dispatcher;
  const records = new Map();
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, executablePath }); context = await browser.newContext();
    const pages = { async openTab({ url }) {
      const page = await context.newPage(); await page.goto(url);
      records.set('t1', { page, state: { snapshotNo: 0, submitUnconfirmed: false } }); return { tab: 't1' };
    }, tab(id) { assert.ok(records.has(id)); return records.get(id); },
    enqueue: (id, run) => run(pages.tab(id)),
    list: async () => [...records].map(([tab, entry]) => ({ tab, url: entry.page.url() })),
    async close(id) { await pages.tab(id).page.close(); records.delete(id); return { closed: true }; },
    async endTurn() { await context.close(); return { cleanedUp: true, rows: [] }; } };
    const locator = (page, ref) => ref === 'e1' ? page.getByRole('textbox', { name: 'Name' }) : ref === 'e2' ? page.getByRole('button', { name: 'Save' }) : assert.fail('unsupported fixture ref');
    let number = 0;
    const snapshot = async page => ({ text: 'Untrusted local state:\n' + await page.locator('body').innerText(), number: ++number });
    dispatcher = createToolDispatcher({ browser: 'bfixture', pages, snapshot,
      async runSteps(entry, steps) {
        const lines = [];
        for (const step of steps) {
          if (step.do === 'type') await locator(entry.page, step.ref).fill(step.text);
          else if (step.do === 'click') await locator(entry.page, step.ref).click();
          else assert.fail('unsupported fixture action');
          lines.push(step.do + ': done');
        }
        return { lines, observe: { ...await snapshot(entry.page), capturedAt: Date.now() } };
      },
      async fillFields(entry, fields, { submit }) {
        for (const field of fields) await locator(entry.page, field.ref).fill(field.value);
        if (submit) await locator(entry.page, submit).click();
        return { rows: fields.map(field => ({ ref: field.ref, status: 'set' })), submitted: { status: 'done' } };
      } });
    const call = async (name, args) => { const result = await dispatcher.call({ name, arguments: args }); assert.equal(result.isError, false, result.text); dispatcher.delivered(result); return result.text; };
    assert.match(await call('browser_open', { url: `http://127.0.0.1:${server.address().port}` }), /t1.*Local form/s);
    assert.match(await call('browser_fill', { tab: 't1', fields: [{ ref: 'e1', value: 'Ada' }], submit: 'e2' }), /Saved Ada/);
    assert.match(await call('browser_read', { tab: 't1', find: 'Saved' }), /Saved Ada/);
    assert.match(await call('browser_act', { tab: 't1', steps: [{ do: 'type', ref: 'e1', text: 'Grace' }, { do: 'click', ref: 'e2' }] }), /Saved Grace/);
    assert.match(await call('browser_tabs', { do: 'list' }), /t1/);
    await call('browser_tabs', { do: 'close', tab: 't1' });
    assert.equal(records.size, 0);
    assert.deepEqual(await dispatcher.end(), { revoked: true, cleanup: [] });
  } finally {
    await context?.close(); await browser?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
