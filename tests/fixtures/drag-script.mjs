import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Shared fake AX/CG boundary for the engine and runtime local-drag suites.
export function dragScriptFixture(options = {}, defaultAppId = 'com.apple.TextEdit') {
  return harness(options);
function harness({ background = false, backgroundAfter = 'beta gammaalpha\n', setterFails = false, readFails = false, postFails = false, failBeforePress = false, releaseFails = false, changeOnActivate = false, second = true, before = 'alpha beta gamma\n', after = 'beta gamma alpha\n', selection = 'alpha', areaRole = 'AXTextArea', repairDeletesText = false, movedOnActivate = false, coveredEnd = false, coveredPid = 7, splitAreas = false, missingContent = false, extraElements = 0, stacked = false, raiseWorks = true, raiseActivates = false, offSpace = false, noWindows = false, appId = defaultAppId, busyChecks = 0, typesAt = null, ax = null, coverTitle = 'cover.txt', slowDelays = false, nativeFailure = null, rows = 0, coverBounds = null, rowRole = 'AXRow', rowChild = null, shiftRowsOnRaise = 0, extraWindows = [], onDelay, nativeAppResolution = false } = {}) {
  const events = [], restored = [], activations = [], pidEvents = [], mainWrites = [], textWrites = [];
  let visited = 0, inputChecks = 0, readbacks = 0;
  let mainId = 22, rowShift = 0;
  let order = [22, 11];
  const frames = new Map([[11, { X: 100, Y: 100, Width: 600, Height: 400 }], [22, { X: 900, Y: 200, Width: 800, Height: 500 }]]);
  if (stacked) frames.set(22, { ...frames.get(11) });
  const values = new Map([[11, before], [22, before]]);
  const selected = new Map([[11, selection], [22, selection]]);
  const proc = { attributes: { byName: () => ({ value: () => ({ attributes: { byName: () => ({ value: () => selection }) } }) }) }, windows: () => (second ? [11, 22] : [11]).map(id => {
    const b = frames.get(id);
    const area = {
      role: () => areaRole, position: () => [b.X + 5, b.Y + 30], size: () => [b.Width - 10, splitAreas ? 100 : b.Height - 35],
      value: () => { if (readFails && pidEvents.length) throw new Error('read unavailable'); return values.get(id); }, uiElements: () => [],
      attributes: { byName: name => ({
        get value() { return () => name === 'AXSelectedText' ? selected.get(id) : null; },
        set value(replacement) {
          textWrites.push(replacement);
          const old = selected.get(id), at = values.get(id).indexOf(old);
          values.set(id, repairDeletesText ? '\n beta gamma\n' : values.get(id).slice(0, at) + replacement + values.get(id).slice(at + old.length));
          selected.set(id, replacement);
        },
      }) },
    };
    // Reorderable rows inside window 11's content area, 30 points tall every 40 points.
    const rowEls = id !== 11 ? [] : Array.from({ length: rows }, (_, i) => ({
      role: () => rowRole, subrole: () => '', name: () => `row ${i}`, position: () => [b.X + 5, b.Y + 30 + i * 40 + rowShift], size: () => [b.Width - 10, 30],
      uiElements: () => rowChild ? [{ role: () => 'AXButton', subrole: () => '', name: () => `button ${i}`, position: () => [b.X + rowChild[0], b.Y + 30 + i * 40 + rowShift],
        size: () => [rowChild[1], 30], uiElements: () => [], attributes: { byName: () => ({ value: () => '' }) } }] : [],
      attributes: { byName: () => ({ value: () => '' }) },
    }));
    area.uiElements = () => rowEls;
    const toolbar = { role: () => 'AXToolbar', position: () => [b.X, b.Y + 20], size: () => [b.Width, 10], uiElements: () => [] };
    return {
      role: () => 'AXWindow', position: () => [b.X, b.Y], size: () => [b.Width, b.Height], name: () => `${id}.txt`,
      attributes: { byName: name => ({
        get value() { return () => name === 'AXWindowNumber' ? id : name === 'AXMain' ? mainId === id : null; },
        set value(value) { assert.equal(name, 'AXMain'); assert.equal(value, true); mainWrites.push(id); mainId = id; },
      }) },
      uiElements: () => missingContent ? [toolbar] : [toolbar, area, ...Array.from({ length: extraElements }, () => ({
        role: () => { visited++; return 'AXButton'; }, subrole: () => '',
        position: () => [b.X + 10, b.Y + 32], size: () => [10, 10], uiElements: () => [],
      })), ...(splitAreas ? [{ ...area, position: () => [b.X + 5, b.Y + 180] }] : [])], actions: { byName: () => ({ perform: () => { rowShift = shiftRowsOnRaise; if (raiseWorks) order = [id, ...order.filter(n => n !== id)]; if (raiseActivates) $.NSWorkspace.sharedWorkspace.frontmostApplication = target; } }) },
    };
  }) };
  const previous = { isNil: () => false, processIdentifier: 99, activateWithOptions: () => restored.push('app') };
  const target = { processIdentifier: 7, bundleIdentifier: appId, localizedName: 'TextEdit',
    bundleURL: { path: '/Applications/TextEdit.app' }, activateWithOptions() {
    activations.push(7);
    if (changeOnActivate) values.set(11, 'owner edited alpha beta gamma\n');
    if (movedOnActivate) { frames.get(11).X = 300; frames.get(11).Y = 400; }
  } };
  const $ = {
    malloc: () => ({}), free() {},
    NSWorkspace: { sharedWorkspace: { frontmostApplication: previous,
      runningApplications: { count: 1, objectAtIndex: () => target } } },
    CGEventCreate: () => ({}), CGEventGetLocation: () => ({ x: 4, y: 8 }),
    CGPointMake: (x, y) => ({ x, y }), CGWarpMouseCursorPosition: p => restored.push(p),
    kCGMouseButtonLeft: 0, kCGHIDEventTap: 0,
    kCGEventMouseMoved: 5, kCGEventLeftMouseDown: 1, kCGEventLeftMouseDragged: 6, kCGEventLeftMouseUp: 2,
    CGEventCreateMouseEvent: (_, type, point) => ({ type, point }), CGEventSetIntegerValueField() {},
    CGEventPost: (_, event) => {
      events.push(event);
      if (event.type === 2) {
        const id = order[0]; values.set(id, after); selected.set(id, after.includes(selection) ? selection : '');
      }
    },
    NSProcessInfo: { processInfo: { systemUptime: 1 } },
    // The person at the Mac: busy for the first busyChecks idle checks, and typing
    // after activation ('focused') or during the drag ('dragging').
    CGEventSourceSecondsSinceLastEventType: (_state, type) => {
      if (type === 10) {
        const typed = typesAt === 'focused' ? activations.length > 0 : typesAt === 'dragging' && events.some(e => e.type === 1);
        return typed ? 0 : 60;
      }
      inputChecks++;
      return inputChecks <= busyChecks ? 0.1 : 60;
    },
    NSEvent: { mouseEventWithTypeLocationModifierFlagsTimestampWindowNumberContextEventNumberClickCountPressure: (type, point, flags) => ({ type, point, flags }) },
    objc_msgSend: e => e,
    CGEventSetWindowLocation: (e, p) => { if (setterFails) throw new Error('setter failed'); e.local = p; },
    CGEventGetWindowLocation: e => e.local,
    CGEventGetType: e => e.type, CGEventSetLocation: (e, p) => { e.point = p; }, CGEventSetTimestamp() {},
    CGEventCreateKeyboardEvent: (_source, _key, down) => ({ down }), CGEventSetFlags() {}, CGEventSetType() {},
    CGEventPostToPid: (pid, e) => {
      assert.equal(pid, 7);
      if (e.down !== undefined) { if (e.type === 12) pidEvents.push(e); return; }
      pidEvents.push(e);
      if (failBeforePress && e.type === 5) throw new Error('posting unavailable before press');
      if (releaseFails && e.type === 2) throw new Error('release failed');
      if (e.type === 2 || postFails) values.set(11, backgroundAfter);
      if (postFails && e.type === 6) throw new Error('posting interrupted');
    },
  };
  const delays = [];
  // slowDelays: every wait takes 30 s on the script's clock, as slow window reads would.
  let clock = 0;
  // Adapt the same fixture elements at the native AX boundary. Guard assertions
  // below still exercise run(), including all text and foreground fallbacks.
  const list = items => ({ count: items.length, objectAtIndex: i => items[i] });
  let nativeWindows;
  const parents = new Map();
  const native = Object.assign(value => value, $, {
    AXUIElementCreateApplication: () => proc,
    AXUIElementSetMessagingTimeout: () => 0,
    CFEqual: (a, b) => a === b,
    AXUIElementCopyElementAtPosition: (_app, x, y, out) => {
      nativeWindows ??= proc.windows();
      const win = nativeWindows.find(w => { const [wx, wy] = w.position(), [width, height] = w.size(); return x >= wx && x < wx + width && y >= wy && y < wy + height; });
      if (!win) return -25212;
      const children = win.uiElements();
      const rowHit = children[1]?.uiElements().find(el => { const [ex, ey] = el.position(), [width, height] = el.size(); return x >= ex && x < ex + width && y >= ey && y < ey + height; });
      if (rowHit) {
        parents.set(rowHit, children[1]); parents.set(children[1], win);
        const child = rowHit.uiElements().find(el => { const [ex, ey] = el.position(), [width, height] = el.size(); return x >= ex && x < ex + width && y >= ey && y < ey + height; });
        if (child) parents.set(child, rowHit);
        out[0] = child ?? rowHit; return 0;
      }
      const hit = children.slice(0, 2).find(el => { const [ex, ey] = el.position(), [width, height] = el.size(); return x >= ex && x < ex + width && y >= ey && y < ey + height; }) ?? win;
      if (hit !== win) parents.set(hit, win);
      out[0] = hit; return 0;
    },
    AXUIElementCopyAttributeValue: (el, name, out) => {
      if (nativeFailure?.name === name) {
        const pressed = [...pidEvents, ...events].some(event => event.type === 1);
        if (nativeFailure.afterPress ? pressed && ++readbacks >= nativeFailure.afterPress : el.role?.() === 'AXToolbar') return nativeFailure.code;
      }
      const methods = { AXWindows: 'windows', AXChildren: 'uiElements', AXRole: 'role', AXSubrole: 'subrole', AXTitle: 'name', AXValue: 'value' };
      try {
        if (name === 'AXWindows') { nativeWindows ??= proc.windows(); out[0] = list(nativeWindows); }
        else if (name === 'AXFocusedUIElement') { nativeWindows ??= proc.windows(); const win = nativeWindows[0]; out[0] = win.uiElements()[1]; parents.set(out[0], win); }
        else if (name === 'AXParent') { if (!parents.has(el)) return -25212; out[0] = parents.get(el); }
        else if (name === 'AXPosition') { const [x, y] = el.position(); out[0] = { x, y }; }
        else if (name === 'AXSize') { const [width, height] = el.size(); out[0] = { width, height }; }
        else if (methods[name]) { const value = el[methods[name]](); out[0] = Array.isArray(value) ? list(value) : value; }
        else out[0] = el.attributes.byName(name).value();
        return 0;
      } catch { return -25205; }
    },
    AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return true; },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { bytes, mutableBytes: bytes }; } },
    NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
    AXUIElementSetAttributeValue: (el, name, value) => { el.attributes.byName(name).value = value; return 0; },
    AXUIElementPerformAction: (el, name) => { el.actions.byName(name).perform(); return 0; },
  });
  const traces = [];
  Object.defineProperty(native.NSProcessInfo.processInfo, 'systemUptime', { get: () => 1 + ++clock / 1000 });
  const context = vm.createContext({ console: { log: line => traces.push(JSON.parse(line.replace(/^sleight-drag-phase /, ''))) }, SLEIGHT_ACCESSIBILITY_MOVE: ax !== null, $: native, Ref: () => [], ObjC: { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v, bindFunction() { if (!background) throw new Error('private API missing'); } }, delay: s => { delays.push(s); onDelay?.({ values, selected }); if (slowDelays) clock += 30000; },
    Date: { now: () => clock },
    Application: () => ({ processes: { whose: () => [proc] } }) });
  vm.runInContext(readFileSync(new URL('../../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  // Older bundle-agnostic rows deliberately use selectors different from appId.
  // Runtime admission rows opt in to the actual findApp predicate instead.
  if (!nativeAppResolution) context.findApp = () => target;
  // A one-line text area in window 11 at 8 px per character, 13 px tall.
  // Past the line's end, indexAt answers 0, as AXRangeForPosition does.
  const axWrites = [];
  context.axTextArea = () => {
    if (!ax) throw new Error('AX unavailable');
    if (ax.failArea) throw new Error('area unavailable');
    const x0 = frames.get(11).X + 5, y0 = frames.get(11).Y + 30, text = () => values.get(11);
    return {
      value: () => { if (ax.failValue) throw new Error('value unavailable'); return ax.changedBeforeMove ? 'owner edit\n' : text(); },
      selection: () => { if (ax.failSelection) throw new Error('selection unavailable'); return { location: text().indexOf(selected.get(11)), length: selected.get(11).length }; },
      lineRange: line => line === 0 ? { location: 0, length: text().length } : null,
      lineForIndex: () => 0,
      hasAttributes: (location, length, baseline) => {
        if (ax.unreadableAttributes) throw new Error('attributed string unavailable');
        if (!ax.attributes) return !!ax.formatted;
        assert.equal(baseline, 0);
        const size = location + length - baseline;
        return context.attributedTextHasAttributes({ length: size, attributesAtIndexEffectiveRange: index => {
          const font = ax.attributes[baseline + index];
          return { count: 2, font, objectForKey: () => undefined, isEqualToDictionary: other => font === other.font };
        } }, size, location - baseline);
      },
      indexAt: p => { const i = Math.floor((p.x - x0) / 8); return p.y >= y0 && p.y < y0 + 13 && i >= 0 && i < text().length - 1 ? i : 0; },
      rect: (i, length = 1) => {
        const end = text().length - 1;
        if (i === 0 && length === text().length) return { X: x0, Y: y0, Width: 8 * end, Height: 13 };
        if (i === text().length && length === 0) return { X: x0, Y: y0 + 20, Width: 0, Height: 13 };
        return i <= end ? { X: x0 + 8 * i, Y: y0, Width: length === 0 || i === end ? 0 : 8, Height: 13 } : null;
      },
      lineEnd: () => text().length,
      replace: (location, length, s) => {
        if (ax.failWrite === axWrites.length + 1) throw new Error('AX write failed');
        if (ax.ignored) { axWrites.push('ignored'); return; }
        axWrites.push([location, length, s]);
        values.set(11, text().slice(0, location) + s + text().slice(location + length));
      },
      select: () => {},
      settle: () => { axWrites.push('settle'); if (ax.nativeSettle) context.settleAfterTextWrite(7); },
    };
  };
  context.windows = onScreenOnly => noWindows || (onScreenOnly && offSpace) ? [] : [
    ...extraWindows.map(w => ({ id: 44, pid: 9, owner: 'Other app', title: '', layer: 0, ...w })),
    ...(coveredEnd ? [{ id: 33, pid: coveredPid, owner: coveredPid === 7 ? 'TextEdit' : 'Other app', title: coverTitle, layer: 0, bounds: coverBounds ? { ...coverBounds } : { X: 180, Y: 130, Width: 80, Height: 40 } }] : []),
    ...order.filter(id => second || id === 11).map(id => ({ id, pid: 7, owner: 'TextEdit', title: `${id}.txt`, layer: 0, bounds: { ...frames.get(id) } })),
  ];
  const run = changes => JSON.parse(context.run([JSON.stringify({ app: defaultAppId, from: [26.6, 38.5], to: [119, 38.5], dp2: false, ...changes })]));
  return { run, context, native, traces, events, restored, activations, pidEvents, values, mainWrites, delays, axWrites, textWrites, visits: () => visited };
}
}
