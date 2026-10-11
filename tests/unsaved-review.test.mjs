import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TurnJournal } from '../plugins/sleight/lib/turn-receipts.mjs';
import { GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/document-scope.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/verified-results-review.json', import.meta.url)));
const tree = rows => `Window: "Untitled", App: TextEdit.\n0 standard window\n${rows}`;
const request = (id, code) => ({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
const reply = (id, text, failed = false) => ({ id, result: { isError: failed, content: [{ type: 'text', text }] } });
const hidden = length => ({ redacted: true, length });
function call(journal, id, code, text, failed) {
  journal.request(request(id, code)); journal.reply(reply(id, text, failed));
}
function review(before, after, { enabled = true, code = 'await app.click(1)', failed = false } = {}) {
  const journal = new TurnJournal({ ownerNames: [] });
  call(journal, 1, 'let app = await cua.getApp("TextEdit")', before);
  call(journal, 2, code, after, failed);
  return { receipt: journal.finish({ review: enabled }), journal };
}

test('recorded TextEdit values become a redacted before/after in the receipt and review', () => {
  const { receipt, journal } = review(recorded.edit.before, recorded.edit.after);
  assert.deepEqual(receipt.windows[0].fields.changes, [{ field: 1, role: 'text entry area', property: 'value', before: hidden(17), after: hidden(18) }]);
  assert.match(receipt.review, /text entry area 1, value: \[redacted 17 chars\] -> \[redacted 18 chars\]/);
  assert.doesNotMatch(JSON.stringify(receipt), /alpha|delta|First Text View|fingerprint|identity/);
  assert.doesNotMatch(JSON.stringify(journal.last), /alpha|delta|First Text View/);
});

test('same-length computed input changes stay visible without recording contents or labels', () => {
  const before = tree('\t1 text field Description: never-publish, ID: field-1, Value: abcd');
  const after = tree('\t1 text field Description: never-publish, ID: field-1, Value: wxyz');
  const { receipt } = review(before, after, { code: 'await app.typeText(secretFromElsewhere)' });
  assert.deepEqual(receipt.windows[0].fields.changes[0], { field: 1, role: 'text field', property: 'value', before: hidden(4), after: hidden(4) });
  assert.doesNotMatch(JSON.stringify(receipt), /never-publish|field-1|abcd|wxyz/);
  assert.match(receipt.review, /4 chars.*4 chars/);
});

test('checkboxes, popups and selections expose safe states and redact selected text', () => {
  const before = tree('\t1 checkbox (settable) Keep-private, Value: 0, ID: enabled\n\t2 pop up button Mode, Value: Private-mode, ID: mode\n\t3 text field Value: abcdef, Selected Text: abc, ID: text\n\t4 row Choice, Selected: false, ID: choice');
  const after = before.replace('Value: 0', 'Value: 1').replace('Private-mode', 'Another-mode').replace('Text: abc,', 'Text: abcde,').replace('Selected: false', 'Selected: true');
  const { receipt } = review(before, after);
  assert.deepEqual(receipt.windows[0].fields.changes.map(({ property, before, after }) => ({ property, before, after })), [
    { property: 'value', before: 'unchecked', after: 'checked' },
    { property: 'value', before: hidden(12), after: hidden(12) },
    { property: 'selected text', before: hidden(3), after: hidden(5) },
    { property: 'selected', before: 'not selected', after: 'selected' },
  ]);
  assert.doesNotMatch(JSON.stringify(receipt), /Private-mode|Another-mode|abcdef|Keep-private/);
  assert.match(receipt.review, /unchecked -> checked/);
});

test('secure nodes and descendants never contribute lengths, hashes or value changes', () => {
  const secure = 'secure-exclusive-value';
  const before = tree(`\t1 secure text field (settable) Password, Value: ${secure}\n\t\t2 text field Value: nested-secret\n\t3 text field Value: old`);
  const after = before.replace(secure, 'longer-secure-exclusive-value').replace('nested-secret', 'other-nested-secret').replace('Value: old', 'Value: updated');
  const { receipt, journal } = review(before, after);
  assert.deepEqual(receipt.windows[0].fields.changes, [{ field: 1, role: 'text field', property: 'value', before: hidden(3), after: hidden(7) }]);
  assert.equal(receipt.windows[0].fields.excluded, true);
  const retained = JSON.stringify({ receipt, last: journal.last });
  assert.doesNotMatch(retained, /exclusive-value|nested-secret|Password/);
  for (const raw of [secure, '\tsecure text field (settable) Password, Value: ' + secure]) {
    assert.equal(retained.includes(createHash('sha256').update(raw).digest('base64')), false);
  }
  assert.equal(receipt.windows[0].detail, '1 accessibility lines changed; 1 value fields changed (contents redacted).');
});

test('ambiguous controls are partial while a uniquely identified renumbered field still compares', () => {
  const before = tree('\t1 text field Value: old, ID: unique\n\t2 text field Value: a, ID: duplicate\n\t3 text field Value: b, ID: duplicate');
  const after = before.replace('1 text field', '8 text field').replace('Value: old', 'Value: newer').replace('Value: a,', 'Value: c,');
  const { receipt } = review(before, after);
  assert.equal(receipt.windows[0].fields.status, 'partial');
  assert.equal(receipt.windows[0].fields.changes.length, 1);
  assert.deepEqual(receipt.windows[0].fields.changes[0].after, hidden(5));
  assert.match(receipt.review, /partial/i);
});

test('missing, diff-only, failed and switched-window results do not invent field comparisons', () => {
  for (const [after, failed] of [
    ['No header', false],
    [tree('+ \t1 text field Value: new'), false],
    [tree('\t1 text field Value: new'), true],
    [tree('\t1 text field Value: new').replace('Untitled', 'Other window'), false],
  ]) {
    const { receipt } = review(tree('\t1 text field Value: old'), after, { failed });
    assert.equal(receipt.windows[0].fields.status, 'unavailable');
    assert.deepEqual(receipt.windows[0].fields.changes, []);
    assert.match(receipt.review, /Field review unavailable/);
  }
});

test('full guard output wins over a diff and keeps its redacted field pair', () => {
  const before = tree('\t1 text field Value: old, ID: entry');
  const after = tree('\t8 text field Value: newer, ID: entry');
  const { receipt } = review(before, tree('+ 8 text field Value: private') + '\n' + GUARD_MARK + after + GUARD_END);
  assert.deepEqual(receipt.windows[0].fields.changes[0].after, hidden(5));
  assert.equal(receipt.windows[0].fields.status, 'compared');
});

test('field review is opt-in and a previous turn supplies only a redacted baseline', () => {
  const before = tree('\t1 text field Value: old'), after = tree('\t1 text field Value: newer');
  const off = review(before, after, { enabled: false }).receipt;
  assert.equal(off.windows[0].fields, undefined);
  const { receipt, journal } = review(before, after);
  assert.equal(receipt.windows[0].fields.changes.length, 1);
  call(journal, 3, 'await app.click(1)', tree('\t1 text field Value: newest'));
  const next = journal.finish({ review: true });
  assert.deepEqual(next.windows[0].fields.changes[0].before, hidden(5));
  assert.deepEqual(next.windows[0].fields.changes[0].after, hidden(6));
});

test('read-only windows are excluded and acted-on windows keep distinct review numbers', () => {
  const journal = new TurnJournal({ ownerNames: [] });
  for (let n = 0; n < 3; n++) {
    const before = tree('\t1 text field Value: old').replace('Untitled', `Untitled ${n}`);
    call(journal, n * 2 + 1, 'app = await cua.getApp("TextEdit")', before);
    if (n !== 2) call(journal, n * 2 + 2, 'await app.click(1)', before.replace('old', 'newer'));
  }
  const receipt = journal.finish({ review: true });
  assert.deepEqual(receipt.windows.map(w => w.reviewWindow), [1, 2]);
  assert.equal(receipt.windows.length, 2);
  assert.match(receipt.review, /Window 1/); assert.match(receipt.review, /Window 2/);
});

test('unreviewable canvases, pixels and secure-only trees say field review unavailable', () => {
  for (const rows of ['\t1 canvas', '', '\t1 secure text field Value: secret']) {
    const { receipt } = review(tree(rows), tree(rows));
    assert.equal(receipt.windows[0].fields.status, 'unavailable');
    assert.match(receipt.review, /Field review unavailable/);
  }
});

test('large field changes are bounded and report the omitted count', () => {
  const rows = Array.from({ length: 103 }, (_, i) => `\t${i + 1} text field Value: old, ID: field-${i}`).join('\n');
  const { receipt } = review(tree(rows), tree(rows.replaceAll('Value: old', 'Value: newer')));
  assert.equal(receipt.windows[0].fields.changes.length, 100);
  assert.equal(receipt.windows[0].fields.omitted, 3);
  assert.equal(receipt.windows[0].fields.status, 'partial');
  assert.match(receipt.review, /3 field changes omitted/);
});

test('multiline text is one redacted value and attributes do not enter its length', () => {
  const before = tree('\t1 text entry area Value: first\nsecond, ID: text');
  const after = tree('\t1 text entry area Value: first\nsecond\nthird, ID: text');
  const { receipt } = review(before, after);
  assert.deepEqual(receipt.windows[0].fields.changes[0].before, hidden(12));
  assert.deepEqual(receipt.windows[0].fields.changes[0].after, hidden(18));
  assert.doesNotMatch(JSON.stringify(receipt), /first|second|third/);
});

test('overlaps and unfinished calls suppress otherwise comparable field pairs', () => {
  for (const pending of [false, true]) {
    const journal = new TurnJournal({ ownerNames: [] });
    call(journal, 1, 'let app = await cua.getApp("TextEdit")', tree('\t1 text field Value: old'));
    journal.request(request(2, 'await app.click(1)'));
    if (!pending) {
      journal.request(request(3, 'await app.getAXState()'));
      journal.reply(reply(2, tree('\t1 text field Value: new')));
      journal.reply(reply(3, tree('\t1 text field Value: new')));
    }
    const receipt = journal.finish({ review: true });
    assert.equal(receipt.windows[0].fields.status, 'unavailable');
    assert.deepEqual(receipt.windows[0].fields.changes, []);
    assert.match(receipt.review, /Field review unavailable/);
  }
});

test('trailing spaces remain part of redacted value lengths and comparison', () => {
  const { receipt } = review(tree('\t1 text field Value: x '), tree('\t1 text field Value: x  '));
  assert.deepEqual(receipt.windows[0].fields.changes, [{ field: 1, role: 'text field', property: 'value', before: hidden(2), after: hidden(3) }]);
});

test('rootless, truncated and unterminated guard trees leave field review unavailable', () => {
  const before = tree('\t1 text field Value: old');
  for (const after of ['Window: "Untitled", App: TextEdit.\n\t1 text field Value: new',
    tree('\t1 text field Value: new…(20000)'), GUARD_MARK + tree('\t1 text field Value: new')]) {
    const { receipt } = review(before, after);
    assert.equal(receipt.windows[0].fields.status, 'unavailable');
    assert.deepEqual(receipt.windows[0].fields.changes, []);
    assert.match(receipt.review, /Field review unavailable/);
  }
});

test('native Selected text and selectable flags compare without becoming value text', () => {
  const before = tree('\t1 text field Value: abcdef, Selected text: abc, ID: text\n\t2 row (selectable) Choice, ID: choice\n\t3 checkbox (checkable) Enabled, ID: enabled');
  const after = before.replace('text: abc,', 'text: abcde,').replace('(selectable)', '(selected)').replace('(checkable)', '(checked)');
  const { receipt } = review(before, after);
  assert.deepEqual(receipt.windows[0].fields.changes.map(({ property, before, after }) => ({ property, before, after })), [
    { property: 'selected text', before: hidden(3), after: hidden(5) },
    { property: 'selected', before: 'not selected', after: 'selected' },
    { property: 'value', before: 'unchecked', after: 'checked' },
  ]);
  assert.equal(receipt.windows[0].fields.status, 'compared');
});

test('recorded native selection footers get a redacted window selection comparison', () => {
  const source = JSON.parse(readFileSync(new URL('../docs/benchmarks/2026-10-04-clipboard-attempt-20.json', import.meta.url)));
  const find = value => typeof value === 'string' ? (value.startsWith('Window: ') && value.includes('Selected text: ```') ? value : undefined)
    : value && typeof value === 'object' ? Object.values(value).map(find).find(Boolean) : undefined;
  const before = find(source);
  assert.ok(before, 'Recorded native selection fixture is present');
  const after = before.replace('Selected text: ```\nalpha beta gamma', 'Selected text: ```\nalpha');
  const { receipt } = review(before, after);
  assert.deepEqual(receipt.windows[0].fields.changes, [{ field: 2, role: 'window', property: 'selected text', before: hidden(17), after: hidden(6) }]);
  assert.doesNotMatch(JSON.stringify(receipt), /alpha|beta|gamma|Note:|```/);
});

test('recorded TextEdit value newlines remain visible as redacted length changes', () => {
  const source = JSON.parse(readFileSync(new URL('../docs/benchmarks/2026-10-04-clipboard-attempt-20.json', import.meta.url)));
  const find = value => typeof value === 'string' ? (value.startsWith('Window: ') && value.includes('Value: alpha beta gamma\n\n\t\t3') ? value : undefined)
    : value && typeof value === 'object' ? Object.values(value).map(find).find(Boolean) : undefined;
  const recordedTree = find(source);
  assert.ok(recordedTree, 'Recorded native multiline value fixture is present');
  const after = recordedTree.replace('Value: alpha beta gamma\n\n\t\t3', 'Value: alpha beta gamma\n\n\n\t\t3');
  const { receipt } = review(recordedTree, after);
  assert.equal(receipt.windows[0].change, 'changed');
  assert.match(receipt.windows[0].detail, /1 value fields changed/);
  assert.deepEqual(receipt.windows[0].fields.changes, [{ field: 1, role: 'text entry area', property: 'value', before: hidden(17), after: hidden(18) }]);
});

test('secure selection footers are excluded even after a nonsecure menu bar', () => {
  const before = tree('\t1 secure text field Value: secret\n2 menu bar\n\t3 Edit') + '\nSelected text: ```\nsecret-one\n```';
  const after = before.replace('secret-one', 'different-secret-two');
  const first = review(before, before), second = review(before, after);
  assert.equal(first.journal.last.fields.structure, second.journal.last.fields.structure);
  assert.deepEqual(second.receipt.windows[0].fields.changes, []);
  assert.equal(second.receipt.windows[0].fields.status, 'unavailable');
});

test('a failed or missing final read invalidates the preceding successful mutation observation', () => {
  for (const failed of [false, true]) {
    const journal = new TurnJournal({ ownerNames: [] });
    call(journal, 1, 'let app = await cua.getApp("TextEdit")', tree('\t1 text field Value: old'));
    call(journal, 2, 'await app.click(1)', tree('\t1 text field Value: newer'));
    call(journal, 3, 'await app.getAXState()', 'AX read unavailable', failed);
    const receipt = journal.finish({ review: true });
    assert.equal(receipt.windows[0].change, 'unknown');
    assert.equal(receipt.windows[0].fields.status, 'unavailable');
    assert.deepEqual(receipt.windows[0].fields.changes, []);
    assert.equal(journal.last, undefined);
  }
});
