import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDragViaDriver } from '../plugins/sleight/lib/drag-via-driver.mjs';
import { dragScriptFixture } from './fixtures/drag-script.mjs';
import { fakeDragExecutor, driverScriptRunner } from './fixtures/drag-via-driver-exec.mjs';

const source = { windowId: '11', pid: 7, processStart: '7:100', bundleId: 'com.apple.TextEdit',
  title: '11.txt', identityVerified: true };
const request = { app: source.bundleId, from: [26.6, 38.5], to: [150, 38.5], dp2: false };
const run = (fixture, args = request, binding = source) =>
  createDragViaDriver(driverScriptRunner(fixture, { source: binding }))('drag.js', args, { run: fakeDragExecutor(fixture) });
const noInput = fixture => {
  assert.equal(fixture.events.length + fixture.pidEvents.length + fixture.axWrites.length + fixture.textWrites.length, 0);
  assert.equal(fixture.activations.length, 0);
  assert.equal(fixture.mainWrites.length, 0);
};

test('missing windowId refuses before input when drag.js selects a different source', async () => {
  // x=700 fits window 22 only. The retained source is window 11.
  const fixture = dragScriptFixture({ nativeAppResolution: true, background: true, ax: {} });
  const result = await run(fixture, { ...request, from: [700, 38.5] });
  assert.equal(result.ok, false);
  assert.match(result.error, /IDENTITY_CHANGED/);
  noInput(fixture);
});

test('missing windowId still refuses ambiguity before input', async () => {
  const fixture = dragScriptFixture({ nativeAppResolution: true, background: true, ax: {} });
  const result = await run(fixture);
  assert.equal(result.ok, false); assert.match(result.error, /ambiguous/);
  noInput(fixture);
});

test('missing windowId allows the sole matching bound source', async () => {
  const fixture = dragScriptFixture({ nativeAppResolution: true, second: false, background: true, ax: {} });
  const result = await run(fixture);
  assert.equal(result.ok, true); assert.equal(result.windowId, 11);
  assert.ok(fixture.axWrites.length > 0);
});

test('driver and JXA resolving different instances refuse before input', async () => {
  for (const selector of ['com.apple.TextEdit', 'TextEdit', '/Applications/TextEdit.app']) {
    const fixture = dragScriptFixture({ nativeAppResolution: true, second: false, background: true, ax: {} });
    const workspace = fixture.native.NSWorkspace.sharedWorkspace;
    const actual = workspace.runningApplications.objectAtIndex(0);
    const apps = [{ ...actual, processIdentifier: 8 }, actual];
    workspace.runningApplications = { count: apps.length, objectAtIndex: i => apps[i] };
    const windows = fixture.context.windows;
    let inventories = 0;
    fixture.context.windows = (...args) => { inventories++; return windows(...args); };
    const result = await run(fixture, { ...request, app: selector, windowId: 11 });
    assert.equal(result.ok, false); assert.match(result.error, /IDENTITY_CHANGED/);
    assert.equal(inventories, 0, 'the instance mismatch refuses before selecting any window');
    noInput(fixture);
  }
});

function shiftFixture() {
  const fixture = dragScriptFixture({ nativeAppResolution: true, second: false, background: true, ax: {} });
  Object.assign(fixture.native, {
    CGEventCreateKeyboardEvent: (_source, key, down) => ({ key, down }),
    CGEventSetFlags: (event, flags) => { event.flags = flags; },
    CGEventSetType: (event, type) => { event.type = type; },
    kCGEventFlagMaskShift: 0x20000, kCGEventFlagsChanged: 12,
  });
  return fixture;
}

for (const step of ['create', 'flags', 'type', 'post', 'delay']) {
  for (const down of [true, false]) test(`runtime Shift releases after a throw at ${step}, down=${down}`, async () => {
    const fixture = shiftFixture();
    const names = { create: 'CGEventCreateKeyboardEvent', flags: 'CGEventSetFlags', type: 'CGEventSetType', post: 'CGEventPostToPid' };
    let thrown = false, currentDown;
    const create = fixture.native.CGEventCreateKeyboardEvent;
    fixture.native.CGEventCreateKeyboardEvent = (...args) => { currentDown = args[2]; return create(...args); };
    const owner = step === 'delay' ? fixture.context : fixture.native, key = names[step] ?? 'delay';
    const original = owner[key];
    owner[key] = (...args) => {
      const direction = step === 'create' ? args[2] : currentDown;
      if (!thrown && direction === down) { thrown = true; throw new Error(`injected ${step}`); }
      return original(...args);
    };
    const wrapped = createDragViaDriver(driverScriptRunner(fixture, { source }));
    await wrapped('drag.js', { ...request, windowId: 11 }, { run: fakeDragExecutor(fixture) });
    // DS1 recovers a transient release failure and still propagates a down error.
    thrown = false; fixture.pidEvents.length = 0;
    if (down) assert.throws(() => fixture.context.settleAfterTextWrite(7), new RegExp(`injected ${step}`));
    else assert.doesNotThrow(() => fixture.context.settleAfterTextWrite(7));
    assert.equal(thrown, true);
    assert.equal(fixture.pidEvents.at(-1)?.down, false, 'last delivered event releases Shift');
    assert.equal(fixture.pidEvents.at(-1)?.flags, 0);
    assert.equal(fixture.pidEvents.at(-1)?.type, 12);
  });
}

