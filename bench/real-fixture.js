// JXA uses only native AppKit and AX calls. The window reference stays in this
// process until cleanup; neither setup nor cleanup enumerates app windows.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');

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

function nativeAX() {
  function read(element, attribute) {
    var value = Ref();
    var code = Number($.AXUIElementCopyAttributeValue(element, $(attribute), value));
    if (code === -25205 || code === -25212) return null;
    if (code !== 0) throw Object.assign(new Error('AX fixture read failed: ' + code), { code: code });
    return ObjC.castRefToObject(value[0]);
  }
  function text(element, attribute) { var value = read(element, attribute); return value ? String(ObjC.unwrap(value)) : ''; }
  function children(element, attribute) {
    var values = read(element, attribute || 'AXChildren'), result = [];
    if (values) for (var index = 0; index < Number(values.count); index++) result.push(values.objectAtIndex(index));
    return result;
  }
  function press(element) {
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
    press(files[0]);
    var menus = children(files[0]).filter(function (child) { return text(child, 'AXRole') === 'AXMenu'; });
    var items = [];
    menus.forEach(function (menu) {
      items = items.concat(children(menu).filter(function (item) { return titles.indexOf(text(item, 'AXTitle')) !== -1; }));
    });
    if (items.length !== 1) throw new Error('Fixture menu item unavailable or ambiguous');
    press(items[0]);
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
  var allowed = ['com.apple.Safari', 'com.apple.Preview', 'com.apple.finder',
    'com.apple.TextEdit', 'com.apple.calculator', 'com.apple.dt.Devices', 'com.apple.iphonesimulator'];
  if (allowed.indexOf(request.bundle) === -1 || !request.control || !request.mode) throw new Error('Invalid fixture request');
  if (!$.AXIsProcessTrusted()) throw new Error('Accessibility is unavailable; fixture not opened');
  var api = nativeAX();
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
  var target = application(), running = !!target, pid, app, previous, owned;
  if (target) {
    pid = Number(target.processIdentifier); app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    previous = api.focused(app);
  }
  if (request.bundle === 'com.apple.Safari') {
    if (!target) {
      emit({ stage: 'untouched' });
      throw new Error('Safari must already be running to create an isolated fixture without restoring a session');
    }
    api.fileMenu(app, ['New Window']);
    for (var newTry = 0; newTry < 30; newTry++) {
      owned = api.focused(app);
      if (owned && !api.equal(owned, previous)) break;
      owned = null; api.wait();
    }
    if (!owned) throw new Error('New Safari fixture window unconfirmed');
  }
  emit({ stage: 'armed', running: running });
  var inherited = request.mode === 'inherit' && !!previous;
  while (command() !== 'opened') {
    if (command() === 'close') throw new Error('Fixture opening interrupted before identity was recorded');
    api.wait();
  }
  for (var attempt = 0; attempt < 200; attempt++) {
    if (command() === 'close') throw new Error('Fixture opening interrupted before identity was recorded');
    target = application();
    if (!target) { api.wait(); continue; }
    if (pid && Number(target.processIdentifier) !== pid) throw new Error('Fixture process changed');
    pid = Number(target.processIdentifier); app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    if (inherited) break;
    var current = owned || api.focused(app);
    if (!current) { api.wait(); continue; }
    if (request.mode === 'folder' && api.equal(current, previous)) {
      api.wait(); continue;
    }
    if (api.matches(current, request)) { owned = current; break; }
    api.wait();
  }
  if (!inherited && !owned) throw new Error('Fixture identity could not be established without a window inventory');
  if (!inherited && !api.matches(owned, request)) throw new Error('Fixture document identity unconfirmed');
  emit({ stage: 'ready', pid: pid });
  while (command() !== 'close') api.wait();
  target = application();
  if (target && Number(target.processIdentifier) !== pid) throw new Error('Fixture process changed before cleanup');
  if (target && !inherited) closeOwnedWindow(owned, request, app, api);
  emit({ stage: 'closed' });
}
