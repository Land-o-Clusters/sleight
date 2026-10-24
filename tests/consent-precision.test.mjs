import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { engineConsent } from '../plugins/sleight/lib/consent-wall.mjs';

const header = 'Window: "Fixture", App: Browser\n0 standard window Fixture\n\t1 HTML content Fixture';
const tree = (role = 'dialog', words = 'Cookies', target = 'button Accept all', reject = true) => header +
  `\n\t\t2 ${role}\n\t\t\t3 text ${words}\n\t\t\t4 ${target}` + (reject ? '\n\t\t\t5 button Reject all' : '');

for (const [title, role, words, target] of [
  ['recipe', 'main', 'Cookies recipe', 'button Continue reading'],
  ['notification', 'dialog', 'Privacy notifications', 'button Allow notifications'],
  ['invitation', 'group', 'Cookies at the party', 'button Accept invitation'],
  ['tracking checkout', 'form', 'Tracking number', 'button Continue'],
  ['OAuth', 'dialog', 'Acme Partners', 'button Allow'],
  ['ToS', 'dialog', 'Our partners', 'button I agree'],
  ['package', 'dialog', 'Package tracking', 'button OK'],
  ['payment', 'HTML content Payment', 'Tracking number', 'button Continue'],
  ['in-flow unknown CMP', 'group', 'Cookies', 'button Accept all'],
  ['ordinary sheet', 'sheet', 'Cookies document', 'button Accept all'],
  ['ordinary alert', 'alert', 'Cookies document', 'button OK'],
  ['long dialog', 'dialog', 'Cookies ' + 'a'.repeat(1500), 'button Accept all'],
]) test(`engine precision permits ${title}`, () => {
  assert.equal(engineConsent('click', [4], tree(role, words, target))?.blocked, undefined);
});

for (const target of ['button I understand', 'button Yes, that is fine', 'check box Accept all cookies',
  'switch Accept all', 'group Accept all', 'image Accept all', 'text Accept all']) test(`engine blocks role and name ${target}`, () => {
  assert.equal(engineConsent('click', [4], tree('dialog', 'Cookies', target))?.blocked, true);
});

for (const role of ['dialog', 'alert dialog', 'group OneTrust', 'container Cookiebot', 'region Cookies', 'section Cookies']) {
  test(`engine qualifying ${role}`, () => assert.equal(engineConsent('click', [4], tree(role))?.blocked, true));
}
for (const [role, ask] of [['region Cookies', false], ['section Cookies', false], ['dialog', true], ['group OneTrust', true]]) {
  test(`engine no reject ${role} ask=${ask}`, () => {
    const result = engineConsent('click', [4], tree(role, 'Cookies', 'button Accept all', false));
    assert.equal(result?.blocked, true);
    assert.match(result.why, /accepting cookies is blocked/);
    assert.equal(/stop and ask/i.test(result.why), ask);
  });
}
test('engine includes nested landmark text in the container length bound', () => {
  const before = tree() + '\n\t\t\t6 main\n\t\t\t\t7 text ' + 'a'.repeat(1500);
  assert.equal(engineConsent('click', [4], before)?.blocked, undefined);
});
for (const method of ['pressKey', 'typeText']) for (const key of method === 'pressKey' ? ['Space', 'Return', 'NumpadEnter', '\n', '\r'] : [' ', '\n']) {
  test(`engine focused ${method} ${JSON.stringify(key)}`, () => {
    const before = tree() + '\nThe focused UI element is 4 button Accept all';
    assert.equal(engineConsent(method, [key], before)?.blocked, true);
  });
}
test('engine ordinary typing on Accept does not activate it', () => {
  assert.equal(engineConsent('typeText', ['fixture'], tree() + '\nThe focused UI element is 4 button Accept all'), undefined);
});
for (const method of ['click', 'doubleClick', 'press']) test(`engine maps ${method} point to deepest framed row`, () => {
  const before = tree('dialog', 'Cookies', 'group Accept all, Frame: [20, 30, 100, 40]', false) + '\n\t\t\t\t6 text Accept all, Frame: [30, 35, 60, 20]\n\t\t\t5 button Reject all';
  assert.equal(engineConsent(method, [[40, 40]], before)?.blocked, true);
  assert.equal(engineConsent(method, [[500, 500]], before), undefined);
});
test('engine point outside a cookie dialog does not borrow its context', () => {
  const before = tree('dialog', 'Cookies', 'button Accept all, Frame: [20, 30, 100, 40]') + '\n\t\t7 button Continue, Frame: [200, 200, 100, 40]';
  assert.equal(engineConsent('click', [[220, 220]], before), undefined);
});
test('engine CMP root supplies privacy wording but unknown root does not', () => {
  assert.equal(engineConsent('click', [4], tree('group OneTrust', 'Your privacy'))?.blocked, true);
  assert.equal(engineConsent('click', [4], tree('group UnknownCMP', 'Your privacy')), undefined);
});