test('Shift-up delivery errors get one release retry and never replay the text move', async () => {
  const fixture = shiftFixture(), posts = [];
  const post = fixture.native.CGEventPostToPid;
  fixture.native.CGEventPostToPid = (pid, event) => {
    posts.push(event.down);
    if (!event.down) throw new Error('release unavailable');
    post(pid, event);
  };
  const area = fixture.context.axTextArea;
  fixture.context.axTextArea = (...args) => ({ ...area(...args), settle: () => fixture.context.settleAfterTextWrite(7) });
  const result = await run(fixture, { ...request, windowId: 11 });
  assert.equal(result.ok, false);
  assert.equal(result.deliveryVerified, false);
  assert.match(result.error, /Shift release failed twice for pid 7/);
  assert.match(result.error, /Shift may still be held/);
  assert.match(result.error, /Text may already have moved/);
  assert.equal(result.path, 'accessibility');
  assert.deepEqual(posts, [true, false, false]);
  assert.equal(fixture.axWrites.length, 2, 'one insertion and one cut');
  assert.equal(fixture.values.get(11), 'beta gamma alpha\n');
  assert.equal(fixture.events.length + fixture.activations.length, 0);
});

test('an unguarded engine settle releases Shift after an interrupted down post', async () => {
  const fixture = shiftFixture(), post = fixture.native.CGEventPostToPid;
  fixture.native.CGEventPostToPid = (pid, event) => {
    post(pid, event);
    if (event.down) throw new Error('engine down post interrupted');
  };
  assert.throws(() => fixture.context.settleAfterTextWrite(7), /engine down post interrupted/);
  // DS1 releases in finally even when Shift-down throws after delivery.
  assert.deepEqual(fixture.pidEvents.map(event => event.down), [true, false]);
});

test('runtime adapter reports a persistent release failure after an interrupted down post', async () => {
  const fixture = shiftFixture(), posts = [];
  const post = fixture.native.CGEventPostToPid;
  fixture.native.CGEventPostToPid = (pid, event) => {
    posts.push([pid, event.down]);
    if (!event.down) throw new Error('release unavailable');
    post(pid, event);
    throw new Error('down interrupted after delivery');
  };
  const area = fixture.context.axTextArea;
  fixture.context.axTextArea = (...args) => ({ ...area(...args), settle: () => fixture.context.settleAfterTextWrite(7) });
  const result = await run(fixture, { ...request, windowId: 11 });
  assert.equal(result.ok, false);
  assert.equal(result.deliveryVerified, false);
  assert.match(result.error, /Shift release failed twice for pid 7/);
  assert.match(result.error, /release unavailable/);
  assert.doesNotMatch(result.error, /down interrupted/);
  assert.deepEqual(posts, [[7, true], [7, false], [7, false]]);
  assert.equal(fixture.axWrites.length, 2);
  assert.equal(fixture.values.get(11), 'beta gamma alpha\n');
  assert.equal(fixture.events.length + fixture.activations.length, 0);
});

test('runtime settle refuses a different pid before creating a Shift event', async () => {
  const fixture = shiftFixture();
  await run(fixture, { ...request, windowId: 11 });
  fixture.pidEvents.length = 0;
  let creates = 0;
  fixture.native.CGEventCreateKeyboardEvent = () => { creates++; return null; };
  assert.throws(() => fixture.context.settleAfterTextWrite(8), /IDENTITY_CHANGED/);
  assert.equal(creates, 0);
  assert.equal(fixture.pidEvents.length, 0);
});

test('runtime settle retains DS1 null-event checks and persistent failure marker', async () => {
  const fixture = shiftFixture();
  await run(fixture, { ...request, windowId: 11 });
  fixture.pidEvents.length = 0;
  let creates = 0;
  fixture.native.CGEventCreateKeyboardEvent = () => { creates++; return null; };
  assert.throws(() => fixture.context.settleAfterTextWrite(7), error => {
    assert.equal(error.modifierReleaseFailed, true);
    assert.match(error.message, /could not create the Shift event/);
    return true;
  });
  assert.equal(creates, 3, 'one down attempt and two release attempts');
  assert.equal(fixture.pidEvents.length, 0);
});

test('a plain revocation after delivery is USER_STOPPED with unknown delivery', async () => {
  const fixture = dragScriptFixture({ nativeAppResolution: true, second: false, background: true, ax: {} });
  const options = driverScriptRunner(fixture, { source }, () => {
    if (fixture.axWrites.length) throw new Error('app lease revoked');
  });
  const result = await createDragViaDriver(options)('drag.js', { ...request, windowId: 11 }, { run: fakeDragExecutor(fixture) });
  assert.equal(result.ok, false); assert.equal(result.code, 'USER_STOPPED');
  assert.match(result.error, /USER_STOPPED/); assert.doesNotMatch(result.error, /DRIVER_PROTOCOL/);
  assert.equal(result.delivery, 'unknown'); assert.equal(result.retry, 'read-first');
});
