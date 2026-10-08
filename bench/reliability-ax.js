ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function run(argv) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  if (!Number(apps.count)) return JSON.stringify({ status: 'absent' });
  const pid = Number(apps.objectAtIndex(0).processIdentifier);
  const app = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetMessagingTimeout(app, 0.5);
  const value = Ref();
  const error = $.AXUIElementCopyAttributeValue(app, $('AXWindows'), value);
  return JSON.stringify({ pid, error: Number(error), ref: String(value), first: String(value[0]), value: error === 0 ? ObjC.deepUnwrap(ObjC.castRefToObject(value[0])) : null });
}
