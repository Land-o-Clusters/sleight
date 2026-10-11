// Background-only operations on one owned temporary TextEdit document per run.
// Accessibility writes and PID-local settle events only. Cmd+S is the engine's
// pressKey("super+s"), never a posted key. Cleanup looks up TextEdit's PID and
// closes only the owned document. No activation, pointer, clipboard, permission
// request, dialog response or screenshot.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

const OWNED_PATH = /^\/private\/tmp\/sleight-save-lock-[A-Za-z0-9]+\/trial\.txt$/;

// The owned URL must be exactly one window. Extra owner documents and empty
// untitled windows are tolerated because this probe uses the already-running
// TextEdit (Open panel, not an isolated launch). Any dialog or sheet refuses.
function acceptOwnedWindows(rows, expectedURL) {
  if (!Array.isArray(rows) || rows.length === 0) return { accept: false, retry: true, reason: 'No window yet' };
  const owned = rows.filter(r => r.document === expectedURL);
  if (owned.length === 0) return { accept: false, retry: true, reason: 'Owned document window not open yet' };
  if (owned.length > 1) return { accept: false, reason: 'Ambiguous owned windows' };
  if (owned[0].modal || owned[0].sheet) return { accept: false, reason: 'Owned window has a dialog or sheet' };
  for (const r of rows) {
    if (r.modal || r.sheet) return { accept: false, reason: 'TextEdit has a dialog or sheet' };
  }
  const extras = rows.filter(r => r !== owned[0]);
  return {
    accept: true,
    owned: rows.indexOf(owned[0]),
    artifacts: extras.map(r => {
      if (r.document) return 'other-document';
      if (r.text === null) return 'panel';
      if (r.text === '') return 'empty-untitled';
      return 'untitled';
    }),
  };
}

