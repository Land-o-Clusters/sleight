import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBackgroundDrag } from '../plugins/sleight/lib/background-drag.mjs';

const request = { app: 'TextEdit', from: [20, 40], to: [200, 40] };
test('background prototype preserves window coordinates and bounded timing', () => {
  assert.deepEqual(validateBackgroundDrag(request), { ...request, holdMs: 500, steps: 25, settleMs: 1500, mode: 'window-location' });
  assert.equal(validateBackgroundDrag({ ...request, steps: 100, holdMs: 0 }).steps, 100);
});
test('invalid input fails before compiling or sending input', () => {
  for (const change of [{ app: '' }, { from: [NaN, 2] }, { to: [1] }, { steps: 0 }, { steps: 101 }, { steps: 2.5 }, { holdMs: -1 }, { settleMs: 5001 }, { mode: 'hid' }, { windowTitle: '' }, { windowId: 0 }, { abortAfterStep: 26 }]) {
    assert.throws(() => validateBackgroundDrag({ ...request, ...change }));
  }
});
