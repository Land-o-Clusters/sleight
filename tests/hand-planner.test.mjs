import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHandFrames, handTargets, handIdentity, GUARD_READ_MS, WRITE_MS } from '../plugins/sleight/lib/hand/planner.mjs';

// A 656×422-point window at (100, 200) on a Retina display, screenshotted at 1312×844 pixels.
const BOUNDS = { X: 100, Y: 200, Width: 656, Height: 422 };
const WINDOW = { pid: 321, windowId: 77, bounds: BOUNDS };
const SHOT = [1312, 844];
const DISPLAYS = [{ X: 0, Y: 0, Width: 1512, Height: 982 }];
// Front to back: the menu bar strip, then the target window alone.
const WINDOWS = [
  { id: 1, pid: 50, layer: 25, owner: 'Window Server', bounds: { X: 0, Y: 0, Width: 1512, Height: 24 } },
  { id: 77, pid: 321, layer: 0, owner: 'Editor', bounds: BOUNDS },
];
const TREE = 'Window: "notes.txt", App: Editor.\n0 standard window notes.txt\n' +
  '\t1 button Description: Save, ID: saveButton\n\t2 text field (settable) Value: draft, ID: nameField\n' +
  '\t3 button Cancel\n\t4 row Selected, Item one\n\t5 button Cancel';
const ELEMENTS = { 1: { X: 120, Y: 240, Width: 80, Height: 20 }, 2: { X: 300, Y: 400, Width: 200, Height: 24 }, 4: { X: 110, Y: 500, Width: 600, Height: 30 } };
const base = (code, extra = {}) => ({ code, lines: TREE, screenshotSize: SHOT, window: WINDOW, elements: ELEMENTS,
  windows: WINDOWS, displays: DISPLAYS, ...extra });

test('click, double and right clicks at screenshot pixels land at global points via the screenshot scale', () => {
  const { frames, skipped } = planHandFrames(base('await app.click([400, 196]); await app.doubleClick([0, 0]); await app.rightClick([1310, 842]);'));
  assert.deepEqual(skipped, []);
  assert.deepEqual(frames, [
    { kind: 'click', pid: 321, windowId: 77, at: [300, 298], path: [[300, 298]], delayMs: 0, beats: 1 },
    { kind: 'double', pid: 321, windowId: 77, at: [100, 200], path: [[100, 200]], delayMs: WRITE_MS, beats: 2 },
    { kind: 'right', pid: 321, windowId: 77, at: [755, 621], path: [[755, 621]], delayMs: 2 * WRITE_MS, beats: 1 },
  ]);
});

test('a scroll and a drag use the same conversion, the drag with its whole path', () => {
  const { frames } = planHandFrames(base('await app.scroll([200, 500], "down", 3); await app.drag([100, 100], [300, 200]);'));
  assert.deepEqual(frames, [
    { kind: 'scroll', pid: 321, windowId: 77, at: [200, 450], path: [[200, 450]], delayMs: 0, beats: 1 },
    { kind: 'drag', pid: 321, windowId: 77, at: [150, 250], path: [[150, 250], [250, 300]], delayMs: WRITE_MS, beats: 1 },
  ]);
});

test('click(N) resolves through the last read to the AX frame, after the guard read', () => {
  const { frames, skipped } = planHandFrames(base('await app.click(1); await app.click({ id: "nameField" }); await app.click({ label: "Item one" });'));
  assert.deepEqual(skipped, []);
  assert.deepEqual(frames.map(f => [f.kind, f.at, f.delayMs]), [
    ['click', [160, 250], GUARD_READ_MS],
    ['click', [400, 412], 2 * GUARD_READ_MS + WRITE_MS],
    ['click', [410, 515], 3 * GUARD_READ_MS + 2 * WRITE_MS],
  ]);
});

