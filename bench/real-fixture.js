// JXA uses only native AppKit and AX calls. The window reference stays in this
// process until cleanup. Recovery uses only that retained reference.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

function waitForLaunch(seconds) {
  var deadline = $.NSDate.dateWithTimeIntervalSinceNow(seconds === undefined ? 0.1 : seconds);
  $.NSRunLoop.mainRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, deadline);
  var remaining = Number(deadline.timeIntervalSinceNow);
  if (remaining > 0) $.NSThread.sleepForTimeInterval(remaining);
}

function waitForApplication(application, wait) {
  for (var attempt = 0; attempt < 100; attempt++) {
    var target = application();
    if (target && target.isFinishedLaunching) return target;
    wait();
  }
  return null;
}

function quitFixtureApplication(pid, bundle, application, wait) {
  var target = application();
  if (!target) return true;
  if (Number(target.processIdentifier) !== pid || String(ObjC.unwrap(target.bundleIdentifier)) !== bundle) throw new Error('Launched app identity changed; quit refused');
  if (!target.terminate) throw new Error('Launched app refused quit');
  for (var attempt = 0; attempt < 50; attempt++) {
    wait();
    if (!application()) return true;
  }
  throw new Error('Launched app quit unconfirmed');
}

function setupRead(operation, state, clock) {
  var lastError;
  while (true) {
    if (lastError && clock.now() - state.retryStarted >= 15000) throw lastError;
    try { return operation(); }
    catch (error) {
      if (!state || !state.fresh || !state.setup || (state.fixtureExists && state.actionTaken) ||
          [-25204, -25205].indexOf(error.code) === -1) throw error;
      if (state.retryStarted === undefined) state.retryStarted = clock.now();
      state.retryWaitMs = clock.now() - state.retryStarted;
      var remaining = 15000 - (clock.now() - state.retryStarted);
      if (remaining <= 0) throw error;
      lastError = error;
      var delay = Math.min(100, remaining), before = clock.now();
      clock.wait(delay);
      state.retryWaitMs = clock.now() - state.retryStarted;
      clock.emit({ stage: 'retry', code: error.code, waitMs: clock.now() - before,
        totalWaitMs: state.retryWaitMs });
    }
  }
}

function recoverSetup(window, request, api) {
  if (!window) return 'unconfirmed';
  if (!api.exists(window)) return 'closed retained fixture';
  api.closeButton(window);
  for (var attempt = 0; attempt < 30; attempt++) {
    api.wait();
    if (!api.exists(window)) return 'closed retained fixture';
  }
  throw new Error('Retained fixture window cleanup unconfirmed');
}

function chooseFileMenu(file, titles, api) {
  var menus = [];
  try {
    api.press(file);
    menus = api.children(file).filter(function (child) { return api.text(child, 'AXRole') === 'AXMenu'; });
    var items = [];
    menus.forEach(function (menu) {
      items = items.concat(api.children(menu).filter(function (item) { return titles.indexOf(api.text(item, 'AXTitle')) !== -1; }));
    });
    if (items.length !== 1) throw new Error('Fixture menu item unavailable or ambiguous');
    api.press(items[0]);
  } catch (error) {
    try { api.cancel(menus.length === 1 ? menus[0] : file); }
    catch (failure) { error.menuCleanupError = failure.message; }
    throw error;
  }
}

function closeOwnedWindow(window, request, app, api) {
  if (!window || !api.exists(window)) return;
  if (!api.matches(window, request, true)) throw new Error('Owned fixture document identity changed');
  if (request.mode === 'document') {
    if (!api.equal(api.focused(app), window)) throw new Error('Owned document lost focus; cleanup refused');
    api.closeDocument(app);
  } else api.closeButton(window);
  for (var attempt = 0; attempt < 30; attempt++) {
    api.wait();
    if (!api.exists(window)) return;
    api.discard(window);
    if (request.mode === 'document' && !api.matches(window, request, true)) return;
  }
  throw new Error('Owned fixture window is still open');
}

