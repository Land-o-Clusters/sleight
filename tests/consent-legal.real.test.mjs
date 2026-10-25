import test from 'node:test';
import assert from 'node:assert/strict';
import { skip } from './fixtures/cr4-real.mjs';
import { consentFixture as setup } from './fixtures/consent-runner.mjs';
import { checkConsent } from '../plugins/sleight/lib/direct-browser/consent-wall.mjs';
import { ordinary, phrases, roots, declines } from './fixtures/consent-g11f.mjs';
const button = label => `<button onclick="document.body.dataset.hit='yes'">${label}</button>`;
const html = (attrs, words, label = 'Continue') => `<!doctype html><meta charset="utf-8"><section ${attrs}>${words}${button(label)}</section>`;
for (const [title, words, label] of [...ordinary,
  ['footer link', '<a href="#"><span>Cookie settings</span></a>', 'Yes, subscribe'],
  ['policy link', '<a href="#">Cookie policy</a>', 'Continue'],
  ['ARIA link', '<span role="link"><span>Cookie settings</span></span>', 'Yes'],
  ['linked agreement', 'You agree to <a href="#">Terms</a>, <a href="#">Privacy</a> and <a href="#">Cookie Policy</a>', 'Continue'],
  ['settings button', '<button type="button">Cookie settings</button>', 'Continue'],
]) test(`turbo permits ${title}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, html('role="dialog" style="position:fixed"', words, label));
  const target = f.entry.page.getByRole('button', { name: label, exact: true });
  assert.equal(await checkConsent(target, 'click', f.entry.state), false);
  const result = await f.act(label);
  assert.doesNotMatch(result, /accepting cookies is blocked/);
  // Subscribe still needs the separate payment confirmation; this test grants none.
  if (label === 'Yes, subscribe') {
    assert.match(result, /confirmation required through the trusted consent UI/);
    assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), null);
  } else assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), 'yes', result);
});
for (const phrase of [...phrases, 'You agree to our Cookie Policy. We use cookies.',
  // g11f review: a link inside the consent sentence and implied-consent sentences still name cookie use.
  'We use <a href="#">cookies</a> to improve your experience.',
  'By using this website, you agree to our use of cookies as described in our <a href="#">Cookie Policy</a>.',
  'By continuing to browse you agree to our use of cookies.']) test(`turbo common phrase blocks: ${phrase}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, html('style="position:fixed"', phrase));
  await assert.rejects(checkConsent(f.entry.page.getByRole('button'), 'click', f.entry.state), /accepting cookies is blocked/);
  assert.match(await f.act('Continue'), /accepting cookies is blocked/);
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), null);
});
for (const root of roots) test(`turbo CMP root blocks: ${root}`, { skip, timeout: 30000 }, async t => {
  const frame = root.startsWith('sp_message_iframe');
  const f = await setup(t, frame ? `<iframe name="${root}" src="/frame"></iframe>` : html(`id="${root}"`, 'Your privacy'), { '/frame': html('', 'Your privacy') });
  await f.entry.page.waitForLoadState('load');
  const page = frame ? f.entry.page.frames()[1] : f.entry.page;
  await assert.rejects(checkConsent(page.getByRole('button'), 'click', f.entry.state), /accepting cookies is blocked.*Stop and ask/);
  assert.equal(await page.locator('body').getAttribute('data-hit'), null);
});
for (const decline of declines) test(`turbo observes one-click decline: ${decline}`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, html('role="dialog"', `We use cookies<button onclick="this.parentElement.remove()">${decline}</button>`));
  const blocked = await f.act('Continue');
  assert.match(blocked, /accepting cookies is blocked/);
  assert.ok(blocked.includes(JSON.stringify(decline)));
  assert.doesNotMatch(blocked, /Stop and ask/);
  assert.match(await f.act(decline), /Decline confirmed/);
});
test('turbo reset instructions do not hide an independent cookie-use sentence', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, html('role="dialog"', 'We use cookies. You can remove cookies in your browser.'));
  await assert.rejects(checkConsent(f.entry.page.getByRole('button'), 'click', f.entry.state), /accepting cookies is blocked/);
});
test('turbo settings heading above a reset question is not a wall', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, html('role="dialog"', '<h2>Cookie preferences</h2>Reset your cookies?', 'Yes'));
  assert.equal(await checkConsent(f.entry.page.getByRole('button'), 'click', f.entry.state), false);
});
for (const role of ['dialog', 'alertdialog']) test(`turbo permits a reset-only ${role} inside a known CMP root`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, html(`role="${role}" id="onetrust-pc-sdk"`, '<h2>Cookie preferences</h2>Reset your cookies?', 'Yes'));
  const target = f.entry.page.getByRole('button');
  assert.equal(await checkConsent(target, 'click', f.entry.state), false);
  await target.click({ timeout: 10000 });
  assert.equal(await f.entry.page.locator('body').getAttribute('data-hit'), 'yes');
});
test('turbo CMP reset instructions cannot hide a cookie-use sentence', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, html('role="dialog" id="onetrust-pc-sdk"', 'We use cookies. You can remove cookies in your browser.'));
  await assert.rejects(checkConsent(f.entry.page.getByRole('button'), 'click', f.entry.state), /accepting cookies is blocked/);
});
