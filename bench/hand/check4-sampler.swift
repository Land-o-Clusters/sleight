// Metadata-only 20 Hz observer. Never creates NSApplication, windows, images or input events.
import CoreGraphics
import Foundation
import Darwin
import QuartzCore
import ApplicationServices

func clockMs() -> Double { CACurrentMediaTime() * 1000 }
func emit(_ row: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(70) }
    FileHandle.standardOutput.write(data + Data([10]))
}
func rectangle(_ raw: Any?) -> [Double]? {
    // JSON fixtures contain Double; native AXValue and CGRect accessors produce CGFloat.
    guard let a = (raw as? [Double]) ?? (raw as? [CGFloat])?.map({ Double($0) }),
        a.count == 4, a.allSatisfy({ $0.isFinite }), a[2] > 0, a[3] > 0 else { return nil }
    return a
}
func touching(_ a: [Double], _ b: [Double]) -> Bool {
    a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2] && a[1] <= b[1] + b[3] && b[1] <= a[1] + a[3]
}
func expanded(_ r: [Double]) -> [Double] { [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96] }
func sample(_ t: Double, _ status: [String: Any]?, _ windows: [[String: Any]]?, _ pids: [Int], _ lastValidStatus: [String: Any]?, _ accessibility: [[String: Any]] = []) -> [String: Any] {
    let host = status ?? [:]
    let statusTime = host["hostTimeMs"] as? Double
    let wide = host["wideWindows"] as? [[String: Any]], protected = host["protectedRects"] as? [Any]
    let valid = statusTime != nil && t >= statusTime! && t - statusTime! <= 100 && host["pid"] is Int && wide != nil && protected != nil &&
        wide!.allSatisfy { $0["pid"] is Int && $0["id"] is Int } && protected!.allSatisfy { rectangle($0) != nil }
    let protection = valid && windows != nil ? status : lastValidStatus
    let identity = protection ?? host
    var list = windows ?? []
    if let panel = accessibilityPanel(identity, accessibility) {
        list.removeAll { ($0["pid"] as? Int) == (identity["pid"] as? Int) && ($0["id"] as? Int) == (identity["panelID"] as? Int) }
        list.append(panel)
    }
    let panels = list.filter { ($0["pid"] as? Int) == (identity["pid"] as? Int) && ($0["id"] as? Int) == (identity["panelID"] as? Int) && rectangle($0["frame"]) != nil }
    let onScreen = panels.count == 1 && (panels[0]["alpha"] as? Double ?? 0) > 0
    let frame = panels.count == 1 ? rectangle(panels[0]["frame"]) : nil
    var hits: [[String: Any]] = []
    if let protection = protection, onScreen, let panel = frame {
        for key in protection["wideWindows"] as? [[String: Any]] ?? [] {
            for window in list where (window["pid"] as? Int) == (key["pid"] as? Int) && (window["id"] as? Int) == (key["id"] as? Int) {
                if let r = rectangle(window["frame"]), (window["alpha"] as? Double ?? 0) > 0, touching(panel, expanded(r)) {
                    hits.append(["kind": "wide-window", "pid": key["pid"]!, "id": key["id"]!, "frame": expanded(r)])
                }
            }
        }
        for (index, raw) in (protection["protectedRects"] as? [Any] ?? []).enumerated() {
            if let r = rectangle(raw), touching(panel, r) { hits.append(["kind": "protected-rectangle", "index": index, "frame": r]) }
        }
    }
    var panel: [String: Any] = ["pid": identity["pid"] ?? NSNull(), "id": identity["panelID"] ?? NSNull(), "onScreen": onScreen,
        "frame": frame as Any? ?? NSNull(), "alpha": panels.count == 1 ? panels[0]["alpha"] ?? 0 : 0]
    if panels.count == 1, let source = panels[0]["source"] { panel["source"] = source }
    return ["t": t, "source": "CGWindowListCopyWindowInfo", "valid": valid && windows != nil, "status": status as Any? ?? NSNull(),
        "panel": panel, "independentArt": onScreen ? frame as Any? ?? NSNull() : NSNull(),
        "artIntersections": hits.map { hit in hit.filter { $0.key != "frame" } },
        "windows": list.filter { pids.contains($0["pid"] as? Int ?? -1) }, "intersections": hits]
}
// Only the private host labels its character panel. No position, size or visibility comes from host diagnostics.
func accessibilityPanel(_ status: [String: Any]?, _ rows: [[String: Any]]) -> [String: Any]? {
    guard let pid = status?["pid"] as? Int, pid > 0, let id = status?["panelID"] as? Int, id > 0 else { return nil }
    let matches = rows.filter { ($0["pid"] as? Int) == pid && ($0["title"] as? String) == "sleight check 4 character" &&
        ($0["identifier"] as? String) == "sleight.check4.character" && ($0["role"] as? String) == "AXWindow" }
    guard matches.count == 1, let row = matches.first, row["hidden"] as? Bool == false,
        row["minimized"] as? Bool == false, let frame = rectangle(row["frame"]) else { return nil }
    return ["pid": pid, "id": id, "layer": 3, "alpha": 1.0, "frame": frame, "source": "Accessibility"]
}
func accessibilityWindows(_ status: [String: Any]?, diagnostic: inout [String: Any]) -> [[String: Any]] {
    diagnostic = ["trusted": AXIsProcessTrusted()]
    guard let pid = status?["pid"] as? Int, pid > 0, pid <= Int(Int32.max), AXIsProcessTrusted() else { return [] }
    let app = AXUIElementCreateApplication(Int32(pid))
    AXUIElementSetMessagingTimeout(app, 0.02)
    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        if error != .success { diagnostic[name + "Error"] = error.rawValue; return nil }
        return value
    }
    let hidden = attribute(app, kAXHiddenAttribute) as? Bool
    diagnostic["hidden"] = hidden as Any? ?? NSNull()
    guard hidden == false, let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement], windows.count <= 16 else { return [] }
    diagnostic["windowCount"] = windows.count
    var candidates: [[String: Any]] = []
    return windows.compactMap { window in
        AXUIElementSetMessagingTimeout(window, 0.02)
        var owner: pid_t = 0
        let ownerError = AXUIElementGetPid(window, &owner)
        let title = attribute(window, kAXTitleAttribute) as? String
        let identifier = attribute(window, kAXIdentifierAttribute) as? String
        let role = attribute(window, kAXRoleAttribute) as? String
        let minimized = attribute(window, kAXMinimizedAttribute) as? Bool
        candidates.append(["pid": Int(owner), "ownerError": ownerError.rawValue, "title": title as Any? ?? NSNull(),
            "identifier": identifier as Any? ?? NSNull(), "role": role as Any? ?? NSNull(), "minimized": minimized as Any? ?? NSNull()])
        diagnostic["candidates"] = candidates
        guard ownerError == .success, owner == Int32(pid), title == "sleight check 4 character",
            identifier == "sleight.check4.character", let role = role, let minimized = minimized,
            let position = attribute(window, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
            let size = attribute(window, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
        return ["pid": Int(owner), "title": title, "identifier": identifier, "role": role, "hidden": hidden,
            "minimized": minimized, "frame": [point.x, point.y, extent.width, extent.height]]
    }
}
// Same metadata extraction as capture.swift. Geometry is always taken from this independent WindowServer query.
func windowList(_ status: [String: Any]? = nil) -> [[String: Any]]? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    var observed = list
    // A capture-hidden panel may be absent from the broad census. Ask WindowServer for that one ID as well;
    // its own on-screen flag and owner must agree. Never substitute a rectangle reported by the host.
    if let extra = hostWindowMetadata(status, list) { observed.append(extra) }
    return observed.compactMap { info in
        guard let id = info[kCGWindowNumber as String] as? Int, let pid = info[kCGWindowOwnerPID as String] as? Int,
              let layer = info[kCGWindowLayer as String] as? Int, let raw = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
        return ["pid": pid, "id": id, "layer": layer, "alpha": info[kCGWindowAlpha as String] as? Double ?? 1,
            "frame": [bounds.minX, bounds.minY, bounds.width, bounds.height]]
    }
}
func hostWindowMetadata(_ status: [String: Any]?, _ list: [[String: Any]],
    query: (CGWindowListOption, CGWindowID) -> CFArray? = { CGWindowListCopyWindowInfo($0, $1) }) -> [String: Any]? {
    guard let pid = status?["pid"] as? Int, let id = status?["panelID"] as? Int, pid > 0, id > 0, id <= Int(UInt32.max),
        !list.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowNumber as String] as? Int) == id }),
        let rows = query(.optionIncludingWindow, UInt32(id)) as? [[String: Any]], rows.count == 1,
        let row = rows.first, (row[kCGWindowOwnerPID as String] as? Int) == pid,
        (row[kCGWindowNumber as String] as? Int) == id, row[kCGWindowIsOnscreen as String] as? Bool == true else { return nil }
    return row
}
func jsonFile(_ path: String) -> [String: Any]? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)), data.count <= 4 * 1024 * 1024 else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}
let args = Array(CommandLine.arguments.dropFirst())
var lastValidStatus: [String: Any]?
func observe(_ t: Double, _ status: [String: Any]?, _ windows: [[String: Any]]?, _ pids: [Int], _ accessibility: [[String: Any]] = []) -> [String: Any] {
    let row = sample(t, status, windows, pids, lastValidStatus, accessibility)
    if row["valid"] as? Bool == true { lastValidStatus = status }
    return row
}
if args == ["--selftest"] {
    // Fake window lists pass through the exact same sampler used live. No window-list read occurs in this mode.
    while let line = readLine() {
        guard line.utf8.count <= 1024 * 1024, let data = line.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let t = row["t"] as? Double else { exit(65) }
        emit(observe(t, row["status"] as? [String: Any], row["windows"] as? [[String: Any]], row["appPids"] as? [Int] ?? [], row["accessibility"] as? [[String: Any]] ?? []))
    }
    exit(0)
}
guard args.count == 4, args[0] == "--status", args[2] == "--pids" else { exit(64) }
let statusPath = args[1], pidsPath = args[3]
var previous: Double?
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .milliseconds(50), leeway: .milliseconds(1))
timer.setEventHandler {
    let status = jsonFile(statusPath), pids = jsonFile(pidsPath)?["pids"] as? [Int] ?? []
    var diagnostic: [String: Any] = [:]
    let windows = windowList(status), accessibility = accessibilityWindows(status ?? lastValidStatus, diagnostic: &diagnostic), t = clockMs()
    var row = observe(t, status, windows, pids, accessibility)
    row["accessibilityTrusted"] = AXIsProcessTrusted()
    row["accessibilityRead"] = diagnostic
    // Only live rows need a wall-clock anchor for bench/run's epoch timestamps. Self-test geometry stays unchanged.
    row["epochMs"] = Date().timeIntervalSince1970 * 1000
    row["appPids"] = pids
    if let before = previous, t - before > 100 { row["gapMs"] = t - before }
    previous = t; emit(row)
}
var commandBuffer = Data()
FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { DispatchQueue.main.async { timer.cancel(); exit(0) }; return }
    commandBuffer.append(data)
    if commandBuffer.count > 8192 { exit(65) }
    while let end = commandBuffer.firstIndex(of: 10) {
        let line = commandBuffer.prefix(upTo: end); commandBuffer.removeSubrange(...end)
        guard let row = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let label = row["mark"] as? String, ["driving-start", "driving-end"].contains(label) else { exit(65) }
        DispatchQueue.main.async { emit(["mark": label, "t": clockMs()]) }
    }
}
timer.resume()
dispatchMain()
