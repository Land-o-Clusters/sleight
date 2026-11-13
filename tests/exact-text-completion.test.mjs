import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { actionOutcome } from '../plugins/sleight/lib/action-outcomes.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const requested = 'first line\nsecond 6fa7bd08\n';
const window = { title: 'fixture.txt', app: 'Fixture Editor', url: 'file:///fixture.txt' };
const area = (value, selection) => `text entry area (settable) ID: FixtureView, Value: ${value}` +
  (selection === undefined ? '' : `, Selected text: ${selection}`);
const tree = (value, selection, url = window.url) =>
  `Window: "fixture.txt", App: Fixture Editor.\n0 standard window fixture.txt, URL: ${url}\n\t1 ${area(value, selection)}\n\t2 button Save`;
const record = want => ({ a: 'setValue', n: 1, body: area('before'), want });

// The focus separator is replayed from the recorded native shapes in action-outcomes.test.mjs.
// A read without a focus summary ends with its own newline, outside the final AX value.
for (const [tailName, tail] of [
  ['focus summary', '\n\nThe focused UI element is 1 text entry area (settable) ID: FixtureView'],
  ['focus summary and read newline', '\n\nThe focused UI element is 1 text entry area (settable) ID: FixtureView\n'],
  ['read newline', '\n'],
]) for (const [actual, want, matches] of [
  ['abc', 'abc', true], ['abc', 'abc\n', false],
  ['abc\n', 'abc', false], ['abc\n', 'abc\n', true],
  ['abc\n\n', 'abc\n', false], ['abc\n\n', 'abc\n\n', true],
]) test(`last Value row preserves ${JSON.stringify(actual)} vs ${JSON.stringify(want)} with ${tailName}`, () => {
  const lastTree = value => tree(value).replace('\n\t2 button Save', '') + tail;
  assert.deepEqual(actionOutcome([record(want)], lastTree('before'), lastTree(actual)).facts,
    [{ o: 'value', m: matches }]);
});

// Trimming, case folding or comparing only the first AX line would break these cases.
for (const [name, actual, want, matches] of [
  ['the complete 27-byte request', requested, requested, true],
  ['the saved 26-byte repair', 'first line\nsecond 6fa7bd08', requested, false],
  ['two final boundaries', 'first line\nsecond 6fa7bd08\n\n', requested, false],
  ['one boundary requested as two', requested, requested + '\n', false],
  ['autocapitalization', 'first line\nSecond 6fa7bd08\n', requested, false],
  ['a different second line', 'first line\nsecond 6fa7bd09\n', requested, false],
  ['UTF-8 text', 'caf\u00e9 \ud83c\udf0a\n\n', 'caf\u00e9 \ud83c\udf0a\n\n', true],
  ['Unicode normalization differs', 'cafe\u0301\n', 'caf\u00e9\n', false],
  ['CRLF differs from LF', 'first\r\nsecond\r\n', 'first\nsecond\n', false],
  ['an empty value', '', '', true],
]) test(`exact AX comparison preserves ${name}`, () => {
  const result = actionOutcome([record(want)], tree('before'), tree(actual));
  assert.deepEqual(result.facts, [{ o: 'value', m: matches }]);
  assert.doesNotMatch(JSON.stringify(result), /first line|6fa7bd|caf|FixtureView/);
});

test('an unchanged mismatching buffer still reports a mismatch', () => {
  const actual = 'first line\nsecond 6fa7bd08';
  const result = actionOutcome([{ ...record(requested), body: area(actual) }], tree(actual), tree(actual));
  assert.deepEqual(result.facts, [{ o: 'value', m: false }]);
});

test('selected final newlines remain separate from the complete AX value', () => {
  for (const selected of ['\n', 'second 6fa7bd08\n', 'Second 6fa7bd08\n\n']) {
    assert.deepEqual(actionOutcome([record(requested)], tree('before'), tree(requested, selected)).facts,
      [{ o: 'value', m: true }]);
    assert.deepEqual(actionOutcome([record(requested)], tree('before'), tree(requested.slice(0, -1), selected)).facts,
      [{ o: 'value', m: false }]);
  }
});

