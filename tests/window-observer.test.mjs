import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { startWindowObserver } from '../bench/window-observer.mjs';
import { requestNativeWindow, nativeWindowMatches, sameNativeWindow, treeFreeAction } from '../bench/window-observer-client.mjs';

const expected = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
const snapshot = { status: 'ok', epoch: 'one', pid: 12, processStart: 100, window: 3,
  appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'a.txt', document: 'file:///tmp/a.txt',
  overlay: false, matchingWindows: 1 };
test('native eligibility requires a complete unique window and exact document identity', () => {
  assert.equal(nativeWindowMatches(snapshot, expected, 'com.apple.TextEdit'), true);
  for (const patch of [{ status: 'unknown' }, { title: 'other' }, { document: null }, { overlay: true },
    { matchingWindows: 2 }, { epoch: '' }, { pid: 0 }, { processStart: null }, { window: null }, { appId: 'other' }]) {
    assert.equal(nativeWindowMatches({ ...snapshot, ...patch }, expected, 'com.apple.TextEdit'), false);
  }
  for (const key of Object.keys(snapshot)) assert.equal(nativeWindowMatches({ ...snapshot, [key]: undefined }, expected, 'com.apple.TextEdit'), false, key);
  for (const patch of [{ epoch: 'two' }, { window: 4 }, { pid: 13 }, { processStart: 200 }, { title: 'b.txt' }, { overlay: true }]) {
    assert.equal(sameNativeWindow(snapshot, { ...snapshot, ...patch }), false);
  }
});
test('only text, keys, paste and valid coordinate actions may skip the selector tree', () => {
  for (const [method, args] of [['typeText', ['x']], ['pressKey', ['super+s']], ['paste', ['x']],
    ['click', [[1, 2]]], ['scroll', [[1, 2], 'down']], ['drag', [[1, 2], [3, 4]]]]) assert.equal(treeFreeAction(method, args), true);
  for (const [method, args] of [['click', [1]], ['click', [{ id: 'x' }]], ['click', [{ label: 'x' }]],
    ['click', [{ line: 'button x' }]], ['scroll', [1, 'down']], ['setValue', [1, 'x']], ['selectText', [1, 'x']],
    ['performSecondaryAction', [1, 'Raise']], ['click', [[1, NaN]]], ['drag', [[1, 2], 3]], ['typeText', [3]]]) assert.equal(treeFreeAction(method, args), false);
});
function fakeHelper(delay = 0) {
  return () => spawn(process.execPath, ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline';
    const lines = createInterface({input: process.stdin});
    lines.on('line', line => { const request = JSON.parse(line);
      setTimeout(() => console.log(JSON.stringify({...${JSON.stringify(snapshot)}, id: request.id})), ${delay}); });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
}
test('socket bridge authorizes its token, correlates replies and collects its child and private socket', async () => {
  const observer = await startWindowObserver({ spawnHelper: fakeHelper(), timeoutMs: 1000 });
  try {
    assert.equal((await requestNativeWindow({ ...observer.endpoint, appId: 'com.apple.TextEdit' })).window, 3);
    assert.notEqual((await requestNativeWindow({ ...observer.endpoint, appId: 'com.apple.TextEdit', token: 'wrong' })).status, 'ok');
  } finally { await observer.close(); }
  assert.equal(existsSync(observer.endpoint.path), false);
  assert.notEqual((await requestNativeWindow({ ...observer.endpoint, appId: 'com.apple.TextEdit' })).status, 'ok');
});
test('a starved helper cannot authorize a late reply or a queued request after its deadline', async () => {
  const observer = await startWindowObserver({ spawnHelper: fakeHelper(150), timeoutMs: 60 });
  try {
    assert.notEqual((await requestNativeWindow({ ...observer.endpoint, appId: 'com.apple.TextEdit' })).status, 'ok');
    assert.notEqual((await requestNativeWindow({ ...observer.endpoint, appId: 'com.apple.TextEdit' })).status, 'ok');
  } finally { await observer.close(); }
});
