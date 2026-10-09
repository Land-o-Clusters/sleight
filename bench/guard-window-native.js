// Research prototype: fresh AX metadata with retained window identity, no input or permission prompt.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
const identities = [];
function identity(window) {
  for (let i = 0; i < identities.length; i++) if ($.CFEqual(identities[i], window)) return i + 1;
  identities.push(window);
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
function observe(appId) {
  if (!$.AXIsProcessTrusted()) return { status: 'denied' };
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(appId);
  if (Number(apps.count) !== 1) return { status: Number(apps.count) === 0 ? 'absent' : 'ambiguous', count: Number(apps.count) };
  const running = apps.objectAtIndex(0), pid = Number(running.processIdentifier);
  const app = $.AXUIElementCreateApplication(pid);
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.1)) !== 0) return { status: 'unknown' };
  const window = attr(app, 'AXFocusedWindow');
  const title = scalar(attr(window, 'AXTitle')), document = scalar(attr(window, 'AXDocument', true));
  const role = scalar(attr(window, 'AXRole')), subrole = scalar(attr(window, 'AXSubrole', true));
  const modal = scalar(attr(window, 'AXModal', true)), sheets = attr(window, 'AXSheets', true);
  const children = attr(window, 'AXChildren', true);
  let overlay = modal === true || role === 'AXSheet' || subrole === 'AXDialog' || Number(sheets?.count ?? 0) > 0;
  for (let i = 0; children && i < children.count; i++) {
    const child = children.objectAtIndex(i), role = scalar(attr(child, 'AXRole'));
    if (role === 'AXSheet' || role === 'AXDialog') overlay = true;
  }
  if (!$.CFEqual(window, attr(app, 'AXFocusedWindow'))) return { status: 'changed' };
  return { status: 'ok', pid, appId, app: ObjC.unwrap(running.localizedName),
    processStart: Number(running.launchDate.timeIntervalSince1970), window: identity(window),
    title, document, role, subrole, overlay, modal, sheets: sheets === null ? null : Number(sheets.count) };
}
function answer(request) {
  const start = Date.now();
  try { return { id: request.id, ...observe(request.appId), nativeMs: Date.now() - start }; }
  catch (error) { return { id: request.id, status: 'unknown', error: String(error.message || error), nativeMs: Date.now() - start }; }
}
function run(argv) {
  if (argv.length) return JSON.stringify(answer(JSON.parse(argv[0])));
  const stdin = $.NSFileHandle.fileHandleWithStandardInput, stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  let buffer = '';
  for (;;) {
    const data = stdin.availableData;
    if (Number(data.length) === 0) break;
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const response = JSON.stringify(answer(JSON.parse(line))) + '\n';
      stdout.writeData($(response).dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
}