test('targets name the identities the frame helper must look up, from the tree lines', () => {
  const targets = handTargets({ code: 'await app.click(1); await app.scroll(4, "down", 2); await app.setValue(2, "x"); await app.typeText("hi");', lines: TREE });
  assert.deepEqual(targets.identities, {
    1: { role: 'AXButton', id: 'saveButton', description: 'Save', title: undefined },
    4: { role: 'AXRow', id: undefined, description: undefined, title: 'Item one' },
    2: { role: 'AXTextField', id: 'nameField', description: undefined, title: undefined },
  });
  assert.equal(targets.focus, false, 'typing after an element action types where that action was');
  assert.equal(handTargets({ code: 'await app.pressKey("super+s")', lines: TREE }).focus, true);
  assert.deepEqual(handIdentity('button (disabled) Apply'), { role: 'AXButton', id: undefined, description: undefined, title: 'Apply' });
  assert.equal(handIdentity('text field (settable) Value: x'), undefined, 'a value is no identity');
});

test('keys, typing and paste go to the focused element, or the point the call last clicked', () => {
  const focused = { frame: { X: 300, Y: 400, Width: 200, Height: 24 }, window: false, inWindow: true };
  const { frames } = planHandFrames(base('await app.pressKey("super+a"); await app.typeText("hello"); await app.paste("x");', { focused }));
  assert.deepEqual(frames.map(f => [f.kind, f.at, f.delayMs, f.beats]), [
    ['key', [400, 412], 0, 1], ['type', [400, 412], WRITE_MS, 5], ['type', [400, 412], 2 * WRITE_MS, 1],
  ]);
  const after = planHandFrames(base('await app.click([400, 196]); await app.typeText("a much longer text than eight");', { focused }));
  assert.deepEqual(after.frames.map(f => [f.kind, f.at, f.beats]), [['click', [300, 298], 1], ['type', [300, 298], 8]]);
  const set = planHandFrames(base('await app.setValue(2, "x")'));
  assert.deepEqual(set.frames.map(f => [f.kind, f.at, f.delayMs]), [['type', [400, 412], GUARD_READ_MS]]);
});

test('no hand for keys when the window itself has focus, focus is elsewhere, or nothing has it', () => {
  for (const [focused, reason] of [[{ window: true }, 'window-focused'], [{ frame: ELEMENTS[2], window: false, inWindow: false }, 'focus-elsewhere'],
    [undefined, 'no-focus']]) {
    const { frames, skipped } = planHandFrames(base('await app.pressKey("Return")', { focused }));
    assert.deepEqual(frames, []);
    assert.deepEqual(skipped, [{ action: 0, method: 'pressKey', reason }]);
  }
});

test('a covered point, an offscreen point and a window state skip with the reason', () => {
  const cover = { id: 9, pid: 999, layer: 0, owner: 'Other', bounds: { X: 250, Y: 250, Width: 100, Height: 100 } };
  const covered = planHandFrames(base('await app.click([400, 196]); await app.click([20, 20]);', { windows: [cover, ...WINDOWS] }));
  assert.deepEqual(covered.frames.map(f => f.at), [[110, 210]]);
  assert.deepEqual(covered.skipped, [{ action: 0, method: 'click', reason: 'covered' }]);
  // A floating panel of any layer covers too, as drag.js's exposedEndpoints counts it; the hand's own pid doesn't.
  const panel = { id: 10, pid: 444, layer: 3, owner: 'sleight', bounds: BOUNDS };
  assert.deepEqual(planHandFrames(base('await app.click([400, 196])', { windows: [panel, ...WINDOWS] })).skipped[0].reason, 'covered');
  assert.equal(planHandFrames(base('await app.click([400, 196])', { windows: [panel, ...WINDOWS], ignorePids: [444] })).frames.length, 1);
  // The engine's own overlay never counts as cover, as in drag.js.
  const overlay = { id: 11, pid: 555, layer: 0, owner: 'Codex Computer Use', bounds: BOUNDS };
  assert.equal(planHandFrames(base('await app.click([400, 196])', { windows: [overlay, ...WINDOWS] })).frames.length, 1);
  // Half the window hangs off the right edge of the only display.
  const off = { ...WINDOW, bounds: { ...BOUNDS, X: 1300 } };
  const offscreen = planHandFrames(base('await app.click([100, 100]); await app.click([1000, 100]);',
    { window: off, windows: [{ ...WINDOWS[1], bounds: off.bounds }] }));
  assert.deepEqual(offscreen.frames.map(f => f.at), [[1350, 250]]);
  assert.deepEqual(offscreen.skipped, [{ action: 1, method: 'click', reason: 'offscreen' }]);
  for (const state of ['minimized', 'hidden', 'other-space', 'side-stage']) {
    const { frames, skipped } = planHandFrames(base('await app.click(1); await app.pressKey("a")', { state, windows: [] }));
    assert.deepEqual(frames, []);
    assert.deepEqual(skipped.map(s => s.reason), [state, state]);
  }
});

