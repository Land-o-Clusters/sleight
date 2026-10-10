import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const window = (pid, onScreen, extra = {}) => ({ onScreen, info: { kCGWindowOwnerPID: pid, kCGWindowLayer: 0, kCGWindowAlpha: 1,
  kCGWindowBounds: { Width: 600, Height: 400 }, ...extra } });

function probe({ trusted = true, error = 0, count = 1, apps = ['com.apple.TextEdit'], timeoutError = 0, hidden = false,
  minimized = [], cg = [window(42, true)], fullScreen = false } = {}) {
  const calls = [];
  const $ = value => value;
  Object.assign($, {
    AXIsProcessTrusted: () => trusted,
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: 9, isNil: () => false }, runningApplications: { count: apps.length, objectAtIndex: i => ({
      localizedName: 'TextEdit', bundleIdentifier: apps[i], bundleURL: { path: '/System/Applications/TextEdit.app' }, processIdentifier: 42, hidden,
    }) } } },
    kCGWindowListOptionOnScreenOnly: 1, kCGWindowListOptionAll: 0, kCGWindowListExcludeDesktopElements: 16,
    CGWindowListCopyWindowInfo: options => {
      const list = cg.filter(w => !(options & 1) || w.onScreen).map(w => w.info);
      return { count: list.length, objectAtIndex: i => list[i] };
    },
    AXUIElementCreateApplication: pid => { if (pid !== 9) calls.push(['create', pid]); return pid; },
    AXUIElementSetMessagingTimeout: (app, deadline) => { if (app !== 9) calls.push(['deadline', deadline]); return app === 9 ? 0 : timeoutError; },
    AXUIElementCopyAttributeValue: (app, name, ref) => {
      if (name === 'AXFocusedWindow') { ref[0] = { front: true }; return 0; }
      if (name === 'AXFullScreen') { ref[0] = fullScreen; return 0; }
      calls.push(['read', name]);
      ref[0] = name === 'AXMinimized' ? app.minimized : { count, objectAtIndex: i => ({ minimized: minimized[i] === true }) };
      return name === 'AXMinimized' ? 0 : error;
    },
  });
  const context = vm.createContext({ $, Ref: () => [], ObjC: { import() {}, unwrap: value => value, castRefToObject: value => value, deepUnwrap: value => value } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/app-health.js', import.meta.url), 'utf8'), context);
  return { run: selector => JSON.parse(context.run([JSON.stringify(selector)])), calls };
}
test('AX health does not prompt when Accessibility is missing or a selector is ambiguous', () => {
  for (const options of [{ trusted: false }, { apps: ['com.apple.TextEdit', 'com.apple.TextEdit'] }, { apps: [] }]) {
    const p = probe(options); const result = p.run('textedit');
    assert.notEqual(result.status, 'responding'); assert.equal(p.calls.length, 0);
  }
});
test('native AX messaging is bounded and only its actual cannotComplete error diagnoses timeout', () => {
  for (const error of [-25204, -25211, -25205, 0]) {
    const p = probe({ error }); const result = p.run('com.apple.textedit');
    assert.equal(result.status, error === -25204 ? 'timeout' : error === -25211 ? 'denied' : error ? 'unknown' : 'responding');
    assert.deepEqual(p.calls, [['create', 42], ['deadline', 0.5], ['read', 'AXWindows'], ...(error ? [] : [['read', 'AXMinimized']])]);
    assert.equal('title' in result, false);
  }
});
test('no-window responses are preserved and a failed deadline stops before querying', () => {
  assert.equal(probe({ count: 0 }).run('TextEdit').windows, 0);
  const p = probe({ timeoutError: -25205 });
  assert.equal(p.run('TextEdit').status, 'unknown'); assert.equal(p.calls.length, 2);
  assert.equal(probe().run({ windowId: 12 }).status, 'unknown');
});
test('windows are counted on the current Space, leaving out small, transparent and other apps\' windows', () => {
  const result = probe({ count: 2, cg: [window(42, false), window(42, false), window(42, true, { kCGWindowLayer: 3 }),
    window(42, true, { kCGWindowAlpha: 0 }), window(42, true, { kCGWindowBounds: { Width: 40, Height: 40 } }), window(7, true)] }).run('TextEdit');
  assert.deepEqual({ onScreen: result.onScreen, allWindows: result.allWindows, minimized: result.minimized, hidden: result.hidden, fullScreenSpace: result.fullScreenSpace },
    { onScreen: 0, allWindows: 2, minimized: 0, hidden: false, fullScreenSpace: false });
  assert.equal(probe({ fullScreen: true }).run('TextEdit').fullScreenSpace, true, 'the front window decides');
  assert.equal(probe({ count: 2, minimized: [true, false] }).run('TextEdit').minimized, 1);
  assert.equal(probe({ hidden: true }).run('TextEdit').hidden, true);
  assert.equal(probe({ error: -25204, cg: [window(42, false)] }).run('TextEdit').onScreen, 0, 'a timed-out app still reports its Space');
});
test('an empty TextEdit with only a Save Panel Accessory View is identified without exposing titles', () => {
  const panel = window(42, false, { kCGWindowName: 'Save Panel Accessory View' });
  const result = probe({ count: 0, cg: [panel] }).run('TextEdit');
  assert.equal(result.savePanelOnly, true);
  assert.equal(JSON.stringify(result).includes('Save Panel Accessory View'), false);
  for (const options of [{ count: 1, cg: [panel] }, { count: 0, cg: [panel, window(42, false)] },
    { count: 0, cg: [window(42, false)] }, { count: 0, cg: [panel], apps: ['com.apple.Preview'] }, { count: 0, cg: [panel], error: -25204 }]) {
    assert.notEqual(probe(options).run('TextEdit').savePanelOnly, true);
  }
});
