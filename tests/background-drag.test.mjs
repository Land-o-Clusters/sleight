import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBackgroundDrag } from '../bench/background-drag/helper.mjs';
import * as helper from '../bench/background-drag/helper.mjs';

const request = { app: 'TextEdit', from: [20, 40], to: [200, 40] };
test('background prototype preserves window coordinates and bounded timing', () => {
  assert.deepEqual(validateBackgroundDrag(request), { ...request, holdMs: 500, steps: 25, settleMs: 1500, mode: 'window-location' });
  assert.equal(validateBackgroundDrag({ ...request, steps: 100, holdMs: 0 }).steps, 100);
});
test('benchmark options survive validation instead of silently changing the experiment', () => {
  const input = { ...request, holdMs: 2000, command: false, posting: 'psn', select: true };
  const result = validateBackgroundDrag(input);
  assert.equal(result.command, false);
  assert.equal(result.posting, 'psn');
  assert.equal(result.select, true);
});
test('benchmark options reject mistyped modifiers, selection and posting APIs', () => {
  for (const change of [{ command: 'false' }, { posting: 'hid' }, { select: 1 }]) {
    assert.throws(() => validateBackgroundDrag({ ...request, ...change }));
  }
});
test('text drop uses the final visible glyph on the source line, including window offsets', () => {
  assert.equal(typeof helper.textDragPoints, 'function');
  assert.deepEqual(helper.textDragPoints({
    startBounds: [110, 220, 30, 14], endGlyphBounds: [210, 220, 10, 14], windowOrigin: [100, 200],
  }), { from: [25, 27], to: [123, 27] });
});
test('missing, nonfinite, empty and different-line glyph bounds refuse a text trial', () => {
  assert.equal(typeof helper.textDragPoints, 'function');
  const input = { startBounds: [110, 220, 30, 14], endGlyphBounds: [210, 220, 10, 14], windowOrigin: [100, 200] };
  for (const change of [{ startBounds: undefined }, { endGlyphBounds: [210, 206, 10, 14] },
    { endGlyphBounds: [210, 220, 0, 14] }, { windowOrigin: [NaN, 200] }]) {
    assert.throws(() => helper.textDragPoints({ ...input, ...change }));
  }
});
test('invalid input fails before compiling or sending input', () => {
  for (const change of [{ app: '' }, { from: [NaN, 2] }, { to: [1] }, { steps: 0 }, { steps: 101 }, { steps: 2.5 }, { holdMs: -1 }, { settleMs: 5001 }, { mode: 'hid' }, { windowTitle: '' }, { windowId: 0 }, { abortAfterStep: 26 }]) {
    assert.throws(() => validateBackgroundDrag({ ...request, ...change }));
  }
});
test('a completed post is not a verified background text move', () => {
  assert.equal(typeof helper.judgeTextDrag, 'function');
  const drag = { ok: true, pointerUnchanged: true, stayedBackground: true };
  const after = { ok: true, active: false, text: ' beta gammaalpha\n' };
  assert.deepEqual(helper.judgeTextDrag(drag, after), { moved: true, backgroundMove: true });
  assert.deepEqual(helper.judgeTextDrag(drag, { ...after, text: 'alpha beta gamma\n' }), { moved: false, backgroundMove: false });
  for (const change of [{ ok: false }, { pointerUnchanged: false }, { stayedBackground: false }]) {
    assert.deepEqual(helper.judgeTextDrag({ ...drag, ...change }, after), { moved: true, backgroundMove: false });
  }
  assert.deepEqual(helper.judgeTextDrag(drag, { ...after, active: true }), { moved: true, backgroundMove: false });
  assert.deepEqual(helper.judgeTextDrag(drag, { ok: false }), { moved: false, backgroundMove: false });
});
test('cancellation between app stages prevents later actions while retaining exact-fixture cleanup', async () => {
  assert.equal(typeof helper.runTextDragTrial, 'function');
  for (const cancelAt of ['open', 'settle', 'select', 'drag', 'after-wait']) {
    let stopping = false;
    const calls = [];
    const step = name => async () => { calls.push(name); if (name === cancelAt) stopping = true; };
    const operations = { cancelled: () => stopping, open: step('open'), select: step('select'), drag: step('drag'),
      read: step('read'), close: step('close'), wait: ms => step(ms === 1200 ? 'settle' : 'after-wait')() };
    await assert.rejects(helper.runTextDragTrial(operations), /cancelled/);
    const expected = {
      open: ['open', 'close'], settle: ['open', 'settle', 'close'], select: ['open', 'settle', 'select', 'close'],
      drag: ['open', 'settle', 'select', 'drag', 'close'],
      'after-wait': ['open', 'settle', 'select', 'drag', 'after-wait', 'close'],
    };
    assert.deepEqual(calls, expected[cancelAt]);
  }
});
test('an already cancelled trial opens nothing and a failed open still closes its exact fixture', async () => {
  assert.equal(typeof helper.runTextDragTrial, 'function');
  const calls = [];
  const operations = { cancelled: () => true, open: async () => calls.push('open'), close: async () => calls.push('close') };
  await assert.rejects(helper.runTextDragTrial(operations), /cancelled/);
  assert.deepEqual(calls, []);
  await assert.rejects(helper.runTextDragTrial({ ...operations, cancelled: () => false,
    open: async () => { calls.push('open'); throw new Error('open failed'); } }), /open failed/);
  assert.deepEqual(calls, ['open', 'close']);
});
test('an uncancelled trial reads its result before closing the fixture', async () => {
  const calls = [];
  const step = name => async () => calls.push(name);
  await helper.runTextDragTrial({ cancelled: () => false, open: step('open'), select: step('select'),
    drag: step('drag'), read: step('read'), close: step('close'), wait: ms => step(ms === 1200 ? 'settle' : 'after-wait')() });
  assert.deepEqual(calls, ['open', 'settle', 'select', 'drag', 'after-wait', 'read', 'close']);
});
test('one background move cannot hide cancellation or unexpected trial failures', () => {
  assert.equal(typeof helper.textDragExitCode, 'function');
  const good = { backgroundMove: true, drag: { ok: true }, after: { ok: true } };
  assert.equal(helper.textDragExitCode([good]), 0);
  assert.equal(helper.textDragExitCode([good], true), 1);
  assert.equal(helper.textDragExitCode([]), 1);
  assert.equal(helper.textDragExitCode([{ ...good, backgroundMove: false }]), 1);
  for (const bad of [{ error: 'read failed' }, { cleanupError: 'close failed' },
    { drag: { ok: false }, after: { ok: true } }, { after: { ok: false } }]) {
    assert.equal(helper.textDragExitCode([good, { ...good, ...bad }]), 1);
  }
  assert.equal(helper.textDragExitCode([good, { backgroundMove: false, ax: { ok: false }, after: { ok: true } }]), 0);
});
