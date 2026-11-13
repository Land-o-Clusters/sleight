import test from 'node:test';
import assert from 'node:assert/strict';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';

const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'com.example.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true };
const tree = (value = 'Ready', extra = '') => 'Window: "Draft", App: Editor.\n0 standard window Draft\n' +
  `\t1 text Value: ${value}\n` + Array.from({ length: 30 }, (_, i) => `\t${i + 2} button Row ${i}, ID: row-${i}`).join('\n') + extra;
const text = value => ({ type: 'text', text: value });
const params = (readId, target = 1) => ({ windowId: '101', processStart: '100.25', readId, args: [target] });
const observe = (state, readId, value = tree(), patch = {}) => state.read({ window, readId, text: value, truncated: false, ...patch });
const display = (state, snapshots, options = {}) => state.prepareDisplay(snapshots.map(row => text(row.text)), snapshots, options);
const shown = batch => batch.content.map(item => item.text ?? '').join('\n');
const seed = state => { const one = observe(state, 1); const batch = display(state, [one]); batch.commit(); return one; };

test('UC2E default display stays full and opt-in repeat display reuses compactor wording', () => {
  const state = createMacReadState(); seed(state);
  const two = observe(state, 2);
  const full = display(state, [two]); assert.equal(shown(full), tree()); full.commit();
  const three = observe(state, 3);
  const compact = display(state, [three], { compact: true });
  assert.match(shown(compact), /sleight: no change since the last full tree you saw for this window\./);
  assert.ok(shown(compact).length < tree().length * 0.6);
  compact.commit(); state.assertCurrent('click', params(3));
});

test('UC2E changed output grants its full parent baseline only after successful delivery', () => {
  const state = createMacReadState(); seed(state);
  const two = observe(state, 2, tree('Changed'));
  const batch = display(state, [two], { compact: true });
  assert.match(shown(batch), /^- \ttext Value: Ready$/m);
  assert.match(shown(batch), /^\+ \t1 text Value: Changed$/m);
  assert.throws(() => state.assertCurrent('click', params(2)), { code: 'STALE_READ' });
  batch.commit(); state.assertCurrent('click', params(2));
  assert.equal(state.fullTree(params(2)), tree('Changed'));
});

for (const error of [undefined, Error('write failed')]) test(`UC2E outstanding delivery sends later trees full, failed=${!!error}`, () => {
  const state = createMacReadState(); seed(state);
  const two = observe(state, 2, tree('Changed')), pending = display(state, [two], { compact: true });
  const three = observe(state, 3), later = display(state, [three], { compact: true });
  assert.equal(shown(later), tree(), 'return to S0 cannot be a delta while S1 is in flight');
  later.commit(); pending.commit(error);
  const four = observe(state, 4), next = display(state, [four], { compact: true });
  assert.match(shown(next), /no change since/, 'older callbacks cannot roll the delivered baseline back');
  next.commit();
});

test('UC2E failed delivery and hidden or sliced output never update the display baseline', () => {
  const state = createMacReadState(); seed(state);
  const two = observe(state, 2, tree('Changed'));
  const hidden = state.prepareDisplay([text(two.text.slice(0, 90))], [two], { compact: true }); hidden.commit();
  const three = observe(state, 3, tree('Changed'));
  const failed = display(state, [three], { compact: true }); failed.commit(Error('write failed'));
  const four = observe(state, 4, tree('Changed')), next = display(state, [four], { compact: true });
  assert.equal(shown(next), four.text);
  assert.throws(() => state.assertCurrent('click', params(4)), { code: 'STALE_READ' });
  next.commit(); state.assertCurrent('click', params(4));
});

test('UC2E scratch follows S0 S1 S0 in display order within one delivered cell', () => {
  const state = createMacReadState(); seed(state);
  const two = observe(state, 2, tree('Changed')), three = observe(state, 3);
  const batch = display(state, [two, three], { compact: true });
  assert.match(batch.content[0].text, /^\+ \t1 text Value: Changed$/m);
  assert.match(batch.content[1].text, /^\+ \t1 text Value: Ready$/m);
  batch.commit(); state.assertCurrent('click', params(3));
});

for (const reset of ['endTurn', 'reset']) test(`UC2E ${reset} invalidates compact baselines and old callbacks`, () => {
  const state = createMacReadState(); seed(state);
  const two = observe(state, 2, tree('Changed')), old = display(state, [two], { compact: true });
  state[reset](); old.commit();
  const three = observe(state, 3, tree('Changed')), batch = display(state, [three], { compact: true });
  assert.equal(shown(batch), three.text); batch.commit();
});

