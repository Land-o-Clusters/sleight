import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { check as ruleCheck, beginSubmit, finishSubmit, captureSnapshot, deliverSnapshot } from './fixtures/direct-browser-v5-rule-contract.mjs';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';
import { createFormsFixtureHandler } from './fixtures/direct-browser-forms-fixture.mjs';

const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
const spec = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(b => b.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executable = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = !live ? 'opt-in real-page qualification belongs to sleight-arch' : !existsSync(executable)
  ? 'the pinned Chromium build is missing' : !existsSync(join(cache, 'test/forms/site/travel.html'))
    ? 'the read-only demo fixture source is missing' : false;

async function fixture(t, route, { retryGuard = false } = {}) {
  const posts = [], sockets = new Set(); let browser, origin;
  // Exact MIT FowlBrowser demo fixtures, pinned 8b68924, rendered in memory.
  // This never runs its benchmark runner or changes the cache clone.
  let shop;
  if (route === 'shop') {
    const source = readFileSync(join(cache, 'test/demo/server.mjs'), 'utf8');
    shop = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport {shopPage as renderFixture};').toString('base64'));
  }
  const server = createServer(createFormsFixtureHandler({ route, siteRoot: join(cache, 'test/forms/site'),
    renderShop: shop?.renderFixture, origin: () => origin, posts }));
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    try { await browser?.close(); } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      t.diagnostic('Cleanup: browserClosed=true socketsClosed=true');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const { chromium } = await import('../plugins/sleight/vendor/playwright-core/index.mjs');
  browser = await chromium.launch({ headless: true, executablePath: executable });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  if (route === 'checkout') await page.route('**/payment.html?*', request => request.fulfill({
    contentType: 'text/html', body: readFileSync(join(cache, 'test/forms/site/payment.html'), 'utf8') }));
  await page.goto(origin + (route === 'shop' ? '/shop/checkout/payment' : '/' + route));
  const tab = { page, state: { snapshotNo: 1, submitUnconfirmed: false } }, shadow = new Map();
  const ref = async (selector, frame = page) => {
    const locator = frame.locator(selector);
    // Obtain real Playwright refs, including fNeM child-frame routing. Closed
    // host refs model V3/V4's separate delivered binding, never a public selector.
    const yaml = await locator.ariaSnapshot({ mode: 'ai' });
    const match = yaml.match(/\[ref=((?:f\d+)?e\d+)\]/);
    if (match) return match[1];
    if (await locator.evaluate(el => typeof el.checked === 'boolean' && el.tagName.includes('-'))) {
      const id = 's' + (shadow.size + 1); shadow.set(id, locator); return id;
    }
    throw Error('fixture target has no observed ref: ' + selector + '\n' + yaml);
  };
  // V4 and V6 are independent lanes. This explicit fake consumes their fixed
  // interfaces, with actual Playwright input and fixture-only trusted consent.
  // It qualifies V5's strategies, not the sibling rule/action implementation.
  const check = retryGuard ? ruleCheck : () => 'allow';
  const ctx = { userMessage: 'Fill the fixture, and pay for the fixture order with the fixture card', consent: null, files: [] };
  const runSteps = async (tab, steps) => {
    for (const step of steps) {
      const loc = shadow.get(step.ref) ?? page.getByRef(step.ref);
      if (step.do === 'check' || step.do === 'uncheck') {
        const want = step.do === 'check';
        if (await loc.evaluate(el => el.checked) !== want) await loc.click({ timeout: 1500 });
        assert.equal(await loc.evaluate(el => el.checked), want);
      } else if (step.do === 'scroll') {
        let found = false;
        for (let i = 0; i < 60; i++) {
          const option = loc.getByRole('option', { name: step.until, exact: true });
          if (await option.count() === 1) { found = true; break; }
          await loc.evaluate(el => { el.scrollTop += el.clientHeight * 0.8; });
          await page.waitForTimeout(20);
        }
        if (!found) return { lines: ['1 scroll: not run: bounded search exhausted'], stoppedAt: 1 };
      } else if (step.do === 'click') {
        if (retryGuard) {
          const element = await loc.evaluate(el => ({ tag: el.localName, role: el.getAttribute('role') || '', kind: 'button',
            connected: el.isConnected, visible: true, enabled: !el.disabled, submit: el.type === 'submit' && !!el.form,
            payment: false, form: !!el.form, formPayment: false }));
          const verdict = ruleCheck(ctx, 'click', { element, state: tab.state });
          if (verdict.verdict !== 'allow') return { lines: ['1 click: not run: submit unconfirmed'], stoppedAt: 1 };
          const marker = beginSubmit(tab.state);
          await loc.click({ timeout: 1500 });
          await page.waitForTimeout(5000);
          finishSubmit(tab.state, marker);
          return { lines: ['1 click: effect unconfirmed; read before retrying'], stoppedAt: 1 };
        }
        await loc.click({ timeout: 1500 });
      }
      else throw Error('fake V4 does not implement ' + step.do);
    }
    return { lines: ['1 action: input sent; fixture observation follows'], stoppedAt: null, observe: undefined };
  };
  const fillFields = createFillFields({ check, runSteps });
  const fill = async (fields, submit) => {
    const input = [];
    for (const field of fields) {
      const [selector, value, frame] = field;
      input.push({ ref: await ref(selector, frame), value });
    }
    const submitRef = submit ? await ref(submit) : undefined;
    // A scoped AI snapshot replaces Playwright's query bank. Seed one full
    // snapshot after collecting refs so the batch can resolve all its controls.
    await page.ariaSnapshot({ mode: 'ai' });
    const result = await fillFields(tab, input, submitRef ? { submit: submitRef } : {}, ctx);
    assert.deepEqual(result.rows.map(row => row.status), fields.map(() => 'set'), JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result), /4242424242424242/);
    return result;
  };
  const click = selector => page.locator(selector).click({ timeout: 1500 });
  const posted = async () => {
    for (let i = 0; i < 100 && !posts.length; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(posts.length, 1, 'exactly one submission must reach the fixture endpoint'); return posts[0];
  };
  return { page, tab, ref, fillFields, ctx, fill, click, posted, posts };
}

test('v3 real travel fills ordinary and dependent fields, chooses readonly dates, and submits', { skip }, async t => {
  const f = await fixture(t, 'travel');
  await f.fill([['#reference', 'V5-TRAVEL'], ['#fullName', 'Example Traveler'], ['#email', 'traveler@example.invalid']]);
  const readonly = await f.fillFields(f.tab, [{ ref: await f.ref('#dates'), value: 'unproved date' }], {}, f.ctx);
  assert.equal(readonly.rows[0].status, 'failed'); assert.match(readonly.rows[0].reason, /readonly/);
  await f.click('#dates');
  const dates = [];
  for (const offset of [2, 5]) {
    const date = new Date(); date.setDate(date.getDate() + offset);
    const iso = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    dates.push(iso);
    const selector = `button[data-date="${iso}"]`;
    for (let attempt = 0; attempt < 3 && !await f.page.locator(selector).count(); attempt++) await f.click('#next');
    await f.click(selector);
  }
  await f.click('#to2');
  await f.fill([['#country', 'Japan'], ['#city', 'Osaka']]);
  const airport = JSON.parse(readFileSync(join(cache, 'test/forms/site/airports.json'), 'utf8'))[0];
  await f.fill([['#airports', airport.name + ' ' + airport.code]]);
  await f.click('#to3'); await f.click('#seatmap button[data-seat="1A"]');
  await f.click('button[type="submit"]');
  const post = await f.posted(); assert.equal(post.path, '/submit/travel');
  const firstAirport = airport.code;
  assert.deepEqual(post.data, { reference: 'V5-TRAVEL', fullName: 'Example Traveler', email: 'traveler@example.invalid',
    checkIn: dates[0], checkOut: dates[1], adults: 1, children: 0, country: 'Japan', city: 'Osaka', airport: firstAirport, seat: '1A' });
});

test('v3 real settings fills closed switch, grouped multi-select, slider and reorder before one submit', { skip }, async t => {
  const f = await fixture(t, 'settings'), order = ['Security', 'Mentions', 'Billing', 'Reminders', 'Product updates'];
  await f.fill([['#reference', 'V5-SETTINGS'], ['#twoFactor', true], ['#languages', ['Japanese', 'Korean']], ['#volume', 72], ['#prio', order]], 'button[type="submit"]');
  assert.deepEqual(await f.page.locator('#prio li').allTextContents(), order.map(v => '⋮⋮' + v));
  await f.click('#do-save'); const post = await f.posted();
  assert.equal(post.path, '/submit/settings'); assert.equal(post.data.twoFactor, true); assert.equal(post.data.volume, 72);
  assert.deepEqual(post.data.languages, ['ja', 'ko']); assert.deepEqual(post.data.priorities, order);
});

test('v3 real settings sets the slider from a numeric string directly, with the page seeing input and change', { skip }, async t => {
  const f = await fixture(t, 'settings');
  await f.page.evaluate(() => { window.events = []; for (const type of ['input', 'change']) document.querySelector('#volume').addEventListener(type, () => window.events.push(type)); });
  const presses = []; await f.page.exposeFunction('noteKey', key => presses.push(key));
  await f.page.evaluate(() => document.querySelector('#volume').addEventListener('keydown', e => window.noteKey(e.key)));
  const result = await f.fill([['#volume', '37']]);
  assert.equal(result.rows[0].status, 'set'); assert.equal(await f.page.locator('#volume').inputValue(), '37');
  assert.equal(await f.page.locator('#volume-out').textContent(), '37'); assert.deepEqual(await f.page.evaluate(() => window.events), ['input', 'change']);
  assert.deepEqual(presses, []);
  const ref = await f.ref('#volume'); await f.page.ariaSnapshot({ mode: 'ai' });
  const off = await f.fillFields(f.tab, [{ ref, value: 37.5 }], {}, f.ctx);
  assert.equal(off.rows[0].status, 'failed'); assert.match(off.rows[0].reason, /nearest valid values are 37 and 38/);
  assert.equal(await f.page.locator('#volume').inputValue(), '37');
});

test('v3 real shop checkout fills protected fields and returns optional-submit outcome', { skip }, async t => {
  const f = await fixture(t, 'shop');
  const result = await f.fill([['input[name="number"]', '4242424242424242'], ['input[name="expiry"]', '12/30'], ['input[name="cvc"]', '123']], 'form button');
  assert.equal(result.submitted.status, 'done'); const post = await f.posted();
  assert.equal(post.path, '/shop/checkout/order'); assert.equal(post.data.number, '4242424242424242');
  assert.equal(post.data.expiry, '12/30'); assert.equal(post.data.cvc, '123');
});

test('v3 real checkout chooses address autocomplete, fills cross-origin card iframe and submits once', { skip }, async t => {
  const f = await fixture(t, 'checkout');
  await f.click('#reject');
  await f.page.frameLocator('#card').locator('#cardNumber').waitFor();
  const frame = f.page.frames().find(frame => /\/payment.html/.test(frame.url())); assert.ok(frame);
  assert.notEqual(new URL(frame.url()).origin, new URL(f.page.url()).origin);
  f.page.once('dialog', dialog => { assert.match(dialog.message(), /^Pay \$268\.00 now\?$/); return dialog.accept(); });
  const address = '1880 Larkspur Lane, Portland, OR 97217';
  const result = await f.fill([['#reference', 'V5-CHECKOUT'], ['#fullName', 'Example Buyer'], ['#email', 'buyer@example.invalid'],
    ['#phone', '5555551212'], ['#address', address], ['input[name="shipping"][value="standard"]', true],
    ['#cardNumber', '4242424242424242', frame], ['#expiry', '12/30', frame], ['#cvc', '123', frame]], '#pay');
  assert.equal(result.submitted.status, 'done'); const post = await f.posted();
  assert.equal(post.path, '/submit/checkout'); assert.equal(post.data.address, address); assert.equal(post.data.shipping, 'standard');
  assert.equal(post.data.cardNumber.replace(/\s/g, ''), '4242424242424242'); assert.equal(post.data.cvc, '123');
  assert.equal(post.data.reference, 'V5-CHECKOUT');
});

test('v3 real autocomplete refuses absent suggestion without submitting', { skip }, async t => {
  const f = await fixture(t, 'checkout'); await f.click('#reject');
  const addressRef = await f.ref('#address'), submitRef = await f.ref('#pay');
  await f.page.ariaSnapshot({ mode: 'ai' });
  const result = await f.fillFields(f.tab, [{ ref: addressRef, value: 'No Such Fixture Street' }], { submit: submitRef }, f.ctx);
  assert.equal(await f.page.locator('#address').inputValue(), 'No Such Fixture Street');
  assert.equal(result.rows[0].status, 'failed'); assert.equal(result.submitted.status, 'not reached'); assert.equal(f.posts.length, 0);
});


test('v5r real submit-toggle refuses resend until a delivered post-settle read', { skip }, async t => {
  const f = await fixture(t, 'settings', { retryGuard: true });
  await f.page.setContent(`<form><input id="note" aria-label="Note"><button id="save" type="submit" role="checkbox" aria-checked="false">Save</button></form>
    <script>window.submissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++}</script>`);
  const save = await f.ref('#save'); await f.page.ariaSnapshot({ mode: 'ai' });
  const input = [{ ref: save, value: true }];
  await f.fillFields(f.tab, input, {}, f.ctx);
  const retry = await f.fillFields(f.tab, input, {}, f.ctx);
  assert.equal(await f.page.evaluate(() => window.submissions), 1, 'no blind second submit');
  assert.equal(retry.rows[0].status, 'failed'); assert.ok(f.tab.state.submitUnconfirmed);
  const note = await f.ref('#note'); await f.page.ariaSnapshot({ mode: 'ai' });
  const ordinary = await f.fillFields(f.tab, [{ ref: note, value: 'ordinary input remains available' }], {}, f.ctx);
  assert.equal(ordinary.rows[0].status, 'set'); assert.ok(f.tab.state.submitUnconfirmed);
  const delivered = captureSnapshot(f.tab.state); await f.page.ariaSnapshot({ mode: 'ai' });
  assert.equal(deliverSnapshot(f.tab.state, delivered), true); assert.equal(f.tab.state.submitUnconfirmed, false);
  await f.fillFields(f.tab, input, {}, f.ctx);
  assert.equal(await f.page.evaluate(() => window.submissions), 2, 'fresh delivered read permits another explicit submit');
});

test('v5r2 real navigation during final inspection prevents submit delegation', { skip }, async t => {
  const f = await fixture(t, 'settings');
  await f.page.setContent('<form><button id="save" type="submit" role="checkbox" aria-checked="false">Save</button><input id="suffix" aria-label="Suffix"></form>');
  const save = await f.ref('#save'), suffix = await f.ref('#suffix');
  await f.page.ariaSnapshot({ mode: 'ai' });
  let inspections = 0, delegated = 0, consumed = 0;
  const original = f.page.getByRef.bind(f.page);
  f.page.getByRef = ref => new Proxy(original(ref), { get(target, key) {
    // Trusted inspections acquire a pinned handle and evaluate in utility
    // world. Navigate at that actual boundary, without replacing its reader.
    if (key === 'elementHandle') return async (...args) => {
      const value = await target.elementHandle(...args);
      if (++inspections === 3) await f.page.goto(f.page.url() + '?boundary=1');
      return value;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const fill = createFillFields({ check: () => { consumed++; return 'allow'; },
    runSteps: async () => { delegated++; return { lines: ['1 click: input sent'], stoppedAt: null }; } });
  const result = await fill(f.tab, [{ ref: save, value: true }, { ref: suffix, value: 'untouched' }], {}, f.ctx);
  assert.equal(inspections, 3); assert.equal(delegated, 0); assert.equal(consumed, 0);
  assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
  assert.match(result.stopped, /new document/); assert.equal(f.posts.length, 0);
  assert.equal(f.tab.state.submitUnconfirmed, false);
});
