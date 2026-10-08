// Menu bar status items and notification banners, through System Events UI
// scripting. The computer-use engine leaves both out (its inventory has no
// Control Center or Notification Center), so sleight reads them itself. The
// relay asks the user before any call that touches an app (see launch.mjs).
//
//   osascript -l JavaScript menubar.js '<json request>'
//
// Prints one JSON object. Requests:
//   { op: "apps" }                          apps that have a status item
//   { op: "open", app, item? }              click an app's status item and read what opened
//                                           (a menu is read and closed again)
//   { op: "choose", app, path, item? }      open, then click the menu item at path (titles)
//   { op: "press", app, element }           click an element of the app's open popover window
//   { op: "close", app, item? }             close the app's open status menu
//   { op: "notifications" }                 the banners on screen, with their buttons
//   { op: "notify-press", banner, button }  press a banner's button by name

ObjC.import('Foundation');
ObjC.import('CoreGraphics');

const se = Application('System Events');

function attempt(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

function statusItems(app) {
  const proc = se.processes.byName(app);
  if (!attempt(() => proc.exists(), false)) throw new Error(`${app} isn't running`);
  const bars = proc.menuBars();
  if (bars.length < 2) throw new Error(`${app} has no status item in the menu bar. Its own menus (File, Edit, Format…) are in its tree: use js.`);
  return { proc, items: bars[1].menuBarItems() };
}

function pick(items, index = 0) {
  if (!items[index]) throw new Error(`no status item ${index}; this app has ${items.length}`);
  return items[index];
}

// A menu as nested titles. Separators are left out.
function readMenu(menu, depth = 0) {
  return menu.menuItems().flatMap(mi => {
    const title = attempt(() => mi.title(), '');
    if (!title) return [];
    const entry = { title };
    if (!attempt(() => mi.enabled(), true)) entry.disabled = true;
    const mark = attempt(() => mi.attributes.byName('AXMenuItemMarkChar').value(), null);
    if (mark) entry.checked = true;
    const sub = depth < 3 ? attempt(() => mi.menus(), []) : [];
    if (sub.length) entry.submenu = readMenu(sub[0], depth + 1);
    return [entry];
  });
}

// A window as a flat list of the elements worth acting on, numbered.
function readWindow(win) {
  const out = [];
  const origin = attempt(() => win.position(), null);
  const walk = (el, depth) => {
    if (depth > 12 || out.length > 300) return;
    const role = attempt(() => el.role(), '');
    // Icon-only buttons often have only a tooltip (help) or an identifier.
    const text = [attempt(() => el.title(), ''), attempt(() => el.description(), ''), attempt(() => String(el.value() ?? ''), ''),
      attempt(() => el.help(), ''), attempt(() => el.attributes.byName('AXIdentifier').value(), '')]
      .filter(t => t && !['group', 'text', 'button', 'image', 'scroll area'].includes(t));
    if (['AXButton', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXMenuButton', 'AXSlider', 'AXTextField', 'AXStaticText', 'AXLink', 'AXSwitch'].includes(role)) {
      const name = role.replace(/^AX/, '');
      const pos = attempt(() => el.position(), null);
      const positioned = Array.isArray(origin) && origin.length === 2 && Array.isArray(pos) && pos.length === 2 && [...origin, ...pos].every(Number.isFinite);
      const fallback = positioned ? `${name} at (${Math.round(pos[0] - origin[0])}, ${Math.round(pos[1] - origin[1])})` : `${name} ${out.length}`;
      out.push({ element: out.length, role: name, text: text.join(' · ') || fallback });
    }
    for (const kid of attempt(() => el.uiElements(), [])) walk(kid, depth + 1);
  };
  walk(win, 0);
  return out;
}

// A real click at the status item's center, then the pointer goes back where
// it was. SwiftUI's window-style menu bar items ignore the accessibility press.
function realClick(item) {
  // Wait, as drag and hover do, until the person at the Mac has paused for 2 s (up to
  // 10 s), so the click can't land in the middle of their own click or drag.
  for (let waited = 0; $.CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF) < 2; waited += 0.5) {
    if (waited >= 10) throw new Error('the person at the Mac kept typing or using the mouse for 10 s, and this icon needs a real click; nothing was clicked. Tell the user, and retry when they have paused');
    delay(0.5);
  }
  const pos = item.position();
  const size = item.size();
  const point = $.CGPointMake(pos[0] + size[0] / 2, pos[1] + size[1] / 2);
  const saved = $.CGEventGetLocation($.CGEventCreate(null));
  for (const type of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, point, $.kCGMouseButtonLeft));
  }
  $.CGWarpMouseCursorPosition(saved);
}

function waitForWindow(proc, before, seconds) {
  for (let i = 0; i < seconds * 10; i++) {
    delay(0.1);
    if (popoverWindows(proc).length > before) return true;
  }
  return false;
}

function popoverWindows(proc) {
  return proc.windows().filter(w => attempt(() => w.subrole(), '') !== 'AXStandardWindow');
}

function open(app, itemIndex, keepOpen = false) {
  const { proc, items } = statusItems(app);
  const item = pick(items, itemIndex);
  const before = popoverWindows(proc).length;
  // A classic menu is listed under the item even while closed, so it can be
  // opened and read through accessibility. Anything else may be a window.
  const hasMenu = attempt(() => item.menus().length, 0) > 0;
  item.click();
  if (!hasMenu && !waitForWindow(proc, before, 0.6)) {
    realClick(item);
    waitForWindow(proc, before, 1.5);
  }
  const menus = hasMenu ? attempt(() => item.menus(), []) : [];
  if (menus.length) {
    // An open menu holds the user's keyboard and mouse, so read it and close it.
    // choose opens it again and clicks in one go.
    const menu = readMenu(menus[0]);
    if (!keepOpen) attempt(() => menus[0].actions.byName('AXCancel').perform());
    return { app, opened: 'menu', menu };
  }
  const wins = popoverWindows(proc);
  if (wins.length) return { app, opened: 'window', elements: readWindow(wins[wins.length - 1]) };
  return { app, opened: 'nothing visible' };
}

