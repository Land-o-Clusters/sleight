import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { runSharedHost as shared } from './fixtures/shared-consent-host.mjs';

// The shared host: one consent-host process per session serves the hand (stdin, toggle events on stdout) and turbo's consent
// channel (fd 3 in, fd 4 out). These tests never show anything: the turbo status is disconnected and the hand is off, so the
// glove stays hidden, and every hand frame names a window that doesn't exist.
const sourcePath = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
const skip = macCommandSkip('xcrun');
let built;
function build() {
  if (built) return built;
  const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-shared-host-'))));
  const binary = join(dir, 'consent-host');
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), sourcePath, '-o', binary], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return (built = binary);
}
const handNonce = 'a'.repeat(64), consentNonce = 'c'.repeat(64);
const menu = (over = {}) => ({ hand: 'menu', nonce: handNonce, enabled: false, capture: 'hidden', version: '1.3.1', ...over });
const act = (seq, over = {}) => ({ hand: 'act', nonce: handNonce, seq, kind: 'click', pid: 2147483647, windowId: 4294967295,
  at: [10, 10], path: [[10, 10]], delayMs: 0, beats: 1, ...over });
const status = (over = {}) => ({ id: 'v3-control-1', nonce: consentNonce, choices: ['connect'], deadline: Date.now() + 60000,
  data: { status: 'disconnected' }, ...over });

test('two senders share one host: consent on fds 3 and 4, the hand on stdin, and turbo ending leaves the hand running', { skip }, async () => {
  const binary = build();
  const result = await shared(binary, [[3, status()], [0, menu()], [0, act(1)], [0, act(2, { kind: 'drag' })], ['wait', 300], ['end', 3], ['wait', 300],
    [0, act(3)], [0, menu({ enabled: true, capture: 'visible' })], [0, menu({ enabled: false })], [0, { hand: 'hide', nonce: handNonce }], ['end', 0]]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '', 'hand frames never produce stdout'); assert.equal(result.consent, '', 'no choice without a click');
});

// Hand-channel faults the shared host survives, and consent-channel faults that end it.
const handFaults = {
  'a consent frame on the hand channel': [[0, status()]],
  'the consent nonce on the hand channel': [['wait', 300], [0, menu({ nonce: consentNonce })]],
  'a second hand nonce': [[0, menu()], [0, act(1, { nonce: 'b'.repeat(64) })]],
  'a menu frame with an extra key': [[0, menu({ visible: true })]],
  'a menu frame with a string flag': [[0, menu({ enabled: 'false' })]],
  'a menu frame with an unknown capture': [[0, menu({ capture: 'readOnly' })]],
  'a menu frame with an odd version': [[0, menu({ version: '1.3.1; x' })]],
  'a toggle frame from a sender': [[0, { hand: 'toggle', nonce: handNonce, enabled: true }]],
  'a line that is not JSON': [[0, 'click 1 2']],
};
test('each channel has its own parser and nonce: a consent-channel fault ends the host', { skip }, async () => {
  const binary = build();
  for (const [name, steps] of Object.entries({
    'a hand frame on the consent channel': [[3, menu()]],
    'the hand nonce on the consent channel': [[0, menu()], ['wait', 300], [3, status({ nonce: handNonce })]],
    'a second consent nonce': [[3, status()], [3, status({ id: 'v3-control-2', nonce: 'd'.repeat(64) })]],
  })) {
    const result = await shared(binary, [...steps, ['wait', 200], ['end', 3], ['end', 0]]);
    assert.equal(result.code, 65, name + ': ' + result.stderr);
    assert.equal(result.stdout + result.consent, '', name);
  }
});

test('a hand-channel fault drops only the hand: turbo\'s consent channel keeps the host running', { skip }, async () => {
  const binary = build();
  for (const [name, steps] of Object.entries(handFaults)) {
    const result = await shared(binary, [[3, status()], ...steps, ['wait', 300], ['alive'], [0, act(9)], [3, status({ id: 'v3-control-9' })],
      ['wait', 200], ['alive'], ['end', 3], ['end', 0]]);
    assert.deepEqual(result.alive, [true, true], name);
    assert.equal(result.code, 0, name + ': ' + result.stderr);
    // A fault after the hand nonce is bound tells the relay its pause control is gone, on that nonce. Nothing else is written.
    assert.deepEqual(result.stdout.split('\n').filter(Boolean).map(text => JSON.parse(text)),
      name === 'a second hand nonce' ? [{ hand: 'control-gone', nonce: handNonce }] : [], name);
    assert.equal(result.consent, '', name);
  }
  // Without a consent channel (--menu) a hand fault still ends the host.
  for (const [name, steps] of Object.entries(handFaults)) {
    if (name === 'the consent nonce on the hand channel') continue; // with no consent channel, that nonce is just the hand's
    const result = await shared(binary, [...steps, ['wait', 200], ['end', 0]], ['--hand', '--menu']);
    assert.equal(result.code, 65, name + ' with --menu: ' + result.stderr);
  }
});

