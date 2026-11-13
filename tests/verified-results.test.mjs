import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

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
  return c.process(content, { action, ...options }).find(item => /^sleight: (?:UI|call failed|saved:)/.test(item.text))?.text;
}

test('a value change is observed without treating typing as a save', () => {
  const note = run(tree(rows), tree([rows[0].replace('before', 'after'), rows[1]]));
  assert.match(note, /UI changed \(value\)/);
  assert.doesNotMatch(note, /saved:|input sent:/);
  assert.equal(note.split('\n').length, 1);
});

test('numbering alone adds no summary, while a renamed element is observed', () => {
  assert.equal(run(tree(rows), tree(rows.map(r => r.replace(/\d/, n => +n + 5)))), undefined);
  assert.match(run(tree(rows), tree([rows[0], '\t2 button Store'])), /UI changed \(element\)/);
});

test('a newly selected row or a new sheet is observable', () => {
  assert.match(run(tree(['\t1 row (selectable) Item']), tree(['\t1 row (selected) Item']), 'await app.click(1)'), /UI changed/);
  assert.match(run(tree(rows), tree([...rows, '\t3 sheet Save']), 'await app.pressKey("super+s")'), /UI changed \(sheet or dialog\)/);
});

for (const [role, item, oldLabel, newLabel] of [
  ['sheet tab strip', 'tab', 'Summary, Sheet 1 of 1', 'Review, Sheet 2 of 2'],
  ['tab bar', 'radio button', 'First page', 'Second page'],
  ['segmented control', 'button', 'Overview', 'Details'],
  ['tab group', 'tab', 'Home', 'Insert'],
  ['page selector', 'button', 'Page 1', 'Page 2'],
]) {
  test(`a ${role} selection names the old and new tabs and keeps the existing note`, () => {
    const before = tree([`\t1 ${role} Navigation`, `\t\t2 ${item} (selected) ${oldLabel}`,
      ...(role === 'sheet tab strip' ? [] : [`\t\t3 ${item} (selectable) ${newLabel}`])]);
    const after = tree([`\t1 ${role} Navigation`, `\t\t2 ${item} (selectable) ${oldLabel}`,
      `\t\t3 ${item} (selected) ${newLabel}`]);
    const note = run(before, after, 'await app.click(3)');
    assert.ok(note.includes(`UI changed (selected tab: ${oldLabel} to ${newLabel})`), note);
    assert.match(note, role === 'sheet tab strip' ? /UI changed \(value\)/ : /UI changed \(element\)/);
    assert.equal(run(after, after, 'await app.click(3)'), undefined);
  });
}

test('a tab group Value change names its selection even without selected children', () => {
  const before = tree(['\t1 tab group Navigation, Value: Summary, ID: tabs']);
  const after = tree(['\t1 tab group Navigation, Value: Review, ID: tabs']);
  const note = run(before, after, 'await app.click(1)');
  assert.match(note, /UI changed \(selected tab: Summary to Review\)/);
  assert.match(note, /UI changed \(value\)/);
});

test('selected flags use descriptions as labels and survive element renumbering', () => {
  const before = tree(['\t1 tab bar', '\t\t2 radio button (selected) Description: One, ID: first',
    '\t\t3 radio button (selectable) Description: Two, ID: second']);
  const after = tree(['\t5 tab bar', '\t\t6 radio button (selectable) Description: One, ID: first',
    '\t\t7 radio button (selected) Description: Two, ID: second']);
  assert.match(run(before, after, 'await app.click(3)'), /UI changed \(selected tab: One to Two\)/);
});

test('list selections and tab labels in ordinary groups add no selected-tab note', () => {
  for (const role of ['list', 'outline', 'group Tab bar']) {
    const before = tree([`\t1 ${role}`, '\t\t2 row (selected) One', '\t\t3 row (selectable) Two']);
    const after = before.replace('(selected) One', '(selectable) One').replace('(selectable) Two', '(selected) Two');
    const note = run(before, after, 'await app.click(3)');
    assert.match(note, /UI changed/);
    assert.doesNotMatch(note, /selected tab:/);
  }
});

test('an unchanged selection adds no selected-tab note when other content changes', () => {
  const before = tree(['\t1 tab bar', '\t\t2 tab (selected) One', '\t3 text field Value: before']);
  const note = run(before, before.replace('Value: before', 'Value: after'));
  assert.match(note, /UI changed \(value\)/);
  assert.doesNotMatch(note, /selected tab:/);
});

