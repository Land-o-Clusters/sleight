// A drag that holds the mouse down and moves in steps, for what the engine's
// instant drag can't do (moving selected text). Try window-targeted PID
// posting first. Only unchanged text, or an unavailable native bridge before
// posting, permits the foreground path. The relay asks first (launch.mjs).
//
//   osascript -l JavaScript drag.js '<json request>'
//   { app, from: [x, y], to: [x, y], windowId?, holdMs?, steps?, settleMs? }
//
// Coordinates are relative to one identified window's top-left corner, as in
// the engine's screenshots. Ambiguous windows refuse. Prints one JSON object.

ObjC.import('AppKit');
ObjC.import('CoreGraphics');

function windows(onScreenOnly) {
  const options = onScreenOnly ? $.kCGWindowListOptionOnScreenOnly : $.kCGWindowListOptionAll;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options | $.kCGWindowListExcludeDesktopElements, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    out.push({
      id: ObjC.unwrap(w.objectForKey('kCGWindowNumber')),
      title: ObjC.unwrap(w.objectForKey('kCGWindowName')) || '',
      owner: ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')),
      pid: ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')),
      layer: ObjC.unwrap(w.objectForKey('kCGWindowLayer')),
      bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')),
    });
  }
  return out; // front to back
}

const inside = (b, p) => p.x >= b.X && p.x < b.X + b.Width && p.y >= b.Y && p.y < b.Y + b.Height;
const attempt = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
const at = (b, p) => ({ x: b.X + p[0], y: b.Y + p[1] });
const sameBounds = (a, b) => ['X', 'Y', 'Width', 'Height'].every(k => Math.abs(a[k] - b[k]) < 0.5);
function frame(el) {
  const p = el.position(), s = el.size();
  if (![...p, ...s].every(Number.isFinite) || s[0] <= 0 || s[1] <= 0) throw new Error('AX geometry is unavailable');
  return { X: p[0], Y: p[1], Width: s[0], Height: s[1] };
}
function clip(a, b) {
  const X = Math.max(a.X, b.X), Y = Math.max(a.Y, b.Y);
  return { X, Y, Width: Math.max(0, Math.min(a.X + a.Width, b.X + b.Width) - X), Height: Math.max(0, Math.min(a.Y + a.Height, b.Y + b.Height) - Y) };
}
function resolveWindow(own, request) {
  const list = () => JSON.stringify(own.map(w => ({ windowId: w.id, title: w.title, bounds: w.bounds })));
  const candidates = request.windowId === undefined ? own.filter(w => inside(w.bounds, at(w.bounds, request.from))) : own.filter(w => w.id === request.windowId);
  if (candidates.length !== 1) throw new Error(`drag target is ${candidates.length > 1 ? 'ambiguous; supply windowId' : 'unavailable; read the window again'}. Windows: ${list()}`);
  return candidates[0];
}
function axWindow(pid, window) {
  const proc = Application('System Events').processes.whose({ unixId: pid })[0];
  const all = proc.windows();
  const byId = all.filter(w => attempt(() => w.attributes.byName('AXWindowNumber').value(), null) === window.id);
  const matches = byId.length ? byId : all.filter(w =>
    attempt(() => sameBounds(frame(w), window.bounds) && (!window.title || w.name() === window.title), false));
  if (matches.length !== 1) throw new Error(`cannot match window ${window.id} to one AX window; nothing was pressed`);
  return matches[0];
}
function content(win, bounds) {
  const areas = [], toolbars = [];
  let visited = 0;
  const walk = (el, parent, depth) => {
    if (depth > 12 || ++visited > 300) throw new Error('AX content scan exceeded its depth or 300-element limit');
    const role = attempt(() => el.role(), '');
    const own = attempt(() => frame(el), null);
    const visible = own ? clip(parent, own) : parent;
    if (role === 'AXToolbar') { if (own) toolbars.push(visible); return; }
    if (/^AX(?:Close|Minimize|Zoom|FullScreen|TitleBar)/.test(attempt(() => el.subrole(), ''))) return;
    const body = ['AXScrollArea', 'AXTextArea', 'AXWebArea', 'AXTable', 'AXOutline', 'AXImage', 'AXSplitGroup'];
    // A group covering the whole frame is not evidence of a content area.
    if (own && (body.includes(role) || (role === 'AXGroup' && own.Y > bounds.Y))) areas.push({ el, role, bounds: visible });
    for (const child of attempt(() => el.uiElements(), [])) walk(child, visible, depth + 1);
  };
  walk(win, bounds, 0);
  return { areas, toolbars };
}
function validatePoints(info, bounds, from, to, isTextEdit) {
  const start = at(bounds, from), end = at(bounds, to);
  for (const [name, point] of [['from', start], ['to', end]]) {
    if (!inside(bounds, point) || info.toolbars.some(b => inside(b, point)) || !info.areas.some(a => inside(a.bounds, point))) {
      throw new Error(`${name} is outside the window content area (title bar, toolbar or frame); nothing was pressed`);
    }
  }
  let text = null;
  if (isTextEdit) {
    const areas = info.areas.filter(a => a.role === 'AXTextArea' && inside(a.bounds, start));
    if (areas.length !== 1 || !inside(areas[0].bounds, end)) throw new Error('TextEdit from and to must be inside the same visible text area; nothing was pressed');
    const el = areas[0].el;
    const value = el.value(), selected = el.attributes.byName('AXSelectedText').value();
    if (typeof value !== 'string' || typeof selected !== 'string' || !selected.trim()) throw new Error('Select non-whitespace TextEdit text in this window before dragging; nothing was pressed');
    text = { el, text: value, selected };
  }
  return { start, end, text };
}

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

