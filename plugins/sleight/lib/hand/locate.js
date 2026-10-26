// The ghost hand's geometry for one call, read beside the engine call and never awaited by it
// (relay-hand.mjs). Read-only: no input, no raise, no focus change, never asks for trust.
//
//   osascript -l JavaScript locate.js '<json request>'
//   { app?, appId?, title?, windowNumber?, pid?, identities: { number: { role, id, description, title } }, focus? }
//   { bounds: { X, Y, Width, Height } } for turbo's browser window (browser-hand.mjs)
//
// Prints { ok, pid, window: { pid, windowId, bounds }, windows, displays, state?, elements, focused? }, every
// frame in global points with a top-left origin. windows is the on-screen list front to back, every layer, cut
// to those over the target window. state is minimized, hidden, side-stage (Stage Manager) or other-space.

ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');

const ELEMENT_LIMIT = 3000, WALK_MS = 400;

function cgWindows(onScreenOnly) {
  const options = onScreenOnly ? $.kCGWindowListOptionOnScreenOnly : $.kCGWindowListOptionAll;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options | $.kCGWindowListExcludeDesktopElements, 0));
  const out = [];
  for (let i = 0; i < Number(list.count); i++) {
    const w = list.objectAtIndex(i);
    out.push({ id: ObjC.unwrap(w.objectForKey('kCGWindowNumber')), pid: ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')),
      layer: ObjC.unwrap(w.objectForKey('kCGWindowLayer')), owner: ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')) || '',
      bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')) });
  }
  return out; // front to back
}
const sameBounds = (a, b) => !!a && !!b && ['X', 'Y', 'Width', 'Height'].every(k => Math.abs(a[k] - b[k]) < 0.5);
const overlaps = (a, b) => a.X < b.X + b.Width && b.X < a.X + a.Width && a.Y < b.Y + b.Height && b.Y < a.Y + a.Height;

function findApp(request) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  const matches = [];
  for (let i = 0; i < Number(apps.count); i++) {
    const a = apps.objectAtIndex(i);
    const pid = Number(a.processIdentifier), id = ObjC.unwrap(a.bundleIdentifier), name = ObjC.unwrap(a.localizedName);
    if (request.pid !== undefined ? pid === request.pid : (request.appId && id === request.appId) || name === request.app || id === request.app) matches.push(a);
  }
  return matches.length === 1 ? matches[0] : null;
}

// As window-identity.js: JXA's Ref('CGPoint') reads back as 0, so copy the struct through NSValue.
function axPair(value, type) {
  const bytes = $.NSMutableData.dataWithLength(16);
  if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
  const boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
  const s = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
  return type === 1 ? [s.x, s.y] : [s.width, s.height];
}
function attr(el, name) {
  const out = Ref();
  return Number($.AXUIElementCopyAttributeValue(el, $(name), out)) === 0 ? ObjC.castRefToObject(out[0]) : null;
}
const scalar = (el, name) => { const v = attr(el, name); return v === null ? null : ObjC.deepUnwrap(v); };
function frameOf(el) {
  const p = attr(el, 'AXPosition'), s = attr(el, 'AXSize');
  const position = p && axPair(p, 1), size = s && axPair(s, 2);
  if (!position || !size || ![...position, ...size].every(Number.isFinite) || size[0] <= 0 || size[1] <= 0) return null;
  return { X: position[0], Y: position[1], Width: size[0], Height: size[1] };
}
const list = value => value ? Array.from({ length: Number(value.count) }, (_, i) => value.objectAtIndex(i)) : [];

function displays() {
  const screens = list($.NSScreen.screens), rect = s => ObjC.deepUnwrap(s.frame);
  if (!screens.length) return [];
  const primary = rect(screens[0]);
  return screens.map(s => {
    const f = rect(s);
    return { X: f.origin.x, Y: primary.size.height - (f.origin.y + f.size.height), Width: f.size.width, Height: f.size.height };
  });
}

function stageManager() {
  try { return !!$.NSUserDefaults.alloc.initWithSuiteName('com.apple.WindowManager').boolForKey('GloballyEnabled'); } catch { return false; }
}

