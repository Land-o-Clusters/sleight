// JXA uses only native AppKit and AX calls. The window reference stays in this
// process until cleanup. Recovery uses only that retained reference.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.import('CoreFoundation');

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

function runningBundle(target) {
  var raw = target && target.bundleIdentifier;
  if (raw == null) return '';
  if (raw.isNil && raw.isNil()) return '';
  var value = typeof raw === 'string' ? raw : ObjC.unwrap(raw);
  return value == null ? '' : String(value);
}

function runningPid(target) {
  var raw = target && target.processIdentifier;
  if (raw == null) return -1;
  if (raw.isNil && raw.isNil()) return -1;
  var value = typeof raw === 'number' ? raw : Number(ObjC.unwrap(raw));
  if (typeof value !== 'number' || value !== value) return -1;
  return value;
}

function finderBirthParts(value) {
  if (typeof value !== 'string') return null;
  var match = /^([1-9][0-9]{0,15})\.([0-9]{6})$/.exec(value);
  if (!match || match[0] !== value || Number(match[1]) > 9007199254740991) return null;
  return [Number(match[1]), Number(match[2])];
}

var finderBirthBound = false;
// Same PROC_PIDTBSDINFO layout as real-electron.js. Keep microseconds exact:
// AppKit launchDate can be absent and rounded milliseconds cannot bind a PID.
function finderProcessBirth(pid) {
  if (typeof pid !== 'number' || !(pid > 0) || pid > 2147483647 || Math.floor(pid) !== pid) return null;
  try {
    if (!finderBirthBound) {
      ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);
      finderBirthBound = true;
    }
    var data = $.NSMutableData.dataWithLength(136);
    if (Number($.proc_pidinfo(pid, 3, 0, data.mutableBytes, 136)) !== 136) return null;
    var encoded = String(ObjC.unwrap(data.base64EncodedStringWithOptions(0)));
    if (!/^[A-Za-z0-9+/]{182}==$/.test(encoded) || encoded.length !== 184) return null;
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes = [], bits = 0, value = 0;
    for (var i = 0; i < encoded.length - 2; i++) {
      value = value << 6 | alphabet.indexOf(encoded[i]); bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push(value >> bits & 255); }
    }
    if (bytes.length !== 136) return null;
    function u32(at) { return bytes[at] + bytes[at + 1] * Math.pow(2, 8) + bytes[at + 2] * Math.pow(2, 16) + bytes[at + 3] * Math.pow(2, 24); }
    function u64(at) { return u32(at) + u32(at + 4) * Math.pow(2, 32); }
    if (u32(12) !== pid || u32(4) === 5) return null;
    var seconds = u64(120), micros = u64(128);
    if (!(seconds > 0) || seconds > 9007199254740991 || Math.floor(seconds) !== seconds ||
        micros < 0 || micros > 999999 || Math.floor(micros) !== micros) return null;
    return seconds + '.' + ('000000' + micros).slice(-6);
  } catch (error) { return null; }
}

function finderOriginalExited(original, receipt, birth) {
  if (!original || !original.isTerminated || !finderBirthParts(receipt.pidBirth)) return false;
  var current = $.NSRunningApplication.runningApplicationWithProcessIdentifier(receipt.pid);
  if (!current || (current.isNil && current.isNil()) || current.isTerminated) return true;
  var started = (birth || finderProcessBirth)(receipt.pid);
  return finderBirthParts(started) !== null && started !== receipt.pidBirth;
}

// Three slow AXCannotComplete responses authorize one recovery of this exact
// Finder incarnation. A PID alone cannot carry timeout evidence across launches.
function ensureFinderAX(api, clock) {
  var target, original, receipt, code, timeouts = 0, birth = api.birth || finderProcessBirth;
  function failure(message, identityReason) {
    return Object.assign(new Error('Finder AX ' + message), { code: code, attribute: 'AXWindows', finderAX: true, identityReason: identityReason });
  }
  function identity(value) {
    var pid = runningPid(value);
    if (!value) throw failure('process identity unavailable', 'target-unavailable');
    if (runningBundle(value) !== 'com.apple.finder') throw failure('process identity unavailable', 'bundle-mismatch');
    if (!(pid > 0) || !isFinite(pid) || Math.floor(pid) !== pid) throw failure('process identity unavailable', 'pid-invalid');
    var pidBirth = birth(pid);
    if (!finderBirthParts(pidBirth)) throw failure('process identity unavailable', 'start-unavailable');
    return { pid: pid, pidBirth: pidBirth };
  }
  function same(value, expected) {
    var actual = identity(value);
    if (actual.pid !== expected.pid) throw failure('process changed during probes or before relaunch', 'pid-changed');
    if (actual.pidBirth !== expected.pidBirth) throw failure('process changed during probes or before relaunch', 'start-changed');
    if (value.isTerminated) throw failure('process changed during probes or before relaunch', 'terminated');
    return value;
  }
  for (var attempt = 0; attempt < 3; attempt++) {
    clock.check();
    target = api.application();
    if (!receipt) { receipt = identity(target); original = target; }
    same(target, receipt);
    var started = clock.now();
    code = api.probe(target, 0.5);
    var probeMs = clock.now() - started;
    clock.check();
    same(api.application(), receipt);
    if (code === 0) return target;
    if (code === -25204 && probeMs >= 400) timeouts++;
    if (attempt < 2) clock.wait(100);
  }
  if (timeouts !== 3) throw failure('probe failed: ' + code);
  clock.check();
  var current = same(api.application(), receipt);
  var deadline = clock.now() + 30000;
  clock.emit({ stage: 'finder-relaunch', finderRelaunch: { reason: 'three AXWindows timeouts', pid: receipt.pid, pidBirth: receipt.pidBirth } });
  current = same(api.application(), receipt);
  clock.check();
  current = same(api.application(), receipt);
  if (!current.forceTerminate) throw failure('force termination refused');
  while (clock.now() < deadline) {
    clock.check();
    var exited = (api.exited || finderOriginalExited)(original, receipt, birth) === true;
    target = api.application();
    if (exited && target && runningPid(target) !== receipt.pid) {
      var successor = identity(target);
      if (target.isTerminated) throw failure('process changed during probes or before relaunch', 'terminated');
      var nextBirth = finderBirthParts(successor.pidBirth), previousBirth = finderBirthParts(receipt.pidBirth);
      if (nextBirth[0] < previousBirth[0] || nextBirth[0] === previousBirth[0] && nextBirth[1] <= previousBirth[1])
        throw failure('successor start time unconfirmed');
      if (clock.now() >= deadline) break;
      code = api.probe(target, Math.min(0.5, (deadline - clock.now()) / 1000));
      clock.check();
      same(api.application(), successor);
      if (!(api.exited || finderOriginalExited)(original, receipt, birth)) throw failure('original exit unconfirmed');
      if (code === 0 && clock.now() <= deadline) {
        clock.emit({ stage: 'finder-recovered', finderRecovery: { originalExitConfirmed: true,
          fromPid: receipt.pid, fromPidBirth: receipt.pidBirth, toPid: successor.pid, toPidBirth: successor.pidBirth } });
        return target;
      }
    }
    var remaining = deadline - clock.now();
    if (remaining > 0) clock.wait(Math.min(100, remaining));
  }
  throw failure('did not answer within thirty seconds after relaunch; original exit or successor unconfirmed');
}

function probeFinderAX(target, seconds) {
  var app = $.AXUIElementCreateApplication(runningPid(target)), value = Ref();
  $.AXUIElementSetMessagingTimeout(app, seconds);
  var code = Number($.AXUIElementCopyAttributeValue(app, $('AXWindows'), value));
  if (code !== 0) return code;
  var windows = ObjC.castRefToObject(value[0]);
  return windows && !(windows.isNil && windows.isNil()) ? 0 : -25205;
}

function finderMenuDiagnostics(items, api) {
  var commands = { 'New Finder Window': 'new-window', 'Go to Folder…': 'go-to-folder', 'Go to Folder...': 'go-to-folder' };
  return items.reduce(function (result, item) {
    var title = api.text(item, 'AXTitle');
    if (Object.prototype.hasOwnProperty.call(commands, title))
      result.push({ command: commands[title], enabled: api.enabled(item) ? 1 : 0 });
    return result;
  }, []);
}

function roleReadFields(detail) {
  var fields = [];
  if (!detail) return fields;
  if (typeof detail.axCode === 'number' && isFinite(detail.axCode) && Math.floor(detail.axCode) === detail.axCode)
    fields.push('axCode=' + detail.axCode);
  if ([0, -25212, -25202, 'other'].indexOf(detail.roleReadCode) !== -1) fields.push('roleReadCode=' + detail.roleReadCode);
  if (['nil', 'empty', 'known-nonwindow', 'other-string', 'nonstring'].indexOf(detail.roleState) !== -1)
    fields.push('roleState=' + detail.roleState);
  if (['AXApplication', 'AXSystemWide', 'AXWindow', 'AXSheet', 'AXDrawer', 'AXDialog', 'AXGroup', 'AXButton', 'AXScrollArea', 'AXUnknown'].indexOf(detail.roleKnown) !== -1)
    fields.push('roleKnown=' + detail.roleKnown);
  if (['cf-string', 'other', 'unavailable'].indexOf(detail.roleNativeType) !== -1) fields.push('roleNativeType=' + detail.roleNativeType);
  ['roleNativeWindowEqual', 'roleDeepWindowEqual'].forEach(function (key) {
    if (['yes', 'no', 'unavailable'].indexOf(detail[key]) !== -1) fields.push(key + '=' + detail[key]);
  });
  return fields;
}

function windowInventoryError(message, reason, count, index, detail) {
  var fields = ['reason=' + reason];
  if (typeof count === 'number' && isFinite(count)) fields.push('count=' + count);
  if (index !== undefined) fields.push('index=' + index);
  if (detail) {
    if (detail.duplicateIndex !== undefined) fields.push('duplicateIndex=' + detail.duplicateIndex);
    if (['AXWindow', 'AXSheet', 'AXDialog', 'AXGroup', 'AXButton'].indexOf(detail.role) !== -1) fields.push('role=' + detail.role);
    fields = fields.concat(roleReadFields(detail));
  }
  return Object.assign(new Error(message + ' [' + fields.join(' ') + ']'), { finderFailureReason: 'inventory-unconfirmed' });
}

function finderStaticFailure(error) {
  function field(key) { try { return error == null ? undefined : error[key]; } catch (ignored) { return undefined; } }
  var messages = {
    'Finder baseline role ledger ownership unconfirmed': 'ledger-unconfirmed',
    'Finder pre-action baseline role inventory changed': 'baseline-changed',
    'Finder previous window absent from inventory': 'previous-absent',
    'Finder window appeared before New Finder Window': 'window-before-new-command',
    'New Finder fixture window ambiguous': 'new-window-ambiguous',
    'New Finder fixture window unconfirmed': 'new-window-unconfirmed',
    'New Finder fixture window identity changed': 'new-window-identity-changed',
    'Foreign Finder dialog; folder setup refused': 'foreign-dialog',
    'Finder folder window vanished': 'window-vanished',
    'Finder folder window lost focus': 'window-focus-lost',
    'Finder folder focus changed during validation': 'window-focus-changed',
    'Finder focused element ancestry unconfirmed': 'focused-ancestry-unconfirmed',
    'Fixture needs the File menu': 'menu-unavailable', 'Fixture needs the Go menu': 'menu-unavailable',
    'Fixture menu item unavailable or ambiguous': 'menu-item-unavailable',
    'Fixture opening interrupted before identity was recorded': 'opening-interrupted',
    'Finder fixture window ownership unconfirmed': 'fixture-ownership-unconfirmed',
    'Finder extra window ownership unconfirmed': 'extra-window-unconfirmed',
    'Finder fixture identity changed': 'fixture-identity-changed',
    'Finder fixture window is still open': 'fixture-still-open',
    'Finder dialog present; fixture cleanup refused': 'dialog-present',
    'Fixture cancellation target is not an observed menu': 'menu-cancel-target-unconfirmed',
    'Fixture menu cancellation failed; Escape refused': 'menu-cancel-failed',
    'File-menu cancellation lost the app identity': 'cancellation-app-identity-lost'
  };
  var message = field('message'), name = field('name'), code = field('code'), attribute = field('attribute');
  var reason = typeof message === 'string' && Object.prototype.hasOwnProperty.call(messages, message) ? messages[message] : 'unclassified';
  if (field('finderFailureReason') === 'inventory-unconfirmed') reason = 'inventory-unconfirmed';
  else if (typeof code === 'number' && (code === 0 || code >= -25214 && code <= -25200 && code === Math.floor(code)) &&
      ['AXWindows', 'AXFocusedWindow', 'AXRole', 'AXValue', 'AXMenuBar', 'AXChildren', 'AXTitle', 'AXSubrole', 'AXParent', 'AXSheets', 'AXFocusedUIElement', 'AXEnabled', 'AXCloseButton'].indexOf(attribute) !== -1)
    reason = 'ax-read-failed';
  var pressCode = typeof message === 'string' && /^AX fixture press failed: (-?\d{1,8})$/.exec(message);
  if (pressCode) { reason = 'ax-press-failed'; if (code === undefined) code = Number(pressCode[1]); }
  var writeCode = typeof message === 'string' && /^Finder folder AXValue failed: (-?\d{1,8})$/.exec(message);
  if (writeCode) { reason = 'ax-write-failed'; if (code === undefined) code = Number(writeCode[1]); }
  var names = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
    'NSInvalidArgumentException', 'NSRangeException', 'NSInternalInconsistencyException', 'NSUnknownKeyException', 'NSGenericException'];
  return { failureReason: reason,
    errorName: name === undefined ? 'unavailable' : names.indexOf(name) !== -1 ? name : 'other',
    errorCode: code === undefined ? 'unavailable' : typeof code === 'number' &&
      (code === 0 || code >= -25214 && code <= -25200 && code === Math.floor(code)) ? code : 'other' };
}

