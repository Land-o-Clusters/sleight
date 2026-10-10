// Read one process's AXWindows with a native 500 ms messaging deadline, and count its windows on
// the current Space. No System Events, activation, approval changes or permission prompts.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

// Normal windows big enough to be documents, from CGWindowList. With `onScreenOnly` that list
// holds only the current Space's windows (and leaves out minimized ones).
function cgWindows(onScreenOnly) {
  const options = (onScreenOnly ? $.kCGWindowListOptionOnScreenOnly : $.kCGWindowListOptionAll) | $.kCGWindowListExcludeDesktopElements;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options, 0));
  const pids = [];
  for (let i = 0; i < list.count; i++) {
    const info = ObjC.deepUnwrap(list.objectAtIndex(i));
    const bounds = info.kCGWindowBounds ?? {};
    if (info.kCGWindowLayer === 0 && (info.kCGWindowAlpha ?? 1) > 0 && bounds.Width >= 100 && bounds.Height >= 100) pids.push(info.kCGWindowOwnerPID);
  }
  return pids;
}

// Whether the frontmost app's focused window is in full screen, which Split View windows are too.
// A full-screen window on a notched display has the same frame as a zoomed one, so its size can't tell.
function frontFullScreen() {
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!front || front.isNil()) return undefined;
  const app = $.AXUIElementCreateApplication(Number(front.processIdentifier));
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) return undefined;
  const window = Ref(), value = Ref();
  if (Number($.AXUIElementCopyAttributeValue(app, $('AXFocusedWindow'), window)) !== 0) return undefined;
  if (Number($.AXUIElementCopyAttributeValue(ObjC.castRefToObject(window[0]), $('AXFullScreen'), value)) !== 0) return false;
  return ObjC.unwrap(ObjC.castRefToObject(value[0])) === true;
}

// On another Space, an app's windows leave AXWindows too (Calculator, 2026-10-09), so CGWindowList
// is the only count of them.
function spaces(pid) {
  return {
    onScreen: cgWindows(true).filter(owner => owner === pid).length,
    allWindows: cgWindows(false).filter(owner => owner === pid).length,
    fullScreenSpace: frontFullScreen(),
  };
}

function minimizedCount(windows) {
  let count = 0;
  for (let i = 0; i < windows.count; i++) {
    const value = Ref();
    if (Number($.AXUIElementCopyAttributeValue(windows.objectAtIndex(i), $('AXMinimized'), value)) === 0 &&
      ObjC.unwrap(ObjC.castRefToObject(value[0])) === true) count++;
  }
  return count;
}

// With an argument, one probe. Without, a long-lived helper: one JSON line in ({ id, app }), one out,
// so a session spawns osascript once instead of on every app read (about 150 ms of CPU each).
function run(argv) {
  if (argv.length && argv[0] !== '--session') return JSON.stringify(probe(JSON.parse(argv[0])));
  // Load the existing read-only queries once, in this helper's JavaScript context.
  const query = name => {
    const source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(`${argv[1]}/${name}.js`, $.NSUTF8StringEncoding, null));
    return eval(`(function () { ${source}; return run; })()`);
  };
  const taps = argv[0] === '--session' ? query('keyboard-taps') : undefined;
  const target = argv[0] === '--session' ? query('lease-target') : undefined;
  let windowIdentity;
  const stdin = $.NSFileHandle.fileHandleWithStandardInput, stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  let buffer = '';
  for (;;) {
    const data = stdin.availableData;
    if (Number(data.length) === 0) return '';
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    if (buffer.length > 4096) return '';
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      // NSWorkspace learns of launched and quit apps through notifications that only a running run
      // loop delivers. Blocked on stdin, the helper saw Calculator as absent 3 s after it launched.
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.005));
      let reply;
      let request;
      try {
        request = JSON.parse(line);
        const result = request.op === 'window-identity' ? JSON.parse((windowIdentity ||= query('window-identity'))([JSON.stringify(request.window)]))
          : request.op === 'keyboard-taps' ? JSON.parse(taps())
          : request.op === 'lease-target' ? JSON.parse(target([JSON.stringify({ app: request.app })])) : probe(request.app);
        reply = { id: request.id, ...result };
      } catch { reply = { id: request?.id, status: 'unknown', ok: false, error: 'session query failed' }; }
      stdout.writeData($(JSON.stringify(reply) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
}

function probe(selector) {
  if (!$.AXIsProcessTrusted()) return { status: 'denied' };
  if (typeof selector !== 'string' || !selector) return { status: 'unknown' };
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  let target;
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    if ([ObjC.unwrap(app.localizedName), ObjC.unwrap(app.bundleIdentifier), ObjC.unwrap(app.bundleURL.path)]
      .some(value => typeof value === 'string' && value.toLowerCase() === selector.toLowerCase())) {
      if (target) return { status: 'unknown' };
      target = app;
    }
  }
  if (!target) return { status: 'absent' };
  const pid = Number(target.processIdentifier), app = $.AXUIElementCreateApplication(pid);
  const space = { hidden: target.hidden === true, ...spaces(pid) };
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) return { status: 'unknown', ...space };
  const value = Ref();
  const error = Number($.AXUIElementCopyAttributeValue(app, $('AXWindows'), value));
  if (error !== 0) return { status: error === -25204 ? 'timeout' : error === -25211 ? 'denied' : 'unknown', error, pid, ...space };
  const windows = ObjC.castRefToObject(value[0]);
  return { status: 'responding', pid, windows: Number(windows.count), minimized: minimizedCount(windows), ...space };
}
