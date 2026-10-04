import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Only the native AX/CG boundary is replaced. run() does the real selection,
// validation, coordinate conversion, mouse sequence and post-drop check.
function harness({ second = true, before = 'alpha beta gamma\n', after = 'beta gamma alpha\n', selection = 'alpha', repairDeletesText = false, movedOnActivate = false, coveredEnd = false, splitAreas = false, missingContent = false, appId = 'com.apple.TextEdit' } = {}) {
  const events = [], restored = [];
  let order = [22, 11];
  const frames = new Map([[11, { X: 100, Y: 100, Width: 600, Height: 400 }], [22, { X: 900, Y: 200, Width: 800, Height: 500 }]]);
  const values = new Map([[11, before], [22, before]]);
  const selected = new Map([[11, selection], [22, selection]]);
  const proc = { windows: () => (second ? [11, 22] : [11]).map(id => {
    const b = frames.get(id);
    const area = {
      role: () => 'AXTextArea', position: () => [b.X + 5, b.Y + 30], size: () => [b.Width - 10, splitAreas ? 100 : b.Height - 35],
      value: () => values.get(id), uiElements: () => [],
      attributes: { byName: name => ({
        get value() { return () => name === 'AXSelectedText' ? selected.get(id) : null; },
        set value(replacement) {
          const old = selected.get(id), at = values.get(id).indexOf(old);
          values.set(id, repairDeletesText ? '\n beta gamma\n' : values.get(id).slice(0, at) + replacement + values.get(id).slice(at + old.length));
          selected.set(id, replacement);
        },
      }) },
    };
    const toolbar = { role: () => 'AXToolbar', position: () => [b.X, b.Y + 20], size: () => [b.Width, 10], uiElements: () => [] };
    return {
      role: () => 'AXWindow', position: () => [b.X, b.Y], size: () => [b.Width, b.Height], name: () => `${id}.txt`,
      attributes: { byName: name => ({ value: () => name === 'AXWindowNumber' ? id : null }) },
      uiElements: () => missingContent ? [toolbar] : [toolbar, area, ...(splitAreas ? [{ ...area, position: () => [b.X + 5, b.Y + 180] }] : [])], actions: { byName: () => ({ perform: () => { order = [id, ...order.filter(n => n !== id)]; } }) },
    };
  }) };
  const previous = { isNil: () => false, processIdentifier: 99, activateWithOptions: () => restored.push('app') };
  const target = { processIdentifier: 7, bundleIdentifier: appId, activateWithOptions() {
    if (movedOnActivate) { frames.get(11).X = 300; frames.get(11).Y = 400; }
  } };
  const $ = {
    NSWorkspace: { sharedWorkspace: { frontmostApplication: previous } },
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
  };
  const context = vm.createContext({ $, ObjC: { import() {}, unwrap: v => v }, delay() {},
    Application: () => ({ processes: { whose: () => [proc] } }) });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  context.findApp = () => target;
  context.windows = () => [
    ...(coveredEnd ? [{ id: 33, pid: 7, owner: 'TextEdit', title: 'cover.txt', layer: 0, bounds: { X: 210, Y: 130, Width: 40, Height: 40 } }] : []),
    ...order.filter(id => second || id === 11).map(id => ({ id, pid: 7, owner: 'TextEdit', title: `${id}.txt`, layer: 0, bounds: { ...frames.get(id) } })),
  ];
  const run = changes => JSON.parse(context.run([JSON.stringify({ app: 'TextEdit', from: [26.6, 38.5], to: [119, 38.5], ...changes })]));
  return { run, events, restored, values };
}
test('two TextEdit windows refuse ambiguous relative points before mouse-down and list IDs', () => {
  const h = harness(); const result = h.run({});
  assert.equal(result.ok, false);
  assert.match(result.error, /ambiguous.*windowId/i);
  assert.match(result.error, /11/); assert.match(result.error, /22/);
  assert.equal(h.events.length, 0);
});
test('windowId selects the smaller source window for both endpoints after activation moves it', () => {
  const h = harness({ movedOnActivate: true }); const result = h.run({ windowId: 11 });
  assert.equal(result.ok, true); assert.equal(result.windowId, 11);
  assert.deepEqual(h.events.find(e => e.type === 1).point, { x: 326.6, y: 438.5 });
  assert.deepEqual(h.events.find(e => e.type === 2).point, { x: 419, y: 438.5 });
  assert.equal(h.values.get(22), 'alpha beta gamma\n');
  assert.ok(h.restored.length >= 2);
});
test('title bar, toolbar and out-of-frame destinations refuse before pressing', () => {
  for (const to of [[119, 10], [119, 25], [700, 38.5], [-1, 38.5]]) {
    const h = harness(); const result = h.run({ windowId: 11, to });
    assert.equal(result.ok, false, JSON.stringify(to));
    assert.match(result.error, /content|text area|outside/i);
    assert.equal(h.events.length, 0);
  }
});
test('a second window of the same app covering the drop point refuses before pressing', () => {
  const h = harness({ coveredEnd: true }); const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.match(result.error, /cover|window/i);
  assert.equal(h.events.length, 0);
});
test('lost dragged text returns an error with Cmd+Z and the exact window, never success', () => {
  const h = harness({ after: '\n beta gamma\n' }); const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.equal(result.lostText, true);
  assert.match(result.error, /disappeared|lost|missing/i); assert.match(result.error, /Cmd\+Z/); assert.match(result.error, /11/);
  assert.ok(h.events.some(e => e.type === 2)); assert.ok(h.restored.length >= 2);
});
test('single-window calls still work; a foreign or stale windowId cannot fall back', () => {
  const h = harness({ second: false }); assert.equal(h.run({}).ok, true);
  const stale = harness(); assert.equal(stale.run({ windowId: 999 }).ok, false); assert.equal(stale.events.length, 0);
});
test('non-TextEdit drags also reject title bars and toolbars', () => {
  for (const to of [[119, 10], [119, 25]]) {
    const h = harness({ second: false, appId: 'com.apple.Chess' });
    assert.equal(h.run({ to }).ok, false); assert.equal(h.events.length, 0);
  }
});
test('TextEdit cannot drop into a different text area of the chosen window', () => {
  const h = harness({ splitAreas: true });
  const result = h.run({ windowId: 11, to: [119, 190] });
  assert.equal(result.ok, false); assert.match(result.error, /same.*text area/); assert.equal(h.events.length, 0);
});
test('missing content geometry and invalid inputs fail closed before pressing', () => {
  const h = harness({ missingContent: true }); assert.equal(h.run({ windowId: 11 }).ok, false); assert.equal(h.events.length, 0);
  for (const change of [{ windowId: 0 }, { windowId: 1.5 }, { from: [null, 38.5] }, { steps: 0 }, { holdMs: 9000 }]) {
    const invalid = harness(); assert.equal(invalid.run(change).ok, false); assert.equal(invalid.events.length, 0);
  }
});
test('a new substring formed by deleting selected text cannot conceal the loss', () => {
  const h = harness({ before: 'alalphapha\n', after: 'alpha\n' });
  const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.equal(result.lostText, true); assert.match(result.error, /Cmd\+Z/);
});
test('loss during an AX spacing write also returns an error', () => {
  const h = harness({ after: 'beta gammaalpha\n', repairDeletesText: true });
  const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.equal(result.lostText, true); assert.match(result.error, /Cmd\+Z/);
});
test('a verified spacing repair after a valid window-bound drag succeeds', () => {
  const h = harness({ after: 'beta gammaalpha\n' }); const result = h.run({ windowId: 11 });
  assert.equal(result.ok, true); assert.equal(result.spaceInserted, true); assert.equal(h.values.get(11), 'beta gamma alpha\n');
});
test('a valid overlapping partial-word move does not report loss', () => {
  const h = harness({ before: 'abababa X', after: 'abba Xaba', selection: 'aba' });
  assert.equal(h.run({ windowId: 11 }).ok, true);
});
test('whitespace-only selections refuse before pressing', () => {
  const h = harness({ selection: ' ' });
  assert.equal(h.run({ windowId: 11 }).ok, false); assert.equal(h.events.length, 0);
});
test('Unicode text loss is detected and a conserved repeated selection is accepted', () => {
  const lost = harness({ before: 'é🦊 é🦊 X', after: 'é🦊 X', selection: 'é🦊' });
  assert.equal(lost.run({ windowId: 11 }).lostText, true);
  const moved = harness({ before: 'é🦊 é🦊 X', after: 'é🦊 Xé🦊', selection: 'é🦊' });
  assert.equal(moved.run({ windowId: 11 }).ok, true);
});
test('TextEdit smart spacing can change selected whitespace without a false loss error', () => {
  const h = harness({ selection: 'alpha ', after: 'beta gammaalpha\n' });
  assert.equal(h.run({ windowId: 11 }).ok, true);
});
