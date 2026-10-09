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

function quitFixtureApplication(pid, bundle, application, clock) {
  var started = clock.now(), accepted = false, finishedLaunching;
  function identity(target) {
    if (Number(target.processIdentifier) !== pid || String(ObjC.unwrap(target.bundleIdentifier)) !== bundle) throw new Error('Launched app identity changed; quit refused');
    finishedLaunching = !!target.isFinishedLaunching;
  }
  function receipt(reason) {
    clock.emit({ stage: 'quit', quitWait: { reason: reason, accepted: accepted,
      elapsedMs: clock.now() - started, finishedLaunching: finishedLaunching } });
  }
  var target = application();
  if (!target) { receipt('already-exited'); return true; }
  identity(target);
  // NSRunningApplication.terminate requests an ordinary quit. Acceptance does
  // not mean the process has exited, especially while Office is still starting.
  accepted = !!target.terminate;
  if (!accepted) { receipt('refused'); throw new Error('Launched app refused quit'); }
  while (true) {
    target = application();
    if (!target) { receipt('exited'); return true; }
    identity(target);
    var remaining = 30000 - (clock.now() - started);
    if (remaining <= 0) break;
    clock.wait(Math.min(100, remaining));
  }
  receipt('deadline');
  throw new Error('Launched app quit unconfirmed after thirty seconds (normal quit accepted; finishedLaunching=' + finishedLaunching + ')');
}

function officeDeadlineError(state) {
  var last = state.officeLastError;
  return Object.assign(new Error('Office fixture readiness timed out after thirty seconds; ' +
    (last ? 'last AX error ' + last.code + ' (' + last.attribute + ')' : 'no AX error; matching window absent')), { officeDeadline: true });
}

function waitForOfficeFixture(probe, state, clock) {
  if (!state.fresh || !state.setup || state.actionTaken) throw new Error('Office startup wait requires an untouched cold launch');
  var started = clock.now(), reason = 'error';
  state.officeWaiting = true;
  state.officeDeadline = started + 30000;
  try {
    while (clock.now() < state.officeDeadline) {
      try {
        var ready = probe();
        if (clock.now() >= state.officeDeadline) break;
        if (ready) { reason = 'ready'; return true; }
      } catch (error) {
        if (error.officeDeadline) break;
        if ([-25204, -25205].indexOf(error.code) === -1) throw error;
        state.officeLastError = { code: error.code, attribute: error.attribute };
      }
      var remaining = state.officeDeadline - clock.now();
      if (remaining > 0) clock.wait(Math.min(100, remaining));
    }
    reason = 'deadline';
    throw officeDeadlineError(state);
  } finally {
    state.officeWaiting = false;
    delete state.officeDeadline;
    var last = state.officeLastError || {};
    state.launchWait = { reason: reason, elapsedMs: clock.now() - started, code: last.code, attribute: last.attribute };
    clock.emit({ stage: 'office-wait', launchWait: state.launchWait });
  }
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
  if (!api.matches(window, request, true)) return 'unconfirmed';
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
    var items = [], allItems = [];
    menus.forEach(function (menu) {
      var children = api.children(menu);
      api.inspect && api.inspect(children);
      allItems = allItems.concat(children);
    });
    for (var index = 0; index < titles.length; index++) {
      items = allItems.filter(function (item) { return api.text(item, 'AXTitle') === titles[index] && (!api.enabled || api.enabled(item)); });
      if (items.length) break;
    }
    if (items.length !== 1) throw new Error('Fixture menu item unavailable or ambiguous');
    if (api.beforePress) api.beforePress();
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
    var validate = function () {
      if (!api.exists(window) || !api.matches(window, request, true)) throw new Error('Owned fixture document identity changed');
      if (!api.equal(api.focused(app), window)) throw new Error('Owned document lost focus; cleanup refused');
    };
    validate();
    api.closeDocument(app, validate, request);
  } else api.closeButton(window);
  for (var attempt = 0; attempt < 30; attempt++) {
    api.wait();
    if (!api.exists(window)) return;
    if (request.mode === 'document' && !api.matches(window, request, true)) return;
    api.discard(window);
  }
  throw new Error('Owned fixture window is still open');
}

function closeDocumentSafely(app, request, validate, api) {
  try { api.menu(app, validate); }
  catch (error) {
    if (request.ownerAway !== true || error.menuCleanupError || error.message !== 'Fixture menu item unavailable or ambiguous') throw error;
    validate();
    api.activate(app);
    validate();
    api.menu(app, validate);
  }
}

