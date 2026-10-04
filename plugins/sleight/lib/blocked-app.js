// Driving the apps OpenAI's engine refuses (terminals, OpenAI's own apps)
// through macOS Accessibility and posted events — sleight's own path, the one
// menu_bar and drag use. This file never touches the engine or its helper; the
// relay asks the user before any call (see launch.mjs and blocked-apps.mjs).
//
//   osascript -l JavaScript blocked-app.js '<json request>'
//
// Requests (app is a name, bundle ID or path; settings is a RegExp source the
// relay passes in):
//   { op: "read", app, shot? }               the window's numbered elements, plus a
//                                            screenshot of it saved to shot
//   { op: "click", app, element? | point? }  AXPress the element, else a real click
//                                            at the point (window-relative, like the
//                                            engine's screenshot frame)
//   { op: "type", app, text }                keystrokes, app in front
//   { op: "key", app, key }                  one key or chord ("Return", "super+v")
//   { op: "scroll", app, amount }            scroll lines, positive up
//
// Every reply is one JSON object. Reads, element presses and scrolls stay in
// the background; typing, keys and point clicks need the app in front, so
// they bring it forward and put the previous front app (and the pointer) back,
// as drag does, and say so in the reply.

ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

const se = Application('System Events');

function attempt(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

// The same refused-app rule the relay checks (blocked-apps.mjs), repeated here
// as the last check before anything is driven. A bundle ID decides; a bare
// name matches only the known list.
const TERMINALS = { 'com.apple.terminal': 'Terminal', 'com.googlecode.iterm2': 'iTerm2' };
const TERMINAL_NAMES = { terminal: 'com.apple.terminal', iterm2: 'com.googlecode.iterm2', iterm: 'com.googlecode.iterm2' };
const OPENAI_NAMES = ['chatgpt', 'codex', 'atlas'];
function blockedEntry(...wanted) {
  const key = value => (value ?? '').toString().trim().toLowerCase().replace(/^.*\//, '').replace(/\.app$/, '').replace(/\s+beta$/, '');
  const name = key(wanted[0]);
  const bundle = key(wanted[1]);
  if (bundle.startsWith('com.openai.') || (!bundle && OPENAI_NAMES.includes(name))) return { openai: true };
  if (TERMINALS[bundle] || (!bundle && TERMINAL_NAMES[name])) return { terminal: true };
  return undefined;
}

// The bundle IDs a wanted identifier can denote: a known name maps to its
// bundle, an OpenAI name or bundle stands for the com.openai. prefix, and
// anything else is matched literally (a bundle ID, path or exact name).
function wantedBundles(wanted) {
  const key = value => (value ?? '').toString().trim().toLowerCase().replace(/^.*\//, '').replace(/\.app$/, '').replace(/\s+beta$/, '');
  const name = key(wanted);
  const bare = (wanted ?? '').toString().trim().toLowerCase();
  if (bare.startsWith('com.openai.') || OPENAI_NAMES.includes(name)) return ['com.openai.'];
  if (TERMINAL_NAMES[name]) return [TERMINAL_NAMES[name]];
  return [bare];
}

function findApp(wanted) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  let seen = false;
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    const id = ObjC.unwrap(a.bundleIdentifier);
    const path = a.bundleURL.isNil() ? null : ObjC.unwrap(a.bundleURL.path);
    const name = ObjC.unwrap(a.localizedName);
    // The wanted identifier must pick this app, and the app's own identity
    // (name plus bundle) must be refused. A name rule never fires for an app
    // whose bundle says otherwise.
    const picked = [id, name, path].includes(wanted) ||
      wantedBundles(wanted).some(b => b === 'com.openai.' ? String(id ?? '').startsWith(b) : b === String(id ?? ''));
    if (picked) {
      if (blockedEntry(name, id)) return { ref: a, name, id, pid: Number(a.processIdentifier) };
      seen = true;
    }
  }
  throw new Error(seen
    ? `${wanted} is not one of the apps the engine refuses; use the js tool for it`
    : `${wanted} isn't running`);
}

function frontWindow(proc, appName) {
  let windows;
  try {
    windows = proc.windows();
  } catch (e) {
    // -1719 and -25211: the app running this has no Accessibility permission.
    if (/-1719|-25211|assistive/i.test(String(e.message))) throw e;
    windows = [];
  }
  const win = attempt(() => windows[0], null);
  if (!win) throw new Error(`${appName} has no open window`);
  return win;
}

// Settings and preferences windows of these apps are never driven, read or
// otherwise, so Claude cannot reach the apps' own approval or safety settings.
function refuseSettings(win, pattern) {
  const title = attempt(() => win.title(), '') ?? '';
  if (pattern && new RegExp(pattern).test(title.trim())) {
    const err = new Error(`refused: "${title}" is a settings or preferences window`);
    err.settings = true;
    throw err;
  }
  return title;
}

// The window as a flat list of the elements worth acting on, numbered, in the
// engine's style. Long values (a terminal's scrollback) keep their head and
// their tail, so the end of a terminal buffer stays readable.
const ACTABLE = ['AXButton', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXMenuButton', 'AXSlider',
  'AXTextField', 'AXTextArea', 'AXStaticText', 'AXLink', 'AXSwitch', 'AXMenu', 'AXMenuItem', 'AXTabGroup'];
const cut = (value, at) => {
  const text = String(value ?? '');
  if (text.length <= at) return text;
  const tail = text.length > at * 2 ? `…${text.slice(-Math.floor(at / 2))}` : '';
  return `${text.slice(0, at)}…(${text.length})${tail}`;
};

function elementText(el) {
  const parts = [attempt(() => el.title(), ''), attempt(() => el.description(), ''), cut(attempt(() => el.value(), ''), 160),
    attempt(() => el.help(), ''), attempt(() => el.attributes.byName('AXIdentifier').value(), '')]
    .filter(t => t && !['group', 'text', 'button', 'image', 'scroll area', 'slider'].includes(t));
  return parts.join(' · ');
}

function walkElements(win, visit) {
  let count = 0;
  let done = false;
  const walk = (el, depth) => {
    if (done || depth > 12 || count > 300) return;
    const role = attempt(() => el.role(), '');
    if (ACTABLE.includes(role)) {
      count++;
      if (visit(el, role, count - 1) === false) { done = true; return; }
    }
    for (const kid of attempt(() => el.uiElements(), [])) walk(kid, depth + 1);
  };
  walk(win, 0);
}

function readElements(win) {
  const out = [];
  walkElements(win, (el, role, index) => {
    out.push({ element: index, role: role.replace(/^AX/, ''), text: elementText(el) });
  });
  return out;
}

function elementAt(win, index) {
  let target = null;
  let role = null;
  walkElements(win, (el, found, at) => {
    if (at === index) { target = el; role = found; return false; }
  });
  if (!target) throw new Error(`no element ${index}; read the window again for current numbers`);
  return { target, role };
}

function pressElement(el) {
  const press = attempt(() => el.actions.byName('AXPress'), null);
  if (press) { press.perform(); return 'AXPress'; }
  el.click();
  return 'accessibility click';
}

function windowGeometry(win) {
  const position = attempt(() => win.position(), null);
  const size = attempt(() => win.size(), null);
  if (!position || !size) throw new Error('the window has no readable position; coordinate actions are unavailable');
  return { x: position[0], y: position[1], w: size[0], h: size[1] };
}

function windowsOnScreen() {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    out.push({
      id: ObjC.unwrap(w.objectForKey('kCGWindowNumber')),
      owner: ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')),
      pid: ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')),
      layer: ObjC.unwrap(w.objectForKey('kCGWindowLayer')),
      bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')),
    });
  }
  return out; // front to back
}

