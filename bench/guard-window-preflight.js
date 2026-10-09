// Read-only feasibility probe. AXIsProcessTrusted never asks for permission.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function run() {
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ status: 'denied', permissionRequested: false });
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.calculator');
  if (Number(apps.count) !== 1) return JSON.stringify({ status: Number(apps.count) === 0 ? 'absent' : 'ambiguous', permissionRequested: false });
  const pid = Number(apps.objectAtIndex(0).processIdentifier);
  const app = $.AXUIElementCreateApplication(pid);
  const deadline = Number($.AXUIElementSetMessagingTimeout(app, 0.1));
  if (deadline !== 0) return JSON.stringify({ status: 'unknown', error: deadline });
  const value = Ref();
  const error = Number($.AXUIElementCopyAttributeValue(app, $('AXFocusedWindow'), value));
  if (error !== 0) return JSON.stringify({ status: error === -25211 ? 'denied' : 'unknown', error });
  const window = ObjC.castRefToObject(value[0]);
  const read = name => {
    const result = Ref();
    const error = Number($.AXUIElementCopyAttributeValue(window, $(name), result));
    return error === 0 ? { value: ObjC.deepUnwrap(ObjC.castRefToObject(result[0])) } : { error };
  };
  return JSON.stringify({ status: 'ok', pid, title: read('AXTitle'), document: read('AXDocument'),
    role: read('AXRole'), subrole: read('AXSubrole'), windowNumber: read('AXWindowNumber') });
}