function appDialogCategory(info) {
  var modal = ['AXDialog', 'AXSystemDialog'].indexOf(info.subrole) !== -1;
  if (info.document && !modal) return null;
  var startup = /^(?:Microsoft )?(?:Word|Excel|PowerPoint|Mail)$/.test(info.title || '');
  var text = [info.title || ''].concat(modal || startup ? (info.buttons || []).concat(info.text || []) : []).join('\n');
  if (/(?:activate|activation|licen[cs][ei]|subscription|product key)/i.test(text)) return 'activation';
  if (/\b(?:sign[ -]?in|log[ -]?in)\b/i.test(text)) return 'sign-in';
  if (/\b(?:grant access|allow access|needs? access|permission|would like to access|don.t allow)\b/i.test(text)) return 'permission';
  if (/\b(?:welcome|what.s new|getting started|first run|get started)\b/i.test(text)) return 'first-run';
  return modal ? 'application-result' : null;
}

function appDialogInfo(info, app) {
  var category = appDialogCategory(info);
  if (!category) return null;
  return { app: app, category: category, title: info.title || '', buttons: info.buttons || [],
    stop: ['activation', 'sign-in', 'permission'].indexOf(category) !== -1,
    description: category + ' application dialog' };
}

function dialogContents(element, api) {
  var result = { buttons: [], text: [] }, visited = 0;
  function visit(current, depth) {
    if (depth < 0 || ++visited > 512) throw new Error('Application dialog inspection exceeded its bound');
    api.children(current).forEach(function (child) {
      var role = api.text(child, 'AXRole');
      if (role === 'AXButton') result.buttons.push(api.text(child, 'AXTitle'));
      if (role === 'AXStaticText') result.text.push(api.text(child, 'AXValue'), api.text(child, 'AXTitle'));
      visit(child, depth - 1);
    });
  }
  visit(element, 8);
  return result;
}

