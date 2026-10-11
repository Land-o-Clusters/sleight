import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

// Compact named-control lines from 2026-10-11T00-43-26-532Z/sleight-textedit-save-1/trace-85761.jsonl
// (the traced pass behind docs/benchmarks/2026-10-11-textedit-save-traced.json). Folder rows omitted
// the way waits-targeting live traces omit them.
const untitled = [
  'Window: "Untitled 12", App: TextEdit.',
  '0 standard window Untitled 12, Secondary Actions: Raise',
  '\t1 scroll area Secondary Actions: Scroll Left, Scroll Right, Scroll Up, Scroll Down',
  '\t\t2 text entry area (settable) First Text View',
].join('\n');
const openedSheet = [
  'Window: "Save", App: TextEdit.',
  '0 sheet Description: save, ID: save-panel, Secondary Actions: Raise',
  '\t\t56 pop up button Where:, Value: sleight-waits-targeting-TWBJ4e, ID: where popup',
  '\t\t61 text field (settable) Value: Untitled 12.txt, ID: saveAsNameTextField',
  '\t\t68 button Cancel, ID: CancelButton',
  '\t\t69 button Save, ID: OKButton',
].join('\n');
const stillSheet = [
  'Window: "Save", App: TextEdit.',
  '0 sheet Description: save, ID: save-panel, Secondary Actions: Raise',
  '\t\t326 pop up button Where:, Value: sleight-textedit-save-1, ID: where popup',
  '\t\t331 text field (settable) Value: Untitled 12.txt, ID: saveAsNameTextField',
  '\t\t338 button Cancel, ID: CancelButton',
  '\t\t339 button Save, ID: OKButton',
].join('\n');
const openPanel = [
  'Window: "Open", App: TextEdit.',
  '0 standard window Open, ID: open-panel, Secondary Actions: Raise',
  '\t\t63 button Cancel, ID: CancelButton',
  '\t\t64 button (disabled) Open, ID: OKButton',
].join('\n');
const openSheetCode = 'await app.pressKey("super+s"); nodeRepl.write(await app.waitFor({ label: "Save" }, { timeoutMs: 10000 }));';
const alreadyOpenCode = 'await app.pressKey("super+shift+g"); await app.typeText("/tmp/sleight-bench/sleight-textedit-save-1/"); await app.pressKey("Return");';
const recipe = 'await app.pressKey("super+shift+g"); await app.typeText("<folder>"); await app.pressKey("Return"); await app.setValue({ id: "saveAsNameTextField" }, "<name>"); await app.pressKey("Return")';

const text = item => ({ type: 'text', text: item });
function notes(before, after, code, options = {}) {
  const c = createReadCompactor();
  if (before) c.process([text(before)]);
  const action = c.beginAction(code);
  const content = after === undefined ? [] : [text(GUARD_MARK + after + GUARD_END)];
  return c.process(content, { action, ...options })
    .filter(item => typeof item.text === 'string' && item.text.includes('sleight:'))
    .map(item => item.text).join('\n');
}

test('opening the recorded Save sheet names the one-call finish with that sheet\'s IDs', () => {
  const note = notes(untitled, openedSheet, openSheetCode);
  assert.match(note, /UI changed \(window\)/);
  assert.match(note, /finish the save in the next call/);
  assert.match(note, new RegExp(recipe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(note, /saved:/);
});

test('a later call on the recorded Save sheet that was already open adds no finish line', () => {
  const note = notes(openedSheet, stillSheet, alreadyOpenCode);
  assert.doesNotMatch(note, /finish the save in the next call/);
});

test('an Open panel does not get the Save-sheet finish line', () => {
  const note = notes(untitled, openPanel, 'await app.pressKey("super+o")');
  assert.doesNotMatch(note, /finish the save in the next call/);
  assert.doesNotMatch(note, /saveAsNameTextField/);
});

test('a call that leaves no sheet open adds no finish line', () => {
  const after = untitled.replace('First Text View', 'Value: sleight bench 2b7f33b9, ID: First Text View');
  const note = notes(untitled, after, 'await app.paste("sleight bench 2b7f33b9")');
  assert.doesNotMatch(note, /finish the save in the next call/);
});

test('the skill\'s save sequence matches the result note\'s recipe, including the name-field ID', () => {
  const skill = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /In a Save panel, send Go to Folder, the folder, Return, the name and the final Return in one call/);
  assert.match(skill, new RegExp(recipe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
