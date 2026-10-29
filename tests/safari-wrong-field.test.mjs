import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, recordings } from '../bench/replay/safari-wrong-field.mjs';
import { elementLines } from '../plugins/sleight/lib/document-scope.mjs';

for (const recording of recordings) {
  test(`${recording.id}: recorded effect is reproduced at the fake-engine boundary`, async () => {
    assert.match(elementLines(recording.before).get(26), /^combo box .* Address,/);
    assert.match(elementLines(recording.before).get(53), /^text field .* Promo code,/);
    assert.match(elementLines(recording.after).get(53), /Value: 47 Juniper Court/);
    assert.doesNotMatch(elementLines(recording.after).get(26), /Value: 47 Juniper Court/);
    const result = await replay(recording);
    assert.equal(result.error, undefined);
    assert.equal(result.remapped, undefined);
    assert.equal(result.output.filter(line => line.startsWith('[replay]{"binding"')).length,
      recording.id.includes('r1') ? 4 : 1, 'all recorded writes must cross the installed guard');
    const freshChars = recording.id.includes('r1') ? [5409, 5483, 5472, 5469]
      : recording.id.endsWith('c9') ? [5233] : [5232];
    assert.deepEqual(result.reads.slice(0, freshChars.length), freshChars,
      'reconstructed pre-action read sizes match the retained guard-read receipts');
    assert.deepEqual(result.dispatches.map(d => d.number), recording.id.includes('r1') ? [45, 47, 49, 26] : [26]);
    assert.equal(result.dispatches.at(-1).actual, 53);
    assert.match(result.dispatches.at(-1).chosenBy, /^fake-engine/);
    assert.doesNotMatch(result.output.join(''), /went to element 53/);
    assert.match(elementLines(result.current).get(53), /Value: 47 Juniper Court/);
  });

  test(`${recording.id}: faithful fake engine writes Address only`, async () => {
    const result = await replay(recording, { recordedEffect: false });
    assert.equal(result.error, undefined);
    assert.equal(result.dispatches.at(-1).actual, 26);
    assert.equal(elementLines(result.current).get(53), elementLines(recording.before).get(53));
  });

  test(`${recording.id}: CK1, CK2 and capture binding do not choose Promo`, async () => {
    for (const options of [{ ck1: false }, { ck2: false }, { bind: false, ck1: false, ck2: false }]) {
      const result = await replay(recording, { ...options, recordedEffect: false });
      assert.equal(result.error, undefined);
      assert.equal(result.dispatches.at(-1).number, 26);
      assert.equal(result.dispatches.at(-1).actual, 26);
    }
  });

  test(`${recording.id}: proposed engine-side identity seam refuses the modeled misdelivery`, async () => {
    const result = await replay(recording, { dispatchIdentityGuard: true });
    assert.match(result.error?.message ?? '', /role\/label mismatch/);
    assert.equal(result.writes.filter(w => w.actual === 53).length, 0);
  });
}

const head = 'Window: "Form", App: Fixture.\n0 standard window Form\n\t1 container Shipping\n';
const tree = rows => head + rows;
const before = tree('\t\t26 combo box (collapsed, settable) Address\n\t\t53 text field (settable) Promo code');
const source = { code: 'await app.setValue(26, "street");', before };

for (const [name, now] of [
  ['duplicate old labels', before + '\n\t\t54 combo box (collapsed, settable) Address'],
  ['duplicate current labels after renumber', tree('\t\t26 text field (settable) Promo code\n\t\t54 combo box (collapsed, settable) Address\n\t\t55 combo box (collapsed, settable) Address')],
  ['changed role at the same number', before.replace('combo box (collapsed, settable)', 'text field (settable)')],
  ['changed label at the same number', before.replace(' Address', ' Promo code')],
]) test(`pre-write refusal: ${name}`, async () => {
  // A duplicate at an unchanged, explicitly observed number is allowed by the existing guard.
  // Force renumbering for the old duplicate case to test that it cannot become a unique remap.
  const old = name === 'duplicate old labels' ? now : before;
  const fresh = name === 'duplicate old labels' ? tree('\t\t26 text field (settable) Promo code\n\t\t55 combo box (collapsed, settable) Address') : now;
  const result = await replay({ ...source, before: old }, { snapshots: [fresh], recordedEffect: false });
  assert.match(result.error?.message ?? '', /sleight stopped before/, JSON.stringify({ output: result.output, writes: result.writes }));
  assert.equal(result.writes.length, 0);
});

test('renumber between read and write preserves the unique role, label and parent', async () => {
  const shifted = tree('\t\t26 text field (settable) Promo code\n\t\t54 combo box (collapsed, settable) Address');
  const result = await replay(source, { snapshots: [shifted], recordedEffect: false });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.writes.map(w => w.actual), [54]);
  assert.match(result.dispatches[0].line, /^combo box .* Address$/);
});

for (const ambiguous of [false, true]) test(`suggestion collapse keeps Expiry separate from Promo, duplicate=${ambiguous}`, async () => {
  const expanded = tree('\t\t26 combo box (expanded, settable) Address\n\t\t\t30 button Pick address\n\t\t48 text field (settable) Card number\n\t\t50 text field (settable) Expiry\n\t\t52 text field (settable) CVC');
  const collapsed = tree('\t\t26 combo box (collapsed, settable) Address\n\t\t45 text field (settable) Card number\n\t\t47 text field (settable) Expiry\n\t\t49 text field (settable) CVC\n\t\t50 text Promo code\n\t\t52 text field (settable) Promo code');
  const fresh = collapsed + (ambiguous ? '\n\t\t54 text field (settable) Expiry' : '');
  const result = await replay({ before: expanded, code: 'await app.click(30); await app.setValue(50, "11/28");' },
    { snapshots: [expanded, fresh], recordedEffect: false, bind: false });
  if (ambiguous) {
    assert.match(result.error?.message ?? '', /sleight stopped before/);
    assert.deepEqual(result.writes, [{ click: 30 }]);
  } else {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.writes, [{ click: 30 }, { number: 47, actual: 47, value: '11/28' }]);
    assert.match(result.dispatches[0].line, /^text field .* Expiry$/);
  }
});
