import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeHand } from '../plugins/sleight/lib/hand/runtime-hand.mjs';

test('CR2B Glide drawing preserves measured window bounds independently of the target rect', () => {
  const frames = [], rect = [10, 20, 30, 40], windowRect = [0, 0, 900, 600];
  const hand = createRuntimeHand({ client: { send: frame => frames.push(frame) } });
  hand({ type: 'action', phase: 'act', kind: 'click', point: [25, 40], rect, window: { id: 7, pid: 42, rect: windowRect } });
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].rect, rect); assert.deepEqual(frames[0].windowRect, windowRect);
});
