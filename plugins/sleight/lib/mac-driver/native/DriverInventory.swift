import AppKit
import ApplicationServices

// A successful CG row omits this optional key for off-screen windows. Preserve
// explicit null or malformed values so genuinely unreadable state fails closed.
func driverOnScreen(_ value: Any?) -> Any { value ?? false }

func driverStart(_ pid: pid_t) -> String? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_start_tvsec > 0 else { return nil }
    return "\(info.pbi_start_tvsec).\(info.pbi_start_tvusec)"
}

final class DriverInventory {
    let fixture: DriverObject?
    private var polls = 0
    private var lastWindows: [DriverObject] = []
    init(fixture: DriverObject? = nil) { self.fixture = fixture }
    func state() -> DriverObject {
        if let fixture = fixture {
            polls += 1
            let snapshots = fixture["windowSnapshots"] as? [[DriverObject]]
            let snapshot = snapshots?.isEmpty == false ? snapshots![min(polls - 1, snapshots!.count - 1)] : nil
            let windows: Any = polls <= (driverInteger(fixture["windowPollsBeforeReady"]) ?? 0) ? [] : snapshot ?? fixture["windows"] ?? []
            lastWindows = (windows as? [DriverObject] ?? []).map { row in
                var current = row; current["onScreen"] = driverOnScreen(row["onScreen"]); return current
            }
            return ["apps": ranked(fixture["apps"] as? [DriverObject] ?? []), "windows": lastWindows, "errors": fixture["errors"] ?? []]
        }
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleURL != nil && !$0.isTerminated }
        let apps: [DriverObject] = running.map { app in
            ["id": app.bundleIdentifier ?? app.bundleURL!.path, "name": app.localizedName ?? app.bundleURL!.deletingPathExtension().lastPathComponent,
             "path": app.bundleURL!.path, "running": true, "pid": Int(app.processIdentifier),
             "processStart": driverStart(app.processIdentifier) as Any? ?? NSNull(), "useCount": 0]
        }
        let byPID = Dictionary(running.map { ($0.processIdentifier, $0) }, uniquingKeysWith: { first, _ in first })
        let listed = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [DriverObject]
        let rows = listed ?? []
        let starts = Dictionary(apps.compactMap { app -> (Int, String)? in
            guard let pid = driverInteger(app["pid"]), let start = app["processStart"] as? String else { return nil }; return (pid, start)
        }, uniquingKeysWith: { first, _ in first })
        let windows: [DriverObject] = rows.compactMap { row in
            guard let pid = row[kCGWindowOwnerPID as String] as? Int, let app = byPID[pid_t(pid)],
                  let id = row[kCGWindowNumber as String] as? Int, id > 0,
                  (row[kCGWindowLayer as String] as? Int) == 0,
                  let dict = row[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: dict as CFDictionary), rect.width > 0, rect.height > 0,
                  let start = starts[pid] else { return nil }
            return ["windowId": String(id), "pid": pid, "processStart": start,
                    "bundleId": app.bundleIdentifier as Any? ?? NSNull(), "app": app.localizedName ?? "",
                    "title": row[kCGWindowName as String] as? String ?? "",
                    "bounds": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height],
                    "onScreen": driverOnScreen(row[kCGWindowIsOnscreen as String]),
                    "layer": row[kCGWindowLayer as String] as Any? ?? NSNull(), "hidden": app.isHidden,
                    "minimized": NSNull(), "fullScreen": NSNull(), "identityVerified": false]
        }
        lastWindows = windows
        return ["apps": ranked(apps), "windows": windows,
                "errors": listed == nil ? [["source": "windows", "code": "AX_UNAVAILABLE", "message": "Window metadata could not be read."]] : []]
    }
    func ranked(_ apps: [DriverObject]) -> [DriverObject] {
        apps.sorted {
            let a = driverInteger($0["useCount"]) ?? 0, b = driverInteger($1["useCount"]) ?? 0
            return a == b ? ($0["name"] as? String ?? "").localizedCaseInsensitiveCompare($1["name"] as? String ?? "") == .orderedAscending : a > b
        }
    }
    func ambiguousBounds(_ window: DriverObject) -> Bool {
        guard let frame = driverRect(window["bounds"]) else { return true }
        return lastWindows.filter { candidate in
            guard driverInteger(candidate["pid"]) == driverInteger(window["pid"]),
                  candidate["processStart"] as? String == window["processStart"] as? String,
                  let other = driverRect(candidate["bounds"]) else { return false }
            return driverSameBounds(frame, other)
        }.count > 1
    }
    // The inventory snapshot used to bind a read is also the before-action
    // window set. Reading this bank causes no new host query.
    func observedWindowIDs(_ window: DriverObject) -> Set<String> {
        Set(lastWindows.filter {
            driverInteger($0["pid"]) == driverInteger(window["pid"]) &&
            $0["processStart"] as? String == window["processStart"] as? String
        }.compactMap { $0["windowId"] as? String })
    }
    func firstWindow(_ resolved: DriverObject, request: DriverRequest, accept: (DriverObject) throws -> Bool) throws -> DriverObject {
        var windows = resolved["windows"] as? [DriverObject] ?? []
        let app = resolved["app"] as? DriverObject ?? [:]
        func standard(_ window: DriverObject) -> Bool {
            if let fixture = fixture, let trees = fixture["trees"] as? DriverObject,
               let tree = trees[window["windowId"] as? String ?? ""] as? DriverObject {
                return tree["AXRole"] as? String == "AXWindow" && !["AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXSystemFloatingWindow"].contains(tree["AXSubrole"] as? String ?? "")
            }
            return true // AX correspondence is verified by the core before reading.
        }
        while true {
            var pending: DriverFault?
            for window in windows where standard(window) {
                do { if try accept(window) { return window } }
                catch let fault as DriverFault {
                    // A launch can publish its CG surface before AX exposes the
                    // corresponding window. Recheck without creating a document.
                    guard ["AX_UNAVAILABLE", "IDENTITY_UNVERIFIED"].contains(fault.code) else { throw fault }
                    pending = fault
                }
            }
            if request.remaining <= 0.15 { throw pending ?? DriverFault("NO_WINDOWS_AVAILABLE") }
            try request.check(); Thread.sleep(forTimeInterval: min(0.025, max(0, request.remaining - 0.1)))
            windows = (state()["windows"] as? [DriverObject] ?? []).filter {
                driverInteger($0["pid"]) == driverInteger(app["pid"]) && $0["processStart"] as? String == app["processStart"] as? String
            }.filter(standard)
        }
    }
    func resolve(_ selector: Any, launch: Bool, request: DriverRequest) throws -> DriverObject {
        try request.check()
        var inventory = state()
        if let object = selector as? DriverObject, Set(object.keys) == ["windowId"],
           let id = object["windowId"] as? String, validWindowID(id) {
            guard let window = (inventory["windows"] as? [DriverObject])?.first(where: { $0["windowId"] as? String == id }),
                  let app = (inventory["apps"] as? [DriverObject])?.first(where: { driverInteger($0["pid"]) == driverInteger(window["pid"]) }) else { throw DriverFault("WINDOW_NOT_FOUND") }
            return ["app": app, "windows": [window]]
        }
        guard let name = selector as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              name.utf8.count <= 4096 else { throw DriverFault("INVALID_PARAMS") }
        func matching(_ state: DriverObject) -> [DriverObject] {
            (state["apps"] as? [DriverObject] ?? []).filter { app in
                ["id", "name", "path"].contains { key in (app[key] as? String)?.caseInsensitiveCompare(name) == .orderedSame }
            }
        }
        var matches = matching(inventory)
        if matches.isEmpty && fixture == nil {
            let url: URL?
            if name.hasPrefix("/"), name.hasSuffix(".app") { url = URL(fileURLWithPath: name).standardizedFileURL }
            else { url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) }
            // Exact name resolution uses Launch Services, without launching a file or an Open panel.
            let resolved = try name.hasPrefix("/") || name.contains(".") ? url : applicationNamed(name)
            guard let appURL = resolved, let bundle = Bundle(url: appURL), appURL.pathExtension == "app" else { throw DriverFault("APP_NOT_FOUND") }
            if !launch {
                return ["app": ["id": bundle.bundleIdentifier ?? appURL.path, "name": bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? appURL.deletingPathExtension().lastPathComponent,
                                "path": appURL.path, "running": false, "pid": NSNull(), "processStart": NSNull(), "useCount": 0], "windows": []]
            }
            let config = NSWorkspace.OpenConfiguration(); config.activates = false; config.addsToRecentItems = false
            let completion = DispatchSemaphore(value: 0)
            let launched = DriverLaunchResult()
            NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, error in launched.set(app, error); completion.signal() }
            guard completion.wait(timeout: .now() + request.remaining) == .success else { throw DriverFault("DEADLINE_EXCEEDED", unhealthy: true) }
            guard launched.succeeded else { throw DriverFault("LAUNCH_FAILED") }
            inventory = state(); matches = matching(inventory)
            if matches.isEmpty, let pid = launched.pid { matches = (inventory["apps"] as? [DriverObject] ?? []).filter { driverInteger($0["pid"]) == Int(pid) } }
        }
        guard matches.count <= 1 else { throw DriverFault("AMBIGUOUS_APP") }
        guard let app = matches.first else { throw DriverFault("APP_NOT_FOUND") }
        let windows = (inventory["windows"] as? [DriverObject] ?? []).filter { driverInteger($0["pid"]) == driverInteger(app["pid"]) && $0["processStart"] as? String == app["processStart"] as? String }
        return ["app": app, "windows": windows]
    }
    func applicationNamed(_ name: String) throws -> URL? {
        // Restrict name lookup to ordinary app roots; never treat a document as an app selector.
        let roots = ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
        var found = [URL]()
        for root in roots {
            guard let entries = try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil) else { continue }
            found += entries.filter { $0.pathExtension == "app" && $0.deletingPathExtension().lastPathComponent.caseInsensitiveCompare(name) == .orderedSame }
        }
        if found.count > 1 { throw DriverFault("AMBIGUOUS_APP") }
        return found.first
    }
    func bound(_ params: DriverObject) throws -> DriverObject {
        guard let id = params["windowId"] as? String, validWindowID(id),
              let start = params["processStart"] as? String, !start.isEmpty else { throw DriverFault("INVALID_PARAMS") }
        guard let window = (state()["windows"] as? [DriverObject])?.first(where: { $0["windowId"] as? String == id }) else { throw DriverFault("WINDOW_NOT_FOUND") }
        guard window["processStart"] as? String == start else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=process-start") }
        return window
    }
    // One target-only WindowServer query and one kernel start-time check. Never
    // rebuild the running-app inventory after a tree walk.
    func recheck(_ window: DriverObject) throws -> DriverObject {
        if fixture != nil {
            let rows = polls == 0 ? fixture?["windows"] as? [DriverObject] ?? [] : lastWindows
            guard let current = rows.first(where: { $0["windowId"] as? String == window["windowId"] as? String }) else {
                throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-id")
            }
            guard driverInteger(current["pid"]) == driverInteger(window["pid"]) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=pid") }
            guard current["processStart"] as? String == window["processStart"] as? String else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=process-start") }
            var normalized = current; normalized["onScreen"] = driverOnScreen(current["onScreen"]); return normalized
        }
        guard let id = UInt32(window["windowId"] as? String ?? "") else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-id") }
        guard let pid = driverInteger(window["pid"]) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=pid") }
        guard driverStart(pid_t(pid)) == window["processStart"] as? String else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=process-start") }
        guard let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [DriverObject], rows.count == 1 else {
            throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-inventory")
        }
        guard driverInteger(rows[0][kCGWindowNumber as String]) == Int(id) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-id") }
        guard driverInteger(rows[0][kCGWindowOwnerPID as String]) == pid else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=pid") }
        guard let bounds = rows[0][kCGWindowBounds as String] as? DriverObject,
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds") }
        var current = window
        current["bounds"] = ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
        current["onScreen"] = driverOnScreen(rows[0][kCGWindowIsOnscreen as String])
        current["layer"] = rows[0][kCGWindowLayer as String] as Any? ?? NSNull()
        current["hidden"] = NSRunningApplication(processIdentifier: pid_t(pid))?.isHidden as Any? ?? NSNull()
        return current
    }
    // Public display geometry only. A full-screen surface smaller than a whole
    // display may be a Split View tile and remains unqualified for input.
    func fullScreenTile(_ window: DriverObject) -> Bool? {
        guard let frame = driverRect(window["bounds"]), !frame.isNull, !frame.isInfinite,
              frame.width > 0, frame.height > 0 else { return nil }
        let displays: [CGRect]
        if let fixture = fixture {
            guard let rows = fixture["displays"] as? [DriverObject], !rows.isEmpty else { return nil }
            displays = rows.compactMap(driverRect)
            guard displays.count == rows.count else { return nil }
        } else {
            var count: UInt32 = 0
            guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0, count <= 64 else { return nil }
            var ids = [CGDirectDisplayID](repeating: 0, count: Int(count)), received = count
            guard CGGetActiveDisplayList(count, &ids, &received) == .success, received == count else { return nil }
            displays = ids.map(CGDisplayBounds)
        }
        guard displays.allSatisfy({ !$0.isNull && !$0.isInfinite && $0.width > 0 && $0.height > 0 }) else { return nil }
        return !displays.contains { driverSameBounds(frame, $0) }
    }
}

func validWindowID(_ id: String) -> Bool { !id.isEmpty && id.first != "0" && id.allSatisfy { $0.isASCII && $0.isNumber } && UInt32(id) != nil }
final class DriverLaunchResult {
    private let lock = NSLock()
    private var app: NSRunningApplication?, error: Error?
    func set(_ app: NSRunningApplication?, _ error: Error?) { lock.lock(); defer { lock.unlock() }; self.app = app; self.error = error }
    var succeeded: Bool { lock.lock(); defer { lock.unlock() }; return app != nil && error == nil }
    var pid: pid_t? { lock.lock(); defer { lock.unlock() }; return app?.processIdentifier }
}
