import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const traces = JSON.parse(readFileSync(new URL('./fixtures/verified-results.json', import.meta.url)));
const text = text => ({ type: 'text', text });
const tree = (rows, title = 'a.txt', url = 'file:///tmp/a.txt', app = 'TextEdit') =>
  `Window: ${JSON.stringify(title)}, App: ${app}.\n0 standard window ${title}${url ? ', URL: ' + url : ''}\n${rows.join('\n')}`;
const rows = ['\t1 text entry area (settable) First Text View, Value: before', '\t2 button Save'];
function run(before, after, code = 'await app.typeText("after")', options = {}) {
  const c = createReadCompactor();
  if (before) c.process([text(before)]);
  const action = c.beginAction(code);
  const content = after === undefined ? [] : [text(GUARD_MARK + after + GUARD_END)];
  return c.process(content, { action, ...options }).at(-1)?.text;
}

test('a value change is observed without treating typing as a save', () => {
  const note = run(tree(rows), tree([rows[0].replace('before', 'after'), rows[1]]));
  assert.match(note, /input sent: yes \(engine accepted call\)/);
  assert.match(note, /UI changed: yes \(value or selection changed\)/);
  assert.match(note, /saved: not confirmed \(no save action\)/);
  assert.equal(note.split('\n').length, 1);
});

test('numbering alone and a static label change cannot confirm the action', () => {
  assert.match(run(tree(rows), tree(rows.map(r => r.replace(/\d/, n => +n + 5)))), /no change seen \(only numbering changed\)/);
  assert.match(run(tree(rows), tree([rows[0], '\t2 button Store'])), /no change seen \(no action-related change in tree\)/);
});

test('a newly selected row or a new sheet is observable', () => {
  assert.match(run(tree(['\t1 row (selectable) Item']), tree(['\t1 row (selected) Item']), 'await app.click(1)'), /UI changed: yes/);
  assert.match(run(tree(rows), tree([...rows, '\t3 sheet Save']), 'await app.pressKey("super+s")'), /UI changed: yes \(sheet or dialog changed\)/);
});

test('lost button descriptions are degraded evidence, not a UI change', () => {
  assert.match(run(tree(['\t1 button Description: 2, ID: Two']), tree(['\t1 button Two']), 'await app.click(1)'), /no change seen \(degraded read\)/);
});

test('a missing baseline or post-input read explains the uncertainty', () => {
  assert.match(run(undefined, tree(rows)), /no change seen \(no earlier read\)/);
  assert.match(run(tree(rows), undefined), /no change seen \(no read after input\)/);
  assert.match(run(tree(rows), tree(rows)), /no change seen \(no action-related change in tree\)/);
});

test('failure after input and overlapping calls never confirm saving or UI attribution', () => {
  const before = tree(rows), after = tree(rows, 'b.txt', 'file:///tmp/b.txt');
  assert.match(run(before, after, 'await app.pressKey("super+s")', { failed: true }), /input sent: unverified \(call failed; partial input possible\)/);
  assert.match(run(before, after, 'await app.pressKey("super+s")', { failed: true }), /saved: not confirmed \(call failed\)/);
  const c = createReadCompactor(); c.process([text(before)]);
  const action = c.beginAction('await app.pressKey("super+s")'); action.overlap = true;
  const note = c.process([text(GUARD_MARK + after + GUARD_END)], { action }).at(-1).text;
  assert.match(note, /no change seen \(overlapping calls\)/);
  assert.match(note, /saved: not confirmed \(overlapping calls\)/);
});

test('Save opens a sheet without confirming a file save', () => {
  const sheet = 'Window: "Save", App: TextEdit.\n0 sheet Description: save, ID: save-panel\n\t1 button Save';
  const note = run(tree(rows, 'Untitled', null), sheet, 'await app.pressKey("super+s")');
  assert.match(note, /UI changed: yes \(window changed\)/);
  assert.match(note, /saved: not confirmed \(no document save state change seen\)/);
});

test('a Save action confirms an observed document URL or title change', () => {
  const before = tree(rows, 'Untitled', null), after = tree(rows);
  for (const code of ['await app.pressKey("super+s")', 'await app.click({ label: "Save" })', 'await app.click(2)']) {
    assert.match(run(before, after, code), /saved: yes \(document URL or title changed\)/);
  }
  assert.match(run(tree(rows), tree(rows), 'await app.pressKey("super+s")'), /saved: not confirmed \(no document save state change seen\)/);
});

test('clearing the edited title confirms saving, while adding it does not', () => {
  assert.match(run(tree(rows, 'a.txt — Edited'), tree(rows), 'await app.pressKey("cmd+s")'), /saved: yes/);
  assert.match(run(tree(rows), tree(rows, 'a.txt — Edited'), 'await app.pressKey("cmd+s")'), /saved: not confirmed/);
});

test('a different app, ambiguous headers and an ordinary title change never confirm saving', () => {
  assert.match(run(tree(rows), tree(rows, 'b.txt', 'file:///tmp/b.txt', 'Preview'), 'await app.pressKey("super+s")'), /saved: not confirmed \(another app\)/);
  assert.match(run(tree(rows), tree(rows) + '\n' + tree(rows, 'b.txt'), 'await app.pressKey("super+s")'), /saved: not confirmed/);
  assert.match(run(tree(rows), tree(rows, 'b.txt'), 'await app.typeText("hello")'), /saved: not confirmed \(no save action\)/);
});

