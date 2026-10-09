import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Only the native AX/CG boundary is replaced. run() does the real selection,
// validation, coordinate conversion, mouse sequence and post-drop check.
function harness({ background = false, backgroundAfter = 'beta gammaalpha\n', setterFails = false, readFails = false, postFails = false, releaseFails = false, changeOnActivate = false, second = true, before = 'alpha beta gamma\n', after = 'beta gamma alpha\n', selection, repairDeletesText = false, movedOnActivate = false, coveredEnd = false, coveredPid = 7, splitAreas = false, missingContent = false, extraElements = 0, stacked = false, raiseWorks = true, raiseActivates = false, offSpace = false, noWindows = false, appId = 'com.apple.TextEdit', busyChecks = 0, typesAt = null, ax = null, coverTitle = 'cover.txt' } = {}) {
  // Other apps have no selected text unless a test says so: Chess has no text area at all.
  selection ??= appId === 'com.apple.TextEdit' ? 'alpha' : '';
  const events = [], restored = [], activations = [], pidEvents = [], mainWrites = [];
  let visited = 0, inputChecks = 0;
  let mainId = 22;
  let order = [22, 11];
  const frames = new Map([[11, { X: 100, Y: 100, Width: 600, Height: 400 }], [22, { X: 900, Y: 200, Width: 800, Height: 500 }]]);
  if (stacked) frames.set(22, { ...frames.get(11) });
  const values = new Map([[11, before], [22, before]]);
  const selected = new Map([[11, selection], [22, selection]]);
  const proc = { windows: () => (second ? [11, 22] : [11]).map(id => {
    const b = frames.get(id);
    const area = {
      role: () => 'AXTextArea', position: () => [b.X + 5, b.Y + 30], size: () => [b.Width - 10, splitAreas ? 100 : b.Height - 35],
      value: () => { if (readFails && pidEvents.length) throw new Error('read unavailable'); return values.get(id); }, uiElements: () => [],
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
      attributes: { byName: name => ({
        get value() { return () => name === 'AXWindowNumber' ? id : name === 'AXMain' ? mainId === id : null; },
        set value(value) { assert.equal(name, 'AXMain'); assert.equal(value, true); mainWrites.push(id); mainId = id; },
      }) },
      uiElements: () => missingContent ? [toolbar] : [toolbar, area, ...Array.from({ length: extraElements }, () => ({
        role: () => { visited++; return 'AXButton'; }, subrole: () => '',
        position: () => [b.X + 10, b.Y + 32], size: () => [10, 10], uiElements: () => [],
      })), ...(splitAreas ? [{ ...area, position: () => [b.X + 5, b.Y + 180] }] : [])], actions: { byName: () => ({ perform: () => { if (raiseWorks) order = [id, ...order.filter(n => n !== id)]; if (raiseActivates) $.NSWorkspace.sharedWorkspace.frontmostApplication = target; } }) },
    };
  }) };
  const previous = { isNil: () => false, processIdentifier: 99, activateWithOptions: () => restored.push('app') };
  const target = { processIdentifier: 7, bundleIdentifier: appId, activateWithOptions() {
    activations.push(7);
    if (changeOnActivate) values.set(11, 'owner edited alpha beta gamma\n');
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
    CGEventPostToPid: (pid, e) => {
      assert.equal(pid, 7); pidEvents.push(e);
      if (releaseFails && e.type === 2) throw new Error('release failed');
      if (e.type === 2 || postFails) values.set(11, backgroundAfter);
      if (postFails && e.type === 6) throw new Error('posting interrupted');
    },
  };
  const delays = [];
  const context = vm.createContext({ SLEIGHT_ACCESSIBILITY_MOVE: ax !== null, $, ObjC: { import() {}, unwrap: v => v, bindFunction() { if (!background) throw new Error('private API missing'); } }, delay: s => delays.push(s),
    Application: () => ({ processes: { whose: () => [proc] } }) });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  context.findApp = () => target;
  // A one-line text area in window 11 at 8 px per character, 13 px tall.
  // Past the line's end, indexAt answers 0, as AXRangeForPosition does.
  const axWrites = [];
  context.axTextArea = () => {
    if (!ax) throw new Error('AX unavailable');
    const x0 = frames.get(11).X + 5, y0 = frames.get(11).Y + 30, text = () => values.get(11);
    return {
      value: () => ax.changedBeforeMove ? 'owner edit\n' : text(),
      selection: () => ({ location: text().indexOf(selected.get(11)), length: selected.get(11).length }),
      indexAt: p => { const i = Math.floor((p.x - x0) / 8); return p.y >= y0 && p.y < y0 + 13 && i >= 0 && i < text().length - 1 ? i : 0; },
      rect: i => i < text().length - 1 ? { X: x0 + 8 * i, Y: y0, Width: 8, Height: 13 } : null,
      lineEnd: () => text().length,
      replace: (location, length, s) => {
        if (ax.failWrite === axWrites.length + 1) throw new Error('AX write failed');
        if (ax.ignored) { axWrites.push('ignored'); return; }
        axWrites.push([location, length, s]);
        values.set(11, text().slice(0, location) + s + text().slice(location + length));
      },
      select: () => {},
      settle: () => axWrites.push('settle'),
    };
  };
  context.windows = onScreenOnly => noWindows || (onScreenOnly && offSpace) ? [] : [
    ...(coveredEnd ? [{ id: 33, pid: coveredPid, owner: coveredPid === 7 ? 'TextEdit' : 'Other app', title: coverTitle, layer: 0, bounds: { X: 180, Y: 130, Width: 80, Height: 40 } }] : []),
    ...order.filter(id => second || id === 11).map(id => ({ id, pid: 7, owner: 'TextEdit', title: `${id}.txt`, layer: 0, bounds: { ...frames.get(id) } })),
  ];
  const run = changes => JSON.parse(context.run([JSON.stringify({ app: 'TextEdit', from: [26.6, 38.5], to: [119, 38.5], ...changes })]));
  return { run, events, restored, activations, pidEvents, values, mainWrites, delays, axWrites, visits: () => visited };
}
// Window 11's text area starts at x 105, so [150, 38.5] is past the line's end.
const pastEnd = { windowId: 11, to: [150, 38.5] };
test('a covered text drop moves the text through Accessibility with no pointer, focus or posting', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: {} }); const r = h.run(pastEnd);
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'accessibility');
  assert.equal(h.values.get(11), 'beta gamma alpha\n'); assert.equal(r.spaceInserted, true);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0); assert.equal(h.pidEvents.length, 0);
  assert.equal(h.restored.length, 0);
});
test('an unchanged background drag moves the text through Accessibility before any foreground drag', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n', ax: {} }); const r = h.run(pastEnd);
  assert.equal(r.path, 'accessibility'); assert.equal(h.values.get(11), 'beta gamma alpha\n');
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
});
test('a drop inside a line lands before the word under it, with one space each side', () => {
  // x 193 is the left half of "gamma"'s g (index 11, x 193 to 201).
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: {} }); const r = h.run({ windowId: 11, to: [93, 38.5] });
  assert.equal(r.ok, true, r.error); assert.equal(h.values.get(11), 'beta alpha gamma\n');
});
test('text that changed before the Accessibility move stops everything', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: { changedBeforeMove: true } }); const r = h.run(pastEnd);
  assert.equal(r.ok, false); assert.match(r.error, /changed before the move/);
  assert.equal(h.axWrites.length, 0); assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
});
test('a failed first Accessibility write that changed nothing falls back to the guarded foreground drag', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: { failWrite: 1 } }); const r = h.run(pastEnd);
  assert.equal(r.path, 'foreground'); assert.match(r.fallbackReason, /accessibility move failed: AX write failed/);
});
test('a failed second Accessibility write reports the half-done move with Cmd+Z and never falls back', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: { failWrite: 2 } }); const r = h.run(pastEnd);
  assert.equal(r.ok, false); assert.equal(r.path, 'accessibility'); assert.match(r.error, /Cmd\+Z twice/);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
});
test('the foreground path waits for the person at the Mac to stop, then drags', () => {
  const h = harness({ busyChecks: 3 }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'foreground');
  assert.equal(h.delays.filter(s => s === 1.9).length, 3, 'waits out the 2 s idle window three times');
});
test('a person who keeps using the Mac stops the foreground path before it takes focus', () => {
  const h = harness({ busyChecks: Infinity }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /kept typing.*nothing was pressed/);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
  assert.ok(h.delays.reduce((a, b) => a + b, 0) <= 10.01);
});
test('the background path never waits for the person at the Mac', () => {
  const h = harness({ background: true, busyChecks: Infinity }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true); assert.equal(r.path, 'background');
});
test('keys typed after the target takes focus stop the press and report it', () => {
  const h = harness({ typesAt: 'focused' }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /typed while TextEdit was in front.*nothing was pressed/);
  assert.equal(h.events.some(e => e.type === 1), false); assert.ok(h.restored.includes('app'));
});
test('keys typed during the drag turn a success into an error that says so', () => {
  const h = harness({ typesAt: 'dragging' }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /typed during the drag/);
  assert.equal(h.values.get(11), 'beta gamma alpha\n');
});
test('background text move uses PID posting, repairs spacing and never activates or warps', () => {
  const h = harness({ background: true }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true); assert.equal(r.path, 'background'); assert.equal(r.spaceInserted, true);
  assert.equal(r.textChanged, true); assert.equal(h.values.get(11), 'beta gamma alpha\n');
  assert.equal(h.pidEvents.length, 28); assert.equal(h.events.length, 0);
  assert.ok(h.pidEvents.every(e => e.flags === 1 << 20));
  assert.equal(h.activations.length, 0); assert.equal(h.restored.length, 0);
});
test('unchanged background text alone permits the foreground fallback', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n' }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true); assert.equal(r.path, 'foreground'); assert.equal(r.fallbackReason, 'background text unchanged');
  assert.equal(h.pidEvents.length, 28); assert.equal(h.activations.length, 1); assert.equal(h.events.length, 28);
});
test('another app covering the drag points skips background posting and says which app', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9 }); const r = h.run({ windowId: 11 });
  assert.equal(r.path, 'foreground'); assert.equal(r.fallbackReason, 'background skipped: Other app covers the window at the drag points');
  assert.equal(h.pidEvents.length, 0);
});
test('missing or failing private setter skips posting and names the foreground path', () => {
  for (const options of [{ background: false }, { background: true, setterFails: true }]) {
    const h = harness(options); const r = h.run({ windowId: 11 });
    assert.equal(r.path, 'foreground'); assert.match(r.fallbackReason, /background unavailable/);
    assert.equal(h.pidEvents.length, 0); assert.equal(h.activations.length, 1);
  }
});
test('lost text, changed partial text and unreadable text never permit a second drag', () => {
  for (const options of [{ backgroundAfter: '\n beta gamma\n' }, { backgroundAfter: 'beta alpha gamma\n', postFails: true }, { readFails: true }]) {
    const h = harness({ background: true, ...options }); const r = h.run({ windowId: 11 });
    assert.equal(r.ok, false); assert.equal(r.path, 'background');
    if (options.backgroundAfter === '\n beta gamma\n') { assert.equal(r.lostText, true); assert.match(r.error, /Cmd\+Z/); }
    assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0); assert.equal(h.restored.length, 0);
  }
});
test('non-text background posting reports unverified delivery without foreground repetition', () => {
  const h = harness({ background: true, appId: 'com.apple.Chess' }); const r = h.run({ windowId: 11 });
  assert.equal(r.path, 'background'); assert.equal(r.deliveryVerified, false);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
  assert.ok(h.pidEvents.every(e => e.flags === 0), 'Chess piece moves must not become Command drags');
});
test('an owner edit after unchanged readback prevents foreground mouse-down', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n', changeOnActivate: true });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /changed.*foreground/);
  assert.equal(h.events.some(e => e.type === 1), false);
});
test('an unconfirmed background release cannot trigger foreground fallback', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n', releaseFails: true });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.equal(r.path, 'background'); assert.match(r.error, /release/);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
});
test('unchanged text after both paths reports failure and never tries a third drag', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n', after: 'alpha beta gamma\n' });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.equal(r.path, 'foreground'); assert.equal(r.textChanged, false);
  assert.match(r.error, /unchanged/); assert.equal(h.pidEvents.filter(e => e.type === 1).length, 1);
  assert.equal(h.events.filter(e => e.type === 1).length, 1);
});
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
test('large AX trees refuse before pressing after at most 300 elements and restore focus', () => {
  const h = harness({ extraElements: 1000 });
  const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.match(result.error, /300|limit/i);
  assert.ok(h.visits() <= 300); assert.equal(h.events.length, 0);
  assert.ok(h.restored.includes('app'));
});
test('a refusal states nothing was pressed exactly once', () => {
  const h = harness(); const result = h.run({ windowId: 11, to: [119, 10] });
  assert.equal(result.error.match(/nothing was pressed/g)?.length, 1);
});
test('stacked Chess and TextEdit windows make the named window main before dragging', () => {
  for (const appId of ['com.apple.Chess', 'com.apple.TextEdit']) {
    const h = harness({ stacked: true, appId });
    const result = h.run({ windowId: 11 });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(h.mainWrites, [11]);
    assert.equal(h.values.get(11), 'beta gamma alpha\n');
    assert.equal(h.values.get(22), 'alpha beta gamma\n');
  }
});
test('a raise that leaves another stacked same-app window in front refuses before pressing', () => {
  for (const appId of ['com.apple.Chess', 'com.apple.TextEdit']) {
    const h = harness({ stacked: true, raiseWorks: false, appId });
    const result = h.run({ windowId: 11 });
    assert.equal(result.ok, false); assert.match(result.error, /covered|topmost/i);
    assert.equal(h.events.length, 0); assert.ok(h.restored.includes('app'));
  }
});
test('an off-Space window is distinguished from an app with no window before any activation', () => {
  const hidden = harness({ offSpace: true });
  const result = hidden.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.match(result.error, /another desktop or Space/i);
  assert.match(result.error, /on screen/i); assert.equal(hidden.events.length, 0); assert.equal(hidden.restored.length, 0);
  const empty = harness({ noWindows: true });
  assert.match(empty.run({}).error, /has no window/);
  assert.doesNotMatch(empty.run({}).error, /another desktop or Space/);
});
test('background posting raises the named stacked Chess and TextEdit window without HID input', () => {
  for (const appId of ['com.apple.Chess', 'com.apple.TextEdit']) {
    const h = harness({ background: true, stacked: true, backgroundAfter: 'beta gamma alpha\n', appId });
    const result = h.run({ windowId: 11 });
    assert.equal(result.ok, true, result.error); assert.equal(result.path, 'background');
    assert.deepEqual(h.mainWrites, [11]);
    assert.equal(h.values.get(11), 'beta gamma alpha\n'); assert.equal(h.values.get(22), 'alpha beta gamma\n');
    assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
  }
});
test('a failed background raise refuses at both same-app endpoints before PID or HID pressing', () => {
  for (const options of [{ stacked: true, raiseWorks: false }, { coveredEnd: true }]) {
    const h = harness({ background: true, ...options }); const result = h.run({ windowId: 11 });
    assert.equal(result.ok, false); assert.match(result.error, /covered|topmost/i);
    assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0);
  }
});
test('the prior front app is restored if AXRaise brings a background target forward, even on refusal', () => {
  for (const coveredEnd of [false, true]) {
    const h = harness({ background: true, raiseActivates: true, coveredEnd }); h.run({ windowId: 11 });
    assert.ok(h.restored.includes('app')); assert.equal(h.events.length, 0);
  }
});
test('off-Space diagnosis precedes both background and foreground event construction', () => {
  for (const background of [false, true]) {
    const h = harness({ background, offSpace: true }); const result = h.run({ windowId: 11 });
    assert.match(result.error, /another desktop or Space/); assert.equal(h.pidEvents.length, 0);
    assert.equal(h.events.length, 0); assert.equal(h.mainWrites.length, 0);
  }
});
test('screenshot pixels convert to window points with the relay\'s screenshot size', () => {
  // Window 11 is 600×400 points; a 1200×800 screenshot is 2×. [300, 77] is [150, 38.5] in points.
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: {} });
  const r = h.run({ windowId: 11, from: [53.2, 77], to: [300, 77], screenshot: [1200, 800] });
  assert.equal(r.ok, true, r.error); assert.equal(r.screenshotScale, 2); assert.equal(h.values.get(11), 'beta gamma alpha\n');
});
test('a screenshot of another window shape is ignored and the result says the points were window points', () => {
  const h = harness({ second: false });
  const r = h.run({ screenshot: [1000, 1000] });
  assert.equal(r.ok, true, r.error); assert.match(r.coordinates, /another window size/);
  assert.equal(h.run({}).coordinates, 'window points: no engine screenshot of this app yet');
});
test('the screenshot of the dragged window wins over the app\'s latest one', () => {
  // The latest screenshot was of another window (1000×1000); window 11's own was 1200×800, so 2×.
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: {} });
  const r = h.run({ windowId: 11, from: [53.2, 77], to: [300, 77], screenshot: [1000, 1000], screenshots: { '11.txt': [1200, 800] } });
  assert.equal(r.ok, true, r.error); assert.equal(r.screenshotScale, 2);
});
test('an Accessibility move settles the app after writing, even when its second write fails', () => {
  for (const failWrite of [undefined, 2]) {
    const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: { failWrite } }); h.run(pastEnd);
    assert.equal(h.axWrites.at(-1), 'settle', `failWrite ${failWrite}`);
  }
});
test('a text field in another app moves through Accessibility first, never a Command-modified drag', () => {
  // Safari-like: a text field with selected text in an app that isn't TextEdit, nothing covering it.
  const h = harness({ background: true, appId: 'com.apple.Safari', selection: 'alpha', ax: {} }); const r = h.run(pastEnd);
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'accessibility');
  assert.equal(h.values.get(11), 'beta gamma alpha\n'); assert.equal(h.pidEvents.length, 0);
  assert.match(r.fallbackReason ?? '', /^$/);
});
test('another app\'s text drag without Accessibility posts a plain drag, without Command', () => {
  const h = harness({ background: true, appId: 'com.apple.Safari', selection: 'alpha' }); h.run(pastEnd);
  assert.ok(h.pidEvents.length > 0 && h.pidEvents.every(e => e.flags === 0));
});
test('an app that ignores Accessibility writes gets the next path, with no undo advice', () => {
  const h = harness({ background: true, appId: 'com.apple.Safari', selection: 'alpha', ax: { ignored: true } }); const r = h.run(pastEnd);
  assert.notEqual(r.path, 'accessibility'); assert.match(r.fallbackReason, /accessibility move failed: the app ignored/);
  assert.doesNotMatch(r.error ?? '', /Cmd\+Z twice/);
});
test('an untitled window of the same app over a drag point is named as a likely dialog', () => {
  const dialog = harness({ coveredEnd: true, coverTitle: '' }).run({ windowId: 11 });
  assert.equal(dialog.ok, false); assert.match(dialog.error, /no title \(windowId 33\), likely a dialog or sheet: finish or close it/);
  const titled = harness({ coveredEnd: true }).run({ windowId: 11 });
  assert.match(titled.error, /covered by another window of TextEdit \(windowId 33, "cover.txt"\)/);
});
