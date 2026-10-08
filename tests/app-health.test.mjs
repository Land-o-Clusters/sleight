import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function probe({ trusted = true, error = 0, count = 1, apps = ['com.apple.TextEdit'], timeoutError = 0 } = {}) {
  const calls = [];
  const $ = value => value;
  Object.assign($, {
    AXIsProcessTrusted: () => trusted,
    NSWorkspace: { sharedWorkspace: { runningApplications: { count: apps.length, objectAtIndex: i => ({
      localizedName: 'TextEdit', bundleIdentifier: apps[i], bundleURL: { path: '/System/Applications/TextEdit.app' }, processIdentifier: 42,
    }) } } },
    AXUIElementCreateApplication: pid => { calls.push(['create', pid]); return pid; },
    AXUIElementSetMessagingTimeout: (app, deadline) => { calls.push(['deadline', deadline]); return timeoutError; },
    AXUIElementCopyAttributeValue: (app, name, ref) => { calls.push(['read', name]); ref[0] = { count }; return error; },
  });
  const context = vm.createContext({ $, Ref: () => [], ObjC: { import() {}, unwrap: value => value, castRefToObject: value => value } });
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
    assert.deepEqual(p.calls, [['create', 42], ['deadline', 0.5], ['read', 'AXWindows']]);
    assert.equal('title' in result, false);
  }
});
test('no-window responses are preserved and a failed deadline stops before querying', () => {
  assert.equal(probe({ count: 0 }).run('TextEdit').windows, 0);
  const p = probe({ timeoutError: -25205 });
  assert.equal(p.run('TextEdit').status, 'unknown'); assert.equal(p.calls.length, 2);
  assert.equal(probe().run({ windowId: 12 }).status, 'unknown');
});