test('the hand\'s sender leaving keeps the host for turbo until its channel ends, and --menu ends with the hand', { skip }, async () => {
  const binary = build();
  const result = await shared(binary, [[3, status()], [0, menu()], ['end', 0], ['wait', 400], ['alive'], [3, status({ id: 'v3-control-2' })], ['wait', 200], ['alive'], ['end', 3]]);
  assert.deepEqual(result.alive, [true, true]); assert.equal(result.code, 0, result.stderr);
  const menuOnly = await shared(binary, [[0, menu()], [0, act(1)], ['wait', 200], ['alive'], ['end', 0]], ['--hand', '--menu']);
  assert.deepEqual(menuOnly.alive, [true]); assert.equal(menuOnly.code, 0, menuOnly.stderr); assert.equal(menuOnly.stdout, '');
});

test('an open card is aborted when its sender\'s channel ends, so no button stays up that answers nothing', { skip }, t => {
  const source = readFileSync(sourcePath, 'utf8');
  const block = source.match(/\/\/ BEGIN MODAL GUARD\n([\s\S]*?)\/\/ END MODAL GUARD/);
  assert.ok(block, 'modal guard absent');
  // Modal confirmations run through the guard. Disconnect closes the modeless
  // approval card and the modal guard before forgetting their pending requests.
  assert.equal((source.match(/\.runModal\(\)/g) ?? []).length, (source.match(/modal\.run\(abort: \{ NSApp\.abortModal\(\) \}\) \{ [a-z]+\.runModal\(\) \}/g) ?? []).length);
  assert.match(source, /func channelClosed\(\) \{ closeAsk\(\); modal\.close\(\); pending\.removeAll\(\);/);
  const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-modal-guard-'))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\n' + block[1] + `
func check(_ ok: Bool, _ what: String) { if !ok { print("FAIL " + what); exit(1) } }
let guarded = ModalGuard()
var aborts = 0
check(!guarded.active, "idle")
// The channel ends while a card is up: the card is aborted once.
let answer = guarded.run(abort: { aborts += 1 }) { () -> String in
  check(guarded.active, "a card is up")
  guarded.close(); guarded.close()
  return "aborted"
}
check(answer == "aborted" && aborts == 1 && !guarded.active, "aborted once")
// After the card, closing does nothing.
guarded.close(); check(aborts == 1, "no card, nothing to abort")
_ = guarded.run(abort: { aborts += 1 }) { 1 }
check(aborts == 1 && !guarded.active, "a card that ends by itself is not aborted")
print("pass")
`);
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(spawnSync(binary, [], { encoding: 'utf8' }).stdout.trim(), 'pass');
});

test('a usage value the host can\'t admit drops only the usage row: the frame stands and the hand-only host keeps running', { skip }, async () => {
  const binary = build();
  for (const usage of ['Last 7 days: 1.5 s per action', { native: 1.5, saved: 3, calls: 9 }, { native: 1.5, saved: 3.5 }, { perAction: 1.5, saved: 3 }, null]) {
    const result = await shared(binary, [[0, menu({ usage })], ['wait', 300], ['alive'], [0, act(1)], ['wait', 100], ['alive'], ['end', 0]], ['--hand', '--menu']);
    assert.deepEqual(result.alive, [true, true], JSON.stringify(usage));
    assert.equal(result.code, 0, JSON.stringify(usage) + ': ' + result.stderr);
  }
});

