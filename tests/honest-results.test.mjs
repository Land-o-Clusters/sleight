import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnOutcomes } from '../plugins/sleight/lib/turn-outcomes.mjs';
import { readCompleteness, declaredRows, resultCompleteness } from '../plugins/sleight/lib/read-completeness.mjs';
import { outcomeOptions } from '../plugins/sleight/lib/launch.mjs';

test('outcomes default on and only an explicit zero disables them', () => {
  assert.equal(outcomeOptions({}).outcomes, true);
  assert.equal(outcomeOptions({ SLEIGHT_OUTCOMES: '0' }).outcomes, false);
});

test('turn summary keeps uncertain effects, omits refused input and scrubs labels and keys', () => {
  const turn = new TurnOutcomes();
  turn.native({ outcomes: [
    { a: 'click', n: 2, f: [{ o: 'state', d: 'checked' }] },
    { a: 'pressKey', k: 'Return', t: { s: true } },
    { a: 'typeText', l: 'private label', k: 'private value', x: 'failed' },
    { a: 'click', x: 'refused' },
    { a: 'click', n: 5, f: [{ o: 'lines', d: '2' }] },
    { a: 'click', n: 6, f: [{ o: 'none' }] },
  ] });
  assert.match(turn.text(), /5 actions, 4 unverified/);
  assert.match(turn.text(), /pressKey Return/);
  assert.doesNotMatch(turn.text(), /private|refused/);
  turn.reset();
  assert.equal(turn.text(), undefined);
});

test('grouped actions and record overflow stay unverified; summaries stay bounded', () => {
  const turn = new TurnOutcomes();
  turn.native({ outcomes: [{ a: 'setValue', g: true }, { a: 'pressKey', f: [{ o: 'value' }] }], dropped: 2 });
  assert.match(turn.text(), /4 actions, 4 unverified/);
  assert.match(turn.text(), /unrecorded actions \(2\)/);
  assert.doesNotMatch(turn.text(), /more/);
  for (let i = 0; i < 1000; i++) turn.unknown('browser_act');
  assert.ok(turn.text().length <= 500);
  assert.match(turn.text(), /more/);
});

test('completeness distinguishes returned view, limits, filters and unavailable reads', () => {
  assert.equal(readCompleteness({}), 'complete (returned view)');
  assert.match(readCompleteness({ omitted: 90 }), /^90 rows not rendered/);
  assert.match(readCompleteness({ unknown: true }), /unknown/);
  assert.match(readCompleteness({ filtered: true }), /filtered view/);
  assert.match(readCompleteness({ cut: 1000, ref: 'more1_0' }), /cut at 1000 chars; Continue with ref="more1_0"/);
});

test('delivery-time omissions override a complete footer and ordinary arithmetic gets no read footer', () => {
  assert.equal(resultCompleteness([{ type: 'text', text: '4' }]), undefined);
  assert.match(resultCompleteness([{ type: 'text', text: '# complete (returned view)\nsleight: 10 tree lines omitted' }]), /incomplete/);
  assert.match(resultCompleteness([], { requested: true, failed: true }), /incomplete/);
});

test('page-declared row totals count distinct positions and never turn unknown totals into zero', () => {
  const nodes = { nodeName: [0, 1, 1, 1], parentIndex: [-1, 0, 1, 1],
    attributes: [[], [2, 3, 4, 5], [2, 6, 7, 8], [2, 6, 7, 8]] };
  const strings = ['#document', 'DIV', 'role', 'grid', 'aria-rowcount', '100', 'row', 'aria-rowindex', '1'];
  assert.deepEqual(declaredRows({ strings, documents: [{ nodes }] }), { omitted: 99, unknown: false });
  strings[5] = '-1';
  assert.deepEqual(declaredRows({ strings, documents: [{ nodes }] }), { omitted: 0, unknown: true });
});
