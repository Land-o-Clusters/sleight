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

// The person at the Mac. The foreground path takes the pointer and keyboard
// focus for a few seconds, and keys typed then land in the target app: a
// space the owner typed into Claude went into TextEdit's selection mid-drag
// (2026-10-08). So it starts only after IDLE_S without any input, waits up to
// WAIT_S for that, and checks for keys typed once it has taken focus.
const IDLE_S = 2, WAIT_S = 10;
const sinceInput = type => $.CGEventSourceSecondsSinceLastEventType(1, type); // HID system state
function waitForIdle() {
  for (let waited = 0; ;) {
    const idle = sinceInput(0xFFFFFFFF); // any input
    if (idle >= IDLE_S) return;
    const step = Math.max(0.2, IDLE_S - idle);
    if (waited + step > WAIT_S) {
      throw new Error(`the person at the Mac kept typing or using the mouse for ${WAIT_S} s, and a foreground drag would take their pointer and keyboard focus; nothing was pressed. Tell the user, and retry when they've paused, or ask them to uncover the drop point so the drag can run in the background`);
    }
    delay(step);
    waited += step;
  }
}
const typedSince = startedAt => sinceInput(10) <= (Date.now() - startedAt) / 1000; // key down

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
// Claude reads from and to off the engine's screenshot, which is in pixels: 1312×844 for a
// 656×422-point TextEdit window on a Retina display (2026-10-08). Taken as points, they
// landed a line below the text, and 3 of Claude's first drags per run changed nothing.
// The relay passes the size of the app's latest engine screenshot; a size that doesn't
// match this window's shape is from another window and is ignored.
function screenshotScale(request, bounds, title) {
  const own = request.screenshots && Object.hasOwn(request.screenshots, title ?? '') ? request.screenshots[title ?? ''] : undefined;
  const s = own ?? request.screenshot;
  if (!Array.isArray(s) || s.length !== 2 || !s.every(n => Number.isFinite(n) && n > 0)) return null;
  const x = s[0] / bounds.Width, y = s[1] / bounds.Height;
  return Math.abs(x - y) <= 0.03 * Math.max(x, y) && x >= 0.25 && x <= 4 ? { x, y } : null;
}
const toPoints = (p, scale) => scale ? [p[0] / scale.x, p[1] / scale.y] : p;
function resolveWindow(own, request) {
  const list = () => JSON.stringify(own.map(w => ({ windowId: w.id, title: w.title, bounds: w.bounds })));
  const candidates = request.windowId === undefined
    ? own.filter(w => inside(w.bounds, at(w.bounds, toPoints(request.from, screenshotScale(request, w.bounds, w.title)))))
    : own.filter(w => w.id === request.windowId);
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

// The text area under a screen point, through the Accessibility C API, which
// can map a point to a character and write text without the pointer or focus.
// JXA can't pass struct pointers, so AXValues are built from an NSValue's bytes.
function axTextArea(pid, point) {
  ObjC.import('ApplicationServices');
  ObjC.bindFunction('malloc', ['void*', ['unsigned long']]);
  ObjC.bindFunction('free', ['void', ['void*']]);
  ObjC.bindFunction('AXValueCreate', ['id', ['int', 'void*']]);
  const axValue = (type, nsvalue) => { const buf = $.malloc(32); try { nsvalue.getValue(buf); return $.AXValueCreate(type, buf); } finally { $.free(buf); } };
  const range = (location, length) => axValue(4, $.NSValue.valueWithRange($.NSMakeRange(location, length)));
  const described = ref => ObjC.unwrap(ObjC.castRefToObject(ref).description);
  const get = (el, name) => { const out = Ref(); const err = $.AXUIElementCopyAttributeValue(el, $(name), out); if (err) throw new Error(`AX ${name} failed (${err})`); return out[0]; };
  const ask = (el, name, arg) => { const out = Ref(); const err = $.AXUIElementCopyParameterizedAttributeValue(el, $(name), arg, out); if (err) throw new Error(`AX ${name} failed (${err})`); return out[0]; };
  const set = (el, name, v) => { const err = $.AXUIElementSetAttributeValue(el, $(name), v); if (err) throw new Error(`AX write of ${name} failed (${err})`); };
  const app = $.AXUIElementCreateApplication(pid);
  const hit = Ref();
  // An app element hit-tests only that app's windows, so a covering app doesn't matter.
  if ($.AXUIElementCopyElementAtPosition(app, point.x, point.y, hit)) throw new Error('no accessibility element at the drop point');
  const el = hit[0];
  if (ObjC.unwrap(ObjC.castRefToObject(get(el, 'AXRole'))) !== 'AXTextArea') throw new Error('the drop point is not in a text area');
  const rangeOf = ref => { const m = /location:(\d+) length:(\d+)/.exec(described(ref)); if (!m) throw new Error('unreadable AX range'); return { location: +m[1], length: +m[2] }; };
  const rect = index => {
    const m = /x:([-\d.]+) y:([-\d.]+) w:([-\d.]+) h:([-\d.]+)/.exec(described(ask(el, 'AXBoundsForRange', range(index, 1))));
    return m && { X: +m[1], Y: +m[2], Width: +m[3], Height: +m[4] };
  };
  return {
    value: () => ObjC.unwrap(ObjC.castRefToObject(get(el, 'AXValue'))),
    selection: () => rangeOf(get(el, 'AXSelectedTextRange')),
    indexAt: p => rangeOf(ask(el, 'AXRangeForPosition', axValue(1, $.NSValue.valueWithPoint($.NSMakePoint(p.x, p.y))))).location,
    rect,
    lineEnd: index => {
      const line = ObjC.unwrap(ObjC.castRefToObject(ask(el, 'AXLineForIndex', $(index))));
      const r = rangeOf(ask(el, 'AXRangeForLine', $(line)));
      return r.location + r.length;
    },
    replace: (location, length, text) => { set(el, 'AXSelectedTextRange', range(location, length)); set(el, 'AXSelectedText', $(text)); },
    select: (location, length) => set(el, 'AXSelectedTextRange', range(location, length)),
  };
}

// Where text dropped at a point lands: before or after the character under it,
// or at the end of its line when the point is past the line's last character
// (AXRangeForPosition answers 0 there).
function dropIndex(area, p, text) {
  const onRow = r => r && p.y >= r.Y && p.y < r.Y + r.Height;
  const index = area.indexAt(p), r = area.rect(index);
  if (onRow(r) && p.x >= r.X && p.x < r.X + r.Width) return p.x < r.X + r.Width / 2 ? index : index + 1;
  for (let x = p.x - 4; x >= p.x - 600; x -= 4) {
    const i = area.indexAt({ x, y: p.y }), q = area.rect(i);
    if (onRow(q) && x >= q.X && x < q.X + q.Width) {
      const end = area.lineEnd(i);
      return end > 0 && text[end - 1] === '\n' ? end - 1 : end;
    }
  }
  throw new Error('cannot find where the drop point falls in the text; nothing was changed');
}

// Moves the selected text to the drop point the way TextEdit's own drag does:
// one space comes out with a word at the source, and one goes in at the drop
// when the word would touch another. Checks the whole result, and on a mismatch
// says to undo.
function accessibilityMove(area, snapshot, end, window) {
  const before = area.value(), sel = area.selection();
  if (before !== snapshot.text || before.slice(sel.location, sel.location + sel.length) !== snapshot.selected) {
    throw new Error('the text or selection changed before the move; nothing was changed, read the window again');
  }
  const word = snapshot.selected, src = sel.location, srcEnd = src + sel.length;
  const dest = dropIndex(area, end, before);
  if (dest >= src && dest <= srcEnd) throw new Error('the drop point is inside the selection; nothing was changed');
  const isWord = /^[\p{L}\p{N}]/u.test(word) && /[\p{L}\p{N}]$/u.test(word);
  // Source span, with one space when the word leaves two side by side or one at a line edge.
  let cutFrom = src, cutTo = srcEnd;
  if (isWord) {
    const left = before[src - 1], right = before[srcEnd];
    if (right === ' ' && (left === undefined || left === '\n' || left === ' ')) cutTo++;
    else if (left === ' ' && (right === undefined || right === '\n' || right === ' ')) cutFrom--;
  }
  const leftOfDrop = before[dest - 1], rightOfDrop = before[dest];
  const touches = c => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  const insert = (isWord && touches(leftOfDrop) ? ' ' : '') + word + (isWord && touches(rightOfDrop) ? ' ' : '');
  const expected = dest > srcEnd
    ? before.slice(0, cutFrom) + before.slice(cutTo, dest) + insert + before.slice(dest)
    : before.slice(0, dest) + insert + before.slice(dest, cutFrom) + before.slice(cutTo);
  // The later edit first, so the earlier one's indices still hold.
  const edits = dest > srcEnd ? [[dest, 0, insert], [cutFrom, cutTo - cutFrom, '']] : [[cutFrom, cutTo - cutFrom, ''], [dest, 0, insert]];
  let after;
  try {
    area.replace(...edits[0]);
  } catch (e) {
    after = attempt(() => area.value(), null);
    if (after === before) throw e; // nothing changed, so another path may try
  }
  if (after === undefined) {
    try { area.replace(...edits[1]); } catch (_) {}
    after = attempt(() => area.value(), null);
  }
  if (after !== expected) {
    return { lostText: typeof after !== 'string' || after.replace(/\s/gu, '').length < before.replace(/\s/gu, '').length,
      error: `The text in TextEdit window ${window.id} (${window.title}) isn't what the move should have made. Press Cmd+Z twice in that window, then read it again before continuing.` };
  }
  const movedAt = after.indexOf(word, dest > srcEnd ? dest - (cutTo - cutFrom) : dest);
  attempt(() => area.select(movedAt, word.length));
  return { textChanged: true, spaceInserted: insert !== word };
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

// The other app on top at either drag point, or null when the window is exposed at both.
function coveringApp(list, main, points) {
  for (const point of [points.start, points.end]) {
    const top = list.find(w => w.layer === 0 && inside(w.bounds, point) && !/Computer Use$/.test(w.owner));
    if (top && top.pid !== main.pid) return top.owner || 'another app';
  }
  return null;
}

function run(argv) {
  let previous = null, saved = null, pid = null, pressed = false, didPress = false, post = null, current = null;
  let path = 'none', fallbackReason = null, units = {};
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
      if (offScreen.length) throw new Error(`${app}'s window is off screen, on another desktop or Space (or hidden/minimized); nothing was pressed. Ask the user to show and unminimize this exact window on the current desktop. Drag needs it on screen. Then acquire the app again, take a fresh window screenshot, and use its current windowId and coordinates. Do not retry the old drag or switch to another window`);
      if (!own.length) throw new Error(`${app} has no window; open one on the current desktop before dragging`);
    }
    let main = resolveWindow(own, request);
    const scale = screenshotScale(request, main.bounds, main.title);
    const pointFrom = toPoints(from, scale), pointTo = toPoints(to, scale);
    units = scale ? { screenshotScale: Math.round(scale.x * 1000) / 1000 }
      : { coordinates: request.screenshot ? 'window points: the latest screenshot is of another window size' : 'window points: no engine screenshot of this app yet' };
    const win = axWindow(pid, main);
    let build;
    try { build = backgroundBuilder(); }
    catch (e) { fallbackReason = `background unavailable: ${e.message || e}`; }
    if (build) {
      previous = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      raiseWindow(win);
      delay(settleMs / 1000);
      checkWindow(main, pid, win);
      const points = validatePoints(content(win, main.bounds), main.bounds, pointFrom, pointTo, ObjC.unwrap(target.bundleIdentifier) === 'com.apple.TextEdit');
      // Another document of this app must not receive the press: check fresh
      // own-app order at both ends, then other apps' coverage below.
      const ordered = checkWindow(main, pid, win);
      exposedEndpoints(ordered, main, points, true);
      // The window server picks the drop target from what is on screen at the
      // drop point, so a window another app covers never receives a background
      // drop (0/3 covered, 3/3 uncovered, 2026-10-05). Go straight to foreground.
      const cover = coveringApp(ordered, main, points);
      if (cover) fallbackReason = `background skipped: ${cover} covers the window at the drag points`;
      // A text move can be done without any pointer at all: the foreground
      // path took the owner's pointer and focus mid-sentence (2026-10-08). It's off:
      // after an Accessibility text write, TextEdit's next Cmd+S deadlocked on its
      // save lock in 10 of 13 probe trials (2026-10-08). The tests turn it on.
      const byAccessibility = () => {
        if (globalThis.SLEIGHT_ACCESSIBILITY_MOVE !== true) return null;
        let area;
        try { area = axTextArea(pid, points.end); }
        catch (e) { fallbackReason += `; accessibility move unavailable: ${e.message || e}`; return null; }
        try {
          const outcome = accessibilityMove(area, points.text, points.end, main);
          path = 'accessibility';
          return JSON.stringify({ ok: !outcome.error, app, windowId: main.id, from, to, ...units, path, fallbackReason, ...outcome });
        } catch (e) {
          if (/changed before the move|inside the selection/.test(String(e.message))) throw e;
          fallbackReason += `; accessibility move failed: ${e.message || e}`;
          return null;
        }
      };
      if (cover && points.text) {
        const moved = byAccessibility();
        if (moved) return moved;
      }
      let sequence;
      if (!cover) try {
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
          return JSON.stringify({ ok: false, path, app, windowId: main.id, ...units, ...outcome,
            error: [outcome.error, releaseError].filter(Boolean).join('; ') });
        }
        if (!points.text || after !== points.text.text) {
          const outcome = finishTextDrop(points.text, main);
          if (postingError && !outcome.error) outcome.error = postingError;
          return JSON.stringify({ ok: !outcome.error, app, windowId: main.id, from, to, ...units, holdMs, steps, path,
            textChanged: points.text ? true : null, deliveryVerified: !!points.text && !outcome.error, ...outcome });
        }
        fallbackReason = 'background text unchanged';
        backgroundSnapshot = points.text;
        unchangedText();
        const moved = byAccessibility();
        if (moved) return moved;
      }
    }
    unchangedText();
    waitForIdle();
    unchangedText();
    path = 'foreground';
    const ws = $.NSWorkspace.sharedWorkspace;
    previous = previous || ws.frontmostApplication;
    saved = $.CGEventGetLocation($.CGEventCreate(null));
    const focusedAt = Date.now();
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
    const { start, end, text } = validatePoints(content(win, main.bounds), main.bounds, pointFrom, pointTo, ObjC.unwrap(target.bundleIdentifier) === 'com.apple.TextEdit');
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
    if (typedSince(focusedAt)) throw new Error(`the user typed while ${app} was in front, so their keys may have gone into it; nothing was pressed. Read the window again before continuing, and tell the user`);
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
    if (typedSince(focusedAt)) {
      outcome.error = [outcome.error, `the user typed during the drag while ${app} was in front, so their keys may have gone into it. Read the window again and tell the user`].filter(Boolean).join('; ');
    }
    return JSON.stringify({ ok: !outcome.error, app, windowId: main.id, from, to, ...units, holdMs, steps, path, fallbackReason, ...outcome });
  } catch (e) {
    const message = String(e.message || e);
    return JSON.stringify({ ok: false, path, fallbackReason, ...units, error: message + (!didPress && !message.includes('nothing was pressed') ? '; nothing was pressed' : '') });
  } finally {
    if (pressed && post) attempt(() => post($.kCGEventLeftMouseUp, current));
    if (saved) attempt(() => $.CGWarpMouseCursorPosition(saved));
    if (previous && !previous.isNil() && previous.processIdentifier !== pid &&
        (path === 'foreground' || attempt(() => $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier, null) === pid)) {
      attempt(() => previous.activateWithOptions(0));
    }
  }
}