function choose(app, path, itemIndex) {
  const opened = open(app, itemIndex, true);
  if (opened.opened !== 'menu') throw new Error(`${app}'s status item opened a ${opened.opened}, not a menu`);
  const { items } = statusItems(app);
  let menu = pick(items, itemIndex).menus()[0];
  for (let i = 0; i < path.length; i++) {
    const mi = menu.menuItems().find(m => attempt(() => m.title(), '') === path[i]);
    if (!mi) {
      attempt(() => pick(items, itemIndex).menus()[0].actions.byName('AXCancel').perform());
      throw new Error(`no menu item "${path[i]}"`);
    }
    if (i === path.length - 1) {
      mi.click();
      return { app, chose: path };
    }
    menu = mi.menus()[0];
  }
}

function press(app, element) {
  const { proc } = statusItems(app);
  const wins = popoverWindows(proc);
  if (!wins.length) throw new Error(`${app} has no open window from its status item; use open first`);
  const win = wins[wins.length - 1];
  let n = -1;
  let target = null;
  const walk = (el, depth) => {
    if (target || depth > 12) return;
    const role = attempt(() => el.role(), '');
    if (['AXButton', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXMenuButton', 'AXSlider', 'AXTextField', 'AXStaticText', 'AXLink', 'AXSwitch'].includes(role)) {
      n++;
      if (n === element) { target = el; return; }
    }
    for (const kid of attempt(() => el.uiElements(), [])) walk(kid, depth + 1);
  };
  walk(win, 0);
  if (!target) throw new Error(`no element ${element}`);
  target.click();
  delay(0.3);
  const after = popoverWindows(proc);
  return { app, pressed: element, elements: after.length ? readWindow(after[after.length - 1]) : [] };
}

// A status item lists its menu even while closed, and AXSelected doesn't say
// whether it's open, so this always cancels; that does nothing to a closed menu.
function close(app, itemIndex) {
  const { proc, items } = statusItems(app);
  const item = pick(items, itemIndex);
  const menus = attempt(() => item.menus(), []);
  if (menus.length) attempt(() => menus[0].actions.byName('AXCancel').perform());
  // A window-style item closes when its icon is clicked again.
  if (popoverWindows(proc).length) {
    realClick(item);
    delay(0.3);
  }
  return { app, closed: true, windowStillOpen: popoverWindows(proc).length > 0 || undefined };
}

// A banner's buttons are named AX actions ("Name:Close\nTarget:…").
function bannerButtons(group) {
  return attempt(() => group.actions(), [])
    .map(a => ({ action: a, name: attempt(() => a.name(), '').split('\n')[0] }))
    .filter(b => b.name.startsWith('Name:'))
    .map(b => ({ ...b, name: b.name.slice(5) }));
}

function banners() {
  const proc = se.processes.byName('NotificationCenter');
  const found = [];
  const walk = (el, depth) => {
    if (depth > 8) return;
    const buttons = bannerButtons(el);
    const texts = attempt(() => el.staticTexts(), []).map(t => attempt(() => String(t.value()), '')).filter(Boolean);
    if (buttons.length && texts.length) {
      found.push({ el, texts, buttons });
      return;
    }
    for (const kid of attempt(() => el.uiElements(), [])) walk(kid, depth + 1);
  };
  for (const w of attempt(() => proc.windows(), [])) walk(w, 0);
  return found;
}

function notifications() {
  // Banners animate in and out; an element can vanish mid-read, so try twice.
  let found;
  try { found = banners(); } catch (e) { delay(0.3); found = banners(); }
  return { banners: found.map((b, i) => ({ banner: i, texts: b.texts, buttons: b.buttons.map(x => x.name) })) };
}

function notifyPress(index, name) {
  const b = banners()[index];
  if (!b) throw new Error(`no banner ${index}`);
  const button = b.buttons.find(x => x.name === name);
  if (!button) throw new Error(`banner ${index} has no "${name}" button; it has ${b.buttons.map(x => x.name).join(', ')}`);
  button.action.perform();
  return { pressed: name, banner: index };
}

function run(argv) {
  let request;
  try {
    request = JSON.parse(argv[0]);
    let result;
    switch (request.op) {
      case 'apps': {
        // Two bulk queries instead of one per process. Status items aren't
        // windows of their apps on current macOS, so the window list can't
        // find them; accessibility is the only source, and it takes seconds.
        const names = se.processes.name();
        const bars = se.processes.menuBars();
        result = { apps: names.filter((n, i) => bars[i] && bars[i].length > 1) };
        break;
      }
      case 'open': result = open(request.app, request.item ?? 0); break;
      case 'choose': result = choose(request.app, request.path ?? [], request.item ?? 0); break;
      case 'press': result = press(request.app, request.element); break;
      case 'close': result = close(request.app, request.item ?? 0); break;
      case 'notifications': result = notifications(); break;
      case 'notify-press': result = notifyPress(request.banner, request.button); break;
      default: throw new Error(`unknown op ${request.op}`);
    }
    return JSON.stringify({ ok: true, ...result });
  } catch (e) {
    const message = String(e.message || e);
    // -1719 and -25211: the app running this has no Accessibility permission.
    const access = /-1719|-25211|assistive/.test(message);
    return JSON.stringify({ ok: false, error: message, accessibility: access || undefined });
  }
}
