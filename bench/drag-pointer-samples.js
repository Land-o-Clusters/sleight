// Read-only observation during a locked drag run. No app activation or warp.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv) {
  const samples = [], end = Date.now() + Number(argv[0]);
  while (Date.now() < end) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.01));
    const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    samples.push({ t: Date.now(), pointer: $.CGEventGetLocation($.CGEventCreate(null)), frontPid: app.processIdentifier });
    delay(0.01);
  }
  return JSON.stringify(samples);
}
