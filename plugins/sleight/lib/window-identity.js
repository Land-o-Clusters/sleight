// Read-only AX identity, retained inside the existing lazy target helper. Never requests trust.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
const windowEpoch = ObjC.unwrap($.NSUUID.UUID.UUIDString);
const windowReferences = [];
function run(argv) {
  try {
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility is unavailable');
    const request = JSON.parse(argv[0]);
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.appId);
    if (Number(apps.count) !== 1) throw new Error('Expected one running app');
    const running = apps.objectAtIndex(0), pid = Number(running.processIdentifier);
    const app = $.AXUIElementCreateApplication(pid);
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.1)) !== 0) throw new Error('AX deadline unavailable');
    const attr = (element, name, optional = false) => {
      const value = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
      if (optional && [-25205, -25212].includes(error)) return null;
      if (error) throw new Error(name + ' unavailable');
      return ObjC.castRefToObject(value[0]);
    };
    const scalar = value => value === null ? null : ObjC.deepUnwrap(value);
    const windows = attr(app, 'AXWindows'), matches = [];
    if (Number(windows.count) > 64) throw new Error('Too many windows');
    for (let i = 0; i < Number(windows.count); i++) {
      const window = windows.objectAtIndex(i);
      if (scalar(attr(window, 'AXTitle')) === request.title && scalar(attr(window, 'AXDocument', true)) === request.url) matches.push(window);
    }
    if (matches.length !== 1) return JSON.stringify({ status: 'ok', matches: matches.length,
      appId: request.appId, title: request.title, url: request.url, epoch: windowEpoch, window: 0,
      pid, processStart: Number(running.launchDate.timeIntervalSince1970) });
    const window = matches[0];
    // A unique header must also describe the app's focused window. Otherwise the engine's handle
    // and Accessibility disagree about which window a background input would reach.
    if (!$.CFEqual(window, attr(app, 'AXFocusedWindow'))) throw new Error('Focused window differs');
    let index = windowReferences.findIndex(other => $.CFEqual(other, window));
    if (index < 0) {
      if (windowReferences.length >= 1024) throw new Error('Window identity capacity reached');
      index = windowReferences.push(window) - 1;
    }
    return JSON.stringify({ status: 'ok', matches: 1, appId: request.appId, title: request.title,
      url: request.url, epoch: windowEpoch, window: index + 1, pid,
      processStart: Number(running.launchDate.timeIntervalSince1970) });
  } catch (error) { return JSON.stringify({ status: 'unknown', error: String(error.message || error) }); }
}
