import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHoverRedactor } from '../bench/hover-publication.mjs';

function fixture(duplicate = false) {
  const raised = [];
  const bounds = { X: 100, Y: 200, Width: 600, Height: 400 };
  const square = (name, y) => ({ description: () => name, position: () => [200, y], size: () => [50, 50], uiElements: () => [] });
  const win = { name: () => 'benchmark-game', position: () => [100, 200], size: () => [600, 400],
    uiElements: () => [square('white pawn, e2', 300), square('e4', 400)],
    actions: { byName: name => ({ perform: () => raised.push(name) }) }, attributes: { byName: name => ({ set value(x) { raised.push([name,x]); } }) } };
  const auxiliary = { ...win, name: () => '', position: () => [100, 232], size: () => [600, 368], uiElements: () => [] };
  const windows = [win, auxiliary, ...(duplicate ? [win] : [])];
  const native = [
    { kCGWindowOwnerPID: 7, kCGWindowLayer: 0, kCGWindowNumber: 11, kCGWindowName: 'benchmark-game', kCGWindowBounds: bounds },
    { kCGWindowOwnerPID: 7, kCGWindowLayer: 0, kCGWindowNumber: 12, kCGWindowName: '', kCGWindowBounds: { ...bounds, Y: 232, Height: 368 } },
  ];
  const context = vm.createContext({
    ObjC: { import() {}, deepUnwrap: x => x, castRefToObject: x => x },
    $: { NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: '1', objectAtIndex: () => ({ processIdentifier: '7' }) }) },
      CGWindowListCopyWindowInfo: () => native },
    Application: () => ({ processes: { whose: () => [{ windows: () => windows }] } }),
  });
  vm.runInContext(readFileSync('bench/drag-chess-fixture.js', 'utf8'), context);
  const run = request => JSON.parse(context.run([JSON.stringify(request)]));
  run.raised = raised; return run;
}
test('Chess fixture accepts boxed process metadata and excludes the auxiliary renderer', () => {
  const run = fixture();
  assert.deepEqual(run({ op: 'windows' }).map(w => w.id), [11]);
  const game = run({ op: 'geometry', windowId: 11 });
  assert.equal(createHoverRedactor()(game).title, '<chess-window-title>');
  assert.deepEqual(game.squares.map(s => s.point), [[125, 125], [125, 225]]);
  assert.throws(() => run({ op: 'geometry', windowId: 12 }), /missing/);
});
test('cleanup raising selects only the recorded AX game', () => {
  const run = fixture();
  assert.equal(run({ op: 'raise', windowId: 11 }).windowId, 11);
  assert.deepEqual(run.raised, [['AXMain',true],'AXRaise']);
  assert.throws(() => run({ op: 'raise', windowId: 12 }), /missing/);
});
test('coincident Chess windows cannot silently redirect fixture readback', () => {
  assert.throws(() => fixture(true)({ op: 'geometry', windowId: 11 }), /ambiguous/);
});
