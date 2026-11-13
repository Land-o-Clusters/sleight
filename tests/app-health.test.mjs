import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const window = (pid, onScreen, extra = {}) => ({ onScreen, info: { kCGWindowOwnerPID: pid, kCGWindowLayer: 0, kCGWindowAlpha: 1,
  kCGWindowBounds: { Width: 600, Height: 400 }, ...extra } });

function probe({ trusted = true, error = 0, count = 1, apps = ['com.apple.TextEdit'], name = 'TextEdit', timeoutError = 0, hidden = false,
  minimized = [], cg = [window(42, true)], fullScreen = false, spaces, connection = 7, bindThrows = false } = {}) {
  const calls = [];
  const $ = value => value;
  const array = values => ({ count: values.length, objectAtIndex: i => values[i],
    filteredArrayUsingPredicate: ({ format, args }) => array(values.filter(value => format.startsWith('localizedName')
      ? [value.localizedName, value.bundleIdentifier, value.bundleURL?.path].some(s => s?.toLowerCase() === args[0].toLowerCase())
      : value.kCGWindowOwnerPID === args[0] && value.kCGWindowLayer === 0 && (value.kCGWindowAlpha ?? 1) > 0 &&
        value.kCGWindowBounds?.Width >= 100 && value.kCGWindowBounds?.Height >= 100)) });
  Object.assign($, {
    NSPredicate: { predicateWithFormatArgumentArray: (format, args) => ({ format, args }) },
    AXIsProcessTrusted: () => trusted,
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: 9, isNil: () => false }, runningApplications: array(apps.map(id => ({
      localizedName: name, bundleIdentifier: id, bundleURL: { path: '/System/Applications/TextEdit.app' }, processIdentifier: 42, hidden,
      valueForKeyPath(key) { return key.split('.').reduce((value, part) => value?.[part], this); },
    }))) } },
    kCGWindowListOptionOnScreenOnly: 1, kCGWindowListOptionAll: 0, kCGWindowListExcludeDesktopElements: 16,
    CGWindowListCopyWindowInfo: options => {
      const list = cg.filter(w => !(options & 1) || w.onScreen).map(w => w.info);
      return array(list);
    },
    // `spaces`: window number -> the Spaces CGSCopySpacesForWindows names for it; absent, the private call is unbound.
    CGSMainConnectionID: () => connection,
    CGSCopySpacesForWindows: (cid, mask, ids) => { calls.push(['spaces', cid, mask, ...ids]); return spaces[ids[0]]; },
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
  const bindFunction = spaces ? (name, signature) => { calls.push(['bind', name, JSON.stringify(signature)]); if (bindThrows) throw Error('no symbol'); } : undefined;
  const context = vm.createContext({ $, Ref: () => [], ObjC: { import() {}, unwrap: value => value, castRefToObject: value => value, deepUnwrap: value => value,
    ...(bindFunction ? { bindFunction } : {}) } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/app-health.js', import.meta.url), 'utf8'), context);
  return { run: (selector, deadlineSeconds) => JSON.parse(context.run([JSON.stringify(selector), JSON.stringify(deadlineSeconds)])), calls };
}
test('a longer diagnostic probe applies its requested AX deadline', () => {
  const p = probe();
  assert.equal(p.run('TextEdit', 3).status, 'responding');
  assert.deepEqual(p.calls[1], ['deadline', 3]);
});
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
  const panel = window(42, false, { kCGWindowName: 'Save Panel Accessory View', kCGWindowNumber: 71 });
  const result = probe({ count: 0, cg: [panel] }).run('TextEdit');
  assert.equal(result.savePanelOnly, true);
  assert.deepEqual(result.savePanelWindowIds, [71]);
  assert.equal(JSON.stringify(result).includes('Save Panel Accessory View'), false);
  for (const options of [{ count: 1, cg: [panel] }, { count: 0, cg: [panel, window(42, false)] },
    { count: 0, cg: [window(42, false)] }, { count: 0, cg: [panel], error: -25204 }]) {
    assert.notEqual(probe(options).run('TextEdit').savePanelOnly, true);
  }
});

test('a second AppKit app with zero AX windows gets the orphan-panel diagnosis', () => {
  const panel = window(42, false, { kCGWindowName: 'Save Panel Accessory View', kCGWindowNumber: 72 });
  const result = probe({ count: 0, cg: [panel], apps: ['com.apple.Preview'], name: 'Preview' }).run('com.apple.Preview');
  assert.equal(result.savePanelOnly, true);
  assert.equal(result.app, 'Preview');
  assert.equal(result.pid, 42);
  assert.deepEqual(result.savePanelWindowIds, [72]);
});

// SW1b (2026-10-19): Safari keeps an ordered-out 500x500 window from launch. CGWindowList lists it and no Space holds it, so
// allWindows said 2 for one open window. Measured on this Mac: Safari's two windows answered [4] and [].
test('spaceWindows counts the windows a Space holds, leaving out ordered-out ones and keeping another Space\'s', () => {
  const shown = window(42, true, { kCGWindowNumber: 311216 }), hidden = window(42, false, { kCGWindowNumber: 311209,
    kCGWindowBounds: { Width: 500, Height: 500 } }), elsewhere = window(42, false, { kCGWindowNumber: 311300 });
  const p = probe({ cg: [shown, hidden], spaces: { 311216: [4], 311209: [] } });
  const result = p.run('TextEdit');
  assert.deepEqual({ allWindows: result.allWindows, spaceWindows: result.spaceWindows, onScreen: result.onScreen }, { allWindows: 2, spaceWindows: 1, onScreen: 1 });
  assert.deepEqual(p.calls.filter(c => c[0] === 'spaces'), [['spaces', 7, 7, 311216], ['spaces', 7, 7, 311209]]);
  assert.equal(probe({ cg: [shown, hidden, elsewhere], spaces: { 311216: [4], 311209: [], 311300: [5] } }).run('TextEdit').spaceWindows, 2);
  assert.equal(probe({ cg: [], count: 0, spaces: {} }).run('TextEdit').spaceWindows, 0);
  // Unknown whenever the window server can't say: no binding, no connection, an odd answer, or a window without a number.
  for (const options of [{ cg: [shown, hidden] }, { cg: [shown], spaces: { 311216: [4] }, connection: 0 },
    { cg: [shown, hidden], spaces: { 311216: [4] } }, { cg: [shown, window(42, false)], spaces: { 311216: [4] } }]) {
    assert.equal(probe(options).run('TextEdit').spaceWindows, undefined, JSON.stringify(options.spaces));
  }
  // A binding that throws is not tried again by the long-lived helper, and later probes still answer.
  const broken = probe({ cg: [shown, hidden], spaces: { 311216: [4], 311209: [] }, bindThrows: true });
  for (let i = 0; i < 2; i++) assert.equal(broken.run('TextEdit').spaceWindows, undefined);
  assert.equal(broken.run('TextEdit').status, 'responding');
  assert.equal(broken.calls.filter(c => c[0] === 'bind').length, 1);
  // A probe that times out on AX still reports it, like the other counts.
  assert.equal(probe({ error: -25204, cg: [shown, hidden], spaces: { 311216: [4], 311209: [] } }).run('TextEdit').spaceWindows, 1);
});
