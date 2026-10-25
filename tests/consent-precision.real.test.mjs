import test from 'node:test';
import assert from 'node:assert/strict';
import { skip } from './fixtures/cr4-real.mjs';
import { consentFixture as setup } from './fixtures/consent-runner.mjs';
import { checkConsent } from '../plugins/sleight/lib/direct-browser/consent-wall.mjs';

const hit = `onclick="document.body.dataset.hit='yes'"`;
const button = label => `<button ${hit}>${label}</button>`;
const page = html => '<!doctype html><meta charset="utf-8">' + html;
const wrap = (text, control, attrs = 'style="position:fixed;bottom:0"') => page(`<section ${attrs}><p>${text}</p>${control}</section>`);
async function blocked(f, target, operation = 'click') {
  let message;
  await assert.rejects(checkConsent(target, operation, f.entry.state), error => {
    message = error.message;
    assert.match(message, /accepting cookies is blocked/);
    return true;
  });
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), null);
  return message;
}

for (const [title, html, label] of [
  ['recipe main', `<main><h1>Chocolate cookies</h1>${button('Continue reading')}</main>`, 'Continue reading'],
  ['notifications', `<section style="position:fixed"><p>Tracking preferences for notifications</p>${button('Allow notifications')}</section>`, 'Allow notifications'],
  ['invitation', `<main><p>Share cookies at the party</p>${button('Accept invitation')}</main>`, 'Accept invitation'],
  ['checkout tracking number', `<main><p>Tracking number</p>${button('Continue')}</main>`, 'Continue'],
  ['OAuth Partners', `<section role="dialog"><h1>Acme Partners</h1>${button('Allow')}</section>`, 'Allow'],
  ['ToS partners', `<section role="dialog"><p>Terms with our partners</p>${button('I agree')}</section>`, 'I agree'],
  ['package tracking', `<section style="position:sticky"><p>Package tracking</p>${button('OK')}</section>`, 'OK'],
  ['payment frame', `<iframe title="Payment" src="/payment"></iframe>`, 'Continue'],
  ['ordinary in-flow cookies', `<div><p>Cookies on the menu</p>${button('Continue')}</div>`, 'Continue'],
  ['privacy outside CMP', `<div style="position:fixed"><p>Privacy and tracking partners</p>${button('Accept')}</div>`, 'Accept'],
  ['biscuits outside CMP', `<section style="position:fixed"><p>Biscuits</p>${button('Continue')}</section>`, 'Continue'],
  ['long dialog', `<section role="dialog"><p>Cookies ${'a'.repeat(1500)}</p>${button('Accept')}</section>`, 'Accept'],
  ['long nested dialog', `<section role="dialog"><p>Cookies</p><main>${'a'.repeat(1500)}</main>${button('Accept')}</section>`, 'Accept'],
]) test(`precision permits ${title}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, page(html), { '/payment': page(`<p>Tracking number for payment</p>${button('Continue')}`) });
  await f.entry.page.waitForLoadState('load');
  if (title === 'payment frame') {
    const frame = f.entry.page.frames()[1];
    assert.equal(await checkConsent(frame.getByRole('button', { name: label }), 'click', f.entry.state), false);
    await frame.getByRole('button', { name: label }).click({ timeout: 10000 });
    assert.equal(await frame.locator('body').getAttribute('data-hit'), 'yes');
  } else {
    // Test cookie classification separately from the action runner's short
    // input deadline. Acceptance and fill-submit routing are exercised below.
    const target = f.entry.page.getByRole('button', { name: label, exact: true });
    assert.equal(await checkConsent(target, 'click', f.entry.state), false);
    await target.click({ timeout: 10000 });
    assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), 'yes');
  }
});

for (const label of ['I understand', 'Yes, that is fine', 'Accept all']) test(`precision blocks banner ${label}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wrap('We use cookies', button(label) + button('Reject all')));
  assert.match(await blocked(f, f.entry.page.getByRole('button', { name: label, exact: true })), /Reject all/);
});

