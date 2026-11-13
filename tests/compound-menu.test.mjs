import test from 'node:test';
import assert from 'node:assert/strict';
import { compoundFixture, compoundTestNode } from './fixtures/compound-runtime.mjs';
import { compoundCases } from './fixtures/compound-cases.mjs';
import { recoveryFixture } from './fixtures/compound-recovery.mjs';
import { createCompoundHelper } from '../plugins/sleight/lib/mac-driver/compound/helper.mjs';
import { parseCompoundIntent } from '../plugins/sleight/lib/mac-driver/compound/intent.mjs';
import { resolveUnopenedMenu } from '../plugins/sleight/lib/mac-driver/compound/menu.mjs';

const direct = () => compoundFixture('menu', { unopened: true });
const noForeignInput = h => {
  assert.deepEqual(h.mutations.map(m => m.node), h.mutations.length ? ['command'] : []);
  assert.equal(h.clipboardAccesses + h.postedEvents + h.forbiddenCalls, 0);
};
test('unopened three-title path presses only the leaf once and reports Accessibility', async () => {
  const h = direct(), r = await h.run();
  assert.equal(r.state, 'completed', JSON.stringify(r));
  assert.equal(r.completedSteps, 1); assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].transition, 'menu.direct');
  assert.equal(r.detail, 'Pressed the menu item through Accessibility without opening the menu.');
  assert.equal(r.menuLeftOpen, false); assert.deepEqual(r.remaining, []);
  assert.equal(h.node('edit').expanded, false); assert.equal(h.node('find').expanded, false);
  assert.equal(h.snapshot.domains.menu.container, 'bar'); noForeignInput(h);
});
test('leaf absent from unopened hierarchy uses the original three-step path', async () => {
  const h = compoundFixture(), r = await h.run();
  assert.equal(r.state, 'completed');
  assert.deepEqual(h.mutations.map(m => m.node), ['edit', 'find', 'command']);
  assert.equal(r.menuMechanism, undefined);
});
for (const enabled of [true, false]) test(`ignored unopened leaf enabled=${enabled} returns next read and never presses twice`, async () => {
  const h = direct(); h.node('command').enabled = enabled; h.suppressEffect = true;
  const r = await h.run();
  assert.equal(r.state, 'uncertain'); assert.equal(r.stop?.reason, 'ACTION_UNCONFIRMED');
  assert.equal(r.steps.length, 1); assert.equal(r.steps[0].attempts, 1);
  assert.equal(r.steps[0].delivery, 'sent-unverified'); assert.equal(r.unknownStep, 0);
  assert.equal(r.observation.status, 'available'); assert.equal(r.observation.readId, r.steps[0].afterReadId);
  assert.deepEqual(h.flowReads, [r.observation.readId]); assert.equal(h.invalidated, true);
  assert.equal(r.replayWholeCompound, false); assert.deepEqual(r.remaining, []); noForeignInput(h);
});
test('stale disabled metadata does not prevent a single qualified leaf attempt', async () => {
  const h = direct(); h.node('command').enabled = false;
  const r = await h.run(); assert.equal(r.state, 'completed'); noForeignInput(h);
});
test('a present but unqualified leaf never falls back to opening parents', async () => {
  const h = direct(); h.evidence.delete('menu.direct:command');
  const r = await h.run(); assert.equal(r.stop?.reason, 'UNSUPPORTED_TRANSITION'); noForeignInput(h);
});
test('disabled dormant twins at any path depth are ambiguous before input', async () => {
  for (const token of ['edit', 'find', 'command']) {
    const h = direct(); h.snapshot.nodes.push({ ...h.node(token), token: 'twin', enabled: false });
    const r = await h.run(); assert.equal(r.stop?.reason, 'AMBIGUOUS_STEP'); noForeignInput(h);
  }
});
test('same leaf title in a different branch does not broaden the literal path', async () => {
  const h = direct(); h.snapshot.nodes.push(compoundTestNode('rival', 'edit-menu', 'AXMenuItem', 'Find and Replace…', { active: false }));
  const r = await h.run(); assert.equal(r.state, 'completed'); noForeignInput(h);
});
for (const [name, change, reason] of [
  ['kernel start', h => { h.snapshot.binding.processStart = 'start-2'; }, 'IDENTITY_CHANGED'],
  ['PID', h => { h.snapshot.binding.pid++; }, 'IDENTITY_CHANGED'],
  ['main recipient', h => { h.snapshot.binding.mainWindowId = '43'; }, 'IDENTITY_CHANGED'],
  ['document', h => { h.snapshot.binding.document = 'document-B'; }, 'IDENTITY_CHANGED'],
  ['helper incarnation', h => { h.snapshot.binding.helper = 'helper-2'; }, 'IDENTITY_CHANGED'],
  ['retained root', h => { h.snapshot.binding.root = 'new-root'; }, 'IDENTITY_CHANGED'],
  ['leaf enabled drift', h => { h.node('command').enabled = false; }, 'WITNESS_CHANGED'],
  ['leaf title drift', h => { h.node('command').title += '…'; }, 'WITNESS_CHANGED'],
  ['leaf Help drift', h => { h.node('command').help = 'Upload'; }, 'WITNESS_CHANGED'],
  ['sibling drift', h => { h.node('find').value = 'Other'; }, 'WITNESS_CHANGED'],
  ['lease rotation', h => { h.auth.lease.token = 'rotated'; }, 'AUTHORITY_CHANGED'],
]) test(`unopened execute rechecks ${name}`, async () => {
  const h = direct(); h.on('admit', change);
  const r = await h.run(); assert.equal(r.stop?.reason, reason, JSON.stringify(r)); noForeignInput(h);
});
for (const [name, change, reason] of [
  ['unreadable sibling', h => { h.snapshot.gaps.push('sibling'); }, 'OBSERVATION_INCOMPLETE'],
  ['incomplete child list', h => { h.node('find-menu').childrenComplete = false; }, 'OBSERVATION_INCOMPLETE'],
  ['torn walk', h => { h.snapshot.coherent = false; }, 'OBSERVATION_INCOMPLETE'],
  ['unproved bar owner', h => { h.snapshot.relations = []; }, 'OWNER_UNPROVEN'],
  ['two bar owners', h => { h.snapshot.relations.push({ ...h.snapshot.relations[0] }); }, 'OWNER_UNPROVEN'],
  ['unknown role', h => { h.node('find').role = 'AXGroup'; }, 'STEP_NOT_FOUND'],
  ['disabled parent', h => { h.node('find').enabled = false; }, 'STEP_DISABLED'],
  ['already tracking', h => { h.node('edit-menu').active = true; }, 'UNEXPECTED_TRANSITION'],
  ['hover-only mechanism', h => { h.qualified = false; }, 'UNSUPPORTED_TRANSITION'],
  ['new modal', h => { h.snapshot.modals.push({ kind: 'alert' }); }, 'MODAL_APPEARED'],
  ['blocked background route', h => { h.snapshot.routing.blocked = true; }, 'BACKGROUND_UNAVAILABLE'],
  ['unknown effect semantics', h => { h.classification = 'unknown'; }, 'BOUNDARY_REQUIRED'],
  ['missing AXPress', h => { h.node('command').actions = []; }, 'UNSUPPORTED_TRANSITION'],
]) test(`unopened ${name} refuses without parent fallback`, async () => {
  const h = direct(); change(h);
  const r = await h.run(); assert.equal(r.stop?.reason, reason, JSON.stringify(r)); noForeignInput(h);
});
test('a final path component owning a submenu cannot be pressed as a leaf', async () => {
  const h = direct(); h.intent.segments.pop();
  const r = await h.run(); assert.equal(r.stop?.reason, 'UNSUPPORTED_TRANSITION'); noForeignInput(h);
});
for (const field of ['title', 'description', 'help', 'value']) test(`consequential ${field} on a dormant ancestor refuses`, async () => {
  const h = direct(); h.node('find')[field] = 'Pay $50';
  if (field === 'title') h.intent.segments[1] = 'Pay $50';
  const r = await h.run(); assert.equal(r.stop?.reason, 'BOUNDARY_REQUIRED'); noForeignInput(h);
});
for (const label of ['Pay', 'Delete', 'Save', 'Book trip', 'Enable two-factor', 'Confirmé', 'ВUY', 'SEΝD'])
  test(`unopened consequential leaf ${label} refuses`, async () => {
    const h = direct(); h.intent.segments[2] = label; h.node('command').title = label;
    const r = await h.run(); assert.equal(r.stop?.reason, 'BOUNDARY_REQUIRED'); noForeignInput(h);
  });
