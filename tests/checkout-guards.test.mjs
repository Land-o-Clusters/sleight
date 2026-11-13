import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode, elementLines, elementParents } from '../plugins/sleight/lib/document-scope.mjs';

const expected = { title: 'Checkout', app: 'Fixture Browser', url: 'https://shop.test/checkout' };
const tree = rows => `Window: "Checkout", App: Fixture Browser.\n0 standard window Checkout, URL: ${expected.url}\n${rows}`;
const before = tree('\t1 container Delivery\n\t\t21 text field (settable) Phone\n\t\t38 radio button Overnight Next business day · $29\n\t2 container Card\n\t\t46 text field (settable) Card number\n\t\t48 text field (settable) Expiry (MM/YY)');
const after = before.replace('38 radio button', '38 container\n\t\t39 radio button').replace('48 text field', '48 text CVC\n\t\t49 text field');
function fixture({ first = before, next = after } = {}) {
  let changed = false;
  const calls = [], output = [], bindingReads = [];
  const raw = { getAXState: async () => { calls.push(['read']); return changed ? next : first; } };
  for (const name of ['setValue', 'click', 'pressKey', 'typeText']) raw[name] = async (...args) => {
    calls.push([name, ...args]); changed = true;
  };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: value => { output.push(value); if (value.includes('"binding"')) bindingReads.push(calls.filter(c => c[0] === 'read').length); } } };
  return { calls, output, bindingReads, run: (code, options = {}) => runInNewContext(`(async () => { ${guardedCode(code, expected, 'changed window', undefined, {
    literalOrder: [], seenLines: Object.fromEntries(elementLines(first)), seenParents: Object.fromEntries(elementParents(first)), ...options,
  })} })()`, context) };
}

test('CK2 does not recover radio buttons or payment fields after a non-opening action', async () => {
  const f = fixture();
  await assert.rejects(f.run('await app.click(21); await app.click(38);'), /changed what element/);
  assert.deepEqual(f.calls.filter(c => c[0] !== 'read').map(c => c.slice(0, 2)), [['click', 21]]);
});

test('CK2 keeps payment-worded targets and actions after openers stopped', async () => {
  for (const pay of [false, true]) {
    const first = pay ? before.replace('Overnight Next business day · $29', 'Pay now') : before;
    const next = pay ? after.replace('Overnight Next business day · $29', 'Pay now') : after;
    const f = fixture({ first, next });
    const action = pay ? 'click(21)' : 'setValue(21, "555")';
    await assert.rejects(f.run(`await app.${action}; await app.click(38);`), /changed what element/);
    assert.equal(f.calls.filter(c => c[0] === 'click' && c[1] !== 21).length, 0);
  }
});

test('CK2 off restores the old moved-plain-line refusal and exact output', async () => {
  const f = fixture();
  await assert.rejects(f.run('await app.click(21); await app.click(38);', { ck2: false }), /changed what element 38/);
  assert.equal(f.output.filter(line => /renumbered the window/.test(line)).length, 0);
});

test('CK1 traces every setValue decision and keeps reads between renumbering setValues', async () => {
  const f = fixture();
  await assert.rejects(f.run('await app.setValue(46, "4111"); await app.setValue(48, "12/28");',
    { bind: true, guardStopMark: '[ck]' }), /changed what element/);
  assert.deepEqual(f.calls.filter(c => c[0] === 'setValue').map(c => c[1]), [46]);
  const decisions = f.output.filter(line => line.startsWith('[ck]{"binding"')).map(line => JSON.parse(line.slice(4)).binding);
  assert.equal(decisions.length, 2);
  assert.deepEqual(f.bindingReads, [1, 2]);
  assert.deepEqual(decisions.map(d => [d.decision, d.reason]), [['read', 'first-capture'], ['read', 'previous-opens']]);
});

