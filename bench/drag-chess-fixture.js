// Exact game geometry, plus owned-window raising for locked save cleanup.
ObjC.import('AppKit'); ObjC.import('CoreGraphics');
function run(argv) {
  const request = JSON.parse(argv[0]);
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.Chess');
  if (Number(apps.count) !== 1) throw new Error('Need one Chess process, found ' + apps.count);
  const pid = Number(apps.objectAtIndex(0).processIdentifier);
  let list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)))
    .filter(w => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && w.kCGWindowName);
  const wins = Application('System Events').processes.whose({ unixId: pid })[0].windows();
  list = list.filter(w => wins.some(win => {
    const p = win.position(), s = win.size(), b = w.kCGWindowBounds;
    return win.name() === w.kCGWindowName && Math.abs(p[0] - b.X) < 0.5 && Math.abs(p[1] - b.Y) < 0.5 && Math.abs(s[0] - b.Width) < 0.5 && Math.abs(s[1] - b.Height) < 0.5;
  }));
  if (request.op === 'windows') return JSON.stringify(list.map(w => ({ id: w.kCGWindowNumber, bounds: w.kCGWindowBounds })));
  const main = list.find(w => w.kCGWindowNumber === request.windowId);
  if (!main) throw new Error('Owned Chess window missing');
  const b = main.kCGWindowBounds;
  const matches = wins.filter(w => {
    const p = w.position(), s = w.size();
    return w.name() === main.kCGWindowName && Math.abs(p[0] - b.X) < 0.5 && Math.abs(p[1] - b.Y) < 0.5 && Math.abs(s[0] - b.Width) < 0.5 && Math.abs(s[1] - b.Height) < 0.5;
  });
  if (matches.length !== 1) throw new Error('Owned AX game window missing or ambiguous');
  const win = matches[0];
  if (request.op === 'raise') {
    win.attributes.byName('AXMain').value = true;
    win.actions.byName('AXRaise').perform();
    return JSON.stringify({ app: 'Chess', windowId: request.windowId, title: win.name() });
  }
  const squares = [];
  function walk(el, depth) {
    if (depth > 12) return;
    try {
      const name = el.description();
      if (/\b(?:e2|e4)\b/.test(name)) {
        const p = el.position(), s = el.size();
        squares.push({ name, point: [p[0] + s[0] / 2 - b.X, p[1] + s[1] / 2 - b.Y], size: s });
      }
    } catch (_) {}
    for (const child of el.uiElements()) walk(child, depth + 1);
  }
  walk(win, 0);
  return JSON.stringify({ app: 'Chess', windowId: request.windowId, title: win.name(), squares });
}