test('incomplete, failed, overlapping and different-app reads never name a tab change', () => {
  const before = tree(['\t1 tab group Navigation, Value: One']);
  const after = before.replace('Value: One', 'Value: Two');
  for (const [result, options] of [[after + '\n…(20)', {}], [after, { failed: true }],
    [after.replace('App: TextEdit.', 'App: Other.'), {}]]) {
    assert.doesNotMatch(run(before, result, 'await app.click(1)', options), /selected tab:/);
  }
  const c = createReadCompactor(); c.process([text(before)]);
  const action = c.beginAction('await app.click(1)'); action.overlap = true;
  assert.doesNotMatch(c.process([text(GUARD_MARK + after + GUARD_END)], { action }).at(-1).text, /selected tab:/);
});

test('missing selections and flags in separate sibling groups do not imply a tab switch', () => {
  for (const [before, after] of [
    [['\t1 tab bar', '\t\t2 tab (selected) One'], ['\t1 tab bar', '\t\t2 tab (selectable) One']],
    [['\t1 tab bar', '\t\t2 tab (selectable) One'], ['\t1 tab bar', '\t\t2 tab (selected) One']],
    [['\t1 tab bar First', '\t\t2 tab (selected) One', '\t3 tab bar Second', '\t\t4 tab (selectable) Two'],
      ['\t1 tab bar First', '\t\t2 tab (selectable) One', '\t3 tab bar Second', '\t\t4 tab (selected) Two']],
  ]) assert.doesNotMatch(run(tree(before), tree(after), 'await app.click(2)') ?? '', /selected tab:/);
});

test('renaming a selected tab without moving selection adds no selected-tab note', () => {
  const before = tree(['\t1 tab bar', '\t\t2 tab (selected) Draft', '\t\t3 tab (selectable) Other']);
  const note = run(before, before.replace('Draft', 'Final'), 'await app.click(2)');
  assert.match(note, /UI changed \(element\)/);
  assert.doesNotMatch(note, /selected tab:/);
});

test('ambiguous groups, multiple selected children and nested lists cannot name a tab switch', () => {
  for (const before of [
    ['\t1 tab bar', '\t\t2 tab (selected) One', '\t\t3 tab (selectable) Two',
      '\t4 tab bar', '\t\t5 tab (selected) One', '\t\t6 tab (selectable) Two'],
    ['\t1 tab group Value: One', '\t\t2 tab (selected) One', '\t\t3 tab (selected) Extra'],
    ['\t1 tab bar', '\t\t2 list', '\t\t\t3 row (selected) One', '\t\t\t4 row (selectable) Two'],
  ]) {
    const after = before.map(line => line.replace('(selected) One', '(selectable) One')
      .replace('(selectable) Two', '(selected) Two').replace('Value: One', 'Value: Two'));
    assert.doesNotMatch(run(tree(before), tree(after), 'await app.click(3)') ?? '', /selected tab:/);
  }
});

test('lost button descriptions are degraded evidence, not a UI change', () => {
  assert.match(run(tree(['\t1 button Description: 2, ID: Two']), tree(['\t1 button Two']), 'await app.click(1)'), /UI unverified \(degraded read\)/);
});

test('a missing baseline or post-input read explains the uncertainty', () => {
  assert.match(run(undefined, tree(rows)), /UI unverified \(no earlier read\)/);
  assert.match(run(tree(rows), undefined), /UI unverified \(no read after input\)/);
  assert.equal(run(tree(rows), tree(rows)), undefined);
});

test('failure after input and overlapping calls never confirm saving or UI attribution', () => {
  const before = tree(rows), after = tree(rows, 'b.txt', 'file:///tmp/b.txt');
  assert.match(run(before, after, 'await app.pressKey("super+s")', { failed: true }), /call failed \(partial input possible\)/);
  assert.match(run(before, after, 'await app.pressKey("super+s")', { failed: true }), /saved: not confirmed \(call failed\)/);
  const c = createReadCompactor(); c.process([text(before)]);
  const action = c.beginAction('await app.pressKey("super+s")'); action.overlap = true;
  const note = c.process([text(GUARD_MARK + after + GUARD_END)], { action }).at(-1).text;
  assert.match(note, /UI unverified \(overlapping calls\)/);
  assert.match(note, /saved: not confirmed \(overlapping calls\)/);
});

test('Save opens a sheet without a saved field, and Save in the sheet makes no claim either way', () => {
  const sheet = 'Window: "Save", App: TextEdit.\n0 sheet Description: save, ID: save-panel\n\t1 button Save';
  const note = run(tree(rows, 'Untitled', null), sheet, 'await app.pressKey("super+s")');
  assert.match(note, /UI changed \(window\)/);
  assert.doesNotMatch(note, /saved:/);
  const saved = run(sheet, tree(rows, 'b.txt', 'file:///tmp/b.txt'), 'await app.pressKey("Return")') ?? '';
  assert.doesNotMatch(saved, /saved: not confirmed/);
  assert.doesNotMatch(saved, /saved: observed/);
});

