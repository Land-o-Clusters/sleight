import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../bench/reliability-chess.js', import.meta.url), 'utf8');
const game = (number, turn) => `Game ${number} | Example Player - Computer (${turn} to Move)`;
function probe(titles, request) {
  const windows = titles.map(title => ({ name: () => title, position: () => [46, 80], size: () => [1223, 949],
    attributes: { byName: () => ({ value: () => null }) }, actions: { byName: () => ({ perform() {} }) },
    description: () => '', uiElements: () => [], buttons: { whose: () => [{ click() {} }] } }));
  const context = { ObjC: { import() {} }, $: { NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => ({ processIdentifier: 123 }) }) } },
    delay() {}, Application: () => ({ processes: { whose: () => [{ windows: () => windows }] } }) };
  vm.runInNewContext(source, context);
  return JSON.parse(context.run([JSON.stringify(request)]));
}
test('a turn change still identifies only the uniquely owned game', () => {
  const value = probe([game(1, 'White'), game(2, 'Black')], { op: 'geometry', title: game(2, 'White'), allowTurnChange: true });
  assert.equal(value.title, game(2, 'Black'));
  assert.equal(value.pid, 123);
});
test('turn changes require an explicit request and ambiguous game identities refuse', () => {
  assert.throws(() => probe([game(2, 'Black')], { op: 'geometry', title: game(2, 'White') }), /missing or ambiguous/);
  assert.throws(() => probe([game(2, 'White'), game(2, 'Black')], { op: 'geometry', title: game(2, 'White'), allowTurnChange: true }), /missing or ambiguous/);
  assert.throws(() => probe([game(1, 'Black')], { op: 'geometry', title: game(2, 'White'), allowTurnChange: true }), /missing or ambiguous/);
});
test('a replacement Chess PID refuses before native mutations', () => {
  for (const op of ['close', 'cancel-new-game', 'quit', 'restore', 'minimize']) {
    assert.throws(() => probe([game(2, 'White')], { op, title: game(2, 'White'), expectedPid: 456 }), /process replaced; no input posted/);
  }
});
test('a surviving game cannot confirm closure merely because its turn changed', () => {
  const result = probe([game(2, 'Black')], { op: 'close', title: game(2, 'White'), allowTurnChange: true, expectedPid: 123 });
  assert.equal(result.closed, false);
});