function nativeAX(state, clock) {
  function read(element, attribute) {
    var operation = function () {
      if (state && state.officeWaiting && clock.now() >= state.officeDeadline) throw officeDeadlineError(state);
      var value = Ref();
      var code = Number($.AXUIElementCopyAttributeValue(element, $(attribute), value));
      // These optional attributes can remain unsupported on a valid Office
      // window. Their absence allows the existing nonce-title identity fallback.
      if (code === -25205 && state && state.office && state.setup &&
          ['AXDocument', 'AXSheets', 'AXSubrole', 'AXMainWindow', 'AXChildren', 'AXValue'].indexOf(attribute) !== -1) {
        state.officeLastError = { code: code, attribute: attribute };
        return null;
      }
      if (code === -25212 || (code === -25205 && !(state && state.fresh && state.setup))) return null;
      if (code !== 0) throw Object.assign(new Error('AX fixture read failed: ' + code + ' (' + attribute + ')'), { code: code, attribute: attribute });
      return ObjC.castRefToObject(value[0]);
    };
    return state && state.office && state.setup ? operation() : setupRead(operation, state, clock);
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
  function dialog(app, owned, request) {
    if (!request.stopOnAppDialog) return [];
    var focused = read(app, 'AXFocusedWindow');
    var candidates = [];
    if (owned) candidates = candidates.concat(children(owned, 'AXSheets'));
    if (focused && (!owned || !$.CFEqual(focused, owned))) {
      if (['AXDialog', 'AXSystemDialog'].indexOf(text(focused, 'AXSubrole')) !== -1 || text(focused, 'AXRole') === 'AXSheet') candidates.push(focused);
      else if (matches(focused, request)) candidates = candidates.concat(children(focused, 'AXSheets'));
      else if (!text(focused, 'AXDocument')) candidates.push(focused);
    }
    var found = [];
    for (var index = 0; index < candidates.length; index++) {
      var candidate = candidates[index];
      var info = { title: text(candidate, 'AXTitle'), subrole: text(candidate, 'AXSubrole'),
        document: text(candidate, 'AXDocument') };
      if (text(candidate, 'AXRole') === 'AXSheet') info.subrole = 'AXDialog';
      if (['AXDialog', 'AXSystemDialog'].indexOf(info.subrole) !== -1 || /^(?:Microsoft )?(?:Word|Excel|PowerPoint|Mail)$/.test(info.title)) {
        var content = dialogContents(candidate, { children: children, text: text });
        info.buttons = content.buttons; info.text = content.text;
      }
      var record = appDialogInfo(info, request.app);
      if (record) found.push(record);
    }
    return found;
  }
  function fileMenu(app, titles, beforePress) {
    var bar = read(app, 'AXMenuBar');
    var files = children(bar).filter(function (item) { return text(item, 'AXTitle') === 'File'; });
    if (files.length !== 1) throw new Error('Fixture needs the File menu');
    chooseFileMenu(files[0], titles, { press: press, children: children, text: text, beforePress: beforePress,
      enabled: function (item) { return Number(ObjC.unwrap(read(item, 'AXEnabled'))) === 1; }, cancel: function (menu) {
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
    }, inspect: function (items) {
      clock.emit({ stage: 'menu-items', menuItems: items.map(function (item) {
        var title = text(item, 'AXTitle');
        return /^New .+ Window$/.test(title) && title !== 'New Private Window' ? 'New <profile> Window' : title;
      }), menuCommands: items.map(function (item) { return { title: text(item, 'AXTitle'), enabled: Number(ObjC.unwrap(read(item, 'AXEnabled'))) === 1 }; }) });
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
      var current = path(document), expected = request.target && request.target[0] === '/' ?
        path(String(ObjC.unwrap($.NSURL.fileURLWithPath(request.target).absoluteString))) : null;
      if (current && expected) return current === expected ||
        (request.mode === 'folder' && current.indexOf(expected + '/') === 0);
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
    matches: matches, dialog: dialog,
    readiness: function (app, request) {
      function describe(window) {
        if (!window) return { present: false };
        var document = text(window, 'AXDocument');
        var current = path(document), normalizedTarget = request.target && request.target[0] === '/' ?
          path(String(ObjC.unwrap($.NSURL.fileURLWithPath(request.target).absoluteString))) : null;
        return { present: true, matches: matches(window, request),
          documentKind: document.indexOf('file://') === 0 ? 'file-url' : document.indexOf('http') === 0 ? 'web-url' : document ? 'other' : 'absent',
          titleMatches: text(window, 'AXTitle').indexOf(request.token) !== -1,
          pathAvailable: !!current, pathMatchesNormalizedTarget: !!current && current === normalizedTarget };
      }
      return { focused: describe(read(app, 'AXFocusedWindow')), main: describe(read(app, 'AXMainWindow')) };
    },
    closeButton: function (window) { var button = read(window, 'AXCloseButton'); if (!button) throw new Error('Owned window has no close button'); press(button); },
    closeDocument: function (app, validate, request) {
      closeDocumentSafely(app, request, validate, {
        menu: function (target, beforePress) { fileMenu(target, ['Close Selected PDF Document', 'Close'], beforePress); },
        activate: function (target) {
          var pidRef = Ref();
          if (Number($.AXUIElementGetPid(target, pidRef)) !== 0) throw new Error('Document activation lost the app identity');
          var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pidRef[0]));
          if (running.isNil() || !running.activateWithOptions(0)) throw new Error('Owned document app activation failed');
          clock.emit({ stage: 'foreground-fallback', foregroundFallback: true });
          waitForLaunch();
        },
      });
    },
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
    }, { now: function () { return 0; }, wait: function () {}, emit: function () {} }), path: request.path ? String(ObjC.unwrap($.NSURL.fileURLWithPath(request.path).URLByResolvingSymlinksInPath.path)) : undefined });
  }
  var allowed = ['com.apple.Safari', 'com.apple.Preview', 'com.apple.finder',
    'com.apple.TextEdit', 'com.apple.calculator', 'com.apple.dt.Devices', 'com.apple.iphonesimulator', 'net.imput.helium',
    'com.microsoft.Word', 'com.microsoft.Excel', 'com.microsoft.Powerpoint', 'com.apple.mail'];
  if (request.mode === 'quit') {
    if (allowed.indexOf(request.bundle) === -1 || request.bundle === 'com.apple.finder' || !(request.pid > 0)) throw new Error('Invalid launched app quit request');
    return quitFixtureApplication(request.pid, request.bundle, function () {
      var value = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
      return value.isNil() || value.isTerminated ? null : value;
    }, { now: function () { return Date.now(); }, wait: function (ms) { waitForLaunch(ms / 1000); }, emit: emit });
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
  var target, running, pid, app, previous, owned, observedDialogs = [];
  function checkAppDialog() {
    var found = app && api.dialog(app, owned, request) || [];
    var blocking;
    found.forEach(function (dialog) {
      var key = JSON.stringify(dialog);
      if (observedDialogs.indexOf(key) === -1) {
        observedDialogs.push(key);
        emit({ stage: 'app-dialog', appDialog: dialog, pid: pid, running: running });
      }
      if (dialog.stop) blocking = dialog;
    });
    if (blocking) throw Object.assign(new Error(blocking.app + ' ' + blocking.category + ' dialog: stopped'), { appDialog: blocking });
  }
  try {
  target = application();
  running = !!target;
  state.fresh = !target || !!(target.launchDate && !target.launchDate.isNil() &&
    Number(target.launchDate.timeIntervalSince1970) * 1000 >= request.startedAtMs);
  state.office = state.fresh && ['com.microsoft.Word', 'com.microsoft.Excel', 'com.microsoft.Powerpoint'].indexOf(request.bundle) !== -1;
  if (request.bundle === 'com.apple.Safari') {
    emit({ stage: 'launch', running: running });
    target = waitForApplication(application, waitForLaunch);
  }
  if (target) {
    pid = Number(target.processIdentifier); app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    if (!state.office) previous = api.focused(app);
  }
  emit({ stage: 'identified', running: running, pid: pid });
  if (!state.office) checkAppDialog();
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
    // A launch can open the app, then fail before its remaining setup finishes.
    // Record that process while launch is pending, before cleanup can interrupt it.
    if (!pid && command() === 'launching') {
      target = application();
      if (target) {
        pid = Number(target.processIdentifier);
        emit({ stage: 'launched', pid: pid });
      }
    }
    waitForLaunch();
  }
  function probeReadiness(attempt) {
    if (command() === 'close') throw new Error('Fixture opening interrupted before identity was recorded');
    target = application();
    if (!target) return false;
    if (pid && Number(target.processIdentifier) !== pid) throw new Error('Fixture process changed');
    pid = Number(target.processIdentifier); app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    checkAppDialog();
    if (inherited) { api.focused(app); return true; }
    if (attempt === 0 || attempt === 199) emit({ stage: 'readiness', readiness: api.readiness(app, request) });
    var current = owned || api.focused(app);
    if (!current) return false;
    if (request.mode === 'folder' && api.equal(current, previous)) {
      return false;
    }
    if (api.matches(current, request)) { owned = current; state.fixtureExists = true; return true; }
    return false;
  }
  var applicationReady = false;
  if (state.office) {
    var officeAttempt = 0;
    applicationReady = waitForOfficeFixture(function () { return probeReadiness(officeAttempt++); }, state, clock);
  } else {
    for (var attempt = 0; attempt < 200; attempt++) {
      if (probeReadiness(attempt)) { applicationReady = true; break; }
      api.wait();
    }
  }
  if (!applicationReady) throw new Error('Fixture application readiness unconfirmed');
  if (!inherited && !owned) throw new Error('Fixture identity could not be established without a window inventory');
  if (!inherited && !api.matches(owned, request)) throw new Error('Fixture document identity unconfirmed');
  emit({ stage: 'ready', pid: pid, fresh: state.fresh, totalWaitMs: state.retryWaitMs });
  state.setup = false;
  while (command() !== 'close') { checkAppDialog(); api.wait(); }
  checkAppDialog();
  target = application();
  if (target && Number(target.processIdentifier) !== pid) throw new Error('Fixture process changed before cleanup');
  if (target && !inherited) closeOwnedWindow(owned, request, app, api);
  emit({ stage: 'closed' });
  } catch (error) {
    if (state.setup) {
      state.setup = false;
      var cleanup, cleanupError = error.menuCleanupError;
      try {
        cleanup = error.appDialog ? 'unconfirmed' : recoverSetup(owned, request, api);
      } catch (failure) { cleanupError = [cleanupError, failure.message].filter(Boolean).join('; '); }
      emit({ stage: 'setup-failure', fresh: state.fresh, actionTaken: state.actionTaken, pid: pid,
        cleanup: cleanup, cleanupError: cleanupError, totalWaitMs: state.retryWaitMs, launchWait: state.launchWait });
    }
    throw error;
  }
}
