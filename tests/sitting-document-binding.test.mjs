import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
const slice = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));
// Execute the actual binding method with synthetic AX and CG metadata. These
// executables contain no AppKit startup, host inspection, window or input calls.
const program = `import Foundation
import CoreFoundation
import CoreGraphics
import Darwin
final class Element: NSObject { var values: [String: Any] = [:] }
typealias AXUIElement = Element
let kCGWindowOwnerPID = "pid", kCGWindowLayer = "layer", kCGWindowNumber = "id", kCGWindowName = "title"
var rows: [[String: Any]]?, ax = Element()
func windows() -> [[String: Any]]? { rows }
func num(_ row: [String: Any], _ key: String) -> Int { row[key] as? Int ?? -1 }
func bounds(_ row: [String: Any]) -> CGRect? { (row["frame"] as? [Double]).map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) } }
func rect(_ e: Element) -> CGRect? { bounds(e.values) }
func attr(_ e: Element, _ key: String) -> Any? { e.values[key] }
func AXUIElementCreateApplication(_ pid: Int32) -> Element { ax }
func AXUIElementSetMessagingTimeout(_ e: Element, _ seconds: Double) {}
final class NSRunningApplication {
    var launchDate: Date?, processIdentifier: Int32 = 7
    init(_ date: Date?) { launchDate = date }
    static var apps: [NSRunningApplication] = []
    static func runningApplications(withBundleIdentifier: String) -> [NSRunningApplication] { apps }
}
${slice('func fixtureTitle(', 'func ownedDocument(')}
${slice('func fixtureCandidate(', '// realpath(3)')}
${slice('func canonicalPath(', 'func discardAllowed(')}
final class Replay {
    var pendingDocument: PendingDocument?, launchPermits = Set(["com.apple.TextEdit"])
    var own = Set<Int32>(), ownStarts: [Int32: UInt64] = [:]
    var fixtureBindings: [Int32: [(window: AXUIElement, target: String)]] = [:]
    let started: UInt64 = 10
    func identity(_ app: NSRunningApplication) -> UInt64? { app.launchDate.map { UInt64($0.timeIntervalSince1970) } }
${slice('    func bindDocument()', '    func cleanupTick()')}
}
while let line = readLine() {
    let data = line.data(using: .utf8)!, input = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    let replay = Replay(), target = "/fixture/SIT1-owned.txt", first = Element()
    if input["pending"] as? Bool != false { replay.pendingDocument = PendingDocument(target: target, before: [1]) }
    if input["permit"] as? Bool == false { replay.launchPermits = [] }
    if input["previous"] as? Bool == true { replay.ownStarts[7] = 19 }
    NSRunningApplication.apps = (0..<(input["instances"] as? Int ?? 1)).map { _ in NSRunningApplication(input["dateNil"] as? Bool == true ? nil : Date(timeIntervalSince1970: input["date"] as? Double ?? 20)) }
    let row: [String: Any] = ["pid": 7, "layer": 0, "id": input["cgID"] as? Int ?? 2,
        "title": input["cgTitle"] as? String ?? "SIT1-owned.txt", "frame": input["cgFrame"] as? [Double] ?? [0, 0, 640, 480]]
    var cgRows = [row]
    if input["extraCG"] as? Bool == true { var extra = row; extra["id"] = 4; cgRows.append(extra) }
    rows = input["windowsNil"] as? Bool == true ? nil : input["fresh"] as? Bool == false ? [] : cgRows
    first.values = ["frame": input["axFrame"] as? [Double] ?? [0, 0, 640, 480]]
    if input["titleNil"] as? Bool != true { first.values["AXTitle"] = input["title"] as? String ?? "SIT1-owned.txt" }
    first.values["AXDocument"] = input["path"] as? String ?? "file:///fixture/SIT1-owned.txt"
    if input["frameNil"] as? Bool == true { first.values.removeValue(forKey: "frame") }
    let second = Element(); second.values = first.values
    ax = Element()
    if input["axNil"] as? Bool != true { ax.values["AXWindows"] = Array([first, second].prefix(input["candidates"] as? Int ?? 1)) }
    var result = replay.bindDocument()
    if let change = input["retry"] as? String {
        if change == "settle" { first.values["frame"] = [0.0, 0.0, 640.0, 480.0] }
        if change == "ax" { second.values["frame"] = [0.0, 0.0, 640.0, 480.0]; ax.values["AXWindows"] = [second] }
        if change == "lateAX" { second.values["frame"] = [0.0, 0.0, 640.0, 480.0]; ax.values["AXWindows"] = [first, second] }
        if change == "extraAX" { first.values["frame"] = [0.0, 0.0, 640.0, 480.0]; second.values["frame"] = first.values["frame"]; ax.values["AXWindows"] = [first, second] }
        if change == "cg" { var next = row; next["id"] = 3; next["frame"] = [5.0, 0.0, 640.0, 480.0]; rows = [next] }
        if change == "process" { NSRunningApplication.apps[0].processIdentifier = 8 }
        result = replay.bindDocument()
    }
    var output = result.reply(pending: replay.pendingDocument != nil)
    output["drawing"] = false
    output["bound"] = replay.fixtureBindings.values.flatMap { $0 }.count
    if let value = input["normalize"] as? String { output["path"] = documentPathValue(value) as Any? ?? NSNull() }
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: output)); FileHandle.standardOutput.write(Data([10]))
}
`;
const cases = [
  [{}, 'BOUND'], [{ pending: false }, 'NO_PENDING_DOCUMENT'], [{ windowsNil: true }, 'WINDOWS_UNAVAILABLE'],
  [{ instances: 0 }, 'INSTANCE_COUNT'], [{ instances: 2 }, 'INSTANCE_COUNT'],
  [{ permit: false }, 'LAUNCH_PERMIT_REQUIRED'], [{ dateNil: true }, 'PROCESS_START_UNREADABLE'], [{ date: 9 }, 'PROCESS_START_INVALID'],
  [{ previous: true }, 'PROCESS_START_CHANGED'], [{ axNil: true }, 'AX_WINDOWS_UNAVAILABLE'],
  [{ fresh: false }, 'NO_FRESH_CG_WINDOW'], [{ cgID: 1 }, 'NO_FRESH_CG_WINDOW'],
  [{ title: 'SIT1-other.txt' }, 'TITLE_PATH_MISMATCH'], [{ path: 'file:///other/SIT1-owned.txt' }, 'TITLE_PATH_MISMATCH'],
  [{ frameNil: true }, 'FRAME_MISMATCH'],
  [{ axFrame: [0.5, 0, 640, 480] }, 'FRAME_MISMATCH'], [{ candidates: 2 }, 'CANDIDATE_COUNT', 2],
  [{ candidates: 2, axFrame: [5, 0, 640, 480] }, 'CANDIDATE_COUNT', 0],
  [{ titleNil: true }, 'BOUND'], [{ titleNil: true, cgTitle: 'SIT1-other.txt' }, 'TITLE_PATH_MISMATCH'],
  [{ title: '', cgTitle: 'SIT1-owned.txt' }, 'TITLE_PATH_MISMATCH'],
  ...['file:///.file/id=6571367.12', '/.file/id=6571367.12', 'not-a-path', 'file:relative', 'https://example.invalid/file'].map(path => [{ path }, 'BOUND']),
  [{ axFrame: [5, 0, 640, 480], retry: 'settle' }, 'BOUND'],
  [{ titleNil: true, path: 'file:///.file/id=6571367.12', axFrame: [5, 0, 640, 480], retry: 'lateAX' }, 'BOUND'],
  [{ titleNil: true, path: 'file:///.file/id=6571367.12', axFrame: [5, 0, 640, 480], retry: 'extraAX' }, 'CANDIDATE_COUNT', 2],
  [{ axFrame: [5, 0, 640, 480], retry: 'ax' }, 'TITLE_PATH_MISMATCH'],
  [{ axFrame: [5, 0, 640, 480], extraCG: true, retry: 'ax' }, 'TITLE_PATH_MISMATCH'],
  [{ axFrame: [5, 0, 640, 480], retry: 'cg' }, 'TITLE_PATH_MISMATCH'],
  [{ axFrame: [5, 0, 640, 480], retry: 'process' }, 'PROCESS_START_CHANGED'],
  ...['/fixture/SIT1-owned.txt', 'file:///fixture/SIT1-owned.txt'].map(normalize => [{ normalize }, 'BOUND', undefined, '/fixture/SIT1-owned.txt']),
  ...['file:///.file/id=6571367.12', '/.file/id=6571367.12', 'relative', 'file:relative', 'https://example.invalid/file',
    'file://otherhost/fixture/SIT1-owned.txt', '//fixture/SIT1-owned.txt'].map(normalize => [{ normalize }, 'BOUND', undefined, null]),
];
function failures(binary) {
  const run = spawnSync(binary, [], { input: cases.map(([input]) => JSON.stringify(input)).join('\n') + '\n',
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, run.stderr);
  const rows = run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, cases.length);
  return cases.flatMap(([input, code, count, path], i) => {
    const expected = { reply: 'bind-document', bindCode: code, pendingDocument: code !== 'BOUND' && code !== 'NO_PENDING_DOCUMENT',
      ...(code === 'BOUND' ? { ok: true } : { error: 'FIXTURE_BINDING_REQUIRED' }),
      ...(count !== undefined && { candidateCount: count }), drawing: false, bound: code === 'BOUND' ? 1 : 0,
      ...(input.normalize !== undefined && { path }) };
    try { assert.deepEqual(rows[i], expected); return []; } catch { return [{ input, expected, actual: rows[i] }]; }
  });
}
test('binding diagnostics, macOS 27 metadata and pinned retry identities use the production method', { skip: process.platform !== 'darwin', timeout: 900000 }, async t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-binding-')));
  try {
    const real = join(realpathSync(bank), 'real'), link = join(bank, 'linked');
    mkdirSync(real); symlinkSync(real, link);
    const target = join(real, 'SIT1-owned.txt'); writeFileSync(target, 'fixture');
    // Existing paths resolve symlinks and keep /private; vanished paths stay raw.
    for (const normalize of [join(link, 'SIT1-owned.txt'), 'file://' + join(link, 'SIT1-owned.txt'),
      'file://localhost' + join(link, 'SIT1-owned.txt')]) cases.push([{ normalize }, 'BOUND', undefined, target]);
    const vanished = join(link, 'SIT1-vanished.txt');
    cases.push([{ normalize: vanished }, 'BOUND', undefined, vanished]);
    const compile = text => {
      writeFileSync(join(bank, 'binding.swift'), text);
      const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'binding.swift'), '-o', join(bank, 'binding')],
        { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
      assert.equal(built.status, 0, built.stderr);
      return join(bank, 'binding');
    };
    assert.deepEqual(failures(compile(program)), []);
    t.diagnostic(`${cases.length} offline binding fixtures`);
    // Each code is observed by a fixture and must fail when that diagnostic is lost.
    const codes = [...new Set(cases.map(([, code]) => code))].filter(code => code !== 'BOUND');
    const mutations = [
      ...codes.map(code => [code, `code: "${code}"`, 'code: "BROKEN"']),
      ['file-reference fallback', '!path.hasPrefix("/.file/")', 'true'],
      ['remote file host', 'url.host == nil || url.host == "" || url.host == "localhost"', 'true'],
      ['network path guard', '!value.hasPrefix("//")', 'true'],
      ['real canonical path', 'return canonicalPath(path) ?? path', 'return path'],
      ['vanished path fallback', 'return canonicalPath(path) ?? path', 'return canonicalPath(path)'],
      ['CG title fallback', '?? row[kCGWindowName as String] as? String ?? ""', '?? ""'],
      ['unverified nil-title pin', ' && attr(eligible[0], "AXTitle") as? String != nil', ''],
      ['AX identity pin', '(pending.window == nil || CFEqual(pending.window!, w))', 'true'],
      ['CG identity pin', 'pending.cgWindow == nil || pending.cgWindow == num(row, kCGWindowNumber)', 'true'],
      ['process pin', 'expected != pid || pending.start != date', 'false'],
    ];
    for (const [name, before, after] of mutations) await t.test(`broken ${name}`, () => {
      assert.ok(program.includes(before));
      const broken = failures(compile(program.replaceAll(before, after)));
      assert.ok(broken.length, `${name} survived`);
      t.diagnostic(`${broken.length} failing fixtures`);
    });
  } finally { rmSync(bank, { recursive: true, force: true }); }
});