test('UC2E truncation, explicit full reads and degraded attributes stay full', () => {
  const state = createMacReadState(); seed(state);
  const two = observe(state, 2, tree(), { truncated: true });
  const truncated = display(state, [two], { compact: true }); assert.equal(shown(truncated), two.text); truncated.commit();
  const three = observe(state, 3, tree('Changed'));
  const full = display(state, [three], { compact: true, forceFull: new Set([three]) });
  assert.equal(shown(full), three.text); full.commit();
  const four = observe(state, 4, tree('Changed').replace('button Row 0, ID: row-0', 'button row-0'));
  const degraded = display(state, [four], { compact: true }); assert.equal(shown(degraded), four.text); degraded.commit();
});

test('UC2E renumbered lines are shown with current numbers or the whole tree', () => {
  const state = createMacReadState(); seed(state);
  const shifted = tree() + '\n\t32 text Inserted\n\t33 button Tail';
  const two = observe(state, 2, shifted), first = display(state, [two], { compact: true }); first.commit();
  const next = shifted.replace('32 text Inserted\n\t33 button Tail', '32 text Inserted\n\t33 text New\n\t34 button Tail');
  const three = observe(state, 3, next), batch = display(state, [three], { compact: true });
  assert.match(shown(batch), /(?:^|\+ )\t34 button Tail$/m);
  batch.commit(); state.assertCurrent('click', params(3, 34));
});

test('UC2E equal text from two certified windows stays full without sharing history', () => {
  const state = createMacReadState(); seed(state);
  const two = observe(state, 2), other = observe(state, 1, tree(), { window: { ...window, windowId: '202' } });
  const batch = state.prepareDisplay([text(tree())], [two, other], { compact: true });
  assert.equal(shown(batch), tree()); batch.commit();
  assert.throws(() => state.assertCurrent('click', { ...params(1), windowId: '202' }), { code: 'STALE_READ' });
});

for (const truncated of [false, true]) test(`UC2E identical later reads preserve an earlier full requirement, truncated=${truncated}`, () => {
  const state = createMacReadState(); seed(state);
  const two = observe(state, 2, tree(), { truncated }), three = observe(state, 3);
  const batch = display(state, [two, three], { compact: true, forceFull: new Set(truncated ? [] : [two]) });
  assert.equal(batch.content[0].text, tree());
  assert.equal(batch.content[1].text, tree());
});

test('UC2E parent display uses the shared lean wording when requested', () => {
  const state = createMacReadState(); seed(state);
  const batch = display(state, [observe(state, 2, tree('Changed'))], { compact: true, prompt: 'lean' });
  assert.match(shown(batch), /sleight: lines changed since your last full tree \(- removed, \+ added, current numbers\):/);
  assert.match(shown(batch), /^\+ \t1 text Value: Changed$/m);
});

const insertedTree = () => tree().split('\n').map(line => line.replace(/^(\t*)(\d+) /,
  (_, indent, n) => `${indent}${Number(n) >= 2 ? Number(n) + 1 : n} `))
  .toSpliced(3, 0, '\t2 button Inserted, ID: inserted').join('\n');

for (const partial of ['truncated', 'slice', 'filter', 'prefix', 'error', 'stored', 'wrapped', 'json']) {
  for (const sameCell of partial === 'error' ? [false] : [false, true]) test(`UC2E2 ${partial} grants no rows; exact baseline=${sameCell}`, () => {
    const state = createMacReadState(); seed(state);
    const shifted = observe(state, 2, insertedTree(), { truncated: partial === 'truncated' });
    const partialText = partial === 'slice' ? shifted.text.split('\n').slice(4, 8).join('\n') :
      partial === 'filter' ? shifted.text.split('\n').filter(line => /button Row [0-3],/.test(line)).join('\n') :
      partial === 'wrapped' ? 'Rows from the earlier view: ' + shifted.text.split('\n').slice(4, 8).join(' | ') :
      partial === 'json' ? JSON.stringify(shifted.text.split('\n').slice(4, 8)) :
      partial === 'prefix' ? shifted.text.slice(0, 100) : shifted.text;
    const observed = partial === 'stored' ? [] : [shifted];
    const shielded = sameCell && partial !== 'truncated';
    let batch;
    if (sameCell && partial !== 'error') {
      const current = observe(state, 3);
      batch = state.prepareDisplay([text(partialText), text(current.text)], [...observed, current], { compact: true });
      if (shielded) assert.match(batch.content[1].text, /no change since/);
      else assert.equal(batch.content[1].text, tree());
    } else {
      state.prepareDisplay([text(partialText)], observed, { compact: true, allowDelivery: partial !== 'error' }).commit();
      observe(state, 3);
      assert.throws(() => state.assertCurrent('click', params(3, 3)), { code: 'STALE_READ' });
      const current = observe(state, 4);
      batch = display(state, [current], { compact: true });
      assert.equal(shown(batch), current.text);
    }
    const id = sameCell && partial !== 'error' ? 3 : 4;
    if (shielded) assert.doesNotThrow(() => state.assertCurrent('click', params(id, 3)), 'the unchanged row was already shown at 3');
    else assert.throws(() => state.assertCurrent('click', params(id, 3)), { code: 'STALE_READ' });
    batch.commit();
    // After the full display, number 3 visibly means Row 1 again.
    const request = params(id, 3); state.assertCurrent('click', request);
    assert.equal(request.args[0], 3); assert.match(tree(), /\t3 button Row 1,/);
    const next = observe(state, id + 1);
    assert.match(shown(display(state, [next], { compact: true })), /no change since/);
  });
}

