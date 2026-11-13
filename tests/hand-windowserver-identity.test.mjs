import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
const native = { skip: process.platform !== 'darwin' };
const sourceURL = new URL('../bench/hand/capture.swift', import.meta.url);
test('INT26 WindowServer identity requires the process executable, owner name and one unambiguous pid', native, t => {
  const full = readFileSync(sourceURL, 'utf8');
  let source = full.split('// BEGIN WINDOWSERVER IDENTITY')[1].split('// END WINDOWSERVER IDENTITY')[0];
  const variants = {
    'owner-name': ['["WindowServer", "Window Server"].contains(row["owner"] as? String ?? "")', 'true'],
    'spaced-owner': ['["WindowServer", "Window Server"]', '["WindowServer"]'],
    'executable': ['path.hasPrefix("/System/Library/"), path.hasSuffix("/WindowServer")', '!path.isEmpty'],
    'ambiguous-pid': ['candidates.count == 1 ? candidates.first : nil', 'candidates.first'],
  };
  if (process.env.INT26_WS_BROKEN) {
    const [before, after] = variants[process.env.INT26_WS_BROKEN];
    assert.ok(source.includes(before)); source = source.replace(before, after);
  }
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ws-identity-'))), input = join(root, 'main.swift'), binary = join(root, 'identity');
  writeFileSync(input, `import Foundation\nimport Darwin\n${source}\n` + `
let system = "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer"
func row(_ pid: Int, _ owner: String = "WindowServer") -> [String: Any] { ["pid": pid, "owner": owner, "name": "untrusted title"] }
let paths: [Int32: String] = [88: system, 89: system, 99: "/Applications/WindowServer.app/Contents/MacOS/WindowServer"]
let path: (Int32) -> String? = { paths[$0] }
precondition(windowServerPID([row(88)], executable: path) == 88)
precondition(windowServerPID([row(88, "Window Server")], executable: path) == 88, "current macOS spells the owner with a space")
precondition(windowServerPID([row(88, "Another App")], executable: path) == nil, "owner name must match")
precondition(windowServerPID([row(99)], executable: path) == nil, "app name alone cannot identify WindowServer")
precondition(windowServerPID([row(88), row(99)], executable: path) == 88)
precondition(windowServerPID([row(88), row(89)], executable: path) == nil, "ambiguous verified pids fail closed")
precondition(windowServerPID([row(100)], executable: path) == nil)
precondition(windowServerPID([row(-1)], executable: path) == nil)
precondition(windowServerPID([row(Int.max)], executable: path) == nil)
precondition(windowServerPID([row(88), row(88)], executable: path) == 88)
print(#"{"cases":10,"windowsCreated":0}"#)
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), input, '-o', binary],
    { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cases: 10, windowsCreated: 0 });
  assert.match(full, /"windowServerPid": windowServerPID\(windows\)/);
});
test('INT26 complete capture helper compiles without launching it', native, t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-capture-compile-')));
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), fileURLToPath(sourceURL), '-o', join(root, 'capture')],
    { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
});
