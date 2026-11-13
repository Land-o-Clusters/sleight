import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function crossWindowDragFixture(options = {}) {
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
  const target = { processIdentifier: 7, bundleIdentifier: 'com.apple.TextEdit', localizedName: 'Editor',
    bundleURL: { path: '/Applications/Editor.app' },
    activateWithOptions: () => { activations.push(7); options.onActivate?.({ a, b, frames }); } };
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
    NSWorkspace: { sharedWorkspace: { frontmostApplication: previous, runningApplications: list([target]) } }, NSProcessInfo: { processInfo: { systemUptime: 1 } },
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
  vm.runInContext(readFileSync(new URL('../../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  if (!options.nativeAppResolution) context.findApp = () => target;
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
      select: (location, length) => { el.range = { location, length }; el.AXSelectedText = el.AXValue.slice(location, location + length); }, settle: () => { settles.push(7); if (options.nativeSettle) context.settleAfterTextWrite(7); },
    };
  };
  const run = (change = {}) => JSON.parse(context.run([JSON.stringify({ app: 'Editor', windowId: ids[0], toWindowId: ids[1],
    dp7: options.dp7 ?? false, dp2: options.dp2 ?? false, from: 'the current text selection', to: 'end of line 1', holdMs: 0, settleMs: 0, steps: 2, ...change })]));
  return { run, context, a, b, frames, wins, events, writes, activations, settles, restored, traces };
}