test('recorded abbreviated Calculator and TextEdit trees cannot confirm values or saving', () => {
  for (const [kind, code] of [['calculator', 'await app.click(4)'], ['edit', 'await app.pressKey("super+s")']]) {
    const { before, after } = traces[kind];
    const note = run(before, after, code);
    assert.match(note, /UI changed: no change seen \(incomplete read\)/);
    assert.match(note, /saved: not confirmed/);
  }
  const { before, after } = traces.save;
  const note = run(before, after, 'await app.pressKey("Return")');
  assert.match(note, /UI changed: yes \(window changed\)/);
  assert.match(note, /saved: not confirmed \(incomplete read\)/);
});

test('read-only calls and action names inside strings or comments get no summary', () => {
  const c = createReadCompactor();
  for (const code of ['await app.getAXState()', 'nodeRepl.write("app.click(1)")', '// app.click(1)\nawait app.getAXState()']) {
    assert.equal(c.beginAction(code), undefined);
  }
});

test('forceFull keeps the requested tree and still reports observations', () => {
  const c = createReadCompactor(); c.process([text(tree(rows))]);
  const after = tree([rows[0].replace('before', 'after'), rows[1]]);
  const result = c.process([text(GUARD_MARK + after + GUARD_END)], { action: c.beginAction('await app.typeText("after")'), forceFull: true });
  assert.ok(result[0].text.includes(after));
  assert.match(result.at(-1).text, /UI changed: no change seen \(comparison unavailable\)/);
});

test('an exposed modified flag must clear on the same document to confirm saving', () => {
  const before = tree(rows).replace('standard window a.txt,', 'standard window a.txt, Modified: true,');
  const after = before.replace('Modified: true', 'Modified: false');
  assert.match(run(before, after, 'await app.pressKey("super+s")'), /saved: yes \(document modified state cleared\)/);
  assert.match(run(after, before, 'await app.pressKey("super+s")'), /saved: not confirmed/);
});

test('lost value attributes and different-app headers never imply a successful UI change', () => {
  assert.match(run(tree(rows), tree(['\t1 text entry area (settable) First Text View', rows[1]])), /no change seen \(degraded read\)/);
  assert.match(run(tree(rows), tree(rows, 'a.txt', 'file:///tmp/a.txt', 'Preview')), /no change seen \(another app\)/);
});

test('a header without a root or an unterminated guard read cannot confirm a save', () => {
  assert.match(run('Window: "Untitled", App: TextEdit.', tree(rows), 'await app.pressKey("super+s")'), /saved: not confirmed \(incomplete read\)/);
  const c = createReadCompactor(); c.process([text(tree(rows, 'Untitled', null))]);
  const action = c.beginAction('await app.pressKey("super+s")');
  const note = c.process([text(GUARD_MARK + tree(rows))], { action }).at(-1).text;
  assert.match(note, /saved: not confirmed \(incomplete read\)/);
});

test('a failed action or one without a later read invalidates evidence for the next action', () => {
  for (const failed of [true, false]) {
    const c = createReadCompactor(); c.process([text(tree(rows))]);
    c.process([], { action: c.beginAction('await app.typeText("x")'), failed });
    const action = c.beginAction('await app.typeText("after")');
    const note = c.process([text(GUARD_MARK + tree([rows[0].replace('before', 'after'), rows[1]]) + GUARD_END)], { action }).at(-1).text;
    assert.match(note, /UI changed: no change seen \(no earlier read\)/);
  }
});

test('an ambiguous header invalidates evidence until another complete observation', () => {
  const c = createReadCompactor(); c.process([text(tree(rows))]);
  c.process([text(GUARD_MARK + tree(rows) + '\n' + tree(rows, 'b.txt') + GUARD_END)], { action: c.beginAction('await app.click(2)') });
  const note = c.process([text(GUARD_MARK + tree(rows) + GUARD_END)], { action: c.beginAction('await app.typeText("x")') }).at(-1).text;
  assert.match(note, /UI changed: no change seen \(no earlier read\)/);
});

test('a document acquiring a saved title can confirm the save when URL is unavailable', () => {
  assert.match(run(tree(rows, 'Untitled', null), tree(rows, 'a.txt', null), 'await app.pressKey("super+s")'), /saved: yes \(document URL or title changed\)/);
});

test('dropping Help from an unchanged value and renaming a selectable row are not state changes', () => {
  assert.match(run(tree(['\t1 text field Value: before, Help: text']), tree(['\t1 text field Value: before'])), /no change seen \(degraded read\)/);
  assert.match(run(tree(['\t1 row (selectable) Old name']), tree(['\t1 row (selectable) New name']), 'await app.click(1)'), /no change seen \(no action-related change in tree\)/);
});

test('saving then navigating or observing a different handle cannot confirm the saved document', () => {
  const after = tree(rows, 'b.txt', 'file:///tmp/b.txt');
  for (const code of [
    'await app.pressKey("super+s"); await app.pressKey("super+o")',
    'await app.pressKey("super+s"); await other.getAXState()',
    'await app.pressKey("super+o"); await app.pressKey("super+s")',
    'await app.pressKey("super+s"); await cua.getApp("TextEdit")',
  ]) assert.match(run(tree(rows), after, code), /saved: not confirmed \(mixed save targets\)/);
});
