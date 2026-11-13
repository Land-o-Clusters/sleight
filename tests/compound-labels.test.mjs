import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConsequentialLabel, compareMacElement } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { compoundLabelBoundary } from '../plugins/sleight/lib/mac-driver/compound/boundary.mjs';
import { compoundFixture } from './fixtures/compound-runtime.mjs';
import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
const labels = parserSkip ? {} : await import('./fixtures/compound-labels.mjs');
const { sharedTableLabels, rt11jLabels, compoundParityLabels } = labels;

for (const label of ['Confirmé', 'ВUY', 'SEΝD', 'Ѕtart']) test(`compound blocks RT11J label ${label}`, async () => {
  const h = compoundFixture(); h.node('edit').help = label;
  const result = await h.run();
  assert.equal(result.stop?.reason, 'BOUNDARY_REQUIRED'); assert.equal(h.mutations.length, 0);
});
test('compound and numbered-action classifiers agree on the shared table and RT11J labels', { skip: parserSkip }, t => {
  assert.equal(sharedTableLabels.length, 365); assert.equal(rt11jLabels.length, 383);
  for (const label of sharedTableLabels) assert.equal(classifyConsequentialLabel(label), 'boundary', label);
  for (const label of compoundParityLabels) {
    const classification = classifyConsequentialLabel(label);
    assert.equal(compoundLabelBoundary(label), classification, JSON.stringify(label));
    // A bare button's nonempty shown label uses the same lexical classifier.
    // Empty/malformed labels bind a form structurally, independently of lexicon.
    if (/\p{Cc}/u.test(label) || /^(?:Description|Value|ID):/.test(label)) continue;
    const before = `0 standard window Draft\n\t1 button ${label}\n\t2 text Later`;
    const result = compareMacElement(before, before.replace('text Later', 'text Changed'), 1);
    assert.equal(result.why === 'consequential-tree', classification === 'boundary', JSON.stringify(label));
  }
  t.diagnostic(`shared table=${sharedTableLabels.length}; RT11J label probes=${rt11jLabels.length}; total=${compoundParityLabels.length}`);
});