// drag.js's matchesIdentity, without the role when the tree's role name has no AX role here, and without its
// AXValue label binding: the owner allowed that for drag endpoints only (2026-10-19, CC8).
function matches(el, identity, role) {
  return (!identity.role || role === identity.role) &&
    (!identity.id || scalar(el, 'AXIdentifier') === identity.id) &&
    (!identity.description || scalar(el, 'AXDescription') === identity.description) &&
    (!identity.title || scalar(el, 'AXTitle') === identity.title || scalar(el, 'AXDescription') === identity.title);
}
// Each identity's frame when exactly one element in the window has it; others are left out. A walk cut short
// by its depth, element or time limit proves nothing unique, so it finds nothing.
function elements(win, identities, limit = ELEMENT_LIMIT, ms = WALK_MS) {
  const entries = Object.entries(identities ?? {}).map(([number, identity]) => ({ number, identity, found: [] }));
  if (!entries.length) return {};
  const started = Date.now();
  let visited = 0, truncated = false;
  const walk = (el, depth) => {
    if (truncated) return;
    if (depth >= 64 || ++visited > limit || Date.now() - started > ms) { truncated = true; return; }
    const role = scalar(el, 'AXRole');
    if (role === 'AXToolbar' && depth > 0) return;
    for (const entry of entries) if (entry.found.length < 2 && matches(el, entry.identity, role)) entry.found.push(el);
    for (const child of list(attr(el, 'AXChildren'))) walk(child, depth + 1);
  };
  walk(win, 0);
  const out = {};
  if (truncated) return out;
  for (const entry of entries) if (entry.found.length === 1) { const f = frameOf(entry.found[0]); if (f) out[entry.number] = f; }
  return out;
}

// Each helper owns a bounded bank. Recheck window state, bounds, cover and focus on every request.
// A changed line's identity replaces its old frame, even when the element number is unchanged.
// Frames expire within 500 ms: scrolling and layout changes need not change the window bounds or tree lines.
const geometryCache = new Map();
function cachedElements(pid, windowNumber, bounds, win, identities, versions = {}) {
  const key = JSON.stringify([pid, windowNumber, bounds.X, bounds.Y, bounds.Width, bounds.Height]);
  // A moved window must not revive an older geometry when it moves back.
  for (const [old, bank] of geometryCache) if (bank.pid === pid && bank.windowNumber === windowNumber && old !== key) geometryCache.delete(old);
  let bank = geometryCache.get(key);
  if (!bank) {
    if (geometryCache.size >= 32) geometryCache.delete(geometryCache.keys().next().value);
    bank = { pid, windowNumber, frames: new Map() }; geometryCache.set(key, bank);
  }
  const missing = {}, out = {}, at = Date.now();
  for (const [number, identity] of Object.entries(identities ?? {})) {
    const stamp = JSON.stringify([identity, versions[number]]), cached = bank.frames.get(number);
    if (cached?.stamp === stamp && at >= cached.at && at - cached.at < 500) out[number] = cached.frame;
    else { bank.frames.delete(number); missing[number] = identity; }
  }
  const found = Object.keys(missing).length ? elements(win, missing) : {};
  for (const [number, frame] of Object.entries(found)) {
    if (bank.frames.size >= 3000) bank.frames.delete(bank.frames.keys().next().value);
    bank.frames.set(number, { stamp: JSON.stringify([missing[number], versions[number]]), frame, at }); out[number] = frame;
  }
  return out;
}

function focusedElement(app, win) {
  const el = attr(app, 'AXFocusedUIElement');
  if (!el) return undefined;
  if (win && $.CFEqual(el, win)) return { window: true };
  let inWindow = false;
  const owner = attr(el, 'AXWindow');
  if (owner && win) inWindow = !!$.CFEqual(owner, win);
  else for (let node = el, depth = 0; node && depth < 40 && win && !inWindow; depth++) {
    inWindow = !!$.CFEqual(node, win);
    node = attr(node, 'AXParent');
  }
  const frame = frameOf(el);
  return { window: false, inWindow, ...(frame ? { frame } : {}), ...(attr(el, 'AXRole') === 'AXSecureTextField' ? { role: 'AXSecureTextField', secure: true } : {}) };
}