const inside = (b, p) => p.x >= b.X && p.x < b.X + b.Width && p.y >= b.Y && p.y < b.Y + b.Height;

// Bring the app forward for one action, then put the front app and the
// pointer back (drag's pattern).
function foreground(app) {
  const ws = $.NSWorkspace.sharedWorkspace;
  const previous = ws.frontmostApplication;
  const previousName = previous.isNil() ? undefined : ObjC.unwrap(previous.localizedName);
  const saved = $.CGEventGetLocation($.CGEventCreate(null));
  app.ref.activateWithOptions(0);
  delay(0.4);
  return {
    fronted: true,
    putBack: previousName && previousName !== app.name ? previousName : undefined,
    yield: () => {
      $.CGWarpMouseCursorPosition(saved);
      if (!previous.isNil() && previous.processIdentifier !== app.pid) previous.activateWithOptions(0);
    },
  };
}

// The engine's cursor overlay lets clicks through, so it doesn't count (drag's rule).
function coveredByOther(app, at) {
  const top = windowsOnScreen().find(w => inside(w.bounds, at) && !/Computer Use$/.test(w.owner ?? ''));
  return top ? (top.pid !== app.pid ? top.owner : undefined) : 'no window';
}

function screenshot(geometry, pid, path) {
  if (!path) return undefined;
  const own = windowsOnScreen().find(w => w.pid === pid && w.layer === 0 && w.bounds &&
    Math.abs(w.bounds.X - geometry.x) < 8 && Math.abs(w.bounds.Y - geometry.y) < 8 &&
    Math.abs(w.bounds.Width - geometry.w) < 8 && Math.abs(w.bounds.Height - geometry.h) < 8);
  if (!own) return undefined;
  const shell = Application.currentApplication();
  shell.includeStandardAdditions = true;
  const quoted = `"${path.replace(/(["\\$])/g, '\\$1')}"`;
  return attempt(() => shell.doShellScript(`/usr/sbin/screencapture -x -l ${own.id} ${quoted}`), null) ? path : undefined;
}

