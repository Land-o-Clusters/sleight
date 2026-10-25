import test from 'node:test';
import assert from 'node:assert/strict';
import { skip } from './fixtures/cr4-real.mjs';
import { consentFixture as setup } from './fixtures/consent-runner.mjs';
import { checkConsent } from '../plugins/sleight/lib/direct-browser/consent-wall.mjs';

const button = label => `<button onclick="document.body.dataset.hit='yes'">${label}</button>`;
const section = (attrs, words, label = 'Continue') => `<!doctype html><meta charset="utf-8"><section ${attrs}>${words}${button(label)}</section>`;
for (const [title, attrs, words, label] of [
  ['bakery cart bar', 'style="position:fixed;bottom:0"', 'Your cart: 12 cookies', 'Continue'],
  ['dozen-cookies dialog', 'role="dialog"', 'Add a dozen cookies?', 'OK'],
  ['cookie heading section', '', '<h2>Cookies</h2>Recipes to bake', 'Continue reading'],
  ['Set-Cookie docs nav', 'role="navigation" style="position:sticky;top:0"', 'Set-Cookie reference', 'Continue'],
  ['cookie game HUD', 'style="position:fixed"', 'Cookies collected: 12', 'Continue'],
  ['share bar', 'style="position:sticky"', 'Share this cookies recipe', 'OK'],
  ['ketch-up recipe', 'id="ketch-up"', 'Your recipe privacy', 'Continue'],
  ['cookies-ready alert', 'role="alert"', 'Cookies are ready', 'OK'],
  ['remove cookies dialog', 'role="dialog"', 'Remove all cookies?', 'OK'],
  ['cookie named region', 'role="region" aria-label="Cookies"', 'Our bakery', 'Continue'],
  ['unshaped consent heading', '', '<h2>Cookie preferences</h2>Read our documentation', 'Continue'],
  ['unshaped consent label', 'role="region" aria-label="Cookie preferences"', 'Read our documentation', 'Continue'],
  ['absolute banner limit', 'style="position:absolute"', 'We use cookies', 'Accept all'],
  ['bare cookie dialog limit', 'role="dialog"', 'Cookies', 'Accept all'],
]) test(`phrase rule permits ${title}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, section(attrs, words, label));
  const target = f.entry.page.getByRole('button', { name: label, exact: true });
  assert.equal(await checkConsent(target, 'click', f.entry.state), false);
  await target.click({ timeout: 10000 });
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), 'yes');
});

for (const [title, attrs, words, ask] of [
  ['fixed', 'style="position:fixed"', 'We use cookies', false],
  ['sticky', 'style="position:sticky"', 'This site uses cookies', false],
  ['dialog', 'role="dialog"', 'Cookie policy', true],
  ['alertdialog', 'role="alertdialog"', 'Cookie settings', true],
  ['modal', 'aria-modal="true"', 'Consent to cookies', true],
  ['fixed heading', 'style="position:fixed"', '<h2>Cookie preferences</h2>', false],
  ['sticky named region', 'role="region" style="position:sticky" aria-label="Cookie preferences"', 'We use cookies', false],
  ['CMP privacy', 'id="onetrust-banner-sdk"', 'Your privacy', true],
  ['CMP Ketch', 'class="ketch-banner"', 'Your privacy', true],
]) test(`phrase wall ${title} asks=${ask}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, section(attrs, words));
  await assert.rejects(checkConsent(f.entry.page.getByRole('button'), 'click', f.entry.state), error => {
    assert.match(error.message, /accepting cookies is blocked/);
    assert.equal(/Stop and ask/.test(error.message), ask);
    return true;
  });
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), null);
});
for (const label of ['Consent', 'Understood', 'Proceed', 'Yes', 'Sounds good', 'Enable all']) {
  test(`phrase wall blocks ${label} through guard and dispatcher paths`, { skip, timeout: 30000 }, async t => {
    const f = await setup(t, section('role="dialog"', '<p>We use cookies</p><label>Name<input aria-label="Name"></label>', label));
    for (const operation of ['click', 'press', 'check', 'fill']) {
      await assert.rejects(checkConsent(f.entry.page.getByRole('button'), operation, f.entry.state), /accepting cookies is blocked.*Stop and ask/);
    }
    for (const key of ['Enter', 'Space']) {
      const before = await f.read();
      assert.match(await f.call('browser_act', { steps: [{ do: 'press', ref: f.ref(before, label), key }] }), /accepting cookies is blocked/);
    }
    assert.match(await f.act(label), /accepting cookies is blocked/);
    const before = await f.read();
    assert.match(await f.call('browser_fill', { fields: [{ ref: f.ref(before, 'Name'), value: 'Fixture' }], submit: f.ref(before, label) }), /accepting cookies is blocked/);
    assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), null);
  });
}
for (const [title, name, blocked] of [['known CMP', 'OneTrust', true], ['ketch-up', 'ketch-up', false], ['unknown CMP limit', 'unknown-cmp', false]]) {
  test(`iframe name ${title}`, { skip, timeout: 30000 }, async t => {
    const f = await setup(t, `<iframe name="${name}" src="/frame"></iframe>`, { '/frame': section('', 'Your privacy') });
    await f.entry.page.waitForLoadState('load');
    const target = f.entry.page.frames()[1].getByRole('button');
    if (blocked) await assert.rejects(checkConsent(target, 'click', f.entry.state), /accepting cookies is blocked/);
    else {
      assert.equal(await checkConsent(target, 'click', f.entry.state), false);
      await target.click({ timeout: 10000 });
      assert.equal(await f.entry.page.frames()[1].locator('body').getAttribute('data-hit'), 'yes');
    }
  });
}

for (const [size, blocked] of [[1499, true], [1500, false]]) test(`banner own text length ${size}`, { skip, timeout: 30000 }, async t => {
  const words = 'We use cookies ' + 'x'.repeat(size - 23);
  const f = await setup(t, section('style="position:fixed"', words, 'Consent'));
  const target = f.entry.page.getByRole('button');
  if (blocked) await assert.rejects(checkConsent(target, 'click', f.entry.state), /accepting cookies is blocked/);
  else assert.equal(await checkConsent(target, 'click', f.entry.state), false);
});
test('long known CMP root stays identified', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, section('id="onetrust-pc-sdk"', 'x'.repeat(1600), 'Consent'));
  await assert.rejects(checkConsent(f.entry.page.getByRole('button'), 'click', f.entry.state), /accepting cookies is blocked.*Stop and ask/);
});
test('new acceptance words remain usable outside cookie containers', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, '<main>' + ['Consent', 'Understood', 'Proceed', 'Yes', 'Sounds good', 'Enable all'].map(button).join('') + '</main>');
  for (const label of ['Consent', 'Understood', 'Proceed', 'Yes', 'Sounds good', 'Enable all']) {
    const target = f.entry.page.getByRole('button', { name: label, exact: true });
    assert.equal(await checkConsent(target, 'click', f.entry.state), false);
    await target.click({ timeout: 10000 });
  }
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), 'yes');
});
