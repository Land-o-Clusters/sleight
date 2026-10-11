// Background-only operations on one owned temporary TextEdit document per run.
// No activation, pointer, clipboard, permission request or dialog response.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

const OWNED_PATH = /^\/private\/tmp\/sleight-save-lock-[A-Za-z0-9]+\/trial\.txt$/;

// Decides whether the windows of the instance this run launched can be driven. Every row comes from
// that PID, which was absent at preflight and launched after this run's `open`. Rows hold the
// window's AXDocument (null when it has none), modal and sheet state, and its text area's value
// (null when the window has no text area). The owned document must be the only document. One
// extra window is tolerated when it can't hold anyone's data: no document, empty or no text area,
// not modal and no sheet, which is what a launch's untitled window or panel looks like.
function acceptOwnedWindows(rows, expectedURL) {
  if (!Array.isArray(rows) || rows.length === 0) return { accept: false, retry: true, reason: 'No window yet' };
  const owned = rows.filter(r => r.document === expectedURL);
  if (owned.length === 0) return { accept: false, retry: true, reason: 'Owned document window not open yet' };
  if (owned.length > 1) return { accept: false, reason: 'Ambiguous owned windows' };
  if (owned[0].modal || owned[0].sheet) return { accept: false, reason: 'Owned window has a dialog or sheet' };
  const extras = rows.filter(r => r !== owned[0]);
  if (extras.length > 1) return { accept: false, reason: 'More than one extra window' };
  for (const r of extras) {
    if (r.document !== null && r.document !== undefined) return { accept: false, reason: 'Extra window has a document' };
    if (r.modal || r.sheet) return { accept: false, reason: 'Extra window is modal or has a sheet' };
    if (typeof r.text === 'string' && r.text !== '') return { accept: false, reason: 'Extra untitled window has text' };
    if (r.text !== null && typeof r.text !== 'string') return { accept: false, reason: 'Extra window content unreadable' };
  }
  return { accept: true, owned: rows.indexOf(owned[0]), artifacts: extras.map(r => (r.text === null ? 'panel' : 'empty-untitled')) };
}

