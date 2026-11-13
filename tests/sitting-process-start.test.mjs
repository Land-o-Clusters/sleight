import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
const slice = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));

test('kernel birth is wired into UTM arm, every VM sample and retained fixture identities', () => {
  const verify = s => {
    assert.doesNotMatch(s, /\.launchDate/);
    assert.match(s, /vmStart = processStart\(vmPID\)/);
    assert.match(s, /return birth/);
    assert.match(s, /let birth = processStart\(app.processIdentifier\)/);
    assert.match(s, /let date = identity\(apps\[0\]\)/);
    assert.match(s, /for pid in own where pid != vmPID/);
    assert.match(s, /birth != ownStarts\[pid\]/);
    assert.match(s, /info.pbi_start_tvsec \* 1_000_000 \+ info.pbi_start_tvusec/);
    assert.match(s, /proc_pidinfo\(pid, PROC_PIDTBSDINFO/);
  };
  verify(source);
  for (const [before, after] of [
    ['vmStart = processStart(vmPID)', 'vmStart = nil'],
    ['let birth = processStart(app.processIdentifier)', 'let birth: UInt64? = nil'],
    ['for pid in own where pid != vmPID', 'for pid in Set<Int32>()'],
    ['birth != ownStarts[pid]', 'false'],
    ['info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec', 'info.pbi_start_tvsec * 1_000_000'],
    ['let date = identity(apps[0])', 'let date = apps[0].launchDate'],
  ]) assert.throws(() => verify(source.replace(before, after)), assert.AssertionError);
});

test('compiled production identity decisions catch launch-date flicker, restarts and unreadable births',
  { skip: process.platform !== 'darwin', timeout: 360000 }, async t => {
    const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-process-start-')));
    try {
      const retry = slice('func processStart(', 'func rect(');
      const identity = slice('    func identity(_ app:', '    func bound(');
      const vmCheck = slice('    func checkVM(', '    func captureState(');
      const variants = [
        ['launch-date', identity, 'return birth', 'return app.launchDate.map { UInt64($0.timeIntervalSince1970 * 1_000_000) }'],
        ['birth-match', vmCheck, 'currentStart == vmStart', 'true'],
        ['unreadable-match', vmCheck, 'fault("PROCESS_START_UNREADABLE", read: "KERNEL_PROCESS_BIRTH", value: "nil", pid: vmPID); return', 'return'],
        ['unreadable-code', vmCheck, 'fault("PROCESS_START_UNREADABLE", read: "KERNEL_PROCESS_BIRTH", value: "nil", pid: vmPID)', 'identityFault("PROCESS_START")'],
        ['no-retry', retry, '0..<3', '0..<1'],
        ['unbounded-reads', retry, '0..<3', '0..<4'],
        ['no-pause', retry, 'if attempt < 2 { pause() }', 'if false { pause() }'],
      ];
      const classes = [['good', null, null, null], ...variants].map(([name, part, before, after], i) => {
        if (part) assert.ok(part.includes(before), name);
        const change = value => value === part ? value.replace(before, after) : value;
        const retryName = `start${i}`;
        return `
${change(retry).replace('func processStart(', `func ${retryName}(`)}
final class Replay${i} {
  var stop: String?, identityField: String?, vmPID: Int32 = 7, vmStart: UInt64? = 10_000_001
  var vmWindow = 70, vmTitle = "vm", vmBounds: CGRect? = CGRect(x: 0, y: 0, width: 100, height: 100)
  var ownerPresent = false, captureReadAt = -Double.infinity, captureReads = 0
  func fault(_ s: String, read: String = "", value: String? = nil, pid: Int32 = 0) { if stop == nil { stop = s } }
  func identityFault(_ s: String) { if stop == nil { identityField = s; fault("IDENTITY_CHANGED") } }
  func captureState() -> Bool? { false }
${change(identity).replaceAll('processStart(', `${retryName}(`)}
${change(vmCheck).replaceAll('processStart(', `${retryName}(`)}
  func run(_ input: [String: Any]) -> [String: Any] {
    reads = 0; pauses = 0; births = input["births"] as? [Any] ?? [10_000_001]
    let app = NSRunningApplication(); app.launchDate = (input["launch"] as? Double).map { Date(timeIntervalSince1970: $0) }
    let fixtureBirth = identity(app)
    let fixtureReads = reads
    stop = nil; reads = 0; pauses = 0
    let currentPID = input["pid"] as? Int ?? 7
    let rows: [[String: Any]] = [["pid": currentPID, "id": 70, "title": "vm", "frame": vmBounds!.dictionaryRepresentation]]
    checkVM(rows, readStart: { pid in readBirth(pid) }, readCapture: { false }, clock: { 1 })
    // Exercise the same retry code with a fake sleeper for exact bounds, without host calls.
    reads = 0; pauses = 0
    _ = ${retryName}(7, read: { readBirth($0) }, pause: { pauses += 1 })
    return ["stop": stop as Any? ?? NSNull(), "field": identityField as Any? ?? NSNull(),
      "fixtureBirth": fixtureBirth as Any? ?? NSNull(), "fixtureReads": fixtureReads, "reads": reads, "pauses": pauses]
  }
}
func run${i}(_ input: [String: Any]) -> [String: Any] { Replay${i}().run(input) }
`;
      }).join('\n');
      const program = `import Foundation
import CoreGraphics
import Darwin
var births: [Any] = [], reads = 0, pauses = 0
func readBirth(_ pid: Int32) -> UInt64? {
  let value = births[min(reads, births.count - 1)]; reads += 1
  return (value as? NSNumber)?.uint64Value
}
func kernelInfo(_ pid: Int32) -> (start: UInt64, ppid: Int32)? { readBirth(pid).map { ($0, 1) } }
final class NSRunningApplication { var processIdentifier: Int32 = 7; var launchDate: Date? }
let kCGWindowOwnerPID = "pid", kCGWindowNumber = "id", kCGWindowName = "title"
func num(_ w: [String: Any], _ key: String) -> Int { w[key] as? Int ?? -1 }
func bounds(_ w: [String: Any]) -> CGRect? { (w["frame"] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } }
func uncovered(_ rows: [[String: Any]], pid: Int32, window: Int) -> Bool { true }
${classes}
let runs = [${Array.from({ length: variants.length + 1 }, (_, i) => `run${i}`).join(', ')}]
while let line = readLine() {
  let row = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
  let results = runs.map { $0(row) }
  FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: results)); FileHandle.standardOutput.write(Data([10]))
}
`;
      writeFileSync(join(bank, 'identity.swift'), program);
      const binary = join(bank, 'identity');
      const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'identity.swift'), '-o', binary],
        { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
      assert.equal(build.status, 0, build.stderr);
      const cases = [
        ['nil launch date', {}, null, null, 10_000_001, 1, 0],
        ['changed launch date', { launch: 99 }, null, null, 10_000_001, 1, 0],
        ['new pid', { pid: 8 }, 'IDENTITY_CHANGED', 'WINDOW_COUNT', 10_000_001, 1, 0],
        ['one microsecond birth change', { births: [10_000_002] }, 'IDENTITY_CHANGED', 'PROCESS_START', 10_000_002, 1, 0],
        ['persistent unreadable', { births: [null] }, 'PROCESS_START_UNREADABLE', null, null, 3, 2],
        ['second read recovers', { births: [null, 10_000_001] }, null, null, 10_000_001, 2, 1],
        ['third read recovers', { births: [null, null, 10_000_001] }, null, null, 10_000_001, 3, 2],
        ['zero birth refuses', { births: [0] }, 'PROCESS_START_UNREADABLE', null, null, 3, 2],
      ];
      const replay = spawnSync(binary, [], { input: cases.map(([, input]) => JSON.stringify(input)).join('\n') + '\n',
        encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
      assert.equal(replay.status, 0, replay.stderr);
      const rows = replay.stdout.trim().split('\n').map(JSON.parse);
      const expected = ([, , stop, field, fixtureBirth, reads, pauses]) => ({ stop, field, fixtureBirth, fixtureReads: reads, reads, pauses });
      for (const [i, c] of cases.entries()) await t.test(c[0], () => assert.deepEqual(rows[i][0], expected(c)));
      for (const [i, [name]] of variants.entries()) await t.test(`broken ${name} fails the same assertions`, () => {
        assert.ok(cases.some((c, j) => {
          try { assert.deepEqual(rows[j][i + 1], expected(c)); return false; } catch { return true; }
        }), `${name} survived`);
      });
    } finally { rmSync(bank, { recursive: true, force: true }); }
  });
