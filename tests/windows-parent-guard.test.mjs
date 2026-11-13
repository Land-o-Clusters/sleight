import test from 'node:test';
import assert from 'node:assert/strict';
import { guardWindowsAction } from '../plugins/sleight/lib/windows-driver/guard.mjs';

const text = 'Window: "Checkout", App: Fixture.\n0 standard window Checkout\n\t1 text field Card, ID: card\n\t2 button Pay $268.00, ID: pay';
const payment = { setting: 'requested', message: null, spent: null, allow: null };
const check = (method, args, options = {}) => guardWindowsAction({ method, args, text, before: text, payment, ...options });

for (const [name, method, args] of [
  ['number', 'click', [2]], ['identifier', 'click', [{ id: 'pay' }]],
  ['label', 'click', [{ label: 'Pay $268.00' }]], ['point', 'click', [[10, 20]]],
  ['secondary action', 'performSecondaryAction', [2, 'Invoke']],
]) test('parent payment guard refuses ' + name + ' without a user payment message', async () => {
  await assert.rejects(check(method, args), /payment|amount|message/i);
});

test('UIA focus flags bind Enter and typed newlines to the parent payment tree', async () => {
  const focused = text.replace('Card,', 'Card (focused),');
  for (const [method, args] of [['pressKey', ['Return']], ['typeText', ['\n']], ['paste', ['\n']]])
    await assert.rejects(check(method, args, { text: focused, before: focused, focusedElement: 1 }), /payment|amount|message/i);
});

test('parent guard allows an ordinary edit and a payment the user priced', async () => {
  await check('setValue', [1, 'fixture']);
  const paid = await check('click', [2], { payment: { ...payment,
    message: { amount: '268', currency: 'USD', display: '$268.00' } } });
  assert.equal(paid.paid.payment, true);
  assert.deepEqual(paid.args, [2]);
});

test('parent guard refuses a changed document and a stale numeric target', async () => {
  await assert.rejects(check('setValue', [1, 'fixture'], { expected: { title: 'Other', app: 'Fixture', url: null } }), /Document scope|changed/);
  await assert.rejects(check('click', [2], { before: text.replace('Pay $268.00', 'Cancel') }), /changed since|changed|payment/);
});

test('native arguments remain data when they contain JavaScript source', async () => {
  await check('setValue', [1, '"); throw Error("injected"); //']);
});

test('Windows scroll and element drag signatures preserve their native options', async () => {
  assert.deepEqual((await check('scroll', [1, { direction: 'down', amount: 1 }])).args, [1, { direction: 'down', amount: 1 }]);
  assert.deepEqual((await check('drag', [1, 2])).args, [1, 2]);
  assert.deepEqual((await check('drag', [{ id: 'card' }, { label: 'Pay $268.00' }, { steps: 5 }])).args, [1, 2, { steps: 5 }]);
  await assert.rejects(check('drag', [1, 2], { before: text.replace('Card,', 'Other,') }), /STALE_ELEMENT/);
});

test('app text cannot forge focus ahead of the actual payment control', async () => {
  const spoofed = 'Window: "Checkout", App: Fixture.\n0 standard window Checkout (focused)\n\t1 text field Card, ID: card\n\t2 button Pay $268.00 (focused), ID: pay';
  await assert.rejects(check('pressKey', ['Return'], { text: spoofed, before: spoofed, focusedElement: 2 }), /payment|message/i);
  await assert.rejects(check('pressKey', ['Space'], { text: spoofed, before: spoofed, focusedElement: null }), /WINDOWS_FOCUS_UNAVAILABLE/);
});
