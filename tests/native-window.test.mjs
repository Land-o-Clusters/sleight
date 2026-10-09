import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';

// The actual native program runs against an AX boundary, including error codes and CF identity.
function fixture({ trusted = true, changeFocus = false, documentError, sheetsError = -25205,
  childRole = 'AXGroup', modal = false, extraWindow, readError, appCount = 1 } = {}) {
  const first = { title: 'a.txt', document: 'file:///tmp/a.txt', identity: 41 };
  const second = { ...first, identity: 42 };
  let focused = first, reads = 0, inputs = 0;
  const array = xs => ({ count: String(xs.length), objectAtIndex: i => xs[i] });
  const $ = value => value;
  Object.assign($, {
    AXIsProcessTrusted: () => trusted,
    NSUUID: { UUID: { UUIDString: 'helper-epoch' } },
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => array(Array.from({ length: appCount }, () => ({
      processIdentifier: 12, localizedName: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit',
      launchDate: { timeIntervalSince1970: 100 }, bundleURL: { path: '/System/Applications/TextEdit.app' },
    }))) },
    AXUIElementCreateApplication: () => ({ app: true }),
    AXUIElementSetMessagingTimeout: () => 0,
    CFEqual: (a, b) => a.identity === b.identity,
    AXUIElementCopyAttributeValue: (el, key, out) => {
      reads++;
      if (readError === key) return -25204;
      if (key === 'AXFocusedWindow') { out[0] = focused; if (changeFocus) focused = second; return 0; }
      if (key === 'AXWindows') { out[0] = array(extraWindow ? [first, extraWindow] : [first]); return 0; }
      if (key === 'AXSheets' && sheetsError) return sheetsError;
      if (key === 'AXDocument' && documentError) return documentError;
      const values = { AXTitle: el.title, AXDocument: el.document, AXRole: el.child ? childRole : 'AXWindow',
        AXSubrole: el.subrole ?? 'AXStandardWindow', AXModal: modal, AXSheets: array([]),
        AXChildren: array([{ child: true }]) };
      out[0] = values[key]; return 0;
    },
    AXUIElementPerformAction: () => { inputs++; },
  });
  const context = { $, Ref: () => [], ObjC: { import() {}, unwrap: x => x, deepUnwrap: x => x, castRefToObject: x => x } };
  runInNewContext(readFileSync(new URL('../bench/guard-window-observer.js', import.meta.url), 'utf8'), context);
  return { read: () => JSON.parse(context.run([JSON.stringify({ id: 7, appId: 'com.apple.TextEdit', expires: Date.now() + 1000 })])),
    replace: () => { focused = second; }, get reads() { return reads; }, get inputs() { return inputs; } };
}
test('native observations retain identity across reads and distinguish a same-title replacement', () => {
  const f = fixture(); const a = f.read(), b = f.read();
  assert.equal(a.status, 'ok'); assert.equal(a.title, 'a.txt'); assert.equal(a.document, 'file:///tmp/a.txt');
  assert.equal(a.window, b.window); assert.equal(a.pid, 12); assert.equal(a.processStart, 100);
  f.replace(); assert.notEqual(f.read().window, a.window); assert.equal(f.inputs, 0);
});
test('native observations never query AX without trust or accept a window changing during a read', () => {
  const f = fixture({ trusted: false }); assert.equal(f.read().status, 'denied'); assert.equal(f.reads, 0);
  assert.equal(fixture({ changeFocus: true }).read().status, 'changed');
});
test('multiple processes are ambiguous, never evidence that the benchmark owns a new app', () => {
  assert.equal(fixture({ appCount: 0 }).read().status, 'absent');
  const f = fixture({ appCount: 2 });
  assert.equal(f.read().status, 'ambiguous');
  assert.equal(f.reads, 0);
});
test('native observations identify sheets, dialogs, modal windows and ambiguous same-title windows', () => {
  for (const options of [{ childRole: 'AXSheet' }, { childRole: 'AXDialog' }, { modal: true },
    { extraWindow: { title: 'Open', identity: 90, subrole: 'AXDialog' } }]) {
    assert.equal(fixture(options).read().overlay, true);
  }
  assert.equal(fixture({ extraWindow: { title: 'a.txt', document: 'file:///tmp/a.txt', identity: 90 } }).read().matchingWindows, 2);
});
test('unsupported document means no document, while failed attributes refuse a native observation', () => {
  assert.equal(fixture({ documentError: -25205 }).read().document, null);
  for (const options of [{ documentError: -25204 }, { sheetsError: -25204 }, { readError: 'AXTitle' },
    { readError: 'AXChildren' }, { readError: 'AXWindows' }]) assert.notEqual(fixture(options).read().status, 'ok');
});
