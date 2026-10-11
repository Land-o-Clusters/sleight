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
  function attribute(element, name) {
    var value = Ref();
    var code = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
    return code === 0 ? value[0] : null;
  }
  function windows() {
    if (!pid) return [];
    var value = attribute($.AXUIElementCreateApplication(pid), 'AXWindows');
    if (!value) return [];
    var list = ObjC.castRefToObject(value), out = [];
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
  sample(); emit({ stage: 'armed', wasRunning: wasRunning });
  var end = Date.now() + 600000;
  while (Date.now() < end) {
    var raw = $.NSString.stringWithContentsOfFileEncodingError(request.control, $.NSUTF8StringEncoding, null);
    var command = raw ? JSON.parse(ObjC.unwrap(raw)).command : '';
    if (command === 'abort') { emit({ stage: 'cleanup', confirmed: false }); return ''; }
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
      var clean = true, current = windows();
      if (expected && !retained.length) clean = false;
      retained.forEach(function(w) {
        active();
        if (!current.some(function(now) { return same(w, now); })) return;
        var close = attribute(w, 'AXCloseButton');
        if (!close || Number($.AXUIElementPerformAction(close, $('AXPress'))) !== 0) clean = false;
      });
      var closeDeadline = Date.now() + 10000;
      while (retained.some(function(w) { return windows().some(function(now) { return same(w, now); }); }) && Date.now() < closeDeadline) { active(); sample(); wait(); }
      if (retained.some(function(w) { return windows().some(function(now) { return same(w, now); }); })) clean = false;
      if (launched && clean) {
        active();
        var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
        if (!app || ObjC.unwrap(app.bundleIdentifier) !== request.bundle || windows().length) clean = false;
        else {
          app.terminate;
          var deadline = Date.now() + 30000;
          while (!app.terminated && Date.now() < deadline) wait();
          if (!app.terminated) clean = false;
        }
      }
      emit({ stage: 'cleanup', confirmed: clean }); return '';
    }
    sample(); wait();
  }
  emit({ stage: 'cleanup', confirmed: false });
  return '';
}
