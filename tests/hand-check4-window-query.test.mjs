import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

test('an omitted host window gets one independent query, requiring exact ownership and a positive on-screen flag', { skip: process.platform !== 'darwin' }, t => {
  const source = readFileSync(new URL('../bench/hand/check4-sampler.swift', import.meta.url), 'utf8');
  assert.match(source, /func hostWindowMetadata\(/);
  const helper = source.slice(source.indexOf('func hostWindowMetadata('), source.indexOf('func jsonFile('));
  const root = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-window-query-'))));
  const main = join(root, 'main.swift'), binary = join(root, 'query');
  writeFileSync(main, `import Foundation\nimport CoreGraphics\n${helper}
let status: [String: Any] = ["pid": 42, "panelID": 9]
let raw: [String: Any] = [kCGWindowOwnerPID as String: 42, kCGWindowNumber as String: 9,
    kCGWindowIsOnscreen as String: true, kCGWindowBounds as String: CGRect(x: 1, y: 2, width: 3, height: 4).dictionaryRepresentation]
var calls = 0
let query: (CGWindowListOption, CGWindowID) -> CFArray? = { flags, id in
    precondition(flags == .optionIncludingWindow && id == 9); calls += 1; return [raw] as CFArray
}
precondition(hostWindowMetadata(status, [], query: query) != nil && calls == 1)
precondition(hostWindowMetadata(status, [raw], query: query) == nil && calls == 1)
for mutation: [String: Any] in [[kCGWindowOwnerPID as String: 99], [kCGWindowNumber as String: 8], [kCGWindowIsOnscreen as String: false]] {
    let bad = raw.merging(mutation) { _, new in new }
    precondition(hostWindowMetadata(status, [], query: { _, _ in [bad] as CFArray }) == nil)
}
precondition(hostWindowMetadata(status, [], query: { _, _ in [] as CFArray }) == nil)
precondition(hostWindowMetadata(status, [], query: { _, _ in [raw, raw] as CFArray }) == nil)
precondition(hostWindowMetadata(["pid": 42, "panelID": -1], [], query: query) == nil)
print(#"{"cases":8,"windowsCreated":0}"#)
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), main, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const ran = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(ran, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), { cases: 8, windowsCreated: 0 });
});
