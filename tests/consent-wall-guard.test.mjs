import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { cookieWording, declinesCookies, engineConsent } from '../plugins/sleight/lib/consent-wall.mjs';

const header = 'Window: "Fixture", App: Browser\n0 standard window Fixture\n\t1 HTML content Fixture, URL: http://127.0.0.1:1234/';
const tree = (label = 'Reject all', role = 'dialog', words = 'We use cookies and tracking') => header + `\n\t\t2 ${role}\n\t\t\t3 text ${words}\n\t\t\t4 button Accept all\n\t\t\t5 button ${label}\n\t\t\t6 button Manage preferences\n\t\t\t7 button\n\t\t8 button Read recipe`;
const cleared = header + '\n\t\t8 button Read recipe';
async function guarded(before, code, after = cleared, loseCompletion = false) {
  let current = before;
  const sent = [], written = [];
  const makeRaw = () => ({ getAXState: async () => current,
    ...Object.fromEntries(['click', 'doubleClick', 'rightClick', 'press', 'pressKey', 'performAction', 'setValue', 'typeText', 'paste'].map(name => [name, async (...args) => {
      sent.push(args[0]); current = after; if (loseCompletion) throw Error('input completion lost');
    }])) });
  const context = { cua: { getApp: async () => makeRaw() }, nodeRepl: { write: text => written.push(text) } };
  const run = source => runInNewContext(`(async () => { ${source} })()`, context);
  await run(readCode('await cua.getApp("Browser");'));
  let error;
  try { await run(guardedCode(code, windowFromText(before), 'Stopped.')); } catch (caught) { error = caught; }
  return { sent, text: written.join('\n'), error };
}

for (const role of ['dialog', 'alertdialog', 'group OneTrust', 'container Cookiebot']) test(`engine blocks accept in a qualifying ${role} with cookie text`, async () => {
  const result = await guarded(tree('Reject all', role), 'await app.click(4);');
  assert.match(result.error?.message ?? '', /Reject all/);
  assert.deepEqual(result.sent, []);
});

for (const target of [6, 7, 8]) test(`engine lets nonaccept target ${target} pass`, async () => {
  const result = await guarded(tree(), `await app.click(${target});`);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sent, [target]);
});

for (const label of ['Reject all', 'Use necessary cookies only', 'Alle ablehnen', 'Alles ablehnen', 'Tout refuser', 'Refuser', 'Rechazar todo', 'Rifiuta tutti', 'Rejeitar todos', 'Alles weigeren', 'Odrzuć wszystkie', 'すべて拒否', '全部拒绝', '拒絕全部', '모두 거부', 'Reject optional cookies', 'Deny', 'Continue without accepting']) {
  test(`engine reports a decline named ${label} when the wall closes`, async () => {
    const result = await guarded(tree(label), 'await app.click(5);');
    assert.equal(result.error, undefined);
    assert.deepEqual(result.sent, [5]);
    assert.match(result.text, /decline confirmed/i);
  });
}

for (const label of ['Reject and manage', 'Reject some', 'Save choices', 'Close', 'X', 'Not now', 'Reject all...']) {
  test(`engine passes nonaccept label ${label} without claiming decline`, async () => {
    const result = await guarded(tree(label), 'await app.click(5);');
    assert.equal(result.error, undefined);
    assert.deepEqual(result.sent, [5]);
    assert.doesNotMatch(result.text, /decline confirmed/i);
  });
}

for (const [why, after] of [['wall persists', tree()], ['settings open', tree('Save choices')]]) {
  test(`engine only reports unverified when ${why}, then permits unrelated input`, async () => {
    const result = await guarded(tree(), 'await app.click(5); await app.click(8);', after);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.sent, [5, 8]);
    assert.match(result.text, /decline unverified/i);
  });
}

for (const code of ['await app.click(4);', 'await app.doubleClick(4);', 'await app.performAction(4);', 'await app.setValue(4, "yes");', 'await app.pressKey("Return");']) {
  test(`engine refuses accepting activation: ${code}`, async () => {
    const before = tree() + '\nThe focused UI element is 4 button Accept all';
    const result = await guarded(before, code);
    assert.match(result.error?.message ?? '', /Reject all/);
    assert.deepEqual(result.sent, []);
  });
}

for (const label of ['Accept all, Description: Reject all', 'Reject all, Description: Accept all']) test(`engine checks both visible and accessible names: ${label}`, async () => {
  const result = await guarded(tree(label), 'await app.click(5);');
  assert.match(result.error?.message ?? '', /Cookie acceptance blocked/);
  assert.deepEqual(result.sent, []);
});