function nativeAX(state, clock) {
  function read(element, attribute) {
    return setupRead(function () {
      var value = Ref();
      var code = Number($.AXUIElementCopyAttributeValue(element, $(attribute), value));
      if (code === -25212 || (code === -25205 && !(state && state.fresh && state.setup))) return null;
      if (code !== 0) throw Object.assign(new Error('AX fixture read failed: ' + code), { code: code });
      return ObjC.castRefToObject(value[0]);
    }, state, clock);
  }
  function text(element, attribute) { var value = read(element, attribute); return value ? String(ObjC.unwrap(value)) : ''; }
  function children(element, attribute) {
    var values = read(element, attribute || 'AXChildren'), result = [];
    if (values) for (var index = 0; index < Number(values.count); index++) result.push(values.objectAtIndex(index));
    return result;
  }
  function press(element) {
    if (state && state.setup) { state.actionTaken = true; clock.emit({ stage: 'action', actionTaken: true }); }
    var code = Number($.AXUIElementPerformAction(element, $('AXPress')));
    if (code !== 0) throw new Error('AX fixture press failed: ' + code);
  }
  function buttons(element, wanted, depth) {
    if (depth < 0) return [];
    var result = [];
    children(element).forEach(function (child) {
      var role = text(child, 'AXRole');
      if (role === 'AXButton' && wanted.indexOf(text(child, 'AXTitle')) !== -1) result.push(child);
      if (['AXGroup', 'AXSheet'].indexOf(role) !== -1) result = result.concat(buttons(child, wanted, depth - 1));
    });
    return result;
  }
  function fileMenu(app, titles) {
    var bar = read(app, 'AXMenuBar');
    var files = children(bar).filter(function (item) { return text(item, 'AXTitle') === 'File'; });
    if (files.length !== 1) throw new Error('Fixture needs the File menu');
    chooseFileMenu(files[0], titles, { press: press, children: children, text: text, cancel: function (menu) {
      var method = 'AXCancel';
      if (Number($.AXUIElementPerformAction(menu, $('AXCancel'))) !== 0) {
        var pidRef = Ref();
        if (Number($.AXUIElementGetPid(app, pidRef)) !== 0) throw new Error('File-menu cancellation lost the app identity');
        var down = $.CGEventCreateKeyboardEvent(null, 53, true), up = $.CGEventCreateKeyboardEvent(null, 53, false);
        if (!down || down.isNil() || !up || up.isNil()) throw new Error('File-menu Escape could not be created');
        $.CGEventPostToPid(Number(pidRef[0]), down); $.CGEventPostToPid(Number(pidRef[0]), up);
        method = 'Escape';
      }
      clock.emit({ stage: 'menu-cancel', menuCancelled: true, menuCancelMethod: method });
    } });
  }
  function path(value) {
    if (!value || value.indexOf('file://') !== 0) return null;
    var url = $.NSURL.URLWithString(value);
    return url.isNil() || !url.isFileURL ? null : ObjC.unwrap(url.URLByResolvingSymlinksInPath.path);
  }
  function matches(window, request, retained) {
    var document = text(window, 'AXDocument');
    if (document) {
      if (request.target && request.target.indexOf('http://') === 0) return document.indexOf(request.target) === 0;
      var current = path(document);
      if (current && request.target) return current === request.target ||
        (request.mode === 'folder' && current.indexOf(request.target + '/') === 0);
      return false;
    }
    var title = text(window, 'AXTitle');
    return request.mode === 'inherit' || title.indexOf(request.token) !== -1 ||
      (retained === true && request.mode === 'folder' && title === 'Archive');
  }
  return {
    read: read, text: text, press: press, fileMenu: fileMenu,
    wait: function () { $.NSThread.sleepForTimeInterval(0.1); },
    equal: function (a, b) { return !!a && !!b && !!$.CFEqual(a, b); },
    focused: function (app) { return read(app, 'AXFocusedWindow'); },
    exists: function (window) {
      try { return text(window, 'AXRole') === 'AXWindow'; }
      catch (error) { if (error.code === -25202) return false; throw error; }
    },
    matches: matches,
    closeButton: function (window) { var button = read(window, 'AXCloseButton'); if (!button) throw new Error('Owned window has no close button'); press(button); },
    closeDocument: function (app) { fileMenu(app, ['Close Window', 'Close']); },
    discard: function (window) {
      var sheets = children(window, 'AXSheets');
      if (!sheets.length) return;
      if (sheets.length !== 1) throw new Error('Unexpected owned fixture sheets');
      var discardButtons = buttons(sheets[0], ["Don't Save", 'Don’t Save'], 6);
      if (discardButtons.length !== 1) throw new Error('Unexpected owned fixture sheet; cleanup refused');
      press(discardButtons[0]);
    },
  };
}

