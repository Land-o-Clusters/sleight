import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/verified-results-review.json', import.meta.url)));
const text = text => ({ type: 'text', text });
const tree = (title, url, modified = false) => `Window: ${JSON.stringify(title)}, App: TextEdit.\n0 standard window ${title}, Modified: ${modified}, URL: ${url}\n\t1 text entry area (settable) Value: alpha, ID: First Text View`;
function run(before, after, code, options = {}) {
  const c = createReadCompactor(); c.process([text(before)]);
  return c.process(after === undefined ? [] : [text(GUARD_MARK + after + GUARD_END)], { action: c.beginAction(code), ...options });
}
const last = result => result.at(-1).text;

test('Cmd+S cannot confirm a different file that became the front window', () => {
  const result = last(run(tree('a.txt', 'file:///tmp/a.txt', true), tree('b.txt', 'file:///tmp/b.txt'), 'await app.pressKey("super+s")'));
  assert.match(result, /saved: not confirmed \(different document\)/);
  assert.doesNotMatch(result, /saved: yes|saved: observed/);
});

test('a same-file modified-state change names its file without attributing autosave to Claude', () => {
  const result = last(run(tree('a.txt', 'file:///tmp/a.txt', true), tree('a.txt', 'file:///tmp/a.txt'), 'await app.pressKey("super+s")'));
  assert.match(result, /saved: observed "file:\/\/\/tmp\/a.txt" \(modified state cleared; cause unknown\)/);
  assert.doesNotMatch(result, /saved: yes|input sent/);
});

test('an Edited title clearing after typing does not claim that Claude saved', () => {
  const result = last(run(tree('a.txt — Edited', 'file:///tmp/a.txt'), tree('a.txt', 'file:///tmp/a.txt'), 'await app.typeText("alpha")'));
  assert.doesNotMatch(result, /saved:/);
});

const panel = 'Window: "Save", App: TextEdit.\n0 sheet Description: save, ID: save-panel\n\t79 text field (settable) Value: Untitled.txt, ID: saveAsNameTextField\n\t87 button Save, ID: OKButton';
const untitled = 'Window: "Untitled", App: TextEdit.\n0 standard window Untitled\n\t1 text entry area (settable) Value: alpha, ID: First Text View';
const namedDoc = (url, title = 'x.txt') => `Window: ${JSON.stringify(title)}, App: TextEdit.\n0 standard window ${title}, URL: ${url}\n\t1 text entry area (settable) Value: alpha, ID: First Text View`;
const saveAs = (folder, name, how = 'set') => {
  const nameCall = how === 'set'
    ? `await app.setValue({ id: "saveAsNameTextField" }, ${JSON.stringify(name)})`
    : `await app.typeText(${JSON.stringify(name)})`;
  return `await app.pressKey("super+s"); await app.pressKey("super+shift+g"); await app.typeText(${JSON.stringify(folder)}); await app.pressKey("Return"); ${nameCall}; await app.pressKey("Return")`;
};

test('an Open panel reached by folder and file name is not a save', () => {
  const open = 'await app.pressKey("super+o"); await app.pressKey("super+shift+g"); await app.typeText("/tmp"); await app.pressKey("Return"); await app.typeText("x.txt"); await app.pressKey("Return")';
  assert.doesNotMatch(last(run(untitled, namedDoc('file:///tmp/x.txt'), open)) ?? '', /saved:/);
});

test('a folder and name field in one call observe that named file URL', () => {
  const url = 'file:///tmp/x.txt';
  assert.match(last(run(untitled, namedDoc(url), saveAs('/tmp', 'x.txt'))), /saved: observed "file:\/\/\/tmp\/x.txt" \(named file URL\)/);
  assert.match(last(run(panel, namedDoc(url), saveAs('/tmp', 'x.txt', 'type'))), /saved: observed "file:\/\/\/tmp\/x.txt" \(named file URL\)/);
  const home = pathToFileURL(join(homedir(), 'tmp', 'x.txt')).href;
  assert.ok(last(run(panel, namedDoc(home), saveAs('~/tmp', 'x.txt')))
    .includes(`saved: observed ${JSON.stringify(home)} (named file URL)`));
});

test('a name field alone keeps today\'s Save-panel output', () => {
  const note = last(run(panel, namedDoc('file:///tmp/x.txt'), 'await app.setValue({ id: "saveAsNameTextField" }, "x.txt"); await app.pressKey("Return")')) ?? '';
  assert.doesNotMatch(note, /saved: observed/);
  assert.doesNotMatch(note, /saved: not confirmed/);
});

test('a mismatched URL after a named folder and name field is a different document', () => {
  assert.match(last(run(untitled, namedDoc('file:///tmp/other.txt', 'other.txt'), saveAs('/tmp', 'x.txt'))), /saved: not confirmed \(different document\)/);
});

