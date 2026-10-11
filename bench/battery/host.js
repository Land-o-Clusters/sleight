// Generic native lifecycle and 200 ms focus observer. Never emits titles or text.
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics'); ObjC.import('Foundation');
function run(argv) {
  var request = JSON.parse(argv[0]), started = Date.now(), retained = [], samples = [];
  var initial = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.bundle);
  var wasRunning = initial.count > 0, target = wasRunning ? initial.objectAtIndex(0) : null;
  var pid = target ? Number(target.processIdentifier) : null, launched = false, ready = false;
  var expected = request.targetURL, baselineFront, baselineOwnerWindows;
  function emit(data) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(data) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
  function wait() { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2)); }
  function active() {
    var raw = $.NSString.stringWithContentsOfFileEncodingError(request.control, $.NSUTF8StringEncoding, null);
    if (raw && JSON.parse(ObjC.unwrap(raw)).command === 'abort') throw new Error('HOST_STOP');
  }
  function readAttribute(element, name) {
    var value = Ref();
    var code = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
    return { code: code, value: code === 0 ? value[0] : null };
  }
  function attribute(element, name) { return readAttribute(element, name).value; }
  function windows() {
    if (!pid) return [];
    var read = readAttribute($.AXUIElementCreateApplication(pid), 'AXWindows');
    if (read.code !== 0 || !read.value) {
      var error = new Error('WINDOWS_READ_FAILED'); error.axStatus = read.code; throw error;
    }
    var list = ObjC.castRefToObject(read.value), out = [];
    for (var n = 0; n < list.count; n++) out.push(list.objectAtIndex(n));
    return out;
  }
  function same(a, b) { return !!$.CFEqual(a, b); }
  var before = windows();
  function retain() {
    var current = windows();
    current.forEach(function(w) {
      if (before.some(function(old) { return same(w, old); }) || retained.some(function(old) { return same(w, old); })) return;
      var document = attribute(w, 'AXDocument');
      var match = document && expected && String(ObjC.unwrap(ObjC.castRefToObject(document))) === expected;
      // Exact document URL binds an existing app's new window. A newly launched
      // process's first windows belong to this launch; later windows do not.
      if (match || (launched && !ready)) retained.push(w);
    });
  }
  function sample() {
    var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
    var order = [];
    for (var i = 0; i < list.count; i++) {
      var w = list.objectAtIndex(i);
      if (Number(ObjC.unwrap(w.objectForKey('kCGWindowLayer'))) !== 0) continue;
      var ownerPID = Number(ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')));
      var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(ownerPID);
      var bundle = app && app.bundleIdentifier ? ObjC.unwrap(app.bundleIdentifier) : null;
      order.push({ id: Number(ObjC.unwrap(w.objectForKey('kCGWindowNumber'))), pid: ownerPID, bundle: bundle,
        bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')) });
    }
    var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    var frontBundle = front && front.bundleIdentifier ? ObjC.unwrap(front.bundleIdentifier) : null;
    if (baselineFront === undefined) {
      baselineFront = frontBundle;
      baselineOwnerWindows = order.filter(function(w) { return w.bundle === baselineFront; }).map(function(w) { return w.id; });
    }
    var targetIndex = order.findIndex(function(w) { return w.bundle === request.bundle; });
    var overOwner = targetIndex >= 0 && order.some(function(w, i) {
      if (i <= targetIndex || baselineOwnerWindows.indexOf(w.id) < 0) return false;
      var a = order[targetIndex].bounds, b = w.bounds;
      return a.X < b.X + b.Width && b.X < a.X + a.Width && a.Y < b.Y + b.Height && b.Y < a.Y + a.Height;
    });
    var row = { atMs: Date.now() - started, front: frontBundle, order: order,
      focusChanged: frontBundle !== baselineFront, targetOverOwner: overOwner };
    samples.push(row); emit({ stage: 'sample', sample: row });
  }
  function cleanup() {
    var details = { reasons: [], windows: [] }, clean = true;
    function reason(row, code) { if (row.reasons.indexOf(code) < 0) row.reasons.push(code); }
    function present(w, current) { return current.some(function(now) { return same(w, now); }); }
    function inspect(w, row) {
      var doc = readAttribute(w, 'AXDocument');
      row.document = doc.value ? String(ObjC.unwrap(ObjC.castRefToObject(doc.value))) : null;
      row.documentStatus = doc.code;
      row.documentReads.push({ document: row.document, status: doc.code });
      row.matched = !!expected && doc.code === 0 && row.document === expected;
      var sheets = readAttribute(w, 'AXSheets');
      row.sheetStatus = sheets.code;
      row.sheet = !!sheets.value && ObjC.castRefToObject(sheets.value).count > 0;
      if (expected && !row.matched) reason(row, 'DOCUMENT_NOT_MATCHED');
      if (row.sheet) reason(row, 'SHEET_PRESENT');
      if (sheets.code !== 0 && sheets.code !== -25205) reason(row, 'SHEETS_READ_FAILED');
      return (!expected || row.matched) && !row.sheet && (sheets.code === 0 || sheets.code === -25205);
    }
    function ownFixture() {
      var path = request.fixturePath, root = request.fixtureRoot;
      return path && root && root.indexOf('/private/tmp/sleight-battery-') === 0 &&
        path.slice(0, path.lastIndexOf('/')) === root && !/(^|\/)\.\.?($|\/)/.test(path) &&
        String(ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString)) === expected;
    }
    function quote(value) { return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"'; }
    function recordNew(current, entries) {
      current.forEach(function(w) {
        if (present(w, before) || entries.some(function(entry) { return same(w, entry.window); })) return;
        var row = { index: entries.length, retained: false, expectedURL: expected || null,
          reasons: ['WINDOW_NOT_RETAINED'], documentReads: [], present: true };
        inspect(w, row); clean = false;
        details.windows.push(row); entries.push({ window: w, retained: false, row: row });
      });
    }
    function pollWindows() {
      var current = windows(); recordNew(current, entries); return current;
    }
    try {
      var current = windows();
      if (expected && !retained.length) reason(details, 'FIXTURE_WINDOW_NOT_RETAINED');
      var entries = retained.map(function(w) { return { window: w, retained: true }; });
      current.forEach(function(w) {
        if (!present(w, before) && !present(w, retained)) entries.push({ window: w, retained: false });
      });
      entries.forEach(function(entry, index) {
        var w = entry.window, row = { index: index, retained: entry.retained, expectedURL: expected || null,
          reasons: [], documentReads: [], present: present(w, current) };
        entry.row = row; details.windows.push(row);
        if (!row.present) return;
        active();
        var safe = inspect(w, row);
        if (!entry.retained) { reason(row, 'WINDOW_NOT_RETAINED'); clean = false; return; }
        if (!safe) { clean = false; return; }
        var close = attribute(w, 'AXCloseButton');
        if (!close) reason(row, 'CLOSE_BUTTON_MISSING');
        else {
          row.axPressStatus = Number($.AXUIElementPerformAction(close, $('AXPress')));
          if (row.axPressStatus !== 0) reason(row, 'AXPRESS_FAILED');
        }
      });
      var closeDeadline = Date.now() + 10000;
      current = pollWindows();
      while (retained.some(function(w) { return present(w, current); }) && Date.now() < closeDeadline) {
        active(); sample(); wait(); current = pollWindows();
      }
      entries.forEach(function(entry) {
        var w = entry.window, row = entry.row;
        // One document-level close can remove several retained windows.
        current = pollWindows();
        row.stillPresentAfter10s = present(w, current);
        if (!row.stillPresentAfter10s) return;
        reason(row, 'WINDOW_STILL_PRESENT_AFTER_10S');
        // Revalidate the retained reference after waiting, immediately before scripting.
        active();
        if (!inspect(w, row)) { clean = false; return; }
        if (!entry.retained || !clean) return;
        if (!ownFixture()) { reason(row, 'SCRIPTING_NOT_OWN_FIXTURE'); return; }
        row.scriptingPath = request.fixturePath;
        var script = 'tell application id ' + quote(request.bundle) + '\nclose (documents whose path is ' + quote(request.fixturePath) + ') saving no\nend tell';
        var error = Ref();
        try {
          var result = $.NSAppleScript.alloc.initWithSource($(script)).executeAndReturnError(error);
          row.scriptingStatus = result ? 0 : Number((ObjC.deepUnwrap(error[0]) || {}).NSAppleScriptErrorNumber) || null;
        } catch (_) { row.scriptingStatus = null; }
        if (row.scriptingStatus !== 0) reason(row, 'SCRIPTING_FAILED');
      });
      var scriptDeadline = Date.now() + 10000;
      current = pollWindows();
      while (entries.some(function(entry) { return entry.row.scriptingPath && present(entry.window, current); }) && Date.now() < scriptDeadline) {
        active(); sample(); wait(); current = pollWindows();
      }
      entries.forEach(function(entry) {
        var row = entry.row; row.present = present(entry.window, current);
        if (row.present) { clean = false; if (row.scriptingPath) reason(row, 'WINDOW_STILL_PRESENT_AFTER_SCRIPTING'); }
        if (row.reasons.indexOf('SCRIPTING_FAILED') >= 0) clean = false;
      });
      if (details.reasons.length) clean = false;
      if (launched && clean) {
        active();
        var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
        details.app = { pid: pid, terminated: false };
        if (!app || ObjC.unwrap(app.bundleIdentifier) !== request.bundle) { reason(details, 'APP_IDENTITY_UNCONFIRMED'); clean = false; }
        else if (pollWindows().length) { reason(details, 'APP_HAS_WINDOWS'); clean = false; }
        else {
          details.app.terminateRequested = !!app.terminate;
          var deadline = Date.now() + 30000;
          while (!app.terminated && Date.now() < deadline) { active(); sample(); wait(); }
          details.app.terminated = !!app.terminated;
          if (!app.terminated) { reason(details, 'APP_NOT_TERMINATED'); clean = false; }
        }
      }
    } catch (error) {
      clean = false;
      reason(details, error.message === 'WINDOWS_READ_FAILED' ? error.message : error.message === 'HOST_STOP' ? 'HOST_ABORTED' : 'CLEANUP_FAILED');
      if (error.axStatus !== undefined) details.axStatus = error.axStatus;
    }
    emit({ stage: 'cleanup', confirmed: clean, details: details });
  }
  sample(); emit({ stage: 'armed', wasRunning: wasRunning });
  var end = Date.now() + 600000;
  while (Date.now() < end) {
    var raw = $.NSString.stringWithContentsOfFileEncodingError(request.control, $.NSUTF8StringEncoding, null);
    var command = raw ? JSON.parse(ObjC.unwrap(raw)).command : '';
    if (command === 'abort') { emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['HOST_ABORTED'], windows: [] } }); return ''; }
    if (command === 'launched' && !ready) {
      var list = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.bundle);
      if (list.count) {
        target = list.objectAtIndex(0); pid = Number(target.processIdentifier); launched = !wasRunning;
        retain();
        if (target.isFinishedLaunching && windows().length) { ready = true; emit({ stage: 'ready', launched: launched, pid: pid }); }
      }
    }
    if (ready) retain();
    if (command === 'finish') {
      cleanup(); return '';
    }
    sample(); wait();
  }
  emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['HOST_TIMEOUT'], windows: [] } });
  return '';
}