test('--consent needs its two descriptors, and the arguments stay strict', { skip }, () => {
  const binary = build();
  const run = args => spawnSync(binary, args, { input: '', encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(run(['--hand', '--consent']).status, 64, 'no fd 3 or 4');
  for (const args of [['--hand', '--consent', '--capture=visible'], ['--hand', '--consent', '--consent'], ['--consent'], ['--hand-dump', '--consent'], ['--hand', '--menu', '--consent'], ['--hand', '--consent', '--menu'], ['--hand-dump', '--menu'], ['--hand', '--menu', '--capture=hidden']]) {
    assert.equal(run(args).status, 64, args.join(' '));
  }
});

test('the dump renders every hookup frame as a template image', { skip }, () => {
  const result = spawnSync(build(), ['--hand-dump'], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).hookup, { frames: 10, rendered: 10, template: true, seconds: 0.8 });
});

test('the menu frame\'s Permissions rows and the status frame\'s site are admitted exactly, and anything else ends the host', { skip }, async () => {
  const binary = build();
  const rows = { grants: [{ title: 'Fixture', detail: 'always', used: 1760000000, target: 'app:Fixture' }, { title: 'Chat', detail: 'debugger, always', used: null, target: 'electron:com.example.chat' },
    { title: 'Browser', detail: 'turbo', used: null, target: 'turbo' }], blocked: ['Blocked App'], current: { title: 'Editor', target: 'com.example.editor' }, only: ['https://a.example'] };
  const site = status({ choices: ['connect', 'block-site'], data: { status: 'disconnected', site: 'https://example.com' } });
  const good = await shared(binary, [[3, site], [0, menu({ permissions: rows })], [0, menu({ permissions: { grants: [], blocked: [] } })],
    [0, menu({ permissions: rows, usage: { native: 1.5, turbo: 0.4, saved: 312 } })], [0, menu({ usage: { turbo: 0, saved: 0 } })], ['wait', 300], ['end', 3], ['end', 0]]);
  assert.equal(good.code, 0, good.stderr);
  assert.equal(good.stdout + good.consent, '', 'rows draw nothing and answer nothing without a click');
  const cases = {
    'an unknown grant target': menu({ permissions: { grants: [{ ...rows.grants[0], target: 'unblock:Fixture' }], blocked: [] } }),
    'a grant with an extra key': menu({ permissions: { grants: [{ ...rows.grants[0], grant: true }], blocked: [] } }),
    'a current app that is no bundle id': menu({ permissions: { grants: [], blocked: [], current: { title: 'x', target: 'x' } } }),
    'an unknown permissions key': menu({ permissions: { grants: [], blocked: [], unblock: ['x'] } }),
  };
  // A hand-channel fault drops only the hand while turbo's consent channel runs, so these end the host under --menu.
  for (const [name, frame] of Object.entries(cases)) {
    const result = await shared(binary, [[0, frame], ['wait', 200], ['end', 0]], ['--hand', '--menu']);
    assert.equal(result.code, 65, name + ': ' + result.stderr);
  }
  for (const [name, frame] of Object.entries({ 'a site that is a path': status({ data: { status: 'disconnected', site: 'https://example.com/x' } }),
    'a site choice without a site': status({ choices: ['connect', 'block-site'] }) })) {
    const result = await shared(binary, [[3, frame], ['wait', 200], ['end', 3], ['end', 0]]);
    assert.equal(result.code, 65, name + ': ' + result.stderr);
  }
});


test('an exited worker can be replaced on the same host only after the parent resets its consent nonce', { skip }, async () => {
  const token = 'e'.repeat(32), next = 'd'.repeat(64);
  const reset = { hand: 'consent-reset', nonce: handNonce, token };
  const result = await shared(build(), [[0, menu()], [3, status()], ['wait', 100], [3, reset],
    ['ready', { nonce: handNonce, token }], [3, status({ nonce: next })], ['wait', 100], ['alive'], ['end', 3], ['end', 0]]);
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(result.alive, [true]);
  assert.deepEqual(JSON.parse(result.stdout), { hand: 'consent-ready', nonce: handNonce, token });
  assert.equal(result.consent, '');
  const early = await shared(build(), [[3, reset], ['wait', 300], [0, menu()], ['ready', { nonce: handNonce, token }], [3, status({ nonce: next })], ['end', 3], ['end', 0]]);
  assert.equal(early.code, 0, early.stderr);
  assert.equal(JSON.parse(early.stdout).token, token, 'reset waits for the initial hand menu');
  const forged = await shared(build(), [[0, menu()], [3, status()], ['wait', 100], [3, { ...reset, nonce: consentNonce }], ['wait', 100], ['end', 3], ['end', 0]]);
  assert.equal(forged.code, 65); assert.equal(forged.stdout + forged.consent, '');
});
