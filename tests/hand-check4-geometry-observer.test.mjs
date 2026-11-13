import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../bench/hand/check4-server.mjs';

test('private geometry observations preserve helper results and report the exact host exclusion without content', async () => {
  assert.equal(typeof server.check4HealthObserver, 'function');
  const geometry = { ok: true, pid: 42, window: { pid: 42, windowId: 7, bounds: { X: 100, Y: 50, Width: 300, Height: 400 } },
    elements: { 2: { X: 110, Y: 60, Width: 30, Height: 20 } }, focused: { inWindow: true, frame: { X: 110, Y: 60, Width: 30, Height: 20 } },
    windows: [{ id: 9, pid: 99, layer: 0, owner: 'private title', bounds: { X: 0, Y: 0, Width: 220, Height: 122 } }],
    state: undefined, privateText: 'document text' };
  const requests = [], rows = [], request = { pid: 42, windowNumber: 7, identities: { 2: { title: 'secret label' } } };
  const helper = { handLocate: async input => { requests.push(input); return geometry; }, close: () => 7 };
  const wrapped = server.check4HealthObserver(helper, { hostPid: () => 99, write: row => rows.push(row), now: () => 123 });
  assert.equal(await wrapped.handLocate(request), geometry);
  assert.equal(requests[0], request);
  assert.equal(wrapped.close(), 7);
  assert.equal(rows[0].hostPid, 99);
  assert.deepEqual(rows[0].geometry.window, geometry.window);
  assert.deepEqual(rows[0].geometry.elements, geometry.elements);
  assert.deepEqual(rows[0].geometry.windows[0], { id: 9, pid: 99, layer: 0, bounds: geometry.windows[0].bounds, engineOverlay: false });
  assert.doesNotMatch(JSON.stringify(rows), /document text|secret label|private title/);
  assert.equal(await server.check4HealthObserver(helper, { hostPid: () => 99, write: () => { throw Error('disk full'); } }).handLocate(request), geometry);
});
