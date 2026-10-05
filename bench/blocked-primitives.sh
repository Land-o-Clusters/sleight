#!/bin/sh
# One pass over the JXA primitives the blocked-app driver relies on, against
# Calculator (a benchmark-allowlist app, running, harmless to read). Holds the
# shared live lock for the run and releases it on exit. Prints one JSON line
# per primitive.
set -eu
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT

PID=$(osascript -e 'tell application "System Events" to unix id of process "Calculator"')
echo "{\"calculatorPid\": $PID}"
osascript -l JavaScript - "$PID" <<'EOF'
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
function out(label, value) { return label + ': ' + JSON.stringify(value); }
function run(argv) {
  const pid = Number(argv[0]);
  const se = Application('System Events');
  const lines = [];
  const proc = se.processes.whose({ unixId: pid })[0];
  lines.push(out('whose-unixId', proc ? attemptName() : null));
  function attemptName() { try { return proc.name(); } catch (e) { return 'error ' + e.message; } }
  const win = proc.windows()[0];
  lines.push(out('window', win ? win.title() : null));
  const buttons = [];
  const walk = (el, depth) => {
    if (depth > 8 || buttons.length > 12) return;
    const role = (() => { try { return el.role(); } catch (e) { return ''; } })();
    if (role === 'AXButton') buttons.push((() => { try { return el.title(); } catch (e) { return ''; } })());
    const kids = (() => { try { return el.uiElements(); } catch (e) { return []; } })();
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk(win, 0);
  lines.push(out('ax-buttons', buttons.slice(0, 6)));
  lines.push(out('axpress-clear', (() => { try {
    const found = [];
    const find = (el, depth) => {
      if (found.length || depth > 8) return;
      const role = (() => { try { return el.role(); } catch (e) { return ''; } })();
      if (role === 'AXButton' && (() => { try { return el.title(); } catch (e) { return ''; } })() === 'Clear') { found.push(el); return; }
      const kids = (() => { try { return el.uiElements(); } catch (e) { return []; } })();
      for (const kid of kids) find(kid, depth + 1);
    };
    find(win, 0);
    if (!found.length) return 'no Clear button';
    const press = found[0].actions.byName('AXPress');
    press ? press.perform() : found[0].click();
    return 'pressed';
  } catch (e) { return 'error ' + e.message; } })()));
  lines.push(out('position-size', (() => { try { return { p: win.position(), s: win.size() }; } catch (e) { return 'error ' + e.message; } })()));
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  lines.push(out('frontmost', front.isNil() ? null : ObjC.unwrap(front.localizedName)));
  lines.push(out('activate', (() => { try {
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    for (let i = 0; i < apps.count; i++) {
      const a = apps.objectAtIndex(i);
      if (a.processIdentifier === pid) { a.activateWithOptions(0); delay(0.5); return 'activated'; }
    }
    return 'not found';
  } catch (e) { return 'error ' + e.message; } })()));
  lines.push(out('keystroke', (() => { try { se.keystroke('5'); return 'sent'; } catch (e) { return 'error ' + e.message; } })()));
  lines.push(out('keyCode', (() => { try { se.keyCode(18); return 'sent'; } catch (e) { return 'error ' + e.message; } })()));
  lines.push(out('scroll-post', (() => { try {
    const ev = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, -3);
    $.CGEventPostToPid(pid, ev);
    return 'posted';
  } catch (e) { return 'error ' + e.message; } })()));
  lines.push(out('screencapture', (() => { try {
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
    let id = null;
    for (let i = 0; i < list.count; i++) {
      const w = list.objectAtIndex(i);
      if (ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')) === pid && ObjC.unwrap(w.objectForKey('kCGWindowLayer')) === 0) { id = ObjC.unwrap(w.objectForKey('kCGWindowNumber')); break; }
    }
    if (!id) return 'no window id';
    const path = '/tmp/sleight-primitive-shot.png';
    const shell = Application.currentApplication();
    shell.includeStandardAdditions = true;
    shell.doShellScript(`/usr/sbin/screencapture -x -l ${id} "${path}"`);
    const fm = $.NSFileManager.defaultManager;
    return fm.fileExistsAtPath(path) ? 'saved' : 'no file';
  } catch (e) { return 'error ' + e.message; } })()));
  const ws = $.NSWorkspace.sharedWorkspace;
  const prev = ws.frontmostApplication;
  lines.push(out('restore-front', prev.isNil() ? 'none' : ObjC.unwrap(prev.localizedName)));
  return lines.join('\n');
}
EOF