function run() {
  const free = () => { if ($.NSFileManager.defaultManager.fileExistsAtPath('/tmp/sleight-hold')) throw new Error('Live hold exists; trial stopped'); };
  free();
  const stdin = $.NSFileHandle.fileHandleWithStandardInput;
  const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  let path, expectedURL, win, ax, area, pid, front, ownedApp, attachedCount, priorPids = [], buffer = '';
  const attr = (el, name) => {
    free();
    const out = Ref(), status = Number($.AXUIElementCopyAttributeValue(el, $(name), out));
    if (status) throw new Error(name + ' failed: ' + status);
    return ObjC.castRefToObject(out[0]);
  };
  const value = (el, name) => ObjC.unwrap(attr(el, name));
  // Unsupported (-25205) and no value (-25212) read as null; anything else, such as -25204, throws.
  const optional = (el, name) => { try { return value(el, name); } catch (e) { if (/ failed: -252(05|12)$/.test(e.message)) return null; throw e; } };
  const frontPid = () => Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  const textArea = el => {
    let found, count = 0;
    const walk = (node, depth) => {
      if (++count > 300 || depth > 12) throw new Error('AX scan budget exceeded');
      if (optional(node, 'AXRole') === 'AXTextArea') { if (found) throw new Error('Ambiguous text areas'); found = node; return; }
      let children; try { children = attr(node, 'AXChildren'); } catch { return; }
      for (let i = 0; i < children.count; i++) walk(children.objectAtIndex(i), depth + 1);
    };
    walk(el, 0); return found;
  };
  function windowRows() {
    const windows = attr(ax, 'AXWindows'), rows = [];
    if (windows.count > 40) throw new Error('Window budget exceeded');
    for (let i = 0; i < windows.count; i++) {
      const w = windows.objectAtIndex(i), children = attr(w, 'AXChildren');
      if (children.count > 300) throw new Error('Child budget exceeded');
      let sheet = false;
      for (let j = 0; j < children.count; j++) if (optional(children.objectAtIndex(j), 'AXRole') === 'AXSheet') sheet = true;
      const subrole = optional(w, 'AXSubrole'), found = textArea(w);
      const text = found ? (optional(found, 'AXValue') ?? '') : null;
      rows.push({ el: w, area: found, document: optional(w, 'AXDocument'), modal: optional(w, 'AXModal') === true || subrole === 'AXSystemDialog', sheet, text });
    }
    return rows;
  }
  function verify() {
    if (frontPid() !== front || frontPid() === pid) throw new Error('Foreground changed; no input sent');
    const rows = windowRows(), choice = acceptOwnedWindows(rows, expectedURL);
    // A launch's untitled window may close itself later; a new window stops input.
    if (!choice.accept || rows.length > attachedCount) throw new Error('Owned window set changed: ' + (choice.reason || rows.length + ' windows'));
    attachedCount = rows.length;
    win = rows[choice.owned].el; area = rows[choice.owned].area;
    if (!area) throw new Error('Text area unavailable');
    for (const name of ['AXMainWindow', 'AXFocusedWindow']) if (value(attr(ax, name), 'AXDocument') !== expectedURL) throw new Error('Input window differs from owned document');
  }
  function key(code, flags, type) {
    free();
    const event = $.CGEventCreateKeyboardEvent(null, code, type === 'down' || type === 'flags-set');
    $.CGEventSetFlags(event, flags);
    if (type === 'flags-set' || type === 'flags-clear') $.CGEventSetType(event, $.kCGEventFlagsChanged);
    $.CGEventPostToPid(pid, event);
  }
  // `text of document "trial.txt"` as a raw Apple Event to the owned PID, so it can't reach
  // another TextEdit instance. It never asks for Automation consent (kAEDoNotPromptForUserConsent).
  function appleEventRead() {
    const D = $.NSAppleEventDescriptor, code = s => [...s].reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
    const spec = (want, form, seld, from) => {
      const rec = D.recordDescriptor;
      rec.setDescriptorForKeyword(D.descriptorWithTypeCode(code(want)), code('want'));
      rec.setDescriptorForKeyword(D.descriptorWithEnumCode(code(form)), code('form'));
      rec.setDescriptorForKeyword(seld, code('seld'));
      rec.setDescriptorForKeyword(from || D.nullDescriptor, code('from'));
      return rec.coerceToDescriptorType(code('obj '));
    };
    const doc = spec('docu', 'name', D.descriptorWithString('trial.txt'), null);
    const event = D.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(code('core'), code('getd'), D.descriptorWithProcessIdentifier(pid), -1, 0);
    event.setParamDescriptorForKeyword(spec('prop', 'prop', D.descriptorWithTypeCode(code('ctxt')), doc), code('----'));
    const error = $(); free();
    const sentAt = Date.now(), reply = event.sendEventWithOptionsTimeoutError(0x3 | 0x10 | 0x20000, 3, error);
    const ms = Date.now() - sentAt;
    let status = 0;
    if (!reply || reply.isNil()) { try { status = Number(error.code) || -1; } catch { status = -1; } }
    else { const errn = reply.paramDescriptorForKeyword(code('errn')); if (errn && !errn.isNil()) status = Number(errn.int32Value); }
    // Consent missing or refused, or no such process: TextEdit never saw the event.
    return { appleEventStatus: status, appleEventMs: ms, delivered: ![-1743, -1744, -600, -609].includes(status) };
  }
  function act(r) {
    free();
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no permission prompt requested');
    if (r.op === 'preflight') {
      if (!OWNED_PATH.test(r.path || '')) throw new Error('Expected owned temporary file');
      path = r.path; expectedURL = ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString);
      pid = win = area = ax = ownedApp = attachedCount = undefined;
      const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
      front = frontPid();
      priorPids = [];
      for (let i = 0; i < running.count; i++) priorPids.push(Number(running.objectAtIndex(i).processIdentifier));
      if (priorPids.includes(front)) throw new Error('TextEdit is foreground; probe refused');
      return { background: true, existingProcessCount: priorPids.length, isolatedInstance: true };
    }
    if (!path) throw new Error('No preflight for this run');
    const launchedAfter = app => Number(app.launchDate.timeIntervalSince1970) * 1000 >= Number(r.earliest);
    if (r.op === 'attach') {
      win = area = undefined;
      if (frontPid() !== front) throw new Error('Foreground changed during open');
      if (!pid) {
        const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit'), candidates = [];
        for (let i = 0; i < running.count; i++) { const a = running.objectAtIndex(i); if (!priorPids.includes(Number(a.processIdentifier))) candidates.push(a); }
        if (candidates.length === 0) throw new Error('Retry: New TextEdit process not registered yet');
        if (candidates.length !== 1 || !launchedAfter(candidates[0])) throw new Error('Ambiguous newly launched TextEdit process');
        ownedApp = candidates[0]; pid = Number(ownedApp.processIdentifier);
        ax = $.AXUIElementCreateApplication(pid); $.AXUIElementSetMessagingTimeout(ax, 1);
      }
      let rows;
      try { rows = windowRows(); } catch (e) { throw new Error(/-25204$/.test(e.message) ? 'Retry: ' + e.message : e.message); }
      const choice = acceptOwnedWindows(rows, expectedURL);
      if (!choice.accept) throw new Error((choice.retry ? 'Retry: ' : 'Window refused: ') + choice.reason);
      attachedCount = rows.length;
      // A window can show before it is key, so a mismatched input window gets the retries too.
      try { verify(); } catch (e) { throw new Error(/Input window differs|-25204$/.test(e.message) ? 'Retry: ' + e.message : e.message); }
      return { attached: true, pid, windows: rows.length, artifacts: choice.artifacts };
    }
    if (r.op === 'end-owned') {
      // Quit only the launch this run made: absent at preflight, TextEdit, launched after `open`.
      if (!ownedApp) {
        // A slow launch may register late, so look for 3 s before calling it absent.
        let candidates = [];
        for (const deadline = Date.now() + 3000; ;) {
          const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
          candidates = [];
          for (let i = 0; i < running.count; i++) { const a = running.objectAtIndex(i); if (!priorPids.includes(Number(a.processIdentifier)) && launchedAfter(a)) candidates.push(a); }
          if (candidates.length || Date.now() > deadline) break;
          delay(0.2);
        }
        if (candidates.length === 0) return { gone: true, method: 'never-registered' };
        if (candidates.length !== 1) throw new Error('Ambiguous owned launch; quit refused');
        ownedApp = candidates[0]; pid = Number(ownedApp.processIdentifier);
        ax = $.AXUIElementCreateApplication(pid); $.AXUIElementSetMessagingTimeout(ax, 1);
      }
      if (ObjC.unwrap(ownedApp.bundleIdentifier) !== 'com.apple.TextEdit' || priorPids.includes(pid) || !launchedAfter(ownedApp)) throw new Error('Owned launch identity unproven; quit refused');
      const result = { pid, foregroundSame: frontPid() === front, ownedFront: frontPid() === pid };
      if (ownedApp.isTerminated) return { ...result, gone: true, method: 'already-exited' };
      let clean = false;
      try {
        const rows = windowRows();
        if (rows.some(w => (w.document !== null && w.document !== expectedURL) || (w.document === null && typeof w.text === 'string' && w.text !== ''))) {
          throw new Error('Owned launch shows a window this run did not open; quit refused');
        }
        const owned = rows.find(w => w.document === expectedURL), bytes = $.NSData.dataWithContentsOfFile(path);
        const disk = bytes ? ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)) : undefined;
        clean = rows.every(w => !w.modal && !w.sheet) && (!owned || (owned.text === disk && optional(owned.el, 'AXEdited') === false));
        result.windows = rows.length;
      } catch (e) { if (/quit refused/.test(e.message)) throw e; result.windowsUnreadable = e.message; }
      free();
      // A saved document quits normally. A hung or unsaved one is killed, which discards only
      // this run's temporary buffer.
      // isTerminated only updates when the run loop turns, which delay() doesn't do, so a TextEdit
      // that had exited still read as running (2026-10-10). A fresh lookup by PID is current.
      const ownedPid = Number(ownedApp.processIdentifier);
      const gone = () => { const now = $.NSRunningApplication.runningApplicationWithProcessIdentifier(ownedPid); return now.isNil() || now.isTerminated; };
      if (clean) {
        ownedApp.terminate; result.method = 'terminate';
        const deadline = Date.now() + 3000; while (!gone() && Date.now() < deadline) delay(0.1);
      }
      if (!gone()) {
        ownedApp.forceTerminate; result.method = clean ? 'terminate-then-force' : 'force';
        const deadline = Date.now() + 5000; while (!gone() && Date.now() < deadline) delay(0.1);
      }
      if (!gone()) throw new Error('Owned TextEdit quit unconfirmed');
      pid = ownedApp = ax = win = area = undefined;
      return { ...result, gone: true };
    }
    if (!pid) throw new Error('No owned launch attached');
    verify();
    if (r.op === 'edit') {
      if (typeof r.text !== 'string' || !/^probe-[0-9]+\n$/.test(r.text)) throw new Error('Unexpected fixture text');
      free(); const status = Number($.AXUIElementSetAttributeValue(area, $('AXValue'), $(r.text)));
      if (status) throw new Error('AXValue edit failed: ' + status);
      return { edited: value(area, 'AXValue') === r.text };
    }
    if (r.op === 'event') {
      let out = { delivered: true };
      if (r.variant === 'none') {}
      // Same events and spacing as settleAfterTextWrite in plugins/sleight/lib/drag.js, which runs
      // as its own osascript and can't be imported here.
      else if (r.variant === 'shift-pair') { key(56, $.kCGEventFlagMaskShift, 'flags-set'); delay(0.05); key(56, 0, 'flags-clear'); delay(0.05); }
      else if (r.variant === 'escape') { key(53, 0, 'down'); delay(0.05); key(53, 0, 'up'); }
      else if (r.variant === 'keyup-only') key(53, 0, 'up'); // keyUp (11) is outside NSDocument's monitor mask 0x0BC014CA
      else if (r.variant === 'applescript-read') out = appleEventRead();
      else throw new Error('Unknown event variant');
      delay(0.1); return { posted: r.variant, ...out };
    }
    if (r.op === 'save') {
      key(1, $.kCGEventFlagMaskCommand, 'down'); const postedAt = Date.now(); delay(0.05); key(1, 0, 'up');
      return { saveRequested: true, postedAt };
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
