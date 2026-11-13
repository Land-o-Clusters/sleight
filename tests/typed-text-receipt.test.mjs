import test from 'node:test';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { typedTextReceipt, typingReceiptCall, typingReceiptCode, withoutTypingReceipt } from '../plugins/sleight/lib/typed-text-receipt.mjs';
import { GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/document-scope.mjs';

// The study's document-focused, unchanged table-typing shape, with generic fixture names.
const tree = 'Window: "Draft", App: Example.\n0 standard window Draft\n\t1 text entry area Body, Value: existing\nThe focused UI element is 1 text entry area Body';
const mark = '[sleight:filtered-read:owned]';
const action = { before: { lines: tree.split('\n') } };
const content = (snapshot = tree, typed = ['A\tB\n1\t2']) => [{ type: 'text', text: GUARD_MARK + snapshot + GUARD_END + mark + JSON.stringify({ typedCharacters: typed.reduce((sum, value) => sum + [...value].length, 0) }) + '\n' }];

test('an unchanged focused document gets character count without echoing typed text or values', () => {
  const note = typedTextReceipt({ action, content: content(), mark });
  assert.match(note, /sent 7 characters to text entry area Body/);
  assert.match(note, /tree unchanged; insertion unconfirmed/);
  assert.doesNotMatch(note, /existing|A\tB/);
});

test('actual runtime strings count escaped input and Unicode, including paste batches', () => {
  const note = typedTextReceipt({ action, content: content(tree, ['A\n', '💡']), mark });
  assert.match(note, /sent 3 characters/);
  for (const method of ['typeText', 'paste']) assert.equal(typingReceiptCall(`await app.${method}(text)`), true);
});

for (const [name, options] of [
  ['failure', { failed: true }], ['overlap', { action: { ...action, overlap: true } }],
  ['partial baseline', { action: { before: { ...action.before, incomplete: true } } }],
  ['missing baseline', { action: {} }], ['wrong mark', { mark: 'other' }],
  ['changed value', { content: content(tree.replace('existing', 'changed')) }],
  ['changed focus', { content: content(tree.replace('is 1 text entry area Body', 'is 0 standard window Draft')) }],
  ['new window', { content: content(tree.replace('Draft', 'Other')) }],
  ['textless tree', { action: { before: { lines: tree.replace(', Value: existing', '').split('\n') } }, content: content(tree.replace(', Value: existing', '')) }],
  ['secure field', { action: { before: { lines: tree.replace('text entry area Body', 'secure text field Password').split('\n') } }, content: content(tree.replace('text entry area Body', 'secure text field Password')) }],
  ['no runtime typing', { content: content(tree, []) }],
]) test(`no typing receipt for ${name}`, () => {
  assert.equal(typedTextReceipt({ action, content: content(), mark, ...options }), undefined);
});

test('source text cannot turn a key, setValue, mixed input or quoted method into a typing receipt', () => {
  for (const code of ['await app.pressKey("Return")', 'await app.setValue(1, "x")',
    'await app.typeText("x"); await other.paste("y")', 'await app.typeText("x"); await app.click(1)',
    'nodeRepl.write("app.typeText(\\"x\\")")', '/* app.paste("x") */ 1']) assert.equal(typingReceiptCall(code), false, code);
});


test('runtime marker contains only a count, and removing it preserves filtered-read markers', () => {
  const writes = [];
  const realm = { __sleightDocumentGuard: { typed: ['private input', '💡'] }, nodeRepl: { write: text => writes.push(text) } };
  runInNewContext(typingReceiptCode(mark), realm);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].slice(mark.length)).typedCharacters, 14);
  assert.doesNotMatch(writes[0], /private input|💡/);
  const filtered = mark + JSON.stringify({ visible: ['kept row'] }) + '\n';
  const input = [{ type: 'text', text: filtered + writes[0] }, { type: 'image', data: 'AA==' }];
  assert.deepEqual(withoutTypingReceipt(input, mark), [{ type: 'text', text: filtered }, input[1]]);
});

test('a changed continuation of a multiline value is a tree change', () => {
  const before = tree.replace('Value: existing', 'Value: existing\nold continuation');
  const after = tree.replace('Value: existing', 'Value: existing\nnew continuation');
  assert.equal(typedTextReceipt({ action: { before: { lines: before.split('\n') } }, content: content(after), mark }), undefined);
});
