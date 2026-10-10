// Isolated, timeout-collected drag child. This probe never permits foreground fallback.
ObjC.import('AppKit');
function run(argv) {
  const request = JSON.parse(argv[0]);
  if (request.args.app !== 'TextEdit' || !Number.isInteger(request.args.windowId) ||
      Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) !== request.frontPid ||
      ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier) === 'com.apple.TextEdit') {
    throw new Error('Background fixture precondition changed; no drag attempted');
  }
  const guarded = eval('(function () { ' + request.source + '; waitForIdle = () => { throw new Error("Foreground disabled in this probe"); }; return run; })()');
  return guarded([JSON.stringify(request.args)]);
}
