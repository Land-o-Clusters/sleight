import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareWindowPair } from '../bench/drag-window-fixture.mjs';

test('two-window fixture waits after every placement before reading geometry', async () => {
  const calls = [];
  const selections = await prepareWindowPair(['a', 'b'], {
    cancelled: () => false,
    open: path => calls.push(`open:${path}`), wait: ms => calls.push(`wait:${ms}`),
    place: (path, size) => { calls.push(`place:${path}:${size}`); return true; },
    select: path => { calls.push(`select:${path}`); return { ok: true, windowId: path === 'a' ? 11 : 22, from: [20, 40], to: [120, 40] }; },
  });
  assert.deepEqual(calls, ['open:a', 'wait:800', 'place:a:source', 'wait:1200', 'open:b', 'wait:800', 'place:b:other', 'wait:1200', 'select:a', 'select:b']);
  assert.deepEqual(selections.map(s => s.windowId), [11, 22]);
});
test('cancelled placement cannot open the second window or read coordinates', async () => {
  let cancelled = false; const calls = [];
  await assert.rejects(prepareWindowPair(['a', 'b'], {
    cancelled: () => cancelled, open: path => calls.push(path), wait: () => {},
    place: () => { cancelled = true; return true; }, select: () => { throw new Error('unexpected read'); },
  }), /interrupted/);
  assert.deepEqual(calls, ['a']);
});
