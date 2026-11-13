import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserTools, validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { validatePointStep, capturePointView } from '../plugins/sleight/lib/direct-browser/points.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { EventEmitter } from 'node:events';

const view = '0123456789abcdef';
for (const setting of [undefined, '0', 'true', '01', '1']) test('point input requires exact opt-in: ' + setting, async t => {
  const prior = process.env.SLEIGHT_POINT_INPUT;
  t.after(() => { if (prior === undefined) delete process.env.SLEIGHT_POINT_INPUT; else process.env.SLEIGHT_POINT_INPUT = prior; });
  if (setting === undefined) delete process.env.SLEIGHT_POINT_INPUT; else process.env.SLEIGHT_POINT_INPUT = setting;
  const enabled = setting === '1', act = browserTools('bfixture').find(tool => tool.name === 'browser_act');
  const properties = act.inputSchema.properties.steps.items.properties;
  assert.equal(Object.hasOwn(properties, 'x'), enabled);
  assert.equal(Object.hasOwn(properties, 'y'), enabled);
  assert.equal(Object.hasOwn(properties, 'view'), enabled);
  assert.equal(act.description.includes('Points use'), enabled);
  if (!enabled) assert.deepEqual(properties.to, { type: 'string', pattern: '^(?:(?:f[0-9]+)?e[0-9]+|[sx][0-9]+)$' });
  for (const step of [{ do: 'click', x: 20, y: 20, view }, { do: 'hover', x: 20, y: 20, view },
    { do: 'drag', x: 20, y: 20, view, to: { x: 40, y: 20 } }]) {
    const call = () => validateToolCall({ name: 'browser_act', arguments: { tab: 't1', steps: [step] } });
    if (enabled) { assert.doesNotThrow(call); assert.equal(validatePointStep(step), true); }
    else {
      assert.throws(call, /SLEIGHT_POINT_INPUT=1/);
      assert.throws(() => validatePointStep(step), /SLEIGHT_POINT_INPUT=1/);
      const run = createActionRunner({ check: () => assert.fail('disabled input must not reach rules'), snapshot: () => assert.fail('disabled input must not read') });
      await assert.rejects(run({ page: new EventEmitter(), state: {} }, [step]), /SLEIGHT_POINT_INPUT=1/);
    }
  }
  if (!enabled) {
    assert.throws(() => validatePointStep({ do: 'drag', ref: 'e1', to: { x: 20, y: 20 } }), /SLEIGHT_POINT_INPUT=1/);
    assert.throws(() => validatePointStep({ do: 'click', ref: 'e1', view }), /SLEIGHT_POINT_INPUT=1/);
    assert.equal(await capturePointView({ frames: () => assert.fail('disabled reads must not capture geometry') }), null);
  }
  assert.doesNotThrow(() => validateToolCall({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'drag', ref: 'e1', to: 'e2' }] } }));
});

for (const mode of ['1', '0']) for (const enabled of [false, true])
  test(`point catalog pin: MT=${mode}, enabled=${enabled}`, t => {
    const previous = { SLEIGHT_MT: process.env.SLEIGHT_MT, SLEIGHT_POINT_INPUT: process.env.SLEIGHT_POINT_INPUT };
    t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    process.env.SLEIGHT_MT = mode;
    if (enabled) process.env.SLEIGHT_POINT_INPUT = '1'; else delete process.env.SLEIGHT_POINT_INPUT;
    const json = JSON.stringify(browserTools('bfixture'));
    const pins = mode === '0'
      ? { off: ['a2c815d6f1f3f8f711c23375882dd61e22756ea5a17f3c8f886b6a149bb021d4', 6162], on: ['6c6bd659d3ca4f40a5d12d45668e025e900938591798ed20af2572cd0bb55218', 6581] }
      : { off: ['5eee412683a79e8b826169bb2c03cb9302f623d015c35f4f914670d3ff8bf6ea', 6083], on: ['f114d4c2fbf4c341be50194e44a50c0ba98ddea6adbf1df26d15a5e5fdeb7637', 6502] };
    const [hash, length] = pins[enabled ? 'on' : 'off'];
    assert.equal(json.length, length);
    assert.equal(createHash('sha256').update(json).digest('hex'), hash);
  });