for (const [title, control, selector, operation] of [
  ['img alt', `<button ${hit}><img alt="Accept all" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E"></button>`, 'button', 'click'],
  ['label-for', `<label for="yes">Accept all cookies</label><input id="yes" type="checkbox" onchange="document.body.dataset.hit='yes'">`, 'input', 'click'],
  ['check op', `<input type="checkbox" role="switch" aria-label="Accept all cookies" onchange="document.body.dataset.hit='yes'">`, 'input', 'check'],
  ['div onclick', `<div ${hit}>Accept all</div>`, 'div', 'click'],
  ['div onclick property', `<div id="yes">Accept all</div><script>document.querySelector('#yes').onclick=()=>{document.body.dataset.hit='yes'}</script>`, '#yes', 'click'],
  ['CSS before', `<style>#yes::before{content:'Accept all'}</style><button id="yes" ${hit}></button>`, '#yes', 'click'],
  ['aria-labelledby', `<span id="label">Accept all</span><button aria-labelledby="label" ${hit}>◼</button>`, 'button', 'press'],
]) test(`precision blocks ${title}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wrap('We use cookies', control));
  const target = f.entry.page.locator(selector);
  await blocked(f, target, operation);
});

test('browser_act check and browser_fill cannot activate an Accept switch', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wrap('We use cookies', '<input type="checkbox" role="switch" aria-label="Accept all cookies" onchange="document.body.dataset.hit=\'yes\'">'));
  let before = await f.read();
  assert.match(await f.call('browser_act', { steps: [{ do: 'check', ref: f.ref(before, 'Accept all cookies') }] }), /accepting cookies is blocked/);
  before = await f.read();
  assert.match(await f.call('browser_fill', { fields: [{ ref: f.ref(before, 'Accept all cookies'), value: true }] }), /accepting cookies is blocked/);
  assert.equal(await f.entry.page.locator('input').isChecked(), false);
});

for (const [title, attrs, words, ask] of [
  ['fixed', 'style="position:fixed"', 'We use cookies', false],
  ['sticky', 'style="position:sticky"', 'We use cookies', false],
  ['fixed named region', 'role="region" aria-label="Cookies" style="position:fixed"', 'We use cookies', false],
  ['sticky heading section', 'style="position:sticky"', '<h2>Cookie preferences</h2>', false],
  ['dialog', 'role="dialog"', 'We use cookies', true],
  ['alertdialog', 'role="alertdialog"', 'We use cookies', true],
  ['aria-modal', 'aria-modal="true"', 'We use cookies', true],
  ['CMP privacy', 'id="onetrust-banner-sdk"', 'Your privacy', true],
  ['CMP biscuits', 'class="didomi-popup-container"', 'Biscuits', true],
]) test(`no reject in ${title}: ask=${ask}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wrap(words, button('Continue'), attrs));
  const result = await blocked(f, f.entry.page.getByRole('button', { name: 'Continue', exact: true }));
  assert.equal(/stop and ask/i.test(result), ask, result);
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), null);
});

for (const word of ['Usamos galletas', 'Wir verwenden Kekse', '쿠키를 사용', 'クッキーを使用', 'Çerez kullanıyoruz', 'Vi använder kakor', 'Käytämme evästeitä', 'Sütiket használunk']) test(`localized banner ${word}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wrap(word, button('Accept all')));
  await blocked(f, f.entry.page.getByRole('button', { name: 'Accept all', exact: true }));
});

test('fill submit uses precision guard', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wrap('We use cookies', '<label>Name<input aria-label="Name"></label>' + button('Accept all')));
  const before = await f.read();
  assert.match(await f.call('browser_fill', { fields: [{ ref: f.ref(before, 'Name'), value: 'Fixture' }], submit: f.ref(before, 'Accept all') }), /accepting cookies is blocked/);
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), null);
});

test('known CMP iframe supplies container identity across an origin boundary', { skip, timeout: 30000 }, async t => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(page(`<p>Your privacy</p>${button('Continue')}`)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const f = await setup(t, `<iframe name="OneTrust" title="OneTrust choices" src="http://127.0.0.1:${server.address().port}/"></iframe>`);
  await f.entry.page.waitForLoadState('load');
  await assert.rejects(checkConsent(f.entry.page.frames()[1].getByRole('button', { name: 'Continue' }), 'click', f.entry.state), /accepting cookies is blocked.*stop and ask/i);
});

test('ordinary sketch identifier does not count as Ketch CMP', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, page(`<section id="sketch"><p>Privacy partners</p>${button('Continue')}</section>`));
  const target = f.entry.page.getByRole('button', { name: 'Continue', exact: true });
  assert.equal(await checkConsent(target, 'click', f.entry.state), false);
  await target.click({ timeout: 10000 });
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), 'yes');
});

test('an ordinary SVG descendant does not become an Accept label', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, page(`<main>${button('<svg width="20" height="20"><rect width="20" height="20"/></svg>Continue')}</main>`));
  const target = f.entry.page.locator('svg');
  assert.equal(await checkConsent(target, 'click', f.entry.state), false);
  await target.click({ timeout: 10000 });
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), 'yes');
});

test('an image-only decline is named rather than asking the user', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wrap('We use cookies', button('Accept all') + `<button><img alt="Reject all" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E"></button>`, 'role="dialog"'));
  assert.match(await blocked(f, f.entry.page.getByRole('button', { name: 'Accept all', exact: true })), /Reject all/);
});