const KEYS = { return: 36, enter: 36, tab: 48, escape: 53, delete: 51, forwarddelete: 117, space: 49,
  up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
const MODIFIERS = { super: 'command down', cmd: 'command down', command: 'command down', ctrl: 'control down',
  control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down' };

// Parses without sending, so a bad key name can't act from the wrong app.
function parseKey(key) {
  const parts = String(key).split('+').map(p => p.trim()).filter(Boolean);
  const main = parts.pop();
  if (!main) throw new Error(`no key in "${key}"`);
  const using = {};
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) throw new Error(`unknown modifier "${part}"`);
    using[mod] = true;
  }
  const code = KEYS[main.toLowerCase()];
  if (code !== undefined) return { code, using };
  if (main.length === 1) return { char: main, using };
  throw new Error(`unknown key "${main}"`);
}

function performKey(parsed) {
  const using = Object.keys(parsed.using); // JXA wants a list: ['command down']
  if (parsed.code !== undefined) {
    if (using.length) se.keyCode(parsed.code, { using });
    else se.keyCode(parsed.code);
  } else if (using.length) se.keystroke(parsed.char, { using });
  else se.keystroke(parsed.char);
}

function run(argv) {
  let request;
  try {
    request = JSON.parse(argv[0]);
    const { op, app: wanted } = request;
    const app = findApp(wanted);
    const entry = blockedEntry(wanted, app.id) ?? blockedEntry(app.name, app.id);
    if (!entry) throw new Error(`${wanted} (${app.id}) is not one of the apps the engine refuses; use the js tool for it`);
    const proc = se.processes.whose({ unixId: app.pid })[0] ?? se.processes.byName(app.name);
    if (!proc || !attempt(() => proc.exists(), false)) throw new Error(`${app.name} has no accessibility process; is it running?`);
    const win = frontWindow(proc, app.name);
    const title = refuseSettings(win, request.settings);
    const window = { title };
    let result;
    if (op === 'read') {
      const geometry = windowGeometry(win);
      result = { app: app.name, window, elements: readElements(win), shot: screenshot(geometry, app.pid, request.shot) };
    } else if (op === 'click' && request.element !== undefined) {
      if (request.point !== undefined) throw new Error('click takes element or point, not both');
      const { target, role } = elementAt(win, request.element);
      const label = elementText(target);
      const via = pressElement(target);
      delay(0.3);
      result = { app: app.name, clicked: request.element, via, window, elements: readElements(win),
        ...(label ? { clickedLabel: label } : {}), ...(role ? { clickedRole: role.replace(/^AX/, '') } : {}) };
    } else if (op === 'click' && request.point) {
      const [px, py] = request.point;
      if (![px, py].every(n => typeof n === 'number' && n >= 0)) throw new Error('point must be window-relative [x, y]');
      const geometry = windowGeometry(win);
      const at = { x: geometry.x + px, y: geometry.y + py };
      const front = foreground(app);
      try {
        const cover = coveredByOther(app, at);
        if (cover) throw new Error(`the point isn't on ${app.name}'s window (${cover} covers it); nothing was pressed`);
        const post = (type, p) => {
          const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(p.x, p.y), $.kCGMouseButtonLeft);
          $.CGEventSetIntegerValueField(e, 1, 1); // click state
          $.CGEventPost($.kCGHIDEventTap, e);
        };
        post($.kCGEventMouseMoved, at);
        delay(0.05);
        post($.kCGEventLeftMouseDown, at);
        delay(0.06);
        post($.kCGEventLeftMouseUp, at);
        delay(0.2);
      } finally { front.yield(); }
      result = { app: app.name, clicked: request.point, via: 'pointer', window, elements: readElements(win),
        fronted: true, putBack: front.putBack };
    } else if (op === 'type') {
      if (typeof request.text !== 'string') throw new Error('type needs text');
      const front = foreground(app);
      try {
        // System Events' keystroke doesn't act on an embedded newline in
        // Terminal, so each newline becomes one Return key press.
        request.text.split('\n').forEach((part, i) => {
          if (i) se.keyCode(36);
          if (part) se.keystroke(part);
        });
      } finally { front.yield(); }
      result = { app: app.name, typed: request.text.length, window, fronted: true, putBack: front.putBack };
    } else if (op === 'key') {
      const parsed = parseKey(request.key);
      const front = foreground(app);
      try { performKey(parsed); } finally { front.yield(); }
      result = { app: app.name, key: String(request.key), window, fronted: true, putBack: front.putBack };
    } else if (op === 'scroll') {
      const amount = typeof request.amount === 'number' ? Math.trunc(request.amount) : 3;
      const event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, -amount);
      $.CGEventPostToPid(app.pid, event);
      result = { app: app.name, scrolled: amount, window };
    } else {
      throw new Error(`unknown op ${op}`);
    }
    return JSON.stringify({ ok: true, ...result });
  } catch (e) {
    const message = String(e.message || e);
    // -1719 and -25211: the app running this has no Accessibility permission.
    const access = /-1719|-25211|assistive/.test(message);
    return JSON.stringify({ ok: false, error: message, ...(e.settings ? { settings: true } : {}),
      ...(access ? { accessibility: true } : {}) });
  }
}
