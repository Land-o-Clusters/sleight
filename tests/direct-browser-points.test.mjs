process.env.SLEIGHT_POINT_INPUT = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { validatePointStep, pointDragSteps, pointKind, assertDragSurface } from '../plugins/sleight/lib/direct-browser/points.mjs';
import { EventEmitter } from 'node:events';

const view = '0123456789abcdef';
const call = step => validateToolCall({ name: 'browser_act', arguments: { tab: 't1', steps: [step] } });
test('point schema accepts click, hover and drag, preserving ordinary ref drags', () => {
  for (const step of [{ do: 'click', x: 0, y: 2 }, { do: 'click', x: 4, y: 5, modifier: 'cmd' },
    { do: 'hover', x: 10, y: 20 }, { do: 'drag', x: 10, y: 20, to: { x: 110, y: 20 } },
    { do: 'drag', ref: 'e1', to: 'e2' }]) {
    const input = step.x === undefined ? step : { ...step, view };
    assert.deepEqual(call(input).arguments.steps[0], input);
  }
});

for (const step of [
  { do: 'click', x: 3 }, { do: 'click', y: 4 }, { do: 'click', x: -1, y: 0 }, { do: 'click', x: Infinity, y: 1 },
  { do: 'click', x: NaN, y: 1 }, { do: 'click', x: 1.5, y: 1 }, { do: 'click', x: 10001, y: 1 },
  { do: 'click', x: 1, y: 1, ref: 'e1' }, { do: 'type', x: 1, y: 1, text: 'no' },
  { do: 'press', x: 1, y: 1, key: 'Enter' }, { do: 'scroll', x: 1, y: 1, dy: 10 },
  { do: 'drag', x: 1, y: 1, to: 'e1' }, { do: 'drag', ref: 'e1', to: { x: 10, y: 20 } },
  { do: 'drag', x: 1, y: 1, to: { x: 1, y: 2 } }, { do: 'drag', x: 1, y: 1, to: { x: 20 } },
  { do: 'click', x: 1, y: 1, to: { x: 20, y: 20 } },
]) test('invalid point step sends no input: ' + JSON.stringify(step), async () => {
  const input = step.x !== undefined || step.y !== undefined ? { ...step, view } : step;
  assert.throws(() => call(input));
  const page = new EventEmitter();
  const run = createActionRunner({ check: () => assert.fail('no rule check'), snapshot: async () => ({ text: '', number: 1 }) });
  await assert.rejects(run({ page, state: {} }, [input]), error => error.notRun === true);
});

test('coordinates without a delivered viewport read are refused before target or input', async () => {
  const page = new EventEmitter(), run = createActionRunner({ check: () => assert.fail('no rule check'), snapshot: async () => ({ text: '', number: 1 }) });
  const result = await run({ page, state: {} }, [{ do: 'click', x: 20, y: 20, view }]);
  assert.match(result.lines[0], /not run: Point coordinates are stale or unavailable/);
});

test('drag path has 5 to 40 moves at about 15 CSS pixels, and endpoint controls refuse', () => {
  assert.equal(pointDragSteps({ x: 0, y: 0 }, { x: 15, y: 0 }), 5);
  assert.equal(pointDragSteps({ x: 0, y: 0 }, { x: 150, y: 0 }), 10);
  assert.equal(pointDragSteps({ x: 0, y: 0 }, { x: 10000, y: 0 }), 40);
  for (const info of [{ tag: 'button', button: true }, { tag: 'a', link: true }, { tag: 'a', link: false }, { tag: 'area', link: false }, { tag: 'input', kind: 'file' },
    { tag: 'div', payment: true }, { tag: 'div', submit: true }, { tag: 'video' }, { tag: 'div', role: 'checkbox' }]) assert.throws(() => assertDragSurface(info));
  assert.doesNotThrow(() => assertDragSurface({ tag: 'canvas' }));
  assert.equal(pointKind({ tag: 'button', name: 'secret' }), 'button');
  assert.equal(pointKind({ tag: 'input', kind: 'file', name: 'secret' }), 'input (file)');
  assert.equal(validatePointStep({ do: 'click', ref: 'e1' }), false);
});

test('point coordinates require the read view signature, and refs cannot carry one', () => {
  for (const step of [{ do: 'click', x: 20, y: 20 }, { do: 'hover', x: 20, y: 20, view: 'bad' },
    { do: 'click', ref: 'e1', view }, { do: 'wait', view }]) assert.throws(() => call(step));
});
