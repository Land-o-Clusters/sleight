import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { finderDiagnostic } from '../bench/real-fixture.mjs';

function source() {
  const s = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  assert.equal(typeof s.finderStaticFailure, 'function', 'the closed error classifier is missing');
  return error => JSON.parse(JSON.stringify(s.finderStaticFailure(error)));
}

const guards = [
  ['Finder baseline role ledger ownership unconfirmed', 'ledger-unconfirmed'],
  ['Finder pre-action baseline role inventory changed', 'baseline-changed'],
  ['Finder previous window absent from inventory', 'previous-absent'],
  ['Finder window appeared before New Finder Window', 'window-before-new-command'],
  ['New Finder fixture window ambiguous', 'new-window-ambiguous'],
  ['New Finder fixture window unconfirmed', 'new-window-unconfirmed'],
  ['New Finder fixture window identity changed', 'new-window-identity-changed'],
  ['Foreign Finder dialog; folder setup refused', 'foreign-dialog'],
  ['Finder folder window vanished', 'window-vanished'],
  ['Finder folder window lost focus', 'window-focus-lost'],
  ['Finder folder focus changed during validation', 'window-focus-changed'],
  ['Finder focused element ancestry unconfirmed', 'focused-ancestry-unconfirmed'],
  ['Fixture needs the File menu', 'menu-unavailable'],
  ['Fixture needs the Go menu', 'menu-unavailable'],
  ['Fixture menu item unavailable or ambiguous', 'menu-item-unavailable'],
  ['Fixture opening interrupted before identity was recorded', 'opening-interrupted'],
  ['Finder fixture window ownership unconfirmed', 'fixture-ownership-unconfirmed'],
  ['Finder extra window ownership unconfirmed', 'extra-window-unconfirmed'],
  ['Finder fixture identity changed', 'fixture-identity-changed'],
  ['Finder fixture window is still open', 'fixture-still-open'],
  ['Finder dialog present; fixture cleanup refused', 'dialog-present'],
  ['Fixture cancellation target is not an observed menu', 'menu-cancel-target-unconfirmed'],
  ['Fixture menu cancellation failed; Escape refused', 'menu-cancel-failed'],
  ['File-menu cancellation lost the app identity', 'cancellation-app-identity-lost'],
];

for (const [message, failureReason] of guards) test(`closed Finder failure classifies ${failureReason}: ${message}`, () => {
  const classify = source(), expected = { failureReason, errorName: 'Error', errorCode: 'unavailable' };
  assert.deepEqual(classify(new Error(message)), expected);
  for (const key of ['finderFailure', 'finderCleanupFailure', 'finderMenuCleanupFailure'])
    assert.deepEqual(finderDiagnostic({ [key]: expected }), { [key]: expected });
  assert.equal(classify(new Error(`${message} owner-private-title`)).failureReason, 'unclassified');
});

test('typed inventory and AX errors export only recognized metadata', () => {
  const classify = source();
  assert.deepEqual(classify({ finderFailureReason: 'inventory-unconfirmed', name: 'Error', message: 'private inventory role/title' }),
    { failureReason: 'inventory-unconfirmed', errorName: 'Error', errorCode: 'unavailable' });
  assert.deepEqual(classify({ message: 'AX fixture press failed: -25204', name: 'Error' }),
    { failureReason: 'ax-press-failed', errorName: 'Error', errorCode: -25204 });
  assert.deepEqual(classify({ message: 'private native error', name: 'NSInvalidArgumentException', code: -25202, attribute: 'AXRole' }),
    { failureReason: 'ax-read-failed', errorName: 'NSInvalidArgumentException', errorCode: -25202 });
});

