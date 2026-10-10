// Close only an unchanged, exact temporary fixture in the recorded owned launch.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function run(argv) {
  const free = () => { if ($.NSFileManager.defaultManager.fileExistsAtPath('/tmp/sleight-hold')) throw new Error('Live hold exists; cleanup stopped'); };
  free();
  const path = argv[0], pid = Number(argv[1]), earliest = Number(argv[2]), latest = Number(argv[3]);
  const inspectOnly = argv[4] === 'inspect-only';
  if (!/^\/private\/tmp\/sleight-save-lock-[A-Za-z0-9]+\/trial\.txt$/.test(path) || !Number.isInteger(pid) || pid < 1) throw new Error('Invalid owned fixture identity');
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app) return JSON.stringify({ processAbsent: true, fixtureClosed: true });
  const birth = Number(app.launchDate.timeIntervalSince1970) * 1000;
  if (ObjC.unwrap(app.bundleIdentifier) !== 'com.apple.TextEdit' || birth < earliest - 1000 || birth > latest + 1000) throw new Error('Recorded launch identity no longer matches');
  free();
  if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no prompt requested');
  const front = Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  if (front === pid) throw new Error('Owned TextEdit is foreground; cleanup refused');
  const ax = $.AXUIElementCreateApplication(pid); $.AXUIElementSetMessagingTimeout(ax, 1);
  const attr = (el, name) => { free(); const out = Ref(), status = Number($.AXUIElementCopyAttributeValue(el, $(name), out)); if (status) throw new Error(name + ' failed: ' + status); return ObjC.castRefToObject(out[0]); };
  const value = (el, name) => ObjC.unwrap(attr(el, name));
  const expected = ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString);
  function windows() {
    const rows = attr(ax, 'AXWindows');
    if (rows.count > 40) throw new Error('Window budget exceeded');
    const owned = [];
    for (let i = 0; i < rows.count; i++) {
      const w = rows.objectAtIndex(i), children = attr(w, 'AXChildren');
      if (children.count > 300 || ['AXDialog', 'AXSystemDialog'].includes(value(w, 'AXSubrole')) || value(w, 'AXModal') === true) throw new Error('Dialog or unreadable window; cleanup refused');
      for (let j = 0; j < children.count; j++) if (value(children.objectAtIndex(j), 'AXRole') === 'AXSheet') throw new Error('Sheet present; cleanup refused');
      try { if (value(w, 'AXDocument') === expected) owned.push(w); } catch (error) { if (inspectOnly) throw error; }
    }
    return { owned, count: Number(rows.count) };
  }
  const initial = windows();
  if (initial.owned.length > 1) throw new Error('Ambiguous owned fixture');
  // Inspection also obeys the hold and never counts as proof that the launch quit.
  if (inspectOnly) return JSON.stringify({ readOnly: true, fixtureClosed: initial.owned.length === 0, remainingWindows: initial.count, processQuit: false, unrelatedWindowsPreserved: true });
  if (initial.owned.length === 1) {
    const win = initial.owned[0]; let area, count = 0;
    const walk = (el, depth) => {
      if (++count > 300 || depth > 12) throw new Error('AX scan budget exceeded');
      if (value(el, 'AXRole') === 'AXTextArea') { if (area) throw new Error('Ambiguous text area'); area = el; return; }
      let children; try { children = attr(el, 'AXChildren'); } catch { return; }
      for (let i = 0; i < children.count; i++) walk(children.objectAtIndex(i), depth + 1);
    };
    walk(win, 0);
    const bytes = $.NSData.dataWithContentsOfFile(path);
    if (!area || !bytes || ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)) !== 'seed\n' || value(area, 'AXValue') !== 'seed\n' || value(win, 'AXEdited') !== false) throw new Error('Fixture differs from unchanged seed; no close sent');
    if (Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) !== front || value(win, 'AXDocument') !== expected) throw new Error('Identity changed before close');
    const close = attr(win, 'AXCloseButton'); free();
    const status = Number($.AXUIElementPerformAction(close, $('AXPress')));
    if (status) throw new Error('Owned close failed: ' + status);
    const deadline = Date.now() + 3000;
    while (windows().owned.length) { if (Date.now() > deadline) throw new Error('Owned close unconfirmed'); delay(0.1); }
  }
  const remaining = windows().count;
  if (remaining) return JSON.stringify({ fixtureClosed: true, remainingWindows: remaining, unrelatedWindowsPreserved: true, processQuit: false });
  free();
  if (Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) !== front) throw new Error('Foreground changed before quit');
  if (!app.terminate) throw new Error('Owned quit refused');
  const deadline = Date.now() + 3000;
  while (!app.isTerminated) { free(); if (Date.now() > deadline) throw new Error('Owned quit unconfirmed'); delay(0.1); }
  return JSON.stringify({ fixtureClosed: true, processQuit: true, remainingWindows: 0 });
}