// Turbo's browser window, named by the frame its page reports (window.screenX, screenY, outerWidth, outerHeight):
// the one layer-0 window with those bounds, within a point. Window Server only, no Accessibility.
function byBounds(bounds) {
  const near = w => ['X', 'Y', 'Width', 'Height'].every(k => Math.abs(w.bounds?.[k] - bounds[k]) <= 1);
  const all = cgWindows(false).filter(w => w.layer === 0 && near(w)), onScreen = cgWindows(true);
  const shown = all.filter(w => onScreen.some(o => o.id === w.id));
  if (shown.length > 1) return { ok: false, error: 'several windows have these bounds' };
  if (shown.length === 1) {
    const cg = shown[0];
    return { ok: true, pid: cg.pid, window: { pid: cg.pid, windowId: cg.id, bounds: cg.bounds },
      windows: onScreen.filter(w => w.bounds && overlaps(w.bounds, cg.bounds)), displays: displays() };
  }
  return all.length ? { ok: true, state: stageManager() ? 'side-stage' : 'other-space' } : { ok: false, error: 'no window has these bounds' };
}

function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    if (request.bounds) return JSON.stringify(byBounds(request.bounds));
    if (!$.AXIsProcessTrusted()) return JSON.stringify({ ok: false, error: 'accessibility not granted' });
    const running = findApp(request);
    if (!running) return JSON.stringify({ ok: false, error: 'app not running or ambiguous' });
    const pid = Number(running.processIdentifier);
    if (running.hidden) return JSON.stringify({ ok: true, pid, state: 'hidden' });
    const app = $.AXUIElementCreateApplication(pid);
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.25)) !== 0) return JSON.stringify({ ok: false, error: 'AX deadline unavailable' });
    const own = cgWindows(false).filter(w => w.pid === pid && w.layer === 0);
    const axWindows = list(attr(app, 'AXWindows'));
    let cg, win;
    if (Number.isSafeInteger(request.windowNumber)) {
      cg = own.find(w => w.id === request.windowNumber);
      win = cg && axWindows.find(w => sameBounds(frameOf(w), cg.bounds) && (!request.title || scalar(w, 'AXTitle') === request.title));
    } else {
      const titled = axWindows.filter(w => scalar(w, 'AXTitle') === request.title);
      win = titled.length === 1 ? titled[0] : !request.title && axWindows.length === 1 ? axWindows[0] : undefined;
      const bounds = win && frameOf(win), same = bounds ? own.filter(w => sameBounds(w.bounds, bounds)) : [];
      cg = same.length === 1 ? same[0] : undefined;
    }
    const onScreen = cgWindows(true);
    const shown = cg && onScreen.some(w => w.id === cg.id);
    // Accessibility lists only this Space's windows for most apps: an unmatched window with all the app's
    // windows off screen is on another Space or, with Stage Manager on, in its side stage. An unmatched
    // window while others show has no geometry, and the planner says so.
    const offSpace = cg ? !shown : own.length > 0 && own.every(w => !onScreen.some(o => o.id === w.id));
    const state = win && scalar(win, 'AXMinimized') === true ? 'minimized' : offSpace ? (stageManager() ? 'side-stage' : 'other-space') : undefined;
    if (state || !cg || !win) return JSON.stringify({ ok: true, pid, ...(state ? { state } : {}) });
    return JSON.stringify({ ok: true, pid, window: { pid, windowId: cg.id, bounds: cg.bounds },
      windows: onScreen.filter(w => w.bounds && overlaps(w.bounds, cg.bounds)), displays: displays(),
      elements: cachedElements(pid, cg.id, cg.bounds, win, request.identities, request.versions), ...(request.focus ? { focused: focusedElement(app, win) } : {}) });
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message || error) }); }
}
