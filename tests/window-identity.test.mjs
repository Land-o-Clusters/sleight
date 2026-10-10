import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWindowIdentity } from '../plugins/sleight/lib/window-identity.mjs';
// Header shape from the published TextEdit tree; native fields model AX observations.
const target = { appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'Untitled', url: null };
const observed = { status: 'ok', appId: target.appId, title: target.title, url: null,
  epoch: 'helper-a', window: 1, pid: 123, processStart: 1000, matches: 1 };
test('an unsaved window needs one native match and retains its AX reference identity', () => {
  assert.deepEqual(verifyWindowIdentity(target, observed), observed);
  for (const reply of [{ ...observed, matches: 2 }, { ...observed, matches: 0 },
    { status: 'unknown' }, { ...observed, title: 'Other' }, { ...observed, appId: 'another.app' }]) {
    assert.throws(() => verifyWindowIdentity(target, reply), /Input lease:/);
  }
});
test('same-title replacement, app restart or helper replacement cannot reuse a lease identity', () => {
  const leased = { ...target, nativeIdentity: observed };
  for (const key of ['epoch', 'window', 'pid', 'processStart']) {
    const changed = typeof observed[key] === 'number' ? observed[key] + 1 : 'changed';
    assert.throws(() => verifyWindowIdentity(leased, { ...observed, [key]: changed }), /changed/);
  }
  assert.deepEqual(verifyWindowIdentity(leased, observed), observed);
});
