// Research helper: fresh, read-only AX observations in a persistent JXA process.
// AXIsProcessTrusted checks existing permission without asking for a new one.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
const epoch = ObjC.unwrap($.NSUUID.UUID.UUIDString);
const identities = [];
function identity(window) {
  for (let i = 0; i < identities.length; i++) if ($.CFEqual(identities[i], window)) return i + 1;
  if (identities.length >= 1024) throw new Error('Window identity capacity reached');
  identities.push(window); // Retain the AX reference so a hash collision cannot identify a window.
  return identities.length;
}
function attr(element, name, optional = false) {
  const result = Ref();
  const error = Number($.AXUIElementCopyAttributeValue(element, $(name), result));
  if (error === 0) return ObjC.castRefToObject(result[0]);
  if (optional && (error === -25205 || error === -25212)) return null;
  throw new Error(name + ': AX error ' + error);
}
const scalar = value => value === null ? null : ObjC.deepUnwrap(value);
const dialog = (role, subrole) => role === 'AXSheet' || role === 'AXDialog' || ['AXDialog', 'AXSystemDialog'].includes(subrole);
function observe(appId) {
  if (!$.AXIsProcessTrusted()) return { status: 'denied' };
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(appId);
  if (Number(apps.count) !== 1) return { status: Number(apps.count) === 0 ? 'absent' : 'ambiguous' };
  const running = apps.objectAtIndex(0), pid = Number(running.processIdentifier);
  const app = $.AXUIElementCreateApplication(pid);
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.1)) !== 0) return { status: 'unknown' };
  const window = attr(app, 'AXFocusedWindow');
  const title = scalar(attr(window, 'AXTitle')), document = scalar(attr(window, 'AXDocument', true));
  const role = scalar(attr(window, 'AXRole')), subrole = scalar(attr(window, 'AXSubrole', true));
  const modal = scalar(attr(window, 'AXModal')), sheets = attr(window, 'AXSheets', true);
  const children = attr(window, 'AXChildren');
  if (Number(children.count) > 128) return { status: 'unknown' };
  let overlay = modal === true || dialog(role, subrole) || Number(sheets?.count ?? 0) > 0;
  for (let i = 0; i < Number(children.count); i++) {
    const child = children.objectAtIndex(i);
    if (dialog(scalar(attr(child, 'AXRole')), scalar(attr(child, 'AXSubrole', true)))) overlay = true;
  }
  const windows = attr(app, 'AXWindows');
  let matchingWindows = 0;
  if (Number(windows.count) > 64) return { status: 'unknown' };
  for (let i = 0; i < Number(windows.count); i++) {
    const other = windows.objectAtIndex(i);
    if ($.CFEqual(other, window)) { matchingWindows++; continue; }
    if (dialog(scalar(attr(other, 'AXRole')), scalar(attr(other, 'AXSubrole', true))) ||
      scalar(attr(other, 'AXModal')) === true) overlay = true;
    if (scalar(attr(other, 'AXTitle')) === title && scalar(attr(other, 'AXDocument', true)) === document) matchingWindows++;
  }
  if (!$.CFEqual(window, attr(app, 'AXFocusedWindow'))) return { status: 'changed' };
  if (typeof title !== 'string' || (document !== null && typeof document !== 'string') || typeof modal !== 'boolean') return { status: 'unknown' };
  return { status: 'ok', epoch, pid, appId, app: ObjC.unwrap(running.localizedName),
    path: ObjC.unwrap(running.bundleURL.path), processStart: Number(running.launchDate.timeIntervalSince1970),
    window: identity(window), title, document, role, subrole, overlay, matchingWindows };
}
function answer(request) {
  const start = Date.now();
  try {
    if (!Number.isSafeInteger(request.id) || typeof request.appId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(request.appId) || !Number.isFinite(request.expires)) return { status: 'invalid' };
    if (start >= request.expires) return { id: request.id, status: 'expired' };
    const result = observe(request.appId);
    return { id: request.id, ...(Date.now() >= request.expires ? { status: 'expired' } : result), nativeMs: Date.now() - start };
  } catch (error) { return { id: request.id, status: 'unknown', error: String(error.message || error), nativeMs: Date.now() - start }; }
}
function run(argv) {
  if (argv.length) return JSON.stringify(answer(JSON.parse(argv[0])));
  const stdin = $.NSFileHandle.fileHandleWithStandardInput, stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  let buffer = '';
  for (;;) {
    const data = stdin.availableData;
    if (Number(data.length) === 0) return '';
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    if (buffer.length > 4096) return '';
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let result;
      try { result = answer(JSON.parse(line)); } catch { result = { status: 'invalid' }; }
      stdout.writeData($(JSON.stringify(result) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
}
