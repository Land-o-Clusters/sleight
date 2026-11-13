import test from 'node:test';
import assert from 'node:assert/strict';
import { compoundFixture, compoundTestNode } from './fixtures/compound-runtime.mjs';
import { createCompoundTransitionContract } from '../plugins/sleight/lib/mac-driver/compound/transitions.mjs';

test('dependent Region-to-Workshop changes need an exact declared field delta', async () => {
  for (const declared of [true, false]) {
    const h = compoundFixture('choose', { dependentChanges: declared ?
      [{ token: 'workshop', field: 'enabled', from: false, to: true }] : [] });
    h.snapshot.nodes.push(compoundTestNode('workshop', 'root', 'AXPopUpButton', 'Workshop', { enabled: false }));
    h.on('performed', x => { x.node('workshop').enabled = true; }, 2);
    const r = await h.run(); assert.equal(h.mutations.length, 2);
    if (declared) assert.equal(r.state, 'completed');
    else assert.equal(r.stop.reason, 'EFFECT_UNVERIFIED');
  }
});
test('a declared enabled delta cannot conceal a sibling value change', async () => {
  const h = compoundFixture('choose', { dependentChanges: [{ token: 'workshop', field: 'enabled', from: false, to: true }] });
  h.snapshot.nodes.push(compoundTestNode('workshop', 'root', 'AXPopUpButton', 'Workshop', { enabled: false }));
  h.on('performed', x => { x.node('workshop').enabled = true; x.node('workshop').value = 'unexpected recipient'; }, 2);
  const r = await h.run(); assert.equal(r.stop.reason, 'EFFECT_UNVERIFIED'); assert.equal(h.mutations.length, 2);
});
test('new menu nodes are restricted to the newly owned menu subtree', async () => {
  for (const [parent, role] of [['root', 'AXMenuItem'], ['edit-menu', 'AXTextField']]) {
    const h = compoundFixture();
    h.on('performed', x => { x.snapshot.nodes.push(compoundTestNode('unexpected', parent, role, 'Unknown')); });
    const r = await h.run(); assert.equal(r.stop.reason, 'EFFECT_UNVERIFIED'); assert.equal(h.mutations.length, 1);
  }
});
test('Save root-directory preparation retains exact literal destination', async () => {
  const h = compoundFixture('prepareSaveAs'); h.intent.destination = '/Pay.txt';
  const r = await h.run(); assert.equal(r.state, 'prepared'); assert.equal(h.mutations.length, 2);
  assert.deepEqual(h.mutations.map(m => m.value), ['/', 'Pay.txt']); assert.equal(r.commitSent, false);
});
for (const kind of ['network', 'icloud', 'symlink']) test(`Save directory ${kind} resolution has no implicit local contract`, async () => {
  const h = compoundFixture('prepareSaveAs'); h.on('performed', x => { x.snapshot.panel.directory.kind = kind; });
  const r = await h.run(); assert.equal(r.stop.reason, 'DESTINATION_UNVERIFIED'); assert.equal(h.mutations.length, 1);
  assert.equal(r.saved, false); assert.equal(r.commitSent, false);
});
test('unknown transition kinds and unbounded dependency predicates cannot construct a contract', () => {
  const base = { id: 'fixture', kind: 'choose.select', token: 'coast', qualifies: () => true, basis: 'fake' };
  assert.throws(() => createCompoundTransitionContract({ ...base, kind: 'filter-and-submit' }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => createCompoundTransitionContract({ ...base, dependentChanges: [{ token: 'any', field: '*', from: 1, to: 2 }] }),
    { code: 'INVALID_CONTRACT' });
});
