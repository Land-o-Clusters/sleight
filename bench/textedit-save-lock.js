// Background-only operations on one retained temporary TextEdit document.
// No activation, pointer, clipboard, permission request or dialog response.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

function run(argv) {
  const free = () => { if ($.NSFileManager.defaultManager.fileExistsAtPath('/tmp/sleight-hold')) throw new Error('Live hold exists; trial stopped'); };
  free();
  const path = argv[0];
  if (!/^\/private\/tmp\/sleight-save-lock-[A-Za-z0-9]+\/trial\.txt$/.test(path)) throw new Error('Expected owned temporary file');
  const stdin = $.NSFileHandle.fileHandleWithStandardInput;
  const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  let win, ax, area, pid, front, ownedApp, priorPids = [], buffer = '';
  const attr = (el, name) => {
    free();
    const out = Ref(), status = Number($.AXUIElementCopyAttributeValue(el, $(name), out));
    if (status) throw new Error(name + ' failed: ' + status);
    return ObjC.castRefToObject(out[0]);
  };
  const value = (el, name) => ObjC.unwrap(attr(el, name));
  const frontPid = () => Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  const expectedURL = ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString);
  function noDialogs() {
    const windows = attr(ax, 'AXWindows');
    if (windows.count > 40) throw new Error('Window budget exceeded');
    for (let i = 0; i < windows.count; i++) {
      const w = windows.objectAtIndex(i), children = attr(w, 'AXChildren');
      if (children.count > 300) throw new Error('Child budget exceeded');
      if (['AXDialog', 'AXSystemDialog'].includes(value(w, 'AXSubrole')) || value(w, 'AXModal') === true) throw new Error('Dialog present; no action sent');
      for (let j = 0; j < children.count; j++) if (value(children.objectAtIndex(j), 'AXRole') === 'AXSheet') throw new Error('Sheet present; no action sent');
    }
  }
  function verify() {
    if (frontPid() !== front || Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) === pid) throw new Error('Foreground changed; no input sent');
    noDialogs();
    if (value(win, 'AXDocument') !== expectedURL) throw new Error('Retained document identity changed');
    if (Number(attr(ax, 'AXWindows').count) !== 1) throw new Error('Another window appeared in owned TextEdit process');
    for (const name of ['AXMainWindow', 'AXFocusedWindow']) if (value(attr(ax, name), 'AXDocument') !== expectedURL) throw new Error('Input window differs from owned document');
  }
  function key(code, flags, type) {
    free();
    const event = $.CGEventCreateKeyboardEvent(null, code, type !== 'up');
    $.CGEventSetFlags(event, flags);
    if (type === 'flags') $.CGEventSetType(event, $.kCGEventFlagsChanged);
    $.CGEventPostToPid(pid, event);
  }
  function act(r) {
    free();
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no permission prompt requested');
    if (r.op === 'preflight') {
      pid = win = area = ax = ownedApp = undefined;
      const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
      front = frontPid();
      priorPids = [];
      for (let i = 0; i < running.count; i++) priorPids.push(Number(running.objectAtIndex(i).processIdentifier));
      if (priorPids.includes(front)) throw new Error('TextEdit is foreground; probe refused');
      return { background: true, existingProcessCount: priorPids.length, isolatedInstance: true };
    }
    if (r.op === 'attach') {
      win = area = undefined;
      if (frontPid() !== front) throw new Error('Foreground changed during open');
      const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
      const candidates = [];
      for (let i = 0; i < running.count; i++) { const a = running.objectAtIndex(i); if (!priorPids.includes(Number(a.processIdentifier))) candidates.push(a); }
      if (!pid) {
        if (candidates.length === 0) throw new Error('New TextEdit process not registered yet');
        if (candidates.length !== 1) throw new Error('Ambiguous newly launched TextEdit process');
        ownedApp = candidates[0]; pid = Number(ownedApp.processIdentifier);
      }
      ax = $.AXUIElementCreateApplication(pid); $.AXUIElementSetMessagingTimeout(ax, 1);
      noDialogs();
      const windows = attr(ax, 'AXWindows');
      if (Number(windows.count) !== 1) throw new Error('Expected only owned temporary window');
      for (let i = 0; i < windows.count; i++) { const w = windows.objectAtIndex(i); try { if (value(w, 'AXDocument') === expectedURL) { if (win) throw new Error('Ambiguous owned windows'); win = w; } } catch (e) { if (e.message === 'Ambiguous owned windows') throw e; } }
      if (!win) throw new Error('Owned AX window unavailable');
      let count = 0;
      const walk = (el, depth) => {
        if (++count > 300 || depth > 12) throw new Error('AX scan budget exceeded');
        if (value(el, 'AXRole') === 'AXTextArea') { if (area) throw new Error('Ambiguous text areas'); area = el; return; }
        let children; try { children = attr(el, 'AXChildren'); } catch { return; }
        for (let i = 0; i < children.count; i++) walk(children.objectAtIndex(i), depth + 1);
      };
      walk(win, 0); if (!area) throw new Error('Text area unavailable');
      verify(); return { attached: true };
    }
    if (r.op === 'close') {
      verify();
      const bytes = $.NSData.dataWithContentsOfFile(path);
      if (!bytes || ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)) !== value(area, 'AXValue')) throw new Error('Buffer differs from saved file; no close sent');
      if (value(win, 'AXEdited') !== false) throw new Error('Owned document still edited; no close sent');
      key(13, $.kCGEventFlagMaskCommand, 'down'); delay(0.05); key(13, 0, 'up');
      const deadline = Date.now() + 3000;
      while (Number(attr(ax, 'AXWindows').count) !== 0) { noDialogs(); if (Date.now() > deadline) throw new Error('Owned document remains open'); delay(0.1); }
      win = area = undefined;
      return { closed: true, foregroundSame: frontPid() === front };
    }
    if (r.op === 'quit-owned') {
      if (frontPid() !== front || !pid || win || Number(attr(ax, 'AXWindows').count) !== 0) throw new Error('Owned launch cannot quit safely');
      noDialogs(); free(); if (!ownedApp.terminate) throw new Error('Owned quit request refused');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        free();
        if (ownedApp.isTerminated) return { quit: true };
        delay(0.1);
      }
      throw new Error('Owned TextEdit quit unconfirmed');
    }
    verify();
    if (r.op === 'read') {
      let edited = null; try { edited = value(win, 'AXEdited'); } catch {}
      return { text: value(area, 'AXValue'), selected: value(area, 'AXSelectedText'), edited, background: true };
    }
    if (r.op === 'edit') {
      if (typeof r.text !== 'string' || !/^probe-[0-9]+\n$/.test(r.text)) throw new Error('Unexpected fixture text');
      free(); const status = Number($.AXUIElementSetAttributeValue(area, $('AXValue'), $(r.text)));
      if (status) throw new Error('AXValue edit failed: ' + status);
      return { edited: value(area, 'AXValue') === r.text };
    }
    if (r.op === 'event') {
      if (!['shift', 'flags-zero', 'shift-release', 'escape', 'none'].includes(r.variant)) throw new Error('Unknown event variant');
      if (r.variant === 'shift') { key(56, $.kCGEventFlagMaskShift, 'flags'); delay(0.05); key(56, 0, 'flags'); }
      if (r.variant === 'flags-zero' || r.variant === 'shift-release') key(r.variant === 'flags-zero' ? 0 : 56, 0, 'flags');
      if (r.variant === 'escape') { key(53, 0, 'down'); delay(0.05); key(53, 0, 'up'); }
      if (!['shift', 'escape'].includes(r.variant)) delay(0.05);
      delay(0.1); verify(); return { posted: r.variant, selected: value(area, 'AXSelectedText') };
    }
    if (r.op === 'save') {
      if (r.method === 'key') { key(1, $.kCGEventFlagMaskCommand, 'down'); delay(0.05); key(1, 0, 'up'); }
      else throw new Error('Unknown save method');
      return { saveRequested: true };
    }
    throw new Error('Unknown operation');
  }
  for (;;) {
    const data = stdin.availableData;
    if (!Number(data.length)) return '';
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    if (buffer.length > 4096) throw new Error('Request limit exceeded');
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); let reply, request;
      try { request = JSON.parse(line); reply = { id: request.id, ok: true, ...act(request) }; }
      catch (error) { reply = { id: request?.id, ok: false, error: String(error.message || error), pid: pid || null, background: /Live hold/.test(error.message) ? null : frontPid() !== pid }; }
      stdout.writeData($(JSON.stringify(reply) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
}
