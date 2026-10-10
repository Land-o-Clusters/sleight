import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const cleanupSource = readFileSync(new URL('../bench/textedit-save-lock-cleanup.js', import.meta.url), 'utf8');
const trialSource = readFileSync(new URL('../bench/textedit-save-lock.js', import.meta.url), 'utf8');
const args = ['/private/tmp/sleight-save-lock-fixture/trial.txt', '123', '100000', '101000'];
function native({ held = false, inspectOnly = false, birth = 100, windowCount = 0, holdAtQuit = false } = {}) {
  const calls = [], $ = value => value;
  let holds = held;
  const app = { launchDate: { timeIntervalSince1970: birth }, bundleIdentifier: 'com.apple.TextEdit', isTerminated: false,
    get terminate() { calls.push('quit'); this.isTerminated = true; return true; } };
  Object.assign($, {
    NSFileManager: { defaultManager: { fileExistsAtPath: () => holds } },
    AXIsProcessTrusted: () => { calls.push('trusted'); return true; },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: () => { calls.push('process'); return app; } },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: 999 } } },
    NSURL: { fileURLWithPath: path => ({ absoluteString: `file://${path}` }) },
    AXUIElementCreateApplication: () => 'app', AXUIElementSetMessagingTimeout: () => {},
    AXUIElementCopyAttributeValue: (_el, name, out) => {
      calls.push(name);
      if (name !== 'AXWindows') throw new Error('unrelated window must be preserved');
      out[0] = { count: windowCount, objectAtIndex: () => ({}) };
      if (holdAtQuit && calls.filter(name => name === 'AXWindows').length === 2) holds = true;
      return 0;
    },
  });
  const context = { $, ObjC: { import() {}, unwrap: value => value, castRefToObject: value => value }, Ref: () => [], delay() {} };
  runInNewContext(cleanupSource, context);
  return { calls, run: () => JSON.parse(context.run([...args, ...(inspectOnly ? ['inspect-only'] : [])])) };
}

for (const inspectOnly of [false, true]) test(`cleanup stops under a hold before host reads (inspectOnly=${inspectOnly})`, () => {
  const h = native({ held: true, inspectOnly });
  assert.throws(h.run, /Live hold/);
  assert.deepEqual(h.calls, []);
});
test('the trial helper stops under a hold before opening its live command channel', () => {
  const $ = () => {}; $.NSFileManager = { defaultManager: { fileExistsAtPath: () => true } };
  const context = { $, ObjC: { import() {} } };
  runInNewContext(trialSource, context);
  assert.throws(() => context.run([args[0]]), /Live hold/);
});
test('cleanup confirms quitting its exact empty owned launch', () => {
  const h = native();
  assert.equal(h.run().processQuit, true);
  assert.equal(h.calls.filter(name => name === 'quit').length, 1);
});
test('inspection does not claim a live process was quit', () => {
  const h = native({ inspectOnly: true });
  const result = h.run();
  assert.equal(result.fixtureClosed, true); assert.equal(result.processQuit, false);
  assert.ok(!h.calls.includes('quit'));
});
test('a replaced PID is never quit', () => {
  const h = native({ birth: 500 });
  assert.throws(h.run, /identity/); assert.ok(!h.calls.includes('quit'));
});
test('a hold arriving before quit stops cleanup', () => {
  const h = native({ holdAtQuit: true });
  assert.throws(h.run, /Live hold/); assert.ok(!h.calls.includes('quit'));
});