for (const words of ['OAuth consent', '同意', '동의', 'Zgoda']) test(`engine permits consent without cookie wording: ${words}`, async () => {
  const result = await guarded(tree('I consent', 'dialog', words), 'await app.click(5);');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sent, [5]);
});

test('engine stops only the accept target when no reject exists', async () => {
  const result = await guarded(tree('Manage choices'), 'await app.click(4);');
  assert.match(result.error?.message ?? '', /no reject option.*ask/i);
  assert.deepEqual(result.sent, []);
  const next = await guarded(tree('Manage choices'), 'await app.click(8);');
  assert.equal(next.error, undefined);
  assert.deepEqual(next.sent, [8]);
});

test('engine never fences a second handle after unverified decline completion', async () => {
  const result = await guarded(tree(), 'try { await app.click(5); } catch {} const alias = await cua.getApp("Browser"); await alias.click(8);', cleared, true);
  // The second input can itself lose completion, but it must have been dispatched.
  assert.deepEqual(result.sent, [5, 8]);
  assert.match(result.text, /decline unverified/i);
});

test('engine accept refusal applies on an alias for the same app and window', async () => {
  const result = await guarded(tree(), 'try { await app.click(4); } catch {} const alias = await cua.getApp("Browser"); await alias.click(4);');
  assert.match(result.error?.message ?? '', /Reject all/);
  assert.deepEqual(result.sent, []);
});

test('engine does not use cookie wording beyond the nearest landmark', () => {
  const before = header + '\n\t\t2 region Cookies\n\t\t\t3 button Accept all\n\t\t4 main\n\t\t\t5 button Continue';
  assert.equal(engineConsent('click', [5], before)?.blocked, undefined);
});

for (const words of ['Çerezler', 'Kakor', 'Evästeet', 'Sütik', 'Galletas', 'Kekse']) test(`bare cookie topic excludes ${words}`, () => {
  assert.equal(cookieWording(words), false);
});
for (const words of ['consent', '同意', '동의', 'zgoda', 'OAuth permission', 'personalisierte Werbung', 'OneTrust', 'Cookiebot', 'partenaires', 'tracking', 'privacy', 'partners']) test(`cookie wording excludes bare ${words}`, () => {
  assert.equal(cookieWording(words), false);
});
for (const label of ['Refuser', 'Alles ablehnen', '拒絕全部', 'Reject optional cookies', 'Deny', 'Continue without accepting']) test(`decline classifier recognises ${label}`, () => {
  assert.equal(declinesCookies(label), true);
});

test('engine does not borrow cookie wording from a sibling dialog at the frame root', () => {
  const before = header + '\n\t\t2 dialog\n\t\t\t3 text Cookies\n\t\t\t4 button Accept all\n\t\t5 button Continue';
  assert.equal(engineConsent('click', [5], before)?.blocked, undefined);
});

test('engine includes cookie wording on the ancestor row itself', () => {
  const before = header + '\n\t\t2 dialog Cookiebot\n\t\t\t4 button Accept all\n\t\t\t5 button Reject all';
  assert.equal(engineConsent('click', [4], before)?.blocked, true);
  assert.match(engineConsent('click', [4], before)?.why, /Reject all/);
});

test('engine finds the decline outside a nested Accept cookies group in the same dialog', () => {
  const before = header + '\n\t\t2 dialog\n\t\t\t3 group\n\t\t\t\t4 button Accept cookies\n\t\t\t5 button Reject all';
  assert.match(engineConsent('click', [4], before)?.why, /Reject all/);
});

// Review g11-engine-read: keys act on current focus, so a wall that appeared after the last read is read fresh.
test('engine reads fresh before Return when the last tree showed no wall', async () => {
  let current = cleared;
  const sent = [];
  const raw = { getAXState: async () => current, pressKey: async key => { sent.push(key); },
    typeText: async text => { sent.push(text); current = tree() + '\nThe focused UI element is 4 button Accept all'; } };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const run = source => runInNewContext(`(async () => { ${source} })()`, context);
  await run(readCode('await cua.getApp("Browser");'));
  let error;
  // A page script raises the wall and focuses Accept after the typing, inside the same call.
  try { await run(guardedCode('await app.typeText("x"); await app.pressKey("Return");', windowFromText(cleared), 'Stopped.')); } catch (caught) { error = caught; }
  assert.match(error?.message ?? '', /Cookie acceptance blocked/);
  assert.deepEqual(sent, ['x']);
});