for (const vendor of ['OneTrust', 'CybotCookiebotDialog', 'Didomi', 'Quantcast', 'TrustArc', 'Usercentrics', 'CookieYes', 'Osano', 'Iubenda', 'Sourcepoint', 'Ketch', 'Termly', 'Complianz', 'Borlabs']) {
  test(`engine known CMP ${vendor}`, () => assert.equal(engineConsent('click', [4], tree('group ' + vendor, 'Your privacy'))?.blocked, true));
}
for (const id of ['sketch', 'ketchup', 'myonetruststory']) test(`engine ordinary identifier ${id} is not a CMP`, () => {
  assert.equal(engineConsent('click', [4], tree('group ' + id, 'Your privacy')), undefined);
});
test('engine point with overlapping sibling frames has no proved target', () => {
  const before = tree('dialog', 'Cookies', 'button Accept all, Frame: [20, 30, 100, 40]') + '\n\t\t\t6 button Manage preferences, Frame: [20, 30, 100, 40]';
  assert.equal(engineConsent('click', [[40, 40]], before), undefined);
});
test('engine point without observed geometry stays unclassified', () => {
  assert.equal(engineConsent('click', [[40, 40]], tree()), undefined);
});

for (const row of ['text Reject all', 'button (disabled) Reject all']) test(`engine does not offer an unavailable decline: ${row}`, () => {
  const result = engineConsent('click', [4], tree().replace('button Reject all', row));
  assert.match(result.why, /no reject option.*stop and ask/i);
});

test('engine retry blocks a newly identified cookie region without asking', async () => {
  const before = header + '\n\t\t2 region\n\t\t\t10 heading Preferences\n\t\t\t3 text Choices\n\t\t\t4 button Allow all\n\t\t8 button Read recipe';
  const after = before.replace('heading Preferences', 'heading Cookies');
  let current = before;
  const sent = [];
  const raw = { getAXState: async () => current, click: async number => {
    sent.push(number);
    if (number === 4) { current = after; throw Error('4 is an invalid element ID'); }
  } };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} }, setTimeout, clearTimeout };
  const run = source => runInNewContext(`(async()=>{${source}})()`, context);
  await run(readCode('await cua.getApp("Browser");'));
  let error;
  try { await run(guardedCode('await app.click(8); await app.click(4);', windowFromText(before), 'Stopped.')); } catch (caught) { error = caught; }
  assert.match(error?.message ?? '', /accepting cookies is blocked/);
  assert.doesNotMatch(error.message, /stop and ask|needs the user's decision/i);
  assert.deepEqual(sent, [8, 4]);
});

for (const [code, target] of [
  ['await app.click([40,40]);', 'group Accept all, Frame: [20, 30, 100, 40]'],
  ['await app.click(4);', 'switch Accept all'],
  ['await app.typeText(" ");', 'button Accept all'],
  ['await app.typeText("\\n");', 'button Accept all'],
]) test(`generated guard refuses ${code}`, async () => {
  const before = tree('dialog', 'Cookies', target) + '\nThe focused UI element is 4 button Accept all';
  const sent = [];
  const raw = { getAXState: async () => before, click: async (...args) => sent.push(args), typeText: async (...args) => sent.push(args) };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const run = source => runInNewContext(`(async()=>{${source}})()`, context);
  await run(readCode('await cua.getApp("Browser");'));
  await assert.rejects(run(guardedCode(code, windowFromText(before), 'Stopped.')), /accepting cookies is blocked/);
  assert.equal(sent.length, 0);
});