function finderMissingFailure(reason) {
  return { failureReason: reason, errorName: 'unavailable', errorCode: 'unavailable' };
}

function finderRoleLedger(receipt, api) {
  if (!receipt || receipt.schema !== 'finder-role-baseline-v1' || !Array.isArray(receipt.baseline) || !Array.isArray(receipt.created) ||
      receipt.baseline.some(function (entry, index) {
        return !entry || !entry.reference || ['AXWindow', 'AXScrollArea'].indexOf(entry.role) === -1 ||
          receipt.baseline.slice(0, index).some(function (other) { return api.equal(entry.reference, other.reference); });
      }) || receipt.created.some(function (item, index) {
        return !item || receipt.baseline.some(function (entry) { return api.equal(entry.reference, item); }) ||
          receipt.created.slice(0, index).some(function (other) { return api.equal(item, other); });
      })) throw new Error('Finder baseline role ledger ownership unconfirmed');
  return receipt;
}

// Keep every reference in the inventory, including inert baseline scroll areas.
// Only new AXWindow references can become fixture candidates.
function finderRoleInventory(app, api, receipt) {
  if (receipt) finderRoleLedger(receipt, api);
  var windows = api.windows(app), message = 'Finder fixture window inventory unconfirmed', result = [];
  if (!Array.isArray(windows)) throw windowInventoryError(message, 'malformed-list');
  windows.forEach(function (item, index) {
    if (!item) throw windowInventoryError(message, 'missing-element', windows.length, index);
    if (!api.equal(item, item)) throw windowInventoryError(message, 'failed-self-identity', windows.length, index);
    var detail = {}, role = api.finderRole ? api.finderRole(item, detail) : null;
    if (['AXWindow', 'AXScrollArea'].indexOf(role) === -1)
      throw windowInventoryError(message, 'non-window-or-stale', windows.length, index, detail);
    windows.slice(0, index).forEach(function (other, otherIndex) {
      if (api.equal(item, other)) throw windowInventoryError(message, 'duplicate-identity', windows.length, index, { duplicateIndex: otherIndex });
    });
    result.push({ reference: item, role: role });
  });
  if (receipt) {
    receipt.baseline.forEach(function (entry) {
      var matches = result.filter(function (current) { return api.equal(current.reference, entry.reference); });
      if (matches.length !== 1 || matches[0].role !== entry.role)
        throw new Error('Finder pre-action baseline role inventory changed');
    });
    result.forEach(function (entry, index) {
      if (entry.role !== 'AXWindow' && !receipt.baseline.some(function (before) { return api.equal(entry.reference, before.reference); }))
        throw windowInventoryError(message, 'non-window-or-stale', windows.length, index);
    });
  }
  return result;
}

// open -a Finder <folder> sends an open-document Apple Event. Finder deadlocked
// in NodeCopyFromURL after the 640-file trial (2026-10-20). Keep folder navigation
// on AX, in a new window, without asking Finder to resolve an Apple Event URL.
function openFinderFolder(request, app, previous, api, clock, retain) {
  var before = finderRoleInventory(app, api), window, sheet, requested = false;
  // These references stay inside this helper. The temporal addition requires
  // exclusive Finder setup; inventory and the menu action are separate calls.
  request.finderOwnership = { schema: 'finder-role-baseline-v1', baseline: before, created: [] };
  if (previous && !before.some(function (item) { return api.equal(item.reference, previous); })) throw new Error('Finder previous window absent from inventory');
  function candidates() {
    return finderRoleInventory(app, api, request.finderOwnership).filter(function (item) {
      return !before.some(function (other) { return api.equal(item.reference, other.reference); });
    }).map(function (item) { return item.reference; });
  }
  function unopened() {
    clock.check();
    if (candidates().length) throw new Error('Finder window appeared before New Finder Window');
    api.finderFolderGuard(app, null, null);
    if (candidates().length) throw new Error('Finder window appeared before New Finder Window');
  }
  function validate() {
    clock.check();
    var fresh = candidates();
    if (fresh.length !== 1 || !api.equal(fresh[0], window)) throw new Error('New Finder fixture window identity changed');
    api.finderFolderGuard(app, window, sheet);
    fresh = candidates();
    if (fresh.length !== 1 || !api.equal(fresh[0], window)) throw new Error('New Finder fixture window identity changed');
  }
  try {
  unopened();
  // The menu can wait while it opens. Check again at the command's AXPress.
  requested = true;
  api.fileMenu(app, ['New Finder Window'], unopened, true, true);
  var deadline = clock.now() + 5000;
  while (clock.now() < deadline) {
    clock.check();
    var fresh = candidates();
    if (fresh.length > 1) throw new Error('New Finder fixture window ambiguous');
    if (fresh.length === 1) { window = fresh[0]; break; }
    api.finderFolderGuard(app, null, null);
    clock.wait(100);
  }
  if (!window) throw new Error('New Finder fixture window unconfirmed');
  validate();
  request.finderOwnership.created.push(window);
  retain(window);
  if (clock.emit) clock.emit({ stage: 'finder-window-retained', referenceExported: false });
  validate();
  api.menu(app, 'Go', ['Go to Folder…', 'Go to Folder...'], validate, true, true);
  deadline = clock.now() + 5000;
  while (clock.now() < deadline) {
    sheet = api.folderSheet(window, app);
    validate();
    if (sheet) break;
    clock.wait(100);
  }
  if (!sheet) throw new Error('Finder Go to Folder sheet unconfirmed');
  validate();
  api.submitFolder(window, sheet, request.target, validate);
  if (clock.emit) clock.emit({ stage: 'finder-folder-submitted', target: request.target });
  return window;
  } catch (error) {
    if (requested) error.finderWindowRequested = true;
    throw error;
  }
}

function inheritReadyCondition(target, app, api, control) {
  if (!target) return null;
  // DeviceHub after open -g can run for tens of seconds with isFinishedLaunching
  // still false (2026-10-11: 34 s, one unchanged pid). A booted simulator plus
  // this live viewer process is the readiness the task can actually observe.
  if (control && control.simulatorBooted === true) return 'simulator-booted';
  var finished = !!target.isFinishedLaunching;
  var focused = !!(api.focused && api.focused(app));
  var hasWindow = !!(api.mainWindow && api.mainWindow(app));
  if (!hasWindow && api.windowCount) hasWindow = api.windowCount(app) > 0;
  if (finished && focused) return 'focused-window';
  if (finished && hasWindow) return 'window';
  return null;
}

function quitFixtureApplication(pid, bundle, application, clock) {
  var started = clock.now(), accepted = false, finishedLaunching;
  pid = Number(pid);
  function identity(target) {
    var actualPid = runningPid(target), actualBundle = runningBundle(target);
    // AppKit reports -1 once a looked-up process is exiting or the property is
    // stale. The lookup was by the launched pid, so keep that identity when the
    // bundle still matches (2026-10-11: pid -1 vs 89311, DeviceHub still up).
    if (actualPid === -1) actualPid = pid;
    finishedLaunching = !!target.isFinishedLaunching;
    // An empty identifier counts only when the process runs from the expected app's own bundle:
    // a reused PID belongs to some other program, which cleanup must never quit.
    var sameBundle = actualBundle ? actualBundle === bundle : !!(clock.sameApp && clock.sameApp(target, bundle));
    if (actualPid !== pid || !sameBundle) {
      throw new Error('Launched app identity changed; quit refused (pid ' + actualPid + ' vs ' + pid +
        ', bundle ' + actualBundle + ' vs ' + bundle + ')');
    }
    if (clock.startedAtMs > 0 && !launchedByThisRun(target)) throw new Error('Launched app start time changed; quit refused');
  }
  var windowless;
  function receipt(reason) {
    var wait = { reason: reason, accepted: accepted, elapsedMs: clock.now() - started, finishedLaunching: finishedLaunching };
    if (windowless) wait.windowless = windowless;
    clock.emit({ stage: 'quit', quitWait: wait });
  }
  // The exact process this run launched: its pid and bundle, and the launch time the setup recorded.
  function launchedByThisRun(target) {
    var date = target.launchDate;
    return clock.startedAtMs > 0 && !!date && !(date.isNil && date.isNil()) &&
      Math.abs(Number(date.timeIntervalSince1970) * 1000 - clock.startedAtMs) < 1;
  }
  function force(reason) {
    if (clock.check) clock.check();
    if (!target.forceTerminate) { receipt('deadline'); throw new Error('Launched app refused force termination after thirty seconds'); }
    var forcedAt = clock.now();
    while (clock.now() - forcedAt < 5000) {
      target = application();
      if (!target) { receipt(reason); return true; }
      identity(target);
      clock.wait(100);
    }
    receipt('deadline');
    throw new Error('Launched app still running five seconds after force termination');
  }
  var office = /^com\.microsoft\.(Word|Excel|Powerpoint)$/.test(bundle);
  if (clock.check) clock.check();
  var target = application();
  if (!target) { receipt('already-exited'); return true; }
  identity(target);
  var discard = clock.prepareDiscard ? clock.prepareDiscard(validateProcess) : null;
  function validateProcess() {
    if (clock.check) clock.check();
    var current = application();
    if (!current) throw new Error('Launched app exited during sheet validation');
    identity(current);
  }
  // NSRunningApplication.terminate requests an ordinary quit. Acceptance does
  // not mean the process has exited, especially while Office is still starting.
  if (clock.check) clock.check();
  validateProcess();
  accepted = !!target.terminate;
  if (!accepted) { receipt('refused'); throw new Error('Launched app refused quit'); }
  while (true) {
    if (clock.check) clock.check();
    target = application();
    if (!target) { receipt('exited'); return true; }
    identity(target);
    if (discard) discard(validateProcess);
    // Word ignored a quit with no windows left after its fixture's Don't Save sheet was answered (2026-10-18, by hand: AX
    // press, terminate, then forceTerminate). With no window there is no document to recover, so after ten seconds the exact
    // launched process is force-terminated. With any window, or an unproven launch time, Office keeps the stop below.
    if (office && clock.windowless && clock.now() - started >= 10000 && launchedByThisRun(target)) {
      windowless = clock.windowless(target);
      if (windowless && windowless.none === true) return force('force-terminated-windowless');
    }
    var remaining = 30000 - (clock.now() - started);
    if (remaining <= 0) break;
    clock.wait(Math.min(100, remaining));
  }
  // A launched app that accepted the quit and is still up after 30 s is stuck: TextEdit deadlocked in a save, and TextEdit and
  // Preview sat in a background menu (2026-10-16). This run launched it with only its fixtures, so it is force-terminated by
  // the same pid and bundle. Word and Excel with a window keep the stop, because a forced end leaves recovery files that
  // broke later runs.
  if (office) {
    receipt('deadline');
    throw new Error('Launched app quit unconfirmed after thirty seconds (normal quit accepted; finishedLaunching=' + finishedLaunching + ')');
  }
  return force('force-terminated');
}

// No window by both counts: the app's AX window list reads as empty, and the window server shows no on-screen layer-0
// window for the pid (a sheet or alert is one). An unreadable list counts as windows present.
function windowlessProcess(pid) {
  var app = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetMessagingTimeout(app, 0.5);
  var value = Ref(), code = Number($.AXUIElementCopyAttributeValue(app, $('AXWindows'), value));
  var list = code === 0 ? ObjC.castRefToObject(value[0]) : null;
  var axWindows = list ? Number(list.count) : -1;
  var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
  var onScreen = raw && !(raw.isNil && raw.isNil()) ? ObjC.deepUnwrap(ObjC.castRefToObject(raw)).filter(function (window) {
    return Number(window.kCGWindowOwnerPID) === pid && Number(window.kCGWindowLayer) === 0;
  }).length : -1;
  return { none: axWindows === 0 && onScreen === 0, axWindows: axWindows, onScreen: onScreen, axCode: code };
}

function officeDeadlineError(state) {
  var last = state.officeLastError;
  return Object.assign(new Error('Office fixture readiness timed out after thirty seconds; ' +
    (last ? 'last AX error ' + last.code + ' (' + last.attribute + ')' : 'no AX error; matching window absent')), { officeDeadline: true });
}