test('CK1 off leaves binding diagnostics out and retains the final read', async () => {
  const f = fixture({ next: before });
  await f.run('await app.setValue(46, "4111"); await app.setValue(48, "12/28");', { bind: true, ck1: false, guardStopMark: '[ck]' });
  assert.equal(f.output.filter(line => line.startsWith('[ck]{"binding"')).length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
});

test('CK1 records an existing bound field and still takes the final read', async () => {
  const f = fixture({ next: before });
  await f.run('await app.click(21); await app.setValue(48, "12/28");', { bind: true, guardStopMark: '[ck]' });
  const decision = f.output.filter(line => line.startsWith('[ck]{"binding"')).map(line => JSON.parse(line.slice(4)).binding);
  assert.equal(decision.length, 1);
  assert.equal(decision[0].decision, 'bound');
  assert.equal(decision[0].reason, 'existing-binding');
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
});

test('CK1 reads and stops when renumbering puts another settable field on the requested number', async () => {
  const f = fixture({ next: after.replace('48 text CVC', '48 text field (settable) CVC') });
  await assert.rejects(f.run('await app.setValue(46, "4111"); await app.setValue(48, "12/28");', { bind: true }), /changed what element/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'setValue', 'read']);
  assert.deepEqual(f.calls.filter(c => c[0] === 'setValue').map(c => c[1]), [46]);
});

const plainBefore = tree('\t1 container Contact\n\t\t2 text field (settable) Name\n\t\t3 text field (settable) Email');
const plainAfter = plainBefore.replace('2 text field (settable) Name', '2 text field (settable) Name, Value: owner')
  .replace('3 text field', '3 text Enter an email\n\t\t4 text field') + '\n\t5 text Ready';

test('CK2 remaps a plain text field after setValue with the same settable inventory', async () => {
  const f = fixture({ first: plainBefore, next: plainAfter });
  await f.run('await app.setValue(2, "owner"); await app.setValue(3, "c@example.test");', { bind: true });
  assert.deepEqual(f.calls, [['read'], ['setValue', 2, 'owner'], ['read'], ['setValue', 4, 'c@example.test'], ['read']]);
  assert.equal(f.output.filter(line => /renumbered the window/.test(line)).length, 1);
});

for (const [reason, next] of [
  ['new settable field', plainAfter.replace('3 text Enter an email', '3 text field (settable) Recovery code')],
  ['equal count replacement', plainAfter.replace('Name, Value: owner', 'Recovery code')],
  ['duplicate target', plainAfter + '\n\t\t5 text field (settable) Email'],
  ['changed parent', plainAfter.replace('container Contact', 'container Account')],
  ['duplicate parent', plainAfter + '\n\t5 container Contact'],
  ['changed role', plainAfter.replace('4 text field', '4 combo box')],
  ['changed label', plainAfter.replace('4 text field (settable) Email', '4 text field (settable) Recovery email')],
  ['bare parent', plainAfter.replace('container Contact', 'container')],
  ['sheet', plainAfter + '\n\t5 sheet Confirm'],
]) test(`CK2 post-setValue recovery refuses ${reason}`, async () => {
  const f = fixture({ first: plainBefore, next });
  await assert.rejects(f.run('await app.setValue(2, "owner"); await app.setValue(3, "c@example.test");', { bind: true }), /changed what element/);
  assert.equal(f.calls.filter(c => c[0] === 'setValue').length, 1);
});

test('CK2 off keeps post-setValue moved plain fields stopped', async () => {
  const f = fixture({ first: plainBefore, next: plainAfter });
  await assert.rejects(f.run('await app.setValue(2, "owner"); await app.setValue(3, "c@example.test");', { bind: true, ck2: false }), /changed what element/);
  assert.equal(f.calls.filter(c => c[0] === 'setValue').length, 1);
});

test('CK2 does not remap a card field or a field under a payment parent after setValue', async () => {
  for (const [from, to] of [['Email', 'Card number'], ['Email', 'Expiry (MM/YY)'], ['container Contact', 'container Card payment']]) {
    const f = fixture({ first: plainBefore.replaceAll(from, to), next: plainAfter.replaceAll(from, to) });
    await assert.rejects(f.run('await app.setValue(2, "owner"); await app.setValue(3, "12/28");', { bind: true }), /changed what element/);
    assert.equal(f.calls.filter(c => c[0] === 'setValue').length, 1);
  }
});

