// Local pointer hover. Capture while hovered, then restore in finally.
// osascript -l JavaScript hover.js '{"app":"TextEdit","at":[100,100]}'
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

function performHover(request, native) {
  const result = { ok: false, takeoverMs: 0 };
  let saved, started;
  try {
    const { app, at, windowTitle, waitMs = 1500 } = request;
    if (typeof app !== 'string' || !app.trim() || !Array.isArray(at) || at.length !== 2 ||
        !at.every(n => Number.isFinite(n) && n >= 0) || !Number.isInteger(waitMs) || waitMs < 100 || waitMs > 4000 ||
        (windowTitle !== undefined && (typeof windowTitle !== 'string' || !windowTitle.trim()))) {
      throw new Error('hover needs an app, two nonnegative finite coordinates and waitMs from 100 to 4000');
    }
    if (!native.screenCaptureAllowed()) throw new Error('Screen Recording permission is required; hover stopped before takeover');
    const target = native.resolve(app);
    const point = native.point(target, at, windowTitle);
    const check = () => {
      if (!native.visible(target, point)) {
        result.blocker = target.blocker;
        result.screenPoint = point;
        throw new Error('another window covers the hover point, including a window of the same app; do not retry unchanged');
      }
    };
    check();
    // Hover takes the pointer and focus, so it waits, as drag does, for the person at the
    // Mac to pause for 2 s (up to 10 s): keys typed then would go into the target app.
    for (let waited = 0; native.idleSeconds() < 2; waited += 500) {
      if (waited >= 10000) throw new Error('the person at the Mac kept typing or using the mouse for 10 s, and hover would take their pointer and focus; hover stopped before takeover. Tell the user, and retry when they have paused');
      native.wait(500);
    }
    check();
    saved = native.save();
    started = native.now();
    native.activate(target);
    native.wait(100);
    check();
    native.move(point);
    native.wait(waitMs);
    check();
    if (native.typedSince(started)) throw new Error(`the user typed while ${app} was in front, so their keys may have gone into it. Read the app again before continuing, and tell the user`);
    result.image = native.capture(target);
    result.app = app;
    result.at = at;
    result.waitMs = waitMs;
    result.windowTitle = target.windowTitle;
    result.ok = true;
  } catch (err) { result.error = String(err.message || err); }
  finally {
    if (saved) {
      for (const restore of ['restorePointer', 'restoreFront']) {
        try { native[restore](saved); }
        catch (err) { result.ok = false; result.error = [result.error, String(err.message || err)].filter(Boolean).join('; '); }
      }
      result.takeoverMs = native.now() - started;
    }
  }
  return result;
}

function windowList(onScreenOnly = true) {
  const options = onScreenOnly ? $.kCGWindowListOptionOnScreenOnly : $.kCGWindowListOptionAll;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options | $.kCGWindowListExcludeDesktopElements, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    out.push({ pid: ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')), owner: ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')),
      title: ObjC.unwrap(w.objectForKey('kCGWindowName')), id: ObjC.unwrap(w.objectForKey('kCGWindowNumber')),
      layer: ObjC.unwrap(w.objectForKey('kCGWindowLayer')), bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')) });
  }
  return out;
}
const inside = (b, p) => p.x >= b.X && p.x < b.X + b.Width && p.y >= b.Y && p.y < b.Y + b.Height;

