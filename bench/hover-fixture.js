// Checkpoint and restore the test's foreground and pointer, under the live lock.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    if (request.op === 'checkpoint') {
      const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      const pointer = $.CGEventGetLocation($.CGEventCreate(null));
      return JSON.stringify({ ok: true, pid: app.processIdentifier, app: ObjC.unwrap(app.bundleIdentifier), pointer });
    }
    // Test setup only, after the engine approval has passed through bench/approve.mjs.
    if (request.op === 'activate' && request.app === 'Calculator') {
      const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
      const found = [];
      for (let i = 0; i < apps.count; i++) {
        const app = apps.objectAtIndex(i);
        if (ObjC.unwrap(app.localizedName) === 'Calculator') found.push(app);
      }
      if (found.length !== 1) throw new Error('Calculator setup needs exactly one running app, found ' + found.length);
      const app = found[0];
      const activated = app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps | $.NSApplicationActivateAllWindows);
      if (!activated) throw new Error('Calculator refused foreground activation (pid ' + app.processIdentifier + ')');
      const deadline = Date.now() + 2000;
      while ($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !== app.processIdentifier && Date.now() < deadline) delay(0.1);
      const frontPid = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
      return JSON.stringify({ ok: frontPid === app.processIdentifier, app: 'Calculator', pid: app.processIdentifier,
        bundleId: ObjC.unwrap(app.bundleIdentifier), frontPid });
    }
    if (request.op !== 'restore' || !Number.isInteger(request.pid) || typeof request.app !== 'string' ||
        !Number.isFinite(request.pointer?.x) || !Number.isFinite(request.pointer?.y)) throw new Error('invalid checkpoint');
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
    if (app.isNil() || ObjC.unwrap(app.bundleIdentifier) !== request.app) throw new Error('original front app is gone');
    if ($.CGWarpMouseCursorPosition($.CGPointMake(request.pointer.x, request.pointer.y)) !== 0) throw new Error('pointer restore failed');
    if (!app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps | $.NSApplicationActivateAllWindows)) throw new Error('front restore failed');
    delay(0.1);
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    const pointer = $.CGEventGetLocation($.CGEventCreate(null));
    return JSON.stringify({ ok: true, frontRestored: front.processIdentifier === request.pid,
      pointerRestored: Math.abs(pointer.x - request.pointer.x) < 1 && Math.abs(pointer.y - request.pointer.y) < 1 });
  } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
}
