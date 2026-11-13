import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const target = { appId: 'com.apple.TextEdit' };
const healthSource = readFileSync(new URL('../../plugins/sleight/lib/app-health.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
export function inspect(request, numbers, focused = 1, cg = false, events = [], setup = () => {}) {
  const list = values => ({ count: values.length, objectAtIndex: i => values[i],
    filteredArrayUsingPredicate: ({ format, args }) => {
      events.push(['predicate', format, ...args]);
      if (runtime.predicateThrows) throw Error('private predicate error');
      return list(values.filter(row => row.info.kCGWindowOwnerPID === args[0] &&
        (row.info.kCGWindowLayer == null || (row.info.kCGWindowLayer >= 0 && row.info.kCGWindowLayer <= 23))));
    } });
  const windows = numbers.map((AXWindowNumber, i) => ({ AXTitle: 'Untitled', AXDocument: null, AXWindowNumber,
    AXPosition: { x: i * 400, y: 20 }, AXSize: { width: 300, height: 200 } }));
  const app = { AXWindows: list(windows), AXFocusedWindow: windows[focused], AXChildren: list([]) };
  const running = { processIdentifier: 123, bundleIdentifier: target.appId, terminated: false,
    launchDate: { timeIntervalSince1970: 1 }, isNil: () => false };
  const runtime = { running, apps: [running], trusted: true, timeoutError: 0, cgWindows: [], spaces: {}, connection: 7 };
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
    CGWindowListCopyWindowInfo: options => { events.push(['cg', options]); return runtime.cgUnavailable ? null : list(cg ? windows.map((window, i) => ({ kCGWindowOwnerPID: 123, kCGWindowLayer: 0,
      kCGWindowNumber: 11 + i, kCGWindowBounds: { X: window.AXPosition.x, Y: 20, Width: 300, Height: 200 } })) :
      runtime.cgWindows.map(info => ({ info, objectForKey: key => { events.push(key); return info[key]; } }))); } });
  return JSON.parse(runInNewContext(`(() => {
    const identity = (function () { ${healthSource}; return (function () { ${source}; return run; })(); })();
    if (runtime.seedWindowIdentity) {
      const baseline = JSON.parse(identity([JSON.stringify({ appId: request.appId, title: 'Untitled', url: null, windowNumber: ${numbers[0] ?? 'undefined'} })]));
      if (baseline.status !== 'ok' || baseline.matches !== 1) throw new Error('Fixture baseline failed: ' + JSON.stringify(baseline));
      request = { ...request, nativeIdentity: { ...request.nativeIdentity, ...baseline } };
      runtime.afterBaseline?.();
    }
    return identity([JSON.stringify(request)]);
  })()`, { $, request, runtime, Ref: () => [],
    Date: { now: () => runtime.clockMs ?? Date.now() },
    ObjC: { import() {}, bindFunction(name) {
      if (runtime.bindThrows) throw Error('private missing symbol');
      $[name] = nativeSymbols[name];
    }, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value } }));
}
