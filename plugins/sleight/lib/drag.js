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

// Only repair a uniquely identified word move whose whole text matches, with
// at most one source-side space removed by TextEdit's smart deletion.
function textDropSpace(before, word, after, selected) {
  if (typeof before !== 'string' || typeof after !== 'string' || !word || word !== selected ||
      !/^[\p{L}\p{N}]+$/u.test(word) || before === after) return null;
  const source = before.indexOf(word);
  const drop = after.indexOf(word);
  if (source < 0 || drop <= 0 || before.indexOf(word, source + 1) >= 0 || after.indexOf(word, drop + 1) >= 0) return null;
  if (/[\p{L}\p{N}]$/u.test(before.slice(0, source)) || /^[\p{L}\p{N}]/u.test(before.slice(source + word.length))) return null;
  if (!/[\p{L}\p{N}]$/u.test(after.slice(0, drop)) || !/^(?:\r?\n|$)/.test(after.slice(drop + word.length))) return null;
  const left = before.slice(0, source), right = before.slice(source + word.length);
  const remainder = after.slice(0, drop) + after.slice(drop + word.length);
  const candidates = [left + right];
  if (left.endsWith(' ')) candidates.push(left.slice(0, -1) + right);
  if (right.startsWith(' ')) candidates.push(left + right.slice(1));
  return candidates.includes(remainder) ? ` ${word}` : null;
}

function textEditSelection(pid, start) {
  const proc = Application('System Events').processes.whose({ unixId: pid })[0];
  const find = (el, depth) => {
    if (depth > 12) return null;
    try {
      if (el.role() === 'AXTextArea') {
        const p = el.position(), s = el.size();
        if (inside({ X: p[0], Y: p[1], Width: s[0], Height: s[1] }, start)) {
          const text = el.value();
          const selected = el.attributes.byName('AXSelectedText').value();
          if (typeof text === 'string' && typeof selected === 'string' && selected) return { el, text, selected };
        }
      }
      for (const child of el.uiElements()) { const found = find(child, depth + 1); if (found) return found; }
    } catch (_) { /* Missing AX text means the drag proceeds without a repair. */ }
    return null;
  };
  for (const win of proc.windows()) { const found = find(win, 0); if (found) return found; }
  return null;
}

function repairTextDrop(snapshot) {
  if (!snapshot) return { spaceInserted: false };
  try {
    const after = snapshot.el.value();
    const selected = snapshot.el.attributes.byName('AXSelectedText');
    const replacement = textDropSpace(snapshot.text, snapshot.selected, after, selected.value());
    if (!replacement) return { spaceInserted: false };
    selected.value = replacement;
    const at = after.indexOf(snapshot.selected);
    const expected = after.slice(0, at) + ' ' + after.slice(at);
    if (snapshot.el.value() !== expected) throw new Error('TextEdit did not confirm the spacing repair; read the document before continuing');
    return { spaceInserted: true };
  } catch (e) {
    return { spaceInserted: false, spacingError: String(e.message || e) };
  }
}

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

    let text = null;
    if (ObjC.unwrap(target.bundleIdentifier) === 'com.apple.TextEdit') {
      try { text = textEditSelection(pid, start); } catch (_) { /* AX may be unavailable. */ }
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
    const spacing = repairTextDrop(text);
    $.CGWarpMouseCursorPosition(saved);
    if (!previous.isNil() && previous.processIdentifier !== pid) previous.activateWithOptions(0);
    return JSON.stringify({ ok: true, app, from, to, holdMs, steps, ...spacing });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e.message || e) });
  }
}
