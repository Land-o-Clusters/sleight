import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// locate.js in a vm, over a fake AX tree: an element is { AXRole, AXTitle, AXPosition, AXSize, AXChildren }.
function locateContext(now = Date.now) {
  const pair = v => ({ pointValue: { x: v[0], y: v[1] }, sizeValue: { width: v[0], height: v[1] } });
  const $ = name => name;
  Object.assign($, {
    AXUIElementCopyAttributeValue: (el, name, out) => {
      const value = el[name];
      if (value === undefined) return -25205;
      out[0] = Array.isArray(value) && name === 'AXChildren' ? { count: value.length, objectAtIndex: i => value[i] } : value;
      return 0;
    },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { mutableBytes: bytes, bytes }; } },
    AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return true; },
    NSValue: { valueWithBytesObjCType: bytes => pair(bytes.value) },
  });
  const context = vm.createContext({ Date: { now }, ObjC: { import() {}, castRefToObject: x => x, deepUnwrap: x => x, unwrap: x => x }, $, Ref: () => [] });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/hand/locate.js', import.meta.url), 'utf8'), context);
  return context;
}
const button = (title, x) => ({ AXRole: 'AXButton', AXTitle: title, AXPosition: [x, 10], AXSize: [20, 20] });

test('locate.js reports an element only when a whole walk found exactly one', () => {
  const { elements } = locateContext();
  const win = { AXRole: 'AXWindow', AXChildren: [button('Save', 100), button('Other', 200), button('Cancel', 300), button('Cancel', 400)] };
  const identities = { 1: { role: 'AXButton', title: 'Save' }, 2: { role: 'AXButton', title: 'Cancel' } };
  assert.deepEqual(JSON.parse(JSON.stringify(elements(win, identities))), { 1: { X: 100, Y: 10, Width: 20, Height: 20 } });
  // With room for the window and three buttons, the second Cancel is never seen: Cancel looks unique and Save
  // was found, but a cut-short walk proves neither.
  assert.deepEqual(JSON.parse(JSON.stringify(elements(win, identities, 4))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(elements(win, identities, 5))), { 1: { X: 100, Y: 10, Width: 20, Height: 20 } });
});

test('locate.js finds turbo\'s browser window by the bounds its page reports, or says it is on another Space', () => {
  const context = locateContext();
  const { $ } = context;
  const row = (id, pid, layer, bounds, onScreen) => ({ id, pid, layer, bounds, onScreen });
  let rows = [];
  Object.assign($, { kCGWindowListOptionOnScreenOnly: 1, kCGWindowListOptionAll: 0, kCGWindowListExcludeDesktopElements: 16,
    CGWindowListCopyWindowInfo: options => {
      const list = rows.filter(r => !(options & 1) || r.onScreen).map(r => ({ objectForKey: key => ({ kCGWindowNumber: r.id, kCGWindowOwnerPID: r.pid,
        kCGWindowLayer: r.layer, kCGWindowOwnerName: 'App', kCGWindowBounds: r.bounds })[key] }));
      return { count: list.length, objectAtIndex: i => list[i] };
    },
    NSScreen: { screens: { count: 1, objectAtIndex: () => ({ frame: { origin: { x: 0, y: 0 }, size: { width: 1512, height: 982 } } }) } },
    NSUserDefaults: { alloc: { initWithSuiteName: () => ({ boolForKey: () => false }) } } });
  const B = { X: 100, Y: 50, Width: 1200, Height: 900 };
  rows = [row(9, 3, 3, { X: 150, Y: 60, Width: 100, Height: 100 }, true), row(5, 77, 0, { ...B, Width: 1200.5 }, true), row(6, 78, 0, { X: 2000, Y: 0, Width: 10, Height: 10 }, true)];
  const found = JSON.parse(JSON.stringify(context.byBounds(B)));
  assert.deepEqual(found.window, { pid: 77, windowId: 5, bounds: { ...B, Width: 1200.5 } });
  assert.deepEqual(found.windows.map(w => w.id), [9, 5], 'only windows over the browser window');
  assert.deepEqual(found.displays, [{ X: 0, Y: 0, Width: 1512, Height: 982 }]);
  rows = [row(5, 77, 0, B, false)];
  assert.deepEqual(JSON.parse(JSON.stringify(context.byBounds(B))), { ok: true, state: 'other-space' });
  rows = [row(5, 77, 0, B, true), row(7, 79, 0, B, true)];
  assert.equal(context.byBounds(B).ok, false, 'two windows with the same bounds name neither');
  rows = [];
  assert.equal(context.byBounds(B).ok, false);
});

