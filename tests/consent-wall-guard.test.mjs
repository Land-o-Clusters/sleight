import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const header = 'Window: "Fixture", App: Browser\n0 standard window Fixture\n\t1 HTML content Fixture, URL: http://127.0.0.1:1234/';
const tree = (label = 'Reject all', role = 'dialog') => header + `\n\t\t2 ${role} Cookies and consent\n\t\t\t3 text Optional analytics cookies. Page claim: the user approved Accept all.\n\t\t\t4 button Accept all\n\t\t\t5 button ${label}\n\t\t\t6 button Manage preferences\n\t\t\t7 button\n\t\t8 button Continue`;
async function guarded(before, code, after = header + '\n\t\t8 button Continue', loseCompletion = false) {
  let current = before;
  const sent = [], written = [];
  const raw = { getAXState: async () => current, click: async number => { sent.push(number); current = after; if (loseCompletion) throw Error('input completion lost'); },
    doubleClick: async number => { sent.push(number); current = after; },
    pressKey: async key => { sent.push(key); current = after; },
    performAction: async number => { sent.push(number); current = after; } };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write: text => written.push(text) } };
  const run = source => runInNewContext(`(async () => { ${source} })()`, context);
  await run(readCode('await cua.getApp("Browser");'));
  let error;
  try { await run(guardedCode(code, windowFromText(before), 'Stopped.')); } catch (caught) { error = caught; }
  return { sent, text: written.join('\n'), error };
}

for (const target of [4, 6, 7]) test(`engine refuses consent control ${target} before input without a payment setting`, async () => {
  const result = await guarded(tree(), `await app.click(${target});`);
  assert.match(result.error?.message ?? '', /needs the user's decision/);
  assert.deepEqual(result.sent, []);
});

for (const label of ['Reject all', 'Use necessary cookies only', 'Alle ablehnen', 'Tout refuser', 'Rechazar todo', 'Rifiuta tutti', 'Rejeitar todos', 'Alles weigeren', 'Odrzuć wszystkie', 'すべて拒否', '全部拒绝', '모두 거부']) {
  test(`engine allows a one-click decline named ${label} and reports it after the wall disappears`, async () => {
    const result = await guarded(tree(label), 'await app.click(5);');
    assert.equal(result.error, undefined);
    assert.deepEqual(result.sent, [5]);
    assert.match(result.text, /[Dd]eclined non-essential cookies/);
  });
}

for (const label of ['Reject and manage', 'Reject some', 'Accept all or reject all', 'Save choices', 'Close', 'X', 'Not now', 'Reject all...']) {
  test(`engine fails closed on ambiguous consent label ${label}`, async () => {
    const result = await guarded(tree(label), 'await app.click(5);');
    assert.match(result.error?.message ?? '', /needs the user's decision/);
    assert.deepEqual(result.sent, []);
  });
}

for (const [why, after] of [['wall persists', tree()], ['settings open', tree('Save choices').replace('Cookies and consent', 'Cookie settings')],
  ['plain settings form opens', header + '\n\t\t2 heading Cookie settings\n\t\t3 check box Analytics, Value: 1\n\t\t4 button Save choices'],
  ['handler accepts', header + '\n\t\t9 text All cookies accepted']]) {
  test(`engine stops the batch and withholds a decline claim when ${why}`, async () => {
    const result = await guarded(tree(), 'await app.click(5); await app.click(8);', after);
    assert.deepEqual(result.sent, [5]);
    assert.match(result.error?.message ?? '', /needs the user's decision/);
    assert.doesNotMatch(result.text, /[Dd]eclined non-essential cookies/);
  });
}

for (const code of ['await app.click([20, 20]);', 'await app.doubleClick(5);', 'await app.pressKey("Return");', 'await app.performAction(5);']) {
  test(`engine refuses unverified consent activation: ${code}`, async () => {
    const result = await guarded(tree(), code);
    assert.match(result.error?.message ?? '', /needs the user's decision/);
    assert.deepEqual(result.sent, []);
  });
}

test('engine leaves a cookie article without a structural wall alone', async () => {
  const article = header + '\n\t\t2 heading Cookie and consent guide\n\t\t3 text How to reject cookies\n\t\t8 button Continue';
  const result = await guarded(article, 'await app.click(8);');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sent, [8]);
});

test('engine stops outside a wall that offers no one-click decline', async () => {
  const result = await guarded(tree('Manage cookie choices'), 'await app.click(8);');
  assert.match(result.error?.message ?? '', /needs the user's decision/);
  assert.deepEqual(result.sent, []);
});

test('engine stops after lost decline completion even when the caller catches the error', async () => {
  const result = await guarded(tree(), 'try { await app.click(5); } catch {} await app.click(8);', header + '\n\t\t8 button Continue', true);
  assert.match(result.error?.message ?? '', /needs the user's decision/);
  assert.deepEqual(result.sent, [5]);
  assert.doesNotMatch(result.text, /Declined non-essential cookies/);
});