test('unknown native metadata and arbitrary messages never pass through', () => {
  const classify = source();
  for (const error of [new Error('owner-private-title /owner/private/path'),
    { name: 'OwnerPrivateException', code: 1234567, message: 'owner-private-title', finderFailureReason: 'owner-private-reason' },
    { name: ['Error'], code: '-25204', message: { toString: () => 'owner-private-title' } }]) {
    const result = classify(error);
    assert.equal(result.failureReason, 'unclassified');
    assert.doesNotMatch(JSON.stringify(result), /owner-private|OwnerPrivate|1234567/);
    assert.deepEqual(finderDiagnostic({ finderFailure: { ...result, message: 'owner-private-title', raw: error } }), { finderFailure: result });
  }
  assert.deepEqual(finderDiagnostic({ finderFailure: { failureReason: 'owner-private', errorName: 'OwnerPrivateException', errorCode: 12345 } }), { finderFailure: {} });
});

test('failing ObjC and NSError metadata getters cannot replace or expose the original failure', () => {
  const classify = source(), error = {};
  for (const key of ['message', 'name', 'code', 'attribute', 'finderFailureReason'])
    Object.defineProperty(error, key, { get() { throw new Error('owner-private-getter-error'); } });
  assert.deepEqual(classify(error), { failureReason: 'unclassified', errorName: 'unavailable', errorCode: 'unavailable' });
});

test('bounded native error schema accepts AX codes and fixed exception names only', () => {
  const classify = source();
  for (const code of [0, ...Array.from({ length: 15 }, (_, i) => -25200 - i)]) {
    const result = classify({ code, name: 'NSRangeException' });
    assert.equal(result.errorCode, code);
    assert.equal(result.errorName, 'NSRangeException');
    assert.deepEqual(finderDiagnostic({ finderCleanupFailure: result }), { finderCleanupFailure: result });
  }
  for (const code of [NaN, Infinity, -25215, -25199, 0.5, '0']) assert.equal(classify({ code }).errorCode, 'other');
});

for (const phase of ['pre-press', 'poll', 'validate', 'cleanup']) test(`baseline diagnostics preserve fixed metadata in ${phase}`, () => {
  const s = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  const owner = { role: 'AXWindow', title: 'owner-private-title', document: '/owner/private/path' };
  const receipt = { schema: 'finder-role-baseline-v1', baseline: [{ reference: owner, role: 'AXWindow' }], created: [] };
  const api = { windows: () => [{ role: 'AXScrollArea' }], equal: (a, b) => a === b, finderRole: w => w.role };
  assert.throws(() => s.finderRoleInventory({}, api, receipt, phase), error => {
    const diagnostic = JSON.parse(JSON.stringify(s.finderStaticFailure(error)));
    assert.deepEqual(diagnostic, { failureReason: 'baseline-changed', errorName: 'Error', errorCode: 'unavailable',
      phase, baselineCount: 1, currentCount: 1, missingRole: 'AXWindow', missingIndex: 0, scrollAreasBaseline: 0, scrollAreasMatched: 0 });
    assert.deepEqual(finderDiagnostic({ finderFailure: diagnostic }), { finderFailure: diagnostic });
    assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostic }), /owner-private|\/owner\/private/);
    return true;
  });
});

test('baseline diagnostics discard private vocabulary, invalid counts and extra data at both boundaries', () => {
  const classify = source();
  for (const value of ['owner-private-title', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, {}, []]) {
    const input = { message: 'Finder pre-action baseline role inventory changed', name: 'Error', phase: 'owner-private-title',
      baselineCount: value, currentCount: value, missingIndex: value, scrollAreasBaseline: value, scrollAreasMatched: value,
      missingRole: '/owner/private/path', title: 'owner-private-title' };
    const expected = { failureReason: 'baseline-changed', errorName: 'Error', errorCode: 'unavailable' };
    assert.deepEqual(classify(input), expected);
    assert.deepEqual(finderDiagnostic({ finderBaselineChange: { ...input, ...expected } }), { finderBaselineChange: expected });
  }
  const error = new Error('Finder pre-action baseline role inventory changed');
  for (const key of ['phase', 'baselineCount', 'currentCount', 'missingIndex', 'missingRole', 'scrollAreasBaseline', 'scrollAreasMatched'])
    Object.defineProperty(error, key, { get() { throw new Error('owner-private-getter-error'); } });
  assert.deepEqual(classify(error), { failureReason: 'baseline-changed', errorName: 'Error', errorCode: 'unavailable' });
});
