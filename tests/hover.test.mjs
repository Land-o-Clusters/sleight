import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { execFile, spawnSync } from 'node:child_process';
import { callLocalTool, HOVER_TOOL, runScript } from '../plugins/sleight/lib/launch.mjs';

// Run the same controller osascript runs, without sending native input.
function controller() {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/hover.js', import.meta.url), 'utf8'), context);
  return context;
}
test('native hover accepts a screenshot response larger than the default stdout buffer', async () => {
  const run = (_command, _args, options, callback) => execFile(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({ok:true,image:"a".repeat(2*1024*1024),takeoverMs:1800}))'], options, callback);
  const result = await runScript('hover.js', { app: 'Chess', at: [62, 16] }, run);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.image.length, 2 * 1024 * 1024);
  assert.equal(result.takeoverMs, 1800);
});
test('native hover keeps a bounded screenshot response and collects an oversized child', async () => {
  let child;
  const run = (_command, _args, options, callback) => child = execFile(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({ok:true,image:"a".repeat(17*1024*1024)}))'], options, callback);
  const result = await runScript('hover.js', { app: 'Chess', at: [62, 16] }, run);
  assert.equal(result.ok, false);
  assert.match(result.error, /maxBuffer/);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
function platform(failAt) {
  const events = []; let time = 0;
  const p = { now: () => time, screenCaptureAllowed: () => failAt !== 'permission', resolve: () => ({ pid: 123 }),
    point: (_target, at) => ({ x: at[0] + 100, y: at[1] + 200 }),
    visible: () => { events.push('visible'); return failAt !== 'covered'; },
    save: () => { events.push('save'); return {}; },
    activate: () => { events.push('activate'); if (failAt === 'activate') throw Error('activate failed'); },
    wait: ms => { events.push(`wait ${ms}`); time += ms; },
    move: () => { events.push('move'); if (failAt === 'move') throw Error('move failed'); },
    capture: () => { events.push('capture'); time += 50; if (failAt === 'capture') throw Error('capture failed'); return 'PNG'; },
    restorePointer: () => { events.push('restore pointer'); if (failAt === 'restore') throw Error('restore failed'); },
    restoreFront: () => { events.push('restore front'); },
  };
  return { p, events };
}
test('hover captures during the dwell, restores both resources and reports takeover time', () => {
  const { p, events } = platform();
  const result = controller().performHover({ app: 'TextEdit', at: [10, 20], waitMs: 1500 }, p);
  assert.equal(result.ok, true);
  assert.equal(result.image, 'PNG');
  assert.equal(result.takeoverMs, 1650);
  assert.deepEqual(events, ['visible', 'save', 'activate', 'wait 100', 'visible', 'move', 'wait 1500', 'visible', 'capture', 'restore pointer', 'restore front']);
});
test('covered points refuse before activation or moving the pointer', () => {
  const { p, events } = platform('covered');
  const result = controller().performHover({ app: 'TextEdit', at: [10, 20] }, p);
  assert.equal(result.ok, false);
  assert.match(result.error, /covers/);
  assert.match(result.error, /same app/);
  assert.match(result.error, /do not retry unchanged/i);
  assert.equal(result.takeoverMs, 0);
  assert.deepEqual(events, ['visible']);
});
test('missing Screen Recording permission refuses before any app or pointer work', () => {
  const { p, events } = platform('permission');
  p.resolve = () => { throw Error('must not resolve an app'); };
  const result = controller().performHover({ app: 'TextEdit', at: [10, 20] }, p);
  assert.equal(result.ok, false);
  assert.match(result.error, /Screen Recording permission/);
  assert.equal(result.takeoverMs, 0);
  assert.deepEqual(events, []);
});
test('native permission preflight calls CGPreflightScreenCaptureAccess without requesting access', () => {
  const c = controller(); let allowed = false, calls = 0;
  c.$ = { CGPreflightScreenCaptureAccess: () => { calls++; return allowed; } };
  const native = c.nativeHover();
  assert.equal(native.screenCaptureAllowed(), false);
  allowed = true;
  assert.equal(native.screenCaptureAllowed(), true);
  assert.equal(calls, 2);
});
test('invalid app, point and unbounded dwell fail without native work', () => {
  for (const input of [{}, { app: '', at: [1, 2] }, { app: 'TextEdit', at: [NaN, 2] },
    { app: 'TextEdit', at: [-1, 2] }, { app: 'TextEdit', at: [1] },
    { app: 'TextEdit', at: [1, 2], waitMs: 99999 }, { app: 'TextEdit', at: [1, 2], waitMs: 0 },
    { app: 'TextEdit', at: [1, 2], waitMs: 100.5 }]) {
    const { p, events } = platform();
    assert.equal(controller().performHover(input, p).ok, false);
    assert.deepEqual(events, []);
  }
});
test('activation, input and capture failures still restore pointer and front app', () => {
  for (const failure of ['activate', 'move', 'capture', 'restore']) {
    const { p, events } = platform(failure);
    const result = controller().performHover({ app: 'TextEdit', at: [10, 20] }, p);
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(failure));
    assert.deepEqual(events.slice(-2), ['restore pointer', 'restore front']);
  }
});
test('coverage is checked again after activation and before capture', () => {
  for (const blockedRead of [2, 3]) {
    const { p, events } = platform(); let reads = 0;
    p.visible = () => ++reads !== blockedRead;
    assert.equal(controller().performHover({ app: 'TextEdit', at: [1, 2] }, p).ok, false);
    assert.equal(events.includes('capture'), false);
    assert.equal(events.includes('move'), blockedRead === 3);
    assert.deepEqual(events.slice(-2), ['restore pointer', 'restore front']);
  }
});

test('local hover denial has no effect, and success returns screenshot plus duration', async () => {
  let effects = 0;
  const execute = async () => { effects++; return { ok: true, image: 'PNG', takeoverMs: 1800, waitMs: 1500 }; };
  const refused = await callLocalTool('hover', { app: 'TextEdit', at: [1, 2] }, async () => false, execute);
  assert.equal(refused.isError, true); assert.equal(effects, 0);
  const allowed = await callLocalTool('hover', { app: 'TextEdit', at: [1, 2] }, async (key, message) => {
    assert.deepEqual(key, ['hover', 'TextEdit']); assert.match(message, /moves your pointer/); return true;
  }, execute);
  assert.equal(effects, 1);
  assert.equal(JSON.parse(allowed.content[0].text).takeoverMs, 1800);
  assert.deepEqual(allowed.content[1], { type: 'image', data: 'PNG', mimeType: 'image/png' });
  const failed = await callLocalTool('hover', { app: 'TextEdit' }, async () => true,
    async () => ({ ok: false, takeoverMs: 200, error: 'capture failed' }));
  assert.equal(failed.isError, true);
  assert.equal(JSON.parse(failed.content[0].text).takeoverMs, 200);
  assert.equal(HOVER_TOOL.inputSchema.properties.waitMs.maximum, 4000);
});
test('benchmark approval admits hover only for its three apps and expected servers', () => {
  const hook = new URL('../bench/approve.mjs', import.meta.url);
  for (const app of ['Calculator', 'TextEdit', 'Chess', 'Mail', 'DragProbe']) {
    for (const server of ['plugin:sleight:computer', 'other']) {
      const child = spawnSync(process.execPath, [hook.pathname], { encoding: 'utf8',
        input: JSON.stringify({ mcp_server_name: server, message: `Allow Claude to hover in ${app}? It moves your pointer briefly.` }) });
      assert.equal(child.status, 0);
      assert.equal(Boolean(child.stdout), server === 'plugin:sleight:computer' && ['Calculator', 'TextEdit', 'Chess'].includes(app));
    }
  }
});

function windowPlatform(windows, allWindows = windows) {
  const c = controller();
  const collection = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const app = { localizedName: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit', processIdentifier: 123,
    bundleURL: { isNil: () => false, path: '/System/Applications/TextEdit.app' } };
  const win = ({ pid = 123, layer = 0, title, id, bounds }) => ({ objectForKey: key => ({ kCGWindowOwnerPID: pid, kCGWindowOwnerName: 'TextEdit', kCGWindowName: title, kCGWindowNumber: id, kCGWindowLayer: layer, kCGWindowBounds: bounds })[key] });
  c.ObjC.unwrap = c.ObjC.deepUnwrap = c.ObjC.castRefToObject = value => value;
  c.$ = { NSWorkspace: { sharedWorkspace: { runningApplications: collection([app]) } },
    CGPreflightScreenCaptureAccess: () => true,
    kCGWindowListOptionOnScreenOnly: 1, kCGWindowListOptionAll: 0, kCGWindowListExcludeDesktopElements: 16,
    CGWindowListCopyWindowInfo: options => collection(((options & 1) ? windows : allWindows).map(win)) };
  return { c, app, collection, native: c.nativeHover() };
}
test('native hover resolves one app and refuses points outside its only normal window', () => {
  const { c, app, collection, native } = windowPlatform([
    { id: 1, layer: 1, bounds: { X: 0, Y: 0, Width: 999, Height: 999 } },
    { id: 2, title: 'a.txt', bounds: { X: 100, Y: 200, Width: 400, Height: 300 } },
  ]);
  for (const name of ['TextEdit', 'com.apple.TextEdit', '/System/Applications/TextEdit.app']) {
    const target = native.resolve(name);
    assert.equal(target.pid, 123);
    const point = native.point(target, [10, 20]);
    assert.equal(point.x, 110); assert.equal(point.y, 220);
    assert.throws(() => native.point(target, [400, 20]), /outside/);
  }
  assert.throws(() => native.resolve('Chess'), /exactly one/);
  c.$.NSWorkspace.sharedWorkspace.runningApplications = collection([app, app]);
  assert.throws(() => native.resolve('TextEdit'), /exactly one/);
});

test('two windows require an exact unique title before saving or moving the pointer', () => {
  const windows = [
    { id: 1, title: 'small.txt', bounds: { X: 10, Y: 20, Width: 50, Height: 50 } },
    { id: 2, title: 'large.txt', bounds: { X: 100, Y: 200, Width: 400, Height: 300 } },
  ];
  const { c, native } = windowPlatform(windows);
  const events = [];
  native.save = () => events.push('save');
  native.activate = () => events.push('activate');
  native.move = () => events.push('move');
  for (const windowTitle of [undefined, 'missing.txt', 'small']) {
    const result = c.performHover({ app: 'TextEdit', at: [10, 20], windowTitle }, native);
    assert.equal(result.ok, false); assert.equal(result.takeoverMs, 0);
    assert.match(result.error, /window.*title|title.*window/i);
    assert.deepEqual(events, []);
  }
  const target = native.resolve('TextEdit');
  const point = native.point(target, [10, 20], 'small.txt');
  assert.equal(point.x, 20); assert.equal(point.y, 40);
  assert.equal(target.windowTitle, 'small.txt');
  assert.equal(target.windowId, 1);
  const other = native.resolve('TextEdit');
  const otherPoint = native.point(other, [10, 20], 'large.txt');
  assert.equal(otherPoint.x, 110); assert.equal(otherPoint.y, 220);
  assert.equal(other.windowId, 2);
  windows[1].title = 'small.txt';
  assert.throws(() => native.point(native.resolve('TextEdit'), [10, 20], 'small.txt'), /ambiguous|more than one/i);
});

test('hover passes the requested title into native selection and rejects malformed titles', () => {
  const { p } = platform();
  let selected;
  p.point = (_target, _at, title) => { selected = title; return {}; };
  const result = controller().performHover({ app: 'TextEdit', at: [1, 2], windowTitle: 'a.txt' }, p);
  assert.equal(result.ok, true); assert.equal(selected, 'a.txt');
  for (const windowTitle of ['', '  ', 123, null]) {
    const { p, events } = platform();
    assert.equal(controller().performHover({ app: 'TextEdit', at: [1, 2], windowTitle }, p).ok, false);
    assert.deepEqual(events, []);
  }
});

test('native coverage reports the blocker and refuses a different window of the same app', () => {
  const { native } = windowPlatform([
    { id: 1, title: 'cover.txt', bounds: { X: 100, Y: 200, Width: 400, Height: 300 } },
    { id: 2, title: 'target.txt', bounds: { X: 100, Y: 200, Width: 400, Height: 300 } },
  ]);
  const target = native.resolve('TextEdit');
  const point = native.point(target, [10, 20], 'target.txt');
  assert.equal(native.visible(target, point), false);
  assert.equal(target.blocker.id, 1);
  assert.equal(target.blocker.owner, 'TextEdit');
});
test('hover identifies an off-Space window before saving, activating or moving', () => {
  const { c, native } = windowPlatform([], [
    { id: 2, title: 'a.txt', bounds: { X: 100, Y: 200, Width: 400, Height: 300 } },
  ]);
  const effects = [];
  for (const name of ['save', 'activate', 'move']) native[name] = () => effects.push(name);
  const result = c.performHover({ app: 'TextEdit', at: [10, 20] }, native);
  assert.equal(result.ok, false); assert.match(result.error, /another desktop or Space/i);
  assert.match(result.error, /on screen/i); assert.deepEqual(effects, []);
  const empty = windowPlatform([]);
  assert.match(empty.c.performHover({ app: 'TextEdit', at: [10, 20] }, empty.native).error, /has no window/);
});

test('native capture passes an empty NSDictionary and cleans up its temporary image', () => {
  const { c, native } = windowPlatform([]);
  const attributes = {}; const removed = [];
  c.$.NSDictionary = { dictionary: attributes };
  c.$.NSTemporaryDirectory = () => '/private/tmp/';
  c.$.NSUUID = { UUID: { UUIDString: 'test' } };
  c.$.NSFileManager = { defaultManager: {
    createDirectoryAtPathWithIntermediateDirectoriesAttributesError: (_dir, _parents, supplied) => { assert.equal(supplied, attributes); return true; },
    removeItemAtPathError: dir => removed.push(dir),
  } };
  c.$.NSTask = { alloc: { init: { terminationStatus: 0 } } };
  c.$.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false, base64EncodedStringWithOptions: () => 'PNG' }) };
  assert.equal(native.capture({ bounds: { X: 10, Y: 20, Width: 300, Height: 400 } }), 'PNG');
  assert.deepEqual(removed, ['/private/tmp/sleight-hover-test']);
});
