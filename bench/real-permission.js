// Read titles only, from macOS's authorization process. No body, buttons,
// screenshots, Apple Events, or windows belonging to any browser are read.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function run(argv) {
  if (!/^[1-9][0-9]*$/.test(argv[0])) throw new Error('Invalid authorization PID');
  if (!$.AXIsProcessTrusted()) throw new Error('Authorization titles need existing Accessibility access');
  var pid = Number(argv[0]);
  var target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (target.isNil() || ObjC.unwrap(target.bundleIdentifier) !== 'com.apple.UserNotificationCenter') {
    return JSON.stringify({ titles: [] });
  }
  var app = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetMessagingTimeout(app, 0.5);
  function read(element, attribute) {
    var value = Ref();
    var code = Number($.AXUIElementCopyAttributeValue(element, $(attribute), value));
    if (code === -25205 || code === -25212) return null;
    if (code !== 0) throw new Error('Authorization title read failed: ' + code);
    return ObjC.castRefToObject(value[0]);
  }
  var windows = read(app, 'AXWindows'), titles = [];
  if (windows) for (var index = 0; index < Number(windows.count); index++) {
    var title = read(windows.objectAtIndex(index), 'AXTitle');
    titles.push(title ? String(ObjC.unwrap(title)) : '(untitled)');
  }
  return JSON.stringify({ titles: titles });
}
