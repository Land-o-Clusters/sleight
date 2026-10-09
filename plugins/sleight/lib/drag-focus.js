// The launcher keeps this snapshot outside drag.js, whose process can time out.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    if (request.op === 'release') {
      // A drag.js killed between its posted press and release leaves the left button down
      // for the session while the hardware button is up. Only that mismatch is ours to undo.
      const posted = $.CGEventSourceButtonState(0, 0), physical = $.CGEventSourceButtonState(1, 0);
      if (!posted || physical) return JSON.stringify({ ok: true, released: false });
      const where = $.CGEventGetLocation($.CGEventCreate(null));
      $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, where, $.kCGMouseButtonLeft));
      return JSON.stringify({ ok: true, released: true });
    }
    const ws = $.NSWorkspace.sharedWorkspace;
    if (request.op === 'capture') {
      const apps = ws.runningApplications;
      for (let i = 0; i < apps.count; i++) {
        const app = apps.objectAtIndex(i);
        const url = app.bundleURL;
        const path = url && !url.isNil() ? ObjC.unwrap(url.path) : null;
        if ([ObjC.unwrap(app.localizedName), ObjC.unwrap(app.bundleIdentifier), path].includes(request.app)) {
          const previous = ws.frontmostApplication;
          return JSON.stringify({ ok: true, targetPid: app.processIdentifier, previousPid: previous && !previous.isNil() ? previous.processIdentifier : null });
        }
      }
      throw new Error(`${request.app} isn't running; nothing was pressed`);
    }
    if (request.op !== 'restore') throw new Error('invalid focus operation');
    const current = ws.frontmostApplication;
    // A user or another app taking focus during the timeout wins. Restore only
    // while the drag target is still in front, using the captured process ID.
    if (request.previousPid && request.previousPid !== request.targetPid && current && !current.isNil() && current.processIdentifier === request.targetPid) {
      const previous = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.previousPid);
      if (!previous || previous.isNil() || !previous.activateWithOptions(0)) throw new Error('could not restore the previous front app');
    }
    return JSON.stringify({ ok: true });
  } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); }
}
