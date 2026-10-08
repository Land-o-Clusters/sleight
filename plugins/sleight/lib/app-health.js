// Read one process's AXWindows with a native 500 ms messaging deadline.
// No System Events, activation, approval changes or permission prompts.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function run(argv) {
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ status: 'denied' });
  const selector = JSON.parse(argv[0]);
  if (typeof selector !== 'string' || !selector) return JSON.stringify({ status: 'unknown' });
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  let target;
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    if ([ObjC.unwrap(app.localizedName), ObjC.unwrap(app.bundleIdentifier), ObjC.unwrap(app.bundleURL.path)]
      .some(value => typeof value === 'string' && value.toLowerCase() === selector.toLowerCase())) {
      if (target) return JSON.stringify({ status: 'unknown' });
      target = app;
    }
  }
  if (!target) return JSON.stringify({ status: 'absent' });
  const pid = Number(target.processIdentifier), app = $.AXUIElementCreateApplication(pid);
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) return JSON.stringify({ status: 'unknown' });
  const value = Ref();
  const error = Number($.AXUIElementCopyAttributeValue(app, $('AXWindows'), value));
  if (error !== 0) return JSON.stringify({ status: error === -25204 ? 'timeout' : error === -25211 ? 'denied' : 'unknown', error, pid });
  const windows = ObjC.castRefToObject(value[0]);
  return JSON.stringify({ status: 'responding', pid, windows: Number(windows.count) });
}
