import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARD_MARK, createReadCompactor, lineDiff } from '../plugins/sleight/lib/compact-reads.mjs';

const tree = (rows, title = 'a.txt') => [`Window: "${title}", App: TextEdit.`,
  `0 standard window ${title}, URL: file:///tmp/${title}, Secondary Actions: Raise`, ...rows].join('\n');
const sidebar = Array.from({ length: 50 }, (_, i) => `\t${i + 2} row (selectable) Value: Chat ${i}`);
const text = item => ({ type: 'text', text: item });
const apply = (c, ...items) => c.process(items.map(text)).map(i => i.text);

test('the line diff lists removed and added lines in order', () => {
  assert.deepEqual(lineDiff(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']), ['- b', '+ x', '+ e']);
  assert.deepEqual(lineDiff(['a'], ['a']), []);
});

test('a guard read after a full tree Claude saw becomes the changed lines', () => {
  const c = createReadCompactor();
  const before = tree([...sidebar, '\t1 text entry area Value: alpha']);
  assert.deepEqual(apply(c, before), [before], 'a full tree Claude reads passes through');
  const [out] = apply(c, GUARD_MARK + tree([...sidebar, '\t1 text entry area Value: alpha beta']));
  assert.match(out, /^Window: "a\.txt", App: TextEdit\.\n0 standard window a\.txt, URL: file:\/\/\/tmp\/a\.txt/);
  assert.match(out, /- \t1 text entry area Value: alpha\n\+ \t1 text entry area Value: alpha beta$/);
  assert.doesNotMatch(out, /Chat 7/, 'the unchanged sidebar is left out');
});

test('an unchanged window says so, and the next diff starts from the guard read', () => {
  const c = createReadCompactor();
  apply(c, tree(sidebar));
  assert.match(apply(c, GUARD_MARK + tree(sidebar))[0], /no change since the last full tree/);
  const [out] = apply(c, GUARD_MARK + tree([...sidebar, '\t60 button OK']));
  assert.match(out, /\+ \t60 button OK$/);
});

test('the first read of a window, another window, or a large change is sent whole without the mark', () => {
  const c = createReadCompactor();
  const first = tree(sidebar);
  assert.deepEqual(apply(c, GUARD_MARK + first), [first]);
  const other = tree(sidebar, 'b.txt');
  assert.deepEqual(apply(c, GUARD_MARK + other), [other]);
  const rerendered = tree(sidebar.map(l => l.replace('row', 'cell')), 'b.txt');
  assert.deepEqual(apply(c, GUARD_MARK + rerendered), [rerendered], 'a re-render is shorter whole');
});

test('engine diffs and other output never replace the copy', () => {
  const c = createReadCompactor();
  apply(c, tree(sidebar));
  apply(c, 'The following is a diff from the previous accessibility tree for Window: "a.txt"\n+ \t99 button X', 'note');
  const [out] = apply(c, GUARD_MARK + tree([...sidebar, '\t99 button X']));
  assert.match(out, /\+ \t99 button X$/, 'changes Claude saw in an engine diff are shown again, never lost');
});
