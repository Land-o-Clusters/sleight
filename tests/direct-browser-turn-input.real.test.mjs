import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, skip } from './adversarial/fixtures/bank.mjs';
import { pendingTabNote } from '../plugins/sleight/lib/browser-turn-input.mjs';

// Loopback fixtures in Playwright's disposable headless Chromium only. The bank
// uses the real CDP filter, registry, hook, snapshot and turn dispatcher.
const signin = doc(`<label>Password<input type="password"></label>
  <label>Country<select id="country"><option>Canada</option><option>Japan</option></select></label>
  <input id="date" type="date"><button id="picker">Pick date</button>
  <a id="mail" href="mailto:fixture@example.invalid">Contact</a>`, `
  window.selectClicks = 0; window.mailClicks = 0;
  document.querySelector('#country').addEventListener('click', () => window.selectClicks++);
  document.querySelector('#mail').addEventListener('click', e => { e.preventDefault(); window.mailClicks++; });
  document.querySelector('#picker').addEventListener('click', () => {
    try { document.querySelector('#date').showPicker(); window.pickerResult = 'opened'; }
    catch (e) { window.pickerResult = e.name + ': ' + e.message; }
  });`);
const ordinary = doc('<p>Ordinary finished article</p>');
const hostPage = (h, f) => {
  const page = h.host.pages().find(p => p.url() === f.page.url());
  assert.ok(page, 'independent observer of the owned fixture tab');
  return page;
};

test('turn end removes the real hook before handing native controls to the person', { skip, timeout: 60000 }, async t => {
  const h = await bank(t), f = await h.start(signin), page = hostPage(h, f);
  assert.equal(f.opened.split('\n').at(-1), pendingTabNote);
  await page.locator('#country').click();
  assert.equal(await page.evaluate(() => window.selectClicks), 0, 'real hook blocks the trusted select click while owned');
  await page.locator('#picker').click();
  assert.match(await page.evaluate(() => window.pickerResult), /Native UI is blocked while sleight owns this tab/);
  await h.start(ordinary); // start() awaits the previous real runtime.end().
  assert.equal(page.isClosed(), false);
  assert.equal(f.entry.state.submitUnconfirmed, false);
  await page.locator('#country').click();
  assert.equal(await page.evaluate(() => window.selectClicks), 1, 'trusted select click reaches the handed-over page');
  await page.keyboard.press('Escape');
  await page.locator('#picker').click();
  assert.equal(await page.evaluate(() => window.pickerResult), 'opened', 'showPicker reaches Chromium after release');
  await page.keyboard.press('Escape');
  await page.locator('#mail').click();
  assert.equal(await page.evaluate(() => window.mailClicks), 1, 'mailto is handed back too');
  await page.reload();
  await page.locator('#country').click();
  assert.equal(await page.evaluate(() => window.selectClicks), 1, 'the removed init script cannot reinstall the hook');
});

test('an ordinary read with a visible cookie dialog closes at turn end', { skip, timeout: 60000 }, async t => {
  const h = await bank(t), f = await h.start(doc(`<article>Article text</article>
    <div role="dialog" aria-label="Cookie notice"><p>Choose cookies</p><button>Reject optional cookies</button></div>`));
  const page = hostPage(h, f);
  assert.match(f.opened, /dialog "Cookie notice"/);
  assert.ok(!f.opened.includes(pendingTabNote));
  assert.ok(!(await f.read()).includes(pendingTabNote));
  await h.start(ordinary);
  assert.equal(page.isClosed(), true);
});

test('automatic keeps close the oldest target across real filtered turns', { skip, timeout: 60000 }, async t => {
  const h = await bank(t), first = await h.start(signin), firstPage = hostPage(h, first);
  const second = await h.start(signin), secondPage = hostPage(h, second);
  assert.equal(firstPage.isClosed(), false);
  await h.start(ordinary);
  assert.equal(firstPage.isClosed(), true, 'upstream closes the old target after its filtered handle was released');
  assert.equal(secondPage.isClosed(), false);
});