function run(argv) {
  var request = JSON.parse(argv[0]);
  if (request.mode === 'self-test') {
    var terminated = false;
    var fake = { processIdentifier: 42, bundleIdentifier: $('com.apple.Preview'),
      get terminate() { terminated = true; return true; } };
    return JSON.stringify({ quit: quitFixtureApplication(42, 'com.apple.Preview', function () {
      return terminated ? null : fake;
    }, function () {}) });
  }
  var allowed = ['com.apple.Safari', 'com.apple.Preview', 'com.apple.finder',
    'com.apple.TextEdit', 'com.apple.calculator', 'com.apple.dt.Devices', 'com.apple.iphonesimulator', 'net.imput.helium'];
  if (request.mode === 'quit') {
    if (allowed.indexOf(request.bundle) === -1 || request.bundle === 'com.apple.finder' || !(request.pid > 0)) throw new Error('Invalid launched app quit request');
    return quitFixtureApplication(request.pid, request.bundle, function () {
      var value = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
      return value.isNil() || value.isTerminated ? null : value;
    }, waitForLaunch);
  }
  if (allowed.indexOf(request.bundle) === -1 || !request.control || !request.mode) throw new Error('Invalid fixture request');
  if (!$.AXIsProcessTrusted()) throw new Error('Accessibility is unavailable; fixture not opened');
  function emit(value) {
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  }
  function command() {
    var data = $.NSData.dataWithContentsOfFile(request.control);
    if (data.isNil()) return '';
    var string = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    try { return JSON.parse(ObjC.unwrap(string)).command; } catch (error) { return ''; }
  }
  function application() {
    var matches = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.bundle);
    if (Number(matches.count) > 1) throw new Error('Ambiguous fixture process');
    return Number(matches.count) === 1 ? matches.objectAtIndex(0) : null;
  }
  var state = { setup: true, fresh: false, fixtureExists: false, actionTaken: false, retryWaitMs: 0 };
  var clock = { now: function () { return Date.now(); }, wait: function (ms) { waitForLaunch(ms / 1000); }, emit: emit };
  var api = nativeAX(state, clock);
  var target, running, pid, app, previous, owned;
  try {
  target = application();
  running = !!target;
  state.fresh = !target || !!(target.launchDate && !target.launchDate.isNil() &&
    Number(target.launchDate.timeIntervalSince1970) * 1000 >= request.startedAtMs);
  if (request.bundle === 'com.apple.Safari') {
    emit({ stage: 'launch', running: running });
    target = waitForApplication(application, waitForLaunch);
  }
  if (target) {
    pid = Number(target.processIdentifier); app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    previous = api.focused(app);
  }
  if (request.bundle === 'com.apple.Safari') {
    if (!target) {
      emit({ stage: 'untouched' });
      throw new Error('Safari process did not finish launching within ten seconds');
    }
    api.fileMenu(app, ['New Window']);
    for (var newTry = 0; newTry < 30; newTry++) {
      owned = api.focused(app);
      if (owned && !api.equal(owned, previous)) { state.fixtureExists = true; break; }
      owned = null; api.wait();
    }
    if (!owned) throw new Error('New Safari fixture window unconfirmed');
  }
  emit({ stage: 'armed', running: running, pid: pid });
  var inherited = request.mode === 'inherit';
  while (command() !== 'opened') {
    if (command() === 'close') throw new Error('Fixture opening interrupted before identity was recorded');
    api.wait();
  }
  var applicationReady = false;
  for (var attempt = 0; attempt < 200; attempt++) {
    if (command() === 'close') throw new Error('Fixture opening interrupted before identity was recorded');
    target = application();
    if (!target) { api.wait(); continue; }
    if (pid && Number(target.processIdentifier) !== pid) throw new Error('Fixture process changed');
    pid = Number(target.processIdentifier); app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    if (inherited) { api.focused(app); applicationReady = true; break; }
    var current = owned || api.focused(app);
    if (!current) { api.wait(); continue; }
    if (request.mode === 'folder' && api.equal(current, previous)) {
      api.wait(); continue;
    }
    if (api.matches(current, request)) { owned = current; state.fixtureExists = true; applicationReady = true; break; }
    api.wait();
  }
  if (!applicationReady) throw new Error('Fixture application readiness unconfirmed');
  if (!inherited && !owned) throw new Error('Fixture identity could not be established without a window inventory');
  if (!inherited && !api.matches(owned, request)) throw new Error('Fixture document identity unconfirmed');
  emit({ stage: 'ready', pid: pid, fresh: state.fresh, totalWaitMs: state.retryWaitMs });
  state.setup = false;
  while (command() !== 'close') api.wait();
  target = application();
  if (target && Number(target.processIdentifier) !== pid) throw new Error('Fixture process changed before cleanup');
  if (target && !inherited) closeOwnedWindow(owned, request, app, api);
  emit({ stage: 'closed' });
  } catch (error) {
    if (state.setup) {
      state.setup = false;
      var cleanup, cleanupError = error.menuCleanupError;
      try {
        cleanup = recoverSetup(owned, request, api);
      } catch (failure) { cleanupError = [cleanupError, failure.message].filter(Boolean).join('; '); }
      emit({ stage: 'setup-failure', fresh: state.fresh, actionTaken: state.actionTaken, pid: pid,
        cleanup: cleanup, cleanupError: cleanupError, totalWaitMs: state.retryWaitMs });
    }
    throw error;
  }
}