test('a save action cannot confirm a new file without a named target', () => {
  const before = tree(rows, 'Untitled', null), after = tree(rows);
  for (const code of ['await app.pressKey("super+s")', 'await app.click({ label: "Save" })', 'await app.click("Save")', 'await app.click(2)']) {
    assert.match(run(before, after, code), /saved: not confirmed/);
  }
  assert.match(run(tree(rows), tree(rows), 'await app.pressKey("super+s")'), /saved: not confirmed \(no document save state change seen\)/);
});

test('clearing the edited title observes save state without proving its cause', () => {
  assert.match(run(tree(rows, 'a.txt — Edited'), tree(rows), 'await app.pressKey("cmd+s")'), /saved: observed/);
  assert.match(run(tree(rows), tree(rows, 'a.txt — Edited'), 'await app.pressKey("cmd+s")'), /saved: not confirmed/);
});

test('a different app, ambiguous headers and an ordinary title change never confirm saving', () => {
  assert.match(run(tree(rows), tree(rows, 'b.txt', 'file:///tmp/b.txt', 'Preview'), 'await app.pressKey("super+s")'), /saved: not confirmed \(another app\)/);
  assert.match(run(tree(rows), tree(rows) + '\n' + tree(rows, 'b.txt'), 'await app.pressKey("super+s")'), /saved: not confirmed/);
  assert.doesNotMatch(run(tree(rows), tree(rows, 'b.txt'), 'await app.typeText("hello")') ?? '', /saved:/);
});

test('recorded abbreviated Calculator and TextEdit trees cannot confirm values or saving', () => {
  for (const [kind, code] of [['calculator', 'await app.click(4)'], ['edit', 'await app.pressKey("super+s")']]) {
    const { before, after } = traces[kind];
    const note = run(before, after, code);
    assert.match(note, /UI unverified \(incomplete read\)/);
    assert.doesNotMatch(note, /saved: observed/);
  }
  const { before, after } = traces.save;
  const note = run(before, after, 'await app.pressKey("Return")');
  assert.match(note, /UI changed \(window\)/);
  assert.match(note, /saved: not confirmed \(incomplete read\)/);
});

test('read-only calls and action names inside strings or comments get no summary', () => {
  const c = createReadCompactor();
  for (const code of ['await app.getAXState()', 'nodeRepl.write("app.click(1)")', '// app.click(1)\nawait app.getAXState()']) {
    assert.equal(c.beginAction(code), undefined);
  }
});

test('forceFull keeps the requested tree and adds no line it cannot back', () => {
  const c = createReadCompactor(); c.process([text(tree(rows))]);
  const after = tree([rows[0].replace('before', 'after'), rows[1]]);
  const result = c.process([text(GUARD_MARK + after + GUARD_END)], { action: c.beginAction('await app.typeText("after")'), forceFull: true });
  assert.ok(result[0].text.includes(after));
  assert.equal(result.length, 1);
});

test('a retitled window adds no unverified line', () => {
  const c = createReadCompactor(); c.process([text(tree(rows))]);
  const after = tree([rows[0].replace('before', 'after'), rows[1]]).replace(/^Window: "([^"]*)"/, 'Window: "$1 — Edited"');
  assert.notEqual(after.split('\n')[0], tree(rows).split('\n')[0]);
  const result = c.process([text(GUARD_MARK + after + GUARD_END)], { action: c.beginAction('await app.typeText("after")') });
  assert.equal(result.length, 1);
});

test('an exposed modified flag must clear on the same document to confirm saving', () => {
  const before = tree(rows).replace('standard window a.txt,', 'standard window a.txt, Modified: true,');
  const after = before.replace('Modified: true', 'Modified: false');
  assert.match(run(before, after, 'await app.pressKey("super+s")'), /saved: observed .* \(modified state cleared; cause unknown\)/);
  assert.match(run(after, before, 'await app.pressKey("super+s")'), /saved: not confirmed/);
});

test('lost value attributes and different-app headers never imply a successful UI change', () => {
  assert.match(run(tree(rows), tree(['\t1 text entry area (settable) First Text View', rows[1]])), /UI unverified \(degraded read\)/);
  assert.match(run(tree(rows), tree(rows, 'a.txt', 'file:///tmp/a.txt', 'Preview')), /UI unverified \(another app\)/);
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
    assert.match(note, /UI unverified \(no earlier read\)/);
  }
});

