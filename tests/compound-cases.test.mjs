import test from 'node:test';
import assert from 'node:assert/strict';
import { compoundFixture } from './fixtures/compound-runtime.mjs';
import { recoveryFixture } from './fixtures/compound-recovery.mjs';
import { compoundCases } from './fixtures/compound-cases.mjs';

assert.equal(compoundCases.length, 72);
for (const c of compoundCases) {
  test(`${c.id} supported counterpart: ${c.title}`, async () => {
    if (['A69', 'A70'].includes(c.id)) {
      const h = recoveryFixture(); h.arm();
      const result = await h.recovery.recover(h.request);
      assert.equal(result.posted, true); assert.equal(h.runs, 1); assert.equal(result.continuation, false); return;
    }
    const h = compoundFixture(c.op, c.happyOptions ?? {}); c.happy(h);
    const result = await h.run();
    assert.equal(result.state, c.op === 'prepareSaveAs' ? 'prepared' : 'completed', JSON.stringify(result));
    assert.equal(h.mutations.length, h.happySends ?? (c.op === 'menu' ? 3 : 2));
    assert.equal(result.completedSteps, 3 - (c.op === 'choose' ? 1 : 0));
    assert.equal(result.steps.filter(s => s.attempts).length, h.mutations.length);
    assert.ok(h.effects.every(e => e.recipient === 'document-A' && e.effect === 'local'));
    assert.equal(h.clipboardAccesses + h.postedEvents + h.forbiddenCalls, 0);
    if (c.op === 'prepareSaveAs') { assert.equal(result.saved, false); assert.equal(result.commitSent, false); }
  });
  test(`${c.id} refused near-match: ${c.title}`, async () => {
    if (['A69', 'A70'].includes(c.id)) {
      const h = recoveryFixture();
      if (c.id === 'A69') {
        const compound = compoundFixture(); compound.suppressEffect = true; h.request.receipt = await compound.run();
        assert.ok(compound.calls.filter(x => x === 'read').length >= 2);
      } else { h.arm(); h.request.modalAbsent = false; }
      const result = await h.recovery.recover(h.request);
      assert.equal(result.attempted, false); assert.equal(h.runs, 0); return;
    }
    const h = compoundFixture(c.op); c.happy(h);
    // A39's refusal is the incomplete version of the same already-selected tree.
    c.setup(h);
    if (c.parser) await assert.rejects(h.run(), { code: c.reason });
    else {
      const result = await h.run();
      assert.equal(result.stop?.reason, c.reason, JSON.stringify(result));
      assert.ok(['stopped', 'uncertain'].includes(result.state));
      assert.ok(result.steps.filter(s => s.attempts > 0 && !s.effectObserved).length <= 1);
      assert.equal(result.steps.reduce((n, s) => n + s.attempts, 0), h.mutations.length);
      assert.equal(result.replayWholeCompound, false);
      assert.ok(result.remaining.every(i => result.steps[i].delivery === 'not-sent'));
      if (c.op === 'prepareSaveAs') { assert.equal(result.saved, false); assert.equal(result.commitSent, false); }
    }
    if (c.maxReads !== undefined) assert.ok((h.counts.get('read') ?? 0) <= c.maxReads, 'named guard must stop before a later read');
    if (c.maxAdmits !== undefined) assert.ok((h.counts.get('admit') ?? 0) <= c.maxAdmits, 'named guard must stop before requesting admission');
    if (c.effectReason) assert.equal(h.effectChecks.at(-1)?.reason, c.effectReason, 'specific postcondition guard must explain refusal');
    assert.equal(h.mutations.length, c.sends);
    assert.equal(h.clipboardAccesses + h.postedEvents + h.forbiddenCalls, 0);
  });
}
