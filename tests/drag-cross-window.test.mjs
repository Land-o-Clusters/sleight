import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Replace only AX/CG and the native text-area adapter; run() keeps the real guards and path ordering.
function fixture(options = {}) {
  const ids = options.windowIds ?? [11, 12];
  const events = [], writes = [], activations = [], settles = [], restored = [], traces = [];
  const frames = [{ X: 100, Y: 100, Width: 600, Height: 400 }, { X: 750, Y: 100, Width: 500, Height: 400 }];
  if (options.stacked) frames[1] = { ...frames[0] };
  const area = (id, value, selected) => ({ id, AXRole: 'AXTextArea', AXValue: value, AXSelectedText: selected,
    AXPosition: { x: frames[ids.indexOf(id)].X + 5, y: 130 }, AXSize: { width: 480, height: 365 }, AXChildren: [] });
  const a = area(ids[0], 'alpha beta\n', 'alpha'), b = area(ids[1], 'gamma delta\n', '');
  a.range = { location: 0, length: 5 }; b.range = { location: 0, length: 0 };
  const wins = [a, b].map((el, i) => {
    const win = { AXRole: 'AXWindow', AXWindowNumber: ids[i], AXTitle: options.sameTitle ? 'Same.txt' : `${ids[i]}.txt`, AXChildren: [el],
      AXPosition: { x: frames[i].X, y: 100 }, AXSize: { width: frames[i].Width, height: 400 } };
    el.AXParent = win; return win;
  });
  const list = items => ({ count: items.length, objectAtIndex: i => items[i] });
  const target = { processIdentifier: 7, activateWithOptions: () => { activations.push(7); options.onActivate?.({ a, b, frames }); } };
  const previous = { processIdentifier: 99, isNil: () => false, activateWithOptions() {} };
  const app = { AXWindows: wins, AXFocusedUIElement: b };
  let order = [ids[1], ids[0]], delayed = 0, attempts = 0;
  const systemWide = { systemWide: true };
  const applyDrop = () => {
    if (options.unchanged) return;
    a.AXValue = ' beta\n'; a.AXSelectedText = '';
    if (!options.lost) b.AXValue = 'gamma delta alpha\n';
  };
  const $ = Object.assign(value => value, {
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout: () => 0, CFEqual: (x, y) => x === y,
    AXUIElementCopyAttributeValue: (el, key, out) => {
      if (options.readbackTimeout && events.some(e => e.type === 2) && el === b && key === 'AXValue') return -25204;
      if (options.axReadbackTimeout && writes.length && el === b && key === 'AXValue') return -25204;
      if (!(key in el)) return -25205;
      out[0] = Array.isArray(el[key]) ? list(el[key]) : el[key]; return 0;
    },
    // The system-wide hit test answers with the process the window server gives the click to (options.eventPid).
    AXUIElementCreateSystemWide: options.eventPid ? () => systemWide : undefined,
    AXUIElementGetPid: (el, out) => { out[0] = el.pid; return el.pid ? 0 : -25205; },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: pid => ({ isNil: () => false, activationPolicy: pid === 7 ? 0 : 1,
      bundleURL: { path: pid === 7 ? '/Applications/Editor.app' : '/System/Library/CoreServices/Agent.app' } }) },
    AXUIElementCopyElementAtPosition: (_app, x, y, out) => {
      if (_app === systemWide) { const pid = options.eventPid(x, y); out[0] = { pid }; return pid ? 0 : -25212; }
      const el = [a, b].find(el => x >= el.AXPosition.x && x < el.AXPosition.x + el.AXSize.width &&
        y >= el.AXPosition.y && y < el.AXPosition.y + el.AXSize.height);
      out[0] = el ?? wins.find(w => x >= w.AXPosition.x && x < w.AXPosition.x + w.AXSize.width);
      return out[0] ? 0 : -25212;
    },
    AXUIElementSetAttributeValue: (el, key, value) => { el[key] = value; return 0; },
    AXUIElementPerformAction: (el) => { const id = el.AXWindowNumber; order = [id, ...order.filter(n => n !== id)]; return 0; },
    AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return true; },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { bytes, mutableBytes: bytes }; } },
    NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: previous } }, NSProcessInfo: { processInfo: { systemUptime: 1 } },
    CGPointMake: (x, y) => ({ x, y }), CGEventGetLocation: () => ({ x: 1, y: 2 }), CGEventCreate: () => ({}), CGWarpMouseCursorPosition: p => restored.push(p),
    CGEventSourceSecondsSinceLastEventType: (_state, type) => options.busy && type !== 10 ? 0 : options.typing && activations.length && type === 10 ? 0 : 60,
    kCGEventMouseMoved: 5, kCGEventLeftMouseDown: 1, kCGEventLeftMouseDragged: 6, kCGEventLeftMouseUp: 2,
    CGEventCreateMouseEvent: (_src, type, point) => ({ type, point }), CGEventSetIntegerValueField() {},
    CGEventPost: (_tap, e) => { events.push({ ...e, foreground: true }); if (e.type === 2) applyDrop(); },
    CGEventSetTimestamp() {}, CGEventPostToPid: (_pid, e) => {
      events.push(e);
      if (options.postFail === e.type) throw new Error('posting failed');
      if (e.type === 2 && !options.postedUnchanged) applyDrop();
    },
  });
  const context = vm.createContext({ console: { log: line => traces.push(JSON.parse(line.replace(/^sleight-drag-phase /, ''))) }, $, Ref: () => [], ObjC: { import() {}, bindFunction() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v },
    delay: () => { if (++delayed === 1) options.onSettle?.({ a, b, frames }); },
    Application: () => assert.fail('cross-window selection must not use app focus or Apple events'),
    SLEIGHT_ACCESSIBILITY_MOVE: options.ax !== false });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  context.findApp = () => target;
  context.windows = () => [
    // As listed on 2026-10-19: Notification Center's full-display window while a banner shows, and the Dock's
    // tiling backdrop over the left half after Move & Resize.
    ...(options.overlays ? [{ id: 40, pid: 739, title: 'Notification Center', owner: 'Notification Center', layer: 21, bounds: { X: 0, Y: 0, Width: 1512, Height: 982 } },
      { id: 310887, pid: 633, title: 'half-backdrop', owner: 'Dock', layer: 0, bounds: { X: -4, Y: 32, Width: 762, Height: 950 } }] : []),
    ...(options.cover ? [{ id: 50, pid: 99, title: 'cover', owner: 'Other', layer: 0, bounds: frames[1] }] : []),
    ...order.filter(id => !(options.foreign && id === ids[1])).map(id => ({ id, pid: 7, title: options.sameTitle ? 'Same.txt' : `${id}.txt`, owner: 'Editor', layer: 0, bounds: { ...frames[ids.indexOf(id)] } })),
  ];
  context.backgroundBuilder = () => {
    if (options.lateCover) options.cover = true;
    if (options.noPosting) throw new Error('no window-local API');
    return (type, point, window) => ({ event: { type, point, windowId: window.id } });
  };
  context.axTextArea = (_pid, point, reference) => {
    const el = reference ?? (point.x < 750 ? a : b);
    const x = el.AXPosition.x;
    return {
      value: () => el.AXValue,
      selection: () => ({ ...el.range }),
      lineForIndex: () => 0,
      lineRange: n => n === 0 ? { location: 0, length: el.AXValue.length } : options.emptyFinal && n === 1 ? { location: el.AXValue.length, length: 0 } : null,
      hasAttributes: () => !!options.formatted,
      rect: (i, length = 1) => {
        const end = el.AXValue.length - 1;
        if (i === 0 && length === el.AXValue.length) return { X: x, Y: 130, Width: 8 * end, Height: 14 };
        if (i === el.AXValue.length && length === 0) return { X: x, Y: 150, Width: 0, Height: 14 };
        return { X: x + i * 8, Y: 130, Width: length === 0 || i === end ? 0 : 8, Height: 14 };
      },
      indexAt: p => options.emptyFinal && (p.y < 130 || p.y >= 144) ? 0 : Math.min(Math.floor((p.x - x) / 8), el.AXValue.length - 1), lineEnd: () => el.AXValue.length,
      replace: (at, length, text) => {
        if (options.rangeSideEffects) { el.range = { location: at, length }; el.AXSelectedText = el.AXValue.slice(at, at + length); }
        if (options.failWrite === ++attempts) throw new Error('write unavailable');
        writes.push([el.id, at, length, text]);
        if (!options.ignoreWrites && !options.ignoreWriteNumbers?.includes(writes.length)) el.AXValue = el.AXValue.slice(0, at) + text + el.AXValue.slice(at + length);
        options.afterWrite?.({ a, b, writes });
      },
      select: (location, length) => { el.range = { location, length }; el.AXSelectedText = el.AXValue.slice(location, location + length); }, settle: () => settles.push(7),
    };
  };
  const run = (change = {}) => JSON.parse(context.run([JSON.stringify({ app: 'Editor', windowId: ids[0], toWindowId: ids[1],
    dp7: options.dp7 ?? false, dp2: options.dp2 ?? false, from: 'the current text selection', to: 'end of line 1', holdMs: 0, settleMs: 0, steps: 2, ...change })]));
  return { run, context, a, b, frames, wins, events, writes, activations, settles, restored, traces };
}