test('a selection repair does not promote a changed value into exact-text proof', () => {
  const capitalized = 'first line\nSecond 6fa7bd08\n\n';
  const repaired = 'first line\nsecond 6fa7bd08';
  // Shift+End selected both the capitalized line and its final boundary in NS1.
  // The paste changes that selection, but it supplies no whole-document expectation.
  const result = actionOutcome([{ a: 'paste', focus: 1,
    body: area(capitalized, 'Second 6fa7bd08\n\n') }, { a: 'pressKey', k: 'super+s' }],
  tree(capitalized, 'Second 6fa7bd08\n\n'), tree(repaired));
  assert.deepEqual(result.facts, [{ o: 'value' }]);
  assert.doesNotMatch(JSON.stringify(result), /first line|6fa7bd/);
});

test('an exact-text comparison cannot cross a window or app boundary', () => {
  for (const after of [tree(requested).replace('App: Fixture Editor.', 'App: Other.'),
    tree(requested).replace('Window: "fixture.txt"', 'Window: "other.txt"')]) {
    assert.ok(!actionOutcome([record(requested)], tree('before'), after).facts.some(fact => fact.m === true));
  }
});

test('a truncated or ambiguous AX value cannot verify the requested text', () => {
  for (const after of [tree(requested) + '\n…(20)', tree(requested) + '\n' + tree(requested),
    tree(requested).replace('ID: FixtureView', 'ID: DifferentView')]) {
    assert.ok(!actionOutcome([record(requested)], tree('before'), after).facts?.some(fact => fact.m === true));
  }
});

test('compacted reads keep one and two trailing boundaries distinct', () => {
  const sidebar = Array.from({ length: 40 }, (_, i) => `\n\t${i + 3} button Item ${i}`).join('');
  const compactor = createReadCompactor();
  compactor.process([{ type: 'text', text: tree(requested) + sidebar }]);
  const read = value => compactor.process([{ type: 'text', text: GUARD_MARK + tree(value) + sidebar + GUARD_END }])
    .map(item => item.text).join('\n');
  const two = read(requested + '\n');
  assert.match(two, /lines changed/);
  assert.match(two, /\n\+ (?:\n|$)/);
  assert.doesNotMatch(two, /no change since/);
  const one = read(requested);
  assert.match(one, /lines changed/);
  assert.match(one, /\n- (?:\n|$)/);
  assert.doesNotMatch(one, /no change since/);
});

test('secure multiline values never produce an exact-text result', () => {
  const secure = value => tree(value).replace('text entry area (settable)', 'text entry area (settable, secure)');
  const result = actionOutcome([{ ...record(requested), body: area('before').replace('(settable)', '(settable, secure)') }],
    secure('before'), secure(requested));
  assert.equal(result.facts, undefined);
  assert.doesNotMatch(JSON.stringify(result), /first line|6fa7bd/);
});

test('a multiline value presented as a text field stays out of outcome facts', () => {
  const field = value => tree(value).replace('text entry area', 'text field');
  const body = area('before').replace('text entry area', 'text field');
  const result = actionOutcome([{ a: 'setValue', n: 1, body, want: 'private\ncontent' }],
    field('before'), field('private\ncontent'));
  assert.deepEqual(result.facts, [{ o: 'value', m: true }]);
  assert.doesNotMatch(JSON.stringify(result), /private|content/);
});

test('the engine comparison returns only a boolean for multiline setValue input', async () => {
  let changed = false;
  const output = [], mark = '[fixture-outcome]';
  const raw = { getAXState: async () => tree(changed ? requested : 'before'),
    setValue: async (number, value) => { assert.equal(number, 1); assert.equal(value, requested); changed = true; } };
  const code = guardedCode(`await app.setValue(1, ${JSON.stringify(requested)});`, window, 'changed', undefined,
    { focused: true, outcomes: true, outcomeMark: mark, actions: ['setValue'] });
  await runInNewContext(`(async () => { ${code} })()`, { app: raw, cua: { getApp: async () => raw },
    setTimeout, clearTimeout, nodeRepl: { write: value => output.push(value) } });
  const receipts = output.filter(value => typeof value === 'string' && value.startsWith(mark));
  const last = JSON.parse(receipts.at(-1).slice(mark.length));
  assert.deepEqual(last.outcomes[0].f, [{ o: 'value', m: true }]);
  assert.doesNotMatch(receipts.join('\n'), /first line|6fa7bd|FixtureView|"want"|"body"/);
});

