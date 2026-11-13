import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

test('stage and model fixtures own a separate person window without replacing input or placement', () => {
  const fixture = readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
  const observer = readFileSync(new URL('../bench/hand/check4-host.swift', import.meta.url), 'utf8');
  assert.match(fixture, /width: 220, height: 122/);
  assert.match(fixture, /stageBenchPersonWindow = StageWindowKey\(pid: getpid\(\), window: UInt32\(standIn.windowNumber\)\)/);
  assert.match(fixture, /person\?\.close\(\)/);
  assert.match(fixture, /stageBenchPersonWindow = nil/);
  assert.match(observer, /stageBenchPersonWindow = StageWindowKey\(pid: getpid\(\), window: UInt32\(panel.windowNumber\)\)/);
  assert.match(observer, /width: 220, height: 122/);
  assert.match(observer, /panel\.ignoresMouseEvents = true/);
  assert.match(observer, /check4PreparePerson\(\)/);
  assert.match(observer, /let stageBenchPointerPosition: CGPoint\? = nil/);
});

test('a front app without an on-screen window still yields a stage world with no person window', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const world = source.slice(source.indexOf('func stageWorld('), source.indexOf('func stageCallQuery('));
  assert.doesNotMatch(world, /guard let person = stagePersonWindow/);
  assert.match(world, /let person = stagePersonWindow\(/);
  assert.match(world, /StageWorld\(base: base, usable: [^,]+, person: person,/);
  assert.match(source, /struct StageWorld \{\n\s+var base: PerchWorld, usable: CGRect, person: CGRect\?/);
});

test('headless person selection returns no person without a front window and protects the exact fixture stand-in', { skip: process.platform !== 'darwin' }, t => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  assert.match(source, /func stagePersonWindow\(/);
  const helper = source.slice(source.indexOf('func stagePersonWindow('), source.indexOf('func stageCallApply('));
  const root = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-stage-person-'))));
  const file = join(root, 'person.swift'), binary = join(root, 'person');
  const valid = source.slice(source.indexOf('func stageRectValid('), source.indexOf('func stagePointRect('));
  writeFileSync(file, `import Foundation\nimport CoreGraphics
struct StageWindowKey { var pid: Int32, window: UInt32 }
${valid}
${helper}
let rect = CGRect(x: 1272, y: 33, width: 220, height: 122)
func row(_ pid: Int32, _ id: UInt32, _ frame: CGRect, layer: Int = 0) -> [String: Any] {
    [kCGWindowOwnerPID as String: pid, kCGWindowNumber as String: id, kCGWindowLayer as String: layer,
        kCGWindowBounds as String: frame.dictionaryRepresentation]
}
let own: Int32 = 42, person = StageWindowKey(pid: own, window: 9)
let windows = [row(own, 9, rect), row(own, 7, CGRect(x: 30, y: 592, width: 700, height: 350)), row(99, 8, CGRect(x: 0, y: 0, width: 1512, height: 982))]
precondition(stagePersonWindow(windows, frontPID: nil, ownPID: own) == nil)
precondition(stagePersonWindow(windows, frontPID: own, ownPID: own) == nil)
precondition(stagePersonWindow(windows, frontPID: 99, ownPID: own, standIn: person) == rect)
precondition(stagePersonWindow(Array(windows.dropFirst()), frontPID: 99, ownPID: own, standIn: person) == nil)
precondition(stagePersonWindow([row(88, 9, rect)], frontPID: 99, ownPID: own, standIn: person) == nil)
precondition(stagePersonWindow([row(own, 9, rect, layer: 3)], frontPID: 99, ownPID: own, standIn: person) == nil)
precondition(stagePersonWindow(windows, frontPID: 99, ownPID: own) == CGRect(x: 0, y: 0, width: 1512, height: 982))
print(#"{"cases":7,"windowsCreated":0}"#)
`);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(compile, 0, compile.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cases: 7, windowsCreated: 0 });
});
