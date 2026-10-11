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
// Unsupported (-25205) and no-value (-25212) attributes read as null; anything else, such as a
// busy -25204 that the harness retries, throws. Matches bench/textedit-save-lock.js.
function soft(el, name) {
  try { return ObjC.unwrap(attribute(el, name)); }
  catch (error) { if (/ failed: -252(05|12)$/.test(error.message)) return null; throw error; }
}
function liveTextEditApps(running) {
  const live = [];
  for (let i = 0; i < Number(running.count); i++) {
    const app = running.objectAtIndex(i);
    if (Number(app.isTerminated) === 1) continue;
    live.push(app);
  }
  return live;
}
function oneLiveTextEdit(running) {
  const live = liveTextEditApps(running);
  if (live.length !== 1) {
    const extras = live.map(app => (ObjC.unwrap(app.localizedName) || 'TextEdit') + ' pid ' + Number(app.processIdentifier)).join(', ');
    throw new Error(live.length ? 'Ambiguous TextEdit process: ' + extras : 'Ambiguous TextEdit process');
  }
  return live[0];
}
// The dialog signals on one window. Until 2026-10-11 this decision swept every window of the
// TextEdit instance and refused metadata it could not read; the engine read right after each
// refusal showed the check's one window, the owned document, with no sheet or dialog. Now only the
// owned window is scanned, and verify()'s main and focused window identity checks still refuse when
// input would land anywhere else.
function dialogSignal(subrole, modal, childRoles) {
  if (subrole === 'AXDialog' || subrole === 'AXSystemDialog') return 'window subrole ' + subrole;
  if (modal === true) return 'window is modal';
  const child = (childRoles ?? []).find(role => role === 'AXSheet' || role === 'AXDialog');
  return child ? 'child role ' + child : null;
}
// Scans owned windows only and returns the first reason, or null. `read` is a soft reader whose
// throws carry the AX code, so a busy -25204 reaches the harness's retry class unchanged.
function firstOwnedDialogSignal(windows, read, isOwned) {
  for (let i = 0; i < Number(windows.count); i++) {
    const window = windows.objectAtIndex(i);
    if (!isOwned(window)) continue;
    const children = read(window, 'AXChildren');
    if (children == null) throw new Error('Owned window has no readable children');
    if (Number(children.count) > 300) throw new Error('Dialog scan exceeded its child budget');
    const roles = [];
    for (let j = 0; j < Number(children.count); j++) roles.push(read(children.objectAtIndex(j), 'AXRole'));
    return dialogSignal(read(window, 'AXSubrole'), read(window, 'AXModal'), roles);
  }
  return null;
}
// A signal confirmed on a second scan, 0.3 s later, is a dialog; one that vanishes was a window
// tree still settling, which is what the three 2026-10-11 refusals were (each engine read right
// after showed the owned document with no sheet or dialog). `readWindows` scans afresh each call.
function confirmedDialogSignal(readWindows, read, isOwned) {
  if (!firstOwnedDialogSignal(readWindows(), read, isOwned)) return null;
  delay(0.3);
  return firstOwnedDialogSignal(readWindows(), read, isOwned);
}
// One record per window for refusal evidence: title, subrole and identifier (null, with the error
// code, when TextEdit does not expose it), document, modal state and direct child roles. `read`
// returns { ok, value } or { ok, code } and never throws; neither does this scan.
function collectWindowRecords(windows, read) {
  const rows = [];
  for (let i = 0; i < Number(windows?.count ?? 0); i++) {
    const window = windows.objectAtIndex(i), row = { index: i };
    for (const [key, name] of [['title', 'AXTitle'], ['subrole', 'AXSubrole'], ['identifier', 'AXIdentifier'], ['document', 'AXDocument'], ['modal', 'AXModal']]) {
      const result = read(window, name);
      row[key] = result.ok ? result.value : null;
      if (!result.ok) row[key + 'Error'] = result.code;
    }
    const children = read(window, 'AXChildren');
    if (!children.ok) { row.childRoles = null; row.childrenError = children.code; }
    else if (Number(children.value?.count ?? 0) > 300) { row.childRoles = null; row.childrenError = 'over budget'; }
    else {
      row.childRoles = [];
      row.childrenError = null;
      for (let j = 0; j < Number(children.value.count); j++) {
        const role = read(children.value.objectAtIndex(j), 'AXRole');
        row.childRoles.push(role.ok ? role.value ?? 'unreadable' : 'error:' + role.code);
      }
    }
    rows.push(row);
  }
  return rows;
}
function run(argv) {
  const path = argv[0];
  if (!/^\/private\/tmp\/sleight-exact-[A-Za-z0-9]+\/exact\.txt$/.test(path)) throw new Error('Expected an owned temporary file');
  const stdin = $.NSFileHandle.fileHandleWithStandardInput, stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  const app = Application('TextEdit');
  let doc, win, ax, textArea, originalFront, ownedApp, ownedPid, priorPids = [], earliest = 0, buffer = '';
  const frontPid = () => Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  const expectedURL = () => ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString);
  const textEditPids = () => {
    const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit'), pids = [];
    for (let i = 0; i < Number(running.count); i++) if (Number(running.objectAtIndex(i).isTerminated) !== 1) pids.push(Number(running.objectAtIndex(i).processIdentifier));
    return pids;
  };
  const launchedAfter = pid => {
    const candidate = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    return !candidate.isNil() && Number(candidate.launchDate.timeIntervalSince1970) * 1000 >= earliest;
  };
  const ownedElement = el => { try { return Boolean($.CFEqual(win, el)); } catch { return false; } };
  const noDialogs = () => {
    if (!ax || !win) return;
    const readWindows = () => {
      const windows = attribute(ax, 'AXWindows');
      if (Number(windows.count) > 40) throw new Error('Dialog scan exceeded its window budget');
      return windows;
    };
    const reason = confirmedDialogSignal(readWindows, soft, ownedElement);
    if (reason) throw new Error('Owned window shows a dialog (' + reason + '); no action will be sent');
  };
  const textOf = window => {
    let found, count = 0;
    const walk = node => {
      if (++count > 300) throw new Error('AX scan budget exceeded');
      if (soft(node, 'AXRole') === 'AXTextArea') { if (found) throw new Error('Ambiguous text areas'); found = node; return; }
      let children; try { children = attribute(node, 'AXChildren'); } catch { return; }
      for (let i = 0; i < Number(children.count); i++) walk(children.objectAtIndex(i));
    };
    walk(window);
    return found ? soft(found, 'AXValue') : null;
  };
  const diagRead = (el, name) => {
    try { return { ok: true, value: ObjC.unwrap(attribute(el, name)) }; }
    catch (error) { return { ok: false, code: /failed: (-?\d+)$/.exec(String(error.message || error))?.[1] ?? String(error.message || error) }; }
  };
  const cgWindowRows = pids => {
    const all = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0)), rows = [];
    for (let i = 0; i < Number(all?.count ?? 0); i++) {
      const w = ObjC.deepUnwrap(all.objectAtIndex(i));
      if (!pids.includes(Number(w?.kCGWindowOwnerPID)) || Number(w?.kCGWindowLayer) !== 0) continue;
      rows.push({ windowNumber: w.kCGWindowNumber, title: w.kCGWindowName ?? null, onscreen: w.kCGWindowIsOnscreen === true, bounds: w.kCGWindowBounds });
    }
    return rows;
  };
  // Attached to every failed request, so a refusal names every TextEdit window the instance had.
  const windowsDiagnostic = () => {
    if (ax) {
      try { return { via: 'ax', pid: ownedPid ?? null, windows: collectWindowRecords(attribute(ax, 'AXWindows'), diagRead) }; }
      catch (error) { return { via: 'ax', pid: ownedPid ?? null, windows: [], error: String(error.message || error) }; }
    }
    const pids = textEditPids();
    return pids.length ? { via: 'cg', pids, windows: cgWindowRows(pids) } : null;
  };
  const verify = () => {
    if (frontPid() !== originalFront) throw new Error('Foreground changed; stopping without input');
    if (String(doc.path()) !== path) throw new Error('Retained document identity changed');
    if (win) {
      noDialogs();
      const url = ObjC.unwrap(attribute(win, 'AXDocument'));
      if (url !== expectedURL()) throw new Error('Retained window identity changed');
      if (ObjC.unwrap(attribute(win, 'AXMain')) !== true) throw new Error('Owned window is no longer the app main window');
      for (const name of ['AXMainWindow', 'AXFocusedWindow']) {
        if (ObjC.unwrap(attribute(attribute(ax, name), 'AXDocument')) !== url) throw new Error('Current app input window differs from the retained fixture');
      }
    }
  };
  function act(request) {
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no permission prompt requested');
    if (request.op === 'preflight') {
      priorPids = textEditPids();
      return { running: app.running(), foregroundTextEdit: ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier) === 'com.apple.TextEdit', pids: priorPids };
    }
    if (request.op === 'attach') {
      originalFront = frontPid();
      if (ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier) === 'com.apple.TextEdit') throw new Error('TextEdit is foreground; background probe refused');
      earliest = Number(request.earliest) || earliest;
      if (request.ownedInstance) {
        // The instance this run launched: a TextEdit process absent at preflight, started after
        // `open` was requested. A second new process is ambiguous and refuses.
        ownedApp = undefined;
        for (const pid of textEditPids()) {
          if (priorPids.includes(pid) || !launchedAfter(pid)) continue;
          const candidate = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
          if (ObjC.unwrap(candidate.bundleIdentifier) !== 'com.apple.TextEdit') continue;
          if (ownedApp) throw new Error('Ambiguous TextEdit process: pids ' + Number(ownedApp.processIdentifier) + ', ' + pid);
          ownedApp = candidate;
        }
        if (!ownedApp) throw new Error('Retry: New TextEdit process not registered yet');
        ownedPid = Number(ownedApp.processIdentifier);
        if (Number(oneLiveTextEdit($.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit')).processIdentifier) !== ownedPid) throw new Error('Ambiguous TextEdit process: a second instance is running');
      } else {
        ownedPid = Number(oneLiveTextEdit($.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit')).processIdentifier);
      }
      ax = $.AXUIElementCreateApplication(ownedPid);
      if (Number($.AXUIElementSetMessagingTimeout(ax, 1)) !== 0) throw new Error('Could not bound fixture AX messaging');
      const matches = app.documents().filter(d => { try { return String(d.path()) === path; } catch { return false; } });
      if (matches.length === 0) throw new Error('Retry: Owned document not open yet');
      if (matches.length !== 1) throw new Error('Expected one owned document');
      doc = matches[0];
      const windows = attribute(ax, 'AXWindows'), candidates = [];
      for (let i = 0; i < windows.count; i++) {
        const candidate = windows.objectAtIndex(i);
        try { if (ObjC.unwrap(attribute(candidate, 'AXDocument')) === expectedURL()) candidates.push(candidate); } catch {}
      }
      if (candidates.length === 0) throw new Error('Retry: Owned AX window not present yet');
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
      verify(); return { attached: true, pid: ownedPid, ownedInstance: Boolean(request.ownedInstance) };
    }
    if (request.op === 'close') {
      if (!doc || String(doc.path()) !== path) throw new Error('Retained document identity changed');
      noDialogs();
      doc.close({ saving: 'no' });
      const remains = app.documents().some(d => { try { return String(d.path()) === path; } catch { return false; } });
      if (remains) throw new Error('Owned document remains open');
      return { closed: true, foregroundSame: frontPid() === originalFront };
    }
    if (request.op === 'end-owned') {
      // Quit only the launch this run made: a TextEdit process absent at preflight, started after
      // this run's `open`. A killed instance discards only this run's temporary buffer.
      earliest = Number(request.earliest) || earliest;
      if (!ownedPid) {
        let candidates = [];
        for (const deadline = Date.now() + 3000; ;) {
          candidates = textEditPids().filter(pid => !priorPids.includes(pid) && launchedAfter(pid));
          if (candidates.length || Date.now() > deadline) break;
          delay(0.2);
        }
        if (candidates.length === 0) return { gone: true, method: 'never-registered' };
        if (candidates.length !== 1) throw new Error('Ambiguous owned launch; quit refused');
        ownedPid = candidates[0];
        ax = $.AXUIElementCreateApplication(ownedPid);
        $.AXUIElementSetMessagingTimeout(ax, 1);
      }
      const now = $.NSRunningApplication.runningApplicationWithProcessIdentifier(ownedPid);
      if (now.isNil() || ObjC.unwrap(now.bundleIdentifier) !== 'com.apple.TextEdit' || priorPids.includes(ownedPid) || !launchedAfter(ownedPid)) throw new Error('Owned launch identity unproven; quit refused');
      const result = { pid: ownedPid, foregroundSame: frontPid() === originalFront };
      const gone = () => { const fresh = $.NSRunningApplication.runningApplicationWithProcessIdentifier(ownedPid); return fresh.isNil() || fresh.isTerminated; };
      if (now.isTerminated) return { ...result, gone: true, method: 'already-exited' };
      let clean = false;
      try {
        const windows = attribute(ax, 'AXWindows');
        if (Number(windows.count) > 40) throw new Error('Window budget exceeded');
        const bytes = $.NSData.dataWithContentsOfFile(path);
        const disk = bytes ? ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)) : undefined;
        clean = true;
        for (let i = 0; i < Number(windows.count); i++) {
          const w = windows.objectAtIndex(i), document = soft(w, 'AXDocument'), text = textOf(w);
          const dialog = firstOwnedDialogSignal({ count: 1, objectAtIndex: () => w }, soft, () => true);
          if ((document != null && document !== expectedURL()) || (document == null && typeof text === 'string' && text !== '')) throw new Error('Owned launch shows a window this run did not open; quit refused');
          if (dialog) clean = false;
          if (document === expectedURL() && text !== disk) clean = false;
        }
      } catch (e) { if (/quit refused/.test(e.message)) throw e; result.windowsUnreadable = String(e.message || e); }
      // A saved document quits normally. Anything uncertain is killed, which discards only this
      // run's temporary buffer. isTerminated only updates when the run loop turns, so a fresh
      // lookup by PID is what confirms the quit (bench/textedit-save-lock.js, 2026-10-10).
      if (clean) {
        ownedApp?.terminate; result.method = 'terminate';
        const deadline = Date.now() + 3000; while (!gone() && Date.now() < deadline) delay(0.1);
      }
      if (!gone()) {
        $.NSRunningApplication.runningApplicationWithProcessIdentifier(ownedPid).forceTerminate; result.method = clean ? 'terminate-then-force' : 'force';
        const deadline = Date.now() + 5000; while (!gone() && Date.now() < deadline) delay(0.1);
      }
      if (!gone()) throw new Error('Owned TextEdit quit unconfirmed');
      ax = win = doc = textArea = ownedApp = ownedPid = undefined;
      return { ...result, gone: true };
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
      catch (error) {
        reply = { id: null, ok: false, error: String(error.message || error) };
        try { const diagnostic = windowsDiagnostic(); if (diagnostic) reply.windows = diagnostic; } catch {}
      }
      stdout.writeData($(JSON.stringify(reply) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
}