function run() {
  const free = () => { if ($.NSFileManager.defaultManager.fileExistsAtPath('/tmp/sleight-hold')) throw new Error('Live hold exists; trial stopped'); };
  free();
  const stdin = $.NSFileHandle.fileHandleWithStandardInput;
  const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  let path, expectedURL, win, ax, area, pid, front, attachedCount, buffer = '';
  const attr = (el, name) => {
    free();
    const out = Ref(), status = Number($.AXUIElementCopyAttributeValue(el, $(name), out));
    if (status) throw new Error(name + ' failed: ' + status);
    return ObjC.castRefToObject(out[0]);
  };
  const value = (el, name) => ObjC.unwrap(attr(el, name));
  const optional = (el, name) => { try { return value(el, name); } catch (e) { if (/ failed: -252(05|12)$/.test(e.message)) return null; throw e; } };
  const frontPid = () => Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  function textEditPid() {
    const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
    if (Number(running.count) !== 1) throw new Error('Ambiguous or missing TextEdit process');
    return Number(running.objectAtIndex(0).processIdentifier);
  }
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
  function bindOwned(rows, choice) {
    attachedCount = rows.length;
    win = rows[choice.owned].el; area = rows[choice.owned].area;
    if (!area) throw new Error('Text area unavailable');
    for (const name of ['AXMainWindow', 'AXFocusedWindow']) if (value(attr(ax, name), 'AXDocument') !== expectedURL) throw new Error('Input window differs from owned document');
  }
  function verify() {
    if (frontPid() !== front || frontPid() === pid) throw new Error('Foreground changed; no input sent');
    const rows = windowRows(), choice = acceptOwnedWindows(rows, expectedURL);
    if (!choice.accept || rows.length > attachedCount) throw new Error('Owned window set changed: ' + (choice.reason || rows.length + ' windows'));
    bindOwned(rows, choice);
  }
  function key(code, flags, type) {
    free();
    const event = $.CGEventCreateKeyboardEvent(null, code, type === 'down' || type === 'flags-set');
    $.CGEventSetFlags(event, flags);
    if (type === 'flags-set' || type === 'flags-clear') $.CGEventSetType(event, $.kCGEventFlagsChanged);
    $.CGEventPostToPid(pid, event);
  }
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
    return { appleEventStatus: status, appleEventMs: ms, delivered: ![-1743, -1744, -600, -609].includes(status) };
  }
  function closeOwnedWindow() {
    const children = attr(win, 'AXChildren');
    let button;
    for (let i = 0; i < children.count; i++) {
      const child = children.objectAtIndex(i);
      if (optional(child, 'AXSubrole') === 'AXCloseButton' || optional(child, 'AXRole') === 'AXCloseButton') {
        if (button) throw new Error('Ambiguous close button');
        button = child;
      }
    }
    if (!button) throw new Error('Owned window has no close button');
    free();
    const status = Number($.AXUIElementPerformAction(button, $('AXPress')));
    if (status) throw new Error('AX close failed: ' + status);
  }
  function act(r) {
    free();
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no permission prompt requested');
    if (r.op === 'preflight') {
      if (!OWNED_PATH.test(r.path || '')) throw new Error('Expected owned temporary file');
      path = r.path; expectedURL = ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString);
      win = area = ax = attachedCount = undefined;
      pid = textEditPid();
      front = frontPid();
      if (front === pid) throw new Error('TextEdit is foreground; probe refused');
      // The engine types the path into the Open panel. If the panel didn't open, the text would go into
      // the focused document, so any document this probe didn't open stops the run.
      const foreign = Application('TextEdit').documents().filter(d => { try { return !OWNED_PATH.test(String(d.path())); } catch { return true; } });
      if (foreign.length) throw new Error(`TextEdit has ${foreign.length} document(s) this probe did not open; probe refused`);
      ax = $.AXUIElementCreateApplication(pid); $.AXUIElementSetMessagingTimeout(ax, 1);
      return { background: true, existingProcessCount: 1, pid, isolatedInstance: false };
    }
    if (r.op === 'lookup-pid') return { pid: textEditPid() };
    if (!path) throw new Error('No preflight for this run');
    if (r.op === 'attach') {
      win = area = undefined;
      if (frontPid() !== front) throw new Error('Foreground changed during open');
      if (textEditPid() !== pid) throw new Error('TextEdit process identity changed');
      let rows;
      try { rows = windowRows(); } catch (e) { throw new Error(/-25204$/.test(e.message) ? 'Retry: ' + e.message : e.message); }
      const choice = acceptOwnedWindows(rows, expectedURL);
      if (!choice.accept) throw new Error((choice.retry ? 'Retry: ' : 'Window refused: ') + choice.reason);
      if (Number($.AXUIElementSetAttributeValue(rows[choice.owned].el, $('AXMain'), $(true))) !== 0
        || Number($.AXUIElementPerformAction(rows[choice.owned].el, $('AXRaise'))) !== 0) {
        throw new Error('Could not select owned window in background');
      }
      try { bindOwned(rows, choice); verify(); } catch (e) { throw new Error(/Input window differs|-25204$/.test(e.message) ? 'Retry: ' + e.message : e.message); }
      return { attached: true, pid, windows: rows.length, artifacts: choice.artifacts };
    }
    if (r.op === 'close-owned') {
      if (!pid) throw new Error('No owned document attached');
      const result = { pid, foregroundSame: frontPid() === front, ownedFront: frontPid() === pid };
      if (frontPid() === pid) throw new Error('TextEdit is foreground; close refused');
      verify();
      const edited = optional(win, 'AXEdited') === true;
      if (edited) throw new Error('Owned document is still edited; close refused so no Save panel is answered');
      closeOwnedWindow();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        delay(0.1);
        if (frontPid() !== front) throw new Error('Foreground changed during close');
        let rows;
        try { rows = windowRows(); } catch (e) { throw new Error('Owned window unreadable after close: ' + e.message); }
        if (rows.some(w => w.modal || w.sheet)) throw new Error('A dialog or sheet appeared on close; no prompt answered');
        if (!rows.some(w => w.document === expectedURL)) {
          win = area = attachedCount = undefined;
          return { ...result, gone: true, method: 'ax-close', cleanup: 'pid-lookup' };
        }
      }
      throw new Error('Owned document still open after close');
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
      else if (r.variant === 'shift-pair') { key(56, $.kCGEventFlagMaskShift, 'flags-set'); delay(0.05); key(56, 0, 'flags-clear'); delay(0.05); }
      else if (r.variant === 'escape') { key(53, 0, 'down'); delay(0.05); key(53, 0, 'up'); }
      else if (r.variant === 'keyup-only') key(53, 0, 'up');
      else if (r.variant === 'applescript-read') out = appleEventRead();
      else throw new Error('Unknown event variant');
      delay(0.1); return { posted: r.variant, ...out };
    }
    if (r.op === 'state') {
      return { edited: optional(win, 'AXEdited') === true, text: value(area, 'AXValue') };
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