test('file bytes and exact-text status stay independent of save evidence', t => {
  const dir = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-exact-save-'))));
  const file = join(dir, 'fixture.txt'), url = pathToFileURL(file).href;
  for (const [actual, bytes] of [
    [requested, 27], ['first line\nsecond 6fa7bd08', 26],
    ['first line\nSecond 6fa7bd08\n', 27], [requested + '\n', 28], ['caf\u00e9 \ud83c\udf0a\n\n', 12],
  ]) {
    writeFileSync(file, 'before'); utimesSync(file, 1000, 1000);
    const compactor = createReadCompactor();
    compactor.process([{ type: 'text', text: tree('before', undefined, url) }]);
    const action = compactor.beginAction('await app.pressKey("super+s")');
    writeFileSync(file, actual, 'utf8'); utimesSync(file, 2000, 2000);
    const content = compactor.process([{ type: 'text', text: GUARD_MARK + tree(actual, undefined, url) + GUARD_END }], { action });
    assert.equal(readFileSync(file).length, bytes);
    assert.deepEqual(readFileSync(file), Buffer.from(actual, 'utf8'));
    const receipt = content.find(item => /saved: observed/.test(item.text))?.text;
    assert.match(receipt, new RegExp(`on disk: ${bytes} bytes, plain text`));
    assert.match(receipt, /requested text: unverified/);
    assert.doesNotMatch(receipt, /first line|6fa7bd|caf/);
  }
});

test('lean save evidence still distinguishes an unverified text request', t => {
  const dir = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-exact-lean-'))));
  const file = join(dir, 'fixture.txt'), url = pathToFileURL(file).href;
  writeFileSync(file, 'before'); utimesSync(file, 1000, 1000);
  const compactor = createReadCompactor({ prompt: 'lean' });
  compactor.process([{ type: 'text', text: tree('before', undefined, url) }]);
  const action = compactor.beginAction('await app.pressKey("super+s")');
  writeFileSync(file, requested.slice(0, -1)); utimesSync(file, 2000, 2000);
  const content = compactor.process([{ type: 'text', text: GUARD_MARK + tree(requested.slice(0, -1), undefined, url) + GUARD_END }], { action });
  const receipt = content.find(item => /saved: observed/.test(item.text))?.text;
  assert.match(receipt, /requested text: unverified/);
  assert.doesNotMatch(receipt, /first line|6fa7bd/);
});

for (const prompt of [undefined, 'lean']) for (const laterPaste of [false, true])
  test(`save evidence respects the last text outcome: ${prompt ?? 'default'}, later paste ${laterPaste}`, t => {
    const dir = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-exact-outcome-'))));
    const file = join(dir, 'fixture.txt'), url = pathToFileURL(file).href;
    writeFileSync(file, 'before'); utimesSync(file, 1000, 1000);
    const compactor = createReadCompactor({ prompt, outcomes: true });
    compactor.process([{ type: 'text', text: tree('before', undefined, url) }]);
    const code = 'await app.setValue(1, "abc");' + (laterPaste ? 'await app.paste("d");' : '') + 'await app.pressKey("super+s");';
    const action = compactor.beginAction(code), mark = '[fixture-outcome]';
    writeFileSync(file, laterPaste ? 'abcd' : 'abc'); utimesSync(file, 2000, 2000);
    const outcomes = [{ a: 'setValue', n: 1, f: [{ o: 'value', m: true }] },
      ...(laterPaste ? [{ a: 'paste', f: [{ o: 'value' }] }] : []), { a: 'pressKey', k: 'super+s' }];
    const content = compactor.process([{ type: 'text', text: mark + JSON.stringify({ outcomes }) + '\n' +
      GUARD_MARK + tree(laterPaste ? 'abcd' : 'abc', undefined, url) + GUARD_END }], { action, code, filterMark: mark });
    const receipt = content.find(item => /saved: observed/.test(item.text))?.text;
    assert.match(receipt, /on disk: [34] bytes, plain text/);
    assert.match(content.map(item => item.text).join('\n'), /holds the value|holds it/);
    if (laterPaste) assert.match(receipt, /requested text: unverified/);
    else assert.doesNotMatch(receipt, /requested text: unverified/);
  });
