// Retains only this run's temporary TextEdit document. No activation or dialog answers.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function run(argv) {
  const path = argv[0];
  if (!/^\/private\/tmp\/sleight-textedit-fixes-[A-Za-z0-9]+\/fixture\.(rtf|txt)$/.test(path)) throw new Error('Expected an owned temporary fixture');
  const app = Application('TextEdit'), stdin = $.NSFileHandle.fileHandleWithStandardInput, stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  let doc, win, area, pid, ax, originalFront, buffer = '', openedWithNoDocuments = false;
  const get = (el, name) => { const out = Ref(); const err = $.AXUIElementCopyAttributeValue(el, $(name), out); if (err) throw new Error(name + ': ' + err); return ObjC.castRefToObject(out[0]); };
  const set = (el, name, value) => { const err = $.AXUIElementSetAttributeValue(el, $(name), value); if (err) throw new Error(name + ': ' + err); };
  ObjC.bindFunction('malloc', ['void*', ['unsigned long']]);
  ObjC.bindFunction('free', ['void', ['void*']]);
  ObjC.bindFunction('AXValueCreate', ['id', ['int', 'void*']]);
  const axValue = (type, value) => { const buf = $.malloc(32); try { value.getValue(buf); return $.AXValueCreate(type, buf); } finally { $.free(buf); } };
  const range = (at, length) => axValue(4, $.NSValue.valueWithRange($.NSMakeRange(at, length)));
  const ask = (name, value) => { const out = Ref(); const err = $.AXUIElementCopyParameterizedAttributeValue(area, $(name), value, out); if (err) throw new Error(name + ': ' + err); return ObjC.castRefToObject(out[0]); };
  const front = () => Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  const verify = () => {
    if (front() !== originalFront || front() === pid) throw new Error('Foreground changed; no further input');
    if (!doc || String(doc.path()) !== path || ObjC.unwrap(get(win, 'AXDocument')) !== ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString)) throw new Error('Fixture identity changed');
  };
  const attributed = () => ask('AXAttributedStringForRange', range(0, ObjC.unwrap(get(area, 'AXValue')).length));
  const cgWindows = (all = false) => {
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo((all ? $.kCGWindowListOptionAll : $.kCGWindowListOptionOnScreenOnly) | $.kCGWindowListExcludeDesktopElements, 0));
    return Array.from({ length: Number(list.count) }, (_, i) => ObjC.deepUnwrap(list.objectAtIndex(i)));
  };
  const characters = rich => [0, 4, 6, 11, 15].filter(index => index < Number(rich.length)).map(index => {
    const attrs = rich.attributesAtIndexEffectiveRange(index, null);
    const font = attrs.objectForKey($.NSFontAttributeName), color = attrs.objectForKey($.NSForegroundColorAttributeName);
    const rgb = color.isNil() ? null : color.colorUsingColorSpace($.NSColorSpace.genericRGBColorSpace);
    return { index, font: font.isNil() ? null : ObjC.unwrap(font.fontName), size: font.isNil() ? null : Number(font.pointSize),
      color: color.isNil() ? null : ObjC.unwrap(color.description),
      rgba: !rgb || rgb.isNil() ? null : [Number(rgb.redComponent), Number(rgb.greenComponent), Number(rgb.blueComponent), Number(rgb.alphaComponent)] };
  });
  const read = () => {
    verify();
    const text = ObjC.unwrap(get(area, 'AXValue'));
    const result = { text, selected: ObjC.unwrap(get(area, 'AXSelectedText')), foregroundSame: true };
    try {
      const rich = attributed();
      result.attributedText = ObjC.unwrap(rich.string);
      const data = ask('AXRTFForRange', range(0, text.length));
      result.characters = characters($.NSAttributedString.alloc.initWithRTFDocumentAttributes(data, null));
    } catch (error) { result.attributedError = String(error.message || error); }
    return result;
  };
  const key = (code, flags) => {
    verify();
    for (const down of [true, false]) {
      const event = $.CGEventCreateKeyboardEvent(null, code, down);
      $.CGEventSetFlags(event, flags); $.CGEventPostToPid(pid, event); delay(0.1);
    }
  };
  function act(request) {
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no prompt requested');
    if (request.op === 'preflight') {
      const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
      return { running: app.running(), foregroundTextEdit: ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier) === 'com.apple.TextEdit', documents: app.running() ? app.documents().length : null,
        frontPid: front(), hidden: Number(apps.count) === 1 ? apps.objectAtIndex(0).hidden === true : null,
        onScreenWindows: Number(apps.count) === 1 ? cgWindows().filter(w => w.kCGWindowOwnerPID === Number(apps.objectAtIndex(0).processIdentifier) && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Height > 50).length : null };
    }
    if (request.op === 'open') {
      originalFront = front();
      if (!app.running() || ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier) === 'com.apple.TextEdit') throw new Error('Requires already-running background TextEdit');
      openedWithNoDocuments = app.documents().length === 0;
      doc = app.open(Path(path));
      const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
      if (Number(running.count) !== 1) throw new Error('Ambiguous TextEdit process');
      pid = Number(running.objectAtIndex(0).processIdentifier);
      if (running.objectAtIndex(0).hidden === true) {
        if (!openedWithNoDocuments) throw new Error('TextEdit is hidden and has other documents; no unhide attempted');
        running.objectAtIndex(0).unhide();
        if (front() !== originalFront) throw new Error('Foreground changed while unhiding the owned fixture');
      }
      ax = $.AXUIElementCreateApplication(pid);
      $.AXUIElementSetMessagingTimeout(ax, 1);
      let matches = [], observed = [];
      for (let poll = 0; poll < 10 && !matches.length; poll++) {
        if (front() !== originalFront) throw new Error('Foreground changed while opening fixture');
        let windows;
        try { windows = get(ax, 'AXWindows'); }
        catch (error) { if (String(error.message) !== 'AXWindows: -25204') throw error; delay(0.1); continue; }
        observed = [{ axWindows: Number(windows.count) }];
        for (let i = 0; i < Number(windows.count); i++) {
          const candidate = windows.objectAtIndex(i);
          try { const url = ObjC.unwrap(get(candidate, 'AXDocument')); observed.push({ documentMatches: url === ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString), fixturePath: typeof url === 'string' && url.includes('/sleight-textedit-fixes-'), nameMatches: ObjC.unwrap(get(candidate, 'AXTitle')) === 'fixture.' + path.split('.').at(-1) }); if (url === ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString)) matches.push(candidate); } catch (error) { observed.push({ error: String(error.message || error) }); }
        }
        if (!matches.length) delay(0.1);
      }
      if (matches.length !== 1) throw new Error('Expected one owned AX window: ' + JSON.stringify({ observed, cg: cgWindows(true).filter(w => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0).map(w => ({ fixture: /^fixture\.(rtf|txt)$/.test(w.kCGWindowName || ''), onScreen: w.kCGWindowIsOnscreen, bounds: w.kCGWindowBounds })) }));
      win = matches[0];
      set(win, 'AXMain', $(true));
      let visited = 0;
      const walk = (el, depth) => {
        if (++visited > 300 || depth > 12) throw new Error('Fixture tree exceeded budget');
        if (ObjC.unwrap(get(el, 'AXRole')) === 'AXTextArea') { if (area) throw new Error('Ambiguous text area'); area = el; return; }
        let children; try { children = get(el, 'AXChildren'); } catch (_) { return; }
        for (let i = 0; i < Number(children.count); i++) walk(children.objectAtIndex(i), depth + 1);
      };
      walk(win, 0); if (!area) throw new Error('No fixture text area');
      verify(); return read();
    }
    if (request.op === 'close') {
      if (!doc || String(doc.path()) !== path) throw new Error('Retained fixture document unavailable');
      doc.close({ saving: 'no' });
      return { closed: !app.documents().some(d => { try { return String(d.path()) === path; } catch (_) { return false; } }), foregroundSame: front() === originalFront };
    }
    if (request.op === 'panel-state') {
      if (front() !== originalFront) throw new Error('Foreground changed; panel inspection stopped');
      const windows = get(ax, 'AXWindows');
      return { documents: app.documents().length, axWindows: Number(windows.count), foregroundSame: true,
        cgWindows: cgWindows(true).filter(w => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0).map(w => ({
          id: w.kCGWindowNumber, panel: w.kCGWindowName === 'Save Panel Accessory View',
          fixture: /^fixture\.(rtf|txt)$/.test(w.kCGWindowName || ''), onScreen: w.kCGWindowIsOnscreen === true,
        })) };
    }
    if (request.op === 'quit-empty') {
      // Only recover an app that started with no documents and still has none. No dialog is
      // answered, no unrelated document is closed, and the front application is left alone.
      if (!openedWithNoDocuments || app.documents().length !== 0 || front() !== originalFront) throw new Error('Empty TextEdit recovery is not safe; leaving it for the operator');
      app.quit();
      for (let i = 0; i < 50 && app.running(); i++) delay(0.1);
      return { quit: !app.running(), foregroundSame: front() === originalFront };
    }
    verify();
    if (request.op === 'read') return read();
    if (request.op === 'prepare') {
      const cover = cgWindows().find(w => w.kCGWindowOwnerPID === originalFront && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width > 200 && w.kCGWindowBounds.Height > 200);
      if (!cover) throw new Error('No covering foreground window; no drag attempted');
      const b = cover.kCGWindowBounds;
      set(win, 'AXPosition', axValue(1, $.NSValue.valueWithPoint($.NSMakePoint(b.X + 25, b.Y + 40))));
      set(win, 'AXSize', axValue(2, $.NSValue.valueWithSize($.NSMakeSize(Math.min(600, b.Width - 50), Math.min(400, b.Height - 80)))));
      delay(0.5);
      set(area, 'AXSelectedTextRange', range(0, 5));
      const own = cgWindows().filter(w => w.kCGWindowOwnerPID === pid && w.kCGWindowName === 'fixture.' + path.split('.').at(-1));
      if (own.length !== 1) throw new Error('Expected one fixture window number');
      const frame = own[0].kCGWindowBounds;
      const rect = index => {
        const m = /x:([-\d.]+) y:([-\d.]+) w:([-\d.]+) h:([-\d.]+)/.exec(ObjC.unwrap(ask('AXBoundsForRange', range(index, 1)).description));
        if (!m) throw new Error('Glyph geometry unavailable');
        return { x: +m[1], y: +m[2], width: +m[3], height: +m[4] };
      };
      const first = rect(2), last = rect(15), from = [first.x + first.width / 2 - frame.X, first.y + first.height / 2 - frame.Y],
        to = [last.x + last.width + 3 - frame.X, last.y + last.height / 2 - frame.Y];
      const covering = cgWindows().find(w => w.kCGWindowLayer === 0 && frame.X + to[0] >= w.kCGWindowBounds.X && frame.X + to[0] < w.kCGWindowBounds.X + w.kCGWindowBounds.Width && frame.Y + to[1] >= w.kCGWindowBounds.Y && frame.Y + to[1] < w.kCGWindowBounds.Y + w.kCGWindowBounds.Height);
      if (covering?.kCGWindowOwnerPID === pid) throw new Error('Fixture is uncovered; foreground probe refused');
      const candidates = Application('System Events').processes.whose({ unixId: pid })[0].windows().map(w => {
        try { return { fixtureName: /^fixture\.(rtf|txt)$/.test(w.name()), position: w.position(), size: w.size(),
          documentMatches: w.attributes.byName('AXDocument').value() === ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString) }; }
        catch (error) { return { error: String(error.message || error) }; }
      });
      return { app: 'TextEdit', windowId: own[0].kCGWindowNumber, from, to, settleMs: 0, covered: true, foregroundSame: true, candidates, cgBounds: frame };
    }
    if (request.op === 'save') {
      doc.save(); verify();
      const data = $.NSData.dataWithContentsOfFile(path);
      return { saved: true, characters: path.endsWith('.rtf') ? characters($.NSAttributedString.alloc.initWithRTFDocumentAttributes(data, null)) : null };
    }
    if (request.op === 'select') { set(area, 'AXSelectedTextRange', range(request.at, request.length)); return read(); }
    if (request.op === 'attributed-write') {
      const rich = ask('AXAttributedStringForRange', range(0, 5));
      set(area, 'AXSelectedTextRange', range(16, 0));
      const status = Number($.AXUIElementSetAttributeValue(area, $('AXSelectedText'), rich));
      return { status, ...read() };
    }
    if (request.op === 'rtf-read') {
      const data = ask('AXRTFForRange', range(0, 5));
      const rich = $.NSAttributedString.alloc.initWithRTFDocumentAttributes(data, null);
      return { rtfBytes: Number(data.length), text: ObjC.unwrap(rich.string), attributes: ObjC.unwrap(rich.attributesAtIndexEffectiveRange(0, null).description) };
    }
    if (request.op === 'save-as') {
      if (!openedWithNoDocuments) throw new Error('Orphan reproduction needs an initially empty TextEdit');
      set(area, 'AXFocused', $(true));
      for (const name of ['AXMainWindow', 'AXFocusedWindow']) if (ObjC.unwrap(get(get(ax, name), 'AXDocument')) !== ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString)) throw new Error('Input window differs from fixture');
      key(1, (1 << 20) | (1 << 19) | (1 << 17)); delay(0.3); return { requested: true };
    }
    throw new Error('Unknown fixture operation');
  }
  for (;;) {
    const data = stdin.availableData; if (!Number(data.length)) return '';
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    if (buffer.length > 2 * 1024 * 1024) throw new Error('Fixture input exceeded budget');
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let reply, request;
      try { request = JSON.parse(line); reply = { id: request.id, ok: true, ...act(request) }; }
      catch (error) { reply = { id: request?.id, ok: false, error: String(error.message || error) }; }
      stdout.writeData($(JSON.stringify(reply) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
}
