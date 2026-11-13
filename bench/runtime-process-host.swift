import Foundation
import Darwin
import CoreFoundation

// RT13's headless process-table witness. It never initializes AppKit, generates
// input, inspects windows or signals processes. EOF collects the owned child.
func validRequest(_ row: [String: Any]) -> Bool {
    if Set(row.keys) == ["op"] { return row["op"] as? String == "inventory" }
    guard let pid = row["pid"] as? NSNumber, CFGetTypeID(pid) != CFBooleanGetTypeID(),
          pid.doubleValue == Double(pid.int64Value), pid.int64Value > 0, pid.int64Value <= Int32.max else { return false }
    return Set(row.keys) == ["op", "pid", "started", "path"] && row["op"] as? String == "rss" &&
        (row["started"] as? String).map({ !$0.isEmpty && $0.count <= 64 }) == true &&
        (row["path"] as? String).map({ $0.hasPrefix("/") && $0.utf8.count <= 4096 }) == true
}
func emit(_ row: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(70) }
    do { try FileHandle.standardOutput.write(contentsOf: bytes + Data([10])) } catch { exit(0) }
}
// Observations are source/evidence reads, not live qualification on this Mac.
// Glide engine: mac-driver/build.mjs prepareMacDriver builds the bare
// glide-engine artifact in its mac-driver cache. ChatGPT engine: ledger/vc/R4-engine-cursor.md
// (2026-10-26) observed this app/executable; lib/setup.mjs HELPER_REL also names it.
// Keep names and path predicates together. --dry-run prints these rules and every
// candidate it sees so the first live qualification can confirm the exact paths.
let classifiers: [[String: String]] = [
    ["kind": "drivers", "name": "glide-engine", "pathContains": "/mac-driver/",
     "observedAt": "RT2 plugins/sleight/lib/mac-driver/build.mjs prepareMacDriver (2026-10-31 source read)"],
    ["kind": "helpers", "name": "SkyComputerUseService",
     "pathSuffix": "/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
     "observedAt": "ledger/vc/R4-engine-cursor.md (2026-10-26); plugins/sleight/lib/setup.mjs HELPER_REL"]
]
func candidate(_ path: String) -> [String: String]? {
    if let kind = classify(path) { return classifiers.first { $0["kind"] == kind } }
    let name = (path as NSString).lastPathComponent
    return classifiers.first { name == $0["name"] ||
        ($0["kind"] == "helpers" && (name.hasPrefix($0["name"]!) ||
            path.contains(($0["pathSuffix"]! as NSString).deletingLastPathComponent + "/"))) ||
        ($0["kind"] == "drivers" && path.contains($0["pathContains"]!)) }
}
func classify(_ path: String) -> String? {
    let name = (path as NSString).lastPathComponent
    return classifiers.first { rule in
        name == rule["name"] && (rule["pathContains"].map({ path.contains($0) }) ?? true) &&
            (rule["pathSuffix"].map({ path.hasSuffix($0) }) ?? true)
    }?["kind"]
}
if CommandLine.arguments.dropFirst() == ["--dump-classifiers"] {
    emit(["classifiers": classifiers, "windowsCreated": 0, "inputGenerated": false, "processesStarted": 0]); exit(0)
}
if CommandLine.arguments.dropFirst() == ["--validate"] {
    let bytes = FileHandle.standardInput.readDataToEndOfFile()
    let row = bytes.count <= 1024 ? (try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]) : nil
    let valid = row.map(validRequest) ?? false
    emit(["valid": valid, "windowsCreated": 0]); exit(valid ? 0 : 65)
}
if CommandLine.arguments.dropFirst() == ["--selftest"] {
    guard classify("/engine/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService") == "helpers",
          classify("/cache/mac-driver/build/glide-engine") == "drivers",
          classify("/cache/glide-engine") == nil,
          classify("/engine/SkyComputerUseService-other") == nil,
          candidate("/engine/SkyComputerUseService-other")?["kind"] == "helpers",
          candidate("/engine/Codex Computer Use.app/Contents/MacOS/renamed-helper")?["kind"] == "helpers",
          classify("/other/SkyComputerUseService") == nil,
          candidate("/cache/mac-driver/build/renamed-driver")?["kind"] == "drivers",
          candidate("/unrelated/application") == nil else { exit(70) }
    emit(["checks": 9, "windowsCreated": 0, "inputGenerated": false]); exit(0)
}
struct ProcessRow {
    let pid: pid_t
    let started: String
    let path: String?
}
enum InventoryFault: Error { case unavailable, incomplete }
func readProcessTable() throws -> [ProcessRow] {
    let count = proc_listallpids(nil, 0)
    guard count > 0 else { throw InventoryFault.unavailable }
    var pids = [pid_t](repeating: 0, count: Int(count) + 4096)
    let bytes = Int32(pids.count * MemoryLayout<pid_t>.stride)
    let used = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, bytes) }
    guard used > 0 && used < pids.count else { throw InventoryFault.incomplete }
    var rows = [ProcessRow]()
    for pid in pids.prefix(Int(used)) where pid > 0 {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
        let got = withUnsafeMutablePointer(to: &info) { proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, size) }
        if got != size { continue } // A process may exit between the two table reads.
        guard info.pbi_uid == getuid() else { continue }
        // Swift cannot import libproc's compound macro (4 * MAXPATHLEN).
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = buffer.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
        // Zombies have no executable. Other unreadable peers are counted below.
        if length <= 0 && info.pbi_status == 5 { continue }
        rows.append(ProcessRow(pid: pid, started: "\(info.pbi_start_tvsec).\(info.pbi_start_tvusec)",
            path: length > 0 ? String(cString: buffer) : nil))
    }
    return rows
}
// Targeted memory read, bound to a driver seen in the independent inventory.
// Recheck identity after the task read so PID reuse never supplies a sample.
func residentMemory(_ row: [String: Any]) -> [String: Any] {
    guard let pid = row["pid"] as? Int32, let started = row["started"] as? String,
          let path = row["path"] as? String, classify(path) == "drivers" else { return ["error": "HELPER_IDENTITY_UNAVAILABLE"] }
    func matches() -> Bool {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
        let got = withUnsafeMutablePointer(to: &info) { proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, size) }
        guard got == size, info.pbi_uid == getuid(), started == "\(info.pbi_start_tvsec).\(info.pbi_start_tvusec)" else { return false }
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = buffer.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
        return length > 0 && String(cString: buffer) == path
    }
    guard matches() else { return ["error": "HELPER_IDENTITY_UNAVAILABLE"] }
    var info = proc_taskinfo()
    let size = Int32(MemoryLayout<proc_taskinfo>.stride)
    let got = withUnsafeMutablePointer(to: &info) { proc_pidinfo(pid, PROC_PIDTASKINFO, 0, $0, size) }
    guard got == size, info.pti_resident_size > 0, matches() else { return ["error": "HELPER_RSS_UNAVAILABLE"] }
    return ["pid": pid, "started": started, "path": path, "rssBytes": info.pti_resident_size]
}
func inventory(_ rows: [ProcessRow], diagnostic: Bool = false) -> [String: Any] {
    var result: [String: [[String: Any]]] = ["helpers": [], "drivers": [], "nearMisses": []]
    var sightings = [[String: Any]](), unreadable = 0
    for row in rows {
        guard let path = row.path else { unreadable += 1; continue }
        if let rule = candidate(path) {
            let kind = classify(path) ?? "nearMisses"
            let process: [String: Any] = ["pid": row.pid, "path": path, "started": row.started]
            let sighting = process.merging(["expectedKind": rule["kind"]!, "classified": kind]) { _, new in new }
            sightings.append(sighting)
            result[kind]!.append(kind == "nearMisses" ? sighting : process)
        }
    }
    let counts = ["helpers": result["helpers"]!.count, "drivers": result["drivers"]!.count,
        "nearMisses": result["nearMisses"]!.count, "unreadable": unreadable]
    if diagnostic {
        return ["schema": "sleight.runtime-process-diagnostic/1", "classifiers": classifiers,
            "sightings": sightings, "inventory": result, "counts": counts,
            "windowsCreated": 0, "inputGenerated": false,
            "processesStarted": 0]
    }
    var output: [String: Any] = result
    output["counts"] = counts
    return output
}
var arguments = Array(CommandLine.arguments.dropFirst())
var fixtureRows: [ProcessRow]?
#if RT13_PROCESS_FIXTURES
// Only test builds accept a synthetic table, before any libproc call. The first
// stdin line is the table; --serve consumes ordinary requests after that line.
if arguments.last == "--fixture-stdin" {
    arguments.removeLast()
    guard let line = readLine(), line.utf8.count <= 1048576,
          let raw = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [[String: Any]] else { exit(65) }
    var rows = [ProcessRow]()
    for row in raw {
        guard let pid = row["pid"] as? Int32, pid > 0, let started = row["started"] as? String,
              !started.isEmpty, row["path"] is String || row["path"] is NSNull else { exit(65) }
        rows.append(ProcessRow(pid: pid, started: started, path: row["path"] as? String))
    }
    fixtureRows = rows
}
#endif
let dryRun = arguments == ["--dry-run"]
guard dryRun || arguments == ["--serve"] else { exit(64) }
func snapshot(diagnostic: Bool = false) -> [String: Any] {
    do { return inventory(try fixtureRows ?? readProcessTable(), diagnostic: diagnostic) }
    catch InventoryFault.incomplete { return ["error": "PROCESS_INVENTORY_INCOMPLETE"] }
    catch { return ["error": "PROCESS_INVENTORY_UNAVAILABLE"] }
}
if dryRun { let row = snapshot(diagnostic: true); emit(row); exit(row["error"] == nil ? 0 : 70) }
while let line = readLine() {
    guard line.utf8.count <= 1024, let data = line.data(using: .utf8),
          let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any], validRequest(row) else {
        emit(["error": "INVALID_REQUEST"]); continue
    }
    emit(row["op"] as? String == "rss" ? residentMemory(row) : snapshot())
}
