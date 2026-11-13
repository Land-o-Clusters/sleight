import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

test('CHV6 held stage slot rechecks every identity without reopening its ancestor directories', { skip: process.platform !== 'darwin' }, t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'stage-slot-native-'))));
  const text = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  let body = text.slice(text.indexOf('// BEGIN STAGE SLOT'), text.indexOf('// END STAGE SLOT'));
  if (process.env.CHV6_SLOT_BROKEN === 'ignore-ancestor') {
    const site = 'for link in directoryLinks {';
    assert.ok(body.includes(site)); body = body.replace(site, 'for link in directoryLinks.prefix(0) {');
  }
  body = body.replaceAll('openat(', 'trackedOpenat(').replaceAll('open(', 'trackedOpen(').replaceAll('close(', 'trackedClose(');
  const main = join(root, 'main.swift'), binary = join(root, 'slot');
  writeFileSync(main, `import Foundation
import Darwin
var opens = 0, held = Set<Int32>()
func trackedOpen(_ path: String, _ flags: Int32) -> Int32 {
    opens += 1; let fd = Darwin.open(path, flags); if fd >= 0 { held.insert(fd) }; return fd
}
func trackedOpenat(_ parent: Int32, _ path: String, _ flags: Int32, _ mode: mode_t = 0) -> Int32 {
    opens += 1; let fd = Darwin.openat(parent, path, flags, mode); if fd >= 0 { held.insert(fd) }; return fd
}
@discardableResult func trackedClose(_ fd: Int32) -> Int32 { held.remove(fd); return Darwin.close(fd) }
${body}
let root = CommandLine.arguments[1] + "/private/slots"
let a = StageSlot(root: root), b = StageSlot(root: root)
precondition(a.claim("1")); let initial = opens
for _ in 0..<30 { precondition(a.claim("1")) }
let extra = opens - initial
precondition(!b.claim("1")); precondition(b.claim("2")); b.release()
precondition(!a.claim("2"))
let parent = URL(fileURLWithPath: root).deletingLastPathComponent().path
let old = parent + "-old"
precondition(rename(parent, old) == 0)
precondition(mkdir(parent, 0o700) == 0)
precondition(mkdir(root, 0o700) == 0)
precondition(!a.claim("1"), "renamed ancestor cannot keep the old flock")
a.release(); precondition(b.claim("1")); b.release()
try! FileManager.default.removeItem(atPath: parent)
precondition(symlink(old, parent) == 0)
precondition(!a.claim("1"), "ancestor aliases are refused")
precondition(unlink(parent) == 0); precondition(rename(old, parent) == 0)
precondition(a.claim("1"))
let lock = root + "/stage-1.lock", saved = root + "/saved"
precondition(rename(lock, saved) == 0)
let replacement = Darwin.open(lock, O_RDWR | O_CREAT | O_EXCL, 0o600); precondition(replacement >= 0); Darwin.close(replacement)
precondition(!a.claim("1"), "lock replacement cannot retain admission")
a.release(); precondition(b.claim("1")); b.release()
precondition(chmod(lock, 0o644) == 0); precondition(!a.claim("1")); a.release()
precondition(unlink(lock) == 0); precondition(symlink(saved, lock) == 0); precondition(!a.claim("1")); a.release()
precondition(unlink(lock) == 0); precondition(link(saved, lock) == 0); precondition(!a.claim("1")); a.release()
precondition(held.isEmpty, "release closes the lock and every directory descriptor")
print("{\\"reopens\\":\\(extra),\\"checks\\":30,\\"remainingDescriptors\\":\\(held.count)}")
`);
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), main, '-o', binary],
    { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  assertChildStatus(build, 0, build.stderr);
  const run = spawnSync(binary, [root], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 0, run.stderr);
  const row = JSON.parse(run.stdout);
  assert.equal(row.reopens, 0, '30 parked checks must retain their verified directory descriptors');
  assert.equal(row.checks, 30); assert.equal(row.remainingDescriptors, 0);
  t.diagnostic(JSON.stringify(row));
});