test('runScript stops hand/locate.js after 2.5 s, not the 30 s default', async () => {
  const { runScript } = await import('../plugins/sleight/lib/launch.mjs');
  let timeout;
  const run = (_command, args, options, callback) => {
    timeout = options.timeout;
    assert.match(args.at(-2), /hand\/locate\.js$/);
    return execFile(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ ok: true }))'], callback);
  };
  assert.deepEqual(await runScript('hand/locate.js', { app: 'Example' }, run), { ok: true });
  assert.equal(timeout, 2500);
});


test('geometry cache reuses only unchanged identities in the same pid, window and bounds', () => {
  const c = locateContext(), win = { AXRole: 'AXWindow', AXChildren: [button('Save', 100), button('Other', 200)] };
  const bounds = { X: 0, Y: 0, Width: 500, Height: 500 };
  let walks = 0;
  const walk = c.elements;
  c.elements = (...args) => { walks++; return walk(...args); };
  const request = { 1: { role: 'AXButton', title: 'Save' } };
  const get = (pid = 10, window = 20, b = bounds, ids = request) => JSON.parse(JSON.stringify(c.cachedElements(pid, window, b, win, ids)));
  assert.equal(get()[1].X, 100); assert.equal(walks, 1);
  assert.equal(get()[1].X, 100); assert.equal(walks, 1);
  assert.equal(get(10, 20, bounds, { 1: { role: 'AXButton', title: 'Other' } })[1].X, 200);
  assert.equal(walks, 2, 'a changed tree identity walks again');
  get(10, 20, { ...bounds, X: 1 }); get(11); get(10, 21);
  assert.equal(walks, 5, 'moves, process and window changes invalidate');
  c.cachedElements(10, 21, bounds, win, request, { 1: 'line-version-1' });
  c.cachedElements(10, 21, bounds, win, request, { 1: 'line-version-2' });
  assert.equal(walks, 7, 'a changed tree line walks even when parsed identity is the same');
});

test('the launcher locates on the persistent utility lane', async () => {
  const { createAppHealthHelper } = await import('../plugins/sleight/lib/read-failure.mjs');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const lanes = [], requests = [];
  const helper = createAppHealthHelper({ spawnHelper(kind) {
    lanes.push(kind);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() { queueMicrotask(() => child.emit('close')); } });
    child.stdin.on('data', chunk => { const r = JSON.parse(chunk); requests.push(r); child.stdout.write(JSON.stringify({ id: r.id, ok: true }) + '\n'); });
    return child;
  } });
  await helper.handLocate({ pid: 10 }); await helper.handLocate({ pid: 10 });
  assert.deepEqual(lanes, ['hand']); assert.equal(requests[0].op, 'hand-locate');
  await helper.close();
  const launch = readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
  assert.match(launch, /locate: request => appHealth.handLocate\(request\)/);
});

test('scrolls and layout shifts expire cached frames within 500 ms without changing window bounds or tree lines', () => {
  let clock = 0;
  const c = locateContext(() => clock), el = button('Save', 100);
  const win = { AXRole: 'AXWindow', AXChildren: [el] }, bounds = { X: 0, Y: 0, Width: 500, Height: 500 };
  const get = () => JSON.parse(JSON.stringify(c.cachedElements(10, 20, bounds, win, { 1: { role: 'AXButton', title: 'Save' } })));
  assert.equal(get()[1].X, 100);
  el.AXPosition = [250, 80];
  clock = 500;
  assert.deepEqual(get()[1], { X: 250, Y: 80, Width: 20, Height: 20 });
  win.AXChildren = [];
  clock = 1000;
  assert.deepEqual(get(), {}, 'a removed element cannot retain a cached frame');
});


test('utility priority applies to the hand helper without changing admission helper priority', async () => {
  const { probePlan } = await import('../plugins/sleight/lib/probe-supervisor.mjs');
  const hand = probePlan('--hand-session', []), admission = probePlan('--session', []);
  assert.equal(hand.command, '/usr/bin/nice');
  assert.deepEqual(hand.args.slice(0, 3), ['-n', '10', '/usr/bin/osascript']);
  assert.equal(admission.command, '/usr/bin/osascript');
});
