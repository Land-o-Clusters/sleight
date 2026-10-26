import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');

test('typed consent runs only inside the native card and preserves GB12 button guards', () => {
  assert.match(source, /class ConsentWordField: NSTextField/);
  assert.match(source, /let typing = ConsentTyping\(actions\)/, 'NSAlert installs typed confirmation');
  assert.match(source, /typing = ConsentTyping\(actions\)/, 'styled card installs typed confirmation');
  assert.match(source, /typing\?\.invalidate\(\)/, 'dismissal destroys typed authority');
  assert.match(source, /personInput\(event.cgEvent\)/);
  assert.doesNotMatch(source, /CGEventPost|AXUIElementSetAttributeValue|\.post\(/);
});

test('real modal and handoff events route typed choices only after field focus without ordering windows', { skip: macCommandSkip('xcrun') }, t => {
  assert.match(source, /class ConsentWordField: NSTextField/, 'typed confirmation is missing');
  const blocks = ['PERSON INPUT', 'APP FRAME', 'ASK CARD'].map(name => {
    const block = source.split(`// BEGIN ${name}\n`)[1]?.split(`// END ${name}`)[0];
    assert.ok(block, name);
    // Headless seams supply CGEvent provenance and key-window/current-event state only.
    // Real NSEvents, window association, key equivalents and responder dispatch stay intact.
    return block.replaceAll('window.isKeyWindow', '(window === fixtureKeyWindow)')
      .replaceAll('window.isVisible', 'fixtureVisibleWindows.contains(ObjectIdentifier(window))')
      .replaceAll('NSWorkspace.shared.notificationCenter', 'fixtureWorkspaceCenter')
      .replaceAll('DistributedNotificationCenter.default()', 'fixtureUnlockCenter')
      .replaceAll('CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .leftMouseDown)', 'fixtureHIDMouseDownAge')
      .replaceAll('NSEvent.mouseLocation', 'fixtureMouseLocation')
      .replaceAll('NSWorkspace.shared.isVoiceOverEnabled', 'fixtureVoiceOver')
      .replaceAll('NSWorkspace.shared.isSwitchControlEnabled', 'fixtureSwitchControl')
      .replaceAll('wordFocusAllowed = isKeyWindow', 'wordFocusAllowed = fixtureKeyWindow === self')
      .replaceAll('makeKey()', 'fixtureMakeKey(self)')
      .replaceAll('window?.isVisible == true', 'window.map { fixtureVisibleWindows.contains(ObjectIdentifier($0)) } == true')
      .replaceAll('event.cgEvent', 'fixtureCGEvent(event)')
      .replaceAll('down.cgEvent', 'fixtureCGEvent(down)')
      .replaceAll('proc_pidpath(Int32(pid), &path, UInt32(path.count))', 'fixturePidPath(Int32(pid), &path, UInt32(path.count))');
  });
  // Exercise the actual callers as well as the shared classifier. Their source has no consent override.
  for (const [start, end] of [['final class CursorPauseControl {', 'final class CursorPauseMenuItem:'],
    ['final class CursorPickerWindowProbe:', 'final class CursorPickerHost:']]) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    const block = source.slice(from, to);
    assert.doesNotMatch(block, /consent: true/);
    blocks.push(block.replaceAll('nonceBook.nonce("hand")', '"a"'));
  }
  const dir = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-typed-input-'))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import AppKit\nimport Foundation\nimport CoreFoundation\nimport QuartzCore\nimport Carbon.HIToolbox\nimport ObjectiveC\nimport Darwin\nimport os.log\n' + blocks.join('\n') + readFileSync(new URL('./fixtures/consent-typed-input.swift', import.meta.url), 'utf8'));
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8', timeout: 600000 });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, `${run.error ?? run.signal ?? ''}\n${run.stderr}${run.stdout}`);
  assert.match(run.stderr, /sleight consent refused: CONSENT_TOO_SOON/);
  assert.match(run.stderr, /sleight consent refused: PERSON_INPUT_REQUIRED/);
  for (const path of ['current-event', 'hid']) {
    for (const exempt of ['true', 'false']) assert.ok(run.stderr.includes(`CONSENT_ACTIVATION path=${path} exempt=${exempt}`));
  }
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.failures, []);
  for (const route of ['window', 'application', 'equivalent']) assert.ok(result.dispatches[route] > 0, route);
  assert.ok(result.checks >= 50, 'security and accessibility cases executed');
  assert.equal(result.visible, false);
  t.diagnostic(`${result.checks} native assertions; no window shown and no event posted`);
});
