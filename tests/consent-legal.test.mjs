import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { engineConsent, cookieWording, consentManager, declinesCookies } from '../plugins/sleight/lib/consent-wall.mjs';
import { guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { ordinary, phrases, roots, declines } from './fixtures/consent-g11f.mjs';
const tree = (words, label = 'Continue', role = 'dialog') => `Window: "Fixture", App: Browser\n0 standard window Fixture\n\t1 HTML content Fixture\n\t\t2 ${role}\n${words}\n\t\t\t4 button ${label}`;
for (const [title, words, label] of ordinary) test(`engine permits ${title}`, async () => {
  const before = tree('\t\t\t3 text ' + words, label);
  assert.equal(engineConsent('click', [4], before), undefined);
  const sent = [], raw = { getAXState: async () => before, click: async n => sent.push(n) };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const run = code => runInNewContext(`(async()=>{${code}})()`, context);
  await run(readCode('await cua.getApp("Browser");'));
  await run(guardedCode('await app.click(4);', windowFromText(before), 'Stopped.'));
  assert.deepEqual(sent, [4]);
});
for (const words of ['Cookie settings', 'Cookie policy']) test(`engine excludes link subtree ${words}`, () => {
  assert.equal(engineConsent('click', [4], tree(`\t\t\t3 link\n\t\t\t\t5 text ${words}`, 'Yes, subscribe')), undefined);
});
for (const phrase of phrases) test(`common phrase blocks: ${phrase}`, () => {
  assert.equal(cookieWording(phrase), true);
  assert.equal(engineConsent('click', [4], tree('\t\t\t3 text ' + phrase))?.blocked, true);
});
for (const root of roots) test(`CMP root blocks: ${root}`, () => {
  assert.equal(consentManager(root), true);
  assert.equal(engineConsent('click', [4], tree('\t\t\t3 text Your privacy', 'Continue', 'group, ID: ' + root))?.blocked, true);
});
for (const decline of declines) test(`engine observes one-click decline: ${decline}`, () => {
  assert.equal(declinesCookies(decline), true);
  const before = tree('\t\t\t3 text We use cookies\n\t\t\t5 button ' + decline);
  const blocked = engineConsent('click', [4], before);
  assert.equal(blocked?.blocked, true);
  assert.ok(blocked.why.includes(JSON.stringify(decline)));
  assert.doesNotMatch(blocked.why, /Stop and ask/);
  assert.equal(engineConsent('click', [5], before)?.decline, true);
});
test('legal sentence does not hide a separate consent sentence', () => {
  assert.equal(engineConsent('click', [4], tree('\t\t\t3 text You agree to our Cookie Policy. We use cookies.'))?.blocked, true);
});
test('reset instructions do not hide an independent cookie-use sentence', () => {
  assert.equal(engineConsent('click', [4], tree('\t\t\t3 text We use cookies. You can remove cookies in your browser.'))?.blocked, true);
});
test('a settings heading above a reset question is not a wall', () => {
  assert.equal(engineConsent('click', [4], tree('\t\t\t3 text Cookie preferences. Reset your cookies?', 'Yes')), undefined);
});
