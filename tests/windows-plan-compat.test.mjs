import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSharedPlans } from '../scripts/windows-plan-compat.mjs';
import { comparePlans } from '../bench/windows/run-checks.mjs';

test('shared Windows plans omit only empty narration and Mac pause diagnostics', () => {
  const plan = { effect: 'draw', state: 'click', layers: [{ name: 'ring' }], total: 1 };
  const full = { ...plan, bubble: null, pauseControl: { after: 1, rect: [1, 2, 24, 24], sprite: false } };
  assert.deepEqual(windowsSharedPlans([full]), [plan]);
  assert.ok(full.pauseControl, 'the full captured fixture retains the Mac diagnostic');
  for (const key of ['state', 'layers', 'total']) {
    const changed = { ...plan, [key]: null };
    assert.ok(comparePlans(windowsSharedPlans([full]), windowsSharedPlans([changed])), key);
  }
  assert.ok(comparePlans(windowsSharedPlans([full]), windowsSharedPlans([{ ...plan, unknown: true }])));
});

test('unsupported narration and malformed pause diagnostics refuse comparison', () => {
  assert.throws(() => windowsSharedPlans([{ effect: 'draw', bubble: { spoken: 'text' } }]), /unsupported/);
  for (const pauseControl of [null, {}, { after: -1, rect: null, sprite: false },
    { after: 1, rect: [1, 2], sprite: false }, { after: 1, rect: null, sprite: 'false' },
    { after: 1, rect: null, sprite: false, extra: true }])
    assert.throws(() => windowsSharedPlans([{ effect: 'draw', pauseControl }]), /Invalid Mac pause/);
});

test('non-drawing records remain complete and retain object identity', () => {
  const record = { effect: 'end', idle: true, pending: 0, timers: 0 };
  assert.equal(windowsSharedPlans([record])[0], record);
});
