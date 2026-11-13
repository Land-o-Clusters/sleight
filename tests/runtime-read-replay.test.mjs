import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedReadBanks, replayReadBanks, auditDisplayedRead } from '../scripts/runtime-read-replay.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';

test('UC2E recorded Calculator and Excel repeat reads save at least 40 percent with zero false additions', t => {
  const results = replayReadBanks();
  assert.deepEqual(results.map(row => row.bank), ['Calculator', 'Excel']);
  assert.deepEqual(results.map(row => [row.reads, row.repeatReads, row.fullCharacters, row.glideCharacters, row.slicedPrints]),
    // RRD1: GLS2C removal diffs withhold shifted numbers, whose admission must refuse below.
    [[20, 10, 22328, 6795, 0], [5, 4, 22701, 11229, 2]]);
  assert.deepEqual(results.map(row => row.refusedRenumberedLines), [157, 0]);
  for (const row of results) {
    t.diagnostic(JSON.stringify(row));
    assert.ok(row.repeatReads > 0);
    assert.ok(row.savedPercent >= 40);
    assert.equal(row.falseAddedLines, 0);
    assert.equal(row.missingCurrentLines, 0);
  }
  // The second compactor has no delivery marks. This compares algorithms only;
  // it does not replay the ChatGPT relay's guard reads or real options.
  assert.deepEqual(results.map(row => row.chatgptCompactorCharacters), [10818, 5493]);
  assert.ok(results[0].glideCharacters < results[0].chatgptCompactorCharacters,
    'GLS2C removal diffs omit only previously seen rows whose shifted numbers refuse');
  assert.ok(results[1].glideCharacters > results[1].chatgptCompactorCharacters,
    'Excel partial prints require a full recovery read');
});

// These checks exercise the replay oracle with real parent read state. A missing
// changed row or an admitted hidden number must still count as missing content.
const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'org.test.replay',
  app: 'Editor', title: 'Draft', identityVerified: true };
const header = 'Window: "Draft", App: Editor.\n0 standard window Draft';
const first = 'button First, Help: ' + 'Unchanged help for the first control. '.repeat(8);
const second = 'button Second, Help: ' + 'Unchanged help for the second control. '.repeat(8);
const before = header + `\n\t1 ${first}\n\t2 ${second}`;
const shifted = header + `\n\t1 text New\n\t2 ${first}\n\t3 ${second}`;
function observed(text, display) {
  const state = createMacReadState();
  const initial = state.read({ window, readId: 1, text: before, truncated: false });
  state.prepareDisplay([{ type: 'text', text: before }], [initial]).commit();
  const snapshot = state.read({ window, readId: 2, text, truncated: false });
  if (display !== 'undelivered') state.prepareDisplay([{ type: 'text', text }], [snapshot],
    { compact: display !== 'full', actionNumbers: false }).commit();
  return { state, snapshot };
}
for (const [name, current, shown, display, expected] of [
  ['refused shifted rows', shifted, header + '\n+ \t1 text New', 'compact', [0, 0, 2]],
  ['admitted shifted rows hidden from the print', shifted, header + '\n+ \t1 text New', 'full', [0, 2, 0]],
  ['a hidden new value', before.replace('button First', 'button Changed'), header, 'compact', [0, 1, 0]],
  ['refused new content', shifted.replace('button Second', 'button Changed'),
    header + `\n+ \t1 text New\n+ \t2 ${first}`, 'undelivered', [0, 1, 0]],
  ['a changed ancestor', header + `\n\t1 container Other\n\t\t2 ${first}\n\t\t3 ${second}`,
    header + '\n+ \t1 container Other', 'undelivered', [0, 2, 0]],
  ['an invented addition', before, header + '\n+ \t1 button Invented', 'full', [1, 0, 0]],
]) test(`RRD1 replay oracle detects ${name}`, () => {
  const { state, snapshot } = observed(current, display);
  const result = auditDisplayedRead(before, current, shown, state, snapshot);
  assert.deepEqual([result.falseAddedLines, result.missingCurrentLines, result.refusedRenumberedLines], expected);
});

test('UC2E replay banks preserve recorded trees and contain no absolute user home paths', () => {
  const banks = recordedReadBanks();
  assert.equal(banks.length, 2);
  for (const bank of banks) {
    assert.doesNotMatch(JSON.stringify(bank), /\/Users\/[^/]+\//);
    for (const sequence of bank.sequences) assert.ok(sequence.length >= 2);
  }
});
