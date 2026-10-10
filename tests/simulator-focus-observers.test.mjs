import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { observePermission } from '../bench/real-permission.mjs';

test('probe options pass the exact opt-in value and guard every permission observation', async () => {
  const { simulatorFocusProbeOptions } = await import('../bench/simulator-focus-setup.mjs');
  let held = false, reads = 0;
  const check = () => { if (held) throw new Error('Live hold exists'); };
  for (const value of [undefined, '0', 'true', '1']) {
    const options = simulatorFocusProbeOptions({ env: { SLEIGHT_SIM_FOCUS_NOTE: value }, check,
      observe: async args => { reads++; assert.equal(args.check, check); assert.equal(args.stopOnLiveHold, true); return false; } });
    assert.equal(options.relayOptions.simFocusNote, value === '1');
    assert.equal(await options.permissionCheck(), false);
    held = true;
    await assert.rejects(options.permissionCheck(), /Live hold/);
    held = false;
  }
  assert.equal(reads, 4);
});
test('permission observation rechecks hold between each host command', async t => {
  const dir = mkdtempSync('/private/tmp/sleight-permission-hold-'), inspector = `${dir}/inspector`;
  t.after(() => rmSync(dir, { recursive: true, force: true })); writeFileSync(inspector, 'fixture');
  let held = false; const calls = [];
  await assert.rejects(observePermission({ inspector,
    check: () => { if (held) throw new Error('Live hold exists'); },
    run: async command => { calls.push(command); held = true; return { stdout: '321\n' }; },
  }), /Live hold/);
  assert.deepEqual(calls, ['/usr/bin/pgrep']);
});
test('permission observation passes the hold boundary into its native title reader', async t => {
  const dir = mkdtempSync('/private/tmp/sleight-permission-hold-'), inspector = `${dir}/inspector`;
  t.after(() => rmSync(dir, { recursive: true, force: true })); writeFileSync(inspector, 'fixture');
  let nativeCalled = false;
  assert.equal(await observePermission({ inspector, stopOnLiveHold: true, run: async (command, args) => {
    if (command === '/usr/bin/pgrep') return { stdout: '321\n' };
    if (args[0] === 'app-info') return { stdout: '[{"bundleIdentifier":"com.apple.UserNotificationCenter"}]' };
    if (args[0] === 'windows-for-pid') return { stdout: '[{"ownerPID":321}]' };
    assert.equal(command, '/usr/bin/osascript'); assert.equal(args.at(-1), 'stop-on-live-hold'); nativeCalled = true;
    return { stdout: '{"titles":["fixture quit unexpectedly"]}' };
  } }), false);
  assert.equal(nativeCalled, true);
});
for (const file of ['real-fixture.js', 'real-permission.js']) test(`${file} stops under a hold before native reads`, () => {
  let reads = 0;
  const $ = () => {}; Object.assign($, {
    NSFileManager: { defaultManager: { fileExistsAtPath: () => true } },
    AXIsProcessTrusted: () => { reads++; throw new Error('unexpected AX read'); },
  });
  const context = { $, ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL(`../bench/${file}`, import.meta.url), 'utf8'), context);
  const args = file === 'real-fixture.js' ? [JSON.stringify({ bundle: 'com.apple.dt.Devices', mode: 'inherit', control: 'fixture', stopOnLiveHold: true })] : ['321', 'stop-on-live-hold'];
  assert.throws(() => context.run(args), /Live hold/); assert.equal(reads, 0);
});
test('retained fixture observations and actions check hold before each AX operation', () => {
  let reads = 0;
  const $ = value => value;
  $.AXUIElementCopyAttributeValue = () => { reads++; return -25212; };
  $.AXUIElementPerformAction = () => { reads++; return 0; };
  const context = { $, ObjC: { import() {} }, Ref: () => [] };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), context);
  const api = context.nativeAX({}, { check: () => { throw new Error('Live hold exists'); } });
  assert.throws(() => api.read({}, 'AXWindows'), /Live hold/);
  assert.throws(() => api.press({}), /Live hold/);
  assert.equal(reads, 0);
});
test('retained fixture quit checks a new hold before requesting termination', () => {
  const context = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), context);
  let checks = 0, quits = 0;
  const app = { processIdentifier: 123, bundleIdentifier: 'com.apple.dt.Devices', get terminate() { quits++; return true; } };
  assert.throws(() => context.quitFixtureApplication(123, 'com.apple.dt.Devices', () => app,
    { check: () => { if (++checks === 2) throw new Error('Live hold exists'); }, now: () => 0, emit() {} }), /Live hold/);
  assert.equal(quits, 0);
});
