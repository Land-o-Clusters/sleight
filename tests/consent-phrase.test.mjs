import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { engineConsent, cookieWording, consentManager } from '../plugins/sleight/lib/consent-wall.mjs';
import { guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const header = 'Window: "Fixture", App: Browser\n0 standard window Fixture\n\t1 HTML content Fixture';
const tree = (role, words, label = 'Continue', reject = false) => header +
  `\n\t\t2 ${role}\n\t\t\t3 text ${words}\n\t\t\t4 button ${label}` + (reject ? '\n\t\t\t5 button Reject all' : '');

for (const [title, role, words, label] of [
  ['bakery cart bar', 'group', 'Your cart: 12 cookies', 'Continue'],
  ['dozen-cookies dialog', 'dialog', 'Add a dozen cookies?', 'OK'],
  ['cookie heading section', 'section Cookies', 'Chocolate chip cookies', 'Continue reading'],
  ['Set-Cookie docs nav', 'navigation Set-Cookie', 'Set-Cookie reference', 'Continue'],
  ['cookie game HUD', 'group', 'Cookies collected: 12', 'Continue'],
  ['share bar', 'group', 'Share this cookies recipe', 'OK'],
  ['ketch-up recipe', 'group ketch-up', 'Recipe privacy', 'Continue'],
  ['cookies-ready alert', 'alert dialog', 'Your cookies are ready', 'OK'],
  ['remove cookies dialog', 'dialog', 'Remove all cookies?', 'OK'],
  ['bare cookie dialog', 'dialog', 'Cookies', 'Accept all'],
  ['unshaped named region', 'region Cookie preferences', 'Cookie preferences', 'Continue'],
]) test(`engine phrase rule permits ${title}`, async () => {
  const before = tree(role, words, label);
  assert.equal(engineConsent('click', [4], before), undefined);
  const sent = [];
  const raw = { getAXState: async () => before, click: async n => sent.push(n) };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const run = code => runInNewContext(`(async()=>{${code}})()`, context);
  await run(readCode('await cua.getApp("Browser");'));
  await run(guardedCode('await app.click(4);', windowFromText(before), 'Stopped.'));
  assert.deepEqual(sent, [4]);
});

for (const words of ['we use cookies', 'this site uses cookies', 'cookie policy', 'cookie settings', 'cookie preferences',
  'accept cookies', 'consent to cookies', 'We use essential cookies', 'Wir verwenden Cookies', 'Nous utilisons des cookies', 'Usamos cookies',
  'Utilizziamo cookie', 'Usamos biscoitos', 'Wij gebruiken cookies', 'Używamy plików cookie', 'Çerez kullanıyoruz',
  'Vi använder kakor', 'Käytämme evästeitä', 'Sütiket használunk', 'クッキーを使用', '我们使用Cookie', '我們使用Cookie', '쿠키를 사용']) {
  test(`consent phrase recognises ${words}`, () => assert.equal(cookieWording(words), true));
  test(`engine blocks consent phrase ${words}`, () => assert.equal(engineConsent('click', [4], tree('dialog', words))?.blocked, true));
}
for (const words of ['Cookies', 'cookies are ready', 'Remove all cookies?', 'Set-Cookie docs', 'Kekse', 'Kakor', 'Galletas', 'クッキー', '쿠키']) {
  test(`bare topic is not a consent phrase: ${words}`, () => assert.equal(cookieWording(words), false));
}
for (const label of ['Consent', 'Understood', 'Proceed', 'Yes', 'Sounds good', 'Enable all']) {
  test(`engine refuses new accept label ${label}`, () => {
    const result = engineConsent('click', [4], tree('dialog', 'We use cookies', label));
    assert.equal(result?.blocked, true);
    assert.match(result.why, /Stop and ask/);
  });
}
for (const identity of ['ketch-up', 'ketch-up-recipe', 'sketch', 'ketchup', 'myonetruststory']) {
  test(`CMP boundary excludes ${identity}`, () => assert.equal(consentManager(identity), false));
}
for (const identity of ['onetrust-banner-sdk', 'CybotCookiebotDialog', 'didomi-popup-container', 'ketch', 'ketch-banner', 'ketch_consent', 'OneTrust choices', 'onetrust-pc-sdk', 'iubenda-cs-container', 'osano-cm-window']) {
  test(`CMP boundary preserves ${identity}`, () => assert.equal(consentManager(identity), true));
}
for (const [role, words, want] of [['dialog', 'We use cookies', true], ['alertdialog', 'Cookie settings', true],
  ['group OneTrust', 'Your privacy', true], ['region Cookie settings', 'Cookie settings', false],
  ['alert', 'Cookies are ready', false]]) {
  test(`engine asks only for a qualifying wall: ${role} / ${words}`, () => {
    const result = engineConsent('click', [4], tree(role, words));
    assert.equal(/Stop and ask/.test(result?.why ?? ''), want);
  });
}
test('engine CMP with decline names that decline instead of asking', () => {
  const result = engineConsent('click', [4], tree('group OneTrust', 'Your privacy', 'Consent', true));
  assert.match(result.why, /Reject all/);
  assert.doesNotMatch(result.why, /Stop and ask/);
});

for (const [size, blocked] of [[1499, true], [1500, undefined]]) test(`engine own text length ${size}`, () => {
  // Empty dialog name, one text row, and a seven-character control name.
  const words = 'We use cookies ' + 'x'.repeat(size - 23);
  assert.equal(engineConsent('click', [4], tree('dialog', words, 'Consent'))?.blocked, blocked);
});
test('known CMP identity does not depend on the banner text length', () => {
  assert.equal(engineConsent('click', [4], tree('group OneTrust', 'x'.repeat(1600), 'Consent'))?.blocked, true);
});