function waitForOfficeFixture(probe, state, clock) {
  if (!state.setup || state.actionTaken) throw new Error('Office startup wait requires untouched setup');
  var started = state.retryStarted === undefined ? clock.now() : state.retryStarted, reason = 'error';
  // Final identity validation uses setupRead after this waiter returns. Keep
  // the same deadline even when only the Office window poll needed retries.
  state.retryStarted = started;
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
    state.launchWait = { reason: reason, setupCase: state.setupCase, elapsedMs: clock.now() - started, code: last.code, attribute: last.attribute };
    clock.emit({ stage: 'office-wait', launchWait: state.launchWait });
  }
}

function setupRead(operation, state, clock) {
  var lastError;
  function receipt(reason) {
    if (!lastError) return;
    state.readWait = { reason: reason, setupCase: state.setupCase, elapsedMs: clock.now() - state.retryStarted,
      code: lastError.code, attribute: lastError.attribute };
    clock.emit({ stage: 'read-wait', readWait: state.readWait });
  }
  while (true) {
    if (state && state.setup && !state.actionTaken && state.retryStarted !== undefined && clock.now() - state.retryStarted >= 30000) {
      lastError = state.retryError || officeDeadlineError(state); receipt('deadline'); throw lastError;
    }
    try { var value = operation(); receipt('ready'); return value; }
    catch (error) {
      if (!state || !state.setup || state.actionTaken || [-25204, -25205].indexOf(error.code) === -1) {
        if (lastError) lastError = error;
        receipt('error'); throw error;
      }
      if (state.retryStarted === undefined) state.retryStarted = clock.now();
      lastError = state.retryError = error;
      if (state.office) state.officeLastError = { code: error.code, attribute: error.attribute };
      state.retryWaitMs = clock.now() - state.retryStarted;
      var remaining = 30000 - (clock.now() - state.retryStarted);
      if (remaining <= 0) { receipt('deadline'); throw error; }
      var delay = Math.min(100, remaining), before = clock.now();
      clock.wait(delay);
      state.retryWaitMs = clock.now() - state.retryStarted;
      clock.emit({ stage: 'retry', code: error.code, waitMs: clock.now() - before,
        totalWaitMs: state.retryWaitMs, setupCase: state.setupCase });
    }
  }
}

function beginCleanup(state) {
  if (state.cleanup) return;
  state.cleanup = true;
  if (state.observation) {
    state.cleanupRetryStarted = state.observation.cleanupRetryStarted;
    state.cleanupRetryError = state.observation.cleanupRetryError;
  }
}

function cleanupRead(operation, state, clock) {
  var lastError, episode, transientStarted, receiptStarted;
  function currentEpisode() {
    // A close request may arrive during a ready-state observation or its wait.
    // Carry that episode's spent budget into cleanup instead of starting over.
    if (state.observation && !state.cleanup && clock.cleanupRequested()) {
      beginCleanup(state);
    }
    return state.cleanup ? state : state.observation;
  }
  function receipt(reason) {
    if (!lastError) return;
    var phase = state.cleanup ? 'cleanup' : 'observation', key = phase + 'ReadWait';
    state[key] = { reason: reason, setupCase: state.setupCase, elapsedMs: clock.now() -
      (receiptStarted === undefined ? episode.cleanupRetryStarted : receiptStarted),
      code: lastError.code, attribute: lastError.attribute };
    var event = { stage: phase + '-read-wait' }; event[key] = state[key]; clock.emit(event);
  }
  while (true) {
    episode = currentEpisode();
    if (episode.cleanupRetryStarted !== undefined && clock.now() - episode.cleanupRetryStarted >= 15000) {
      lastError = episode.cleanupRetryError; receipt('deadline'); throw lastError;
    }
    try { var value = operation(); episode = currentEpisode(); receipt('ready'); return value; }
    catch (error) {
      episode = currentEpisode();
      if (error.code !== -25204 && error.code !== -25205) {
        if (lastError || episode.cleanupRetryError) lastError = error;
        receipt('error'); throw error;
      }
      lastError = error;
      // Required window attributes can fail briefly while Office closes a document.
      // Keep this read's short budget separate from the existing busy-app episode.
      if (error.code === -25205) {
        if (transientStarted === undefined) transientStarted = clock.now();
      } else {
        if (episode.cleanupRetryStarted === undefined) episode.cleanupRetryStarted = clock.now();
        episode.cleanupRetryError = error;
      }
      var remaining = error.code === -25205 ? 3000 - (clock.now() - transientStarted) : 15000 - (clock.now() - episode.cleanupRetryStarted);
      receiptStarted = error.code === -25205 ? transientStarted : episode.cleanupRetryStarted;
      if (episode.cleanupRetryStarted !== undefined) remaining = Math.min(remaining, 15000 - (clock.now() - episode.cleanupRetryStarted));
      if (remaining <= 0) { receipt('deadline'); throw error; }
      var before = clock.now();
      state.readEpoch = (state.readEpoch || 0) + 1;
      clock.wait(Math.min(100, remaining));
      episode = currentEpisode();
      clock.emit({ stage: 'retry', phase: state.cleanup ? 'cleanup' : 'observation', code: error.code, waitMs: clock.now() - before,
        totalWaitMs: clock.now() - (error.code === -25205 ? transientStarted : episode.cleanupRetryStarted), setupCase: state.setupCase });
    }
  }
}

// This helper lives through the whole task, and a long-lived JXA host read an owned Excel process as gone while the same
// pid was alive (Office investigation, 2026-10-17). An empty bundle listing is looked up again by pid before the close is
// skipped, and a skipped close says so, so the parent confirms the exit with the kernel before counting it clean.
function cleanupTarget(listed, pid, bundle, byPid) {
  if (listed) return listed;
  var again = pid > 0 ? byPid(pid) : null;
  return again && runningBundle(again) === bundle ? again : null;
}

function validateOwnedFixture(window, request, app, api, focus, sibling) {
  var epoch;
  do {
    epoch = api.readEpoch ? api.readEpoch() : 0;
    if (!api.exists(window) || !api.matches(window, request, true)) throw new Error('Owned fixture document identity changed');
    if (focus) {
      var focused = api.focused(app);
      if (!api.equal(focused, window) && !(sibling && api.equal(focused, sibling) &&
          api.text(sibling, 'AXTitle').indexOf(siblingToken(request)) !== -1)) throw new Error('Owned document lost focus; cleanup refused');
    }
    // Any waited read may have made an earlier check stale. Repeat all checks
    // before allowing the existing action to use the retained reference.
  } while (api.readEpoch && api.readEpoch() !== epoch);
}

function recoverSetup(window, request, api, app, failure) {
  if (!window) {
    if (failure) Object.assign(failure, finderMissingFailure('retained-reference-unavailable'));
    return 'unconfirmed';
  }
  if (request.bundle === 'com.apple.finder' && request.mode === 'folder') {
    if (api.exists(window) && !api.matches(window, request, true)) {
      if (failure) Object.assign(failure, finderMissingFailure('fixture-location-mismatch'));
      return 'unconfirmed';
    }
    closeFinderFixtureWindows(window, request, app, api);
    return 'closed retained fixture';
  }
  if (!api.exists(window)) return 'closed retained fixture';
  if (!api.matches(window, request, true)) return 'unconfirmed';
  api.closeButton(window, function () { validateOwnedFixture(window, request, null, api, false); });
  for (var attempt = 0; attempt < 30; attempt++) {
    api.wait();
    if (!api.exists(window)) return 'closed retained fixture';
  }
  throw new Error('Retained fixture window cleanup unconfirmed');
}

function chooseFileMenu(file, titles, api) {
  var menus = [], openingAttempted = api.tracksOpeningAttempt !== true;
  try {
    api.press(file, function () { openingAttempted = true; });
    openingAttempted = true;
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
    try { if (openingAttempted) api.cancel(menus.length === 1 ? menus[0] : file); }
    catch (failure) {
      if (api.tracksOpeningAttempt) error.finderMenuCleanupFailure = finderStaticFailure(failure);
      error.menuCleanupError = failure.message;
    }
    throw error;
  }
}

// A window the task already closed can keep answering AXRole while its title is unsupported (-25205): Chess and Word did after
// their tasks saved and closed them (2026-10-16). It counts as closed only when the app's own window list, read successfully,
// no longer holds it. A still-listed window can continue only when its setup binding supplies the missing title identity.
function closedUnderUs(window, app, api, request) {
  if (!api.text || !api.listed) return false;
  try {
    if (api.title && api.title(window) === null && api.titleFree && api.titleFree(window, request, app)) return false;
    api.text(window, 'AXTitle');
    return false;
  }
  catch (error) {
    if (error.code !== -25205) throw error;
    var listed = api.listed(app, window);
    if (listed === false) return true;
    if (api.titleFree && api.titleFree(window, request, app)) return false;
    // Still listed (or the list is unreadable): say what the window looks like, so the next fix is measured, not guessed.
    var probe = function (attribute) { try { var v = api.read(window, attribute); return v === null ? 'null' : 'ok'; } catch (e) { return String(e.code); } };
    error.message += ' [listed=' + listed + ' role=' + probe('AXRole') + ' subrole=' + probe('AXSubrole') + ' document=' + probe('AXDocument') +
      ' sheets=' + probe('AXSheets') + ' children=' + probe('AXChildren') + ' minimized=' + probe('AXMinimized') + ']';
    throw error;
  }
}

