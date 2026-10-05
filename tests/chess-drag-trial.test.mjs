import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackedChessTrial } from '../bench/chess-drag-trial.mjs';

function fixture(failure) {
  const windows = [{ id: 99 }], closed = [], calls = [];
  const state = moved => ({ ok: true, bounds: [100, 100, 600, 600], squares: [
    { title: moved ? 'e2' : 'white pawn, e2', center: [350, 500] },
    { title: moved ? 'white pawn, e4' : 'e4', center: [350, 400] },
  ] });
  let moved = false;
  return { closed, calls, api: {
    snapshot: () => windows.slice(), cancelled: () => false, wait() {}, checkpoint() {},
    open(path) { calls.push(path); windows.push({ id: path === 'a' ? 11 : 22, path }); if (failure === 'open') throw Error('open failed'); },
    place: path => ({ ...state(false), windowId: path === 'a' ? 11 : 22 }),
    drag(request) { assert.equal(request.windowId, 11); assert.deepEqual(request.from, [250, 400]); moved = !failure; return { result: failure ? { isError: true } : {} }; },
    read: path => state(path === 'a' && moved),
    closePath(path) { const index = windows.findIndex(w => w.path === path); if (index < 0) return { ok: true, alreadyClosed: true }; const id = windows[index].id; assert.notEqual(id, 99); closed.push(id); windows.splice(index, 1); return { ok: true }; },
  } };
}
test('a stacked Chess trial checks the named board and closes both games, preserving prior windows', async () => {
  const f = fixture(); const run = await stackedChessTrial(['a', 'b'], f.api);
  assert.equal(run.passed, true); assert.equal(run.closedAllOpenedWindows, true);
  assert.deepEqual(f.closed, [11, 22]);
});
test('a concurrent new Chess game is preserved and persistent cleanup failure has a bounded receipt', async () => {
  const f = fixture(); const open = f.api.open, snapshot = f.api.snapshot;
  f.api.open = path => { open(path); if (path === 'b') snapshot()[0].concurrent = true; };
  f.api.snapshot = () => {
    const result = snapshot();
    return result[0].concurrent ? [...result, { id: 77, path: 'another-session.game' }] : result;
  };
  let attempts = 0;
  f.api.closePath = path => { assert.ok(['a', 'b'].includes(path)); attempts++; throw Error('close refused'); };
  const run = await stackedChessTrial(['a', 'b'], f.api);
  assert.equal(run.closedAllOpenedWindows, false); assert.equal(attempts, 6);
  assert.deepEqual(run.remainingWindows.map(w => w.id), [11, 22]);
});
test('failed opens and refused drags close every game opened before failure', async () => {
  for (const failure of ['open', 'drag']) {
    const f = fixture(failure); const run = await stackedChessTrial(['a', 'b'], f.api);
    assert.equal(run.passed, false); assert.equal(run.closedAllOpenedWindows, true);
    assert.deepEqual(f.closed, failure === 'open' ? [11] : [11, 22]);
  }
});
test('cleanup retries a failed close before the caller can release its live lock', async () => {
  const f = fixture(); const close = f.api.closePath; let refused = false;
  f.api.closePath = path => { if (!refused) { refused = true; throw Error('close refused once'); } return close(path); };
  const run = await stackedChessTrial(['a', 'b'], f.api);
  assert.equal(run.closedAllOpenedWindows, true); assert.deepEqual(f.closed, [22, 11]);
  assert.match(run.cleanup[0].error, /refused/);
});
test('missing CG document mappings cannot falsely confirm cleanup', async () => {
  const f = fixture(); const snapshot = f.api.snapshot;
  f.api.snapshot = () => snapshot().map(({ path, ...window }) => window);
  f.api.closePath = () => ({ ok: false, error: 'owned window remains open' });
  const run = await stackedChessTrial(['a', 'b'], f.api);
  assert.equal(run.closedAllOpenedWindows, false);
  assert.deepEqual(run.remainingPaths, ['a', 'b']);
  assert.equal(run.cleanup.length, 6);
});
