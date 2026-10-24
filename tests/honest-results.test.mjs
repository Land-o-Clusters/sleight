import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('all native input verbs enter the uncertainty ledger', () => {
  const turn = new TurnOutcomes();
  const actions = ['click', 'pressKey', 'typeText', 'paste', 'setValue', 'scroll', 'drag',
    'selectText', 'performSecondaryAction'];
  const api = readFileSync(new URL('fixtures/engine-api-26.1007.71326.ts', import.meta.url), 'utf8');
  for (const action of actions) assert.match(api, new RegExp('\\b' + action + '\\('), action);
  turn.native({ outcomes: actions.map(a => ({ a })) });
  assert.match(turn.text(), /9 actions, 9 unverified/);
});

test('unconfirmed tool statuses are distinct from untrusted page wording', () => {
  const content = text => [{ type: 'text', text }];
  for (const line of ['Input outcome is unconfirmed. Read again.', 'Input outcome unconfirmed; read again.',
    'Operation outcome is unconfirmed. Read current state.', '1 press: effect unconfirmed; read before retrying.',
    '1 hover e1: effect unconfirmed; read before retrying.',
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
  assert.equal(resultCompleteness([], { requested: true, failed: true }), undefined);
});

test('requested inventories and scalar replies never receive a tree completeness footer', () => {
  for (const text of ['Apps:\n- Fixture', 'true', '42', '{"ok":true,"count":2}'])
    assert.equal(resultCompleteness([{ type: 'text', text }], { requested: true }), undefined, text);
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

test('plain lists omit the lazy-row note unless a scroll container contains them', () => {
  const strings = ['DIV', 'UL', 'LI'];
  const nodes = { nodeName: [0, 1, 2], parentIndex: [-1, 0, 1], attributes: [[], [], []] };
  assert.equal(readCompleteness(declaredRows({ strings, documents: [{ nodes }] })), 'complete (returned view)');
  nodes.isScrollable = { index: [0] };
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

test('completeness and outcomes have independent exact-value opt-ins', () => {
  for (const value of [undefined, '0', 'yes', 'true', '01', '1']) {
    assert.equal(outcomeOptions({ SLEIGHT_COMPLETENESS: value }).completeness, value === '1');
    assert.equal(outcomeOptions({ SLEIGHT_COMPLETENESS: value }).outcomes, false);
    assert.equal(outcomeOptions({ SLEIGHT_OUTCOMES: value }).completeness, false);
  }
});

test('filtering a diff read takes precedence over changes-only scope', () => {
  assert.equal(resultCompleteness([{ type: 'text', text: 'The following is a diff from the previous accessibility tree for Window: "Guide"\n+ \t9 button New' }], { filtered: true }),
    '# incomplete read (filtered engine view).');
});

for (const tag of ['UL', 'OL', 'TABLE', 'SELECT', 'DIV']) {
  test(`${tag} only gets lazy-row scope from a scroll container below the document or viewport shell`, () => {
    const strings = ['#document', 'HTML', 'BODY', 'DIV', tag, 'role', 'list'];
    const nodes = { nodeName: [0, 1, 2, 3, 3, 4], parentIndex: [-1, 0, 1, 2, 3, 4],
      attributes: [[], [], [], [], [], tag === 'DIV' ? [5, 6] : []] };
    const layout = { nodeIndex: [1, 2, 3, 4, 5], bounds: [[0,0,800,600], [0,0,800,1200], [0,0,800,600], [0,0,700,400], [0,0,500,200]] };
    for (const scroll of [0, 1, 2, 3]) {
      nodes.isScrollable = { index: [scroll] };
      assert.equal(declaredRows({ strings, documents: [{ nodes, layout, viewportWidth: 800, viewportHeight: 600 }] }).renderedUnknown, undefined, 'stop at ' + scroll);
    }
    for (const scroll of [4, 5]) {
      nodes.isScrollable = { index: [scroll] };
      assert.equal(declaredRows({ strings, documents: [{ nodes, layout, viewportWidth: 800, viewportHeight: 600 }] }).renderedUnknown, true, 'nested scroll ' + scroll);
    }
  });
}


test('unsupported native API verbs are absent from outcome reporting', () => {
  const turn = new TurnOutcomes();
  turn.native({ outcomes: ['performAction', 'doubleClick', 'rightClick', 'press'].map(a => ({ a })) });
  assert.equal(turn.text(), undefined);
});


test('offline footer cost fixtures distinguish trees, scalars and continuation scope', async () => {
  const { footerFixtures } = await import('../bench/read-footer-cost.mjs');
  const fixtures = footerFixtures();
  assert.equal(fixtures.length, 17);
  for (const name of ['getState inventory', 'boolean', 'number', 'JSON object'])
    assert.equal(fixtures.find(row => row.name === name).addition, '');
  assert.match(fixtures.find(row => row.name === 'engine changes').addition, /changes only/);
  assert.match(fixtures.find(row => row.name === 'turbo filtered continuation').addition, /filtered view/);
});