test('a folder typed in an earlier call does not name this call\'s file URL', () => {
  const c = createReadCompactor();
  c.process([text(panel)]);
  c.process([text(GUARD_MARK + panel + GUARD_END)], {
    action: c.beginAction('await app.pressKey("super+shift+g"); await app.typeText("/tmp"); await app.pressKey("Return")'),
  });
  const note = last(c.process([text(GUARD_MARK + namedDoc('file:///tmp/x.txt') + GUARD_END)], {
    action: c.beginAction('await app.setValue({ id: "saveAsNameTextField" }, "x.txt"); await app.pressKey("Return")'),
  })) ?? '';
  assert.doesNotMatch(note, /saved: observed/);
});

test('the recorded TextEdit Save-panel call names the resulting file URL', () => {
  const { before, after, code } = fixtures.save;
  const result = last(run(before, after, code));
  assert.match(result, /saved: observed "file:\/\/\/tmp\/sleight-bench\/2026-10-10T01-18-07-983Z\/sleight-textedit-save-1\/141adc6c.txt"/);
  assert.doesNotMatch(result, /saved: yes/);
});

test('a named Save-panel call cannot confirm another file or a title-only match', () => {
  const { before, after, code } = fixtures.save;
  for (const changed of [after.replaceAll('141adc6c.txt', 'other.txt'), after.replace(/, URL: [^\n]+/, '')]) {
    assert.match(last(run(before, changed, code)), /saved: not confirmed/);
  }
});

test('computed Save-panel folder, filename and Return arguments cannot confirm a literal prefix', () => {
  const { before, after, code } = fixtures.save;
  for (const computed of [
    code.replace('"141adc6c.txt"', '"141adc6c.txt" + ".bak"'),
    code.replace('sleight-textedit-save-1"', 'sleight-textedit-save-1" + "/other"'),
    code.replace(/"Return"(?=\);\nawait app.getAXState)/, '"Return" + "extra"'),
  ]) assert.doesNotMatch(last(run(before, after, computed)) ?? '', /saved: observed/);
});

test('an untitled document acquiring an unnamed URL or title is not a confirmed save', () => {
  const before = 'Window: "Untitled", App: TextEdit.\n0 standard window Untitled';
  for (const after of [tree('a.txt', 'file:///tmp/a.txt'), 'Window: "a.txt", App: TextEdit.\n0 standard window a.txt']) {
    assert.match(last(run(before, after, 'await app.pressKey("super+s")')), /saved: not confirmed/);
  }
});

test('select-all Delete can remove the Value attribute of the recorded TextEdit entry', () => {
  const before = fixtures.edit.before;
  const after = before.replaceAll(', Value: alpha beta gamma', '');
  const result = last(run(before, after, 'await app.pressKey("super+a"); await app.pressKey("Delete")'));
  assert.match(result, /sleight: UI changed \(value\)/);
  assert.doesNotMatch(result, /degraded|saved:|accepted|sent/);
});

test('losing the same Value without a deletion action remains degraded evidence', () => {
  const before = fixtures.edit.before;
  const after = before.replaceAll(', Value: alpha beta gamma', '');
  assert.match(last(run(before, after, 'await app.pressKey("super+s")')), /UI unverified \(degraded read\)/);
});

test('the recorded Chess pawn move changes elements without Value or title changes', () => {
  const { before, after, diff } = fixtures.chess;
  assert.match(diff, /- \t\tbutton white pawn, e2\n\+ \t\t14 button e2/);
  assert.match(diff, /- \t\tbutton e4\n\+ \t\t30 button white pawn, e4/);
  assert.match(last(run(before, after, 'await app.drag([710, 778], [710, 525])')), /^sleight: UI changed \(element\)\.$/);
});

test('the recorded Chess square changes are sufficient without document-action label changes', () => {
  const before = fixtures.chess.before;
  const pawnOnly = before.replace('14 button white pawn, e2', '14 button e2').replace('30 button e4', '30 button white pawn, e4');
  assert.match(last(run(before, pawnOnly, 'await app.drag([710, 778], [710, 525])')), /^sleight: UI changed \(element\)\.$/);
});

test('the recorded TextEdit replacement gets a short value observation without save boilerplate', () => {
  const result = last(run(fixtures.edit.before, fixtures.edit.after, 'await app.selectText(2, "beta"); await app.paste("delta")'));
  assert.match(result, /^sleight: UI changed \(value\)\.$/);
});

test('unchanged and numbering-only reads add no redundant action line', () => {
  const before = fixtures.edit.before;
  for (const after of [before, before.replace(/\t2 text entry/, '\t99 text entry')]) {
    const result = run(before, after, 'await app.pressKey("ArrowLeft")');
    assert.equal(result.length, 1);
    assert.doesNotMatch(result[0].text, /input sent:|saved:|sleight: UI/);
  }
});

test('a failed action still warns about partial input without a routine acceptance claim', () => {
  const result = last(run(fixtures.edit.before, undefined, 'await app.pressKey("Delete")', { failed: true }));
  assert.match(result, /^sleight: call failed \(partial input possible\)\.$/);
  assert.doesNotMatch(result, /sent|accepted|saved:/);
});
