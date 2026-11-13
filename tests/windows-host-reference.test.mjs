import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsPlannerHash } from '../scripts/windows-planner-source.mjs';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { windowsSharedPlans } from '../scripts/windows-plan-compat.mjs';
import { ringCases } from './fixtures/windows-ring-cases.mjs';

const reference = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/windows-ring-reference.json.gz', import.meta.url))));
test('VM reference is bound to the Swift planner regions and contains every complete ring plan', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url));
  assert.equal(reference.plannerSha256, windowsPlannerHash(source), 'regenerate the Windows reference after changing its Swift planner regions');
  assert.equal(windowsPlannerHash(source + '\n// unrelated window change\n'), reference.plannerSha256);
  assert.notEqual(windowsPlannerHash(String(source).replace('// BEGIN RING PLAN\n', '// BEGIN RING PLAN\n// planner change\n')), reference.plannerSha256);
  for (const fixture of ringCases) {
    const effects = reference.cases[fixture.name]; assert.ok(effects, fixture.name);
    assert.doesNotThrow(() => windowsSharedPlans(effects));
    for (const draw of effects.filter(row => row.effect === 'draw')) {
      assert.equal(draw.bubble, null);
      assert.deepEqual(Object.keys(draw.pauseControl).sort(), ['after', 'rect', 'sprite']);
    }
    assert.deepEqual(effects.at(-1), { effect: 'end', idle: true, pending: 0, timers: 0 });
    for (const plan of effects.filter(e => e.effect === 'draw')) {
      assert.ok(plan.layers.length > 0);
      assert.ok(plan.budget.samples >= 1);
      if (plan.budget.samples === 1) { assert.equal(plan.total, 0); assert.equal(plan.animations.length, 0); }
      for (const track of plan.animations) {
        assert.equal(track.values.length, track.times.length);
        assert.equal(track.times[0], 0); assert.equal(track.times.at(-1), 1);
        assert.ok(track.times.every((time, i) => i === 0 || time >= track.times[i - 1]));
      }
    }
  }
});
test('VM sprite reference includes decoded art, direction variants and finite discrete tracks', () => {
  for (const name of ['sprite-states', 'sprite-reduced']) {
    const effects = reference.cases[name]; assert.equal(effects.find(e => e.effect === 'character')?.loaded, true);
    const plans = effects.filter(e => e.effect === 'draw');
    assert.ok(plans.every(plan => plan.sprite?.layers === 1));
    assert.ok(plans.some(plan => plan.sprite.poses.some(pose => pose.state === 'drag-carry')));
    for (const plan of plans) for (const track of plan.sprite.tracks) {
      assert.equal(track.keyTimes[0], 0); assert.equal(track.keyTimes.at(-1), 1);
      assert.equal(track.keyTimes.length, track.values);
    }
  }
});

test('VM sprite reference exercises every half-step direction boundary inside the clip', () => {
  for (let i=0;i<16;i++) {
    const effects=reference.cases['sprite-direction-'+i];
    const aim=effects.find(e=>e.effect==='draw' && e.state==='aim');
    assert.ok(aim?.sprite?.poses.length, 'direction '+i);
    assert.ok(aim.sprite.poses.some(p=>p.direction>=0 && p.direction<16), 'direction '+i);
  }
});
