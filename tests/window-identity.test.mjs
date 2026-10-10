import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
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
const source = readFileSync(new URL('../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
function inspect(request, numbers, focused = 1, cg = false) {
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const windows = numbers.map((AXWindowNumber, i) => ({ AXTitle: 'Untitled', AXDocument: null, AXWindowNumber,
    AXPosition: { x: i * 400, y: 20 }, AXSize: { width: 300, height: 200 } }));
  const app = { AXWindows: list(windows), AXFocusedWindow: windows[focused] };
  const $ = value => value;
  Object.assign($, { NSUUID: { UUID: { UUIDString: 'epoch' } }, AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list([{ processIdentifier: 123, launchDate: { timeIntervalSince1970: 1 } }]) },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, name, value) => { value[0] = element[name] ?? null; return 0; },
    CFEqual: (a, b) => a === b, AXValueGetValue: (value, _type, ref) => { ref[0] = value; return !!value; },
    CGWindowListCopyWindowInfo: () => list(cg ? windows.map((window, i) => ({ kCGWindowOwnerPID: 123, kCGWindowLayer: 0,
      kCGWindowNumber: 11 + i, kCGWindowBounds: { X: window.AXPosition.x, Y: 20, Width: 300, Height: 200 } })) : []) });
  return JSON.parse(runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, request, Ref: () => [],
    ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value } }));
}
test('native duplicate-title identity uses the focused window number or an explicit selection', () => {
  const current = inspect(target, [11, 22]);
  assert.equal(current.matches, 1); assert.equal(current.windowNumber, 22);
  assert.equal(inspect({ ...target, windowNumber: 22 }, [11, 22]).windowNumber, 22);
  assert.notEqual(inspect({ ...target, windowNumber: 11 }, [11, 22]).status, 'ok');
  assert.notEqual(inspect(target, [null, null]).matches, 1, 'missing numbers remain inconclusive');
});
test('native identity maps AX geometry to CG numbers and detects a known number disappearing', () => {
  const selected = inspect({ ...target, windowNumber: 12 }, [null, null], 1, true);
  assert.equal(selected.matches, 1); assert.equal(selected.windowNumber, 12);
  assert.equal(inspect({ ...target, nativeIdentity: { windowNumber: 99 } }, [11, 22]).status, 'mismatch');
  assert.notEqual(inspect({ ...target, nativeIdentity: { windowNumber: 99 } }, [null, null]).status, 'mismatch');
});