for (const label of ['17', '0 standard window', 'A > B', 'Édition', 'Local lookup '])
  test(`unopened literal label ${JSON.stringify(label)} stays exact`, async () => {
    const h = direct(); h.intent.segments[2] = label; h.node('command').title = label;
    const r = await h.run(); assert.equal(r.state, 'completed'); noForeignInput(h);
  });
test('unopened canonical-equivalent or trimmed aliases never select the leaf', () => {
  for (const label of ['E\u0301dit', 'Édit ']) {
    const h = direct(); h.node('command').title = 'Édit';
    const p = parseCompoundIntent({ operation: 'menu', segments: ['Edit', 'Find', label] });
    assert.equal(resolveUnopenedMenu(h.snapshot, p.segments), null);
  }
});
test('every CPD1 menu attack still exercises the guarded lazy fallback', async t => {
  // These schedules retain their original multi-step timings and assertions.
  const cases = compoundCases.filter(c => c.op === 'menu');
  for (const c of cases) await t.test(`${c.id} ${c.title}`, async () => {
    if (['A69', 'A70'].includes(c.id)) {
      const recovery = recoveryFixture();
      if (c.id === 'A69') {
        const h = compoundFixture(); h.suppressEffect = true;
        recovery.request.receipt = await h.run();
      } else { recovery.arm(); recovery.request.modalAbsent = false; }
      const r = await recovery.recovery.recover(recovery.request);
      assert.equal(r.attempted, false); assert.equal(recovery.runs, 0); return;
    }
    const h = compoundFixture(); c.happy(h); c.setup(h);
    if (c.parser) await assert.rejects(h.run(), { code: c.reason });
    else { const r = await h.run(); assert.equal(r.stop?.reason, c.reason); }
    assert.equal(h.mutations.length, c.sends);
  });
});
test('duplicate direct execute retains the uncertain read without a second press', async () => {
  const h = direct(); h.suppressEffect = true;
  const helper = createCompoundHelper({ execution: 'direct', intent: parseCompoundIntent(h.intent), binding: h.snapshot.binding,
    provider: h.provider, contracts: h.contracts, now: () => h.time, deadline: 31000,
    authorizeRead: async () => true, consume: () => {} });
  await helper.prepare(); const a = await helper.execute({}, 0), b = await helper.execute({}, 0);
  assert.equal(a.reason, 'ACTION_UNCONFIRMED'); assert.equal(b.reason, a.reason);
  assert.equal(b.afterReadId, a.afterReadId); noForeignInput(h);
});