test('UC2E2 an older full callback cannot clear a newer partial display', () => {
  const state = createMacReadState(); seed(state);
  const older = display(state, [observe(state, 2)], { compact: true });
  const shifted = observe(state, 3, insertedTree());
  state.prepareDisplay([text(shifted.text.split('\n').slice(4, 8).join('\n'))], [shifted], { compact: true }).commit();
  older.commit();
  const current = observe(state, 4), batch = display(state, [current], { compact: true });
  assert.equal(shown(batch), current.text);
  assert.throws(() => state.assertCurrent('click', params(4, 3)), { code: 'STALE_READ' });
  batch.commit(); state.assertCurrent('click', params(4, 3));
});

test('UC2E2 a known partial print marks only its own window', () => {
  const state = createMacReadState(); seed(state);
  const otherWindow = { ...window, windowId: '202', title: 'Other' };
  const otherText = tree().replaceAll('Draft', 'Other').replaceAll('Row ', 'Other row ');
  const other = observe(state, 1, otherText, { window: otherWindow });
  display(state, [other], { compact: true }).commit();
  const shifted = observe(state, 2, insertedTree());
  state.prepareDisplay([text(shifted.text.split('\n').slice(4, 8).join('\n'))], [shifted], { compact: true }).commit();
  const next = observe(state, 2, otherText, { window: otherWindow });
  assert.match(shown(display(state, [next], { compact: true })), /no change since/);
});

test('UC2E2 a parent-suppressed full observation marks the window until recovery commits', () => {
  const state = createMacReadState(); seed(state);
  const capped = observe(state, 2, insertedTree());
  state.prepareDisplay([text('output capped')], [], { compact: true, incomplete: [capped] }).commit();
  const current = observe(state, 3), recovery = display(state, [current], { compact: true });
  assert.equal(shown(recovery), current.text);
  assert.throws(() => state.assertCurrent('click', params(3, 3)), { code: 'STALE_READ' });
  recovery.commit(); state.assertCurrent('click', params(3, 3));
});

test('GLS4-2 a trailing partial copy adds no rows beside its exact parent baseline', () => {
  const state = createMacReadState(); seed(state);
  const current = observe(state, 2), shifted = observe(state, 3, insertedTree());
  state.prepareDisplay([text(current.text), text(shifted.text.split('\n').slice(4, 8).join('\n'))],
    [current, shifted], { compact: true }).commit();
  assert.throws(() => state.assertCurrent('click', params(3, 32)), { code: 'STALE_READ' }, 'the copy grants no unseen number');
  const next = observe(state, 4);
  assert.match(shown(display(state, [next], { compact: true })), /no change since/);
  assert.doesNotThrow(() => state.assertCurrent('click', params(4, 3)), 'the original row is still shown at 3');
});

for (const prompt of [undefined, 'lean']) test(`UC2E2 renumber note describes current-number reads, prompt=${prompt}`, () => {
  const state = createMacReadState(); seed(state);
  const shifted = observe(state, 2, insertedTree());
  const batch = display(state, [shifted], { compact: true, prompt });
  assert.doesNotMatch(shown(batch), /sleight refuses actions on (?:numbers that changed|changed numbers)/);
  assert.match(shown(batch), /(?:^|\+ )\t3 button Row 0,/m);
});