test('cross-window AX move finds A selection while B has focus and inserts at B line end', () => {
  const h = fixture(), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'accessibility'); assert.equal(r.toWindowId, 12);
  assert.equal(h.a.AXValue, 'beta\n'); assert.equal(h.b.AXValue, 'gamma delta alpha\n');
  assert.deepEqual(h.writes, [[12, 11, 0, ' alpha'], [11, 0, 6, '']]);
  assert.equal(h.settles.length, 1); assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
  // Like the single-window AX move, the moved text ends selected in its new place.
  assert.deepEqual(h.b.range, { location: 12, length: 5 }); assert.equal(h.b.AXSelectedText, 'alpha');
});

test('cross-window traces preserve DP2 ordering for AX and its posted fallback', () => {
  for (const dp2 of [true, false]) {
    for (const formatted of [false, true]) {
      const h = fixture({ dp2, formatted }), r = h.run({ trace: true });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.path, formatted ? 'background' : 'accessibility');
      const pre = ['raise:start', 'raise:end', 'settle:start', 'settle:end'];
      const ax = ['ax-move:start', ...(formatted ? [] : ['settle:start', 'settle:end']), 'ax-move:end'];
      assert.deepEqual(h.traces.map(e => `${e.phase}:${e.edge}`), [
        ...(!dp2 ? pre : []), ...ax, ...(formatted ? [...(dp2 ? pre : []), 'posted-press:start', 'posted-press:end'] : []),
      ]);
      assert.ok(h.traces.every(e => e.monoMs === 1000));
      const quiet = fixture({ dp2, formatted });
      assert.deepEqual(quiet.run(), r); assert.deepEqual(quiet.traces, []);
    }
  }
});