function finishTextDrop(snapshot, window) {
  if (!snapshot) return { spaceInserted: false };
  const name = `TextEdit window ${window.id} (${window.title})`;
  if (snapshot.el.value() === snapshot.text) return {
    spaceInserted: false, textChanged: false,
    error: `Text in ${name} is unchanged after dragging; read it before continuing.`,
  };
  const lost = () => ({ lostText: true, error: `Dragged text disappeared from ${name} and was not inserted in its text area. Press Cmd+Z in that window now, then read it again before continuing.` });
  // A deletion can join surrounding fragments into the selected word. Check
  // its characters as well as presence. Smart deletion may change spaces.
  const characters = text => {
    const counts = new Map();
    for (const c of text) if (!/\s/u.test(c)) counts.set(c, (counts.get(c) || 0) + 1);
    return counts;
  };
  const before = characters(snapshot.text), selected = characters(snapshot.selected);
  const verify = () => {
    const after = snapshot.el.value();
    if (typeof after !== 'string') throw new Error(`cannot verify the drop in ${name}; read that window before continuing`);
    const counts = characters(after);
    return !after.replace(/\s/gu, '').includes(snapshot.selected.replace(/\s/gu, '')) ||
      [...selected.keys()].some(c => (counts.get(c) || 0) < before.get(c));
  };
  if (verify()) return lost();
  const outcome = repairTextDrop(snapshot);
  if (verify()) return lost();
  if (outcome.spacingError) return { ...outcome, error: outcome.spacingError };
  return outcome;
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

function backgroundBuilder() {
  // JXA exposes NSEvent.CGEvent as an opaque Ref that its CF function bridge
  // cannot consume. A typed message send returns the same pointer as a CF id.
  ObjC.bindFunction('objc_msgSend', ['id', ['id', 'selector']]);
  // Named CGPoint aliases silently bind as scalars in JXA. Encode both fields.
  const pointType = '{CGPoint="x"d"y"d}';
  ObjC.bindFunction('CGEventSetWindowLocation', ['void', ['id', pointType]]);
  ObjC.bindFunction('CGEventGetWindowLocation', [pointType, ['id']]);
  return (type, point, main, command) => {
    const b = main.bounds, local = $.CGPointMake(point.x - b.X, point.y - b.Y);
    const native = $.NSEvent.mouseEventWithTypeLocationModifierFlagsTimestampWindowNumberContextEventNumberClickCountPressure(
      type, $.CGPointMake(local.x, b.Height - local.y), command ? 1 << 20 : 0,
      $.NSProcessInfo.processInfo.systemUptime, main.id, null, 1, 1, type === 2 ? 0 : 1);
    const event = $.objc_msgSend(native, 'CGEvent');
    if ($.CGEventGetType(event) !== type) throw new Error('NSEvent CGEvent bridge failed');
    $.CGEventSetLocation(event, $.CGPointMake(point.x, point.y));
    $.CGEventSetWindowLocation(event, local);
    const read = $.CGEventGetWindowLocation(event);
    if (!read || Math.abs(read.x - local.x) > 0.5 || Math.abs(read.y - local.y) > 0.5 ||
        ![read.x, read.y].every(Number.isFinite)) throw new Error('CGEventSetWindowLocation did not retain the window coordinates');
    $.CGEventSetIntegerValueField(event, 7, 3); // window-local mouse subtype
    $.CGEventSetIntegerValueField(event, 1, 1); // click state
    $.CGEventSetIntegerValueField(event, 91, main.id);
    $.CGEventSetIntegerValueField(event, 92, main.id);
    return { native, event }; // retain the NSEvent until its CGEvent has posted
  };
}

function checkWindow(main, pid, win) {
  const list = windows(true);
  const current = list.find(w => w.id === main.id && w.pid === pid && w.layer === 0);
  if (!current || !sameBounds(current.bounds, main.bounds) || !sameBounds(frame(win), main.bounds)) {
    throw new Error('the chosen window moved or disappeared; read it again');
  }
  return list;
}

function raiseWindow(win) {
  attempt(() => { win.attributes.byName('AXMain').value = true; });
  win.actions.byName('AXRaise').perform();
}

function exposedEndpoints(list, main, points, sameAppOnly) {
  for (const [name, point] of [['from', points.start], ['to', points.end]]) {
    const top = list.find(w => inside(w.bounds, point) && !/Computer Use$/.test(w.owner) &&
      (!sameAppOnly || w.pid === main.pid));
    if (!top || top.id !== main.id || top.pid !== main.pid) throw new Error(`${name} is covered by another window; nothing was pressed`);
  }
}

function run(argv) {
  let previous = null, saved = null, pid = null, pressed = false, didPress = false, post = null, current = null;
  let path = 'none', fallbackReason = null;
  let backgroundSnapshot = null;
  const unchangedText = () => {
    if (backgroundSnapshot && (backgroundSnapshot.el.value() !== backgroundSnapshot.text ||
        backgroundSnapshot.el.attributes.byName('AXSelectedText').value() !== backgroundSnapshot.selected)) {
      throw new Error('text or selection changed before foreground fallback; foreground mouse-down was skipped, read the window again');
    }
  };
  try {
    const request = JSON.parse(argv[0]);
    const { app, from, to, holdMs = 500, steps = 25, settleMs = 1500 } = request;
    if (![from, to].every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) ||
        (request.windowId !== undefined && (!Number.isInteger(request.windowId) || request.windowId <= 0)) ||
        !Number.isInteger(steps) || steps < 1 || steps > 100 || !Number.isInteger(holdMs) || holdMs < 0 || holdMs > 5000 ||
        !Number.isInteger(settleMs) || settleMs < 0 || settleMs > 5000) throw new Error('invalid drag points, windowId or timing');
    const target = findApp(app);
    if (!target) throw new Error(`${app} isn't running`);
    pid = target.processIdentifier;
    const own = windows(true).filter(w => w.pid === pid && w.layer === 0);
    if (!own.length || (request.windowId !== undefined && !own.some(w => w.id === request.windowId))) {
      const offScreen = windows(false).filter(w => w.pid === pid && w.layer === 0 && (request.windowId === undefined || w.id === request.windowId));
      if (offScreen.length) throw new Error(`${app}'s window is off screen, on another desktop or Space (or hidden/minimized). Drag needs that window on screen; bring it to the current desktop first`);
      if (!own.length) throw new Error(`${app} has no window; open one on the current desktop before dragging`);
    }
    let main = resolveWindow(own, request);
    const win = axWindow(pid, main);
    let build;
    try { build = backgroundBuilder(); }
    catch (e) { fallbackReason = `background unavailable: ${e.message || e}`; }
    if (build) {
      previous = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      raiseWindow(win);
      delay(settleMs / 1000);
      checkWindow(main, pid, win);
      const points = validatePoints(content(win, main.bounds), main.bounds, from, to, ObjC.unwrap(target.bundleIdentifier) === 'com.apple.TextEdit');
      // Other apps may cover PID delivery, but another document of this app
      // must not receive the press. Check fresh own-app order at both ends.
      exposedEndpoints(checkWindow(main, pid, win), main, points, true);
      let sequence;
      try {
        const moves = Array.from({ length: steps }, (_, i) => ({
          x: points.start.x + (points.end.x - points.start.x) * (i + 1) / steps,
          y: points.start.y + (points.end.y - points.start.y) * (i + 1) / steps,
        }));
        // Prepare and validate every event, including the release, before down.
        // Keep the measured TextEdit modifier. Other apps, including Chess,
        // need an ordinary drag: Command can change the action's meaning.
        const event = (type, p) => build(type, p, main, !!points.text);
        sequence = [event(5, points.start), event(1, points.start),
          ...moves.map(p => event(6, p)), event(2, points.end)];
      } catch (e) { fallbackReason = `background unavailable: ${e.message || e}`; }
      if (sequence) {
        path = 'background';
        post = item => {
          $.CGEventSetTimestamp(item.event, $.NSProcessInfo.processInfo.systemUptime * 1e9);
          $.CGEventPostToPid(pid, item.event);
        };
        let postingError, releaseError;
        try {
          post(sequence[0]); delay(0.05);
          // Mark down before posting, so a posting exception still releases.
          pressed = true; didPress = true; current = sequence[sequence.length - 1];
          post(sequence[1]); delay(holdMs / 1000);
          for (const item of sequence.slice(2, -1)) { post(item); delay(0.02); }
          post(current); pressed = false;
        } catch (e) { postingError = String(e.message || e); }
        finally {
          if (pressed) {
            try { post(current); }
            catch (e) { releaseError = `background release failed: ${e.message || e}; read the window before continuing`; }
            pressed = false;
          }
        }
        delay(0.2);
        // An unreadable snapshot is not unchanged. Never repeat an uncertain or
        // changed edit, even if posting or the spacing repair failed.
        const after = points.text ? points.text.el.value() : null;
        if (points.text && typeof after !== 'string') throw new Error('cannot verify background text; read the window before continuing');
        if (releaseError) {
          const outcome = finishTextDrop(points.text, main);
          return JSON.stringify({ ok: false, path, app, windowId: main.id, ...outcome,
            error: [outcome.error, releaseError].filter(Boolean).join('; ') });
        }
        if (!points.text || after !== points.text.text) {
          const outcome = finishTextDrop(points.text, main);
          if (postingError && !outcome.error) outcome.error = postingError;
          return JSON.stringify({ ok: !outcome.error, app, windowId: main.id, from, to, holdMs, steps, path,
            textChanged: points.text ? true : null, deliveryVerified: !!points.text && !outcome.error, ...outcome });
        }
        fallbackReason = 'background text unchanged';
        backgroundSnapshot = points.text;
      }
    }
    unchangedText();
    path = 'foreground';
    const ws = $.NSWorkspace.sharedWorkspace;
    previous = previous || ws.frontmostApplication;
    saved = $.CGEventGetLocation($.CGEventCreate(null));
    target.activateWithOptions(0);
    // AXRaise alone can leave another stacked document as the app's main window.
    // Some apps expose AXMain as read-only, so coverage still decides whether
    // the raise succeeded. Never ignore a covering window of the same app.
    raiseWindow(win);
    // Right after the engine acts (say, selecting the text), a press that comes
    // at once doesn't take; 2 s later it does (2026-10-04). Wait for things to settle.
    delay(settleMs / 1000);
    main = windows(true).find(w => w.id === main.id && w.pid === pid && w.layer === 0);
    if (!main || !sameBounds(frame(win), main.bounds)) throw new Error('the chosen window changed or disappeared; read it again');
    const { start, end, text } = validatePoints(content(win, main.bounds), main.bounds, from, to, ObjC.unwrap(target.bundleIdentifier) === 'com.apple.TextEdit');
    // Match the exact window at both endpoints, even for another window of
    // the same app. The engine cursor overlay lets events through.
    const currentWindows = windows(true);
    const unchanged = currentWindows.find(w => w.id === main.id && w.pid === pid);
    if (!unchanged || !sameBounds(unchanged.bounds, main.bounds)) throw new Error('the chosen window moved during validation; read it again');
    exposedEndpoints(currentWindows, main, { start, end }, false);
    post = (type, p) => {
      const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(p.x, p.y), $.kCGMouseButtonLeft);
      $.CGEventSetIntegerValueField(e, 1, 1); // click state
      $.CGEventPost($.kCGHIDEventTap, e);
    };
    post($.kCGEventMouseMoved, start);
    current = start;
    delay(0.05);
    unchangedText();
    post($.kCGEventLeftMouseDown, start);
    pressed = true; didPress = true;
    delay(holdMs / 1000);
    for (let i = 1; i <= steps; i++) {
      current = { x: start.x + (end.x - start.x) * i / steps, y: start.y + (end.y - start.y) * i / steps };
      post($.kCGEventLeftMouseDragged, current);
      delay(0.02);
    }
    post($.kCGEventLeftMouseUp, end);
    pressed = false;
    delay(0.2);
    const outcome = finishTextDrop(text, main);
    return JSON.stringify({ ok: !outcome.error, app, windowId: main.id, from, to, holdMs, steps, path, fallbackReason, ...outcome });
  } catch (e) {
    const message = String(e.message || e);
    return JSON.stringify({ ok: false, path, fallbackReason, error: message + (!didPress && !message.includes('nothing was pressed') ? '; nothing was pressed' : '') });
  } finally {
    if (pressed && post) attempt(() => post($.kCGEventLeftMouseUp, current));
    if (saved) attempt(() => $.CGWarpMouseCursorPosition(saved));
    if (previous && !previous.isNil() && previous.processIdentifier !== pid &&
        (path === 'foreground' || attempt(() => $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier, null) === pid)) {
      attempt(() => previous.activateWithOptions(0));
    }
  }
}
