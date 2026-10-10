// Retain the exact document and AX window for a background-only typing probe.
// No activation, pointer events, permission requests or dialog interaction.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function attribute(el, name) {
  const out = Ref();
  const error = Number($.AXUIElementCopyAttributeValue(el, $(name), out));
  if (error !== 0) throw new Error(name + ' failed: ' + error);
  return ObjC.castRefToObject(out[0]);
}
function frontPid() { return Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier); }
function run(argv) {
  const path = argv[0];
  if (!/^\/private\/tmp\/sleight-exact-[A-Za-z0-9]+\/exact\.txt$/.test(path)) throw new Error('Expected an owned temporary file');
  const stdin = $.NSFileHandle.fileHandleWithStandardInput, stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  const app = Application('TextEdit');
  let doc, win, ax, textArea, originalFront, buffer = '';
  const noDialogs = () => {
    if (!ax) return;
    const windows = attribute(ax, 'AXWindows');
    if (Number(windows.count) > 40) throw new Error('Dialog scan exceeded its window budget');
    for (let i = 0; i < windows.count; i++) {
      const candidate = windows.objectAtIndex(i);
      const subrole = ObjC.unwrap(attribute(candidate, 'AXSubrole'));
      const modal = ObjC.unwrap(attribute(candidate, 'AXModal'));
      const children = attribute(candidate, 'AXChildren');
      if (Number(children.count) > 300) throw new Error('Dialog scan exceeded its child budget');
      const sheet = Array.from({ length: Number(children.count) }, (_, j) => ObjC.unwrap(attribute(children.objectAtIndex(j), 'AXRole'))).includes('AXSheet');
      if (subrole === 'AXDialog' || subrole === 'AXSystemDialog' || modal === true || sheet) throw new Error('TextEdit has a dialog; no action will be sent');
    }
  };
  const verify = () => {
    if (frontPid() !== originalFront) throw new Error('Foreground changed; stopping without input');
    if (String(doc.path()) !== path) throw new Error('Retained document identity changed');
    if (win) {
      noDialogs();
      const url = ObjC.unwrap(attribute(win, 'AXDocument'));
      if (url !== ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString)) throw new Error('Retained window identity changed');
      if (ObjC.unwrap(attribute(win, 'AXMain')) !== true) throw new Error('Owned window is no longer the app main window');
      for (const name of ['AXMainWindow', 'AXFocusedWindow']) {
        if (ObjC.unwrap(attribute(attribute(ax, name), 'AXDocument')) !== url) throw new Error('Current app input window differs from the retained fixture');
      }
    }
  };
  function act(request) {
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no permission prompt requested');
    if (request.op === 'preflight') return { running: app.running(), foregroundTextEdit: ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier) === 'com.apple.TextEdit' };
    if (request.op === 'attach') {
      originalFront = frontPid();
      if (ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier) === 'com.apple.TextEdit') throw new Error('TextEdit is foreground; background probe refused');
      const matches = app.documents().filter(d => { try { return String(d.path()) === path; } catch { return false; } });
      if (matches.length !== 1) throw new Error('Expected one owned document');
      doc = matches[0];
      const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
      if (running.count !== 1) throw new Error('Ambiguous TextEdit process');
      ax = $.AXUIElementCreateApplication(Number(running.objectAtIndex(0).processIdentifier));
      if (Number($.AXUIElementSetMessagingTimeout(ax, 1)) !== 0) throw new Error('Could not bound fixture AX messaging');
      const windows = attribute(ax, 'AXWindows'), candidates = [];
      for (let i = 0; i < windows.count; i++) {
        const candidate = windows.objectAtIndex(i);
        try { if (ObjC.unwrap(attribute(candidate, 'AXDocument')) === ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString)) candidates.push(candidate); } catch {}
      }
      if (candidates.length !== 1) throw new Error('Expected one owned AX window');
      win = candidates[0];
      noDialogs();
      if (Number($.AXUIElementSetAttributeValue(win, $('AXMain'), $(true))) !== 0 || Number($.AXUIElementPerformAction(win, $('AXRaise'))) !== 0) throw new Error('Could not select owned window in background');
      let count = 0;
      const walk = (el, depth) => {
        if (depth > 12 || ++count > 300) throw new Error('Fixture AX scan exceeded its budget');
        if (ObjC.unwrap(attribute(el, 'AXRole')) === 'AXTextArea') { if (textArea) throw new Error('Ambiguous text area'); textArea = el; return; }
        let children; try { children = attribute(el, 'AXChildren'); } catch { return; }
        for (let i = 0; i < children.count; i++) walk(children.objectAtIndex(i), depth + 1);
      };
      walk(win, 0); if (!textArea) throw new Error('Owned text area unavailable');
      verify(); return { attached: true };
    }
    if (request.op === 'close') {
      if (!doc || String(doc.path()) !== path) throw new Error('Retained document identity changed');
      noDialogs();
      doc.close({ saving: 'no' });
      const remains = app.documents().some(d => { try { return String(d.path()) === path; } catch { return false; } });
      if (remains) throw new Error('Owned document remains open');
      return { closed: true, foregroundSame: frontPid() === originalFront };
    }
    verify();
    if (request.op === 'read') return { text: ObjC.unwrap(attribute(textArea, 'AXValue')), selected: ObjC.unwrap(attribute(textArea, 'AXSelectedText')), foregroundSame: true };
    if (request.op === 'save') { doc.save(); verify(); return { saved: true }; }
    throw new Error('Unknown fixture operation');
  }
  for (;;) {
    const data = stdin.availableData;
    if (Number(data.length) === 0) return '';
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    if (buffer.length > 4096) return '';
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let reply;
      try { const request = JSON.parse(line); reply = { id: request.id, ok: true, ...act(request) }; }
      catch (error) { reply = { ok: false, error: String(error.message || error) }; }
      stdout.writeData($(JSON.stringify(reply) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
}
