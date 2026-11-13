import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const healthSource = readFileSync(new URL('../../plugins/sleight/lib/app-health.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
export function inspect(request, numbers, focused = 1, cg = false, events = [], setup = () => {}, sources = {}) {
  const list = (values, cgList = false) => ({ count: values.length, objectAtIndex: i => {
    if (cgList) events.push('cg-row');
    return values[i];
  },
    filteredArrayUsingPredicate: ({ format, args }) => {
      events.push(['predicate', format, ...args]);
      if (runtime.predicateThrows) throw Error('private predicate error');
      assert.ok(format === 'kCGWindowOwnerPID == %@ AND (kCGWindowLayer == nil OR kCGWindowLayer == 0)' ||
        format === 'kCGWindowOwnerPID == %@ AND (kCGWindowLayer == nil OR (kCGWindowLayer >= 0 AND kCGWindowLayer <= 23))');
      return list(values.filter(row => row.info.kCGWindowOwnerPID === args[0] &&
        (row.info.kCGWindowLayer == null || (format.includes('<= 23')
          ? row.info.kCGWindowLayer >= 0 && row.info.kCGWindowLayer <= 23 : row.info.kCGWindowLayer === 0))), cgList);
    } });
  const windows = numbers.map((AXWindowNumber, i) => ({ AXTitle: 'Untitled', AXDocument: null, AXWindowNumber,
    AXPosition: { x: i * 400, y: 20 }, AXSize: { width: 300, height: 200 } }));
  const app = { AXWindows: list(windows), AXFocusedWindow: windows[focused], AXChildren: list([]) };
  const running = { processIdentifier: 123, bundleIdentifier: request.appId, terminated: false,
    launchDate: { timeIntervalSince1970: 1 }, isNil: () => false };
  const runtime = { running, apps: [running], trusted: true, timeoutError: 0, cgWindows: undefined, spaces: {}, connection: 7 };
  setup(app, windows, list, runtime);
  const $ = value => value;
  const nativeSymbols = {
    CGSMainConnectionID: () => runtime.connection,
    CGSCopySpacesForWindows: (cid, mask, ids) => {
      events.push(['spaces', cid, mask, ...ids]); runtime.onSpace?.();
      return runtime.spaces[ids[0]];
    },
  };
  Object.assign($, { NSPredicate: { predicateWithFormatArgumentArray: (format, args) => ({ format, args }) },
    NSUUID: { UUID: { UUIDString: 'epoch' } }, AXIsProcessTrusted: () => runtime.trusted,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list(runtime.apps),
      runningApplicationWithProcessIdentifier: pid => runtime.apps.find(item => item.processIdentifier === pid) },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout: () => runtime.timeoutError,
    AXUIElementCopyAttributeValue: (element, name, value) => { events.push(name); runtime.onRead?.(name); if (element.missing?.includes(name)) return -25212; value[0] = element[name] ?? null; return 0; },
    CFEqual: (a, b) => a === b, AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return !!value; },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { bytes, mutableBytes: bytes }; } },
    NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
    CGEventSourceSecondsSinceLastEventType: (source, type) => { events.push('hid'); assert.equal(source, 1); assert.equal(type, 0xFFFFFFFF); return 12.5; },
    kCGWindowListOptionAll: 0, kCGWindowListExcludeDesktopElements: 16,
    CGWindowListCopyWindowInfo: options => {
      events.push(['cg', options]);
      if (runtime.cgUnavailable) return null;
      const rows = runtime.cgWindows ?? (request.closeCount && (!runtime.seedWindowIdentity || runtime.baselineSeeded) ? [] : windows.flatMap((window, i) =>
        cg || Number.isSafeInteger(window.AXWindowNumber) && window.AXWindowNumber > 0 ? [{ kCGWindowOwnerPID: runtime.running.processIdentifier,
          kCGWindowLayer: 0, kCGWindowNumber: runtime.cgNumber ?? (cg ? 11 + i : window.AXWindowNumber),
          kCGWindowName: runtime.cgTitle ?? window.AXTitle,
          kCGWindowBounds: { X: window.AXPosition.x, Y: window.AXPosition.y, Width: window.AXSize.width, Height: window.AXSize.height } }] : []));
      return { ...list(rows.map(info => ({ ...info, info, objectForKey: key => { events.push(key); return info[key]; } })), true),
        ...(runtime.cgListShape ?? {}) };
    } });
  return JSON.parse(runInNewContext(`(() => {
    const identity = (function () { ${sources.healthSource ?? healthSource}; return (function () { ${sources.source ?? source}; return run; })(); })();
    if (runtime.seedWindowIdentity) {
      const baseline = JSON.parse(identity([JSON.stringify({ appId: request.appId, title: 'Untitled', url: null, windowNumber: ${JSON.stringify(numbers[0]) ?? 'undefined'} })]));
      if (baseline.status !== 'ok' || baseline.matches !== 1) throw new Error('Fixture baseline failed: ' + JSON.stringify(baseline));
      request = { ...request, nativeIdentity: { ...request.nativeIdentity, ...baseline } };
      runtime.baselineSeeded = true;
      runtime.afterBaseline?.();
    }
    return identity([JSON.stringify(request)]);
  })()`, { $, request, runtime, Ref: () => [],
    Date: { now: () => runtime.clockMs ?? Date.now() },
    ObjC: { import() {}, bindFunction(name) {
      if (runtime.bindThrows) throw Error('private missing symbol');
      $[name] = nativeSymbols[name];
    }, unwrap: value => value?.boxedScalar ?? value,
    deepUnwrap: value => value?.boxedScalar ?? value?.info ?? value, castRefToObject: value => value } }));
}