test('destination coordinates use B screenshot scale even when A and B differ in size', () => {
  const h = fixture(), r = h.run({ from: [14, 37], to: [190, 74], screenshots: { '11.txt': [600, 400], '12.txt': [1000, 800] } });
  assert.equal(r.ok, true, r.error); assert.equal(h.b.AXValue, 'gamma delta alpha\n');
});

test('each endpoint number uses its own window read, including the same number in both', () => {
  const h = fixture(); h.a.AXTitle = 'source'; h.b.AXTitle = 'destination';
  const r = h.run({ from: 4, to: 4, elementLines: { 4: 'text entry area source' }, elementWindow: { title: '11.txt', windowId: 11 },
    toElementLines: { 4: 'text entry area destination' }, toElementWindow: { title: '12.txt', windowId: 12 } });
  assert.equal(r.ok, true, r.error); assert.equal(h.a.AXValue.trim(), 'beta');
});

for (const [name, change, setup] of [
  ['missing source windowId', { windowId: undefined }, {}], ['same window', { toWindowId: 11 }, {}],
  ['fractional destination', { toWindowId: 12.5 }, {}], ['foreign destination', {}, { foreign: true }],
  ['source title bar', { from: [20, 10] }, {}], ['destination title bar', { to: [20, 10] }, {}],
  ['destination outside', { to: [600, 40] }, {}], ['wrong destination read', { to: 4, toElementLines: { 4: 'text entry area destination' }, toElementWindow: { title: '11.txt', windowId: 11 } }, {}],
  ['covered destination of same app', {}, { stacked: true }],
]) test(`cross-window refuses ${name} before any edit or press`, () => {
  const h = fixture(setup), r = h.run(change);
  assert.equal(r.ok, false); assert.equal(h.writes.length, 0); assert.equal(h.events.length, 0);
  if (setup.stacked) assert.match(r.error, /tile the windows with Window > Move & Resize, then read again/);
});