test('unresolved targets, a missing scale or geometry, and repeated code skip with the reason', () => {
  const r = code => planHandFrames(base(code)).skipped.map(s => s.reason);
  assert.deepEqual(r('await app.click(n)'), ['unresolved']);
  assert.deepEqual(r('await app.click(3)'), ['ambiguous'], 'two lines named "button Cancel"');
  assert.deepEqual(r('await app.click(9)'), ['unresolved'], 'no line 9 in the read');
  assert.deepEqual(r('await app.click({ label: "Cancel" })'), ['ambiguous']);
  assert.deepEqual(planHandFrames(base('await app.click(1)', { elements: {} })).skipped.map(s => s.reason), ['element-not-found']);
  assert.deepEqual(planHandFrames(base('await app.click([1, 1])', { screenshotSize: [800, 800] })).skipped.map(s => s.reason), ['scale']);
  assert.deepEqual(planHandFrames(base('await app.click([1, 1])', { screenshotSize: undefined })).skipped.map(s => s.reason), ['scale']);
  assert.deepEqual(planHandFrames(base('await app.click([1, 1])', { window: undefined })).skipped.map(s => s.reason), ['no-geometry']);
  assert.deepEqual(planHandFrames(base('for (const n of [1, 2]) await app.click(n)')).skipped, [{ reason: 'loop' }]);
  assert.deepEqual(planHandFrames(base('await a.click([1, 1]); await b.click([2, 2]);')).skipped, [{ reason: 'several-handles' }]);
  assert.deepEqual(planHandFrames(base('let h = await cua.getApp("Other"); await h.click([1, 1])', { target: { app: 'Editor' } })).skipped, [{ reason: 'acquisition' }]);
  assert.equal(planHandFrames(base('let app = await cua.getApp("Editor"); await app.click([1, 1])', { target: { app: 'Editor' } })).frames.length, 1);
  // Strings and comments that look like actions are not actions.
  assert.deepEqual(planHandFrames(base('await app.typeText("x.click([1,1])"); // app.click([2, 2])', { focused: { window: true } })).skipped.map(s => s.method), ['typeText']);
  // Reads alone plan nothing.
  assert.deepEqual(planHandFrames(base('await app.getAXState()')), { frames: [], skipped: [], actions: [] });
  // Each frame names the action it shows, for approval beats.
  assert.deepEqual(planHandFrames(base('await app.click([1, 1]); await app.click(n); await app.click([2, 2]);')).actions, [0, 2]);
});


test('bound actions use the guard decision instead of paying another read in the schedule', () => {
  const source = { code: 'await app.click(1); await app.click(1); await app.click(1)',
    lines: { 1: 'button Save' }, target: { app: 'Editor' },
    window: { pid: 1, windowId: 2, bounds: { X: 0, Y: 0, Width: 500, Height: 500 } },
    elements: { 1: { X: 10, Y: 10, Width: 20, Height: 20 } },
    windows: [{ pid: 1, id: 2, bounds: { X: 0, Y: 0, Width: 500, Height: 500 } }],
    bindings: [{ index: 0, bound: false }, { index: 1, bound: true }, { index: 2, bound: true }] };
  const plan = planHandFrames(source);
  assert.deepEqual(plan.frames.map(f => f.delayMs), [470, 542, 614]);
});