test('CK1 retains the full read when an engine capture reassigns a number without changing native field identities', async () => {
  const f = fixture({ first: plainBefore, next: plainBefore.replace('3 text field (settable) Email', '3 text field (settable) Recovery code') });
  await assert.rejects(f.run('await app.setValue(2, "owner"); await app.setValue(3, "c@example.test");', { bind: true }), /changed what element/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'setValue', 'read']);
});

const watched = ['Pay now', 'Buy now', 'Checkout', 'Cardholder name', 'CardNumber', 'Expires', 'Exp. date', 'MM/YY',
  'Credit', 'Debit', 'IBAN', 'Routing', 'Account number', 'SSN', 'Social security', 'PIN', 'OTP', 'Billing', 'Bank',
  'CVV', 'CVC', 'Password', 'Passcode', 'Secret', 'Security code', 'Secure'];
for (const prior of ['setValue(2, "owner")', 'typeText("owner")']) {
  for (const word of watched) test(`CK2 refuses ${word} after ${prior.split('(')[0]} on either recovery path`, async () => {
    for (const ancestor of [false, true]) {
      const from = ancestor ? 'container Contact' : 'Email', to = ancestor ? `container ${word}` : word;
      const f = fixture({ first: plainBefore.replaceAll(from, to), next: plainAfter.replaceAll(from, to) });
      await assert.rejects(f.run(`await app.${prior}; await app.setValue(3, "value");`, { bind: prior.startsWith('setValue') }), /changed what element/);
      assert.equal(f.calls.filter(c => c[0] === 'setValue' && c[1] !== 2).length, 0);
    }
  });
}
for (const prior of ['setValue(2, "owner")', 'typeText("owner")']) {
  test(`CK2 refuses an untitled sheet after ${prior.split('(')[0]}`, async () => {
    const f = fixture({ first: plainBefore, next: plainAfter + '\n\t8 sheet, ID: confirm' });
    await assert.rejects(f.run(`await app.${prior}; await app.setValue(3, "value");`, { bind: prior.startsWith('setValue') }), /changed what element/);
  });
  test(`CK2 refuses secure text roles after ${prior.split('(')[0]}`, async () => {
    const f = fixture({ first: plainBefore.replace('text field (settable) Email', 'secure text field (settable) Email'),
      next: plainAfter.replace('text field (settable) Email', 'secure text field (settable) Email') });
    await assert.rejects(f.run(`await app.${prior}; await app.setValue(3, "value");`, { bind: prior.startsWith('setValue') }), /changed what element/);
  });
}
test('CK2 still recovers an ordinary plain field after typing', async () => {
  const f = fixture({ first: plainBefore, next: plainAfter });
  await f.run('await app.typeText("owner"); await app.setValue(3, "c@example.test");', { bind: false });
  assert.deepEqual(f.calls.filter(c => c[0] === 'setValue'), [['setValue', 4, 'c@example.test']]);
});
test('CK1 reports a completed read when a predicted binding is replaced by fresh evidence', async () => {
  const f = fixture({ first: plainBefore, next: plainBefore });
  await f.run('await app.click(2); await app.setValue(3, "c@example.test");', { bind: true, careful: true, guardStopMark: '[ck]' });
  const decisions = f.output.filter(line => line.startsWith('[ck]{"binding"')).map(line => JSON.parse(line.slice(4)).binding);
  assert.equal(decisions[0].decision, 'read');
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
});

for (const prior of ['setValue(2, "owner")', 'typeText("owner")']) test(`CK2 checks payment ancestors above the parent after ${prior.split('(')[0]}`, async () => {
  const nest = text => text.replace('\n\t1 container Contact', '\n\t9 container Billing\n\t\t1 container Contact').replaceAll('\n\t\t2 ', '\n\t\t\t2 ').replaceAll('\n\t\t3 ', '\n\t\t\t3 ').replaceAll('\n\t\t4 ', '\n\t\t\t4 ');
  const f = fixture({ first: nest(plainBefore), next: nest(plainAfter) });
  await assert.rejects(f.run(`await app.${prior}; await app.setValue(3, "value");`, { bind: prior.startsWith('setValue') }), /changed what element/);
});