test('an ambiguous header invalidates evidence until another complete observation', () => {
  const c = createReadCompactor(); c.process([text(tree(rows))]);
  c.process([text(GUARD_MARK + tree(rows) + '\n' + tree(rows, 'b.txt') + GUARD_END)], { action: c.beginAction('await app.click(2)') });
  const note = c.process([text(GUARD_MARK + tree(rows) + GUARD_END)], { action: c.beginAction('await app.typeText("x")') }).at(-1).text;
  assert.match(note, /UI unverified \(no earlier read\)/);
});

test('a document title alone cannot establish the saved file', () => {
  assert.match(run(tree(rows, 'Untitled', null), tree(rows, 'a.txt', null), 'await app.pressKey("super+s")'), /saved: not confirmed \(document identity unavailable\)/);
});

test('dropping Help is degraded evidence, while renaming a selectable row is observed', () => {
  assert.match(run(tree(['\t1 text field Value: before, Help: text']), tree(['\t1 text field Value: before'])), /UI unverified \(degraded read\)/);
  assert.match(run(tree(['\t1 row (selectable) Old name']), tree(['\t1 row (selectable) New name']), 'await app.click(1)'), /UI changed \(element\)/);
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

test('a save is observed when the document\'s file on disk changes during the call', async () => {
  const { mkdtempSync, writeFileSync, utimesSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os'); const { pathToFileURL } = await import('node:url');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-filesave-')));
  try {
    const file = join(dir, 'a.txt'); writeFileSync(file, 'before'); utimesSync(file, 1000, 1000);
    const url = pathToFileURL(file).href, doc = tree(rows, 'a.txt', url);
    const save = write => {
      const c = createReadCompactor(); c.process([text(doc)]);
      const action = c.beginAction('await app.pressKey("super+s")');
      if (write) { writeFileSync(file, 'after'); utimesSync(file, 2000, 2000); } else utimesSync(file, 1000, 1000);
      return c.process([text(GUARD_MARK + doc + GUARD_END)], { action }).find(item => /^sleight: /.test(item.text))?.text;
    };
    assert.match(save(true), /saved: observed ".*a\.txt" \(its file on disk changed during this call\)/);
    assert.match(save(false), /saved: not confirmed \(no document save state change seen\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function saveAfterClick(t, { role = 'text entry area (settable)', prefix = '', suffix = '', write = true,
  after = doc => doc, failed = false, overlap = false, target = '1', baseline = true,
  edit = 'await app.pressKey("super+a"); await app.paste("759");' } = {}) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-clicksave-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.txt'); writeFileSync(file, 'before'); utimesSync(file, 1000, 1000);
  const doc = tree([`\t1 ${role} Editor, Value: before`, '\t2 button Save'], 'a.txt', pathToFileURL(file).href, 'Editor');
  const c = createReadCompactor(); if (baseline) c.process([text(doc)]);
  const action = c.beginAction(`${prefix}await app.click(${target}); ${edit} await app.pressKey("super+s");${suffix}`);
  action.overlap = overlap;
  if (write) { writeFileSync(file, 'after'); utimesSync(file, 2000, 2000); }
  return c.process([text(GUARD_MARK + after(doc).replace('Value: before', 'Value: after') + GUARD_END)], { action, failed })
    .find(item => /^sleight: (?:UI|call failed|saved:)/.test(item.text))?.text;
}

for (const role of ['text entry area (settable)', 'text area', 'text field', 'static text (settable)']) {
  test(`clicking ${role} before select-all, paste and save observes the same file's write`, t => {
    assert.match(saveAfterClick(t, { role }), /saved: observed ".*a\.txt" \(its file on disk changed during this call\)/);
  });
}

for (const [name, options] of [
  ['an ID click', { target: '{ id: "First Text View" }' }],
  ['an unresolved number', { target: '99' }],
  ['coordinates', { target: '{ x: 10, y: 20 }' }],
  ['select-all alone', { target: '{ id: "First Text View" }', edit: 'await app.pressKey("super+a");' }],
  ['plain typing', { target: '{ id: "First Text View" }', edit: 'await app.typeText("759");' }],
]) test(`a subsequent edit on the same handle resolves ${name} for file-time save evidence`, t => {
  assert.match(saveAfterClick(t, options), /saved: observed .* \(its file on disk changed during this call\)/);
});

for (const role of ['button', 'menu item', 'row', 'link']) {
  test(`a resolved ${role} remains navigation when followed by editing and save`, t => {
    const note = saveAfterClick(t, { role });
    assert.match(note, /saved: not confirmed \(mixed save targets\)/);
    assert.doesNotMatch(note, /saved: observed/);
  });
}

test('a click without an earlier tree leaves save proof unavailable rather than mixed', t => {
  assert.match(saveAfterClick(t, { target: '2', baseline: false }), /saved: not confirmed \(no earlier read\)/);
});

test('an inferred editable click still needs a file write or modified-state evidence', t => {
  assert.match(saveAfterClick(t, { target: '{ id: "First Text View" }', write: false }),
    /saved: not confirmed \(no document save state change seen\)/);
});

test('an editable click after save can retain mixedSave while the same file write is observed', t => {
  assert.match(saveAfterClick(t, { suffix: 'await app.click(1)' }), /saved: observed .* \(its file on disk changed during this call\)/);
});

test('an editable click also permits existing modified-state evidence without a disk write', t => {
  assert.match(run(tree(rows).replace('standard window a.txt,', 'standard window a.txt, Modified: true,'),
    tree(rows).replace('standard window a.txt,', 'standard window a.txt, Modified: false,'),
    'await app.click(1); await app.pressKey("super+s")'), /saved: observed .* \(modified state cleared; cause unknown\)/);
});

for (const [name, options] of [
  ['a different URL', { after: doc => doc.replace(/, URL: .*/, ', URL: file:///tmp/other.txt') }],
  ['a missing URL', { after: doc => doc.replace(/, URL: .*/, '') }],
  ['a different title', { after: doc => doc.replace('Window: "a.txt"', 'Window: "b.txt"').replace('standard window a.txt,', 'standard window b.txt,') }],
  ['a different app', { after: doc => doc.replace('App: Editor.', 'App: Other.') }],
  ['no disk write', { write: false }],
  ...['button', 'menu item', 'row', 'link', 'button (settable)', 'button Description: text area'].map(role => [role, { role, edit: '' }]),
  ['an unknown click target without an edit', { target: '99', edit: '' }],
  ['a coordinate click without an edit', { target: '{ x: 10, y: 20 }', edit: '' }],
  ['an edit on another handle', { target: '99', edit: 'await other.typeText("759");' }],
  ...['super+o', 'super+n', 'super+w', 'Return', 'Escape'].map(key => [key, { prefix: `await app.pressKey("${key}");` }]),
  ['another handle read after save', { suffix: 'await other.getAXState()' }],
  ['another acquisition after save', { suffix: 'await cua.getApp("Other")' }],
  ['another handle input', { prefix: 'await other.click(1);' }],
  ['typing after save', { suffix: 'await app.typeText("unsaved")' }],
  ['a failed call', { failed: true }],
  ['overlap', { overlap: true }],
  ['an incomplete read without a disk write', { write: false, after: doc => doc + '\n…(20)' }],
  ['a degraded read without a disk write', { write: false, after: doc => doc.replace(', Value: before', '') }],
]) {
  test(`click then save stays unconfirmed with ${name}`, t => {
    const note = saveAfterClick(t, options);
    assert.match(note, /saved: not confirmed/);
    assert.doesNotMatch(note, /saved: observed/);
  });
}

// A degraded or incomplete trailing read can't show save state, but the same window's file write still does
// (Fable study, 2026-10-17: "not confirmed (degraded read)" cost six checking turns).
for (const [name, after] of [['an incomplete read', doc => doc + '\n…(20)'], ['a degraded read', doc => doc.replace(', Value: before', '')]]) {
  test(`click then save is observed from the same file's write despite ${name}`, t => {
    assert.match(saveAfterClick(t, { after }), /saved: observed ".*a\.txt" \(its file on disk changed during this call\)/);
  });
}

test('the same focused element with a new description is reported, another element taking focus is not', () => {
  const area = sheet => `\n\nThe focused UI element is 4 layout area Content Area, Description: Workbook area, ${sheet}, Sheet 2 of 2, Help: The content area`;
  const rows = ['\t1 button Add Sheet', '\t4 layout area Content Area'];
  assert.match(run(tree(rows) + area('Inventory'), tree(rows) + area('Review'), 'await app.click(1)'),
    /UI changed \(layout area Content Area: Workbook area, Inventory, Sheet 2 of 2 to Workbook area, Review, Sheet 2 of 2\)/);
  const field = name => `\n\nThe focused UI element is 4 text field ${name}, Description: ${name}`;
  assert.doesNotMatch(run(tree(rows) + field('Name'), tree(rows) + field('City'), 'await app.click(1)') ?? '', /UI changed \(text field/);
  assert.doesNotMatch(run(tree(rows) + area('Inventory'), tree(rows) + area('Inventory'), 'await app.click(1)') ?? '', /Workbook area/);
});