function nativeHover() {
  return {
    now: () => Date.now(),
    // HID system state: the person's own input. 0xFFFFFFFF is any event type, 10 is key down.
    idleSeconds: () => $.CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF),
    typedSince: startedMs => $.CGEventSourceSecondsSinceLastEventType(1, 10) <= (Date.now() - startedMs) / 1000,
    screenCaptureAllowed: () => Boolean($.CGPreflightScreenCaptureAccess()),
    resolve(name) {
      const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
      const found = [];
      for (let i = 0; i < apps.count; i++) {
        const app = apps.objectAtIndex(i);
        if ([ObjC.unwrap(app.localizedName), ObjC.unwrap(app.bundleIdentifier),
          app.bundleURL.isNil() ? null : ObjC.unwrap(app.bundleURL.path)].includes(name)) found.push(app);
      }
      if (found.length !== 1) throw new Error('hover needs exactly one running app');
      return { app: found[0], pid: found[0].processIdentifier };
    },
    point(target, at, windowTitle) {
      const own = windowList().filter(w => w.pid === target.pid && w.layer === 0);
      if (!own.length || (windowTitle !== undefined && !own.some(w => w.title === windowTitle))) {
        const offScreen = windowList(false).filter(w => w.pid === target.pid && w.layer === 0 && (windowTitle === undefined || w.title === windowTitle));
        if (offScreen.length) throw new Error('the window is off screen, on another desktop or Space (or hidden/minimized). Hover needs that window on screen; bring it to the current desktop first');
        if (!own.length) throw new Error('the app has no window; open one on the current desktop before hovering');
      }
      if (windowTitle === undefined && own.length !== 1) throw new Error('more than one window is on screen; supply an exact window title');
      const matches = windowTitle === undefined ? own : own.filter(w => w.title === windowTitle);
      if (!matches.length) throw new Error('no on-screen window matches that title');
      if (matches.length !== 1) throw new Error('window title is ambiguous; more than one window matches');
      target.bounds = matches[0].bounds;
      target.windowId = matches[0].id;
      target.windowTitle = matches[0].title;
      const point = { x: target.bounds.X + at[0], y: target.bounds.Y + at[1] };
      if (!inside(target.bounds, point)) throw new Error('hover point is outside the selected window');
      return point;
    },
    visible(target, point) {
      const top = windowList().find(w => inside(w.bounds, point) && !/Computer Use$/.test(w.owner));
      const visible = top && top.pid === target.pid && (top.layer !== 0 || top.id === target.windowId);
      target.blocker = visible || !top ? undefined : { owner: top.owner, pid: top.pid, id: top.id, layer: top.layer };
      return visible;
    },
    save: () => ({ front: $.NSWorkspace.sharedWorkspace.frontmostApplication, pointer: $.CGEventGetLocation($.CGEventCreate(null)) }),
    activate(target) { if (!target.app.activateWithOptions(0)) throw new Error('app activation failed'); },
    wait: ms => delay(ms / 1000),
    move(point) { $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, $.CGPointMake(point.x, point.y), $.kCGMouseButtonLeft)); },
    capture(target) {
      // Capture only the app's rectangle, including its visible hover surfaces.
      const dir = ObjC.unwrap($.NSTemporaryDirectory()) + 'sleight-hover-' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
      const fm = $.NSFileManager.defaultManager;
      if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, false, $.NSDictionary.dictionary, null)) throw new Error('cannot create hover capture directory');
      const path = dir + '/hover.png';
      try {
        const b = target.bounds;
        const task = $.NSTask.alloc.init;
        task.launchPath = '/usr/sbin/screencapture';
        task.arguments = ['-x', '-R' + [b.X, b.Y, b.Width, b.Height].map(Math.round).join(','), path];
        task.launch; task.waitUntilExit;
        const data = $.NSData.dataWithContentsOfFile(path);
        if (task.terminationStatus !== 0 || data.isNil()) throw new Error('hover screenshot failed; check Screen Recording permission');
        return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
      } finally { fm.removeItemAtPathError(dir, null); }
    },
    restorePointer(saved) { if ($.CGWarpMouseCursorPosition(saved.pointer) !== 0) throw new Error('pointer restoration failed'); },
    restoreFront(saved) { if (!saved.front.isNil() && !saved.front.activateWithOptions(0)) throw new Error('front app restoration failed'); },
  };
}
function run(argv) {
  try { return JSON.stringify(performHover(JSON.parse(argv[0]), nativeHover())); }
  catch (err) { return JSON.stringify({ ok: false, takeoverMs: 0, error: String(err.message || err) }); }
}
