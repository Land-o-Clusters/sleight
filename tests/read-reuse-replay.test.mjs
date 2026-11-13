import test from 'node:test';
import assert from 'node:assert/strict';
import { readReuseReplayCells } from '../scripts/replay-read-reuse.mjs';

const text = 'Window: "Fixture", App: Fixture.\n0 standard window Fixture\n\t1 button OK';
const cell = (after = { full: true, text }) => ({ task: 'fixture', actions: [{ n: 1 }, { n: 1 }],
  before: { text, diffs: [] }, after });
test('replay keeps full pairs and reconstructs changed and unchanged diffs', () => {
  const cells = readReuseReplayCells([cell(), cell({ diff: true,
    text: 'lines changed since the last full tree\n- \tbutton OK\n+ \t1 button Cancel' }),
  cell({ diff: true, text: 'no change since the last full tree' })]);
  assert.equal(cells.length, 3);
  assert.deepEqual(cells.map(row => row.recordedLinesEqual), [true, false, true]);
  assert.equal(cells[1].after.trees['7'].children[0].AXTitle, 'Cancel');
  assert.equal(cells.reduce((n, row) => n + row.laterActions, 0), 3);
});
test('replay excludes missing trees, broken numbering and unapplicable diffs', () => {
  assert.deepEqual(readReuseReplayCells([{}, cell({}), cell({ full: true, text: text.replace('1 button', '3 button') }),
    cell({ diff: true, text: 'lines changed since the last full tree\n- \tbutton Missing' })]), []);
});
