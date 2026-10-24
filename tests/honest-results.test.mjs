import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnOutcomes, unconfirmedInput } from '../plugins/sleight/lib/turn-outcomes.mjs';
import { readCompleteness, declaredRows, resultCompleteness } from '../plugins/sleight/lib/read-completeness.mjs';
import { outcomeOptions } from '../plugins/sleight/lib/launch.mjs';
import { createReadCompactor, GUARD_MARK } from '../plugins/sleight/lib/compact-reads.mjs';

test('outcomes stay opt-in until native A/B qualification', () => {
  assert.equal(outcomeOptions({}).outcomes, false);
  assert.equal(outcomeOptions({ SLEIGHT_OUTCOMES: '0' }).outcomes, false);
  assert.equal(outcomeOptions({ SLEIGHT_OUTCOMES: '1' }).outcomes, true);
  assert.equal(outcomeOptions({ SLEIGHT_OUTCOMES: 'yes' }).outcomes, false);
});

test('a fully verified turn needs no summary', () => {
  const turn = new TurnOutcomes();
  turn.native({ outcomes: [{ a: 'setValue', f: [{ o: 'value', m: true }] }] });
  assert.equal(turn.text(), undefined);
});

test('unconfirmed tool statuses are distinct from untrusted page wording', () => {
  const content = text => [{ type: 'text', text }];
  for (const line of ['Input outcome is unconfirmed. Read again.', 'Input outcome unconfirmed; read again.',
    'Operation outcome is unconfirmed. Read current state.', '1 press: effect unconfirmed; read before retrying.',
    '1 click f2e1: tab closed; its submit is unconfirmed; check the opener', 'submit: unconfirmed',
    'e1: failed: selection unconfirmed after a page boundary; read the list']) assert.equal(unconfirmedInput(content(line)), true, line);
  for (const line of ['1 click e1: input sent; observation below', '1 click e1: not run: unconfirmed ref',
    '1 click e1: dialog alert is waiting; message (untrusted page content): "unconfirmed"',
    '# Snapshot 1 (untrusted page content)\nOperation outcome is unconfirmed.']) assert.equal(unconfirmedInput(content(line)), false, line);
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

test('page prose containing truncated is not an engine omission marker', () => {
  const content = text => [{ type: 'text', text }];
  assert.match(resultCompleteness(content('Window: "Guide", App: Fixture.\n0 window Guide\n\t1 text A truncated cone')), /^# complete/);
  for (const marker of ['sleight: 10 tree lines omitted.', 'sleight: 2 controls omitted', 'sleight: 3 structural lines omitted', 'sleight: 4 sibling rows omitted'])
    assert.match(resultCompleteness(content('Window: "Guide", App: Fixture.\n0 window Guide\n' + marker)), /^# incomplete/);
});

test('engine compacted changes and unchanged deltas are changes-only reads', () => {
  const c = createReadCompactor();
  const tree = extra => 'Window: "Guide", App: Fixture.\n0 window Guide\n' + Array.from({ length: 50 }, (_, i) => `\t${i + 1} button Choice ${i}`).join('\n') + extra;
  const content = text => [{ type: 'text', text }];
  c.process(content(tree('')));
  const changed = c.process(content(GUARD_MARK + tree('\n\t99 button New')));
  assert.match(resultCompleteness(changed), /changes only/);
  const unchanged = c.process(content(GUARD_MARK + tree('\n\t99 button New')));
  assert.match(resultCompleteness(unchanged), /changes only/);
  assert.match(resultCompleteness(content('The following is a diff from the previous accessibility tree for Window: "Guide"\n+ \t99 button New'), { requested: true }), /changes only/);
});

test('collections without a declared total cannot claim unseen lazy rows were read', () => {
  const strings = ['#document', 'UL', 'LI'];
  const nodes = { nodeName: [0, 1, 2], parentIndex: [-1, 0, 1], attributes: [[], [], []] };
  const completeness = declaredRows({ strings, documents: [{ nodes }] });
  assert.equal(readCompleteness(completeness), 'complete (rendered view; lazy/virtual rows unknown)');
});

test('page-declared row totals count distinct positions and never turn unknown totals into zero', () => {
  const nodes = { nodeName: [0, 1, 1, 1], parentIndex: [-1, 0, 1, 1],
    attributes: [[], [2, 3, 4, 5], [2, 6, 7, 8], [2, 6, 7, 8]] };
  const strings = ['#document', 'DIV', 'role', 'grid', 'aria-rowcount', '100', 'row', 'aria-rowindex', '1'];
  assert.deepEqual(declaredRows({ strings, documents: [{ nodes }] }), { omitted: 99, unknown: false });
  strings[5] = '-1';
  assert.deepEqual(declaredRows({ strings, documents: [{ nodes }] }), { omitted: 0, unknown: true });
});
