// A drag that holds the mouse down and moves in steps, for what the engine's
// instant drag can't do (moving selected text). It works in the foreground:
// the app comes to the front, the real pointer does the drag, then the
// pointer and the previously frontmost app go back. The relay asks the user
// first (see launch.mjs).
//
//   osascript -l JavaScript drag.js '<json request>'
//   { app, from: [x, y], to: [x, y], holdMs?, steps?, settleMs? }
//
// Coordinates are in the app's main window, from its top-left corner, the
// same frame as the engine's screenshots. Prints one JSON object.

ObjC.import('AppKit');
ObjC.import('CoreGraphics');

function windows(onScreenOnly) {
  const options = onScreenOnly ? $.kCGWindowListOptionOnScreenOnly : $.kCGWindowListOptionAll;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options | $.kCGWindowListExcludeDesktopElements, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    out.push({
      owner: ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')),
      pid: ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')),
      layer: ObjC.unwrap(w.objectForKey('kCGWindowLayer')),
      bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')),
    });
  }
  return out; // front to back
}

const inside = (b, p) => p.x >= b.X && p.x < b.X + b.Width && p.y >= b.Y && p.y < b.Y + b.Height;

function findApp(name) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    const id = ObjC.unwrap(a.bundleIdentifier);
    const path = ObjC.unwrap(a.bundleURL.path);
    if (ObjC.unwrap(a.localizedName) === name || id === name || path === name) return a;
  }
  return null;
}

function run(argv) {
  try {
    const { app, from, to, holdMs = 500, steps = 25, settleMs = 1500 } = JSON.parse(argv[0]);
    const target = findApp(app);
    if (!target) throw new Error(`${app} isn't running`);
    const pid = target.processIdentifier;
    // The app's main window: its largest normal-level window on screen.
    const own = windows(true).filter(w => w.pid === pid && w.layer === 0);
    if (!own.length) throw new Error(`${app} has no window on screen`);
    const main = own.reduce((a, b) => (a.bounds.Width * a.bounds.Height >= b.bounds.Width * b.bounds.Height ? a : b));
    const at = ([x, y]) => ({ x: main.bounds.X + x, y: main.bounds.Y + y });
    const start = at(from);
    const end = at(to);

    const ws = $.NSWorkspace.sharedWorkspace;
    const previous = ws.frontmostApplication;
    const saved = $.CGEventGetLocation($.CGEventCreate(null));
    target.activateWithOptions(0);
    // Right after the engine acts (say, selecting the text), a press that comes
    // at once doesn't take; 2 s later it does (2026-10-04). Wait for things to settle.
    delay(settleMs / 1000);
    // Never press on another app's window: the topmost window at the start
    // point must belong to this app. The engine's cursor overlay ("ChatGPT
    // Computer Use") lets clicks through, so it doesn't count.
    const top = windows(true).find(w => inside(w.bounds, start) && !/Computer Use$/.test(w.owner));
    if (!top || top.pid !== pid) {
      if (!previous.isNil()) previous.activateWithOptions(0);
      throw new Error(`the start point isn't on ${app}'s window (another window covers it); nothing was pressed`);
    }

    const post = (type, p) => {
      const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(p.x, p.y), $.kCGMouseButtonLeft);
      $.CGEventSetIntegerValueField(e, 1, 1); // click state
      $.CGEventPost($.kCGHIDEventTap, e);
    };
    post($.kCGEventMouseMoved, start);
    delay(0.05);
    post($.kCGEventLeftMouseDown, start);
    delay(holdMs / 1000);
    for (let i = 1; i <= steps; i++) {
      post($.kCGEventLeftMouseDragged, { x: start.x + (end.x - start.x) * i / steps, y: start.y + (end.y - start.y) * i / steps });
      delay(0.02);
    }
    post($.kCGEventLeftMouseUp, end);
    delay(0.2);
    $.CGWarpMouseCursorPosition(saved);
    if (!previous.isNil() && previous.processIdentifier !== pid) previous.activateWithOptions(0);
    return JSON.stringify({ ok: true, app, from, to, holdMs, steps });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e.message || e) });
  }
}
