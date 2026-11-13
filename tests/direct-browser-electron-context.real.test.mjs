import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, realpathSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { check } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { createAppBinding } from '../plugins/sleight/lib/direct-browser/electron-identity.mjs';
import { instance } from './fixtures/electron-app.mjs';
// Real headless Chromium on file: pages stand in for an Electron renderer's app documents. They prove the page-reported
// origin of a file document and the join end to end. No Electron app is launched. Runs through the host runner.
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'real-page app document qualification runs through sleight-arch host runner' : false;
const terms = { item: 'Fixture item', amount: '18.00', payee: 'Fixture shop', method: 'Fixture card', currency: 'USD' };
const html = `<main><form id="payment"><p data-payment-item="Fixture item">Item: Fixture item</p><p data-payment-amount="18.00">Amount: 18.00</p>
<p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>
<button id="e1" aria-label="Continue">Pay $18 now</button></form><form id="upload"><label>Resume<input id="e4" type="file"></label></form><output id="count">0</output>
<script>document.querySelector('#payment').onsubmit = event => {event.preventDefault(); document.querySelector('#count').textContent++;};</script></main>`;
async function fixture(t, text, { rootOffset = '' } = {}) {
  const { chromium } = await import('../plugins/sleight/vendor/playwright-core/index.mjs');
  const spec = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url))).browsers.find(b => b.name === 'chromium-headless-shell');
  const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
  const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision, 'chrome-headless-shell-' + platform, 'chrome-headless-shell');
  assert.ok(existsSync(executablePath), 'pinned headless Chromium required; host tests must not skip');
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'epv3-app-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'app')); mkdirSync(join(dir, 'elsewhere'));
  for (const name of ['app/a.html', 'app/b.html', 'elsewhere/c.html']) writeFileSync(join(dir, name), html);
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); });
  const page = await (await browser.newContext()).newPage(); await page.goto(pathToFileURL(join(dir, 'app/a.html')).href);
  page.getByRef = ref => page.locator('#' + ref);
  let active = true, clock = Date.now();
  const app = createAppBinding({ instance, window: { id: 1, epoch: 1 }, brokerEpoch: 1, recipe: { schemes: [], fileRoots: [join(dir, 'app') + rootOffset] },
    authority: { id: 'grant', session: 'session', turn: null, current: () => active } });
  const binding = createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text }, () => active);
  const ctx = createV3Context({ binding, app, now: () => clock }); t.after(() => ctx.dispose());
  const tab = { page, state: { snapshotNo: 0, submitUnconfirmed: false } };
  const runSteps = createActionRunner({ check, snapshot: async () => ({ text: 'Untrusted fixture page', number: 1 }), now: () => clock, sleep: async ms => { clock += ms; } });
  const target = (ref, extra = {}) => ({ page, locator: page.getByRef(ref), ref, state: tab.state, ...extra });
  return { page, ctx, tab, runSteps, target, dir, app, go: name => page.goto(pathToFileURL(join(dir, name)).href), revoke() { active = false; } };
}
test('real file documents report an opaque origin and still get distinct app-document identities', { skip }, async t => {
  const f = await fixture(t, 'Read only'), reported = [];
  for (const name of ['app/a.html', 'app/b.html']) {
    await f.go(name); reported.push(await f.page.evaluate(() => location.origin));
    const target = f.target('e1');
    assert.equal((await f.ctx.check('click', target)).verdict, 'confirm', name); reported.push(target.origin);
  }
  t.diagnostic('headless Chromium reports location.origin ' + JSON.stringify(reported[0]) + ' for a file document');
  assert.ok(['null', 'file://'].includes(reported[0]), 'Chromium reports ' + reported[0]); assert.equal(reported[0], reported[2], 'both files report the same origin string');
  assert.match(reported[1], /^app-document:v1:[0-9a-f]{64}$/); assert.match(reported[3], /^app-document:v1:[0-9a-f]{64}$/); assert.notEqual(reported[1], reported[3]);
});
test('real exact request pays once on an app document and a changed term confirms', { skip }, async t => {
  const f = await fixture(t, 'Pay ' + JSON.stringify(terms));
  await f.page.locator('[data-payment-amount]').evaluate(el => { el.setAttribute('data-payment-amount', '19.00'); el.textContent = 'Amount: 19.00'; });
  assert.equal((await f.ctx.check('click', f.target('e1'))).verdict, 'confirm');
  await f.page.locator('[data-payment-amount]').evaluate(el => { el.setAttribute('data-payment-amount', '18.00'); el.textContent = 'Amount: 18.00'; });
  const result = await f.runSteps(f.tab, [{ do: 'click', ref: 'e1' }], f.ctx);
  assert.doesNotMatch(result.lines[0], /not run|effect unconfirmed/); assert.equal(await f.page.locator('#count').innerText(), '1');
});
test('real upload transfers exact bytes on an app document and refuses once the frame moves to another file', { skip }, async t => {
  const f = await fixture(t, 'x'); const path = join(f.dir, 'resume.txt'); writeFileSync(path, 'fixture upload bytes');
  const upload = await createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'upload', text: `Upload "${path}" to Resume` }, () => true);
  const ctx = createV3Context({ binding: upload, app: f.app }); t.after(() => ctx.dispose());
  const runSteps = createActionRunner({ check, snapshot: async () => ({ text: 'fixture', number: 1 }), now: Date.now, sleep: async () => {} });
  const result = await runSteps(f.tab, [{ do: 'upload', ref: 'e4', paths: [path] }], ctx);
  assert.doesNotMatch(result.lines[0], /not run|effect unconfirmed/);
  assert.equal(await f.page.locator('#e4').evaluate(el => el.files[0].text()), 'fixture upload bytes');
  await f.go('app/b.html'); assert.equal((await ctx.check('upload', f.target('e4', { paths: [path] }))).verdict, 'refuse');
});
test('real file outside the recipe root and a revoked grant are refused', { skip }, async t => {
  const f = await fixture(t, 'Pay ' + JSON.stringify(terms));
  await f.go('elsewhere/c.html'); assert.equal((await f.ctx.check('click', f.target('e1'))).verdict, 'refuse');
  await f.go('app/a.html'); assert.equal((await f.ctx.check('click', f.target('e1'))).verdict, 'allow');
  f.revoke(); assert.equal((await f.ctx.check('click', f.target('e1'))).verdict, 'refuse'); assert.equal(await f.page.locator('#count').innerText(), '0');
});
