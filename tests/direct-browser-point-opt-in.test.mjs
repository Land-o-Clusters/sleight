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
      ? {
        // HO1 pins the legacy catalog without point input.
        off: ['5e34ae4d2b0d4a250ff865c50e27421a059c81f3712d773de8d6658abacfb9bf', 6101],
        // HO1 pins the legacy catalog with point input.
        on: ['7b4622a6eb2b28bc611a999a123063884745297d027638b5453ea6ec1c041c03', 6520],
      } : {
        // HO1 pins the MT catalog without point input.
        off: ['e86f834fcbd2925113c94378bcd721363aee5f683799550249831f60e0bf8465', 6242],
        // HO1 pins the MT catalog with point input.
        on: ['048abe61536e210452d61e66535d5be927dcc78ee2ca67395c3db96181d8c432', 6661],
      };
    const [hash, length] = pins[enabled ? 'on' : 'off'];
    assert.equal(json.length, length);
    assert.equal(createHash('sha256').update(json).digest('hex'), hash);
  });