test('source selection must be unique within A and non-blank', () => {
  for (const duplicate of [false, true]) {
    const h = fixture();
    if (duplicate) h.wins[0].AXChildren.push({ ...h.a }); else h.a.AXSelectedText = ' ';
    assert.equal(h.run().ok, false); assert.equal(h.writes.length + h.events.length, 0);
  }
});

for (const [name, mutate] of [
  ['destination geometry', h => { h.frames[1].X++; }],
  ['destination text', h => { h.b.AXValue = 'owner edit\n'; }],
  ['source selection', h => { h.a.AXSelectedText = 'beta'; }],
]) test(`cross-window rechecks ${name} after raising A`, () => {
  const h = fixture({ onSettle: mutate }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.writes.length + h.events.length, 0);
});

test('posted drag uses global B endpoint with A event tags and verifies both values', () => {
  const h = fixture({ ax: false }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background'); assert.equal(r.deliveryVerified, true);
  assert.equal(h.events.at(-1).point.x, 842); assert.ok(h.events.every(e => e.windowId === 11));
  assert.equal(h.activations.length, 0);
});

test('lost text names both windows and never retries in foreground', () => {
  const h = fixture({ ax: false, lost: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.lostText, true); assert.match(r.error, /11.*12/);
  assert.equal(h.activations.length, 0); assert.equal(h.events.filter(e => e.type === 1).length, 1);
});

test('a destination readback timeout is unverified and cannot trigger a second drag', () => {
  const h = fixture({ ax: false, readbackTimeout: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.deliveryVerified, false); assert.equal(h.activations.length, 0);
});

test('foreground fallback checks endpoint against B and restores the pointer', () => {
  const h = fixture({ ax: false, postedUnchanged: true }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'foreground');
  assert.equal(h.activations.length, 1); assert.ok(h.events.at(-1).point.x > 750);
  assert.deepEqual(h.restored, [{ x: 1, y: 2 }]);
});

test('foreground refuses busy input and owner edits in either window', () => {
  for (const options of [{ busy: true }, { typing: true }, { onActivate: h => { h.b.AXValue = 'owner edit\n'; } }]) {
    const h = fixture({ ax: false, noPosting: true, ...options }), r = h.run();
    assert.equal(r.ok, false); assert.equal(h.events.filter(e => e.type === 1).length, 0);
  }
});

test('a failed source cut rolls back the verified destination insert before reporting', () => {
  const h = fixture({ failWrite: 2 }), r = h.run();
  assert.equal(r.ok, false); assert.match(r.error, /11.*12/); assert.equal(h.a.AXValue, 'alpha beta\n');
  assert.equal(h.b.AXValue, 'gamma delta\n'); assert.equal(r.rolledBack, true); assert.match(r.error, /removed/);
  assert.deepEqual(h.writes.at(-1), [12, 11, 6, '']); assert.equal(h.events.length, 0); assert.equal(h.settles.length, 1);
});

test('a read-only source that ignores the cut gets the destination insert rolled back, no posting', () => {
  const h = fixture({ ignoreWriteNumbers: [2] }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.rolledBack, true); assert.equal(r.deliveryVerified, false);
  assert.equal(h.a.AXValue, 'alpha beta\n'); assert.equal(h.b.AXValue, 'gamma delta\n');
  assert.deepEqual(h.writes, [[12, 11, 0, ' alpha'], [11, 0, 6, ''], [12, 11, 6, '']]);
  assert.deepEqual(h.b.range, { location: 0, length: 0 }); assert.match(r.error, /read-only/);
  assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0); assert.equal(h.settles.length, 1);
});

test('windows sharing one document: A changing with the B insert rolls back B and skips the cut', () => {
  const h = fixture({ afterWrite: ({ a, writes }) => { a.AXValue = writes.length === 1 ? 'alpha beta\n alpha' : 'alpha beta\n'; } }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.rolledBack, true); assert.match(r.error, /share one document/);
  assert.deepEqual(h.writes, [[12, 11, 0, ' alpha'], [12, 11, 6, '']]);
  assert.equal(h.a.AXValue, 'alpha beta\n'); assert.equal(h.b.AXValue, 'gamma delta\n'); assert.equal(h.events.length, 0);
});

test('an unverifiable rollback says exactly what B now contains', () => {
  const h = fixture({ ignoreWriteNumbers: [2, 3] }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.rolledBack, false); assert.equal(r.deliveryVerified, false);
  assert.ok(r.error.includes('window 12 (12.txt) now contains "gamma delta alpha\\n"'), r.error);
  assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
});

test('an AX readback timeout after writing reports cannot verify, never nothing was pressed or a fallback', () => {
  const h = fixture({ axReadbackTimeout: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.deliveryVerified, false); assert.match(r.error, /cannot verify/);
  assert.doesNotMatch(r.error, /nothing was pressed/); assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
});

test('a posted-drop readback timeout reports cannot verify', () => {
  const h = fixture({ ax: false, readbackTimeout: true }), r = h.run();
  assert.equal(r.ok, false); assert.match(r.error, /cannot verify the drop/); assert.match(r.error, /12/);
});

test('B coordinates never use the latest screenshot of another window', () => {
  const h = fixture(), r = h.run({ to: [190, 74], screenshot: [1000, 800], screenshots: { '11.txt': [600, 400] } });
  assert.equal(r.ok, false); assert.match(r.error, /end of line N/); assert.match(r.error, /element number/);
  assert.equal(h.writes.length + h.events.length, 0);
});

test('equal titles need a B screenshot keyed by window id', () => {
  const titled = fixture({ sameTitle: true }), refused = titled.run({ to: [190, 74], screenshots: { 'Same.txt': [1000, 800] } });
  assert.equal(refused.ok, false); assert.match(refused.error, /end of line N/); assert.equal(titled.writes.length, 0);
  const h = fixture({ sameTitle: true }), r = h.run({ to: [190, 74], screenshots: { 'Same.txt': [600, 400] }, screenshotsByWindow: { 12: [1000, 800] } });
  assert.equal(r.ok, true, r.error); assert.equal(h.b.AXValue, 'gamma delta alpha\n');
});

test('ignored destination AX insert leaves source intact and permits the posted path', () => {
  const h = fixture({ ignoreWrites: true }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background');
  assert.equal(h.writes.filter(([id]) => id === 11).length, 0);
});

test('formatted source selection skips plain AX writes', () => {
  const h = fixture({ formatted: true }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background'); assert.equal(h.writes.length, 0);
});

test('failure before background mouse-down permits guarded foreground fallback', () => {
  const h = fixture({ ax: false, postFail: 5 }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'foreground');
  assert.equal(h.events.filter(e => e.type === 1).length, 1);
});

test('uncertain background release never repeats the drag in foreground', () => {
  const h = fixture({ ax: false, postFail: 2 }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.deliveryVerified, false); assert.equal(h.activations.length, 0);
  assert.equal(h.events.filter(e => e.type === 1).length, 1);
});

test('destination coverage is labeled to and names tiling as recovery', () => {
  const h = fixture({ stacked: true }), r = h.run();
  assert.match(r.error, /to is covered/); assert.equal(h.writes.length + h.events.length, 0);
});

test('a preexisting copy in B cannot conceal lost text from A', () => {
  const h = fixture({ ax: false }); h.b.AXValue = 'gamma delta alpha\n';
  const r = h.run();
  assert.equal(r.ok, false); assert.equal(r.lostText, true); assert.equal(h.activations.length, 0);
});

test('an owner edit between destination insertion and source deletion stops the move', () => {
  const h = fixture({ afterWrite: h => { h.a.AXValue = 'owner alpha beta\n'; } }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.writes.filter(([id]) => id === 11).length, 0); assert.equal(h.a.AXValue, 'owner alpha beta\n');
  assert.equal(h.b.AXValue, 'gamma delta\n'); assert.equal(h.events.length, 0);
});

test('covering another app at B permits AX but forbids background posting', () => {
  const ax = fixture({ cover: true }); assert.equal(ax.run().path, 'accessibility');
  const h = fixture({ ax: false, cover: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.events.filter(e => e.type === 1).length, 0);
});

test('another app covering B after event construction stops background mouse-down', () => {
  const h = fixture({ ax: false, lateCover: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.events.filter(e => e.type === 1).length, 0);
});

test('a repeated selected string does not hide a changed source selection range', () => {
  const h = fixture({ afterWrite: h => { h.a.range = { location: 6, length: 5 }; } });
  h.a.AXValue = 'alpha alpha beta\n';
  const r = h.run();
  assert.equal(r.ok, false); assert.equal(h.writes.filter(([id]) => id === 11).length, 0); assert.equal(h.a.AXValue, 'alpha alpha beta\n');
  assert.equal(h.b.AXValue, 'gamma delta\n');
});

test('ignored native AX insertion restores its own range change before posted fallback', () => {
  const h = fixture({ ignoreWrites: true, rangeSideEffects: true }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background'); assert.equal(h.activations.length, 0);
});

// The 2026-10-19 stop: the Accessibility move failed, the Dock's backdrop sent the drag to the foreground path, and
// Notification Center's full-display window then refused the source point while its banner was elsewhere.
test('system windows that let clicks through cover neither endpoint, so the posted path runs', () => {
  const h = fixture({ ax: false, overlays: true, eventPid: () => 7 }), r = h.run();
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.path, 'background');
  assert.equal(h.activations.length, 0); assert.equal(h.events.filter(e => e.foreground).length, 0);
});

test('without a hit-test answer the overlays still count as cover, as before', () => {
  const h = fixture({ ax: false, overlays: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.events.filter(e => e.type === 1).length, 0);
  assert.match(r.error, /from is covered by Notification Center \(windowId 40/);
});

test('a banner over the point is a system overlay: wait and retry once, no tiling advice, nothing pressed', () => {
  const h = fixture({ ax: false, noPosting: true, overlays: true, eventPid: x => (x < 750 ? 739 : 7) }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.events.filter(e => e.type === 1).length, 0);
  assert.match(r.error, /^from is covered by Notification Center \(windowId 40\), a system window such as a notification banner or a system prompt; nothing was pressed\. If it is a security, permission, password or sign-in prompt, don't interact with it: tell the user now\. Otherwise it usually goes away within seconds: wait about 5 s, read the window again and retry the drag once/);
  assert.doesNotMatch(r.error, /tile the windows|nothing was pressed.*nothing was pressed/);
});

for (const options of [{ formatted: true }, { ignoreWrites: true }, { ax: false }, { noPosting: true, formatted: true }]) {
  test(`DP7 refuses cross-window posting with its AX reason: ${JSON.stringify(options)}`, () => {
    const h = fixture({ ...options, dp7: true, dp2: true }), r = h.run();
    assert.equal(r.ok, false); assert.equal(r.path, 'none'); assert.equal(r.deliveryVerified, false);
    assert.match(r.fallbackReason, /accessibility move unavailable/); assert.match(r.error, /cross-window posting can copy/);
    assert.doesNotMatch(r.error + r.fallbackReason, /use the guarded posted or foreground drag/);
    assert.equal(h.events.length + h.activations.length, 0); assert.equal(h.a.AXValue, 'alpha beta\n');
    assert.equal(h.b.AXValue, 'gamma delta\n');
  });
}

// WD2's recording tried both forms and got the same formatting refusal. Neither may bypass DP7.
test('recorded semantic and coordinate cross-window requests preserve a genuine formatting refusal', () => {
  for (const from of ['the current text selection', [185, 77]]) {
    const h = fixture({ formatted: true, dp7: true, dp2: true });
    h.a.AXValue = 'alpha move-8ea07288 omega\n'; h.a.AXSelectedText = 'move-8ea07288';
    h.a.range = { location: 6, length: 13 }; h.b.AXValue = 'destination\n\n';
    const r = h.run({ from, to: [60, 97], screenshotsByWindow: { 11: [600, 400], 12: [500, 400] } });
    assert.equal(r.ok, false); assert.equal(r.path, 'none'); assert.equal(r.deliveryVerified, false);
    assert.match(r.fallbackReason ?? r.error, /selected text carries formatting/);
    assert.equal(h.a.AXValue, 'alpha move-8ea07288 omega\n'); assert.equal(h.b.AXValue, 'destination\n\n');
    assert.equal(h.writes.length + h.events.length + h.activations.length, 0);
  }
});
test('DP2 cross-window AX move skips the raise and settle', () => {
  const h = fixture({ dp7: true, dp2: true });
  h.context.raiseWindow = () => assert.fail('AX move did not need a raise');
  h.context.delay = () => assert.fail('AX move did not need a settle delay');
  assert.equal(h.run().path, 'accessibility'); assert.equal(h.writes.length, 2);
});

test('DP7 and DP2 default on: a cross-window drop uses the empty final line without raising', () => {
  const h = fixture({ emptyFinal: true });
  h.context.raiseWindow = () => assert.fail('default AX path raised');
  h.context.delay = () => assert.fail('default AX path waited');
  const r = h.run({ dp7: undefined, dp2: undefined, to: [20, 57], screenshotsByWindow: { 12: [500, 400] } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.path, 'accessibility');
  assert.equal(h.a.AXValue, 'beta\n'); assert.equal(h.b.AXValue, 'gamma delta\nalpha\n');
  assert.equal(h.events.length, 0);
});

for (const failure of [{ failWrite: 2 }, { ignoreWriteNumbers: [2] }]) {
  test(`WD5 rolls back the inserted final newline when the source cut fails: ${JSON.stringify(failure)}`, () => {
    const h = fixture({ emptyFinal: true, ...failure });
    const r = h.run({ dp7: true, dp2: true, to: [20, 57], screenshotsByWindow: { 12: [500, 400] } });
    assert.equal(r.ok, false); assert.equal(r.rolledBack, true); assert.equal(r.deliveryVerified, false);
    assert.equal(h.a.AXValue, 'alpha beta\n'); assert.equal(h.b.AXValue, 'gamma delta\n');
    assert.deepEqual(h.writes[0], [12, 12, 0, 'alpha\n']);
    assert.deepEqual(h.writes.at(-1), [12, 12, 6, '']);
    assert.equal(h.events.length + h.activations.length, 0);
  });
}

test('DPd smoke endpoints move onto the second empty target row without a placeholder', () => {
  for (const to of [[24, 128], [20, 132]]) {
    const h = fixture(), adapter = h.context.axTextArea;
    h.a.AXValue = 'alpha move-a7933cf2 omega\n'; h.a.AXSelectedText = 'move-a7933cf2';
    h.a.range = { location: 6, length: 13 }; h.b.AXValue = 'destination\n\n';
    Object.assign(h.frames[1], { X: 752, Y: 49, Width: 720, Height: 560 });
    Object.assign(h.wins[1], { AXPosition: { x: 752, y: 49 }, AXSize: { width: 720, height: 560 } });
    Object.assign(h.b, { AXPosition: { x: 757, y: 81 }, AXSize: { width: 700, height: 520 } });
    h.context.axTextArea = (pid, point, reference) => {
      const area = adapter(pid, point, reference);
      if ((reference ?? (point.x < 750 ? h.a : h.b)) !== h.b) return area;
      return { ...area,
        indexAt: p => p.y >= 81 && p.y < 94 && p.x >= 762 && p.x < 833.5 ? Math.floor((p.x - 762) / 6.5) : 0,
        rect: (i, n = 1) => i === 12 ? { X: 762, Y: 94, Width: 0, Height: 13 }
          : i === 13 && n === 0 ? { X: 762, Y: 107, Width: 0, Height: 13 }
            : { X: 762 + i * 6.5, Y: 81, Width: 6.5, Height: 13 },
        lineRange: n => [{ location: 0, length: 12 }, { location: 12, length: 1 }, { location: 13, length: 0 }][n] ?? null,
      };
    };
    h.context.raiseWindow = () => assert.fail('AX move raised a window');
    const r = h.run({ dp7: undefined, dp2: undefined, to, screenshotsByWindow: { 12: [1440, 1120] }, trace: true });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.path, 'accessibility');
    assert.equal(r.fallbackReason, null); assert.equal(r.deliveryVerified, true);
    assert.equal(h.a.AXValue, 'alpha omega\n'); assert.equal(h.b.AXValue, 'destination\n\nmove-a7933cf2\n');
    assert.deepEqual(h.writes, [[12, 13, 0, 'move-a7933cf2\n'], [11, 6, 14, '']]);
    assert.deepEqual(h.traces.map(e => `${e.phase}:${e.edge}`), ['ax-move:start', 'settle:start', 'settle:end', 'ax-move:end']);
    assert.equal(h.events.length + h.activations.length, 0);
  }
});

test('DPg recorded blank-line destination moves to line 2 without a placeholder or screenshot', () => {
  const h = fixture({ emptyFinal: true }), adapter = h.context.axTextArea;
  h.a.AXValue = 'alpha move-7a278a09 omega\n'; h.a.AXSelectedText = 'move-7a278a09';
  h.a.range = { location: 6, length: 13 }; h.b.AXValue = 'destination\n\n';
  h.context.axTextArea = (pid, point, reference) => {
    const area = adapter(pid, point, reference);
    if (reference !== h.b) return area;
    return { ...area,
      lineRange: n => [{ location: 0, length: 12 }, { location: 12, length: 1 }, { location: 13, length: 0 }][n] ?? null,
      rect: (i, n = 1) => i === 12 ? { X: 755, Y: 150, Width: 0, Height: 14 }
        : i === 13 && n === 0 ? { X: 755, Y: 170, Width: 0, Height: 14 }
          : { X: 755 + i * 8, Y: 130, Width: 8, Height: 14 },
    };
  };
  h.context.raiseWindow = () => assert.fail('AX move raised a window');
  const r = h.run({ dp7: true, dp2: true, to: 'end of line 2', trace: true });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.path, 'accessibility');
  assert.equal(r.fallbackReason, null); assert.equal(r.deliveryVerified, true);
  assert.equal(h.a.AXValue, 'alpha omega\n'); assert.equal(h.b.AXValue, 'destination\nmove-7a278a09\n');
  assert.deepEqual(h.writes, [[12, 12, 0, 'move-7a278a09'], [11, 6, 14, '']]);
  assert.deepEqual(h.traces.map(e => `${e.phase}:${e.edge}`), ['ax-move:start', 'settle:start', 'settle:end', 'ax-move:end']);
  assert.equal(h.events.length + h.activations.length, 0);
});

for (const to of [[24, 104], [20, 100], 'end of line 2']) {
  test(`WD3 recorded selection request moves onto the empty final line: ${JSON.stringify(to)}`, () => {
    const h = fixture({ windowIds: [323040, 323041] }), adapter = h.context.axTextArea;
    h.a.AXValue = 'alpha move-c656f03d omega\n'; h.a.AXSelectedText = 'move-c656f03d';
    h.a.range = { location: 6, length: 13 }; h.b.AXValue = 'destination\n';
    Object.assign(h.frames[1], { X: 752, Y: 49, Width: 720, Height: 560 });
    Object.assign(h.wins[1], { AXPosition: { x: 752, y: 49 }, AXSize: { width: 720, height: 560 } });
    Object.assign(h.b, { AXPosition: { x: 757, y: 81 }, AXSize: { width: 700, height: 520 } });
    h.context.axTextArea = (pid, point, reference) => {
      const area = adapter(pid, point, reference);
      if (reference !== h.b) return area;
      return { ...area,
        bounds: () => ({ X: 757, Y: 81, Width: 700, Height: 520 }),
        characterCount: () => 12,
        indexAt: () => 0,
        rect: (i, n = 1) => i === 0 && n === 12 ? { X: 762, Y: 81, Width: 71.5, Height: 13 }
          : i === 12 && n === 0 && typeof to === 'string' ? { X: 762, Y: 94, Width: 0, Height: 13 }
          : i < 12 ? { X: 762 + i * 6.5, Y: 81, Width: i === 11 ? 0 : 6.5, Height: 13 } : null,
        lineRange: n => [{ location: 0, length: 12 }, { location: 12, length: 0 }][n] ?? null,
      };
    };
    h.context.raiseWindow = () => assert.fail('AX move raised a window');
    const r = h.run({ app: 'TextEdit', dp7: undefined, dp2: undefined, to,
      ...(Array.isArray(to) ? { screenshotsByWindow: { 323041: [1440, 1120] } } : {}), trace: true });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.path, 'accessibility');
    assert.equal(r.toWindowId, 323041); assert.equal(r.fallbackReason, null); assert.equal(r.deliveryVerified, true);
    assert.equal(h.a.AXValue, 'alpha omega\n'); assert.equal(h.b.AXValue, 'destination\nmove-c656f03d\n');
    assert.deepEqual(h.writes, [[323041, 12, 0, 'move-c656f03d\n'], [323040, 6, 14, '']]);
    assert.equal(h.events.length + h.activations.length, 0);
  });
}