// AX metadata on the retained reference only. Decode file URLs as strings so
// reporting never resolves symlinks, stats a file or visits a folder.
function numbersDocumentReport(window, api) {
  try {
    var document = api.text(window, 'AXDocument');
    var value = document || api.text(window, 'AXTitle');
    if (typeof value !== 'string' || !value) return { status: 'unavailable' };
    if (value.indexOf('file://') === 0) {
      var match = /^file:\/\/(?:localhost)?(\/[^?#]*)$/.exec(value);
      if (!match) return { status: 'unavailable' };
      value = decodeURIComponent(match[1]);
    }
    if (/[\x00-\x1f\x7f]/.test(value)) return { status: 'unavailable' };
    if (value[0] === '/') return { status: 'available', path: value };
    if (!document && /\.numbers$/i.test(value)) return { status: 'available', name: value };
    return document ? { status: 'unavailable' } : { status: 'available' };
  } catch (_) { return { status: 'unavailable' }; }
}

function closeOwnedWindow(window, request, app, api) {
  if (request.reportDocument === true && request.bundle === 'com.apple.iWork.Numbers' && request.mode === 'document') {
    api.emit({ stage: 'numbers-document', numbersDocument: numbersDocumentReport(window, api) });
  }
  if (request.bundle === 'com.apple.finder' && request.mode === 'folder') {
    return closeFinderFixtureWindows(window, request, app, api);
  }
  var phase = 'start';
  try { return closeOwnedWindowSteps(window, request, app, api, function (name) { phase = name; }); }
  catch (error) {
    // A stop says which step failed and what the window answered then, so a fix is measured (Chess and Word, 2026-10-16).
    if (error && (error.code === -25205 || error.code === -25202) && api.read && error.message.indexOf('[phase=') === -1) {
      var probe = function (attribute) { try { var v = api.read(window, attribute); return v === null ? 'null' : 'ok'; } catch (e) { return String(e.code); } };
      var listed; try { listed = api.listed ? api.listed(app, window) : 'n/a'; } catch (e) { listed = String(e.code); }
      error.message += ' [phase=' + phase + ' listed=' + listed + ' role=' + probe('AXRole') + ' subrole=' + probe('AXSubrole') +
        ' sheets=' + probe('AXSheets') + ' children=' + probe('AXChildren') + ' minimized=' + probe('AXMinimized') + ']';
    }
    throw error;
  }
}

// A retained Finder window may navigate within the fixture bank. Its path
// confirms location; the separate creation receipt establishes ownership.
function finderFixtureWindow(window, request, api) {
  var document = api.text(window, 'AXDocument') || api.text(window, 'AXURL');
  if (document) {
    var current = api.path(document), root = api.path(request.fixtureRoot || request.target);
    return !!current && !!root && (current === root || current.indexOf(root + '/') === 0);
  }
  return api.text(window, 'AXTitle') === request.token;
}

function closeFinderFixtureWindows(owned, request, app, api) {
  var receipt = finderRoleLedger(request.finderOwnership, api);
  function contains(list, window) { return list.some(function (item) { return api.equal(item, window); }); }
  var baseline = receipt.baseline.map(function (entry) { return entry.reference; });
  if (!owned || !contains(receipt.created, owned) || contains(baseline, owned))
    throw new Error('Finder fixture window ownership unconfirmed');
  function inventory() {
    var windows = finderRoleInventory(app, api, receipt).map(function (entry) { return entry.reference; });
    if (windows.some(function (window) {
      return !contains(baseline, window) && !contains(receipt.created, window);
    })) throw new Error('Finder extra window ownership unconfirmed');
    return windows;
  }
  function listed(window) { return contains(inventory(), window); }
  function validate(window) {
    inventory();
    if (api.dialog(app, window, Object.assign({}, request, { refuseDialogs: true })).length)
      throw new Error('Finder dialog present; fixture cleanup refused');
    if (!listed(window) || contains(baseline, window) || !finderFixtureWindow(window, request, api))
      throw new Error('Finder fixture identity changed');
    if (!listed(window)) throw new Error('Finder fixture identity changed');
  }
  inventory();
  receipt.created.forEach(function (window) {
    if (!listed(window)) return;
    validate(window);
    api.closeButton(window, function () { validate(window); }, true);
    for (var attempt = 0; attempt < 30 && listed(window); attempt++) api.wait();
    if (listed(window)) throw new Error('Finder fixture window is still open');
  });
  inventory();
}

// Word put an untitled document's Don't Save sheet only behind AXFocusedUIElement, absent from AXWindows and AXSheets
// (Office investigation, 2026-10-17). A window that reads as gone counts as closed only when no such sheet is left.
var HIDDEN_SHEET = 'Owned fixture save sheet left outside AXSheets; cleanup unconfirmed';
function closedWithoutSheet(app, window, api) { return !(api.hiddenSheet && api.hiddenSheet(app, window)); }

function closeOwnedWindowSteps(window, request, app, api, step) {
  if (request.mode === 'document' && request.stopOnAppDialog) request = Object.assign({}, request, { refuseDialogs: true });
  if (!window) return;
  if (!api.exists(window) || closedUnderUs(window, app, api, request)) {
    if (closedWithoutSheet(app, window, api)) return;
    throw new Error(HIDDEN_SHEET);
  }
  step('identity');
  if (!api.matches(window, request, true)) throw new Error('Owned fixture document identity changed');
  var noDialog = function () {
    var found = request.refuseDialogs ? api.dialog(app, window, request) : [];
    // The refusal names what it saw, so the next fix is measured (Word's save sheets, 2026-10-18).
    if (found.length) throw new Error('Application dialog present; fixture cleanup refused (' + found.map(function (item) {
      return item.category + ' "' + item.title + '" [' + (item.buttons || []).join(', ') + ']';
    }).join('; ') + ')');
  };
  var identity = function () { noDialog(); validateOwnedFixture(window, request, app, api, false); };
  var discardIdentity = function () {
    var epoch;
    do {
      epoch = api.readEpoch ? api.readEpoch() : 0;
      identity();
      if (request.mode === 'document') {
        var focused = api.focused(app), sheet = api.discardable(window, request, app);
        if (!api.equal(focused, window) && !api.equal(focused, sheet)) throw new Error('Owned document lost focus; cleanup refused');
      }
    } while (api.readEpoch && api.readEpoch() !== epoch);
  };
  step('close');
  if (request.refuseDialogs && api.discardable && api.discardable(window, request, app)) {
    api.discard(window, discardIdentity, request, app);
  } else if (request.mode === 'document') {
    var sibling = raiseOverSibling(window, request, app, api);
    var validate = function () {
      noDialog();
      // A run-launched app's button targets this window even when its sibling keeps focus. A menu still requires this window.
      validateOwnedFixture(window, request, app, api, true,
        api.closesDocumentByButton && api.closesDocumentByButton() ? sibling : null);
    };
    validate();
    api.closeDocument(app, validate, request, window);
  } else api.closeButton(window, identity);
  var sheetLeft = false;
  for (var attempt = 0; attempt < 30; attempt++) {
    step('wait-' + attempt);
    api.wait();
    try {
      if (!api.exists(window) || closedUnderUs(window, app, api, request) || (request.mode === 'document' && !api.matches(window, request, true))) {
        if (closedWithoutSheet(app, window, api)) return;
        sheetLeft = true;
        continue;
      }
      noDialog();
      if (!request.refuseDialogs || (api.discardable && api.discardable(window, request, app))) {
        api.discard(window, request.refuseDialogs ? discardIdentity : identity, request, app);
      }
    } catch (error) {
      // The close can finish between two reads of one check: the window answers AXRole, then is an invalid element (-25202)
      // for AXDocument, AXSheets or AXRole (3 TextEdit stops on 2026-10-19, every probe -25202, listed=false). Only the
      // retained window reading as gone continues the wait, and the next turn still requires no save sheet left behind.
      if (!error || error.code !== -25202 || api.exists(window)) throw error;
    }
  }
  throw new Error(sheetLeft ? HIDDEN_SHEET : 'Owned fixture window is still open');
}

// A task that drags between two fixture windows needs both uncovered: TextEdit cascades a second document over the first,
// and sleight's drag refused the drop as covered by the sibling in all 4 textedit-window-drag runs of 2026-10-19. Each
// window gets its own slot in the primary display's visible frame (menu bar and Dock excluded), side by side with a gap,
// so the slots never overlap on any display size. AX coordinates, origin at the primary display's top left.
var PLACEMENT_GAP = 16;
function fixtureFrame(visible, slot, count) {
  if (!(count >= 1) || !(slot >= 0) || slot >= count || slot !== Math.floor(slot)) throw new Error('Fixture placement slot invalid');
  var width = Math.floor(Math.min(720, (visible.width - PLACEMENT_GAP * (count + 1)) / count));
  var height = Math.floor(Math.min(560, visible.height - PLACEMENT_GAP * 2));
  if (!(width >= 320) || !(height >= 240)) throw new Error('Display too small for side-by-side fixture windows');
  return { x: Math.round(visible.x + PLACEMENT_GAP + slot * (width + PLACEMENT_GAP)), y: Math.round(visible.y + PLACEMENT_GAP), width: width, height: height };
}

// The window must end inside its slot (half a gap of slack) and inside the visible frame, or setup fails before the task starts.
function placeFixtureWindow(window, placement, api) {
  var visible = api.visibleFrame(), frame = fixtureFrame(visible, placement.slot, placement.count);
  api.place(window, frame);
  var actual = api.frame(window), slack = PLACEMENT_GAP / 2;
  var inSlot = actual && actual.x >= frame.x - slack && actual.x + actual.width <= frame.x + frame.width + slack &&
    actual.y >= visible.y - 1 && actual.y + actual.height <= visible.y + visible.height + 1;
  if (!inSlot) throw new Error('Fixture window placement unconfirmed (wanted ' + JSON.stringify(frame) + ', read ' + JSON.stringify(actual) + ')');
  return { slot: placement.slot, count: placement.count, visible: visible, frame: frame, actual: actual };
}

// File > Close acts on the focused document, and a task with two fixture windows can leave the other one focused
// (textedit-window-drag, 2026-10-16). Only when the focused window is a fixture of this run (its title carries the run's
// nonce) is this one raised in the background. Any other focused window keeps the lost-focus refusal.
// The nonce is the run token. A document's own token is its file name (Target-<nonce>.txt), which its sibling
// (Source-<nonce>.txt) never carries: that check refused every sibling and stopped 4 native passes on 2026-10-19.
function siblingToken(request) { return request.runToken || request.token; }
function raiseOverSibling(window, request, app, api) {
  if (!api.raise || !siblingToken(request)) return;
  var focused = api.focused(app);
  if (!focused || api.equal(focused, window) || api.text(focused, 'AXTitle').indexOf(siblingToken(request)) === -1) return;
  api.raise(window);
  for (var attempt = 0; attempt < 20 && !api.equal(api.focused(app), window); attempt++) api.wait();
  return focused;
}

function closeDocumentSafely(app, request, validate, api) {
  // In an app this run launched, the validated window's own close button closes only the fixture, in the background. The
  // File menu is never opened there: macOS checks Close against a key window a background app may never set, and a menu
  // opened by Accessibility can stay in its tracking loop, after which the app ignores quit (TextEdit, Preview and Word,
  // 2026-10-16; TextEdit's sample showed NSMenuTrackingSession).
  if (api.button) return api.button(validate);
  try { api.menu(app, validate); }
  catch (error) {
    var disabled = !error.menuCleanupError && error.message === 'Fixture menu item unavailable or ambiguous';
    if (request.ownerAway !== true || !disabled) throw error;
    validate();
    api.activate(app);
    validate();
    api.menu(app, validate);
  }
}

function appDialogCategory(info) {
  var modal = ['AXDialog', 'AXSystemDialog'].indexOf(info.subrole) !== -1;
  if (info.document && !modal) return null;
  var startup = /^(?:Microsoft )?(?:Word|Excel|PowerPoint|Mail|Numbers)$/.test(info.title || '');
  var text = [info.title || ''].concat(modal || startup ? (info.buttons || []).concat(info.text || []) : []).join('\n');
  if (/(?:activate|activation|licen[cs][ei]|subscription|product key)/i.test(text)) return 'activation';
  if (/\b(?:sign[ -]?in|log[ -]?in)\b/i.test(text)) return 'sign-in';
  if (/\b(?:grant access|allow access|needs? access|permission|would like to access|don.t allow)\b/i.test(text)) return 'permission';
  if (/\b(?:welcome|what.s new|getting started|first run|get started)\b/i.test(text)) return 'first-run';
  return modal ? 'application-result' : null;
}

function appDialogInfo(info, app, refuseDialogs) {
  var category = appDialogCategory(info);
  if (!category) return null;
  return { app: app, category: category, title: info.title || '', buttons: info.buttons || [],
    stop: refuseDialogs === true || ['activation', 'sign-in', 'permission'].indexOf(category) !== -1,
    description: category + ' application dialog' };
}

function cancelFixtureMenu(menu, api, refuseDialogs) {
  if (refuseDialogs && api.role(menu) !== 'AXMenu') throw new Error('Fixture cancellation target is not an observed menu');
  if (api.cancel(menu)) return 'AXCancel';
  if (refuseDialogs) throw new Error('Fixture menu cancellation failed; Escape refused');
  api.escape();
  return 'Escape';
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

var DISCARD_TITLES = ["Don't Save", 'Don’t Save'];
// Buttons a save prompt may carry besides Don't Save. Untitled buttons are icons and help; any other title keeps the refusal.
var SAVE_PROMPT_TITLES = DISCARD_TITLES.concat(['Save', 'Save…', 'Save...', 'Save As…', 'Save As...', 'Cancel', '']);

// Four Word cleanups refused the fixture's own save sheet as an app dialog (2026-10-18 claim runs), and Word answered -25205
// for a window's AXSheets at launch (2026-10-17). Where its sheet sits isn't measured, so a sheet counts as attached when
// AXSheets lists it, the window's children hold it, or the focused window is a sheet whose parent is this window. A focused
// alert (AXDialog) is marked as one, and must name the fixture file and nonce in its text.
function attachedSheets(window, app, api) {
  var sheets = api.children(window, 'AXSheets');
  if (sheets.length) return { sheets: sheets, source: 'AXSheets' };
  sheets = api.children(window).filter(function (child) { return api.text(child, 'AXRole') === 'AXSheet'; });
  if (sheets.length) return { sheets: sheets, source: 'AXChildren' };
  var focused = app && api.read ? api.read(app, 'AXFocusedWindow') : null;
  if (!focused || api.equal(focused, window)) return { sheets: [], source: null };
  var parent = function () { try { return api.read(focused, 'AXParent'); } catch (error) { if (error.code === -25205) return null; throw error; } };
  if (api.text(focused, 'AXRole') === 'AXSheet' && api.equal(parent(), window)) return { sheets: [focused], source: 'focused sheet' };
  if (api.text(focused, 'AXSubrole') === 'AXDialog') return { sheets: [focused], source: 'focused alert', alert: true };
  return { sheets: [], source: null };
}

// Only the exact fixture file's save prompt bypasses a dialog refusal. An unsupported title needs the retained AX reference,
// successful listing and setup's CG number instead. Numbers imports can lack a document URL;
// their nonce title and attached sheet still bind the discard to the retained window.
function fixtureDiscardSheet(window, request, api, app) {
  var located = fixtureDiscardPrompt(window, request, api, app);
  return located ? located.sheet : null;
}

function fixtureDiscardPrompt(window, request, api, app) {
  var token = request.runToken || request.token;
  if (!window || !token || !request.target || request.target[0] !== '/') return null;
  var rawDocument = api.text(window, 'AXDocument'), document = api.path(rawDocument), expected = api.path(request.target), title;
  try { title = api.title ? api.title(window) : api.text(window, 'AXTitle'); }
  catch (error) { if (error.code !== -25205) throw error; title = null; }
  var numbersImport = request.bundle === 'com.apple.iWork.Numbers' && request.mode === 'document' && /\.csv$/i.test(request.target);
  var unnamedImport = numbersImport && !rawDocument && typeof title === 'string' && title.indexOf(token) !== -1;
  if ((!unnamedImport && (!document || document !== expected)) || (title === null ?
      !(api.titleFree && api.titleFree(window, request, app)) : title.indexOf(token) === -1)) return null;
  var found = attachedSheets(window, app, api);
  if (found.alert && (numbersImport || request.requireAttachedSheet || title === null)) return null;
  if (found.sheets.length !== 1) return null;
  var sheet = found.sheets[0];
  if (!found.alert && api.text(sheet, 'AXRole') !== 'AXSheet') return null;
  var content = dialogContents(sheet, api), buttons = content.buttons;
  var discardTitles = numbersImport ? DISCARD_TITLES.concat(['Delete']) : DISCARD_TITLES;
  var saveTitles = numbersImport ? SAVE_PROMPT_TITLES.concat(['Delete']) : SAVE_PROMPT_TITLES;
  if (buttons.filter(function (name) { return discardTitles.indexOf(name) !== -1; }).length !== 1 ||
      buttons.some(function (name) { return saveTitles.indexOf(name) === -1; }) ||
      appDialogCategory({ subrole: 'AXDialog', title: api.text(sheet, 'AXTitle'), text: content.text, buttons: buttons }) !== 'application-result') return null;
  if (found.alert) {
    var name = request.target.split('/').pop(), stem = name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name;
    var said = content.text.join('\n');
    if (said.indexOf(stem) === -1 || said.indexOf(token) === -1) return null;
  }
  return { sheet: sheet, source: found.source, windowTitle: title, buttons: buttons, discardTitles: discardTitles };
}

// Bind the file window before requesting quit. Poll only its own save sheet,
// never an app-wide button search or an Apple event to Office.
function prepareOfficeQuitDiscard(request, app, api) {
  if (!request || request.mode !== 'document' || !request.target || request.target[0] !== '/' ||
      !(request.runToken || request.token)) throw new Error('Office quit fixture identity unavailable');
  var token = request.runToken || request.token, expected = api.path(request.target);
  if (!expected) throw new Error('Office quit fixture path unavailable');
  function matches(window) {
    var title = api.title ? api.title(window) : api.text(window, 'AXTitle');
    return api.path(api.text(window, 'AXDocument')) === expected && (title === null ?
      !!(api.titleFree && api.titleFree(window, request, app)) : title.indexOf(token) !== -1);
  }
  var windows = api.windows(app).filter(function (window) {
    if (api.bindRetained && request.fixtureWindow) api.bindRetained(window, request, app, request.fixtureWindow);
    return matches(window);
  });
  if (windows.length > 1) throw new Error('Ambiguous Office quit fixture window');
  var owned = windows[0], guarded = Object.assign({}, request, { refuseDialogs: true, requireAttachedSheet: true }), answered = false;
  return function (validateProcess) {
    if (!owned || answered || !api.exists(owned)) return;
    var validate = function () {
      var epoch;
      do {
        epoch = api.readEpoch();
        validateProcess();
        if (!matches(owned) || !api.listed(app, owned)) throw new Error('Office quit fixture window identity changed');
      } while (epoch !== api.readEpoch());
      validateProcess();
    };
    validate();
    // The existing guarded discard rechecks the exact sheet and accepts only
    // the save-prompt table's single Don't Save button.
    answered = api.discard(owned, validate, guarded, app) === true;
  };
}

function discardButtons(sheet, api, titles) {
  var result = [], visited = 0;
  (function visit(current, depth) {
    if (depth < 0 || ++visited > 512) throw new Error('Application dialog inspection exceeded its bound');
    api.children(current).forEach(function (child) {
      if (api.text(child, 'AXRole') === 'AXButton' && (titles || DISCARD_TITLES).indexOf(api.text(child, 'AXTitle')) !== -1) result.push(child);
      visit(child, depth - 1);
    });
  })(sheet, 8);
  return result;
}

function recoverFixtureApplications(request, api, clock) {
  var root = api.path(request.fixtureDir);
  if (request.fixtureMode !== 'document' || request.running !== false || request.launched !== true || !(request.startedAtMs > 0) || !request.runToken || !root || root === '/') {
    throw new Error('Owned fixture recovery identity unconfirmed');
  }
  var original;
  function inventory() {
    if (clock.check) clock.check();
    var plans = api.applications().map(function (target) {
      var pid = runningPid(target), date = target.launchDate;
      if (!(pid > 0) || runningBundle(target) !== request.bundle || !date || date.isNil() ||
          !(Number(date.timeIntervalSince1970) * 1000 >= request.startedAtMs)) throw new Error('Fixture process ownership unconfirmed');
      if (original && original.indexOf(pid) === -1) throw new Error('Fixture process identity changed during recovery');
      var app = api.app(target), listedWindows = api.windows(app), excluded = [];
      // A sheet may have its own AXWindows and CG entries. Exclude only a child
      // whose AXParent is one of this inventory's validated fixture windows.
      var documents = listedWindows.filter(function (window) {
        var parent = api.read ? api.read(window, 'AXParent') : null;
        return !parent || !listedWindows.some(function (candidate) { return api.equal(parent, candidate); });
      });
      var windows = documents.map(function (window) {
        var path = api.path(api.text(window, 'AXDocument'));
        var closeRequest = Object.assign({}, request, { mode: 'window', target: path, token: request.runToken, refuseDialogs: true });
        if (api.bindRetained) (request.fixtureWindows || []).forEach(function (receipt) {
          if (receipt.target === path) api.bindRetained(window, closeRequest, app, receipt);
        });
        var title = api.title ? api.title(window) : api.text(window, 'AXTitle');
        if (!path || path.indexOf(root + '/') !== 0 || (title === null ?
            !(api.titleFree && api.titleFree(window, closeRequest, app)) : title.indexOf(request.runToken) === -1)) {
          throw new Error('Fixture window outside owned run directory');
        }
        if (api.read && api.windowNumber) {
          var candidates = listedWindows.concat(attachedSheets(window, app, api).sheets);
          candidates.forEach(function (child) {
            var parent = api.read(child, 'AXParent');
            if (parent && api.equal(parent, window)) {
              var number = api.windowNumber(child, app);
              if (number && excluded.indexOf(number) === -1) excluded.push(number);
            }
          });
        }
        if (api.dialog(app, window, closeRequest).length) throw new Error('Application dialog present; fixture recovery refused');
        return { window: window, request: closeRequest };
      });
      if (!windows.length && (!request.pids || request.pids.indexOf(pid) === -1)) throw new Error('Empty fixture process ownership unconfirmed; recorded pid required');
      if (!windows.length && api.dialog(app, null, Object.assign({}, request, { refuseDialogs: true })).length) throw new Error('Application dialog present; fixture recovery refused');
      if (api.cgWindowCount(pid, excluded) > windows.length) throw new Error('Extra window in fixture process inventory; recovery refused');
      return { pid: pid, processStartedAtMs: Number(date.timeIntervalSince1970) * 1000, app: app, windows: windows };
    });
    return plans;
  }
  var plans = inventory();
  original = plans.map(function (plan) { return plan.pid; });
  var processes = plans.map(function (plan) { return { pid: plan.pid, processStartedAtMs: plan.processStartedAtMs }; });
  plans.forEach(function (plan) {
    plan.windows.forEach(function (item) {
      inventory();
      // Every action rechecks the whole app set as well as the retained window.
      var guarded = Object.create(api);
      guarded.closeButton = function (window, validate) {
        api.closeButton(window, function () { inventory(); validate(); });
      };
      guarded.discard = function (window, validate, closeRequest, app) {
        api.discard(window, function () { inventory(); validate(); }, closeRequest, app);
      };
      closeOwnedWindow(item.window, item.request, plan.app, guarded);
    });
  });
  inventory().forEach(function (plan) {
    quitFixtureApplication(plan.pid, request.bundle, function () { return api.application(plan.pid); }, {
      now: clock.now, wait: clock.wait, emit: clock.emit,
      check: function () {
        var remaining = inventory();
        if (remaining.some(function (item) { return item.windows.length; })) throw new Error('Owned fixture windows remain; quit refused');
      },
    });
  });
  if (inventory().length) throw new Error('Owned fixture processes still running');
  return { pids: original, processes: processes };
}

function nativeAX(state, clock) {
  var placementBound = false, retainedWindows = [], discardedWindows = [], unsupportedTitle = {};
  function roleValueDiagnostic(object) {
    var diagnostic = { roleNativeType: 'unavailable', roleNativeWindowEqual: 'unavailable', roleDeepWindowEqual: 'unavailable' };
    try { if (!object || (object.isNil && object.isNil())) return diagnostic; }
    catch (error) { return diagnostic; }
    try {
      var type = Number($.CFGetTypeID(object)), stringType = Number($.CFStringGetTypeID());
      if (isFinite(type) && type > 0 && isFinite(stringType) && stringType > 0)
        diagnostic.roleNativeType = type === stringType ? 'cf-string' : 'other';
    } catch (error) {}
    if (diagnostic.roleNativeType === 'cf-string') {
      try {
        var equal = Number($.CFEqual(object, $('AXWindow')));
        if (equal === 0 || equal === 1) diagnostic.roleNativeWindowEqual = equal === 1 ? 'yes' : 'no';
      } catch (error) {}
    }
    try {
      var deep = ObjC.deepUnwrap(object);
      if (typeof deep === 'string') diagnostic.roleDeepWindowEqual = deep === 'AXWindow' ? 'yes' : 'no';
    } catch (error) {}
    return diagnostic;
  }
  function refusedRoleCapture(capture) {
    if (!capture) return;
    var diagnostic = capture.roleValueProbe ? capture.roleValueProbe() : roleValueDiagnostic(null);
    delete capture.roleValueProbe;
    Object.assign(capture, diagnostic);
  }
  function read(element, attribute, titleOptional, capture) {
    var operation = function () {
      if (clock && clock.check) clock.check();
      if (state && state.officeWaiting && clock.now() >= state.officeDeadline) throw officeDeadlineError(state);
      var value = Ref();
      var code = Number($.AXUIElementCopyAttributeValue(element, $(attribute), value));
      if (capture) {
        capture.axCode = code;
        capture.roleReadCode = [0, -25212, -25202].indexOf(code) !== -1 ? code : 'other';
      }
      if (code === -25205 && attribute === 'AXTitle' && titleOptional) return unsupportedTitle;
      // These optional attributes can remain unsupported on a valid app
      // window. Their absence allows the existing nonce-title identity fallback.
      if (code === -25205 && state && (state.setup || state.cleanup || state.observation) &&
          ['AXDocument', 'AXURL', 'AXSheets', 'AXSubrole', 'AXMainWindow', 'AXWindows', 'AXChildren', 'AXValue', 'AXWindowNumber', 'AXParent'].indexOf(attribute) !== -1) {
        if (state.office) state.officeLastError = { code: code, attribute: attribute };
        return null;
      }
      if (code === -25212 || (code === -25205 && !(state && (state.setup || state.cleanup || state.observation)))) return null;
      if (code !== 0) throw Object.assign(new Error('AX fixture read failed: ' + code + ' (' + attribute + ')'), { code: code, attribute: attribute });
      var nativeValue = value[0], object = ObjC.castRefToObject(nativeValue);
      if (capture) capture.roleValueProbe = function () { return roleValueDiagnostic(object); };
      return object;
    };
    if (state && (state.cleanup || state.observation)) return cleanupRead(operation, state, clock);
    return state && state.officeWaiting ? operation() : setupRead(operation, state, clock);
  }
  function text(element, attribute, capture) {
    var value = read(element, attribute, undefined, capture), raw = value ? ObjC.unwrap(value) : value;
    var result = value ? String(raw) : '';
    if (capture) {
      if (typeof raw === 'string' && ['AXApplication', 'AXSystemWide', 'AXWindow', 'AXSheet', 'AXDrawer', 'AXDialog', 'AXGroup', 'AXButton', 'AXScrollArea', 'AXUnknown'].indexOf(raw) !== -1)
        capture.roleKnown = raw;
      if (raw == null) capture.roleState = 'nil';
      else if (typeof raw !== 'string') capture.roleState = 'nonstring';
      else if (!raw) capture.roleState = 'empty';
      else if (['AXSheet', 'AXDialog', 'AXGroup', 'AXButton'].indexOf(raw) !== -1) capture.roleState = 'known-nonwindow';
      else if (raw !== 'AXWindow') capture.roleState = 'other-string';
    }
    return result;
  }
  var textOf = text;
  function children(element, attribute) {
    var values = read(element, attribute || 'AXChildren'), result = [];
    if (values) for (var index = 0; index < Number(values.count); index++) result.push(values.objectAtIndex(index));
    return result;
  }
  function press(element, beforePress, onAttempt) {
    if (clock && clock.check) clock.check();
    if (state && state.setup) { state.actionTaken = true; clock.emit({ stage: 'action', actionTaken: true }); }
    if (beforePress) beforePress();
    if (clock && clock.check) clock.check();
    if (onAttempt) onAttempt();
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
    if (!request.stopOnAppDialog && !request.refuseDialogs) return [];
    // Another window of the app can lack a title (Chess, 2026-10-16: -25205 on AXTitle of the focused window at cleanup). In this
    // scan a missing title reads as empty, so that window is still classified as a candidate instead of stopping the pass.
    var text = function (element, attribute) {
      try { return textOf(element, attribute); }
      catch (error) { if (error.code === -25205 && attribute === 'AXTitle') return ''; throw error; }
    };
    var matches = function (window, request) {
      try { return matchesOf(window, request); }
      catch (error) { if (error.code === -25205 && error.attribute === 'AXTitle') return false; throw error; }
    };
    var focused = read(app, 'AXFocusedWindow');
    var candidates = [];
    // A fixture window the task already closed is an invalid element (-25202, TextEdit 2026-10-16): it has no sheets left to scan.
    if (owned) { try { candidates = candidates.concat(children(owned, 'AXSheets')); } catch (error) { if (error.code !== -25202) throw error; } }
    if (focused && (!owned || !$.CFEqual(focused, owned))) {
      if (['AXDialog', 'AXSystemDialog'].indexOf(text(focused, 'AXSubrole')) !== -1 || text(focused, 'AXRole') === 'AXSheet') candidates.push(focused);
      else if (matches(focused, request)) candidates = candidates.concat(children(focused, 'AXSheets'));
      else if (!text(focused, 'AXDocument')) candidates.push(focused);
    }
    var found = [];
    var safeSheet;
    try { safeSheet = state.cleanup && owned && fixtureDiscardSheet(owned, request, promptApi, app); }
    catch (error) { if (error.code !== -25202) throw error; }
    for (var index = 0; index < candidates.length; index++) {
      var candidate = candidates[index];
      if (safeSheet && $.CFEqual(candidate, safeSheet)) continue;
      // A dialog dismissed while it is read becomes an invalid element (-25202, Word's "All done" alert at cleanup,
      // 2026-10-16). It no longer exists, so it can't block cleanup.
      try {
        var info = { title: text(candidate, 'AXTitle'), subrole: text(candidate, 'AXSubrole'),
          document: text(candidate, 'AXDocument') };
        if (text(candidate, 'AXRole') === 'AXSheet') info.subrole = 'AXDialog';
        if (['AXDialog', 'AXSystemDialog'].indexOf(info.subrole) !== -1 || /^(?:Microsoft )?(?:Word|Excel|PowerPoint|Mail|Numbers)$/.test(info.title)) {
          var content = dialogContents(candidate, { children: children, text: text });
          info.buttons = content.buttons; info.text = content.text;
        }
      } catch (error) { if (error.code === -25202) continue; throw error; }
      var record = appDialogInfo(info, request.app, request.refuseDialogs);
      if (record) found.push(record);
    }
    return found;
  }
  function equal(a, b) { return !!a && !!b && !!$.CFEqual(a, b); }
  function menu(app, name, titles, beforePress, refuseDialogs, finderBaseline) {
    var bar = read(app, 'AXMenuBar');
    var files = children(bar).filter(function (item) { return text(item, 'AXTitle') === name; });
    if (files.length !== 1) throw new Error('Fixture needs the ' + name + ' menu');
    var trackedOpening = finderBaseline === true && state.bundle === 'com.apple.finder', commandGuard = trackedOpening ? beforePress : undefined;
    chooseFileMenu(files[0], titles, { tracksOpeningAttempt: trackedOpening,
      press: function (element, onAttempt) { press(element, commandGuard, onAttempt); }, children: children, text: text,
      beforePress: function () { commandGuard = beforePress; },
      enabled: function (item) { return Number(ObjC.unwrap(read(item, 'AXEnabled'))) === 1; }, cancel: function (menu) {
      if (clock && clock.check) clock.check();
      var method = cancelFixtureMenu(menu, { role: function (target) { return text(target, 'AXRole'); },
        cancel: function (target) { return Number($.AXUIElementPerformAction(target, $('AXCancel'))) === 0; },
        escape: function () {
        var pidRef = Ref();
        if (Number($.AXUIElementGetPid(app, pidRef)) !== 0) throw new Error('File-menu cancellation lost the app identity');
        var down = $.CGEventCreateKeyboardEvent(null, 53, true), up = $.CGEventCreateKeyboardEvent(null, 53, false);
        if (!down || down.isNil() || !up || up.isNil()) throw new Error('File-menu Escape could not be created');
        if (clock && clock.check) clock.check();
        $.CGEventPostToPid(Number(pidRef[0]), down); $.CGEventPostToPid(Number(pidRef[0]), up);
      } }, refuseDialogs === true || state.refuseDialogs);
      clock.emit({ stage: 'menu-cancel', menuCancelled: true, menuCancelMethod: method });
    }, inspect: function (items) {
      if (state.bundle === 'com.apple.finder') {
        clock.emit({ stage: 'menu-items', menuCommands: finderMenuDiagnostics(items, { text: text,
          enabled: function (item) { return Number(ObjC.unwrap(read(item, 'AXEnabled'))) === 1; } }) });
        return;
      }
      clock.emit({ stage: 'menu-items', menuItems: items.map(function (item) {
        var title = text(item, 'AXTitle');
        return /^New .+ Window$/.test(title) && title !== 'New Private Window' ? 'New <profile> Window' : title;
      }), menuCommands: items.map(function (item) { return { title: text(item, 'AXTitle'), enabled: Number(ObjC.unwrap(read(item, 'AXEnabled'))) === 1 }; }) });
    } });
  }
  function fileMenu(app, titles, beforePress, refuseDialogs, finderBaseline) { return menu(app, 'File', titles, beforePress, refuseDialogs, finderBaseline); }
  function path(value) {
    if (value && value[0] === '/') value = String(ObjC.unwrap($.NSURL.fileURLWithPath(value).absoluteString));
    if (!value || value.indexOf('file://') !== 0) return null;
    var url = $.NSURL.URLWithString(value);
    return url.isNil() || !url.isFileURL ? null : ObjC.unwrap(url.URLByResolvingSymlinksInPath.path);
  }
  function matchesOf(window, request, retained) { return matches(window, request, retained); }
  function matches(window, request, retained) {
    var document = text(window, 'AXDocument');
    if (document) {
      if (request.target && request.target.indexOf('http://') === 0) return document.indexOf(request.target) === 0;
      if (request.target && request.target.indexOf('https://') === 0) {
        var expected = $.NSURL.URLWithString(request.target), current = $.NSURL.URLWithString(document);
        if (expected.isNil() || current.isNil()) return false;
        var host = ObjC.unwrap(expected.host), scheme = ObjC.unwrap(expected.scheme);
        return scheme === 'https' && ObjC.unwrap(current.scheme) === 'https' && ObjC.unwrap(current.host) === host &&
          (host === 'www.target.com' || host === 'www.bestbuy.com');
      }
      var current = path(document), expected = request.target && request.target[0] === '/' ?
        path(String(ObjC.unwrap($.NSURL.fileURLWithPath(request.target).absoluteString))) : null;
      if (current && expected) {
        if (state && (state.cleanup || state.observation) && identityTitle(window) === null) return titleFree(window, request);
        return current === expected || (request.mode === 'folder' && current.indexOf(expected + '/') === 0);
      }
      return false;
    }
    var title = text(window, 'AXTitle');
    return request.mode === 'inherit' || title.indexOf(request.token) !== -1 ||
      (retained === true && request.mode === 'folder' && title === 'Archive');
  }
  function identityTitle(window) {
    var value = read(window, 'AXTitle', true);
    return value === unsupportedTitle ? null : value ? String(ObjC.unwrap(value)) : '';
  }
  function listed(app, window) {
    var values = read(app, 'AXWindows');
    if (!values) return undefined;
    for (var index = 0; index < Number(values.count); index++) if (equal(values.objectAtIndex(index), window)) return true;
    return false;
  }
  function cgWindows(pid) {
    if (clock && clock.check) clock.check();
    var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID);
    if (!raw || raw.isNil && raw.isNil()) throw new Error('Fixture CG window inventory unavailable');
    return ObjC.deepUnwrap(ObjC.castRefToObject(raw)).filter(function (window) {
      return Number(window.kCGWindowOwnerPID) === pid && Number(window.kCGWindowLayer) === 0;
    });
  }
  function windowNumber(window, app) {
    var pid = Ref();
    if (Number($.AXUIElementGetPid(app, pid)) !== 0) throw new Error('Fixture window process unavailable');
    var windows = cgWindows(Number(pid[0])), direct = read(window, 'AXWindowNumber');
    if (direct && Number(ObjC.unwrap(direct)) > 0) {
      windows = windows.filter(function (info) { return Number(info.kCGWindowNumber) === Number(ObjC.unwrap(direct)); });
    } else {
      var frame = api.frame(window);
      if (!frame) return null;
      var bounds = [frame.x, frame.y, frame.width, frame.height];
      if (!bounds.every(function (value) { return isFinite(value); })) return null;
      windows = windows.filter(function (info) {
        return ['X', 'Y', 'Width', 'Height'].every(function (key, index) {
          return info.kCGWindowBounds && Math.abs(Number(info.kCGWindowBounds[key]) - bounds[index]) < 0.5;
        });
      });
    }
    var number = windows.length === 1 ? Number(windows[0].kCGWindowNumber) : null;
    return number > 0 && number === Math.floor(number) ? number : null;
  }
  function retain(window, request, app, receipt) {
    var expected = request.target && request.target[0] === '/' ? path(request.target) : null;
    if (!expected || path(text(window, 'AXDocument')) !== expected || listed(app, window) !== true) return null;
    var number = windowNumber(window, app);
    if (!number || (receipt && (receipt.target !== expected || receipt.windowNumber !== number))) return null;
    var existing = retainedWindows.filter(function (item) { return equal(item.window, window); })[0];
    if (existing) return existing.receipt.target === expected && existing.receipt.windowNumber === number ? existing.receipt : null;
    var record = { target: expected, windowNumber: number };
    retainedWindows.push({ window: window, app: app, receipt: record });
    return record;
  }
  function titleFree(window, request, app) {
    if (!request) return false;
    var binding = retainedWindows.filter(function (item) { return equal(item.window, window); })[0];
    return !!binding && (!app || equal(app, binding.app)) && listed(binding.app, window) === true &&
      path(text(window, 'AXDocument')) === binding.receipt.target && path(request.target) === binding.receipt.target &&
      windowNumber(window, binding.app) === binding.receipt.windowNumber;
  }
  var promptApi = { text: text, title: identityTitle, titleFree: titleFree, children: children, path: path, read: read, equal: equal };
  var api = {
    emit: clock && clock.emit,
    title: identityTitle, titleFree: titleFree, retain: retain, windowNumber: windowNumber,
    bindRetained: function (window, request, app, receipt) { return receipt ? retain(window, request, app, receipt) : null; },
    read: read, text: text, children: children, press: press, fileMenu: fileMenu, menu: menu, path: path,
    finderFolderGuard: function (app, window, sheet) {
      var focused = this.focused(app);
      function refuseForeign(element) {
        if (!sheet || !equal(element, sheet)) throw new Error('Foreign Finder dialog; folder setup refused');
      }
      function inspect(element) {
        var role = text(element, 'AXRole'), subrole = text(element, 'AXSubrole');
        if (role === 'AXSheet' || ['AXDialog', 'AXSystemDialog'].indexOf(subrole) !== -1) refuseForeign(element);
        children(element, 'AXSheets').forEach(refuseForeign);
        // Some sheets are children but absent from AXSheets.
        if (role === 'AXWindow') children(element).forEach(function (child) {
          if (text(child, 'AXRole') === 'AXSheet' || ['AXDialog', 'AXSystemDialog'].indexOf(text(child, 'AXSubrole')) !== -1)
            refuseForeign(child);
        });
      }
      this.windows(app).forEach(inspect);
      children(app).forEach(inspect);
      if (focused) inspect(focused);
      var node = read(app, 'AXFocusedUIElement'), depth = 0;
      for (; node && depth < 12; node = read(node, 'AXParent'), depth++) {
        inspect(node);
        if (text(node, 'AXRole') === 'AXWindow' || equal(node, app)) break;
      }
      if (node && depth === 12) throw new Error('Finder focused element ancestry unconfirmed');
      if (window) {
        if (!this.exists(window) || this.listed(app, window) !== true) throw new Error('Finder folder window vanished');
        if (sheet && !equal(this.folderSheet(window, app), sheet)) throw new Error('Finder folder sheet identity changed');
        // AXFocusedWindow can be the parent or its sheet. Never raise either.
        if (!equal(focused, window) && !(sheet && equal(focused, sheet))) throw new Error('Finder folder window lost focus');
        // Dialog inspection itself may span a focus change.
        var current = this.focused(app);
        if (!equal(current, focused)) throw new Error('Finder folder focus changed during validation');
      }
    },
    folderSheet: function (window, app) {
      var sheets = children(window, 'AXSheets');
      var sheet = sheets.length === 1 ? sheets[0] : this.hiddenSheet(app, window);
      if (!sheet || text(sheet, 'AXRole') !== 'AXSheet') return null;
      // A Go to Folder sheet is valid only under the new window this helper created.
      for (var parent = read(sheet, 'AXParent'), depth = 0; parent && depth < 12; parent = read(parent, 'AXParent'), depth++) {
        if (equal(parent, window)) return sheet;
        if (text(parent, 'AXRole') === 'AXWindow') return null;
      }
      return null;
    },
    submitFolder: function (window, sheet, target, validate) {
      var pidRef = Ref();
      if (Number($.AXUIElementGetPid(window, pidRef)) !== 0) throw new Error('Finder folder window process unavailable');
      var app = $.AXUIElementCreateApplication(Number(pidRef[0]));
      $.AXUIElementSetMessagingTimeout(app, 0.5);
      if (!equal(this.folderSheet(window, app), sheet)) throw new Error('Finder folder sheet identity changed');
      var fields = [], combos = [], count = 0;
      function walk(node, depth) {
        if (depth > 6 || ++count > 128) throw new Error('Finder folder sheet exceeds bounded search');
        var role = text(node, 'AXRole');
        if (role === 'AXTextField') fields.push(node);
        if (role === 'AXComboBox') combos.push(node);
        children(node).forEach(function (child) { walk(child, depth + 1); });
      }
      walk(sheet, 0);
      if (!fields.length) fields = combos;
      var go = buttons(sheet, ['Go'], 6);
      if (fields.length !== 1 || go.length !== 1) throw new Error('Finder folder sheet controls ambiguous');
      if (clock && clock.check) clock.check();
      if (validate) validate();
      this.finderFolderGuard(app, window, sheet);
      if (validate) validate();
      if (clock && clock.check) clock.check();
      var code = Number($.AXUIElementSetAttributeValue(fields[0], $('AXValue'), $(target)));
      if (code !== 0) throw Object.assign(new Error('Finder folder AXValue failed: ' + code), { code: code, attribute: 'AXValue' });
      var self = this;
      press(go[0], function () {
        if (!equal(self.folderSheet(window, app), sheet)) throw new Error('Finder folder sheet identity changed');
        if (validate) validate();
        self.finderFolderGuard(app, window, sheet);
        if (validate) validate();
      });
    },
    applications: function () {
      var values = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(state.bundle), result = [];
      for (var i = 0; i < Number(values.count); i++) result.push(values.objectAtIndex(i));
      return result;
    },
    application: function (pid) {
      var value = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      return value.isNil() || value.isTerminated ? null : value;
    },
    app: function (target) {
      var app = $.AXUIElementCreateApplication(runningPid(target));
      $.AXUIElementSetMessagingTimeout(app, 0.5);
      return app;
    },
    windows: function (app) {
      var values = read(app, 'AXWindows');
      if (!values) throw windowInventoryError('Fixture window inventory unavailable', 'malformed-list');
      var rawCount = values.count, count = Number(rawCount);
      if (rawCount == null || !isFinite(count) || count < 0 || count !== Math.floor(count))
        throw windowInventoryError('Fixture window inventory malformed', 'malformed-list', rawCount == null ? undefined : count);
      var result = [];
      for (var i = 0; i < count; i++) result.push(values.objectAtIndex(i));
      return result;
    },
    cgWindowCount: function (pid, excluded) {
      return cgWindows(pid).filter(function (window) { return !excluded || excluded.indexOf(Number(window.kCGWindowNumber)) === -1; }).length;
    },
    readEpoch: function () { return state && state.readEpoch || 0; },
    wait: function () { $.NSThread.sleepForTimeInterval(0.1); },
    equal: function (a, b) { return !!a && !!b && !!$.CFEqual(a, b); },
    focused: function (app) { return read(app, 'AXFocusedWindow'); },
    mainWindow: function (app) { return read(app, 'AXMainWindow'); },
    windowCount: function (app) { return children(app, 'AXWindows').length; },
    // true or false only when the app's window list was read; undefined when it couldn't be.
    listed: listed,
    finderRole: function (window, diagnostic) {
      var capture = {};
      try {
        var role = text(window, 'AXRole', capture);
        if (diagnostic) diagnostic.role = role;
        if (capture.roleReadCode === 0 && ['AXWindow', 'AXScrollArea'].indexOf(capture.roleKnown) !== -1) return capture.roleKnown;
        refusedRoleCapture(capture);
        if (diagnostic) Object.assign(diagnostic, capture);
        return null;
      } catch (error) {
        refusedRoleCapture(capture);
        if (diagnostic) Object.assign(diagnostic, capture);
        if (error.code === -25202) { if (diagnostic) diagnostic.axCode = error.code; return null; }
        var fields = roleReadFields(capture);
        if (fields.length) error.message += ' [' + fields.join(' ') + ']';
        throw error;
      }
    },
    exists: function (window, diagnostic) {
      var capture = diagnostic ? {} : undefined;
      try {
        var role = text(window, 'AXRole', capture);
        if (diagnostic) diagnostic.role = role;
        if (role === 'AXWindow') return true;
        refusedRoleCapture(capture);
        if (diagnostic) Object.assign(diagnostic, capture);
        return false;
      }
      catch (error) {
        refusedRoleCapture(capture);
        if (diagnostic) Object.assign(diagnostic, capture);
        if (error.code === -25202) { if (diagnostic) diagnostic.axCode = error.code; return false; }
        var fields = roleReadFields(capture);
        if (fields.length) error.message += ' [' + fields.join(' ') + ']';
        throw error;
      }
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
    visibleFrame: function () {
      var screens = $.NSScreen.screens;
      if (!screens || Number(screens.count) < 1) throw new Error('Fixture display unavailable');
      var primary = screens.objectAtIndex(0), full = primary.frame, area = primary.visibleFrame;
      return { x: Number(area.origin.x), y: Number(full.size.height) - (Number(area.origin.y) + Number(area.size.height)),
        width: Number(area.size.width), height: Number(area.size.height) };
    },
    place: function (window, frame) {
      if (clock && clock.check) clock.check();
      if (!placementBound) {
        ObjC.bindFunction('malloc', ['void*', ['unsigned long']]);
        ObjC.bindFunction('free', ['void', ['void*']]);
        ObjC.bindFunction('AXValueCreate', ['id', ['int', 'void*']]);
        placementBound = true;
      }
      var set = function (attribute, type, boxed) {
        var bytes = $.malloc(32);
        try {
          boxed.getValue(bytes);
          if (clock && clock.check) clock.check();
          var code = Number($.AXUIElementSetAttributeValue(window, $(attribute), $.AXValueCreate(type, bytes)));
          if (code !== 0) throw Object.assign(new Error('Fixture window placement failed: ' + code + ' (' + attribute + ')'), { code: code });
        } finally { $.free(bytes); }
      };
      set('AXSize', 2, $.NSValue.valueWithSize($.NSMakeSize(frame.width, frame.height)));
      set('AXPosition', 1, $.NSValue.valueWithPoint($.NSMakePoint(frame.x, frame.y)));
    },
    // JXA's Ref('CGPoint') reads back as 0: copy the struct into bytes (plugins/sleight/lib/element-visibility.js).
    frame: function (window) {
      var pair = function (attribute, type) {
        var value = read(window, attribute);
        if (!value) return null;
        var bytes = $.NSMutableData.dataWithLength(16);
        if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
        var boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
        var unwrapped = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
        return type === 1 ? [Number(unwrapped.x), Number(unwrapped.y)] : [Number(unwrapped.width), Number(unwrapped.height)];
      };
      var position = pair('AXPosition', 1), size = pair('AXSize', 2);
      return position && size ? { x: position[0], y: position[1], width: size[0], height: size[1] } : null;
    },
    raise: function (window) {
      if (clock && clock.check) clock.check();
      if (Number($.AXUIElementPerformAction(window, $('AXRaise'))) !== 0) throw new Error('Owned fixture window raise failed');
      if (clock && clock.check) clock.check();
      $.AXUIElementSetAttributeValue(window, $('AXMain'), $.kCFBooleanTrue);
    },
    closeButton: function (window, validate, finderBaseline) {
      var button = read(window, 'AXCloseButton');
      if (!button) throw new Error('Owned window has no close button');
      if (validate) validate();
      press(button, finderBaseline === true ? validate : undefined);
    },
    closesDocumentByButton: function () { return !!(state && (state.setupCase === 'cold-launch' || state.launchedByRun)); },
    closeDocument: function (app, validate, request, window) {
      var closeButton = this.closeButton;
      closeDocumentSafely(app, request, validate, {
        button: window && this.closesDocumentByButton() ? function (check) { closeButton(window, check); } : undefined,
        menu: function (target, beforePress) { fileMenu(target, ['Close Selected PDF Document', 'Close'], beforePress, request.refuseDialogs); },
        activate: function (target) {
          if (clock && clock.check) clock.check();
          var pidRef = Ref();
          if (Number($.AXUIElementGetPid(target, pidRef)) !== 0) throw new Error('Document activation lost the app identity');
          var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pidRef[0]));
          if (running.isNil() || !running.activateWithOptions(0)) throw new Error('Owned document app activation failed');
          clock.emit({ stage: 'foreground-fallback', foregroundFallback: true });
          waitForLaunch();
        },
      });
    },
    // A sheet among the window's children, or one the app's focused element sits in whose ancestry reaches this window or no
    // window at all. A sheet on another window is that window's. Single raw reads: an app that already quit has no sheet.
    hiddenSheet: function (app, window) {
      function raw(element, attribute) {
        if (clock && clock.check) clock.check();
        var value = Ref();
        return Number($.AXUIElementCopyAttributeValue(element, $(attribute), value)) === 0 ? ObjC.castRefToObject(value[0]) : null;
      }
      function role(element) { var value = raw(element, 'AXRole'); return value ? String(ObjC.unwrap(value)) : ''; }
      var kids = window && raw(window, 'AXChildren');
      if (kids) for (var index = 0; index < Number(kids.count); index++) if (role(kids.objectAtIndex(index)) === 'AXSheet') return kids.objectAtIndex(index);
      var node = raw(app, 'AXFocusedUIElement'), sheet = null;
      for (var depth = 0; node && depth < 12 && !sheet; depth++) {
        if (role(node) === 'AXSheet') sheet = node;
        else node = raw(node, 'AXParent');
      }
      if (!sheet) return null;
      for (var up = raw(sheet, 'AXParent'), level = 0; up && level < 12; up = raw(up, 'AXParent'), level++) {
        if (window && $.CFEqual(up, window)) return sheet;
        if (role(up) === 'AXWindow') return null;
      }
      return sheet;
    },
    discardable: function (window, request, app) { return fixtureDiscardSheet(window, request, promptApi, app); },
    discard: function (window, validate, request, app) {
      if (request && request.refuseDialogs) {
        if (discardedWindows.some(function (answered) { return equal(answered, window); })) return true;
        var prompt = fixtureDiscardPrompt(window, request, promptApi, app);
        if (!prompt) {
          if (!attachedSheets(window, app, promptApi).sheets.length) return;
          throw new Error('Unexpected owned fixture sheet; cleanup refused');
        }
        var discardButton = discardButtons(prompt.sheet, promptApi, prompt.discardTitles);
        if (discardButton.length !== 1) throw new Error('Unexpected owned fixture sheet; cleanup refused');
        if (validate) validate();
        var current = this.discardable(window, request, app);
        if (!current || !$.CFEqual(prompt.sheet, current)) throw new Error('Owned fixture sheet identity changed');
        var pressed = text(discardButton[0], 'AXTitle');
        press(discardButton[0]);
        discardedWindows.push(window);
        if (clock && clock.emit) clock.emit({ stage: 'fixture-sheet', fixtureSheet: { pressed: pressed, source: prompt.source,
          windowTitle: prompt.windowTitle, buttons: prompt.buttons } });
        return true;
      }
      var sheets = children(window, 'AXSheets');
      if (!sheets.length) return;
      if (sheets.length !== 1) throw new Error('Unexpected owned fixture sheets');
      var plain = buttons(sheets[0], DISCARD_TITLES, 6);
      if (plain.length !== 1) throw new Error('Unexpected owned fixture sheet; cleanup refused');
      if (validate) validate();
      press(plain[0]);
    },
  };
  return api;
}

function run(argv) {
  var request = JSON.parse(argv[0]);
  function free() { if (request.stopOnLiveHold === true && $.NSFileManager.defaultManager.fileExistsAtPath('/tmp/sleight-hold')) throw new Error('Live hold exists; fixture stopped'); }
  free();
  if (request.mode === 'self-test') {
    var terminated = false;
    var fake = { processIdentifier: 42, bundleIdentifier: $('com.apple.Preview'),
      get terminate() { terminated = true; return true; } };
    return JSON.stringify({ quit: quitFixtureApplication(42, 'com.apple.Preview', function () {
      return terminated ? null : fake;
    }, { now: function () { return 0; }, wait: function () {}, emit: function () {} }), path: request.path ? String(ObjC.unwrap($.NSURL.fileURLWithPath(request.path).URLByResolvingSymlinksInPath.path)) : undefined });
  }
  if (request.bundle === 'com.apple.Safari' && ['quit', 'recover'].indexOf(request.mode) === -1) throw new Error('Safari setup requires the profile-proven created-window helper');
  var allowed = ['com.apple.Safari', 'com.apple.Preview', 'com.apple.finder',
    'com.apple.TextEdit', 'com.apple.calculator', 'com.apple.Chess', 'com.apple.dt.Devices', 'com.apple.iphonesimulator', 'net.imput.helium',
    'com.microsoft.Word', 'com.microsoft.Excel', 'com.microsoft.Powerpoint', 'com.apple.mail', 'com.apple.iWork.Numbers'];
  var webFixture = request.fixtureKind === 'web-page' && /^http:\/\/127\.0\.0\.1:[1-9]\d*\/[A-Za-z0-9_-]{1,80}\/$/.test(request.target || '');
  if (request.mode === 'recover') {
    if (allowed.indexOf(request.bundle) === -1 || request.bundle === 'com.apple.finder' || !$.AXIsProcessTrusted()) throw new Error('Invalid fixture recovery request');
    var recoveryClock = { check: free, now: function () { return Date.now(); }, wait: function (ms) { free(); waitForLaunch(ms / 1000); }, emit: emit };
    var recovered = recoverFixtureApplications(request, nativeAX({ cleanup: true, bundle: request.bundle }, recoveryClock), recoveryClock);
    emit({ stage: 'recovered', pids: recovered.pids, processes: recovered.processes });
    return true;
  }
  if (request.mode === 'quit') {
    if ((allowed.indexOf(request.bundle) === -1 && !webFixture) || request.bundle === 'com.apple.finder' || !(request.pid > 0)) throw new Error('Invalid launched app quit request');
    var quitClock = { check: free, now: function () { return Date.now(); }, wait: function (ms) { free(); waitForLaunch(ms / 1000); }, emit: emit,
      startedAtMs: Number(request.processStartedAtMs) || 0,
      windowless: function () { return windowlessProcess(request.pid); },
      sameApp: function (target, bundle) {
        var url = target.bundleURL, expected = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(bundle);
        if (!url || url.isNil() || !expected || expected.isNil()) return false;
        return ObjC.unwrap(url.URLByResolvingSymlinksInPath.path) === ObjC.unwrap(expected.URLByResolvingSymlinksInPath.path);
      } };
    if (/^com\.microsoft\.(Word|Excel)$/.test(request.bundle) && request.fixture && quitClock.startedAtMs > 0) {
      quitClock.prepareDiscard = function (validateProcess) {
        if (!$.AXIsProcessTrusted()) throw new Error('Accessibility is unavailable; Office quit sheet refused');
        var quitApi = nativeAX({ cleanup: true, bundle: request.bundle }, Object.assign({}, quitClock, { check: validateProcess }));
        return prepareOfficeQuitDiscard(request.fixture, quitApi.app({ processIdentifier: request.pid }), quitApi);
      };
    }
    return quitFixtureApplication(request.pid, request.bundle, function () {
      var value = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
      return value.isNil() || value.isTerminated ? null : value;
    }, quitClock);
  }
  if ((allowed.indexOf(request.bundle) === -1 && !webFixture) || !request.control || !request.mode || (webFixture && request.mode !== 'window')) throw new Error('Invalid fixture request');
  if (!$.AXIsProcessTrusted()) throw new Error('Accessibility is unavailable; fixture not opened');
  function emit(value) {
    if (state && value.stage === 'finder-relaunch') state.finderRecoveryPending = true;
    if (state && value.stage === 'finder-recovered') state.finderRecoveryPending = false;
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  }
  function controlData() {
    free();
    var data = $.NSData.dataWithContentsOfFile(request.control);
    if (data.isNil()) {
      if (request.bundle === 'com.apple.finder' && state && state.setup) throw new Error('Finder setup control unavailable');
      return {};
    }
    var string = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    var control;
    try { control = JSON.parse(ObjC.unwrap(string)); } catch (error) {}
    if (!control || typeof control.command !== 'string') {
      if (request.bundle === 'com.apple.finder' && state && state.setup) throw new Error('Finder setup control unavailable');
      return {};
    }
    return control;
  }
  function command() { return controlData().command || ''; }
  function application() {
    free();
    var matches = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.bundle);
    // During a launch handoff the original and its successor can both be listed for a moment:
    // keep the original until it exits rather than failing setup.
    if (Number(matches.count) === 2 && state.setup && pid && !running && controlData().launched === true) {
      for (var i = 0; i < 2; i++) if (runningPid(matches.objectAtIndex(i)) === pid) return matches.objectAtIndex(i);
    }
    if (Number(matches.count) > 1) throw new Error('Ambiguous fixture process');
    return Number(matches.count) === 1 ? matches.objectAtIndex(0) : null;
  }
  var state = { bundle: request.bundle, setup: true, fresh: false, fixtureExists: false, actionTaken: false, retryWaitMs: 0, refuseDialogs: request.refuseDialogs === true };
  var clock = { check: function () { free(); if (state.setup) checkOpening(); }, now: function () { return Date.now(); }, wait: function (ms) { free(); waitForLaunch(ms / 1000); }, emit: emit,
    cleanupRequested: function () { return command() === 'close'; } };
  var api = nativeAX(state, clock);
  var target, running, pid, app, previous, owned, observedDialogs = [];
  var pids = [], processHandoff, processStartedAtMs, handoffPending = false, launchStarted = clock.now();
  function processStart(value) {
    var date = value && value.launchDate;
    return date && !date.isNil() ? Number(date.timeIntervalSince1970) * 1000 : null;
  }
  function recordProcess(value) {
    var nextPid = runningPid(value);
    if (!(nextPid > 0) || pid === nextPid) return;
    if (pid) {
      if (!state.setup || running || controlData().launched !== true || processHandoff || owned || state.actionTaken ||
        String(ObjC.unwrap(value.bundleIdentifier)) !== request.bundle) throw new Error('Fixture process changed');
      var original = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      // DeviceHub listed its successor while the original was still exiting (2026-10-10 10:31 UTC):
      // wait for the original to exit, within setup's own limits, rather than refusing the handoff.
      if (!original.isNil() && !original.isTerminated) { handoffPending = true; return; }
      // Adopt only a successor launched after this setup began, never an app someone opened before.
      var launched = value.launchDate;
      if (launched.isNil() || Number(launched.timeIntervalSince1970) * 1000 < launchStarted) throw new Error('Fixture successor predates this launch');
      processHandoff = { fromPid: pid, toPid: nextPid, elapsedMs: clock.now() - launchStarted };
      handoffPending = false;
      previous = null;
    }
    pid = nextPid;
    processStartedAtMs = processStart(value);
    // A recent launchDate alone proves nothing: only an earlier cold-launch
    // lease in this run can supply the exact process receipt.
    state.launchedByRun = processStartedAtMs > 0 && (request.launchedProcesses || []).some(function (process) {
      return process.pid === pid && process.bundle === request.bundle && runningBundle(value) === request.bundle &&
        process.processStartedAtMs === processStartedAtMs;
    });
    pids.push(pid);
    emit({ stage: processHandoff ? 'process-handoff' : 'identified-process', pid: pid,
      bundle: runningBundle(value) || request.bundle, processStartedAtMs: processStartedAtMs,
      pids: pids.slice(), processHandoff: processHandoff });
  }
  function checkOpening() {
    var control = controlData();
    if (control.command !== 'close' && control.cancelled !== true) return;
    // Ordinary cancellation may coincide with the launcher's exit. Record only
    // an eligible owned successor before ending setup, without any AX action.
    if (control.launched === true && !running) {
      var current = application();
      if (current) recordProcess(current);
    }
    throw new Error('Fixture opening interrupted before identity was recorded');
  }
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
  state.setupCase = running ? 'already-running' : 'cold-launch';
  state.office = ['com.microsoft.Word', 'com.microsoft.Excel', 'com.microsoft.Powerpoint'].indexOf(request.bundle) !== -1;
  if (request.bundle === 'com.apple.finder') {
    target = ensureFinderAX({ application: application, probe: probeFinderAX }, Object.assign({}, clock, { check: checkOpening }));
    running = true;
    state.setupCase = 'already-running';
  }
  if (webFixture || request.bundle === 'com.apple.Safari') {
    emit({ stage: 'launch', running: running });
    target = waitForApplication(application, waitForLaunch);
  }
  if (target) {
    recordProcess(target); app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    if (!state.office || running) previous = api.focused(app);
  }
  emit({ stage: 'identified', running: running, pid: pid, setupCase: state.setupCase });
  if (!state.office || running) checkAppDialog();
  checkOpening();
  if (webFixture || request.bundle === 'com.apple.Safari') {
    if (!target) {
      emit({ stage: 'untouched' });
      throw new Error('Browser process did not finish launching within ten seconds');
    }
    api.fileMenu(app, ['New Window']);
    for (var newTry = 0; newTry < 30; newTry++) {
      owned = api.focused(app);
      if (owned && !api.equal(owned, previous)) { state.fixtureExists = true; break; }
      owned = null; api.wait();
    }
    if (!owned) throw new Error('New browser fixture window unconfirmed');
  }
  emit({ stage: 'armed', running: running, pid: pid });
  var inherited = request.mode === 'inherit';
  while (command() !== 'opened') {
    checkOpening();
    // A launch can open the app, then fail before its remaining setup finishes.
    // Record that process while launch is pending, before cleanup can interrupt it.
    if (command() === 'launching') {
      target = application();
      if (target) recordProcess(target);
    }
    waitForLaunch();
  }
  if (request.bundle === 'com.apple.finder' && request.mode === 'folder') {
    owned = openFinderFolder(request, app, previous, api, Object.assign({}, clock, { check: checkOpening }), function (window) {
      owned = window;
      state.fixtureExists = true;
    });
  }
  function probeReadiness(attempt) {
    checkOpening();
    target = application();
    if (!target) return false;
    recordProcess(target);
    if (handoffPending) return false; // the original is still exiting: not ready, and never ready on it
    app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    checkAppDialog();
    if (inherited) {
      var control = controlData();
      var condition = inheritReadyCondition(target, app, api, control);
      if (attempt === 0 || attempt === 199) emit({ stage: 'readiness', readiness: {
        finished: !!target.isFinishedLaunching,
        simulatorBooted: !!(control && control.simulatorBooted === true),
        pid: pid, inheritReady: condition || null,
      } });
      if (condition) { state.inheritReady = condition; return true; }
      return false;
    }
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
      if (inherited && target) waitForLaunch();
      else api.wait();
    }
  }
  if (!applicationReady) throw new Error('Fixture application readiness unconfirmed');
  if (!inherited && !owned) throw new Error('Fixture identity could not be established without a window inventory');
  if (!inherited && !api.matches(owned, request)) throw new Error('Fixture document identity unconfirmed');
  if (request.placement && !inherited) {
    var placement = placeFixtureWindow(owned, request.placement, api);
    if (!api.matches(owned, request)) throw new Error('Fixture document identity unconfirmed');
    emit({ stage: 'placement', placement: placement });
  }
  var fixtureWindow = !inherited && request.mode === 'document' && api.retain ? api.retain(owned, request, app) : null;
  emit({ stage: 'ready', pid: pid, pids: pids.slice(), processHandoff: processHandoff, fixtureWindow: fixtureWindow,
    processStartedAtMs: processStartedAtMs,
    inheritReady: state.inheritReady, bundle: runningBundle(target) || request.bundle,
    fresh: state.fresh, totalWaitMs: state.retryWaitMs, setupCase: state.setupCase });
  state.setup = false;
  while (command() !== 'close') {
    state.observation = {};
    try { checkAppDialog(); } finally {
      if (clock.cleanupRequested()) beginCleanup(state);
      state.observation = null;
    }
    api.wait();
  }
  beginCleanup(state);
  checkAppDialog();
  target = cleanupTarget(application(), pid, request.bundle, function (value) {
    var found = $.NSRunningApplication.runningApplicationWithProcessIdentifier(value);
    return found.isNil() || found.isTerminated ? null : found;
  });
  if (target && runningPid(target) !== pid && runningPid(target) !== -1) throw new Error('Fixture process changed before cleanup');
  if (target && state.launchedByRun && processStart(target) !== processStartedAtMs) throw new Error('Fixture process changed before cleanup');
  if (target && !inherited) closeOwnedWindow(owned, request, app, api);
  emit(target || inherited ? { stage: 'closed' } : { stage: 'closed', appAbsent: true, pid: pid });
  } catch (error) {
    var finderFailure = request.bundle === 'com.apple.finder' ? finderStaticFailure(error) : undefined;
    if (state.setup) {
      state.setup = false;
      state.cleanup = true;
      var cleanup, cleanupError = error.menuCleanupError, finderCleanupFailure = request.bundle === 'com.apple.finder' ? {} : undefined;
      try {
        cleanup = error.appDialog ? 'unconfirmed' : request.bundle === 'com.apple.finder' && !state.finderRecoveryPending && !state.actionTaken && !owned && !error.finderWindowRequested
          ? 'nothing created' : recoverSetup(owned, request, api, app, finderCleanupFailure);
      } catch (failure) {
        if (finderCleanupFailure) finderCleanupFailure = finderStaticFailure(failure);
        cleanupError = [cleanupError, failure.message].filter(Boolean).join('; ');
      }
      emit({ stage: 'setup-failure', fresh: state.fresh, running: running, setupCase: state.setupCase, actionTaken: state.actionTaken, pid: pid,
        pids: pids.slice(), processHandoff: processHandoff, cleanup: cleanup, cleanupError: cleanupError,
        finderFailure: finderFailure, finderCleanupFailure: finderCleanupFailure && finderCleanupFailure.failureReason ? finderCleanupFailure : undefined,
        finderMenuCleanupFailure: request.bundle === 'com.apple.finder' ? error.finderMenuCleanupFailure : undefined,
        finderAXError: request.bundle === 'com.apple.finder' && (error.finderAX || [-25204, -25205].indexOf(error.code) !== -1)
          ? { code: error.code, attribute: error.attribute, identityReason: error.identityReason } : undefined,
        totalWaitMs: state.retryWaitMs, readWait: state.readWait, launchWait: state.launchWait });
    } else if (finderFailure) emit({ stage: 'finder-failure', finderFailure: finderFailure,
      finderCleanupFailure: state.cleanup ? finderFailure : undefined,
      finderMenuCleanupFailure: error.finderMenuCleanupFailure });
    throw error;
  }
}
