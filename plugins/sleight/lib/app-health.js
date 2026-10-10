// Read one process's AXWindows with a native 500 ms messaging deadline, and count its windows on
// the current Space. No System Events, activation, approval changes or permission prompts.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

// Normal windows big enough to be documents, from CGWindowList. With `onScreenOnly` that list
// holds only the current Space's windows (and leaves out minimized ones).
function documentWindows(list, pid) {
  // Filter inside Foundation. Unwrapping every window dictionary in JavaScript costs CPU and
  // copies unrelated window titles, though the probe needs only a count for this one process.
  return list.filteredArrayUsingPredicate($.NSPredicate.predicateWithFormatArgumentArray(
    'kCGWindowOwnerPID == %@ AND kCGWindowLayer == 0 AND (kCGWindowAlpha == nil OR kCGWindowAlpha > 0) AND kCGWindowBounds.Width >= 100 AND kCGWindowBounds.Height >= 100',
    [pid]));
}

function cgWindows(onScreenOnly, pid) {
  const options = (onScreenOnly ? $.kCGWindowListOptionOnScreenOnly : $.kCGWindowListOptionAll) | $.kCGWindowListExcludeDesktopElements;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options, 0));
  return Number(documentWindows(list, pid).count);
}

function matchingApps(apps, selector) {
  // Bound arguments keep quotes and predicate syntax in a selector literal. The fresh list still
  // detects duplicate matches, including another process with the same name or bundle ID.
  const candidates = apps.filteredArrayUsingPredicate($.NSPredicate.predicateWithFormatArgumentArray(
    'localizedName ==[c] %@ OR bundleIdentifier ==[c] %@ OR bundleURL.path ==[c] %@',
    [selector, selector, selector]));
  // Foundation folds more Unicode spellings than JavaScript lowercasing (for example ß and ss).
  // Keep the original equality rule, but bridge only these candidates rather than every app.
  const matches = [];
  for (let i = 0; i < candidates.count; i++) {
    const app = candidates.objectAtIndex(i);
    if (['localizedName', 'bundleIdentifier', 'bundleURL.path'].some(key => {
      const value = ObjC.unwrap(app.valueForKeyPath(key));
      return typeof value === 'string' && value.toLowerCase() === selector.toLowerCase();
    })) matches.push(app);
  }
  return matches;
}

// This process's document-sized windows, unwrapped only after the native filter: the Save panel
// check needs each window's id and name, and other apps' titles never cross into JavaScript.
function ownWindows(pid) {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0));
  const own = documentWindows(list, pid), windows = [];
  for (let i = 0; i < own.count; i++) {
    const info = ObjC.deepUnwrap(own.objectAtIndex(i));
    windows.push({ id: info.kCGWindowNumber, savePanel: info.kCGWindowName === 'Save Panel Accessory View' });
  }
  return windows;
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
  const all = ownWindows(pid);
  return {
    onScreen: cgWindows(true, pid),
    allWindows: all.length,
    onlySavePanel: all.length > 0 && all.every(w => w.savePanel),
    savePanelWindowIds: all.filter(w => w.savePanel).map(w => w.id).filter(id => Number.isInteger(id) && id > 0),
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
  const apps = matchingApps($.NSWorkspace.sharedWorkspace.runningApplications, selector);
  if (apps.length > 1) return { status: 'unknown' };
  if (apps.length === 0) return { status: 'absent' };
  const target = apps[0];
  const pid = Number(target.processIdentifier), app = $.AXUIElementCreateApplication(pid);
  const { onlySavePanel, savePanelWindowIds, ...counts } = spaces(pid);
  const space = { hidden: target.hidden === true, ...counts };
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) return { status: 'unknown', ...space };
  const value = Ref();
  const error = Number($.AXUIElementCopyAttributeValue(app, $('AXWindows'), value));
  if (error !== 0) return { status: error === -25204 ? 'timeout' : error === -25211 ? 'denied' : 'unknown', error, pid, ...space };
  const windows = ObjC.castRefToObject(value[0]);
  // A single window costs no title reads. Only multiple windows need candidate disambiguation.
  let windowTitles;
  if (Number(windows.count) > 1 && Number(windows.count) <= 64) {
    windowTitles = [];
    for (let i = 0; i < Number(windows.count); i++) {
      const title = Ref();
      if (Number($.AXUIElementCopyAttributeValue(windows.objectAtIndex(i), $('AXTitle'), title)) !== 0) { windowTitles = undefined; break; }
      windowTitles.push(ObjC.unwrap(ObjC.castRefToObject(title[0])));
    }
  }
  return { status: 'responding', pid, windows: Number(windows.count), windowTitles, minimized: minimizedCount(windows), ...space,
    ...(ObjC.unwrap(target.bundleIdentifier) === 'com.apple.TextEdit' && Number(windows.count) === 0 && onlySavePanel ? { savePanelOnly: true, savePanelWindowIds } : {}) };
}
