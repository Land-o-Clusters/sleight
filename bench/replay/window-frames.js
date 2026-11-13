// Benchmark-only read of TextEdit fixture window metadata. No input, raises, focus or permission requests.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    if (request.appId !== 'com.apple.TextEdit' || !Number.isSafeInteger(request.pid) || request.pid <= 0 || !$.AXIsProcessTrusted())
      throw Error('Fixture window metadata unavailable');
    const running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
    if (!running || running.isNil() || running.terminated || ObjC.unwrap(running.bundleIdentifier) !== request.appId)
      throw Error('Fixture app identity changed');
    const app = $.AXUIElementCreateApplication(request.pid);
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.05)) !== 0) throw Error('AX deadline unavailable');
    const attr = (element, key) => {
      const ref = Ref();
      if (Number($.AXUIElementCopyAttributeValue(element, $(key), ref)) !== 0) throw Error('Window metadata missing');
      return ObjC.castRefToObject(ref[0]);
    };
    const pair = (value, type) => {
      const bytes = $.NSMutableData.dataWithLength(16);
      if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) throw Error('Window frame missing');
      const boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
      return ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
    };
    const list = attr(app, 'AXWindows'), count = Number(list.count);
    if (!Number.isSafeInteger(count) || count < 1 || count > 16) throw Error('Window count outside fixture bound');
    const cg = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
    const receipts = [];
    for (let i = 0; i < count; i++) {
      const win = list.objectAtIndex(i), title = ObjC.unwrap(attr(win, 'AXTitle'));
      // Only nonce-named benchmark documents, never another TextEdit window.
      if (typeof title !== 'string' || !/^(?:(?:Source|Target)-)?[a-f0-9]{8}(?:-drag|-edit)?\.txt$/.test(title)) continue;
      const document = ObjC.unwrap(attr(win, 'AXDocument'));
      if (typeof document !== 'string' || !/^file:\/\/\/(?:private\/)?(?:tmp|var)\//.test(document) || !document.includes('/sleight-bench/')) continue;
      const p = pair(attr(win, 'AXPosition'), 1), s = pair(attr(win, 'AXSize'), 2);
      const frame = { x: p.x, y: p.y, width: s.width, height: s.height };
      if (!Object.values(frame).every(Number.isFinite) || !(frame.width > 0 && frame.height > 0)) throw Error('Invalid window frame');
      const matches = cg.filter(w => w.kCGWindowOwnerPID === request.pid && w.kCGWindowLayer === 0 && w.kCGWindowAlpha > 0 &&
        ['X', 'Y', 'Width', 'Height'].every((key, j) => Math.abs(w.kCGWindowBounds?.[key] - Object.values(frame)[j]) <= 0.5));
      if (matches.length !== 1) throw Error('Window identity ambiguous');
      receipts.push({ target: { appId: request.appId, app: 'TextEdit', title, url: document },
        identity: { pid: request.pid, windowNumber: matches[0].kCGWindowNumber }, frame });
    }
    if (running.terminated || ObjC.unwrap(running.bundleIdentifier) !== request.appId) throw Error('Fixture app identity changed');
    return JSON.stringify({ ok: true, receipts });
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message ?? error) }); }
}
