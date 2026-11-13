import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

// Local helpers have their existing result shapes. The relay still owns app
// approvals, forbidden targets and input leases. Register at runtime integration.
private struct LocalToolError: Error { let message: String; init(_ message: String) { self.message = message } }
private let localGlideEngineLine = "That is sleight's Glide engine; tools never act on it."
private let localOwnHostLine = "That is sleight's own confirmation window; only you can answer it."
private func localToolFailure(_ error: LocalToolError) -> DriverObject {
    ["ok": false, "error": error.message, "accessibility": error.message.contains("-25211") || error.message.contains("-1719") || error.message.contains("assistive")]
}
private func localJSON(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes]),
          let text = String(data: data, encoding: .utf8) else { return "null" }; return text
}
private func localFile(_ value: String?) -> String? {
    guard let value = value, let url = URL(string: value), url.isFileURL else { return nil }
    return url.resolvingSymlinksInPath().path
}
private func localEqual(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
private func localSpace(_ c: UInt16) -> Bool {
    (9...13).contains(c) || [0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff].contains(c) || (0x2000...0x200a).contains(c)
}

// Fixture objects are admitted only by the existing fixture build's stdin
// harness. No request field enables fixtures or replaces native providers.
final class DriverLocalNode {
    let native: AXUIElement?
    var fake: DriverObject?
    let io: DriverLocalIO
    init(_ native: AXUIElement, _ io: DriverLocalIO) { self.native = native; self.io = io }
    init(fake: DriverObject, io: DriverLocalIO) { self.fake = fake; self.io = io; native = nil }
    func value(_ key: String) throws -> Any? {
        try io.request.check()
        if let fake = fake {
            if key == "AXMain" { io.events.append(["main-read", fake["key"] ?? text("AXTitle")]) }
            return fake[key] is NSNull ? nil : fake[key]
        }
        guard let native = native else { return nil }
        guard AXUIElementSetMessagingTimeout(native, Float(min(io.axDeadline, io.request.remaining))) == .success else { throw LocalToolError("AX deadline unavailable") }
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(native, key as CFString, &value)
        if error == .attributeUnsupported || error == .noValue { return nil }
        guard error == .success else { throw LocalToolError("Accessibility error \(error.rawValue)") }
        return value
    }
    func text(_ key: String) -> String { (try? value(key)) as? String ?? "" }
    func bool(_ key: String) -> Bool? { driverBoolean(try? value(key)) }
    func nodes(_ key: String = "AXChildren") -> [DriverLocalNode] {
        guard let raw = try? value(key) else { return [] }
        if let array = raw as? [DriverObject] { return array.map { DriverLocalNode(fake: $0, io: io) } }
        if let array = raw as? [AXUIElement] { return array.map { DriverLocalNode($0, io) } }
        return []
    }
    func node(_ key: String) -> DriverLocalNode? {
        guard let value = try? value(key) else { return nil }
        if let fake = value as? DriverObject { return DriverLocalNode(fake: fake, io: io) }
        if CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() { return DriverLocalNode(value as! AXUIElement, io) }
        return nil
    }
    func point(_ key: String) throws -> CGPoint {
        if io.fixture?["logGeometry"] as? Bool == true { io.events.append([key == "AXPosition" ? "position" : "size"]) }
        if let list = try value(key) as? [Double], list.count == 2, list.allSatisfy({ $0.isFinite }) { return CGPoint(x: list[0], y: list[1]) }
        if let value = try value(key), CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() {
            var point = CGPoint.zero
            if key == "AXSize" { var size = CGSize.zero; if AXValueGetValue(value as! AXValue, .cgSize, &size) { return CGPoint(x: size.width, y: size.height) } }
            else if AXValueGetValue(value as! AXValue, .cgPoint, &point) { return point }
        }
        throw LocalToolError("Element geometry unavailable")
    }
    func actions() -> [String] {
        if let fake = fake { return fake["actions"] as? [String] ?? [] }
        guard let native = native else { return [] }; var names: CFArray?
        return AXUIElementCopyActionNames(native, &names) == .success ? names as? [String] ?? [] : []
    }
    func refuseClipboardNotification(_ label: String) throws {
        try DriverKeyboard.refuseClipboardLabel(label)
        let attrs: DriverObject
        if let fake = fake { attrs = fake }
        else if let native = native { attrs = try DriverNode(native).attributes(DriverKeyboard.clipboardMenuAttributes, request: io.request) }
        else { throw DriverFault("STALE_ELEMENT") }
        // Banner actions can expose equivalents without being AXMenuItems.
        try DriverKeyboard.refuseClipboardEquivalent(attrs, layout: fake == nil ? nil : [:])
        try DriverKeyboard.refuseClipboardMenu(attrs, layout: fake == nil ? nil : [:])
    }
    func perform(_ action: String) throws {
        if action == kAXPressAction {
            let attrs: DriverObject
            if let fake = fake { attrs = fake }
            else if let native = native { attrs = try DriverNode(native).attributes(DriverKeyboard.clipboardMenuAttributes, request: io.request) }
            else { throw DriverFault("STALE_ELEMENT") }
            try DriverKeyboard.refuseClipboardMenu(attrs, layout: fake == nil ? nil : [:])
        }
        try io.request.check(); try io.request.admitInput()
        if fake != nil {
            io.events.append(["action", fake?["key"] ?? text("AXTitle"), action])
            if fake?["raiseStatus"] as? Int == -1 { throw LocalToolError("AXRaise failed") }
            if let title = fake?["rename"] { fake?["AXTitle"] = title }
            return
        }
        guard let native = native, AXUIElementPerformAction(native, action as CFString) == .success else { throw LocalToolError("\(action) failed") }
    }
    func main() throws {
        try io.request.check(); try io.request.admitInput()
        if fake != nil {
            let confirmed = fake?["mainStatus"] as? Int != -1
            io.events.append(["main", fake?["key"] ?? text("AXTitle")]); fake?["AXMain"] = confirmed; return
        }
        guard let native = native, AXUIElementSetAttributeValue(native, "AXMain" as CFString, kCFBooleanTrue) == .success else { throw LocalToolError("AXMain failed") }
    }
}

final class DriverLocalIO {
    let request: DriverRequest
    let fixture: DriverObject?
    var events: [[Any]] = []
    var elapsed: Double = 0
    var idleReads = 0
    var axDeadline: Double = 0.5
    // The registrar supplies the core's kernel/CG/AX binding, never model data.
    var verifyDriverIdentity: ((DriverObject) throws -> DriverObject)?
    private var identityReads = 0
    func boundIdentity(_ expected: DriverObject) throws -> DriverObject {
        let actual: DriverObject
        if let verify = verifyDriverIdentity { actual = try verify(expected) }
        else if let fixture = fixture {
            let values = fixture["driverIdentities"] as? [DriverObject] ?? []
            guard !values.isEmpty else { throw LocalToolError("Driver identity unavailable") }
            actual = values[min(identityReads, values.count - 1)]; identityReads += 1
            events.append(["driver-identity", actual])
        } else { throw LocalToolError("Driver identity unavailable") }
        if let fixture = fixture {
            guard fixture["focusedWindowId"] as? String == expected["windowId"] as? String else { throw LocalToolError("The target window is not focused in its app") }
        }
        guard expected["identityVerified"] as? Bool == true, actual["identityVerified"] as? Bool == true,
              let id = expected["windowId"] as? String, UInt32(id) != nil,
              let start = expected["processStart"] as? String, !start.isEmpty,
              let bundle = expected["bundleId"] as? String, !bundle.isEmpty,
              driverInteger(expected["pid"]) != nil,
              ["windowId", "processStart", "bundleId", "title"].allSatisfy({ expected[$0] as? String == actual[$0] as? String }),
              driverInteger(expected["pid"]) == driverInteger(actual["pid"]) else { throw LocalToolError("The target window or process changed") }
        return actual
    }
    // Cleanup belongs to the process that received key-down. A lost or changed
    // window must not strand the key, and a reused PID must never receive key-up.
    func verifyReleaseProcess(_ expected: DriverObject) throws {
        guard let pid = driverInteger(expected["pid"]), pid > 0, pid <= Int32.max,
              let start = expected["processStart"] as? String, !start.isEmpty else {
            throw LocalToolError("The target process changed")
        }
        let actual: DriverObject
        if let fixture = fixture {
            let values = fixture["driverIdentities"] as? [DriverObject] ?? []
            guard !values.isEmpty else { throw LocalToolError("The target process changed") }
            actual = values[min(identityReads, values.count - 1)]; identityReads += 1
            events.append(["driver-identity", actual])
        } else {
            actual = ["pid": pid, "processStart": driverStart(pid_t(pid)) as Any? ?? NSNull()]
        }
        guard driverInteger(actual["pid"]) == pid, actual["processStart"] as? String == start else {
            throw LocalToolError("The target process changed")
        }
    }
    init(_ request: DriverRequest, fixture: DriverObject?) { self.request = request; self.fixture = fixture }
    func sleep(_ seconds: Double) throws {
        try request.check()
        if fixture != nil {
            if fixture?["realTime"] as? Bool == true { try request.pause(min(seconds, request.remaining)) }
            elapsed += seconds; events.append(["wait", seconds])
        }
        else { try request.pause(min(seconds, request.remaining)) }
        try request.check()
    }
    func idle() throws -> Double {
        try request.check()
        if let fixture = fixture {
            events.append(["idle", elapsed, 1, UInt32.max])
            idleReads += 1
            let list = fixture["idle"] as? [Double] ?? [fixture["idle"] as? Double ?? 20]
            if fixture["idleError"] as? Bool == true { throw LocalToolError("input state unavailable") }
            if fixture["idleAt"] as? Double == elapsed { return 2 }
            return list.isEmpty ? 0 : list[min(idleReads - 1, list.count - 1)]
        }
        let value = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .init(rawValue: UInt32.max)!)
        guard value.isFinite else { throw LocalToolError("input state unavailable") }; return value
    }
    func applications() -> [DriverObject] {
        if let fixture = fixture { return fixture["apps"] as? [DriverObject] ?? [] }
        return NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }.map {
            ["appId": $0.bundleIdentifier ?? "", "name": $0.localizedName ?? "", "path": $0.bundleURL?.path ?? "",
             "executable": $0.executableURL?.path ?? "", "pid": Int($0.processIdentifier),
             "processStart": $0.launchDate?.timeIntervalSince1970 ?? 0, "hidden": $0.isHidden,
             "accessory": $0.activationPolicy == .accessory, "active": $0.isActive]
        }
    }
    func matches(_ selector: String, insensitive: Bool = false) -> [DriverObject] {
        applications().filter { app in ["appId", "name", "path"].contains { key in
            guard let text = app[key] as? String else { return false }
            return insensitive ? localEqual(text.lowercased(), selector.lowercased()) : localEqual(text, selector)
        } }
    }
    func ownLine(_ app: DriverObject) -> String? {
        let values = ["name", "executable", "path"].map { app[$0] as? String ?? "" }
        let names = values.map { value -> String in
            let name = (value.trimmingCharacters(in: .whitespacesAndNewlines) as NSString).lastPathComponent.lowercased()
            let bare = name.hasSuffix(".app") ? String(name.dropLast(4)) : name
            return bare.replacingOccurrences(of: "[^a-z0-9]", with: "", options: .regularExpression)
        }
        let paths = values.map { $0.lowercased() }
        let cache = "/library/caches/sleight/turbo-host/", driver = cache + "mac-driver/"
        // A stale consent-host under the driver cache belongs to C and G; C's line wins.
        if names.contains("consenthost") || paths.contains(where: { $0.contains(cache) && !$0.contains(driver) }) { return localOwnHostLine }
        let prebuilt = "/lib/mac-driver/prebuilt/darwin-arm64/glide-engine"
        if names.contains("glideengine") || paths.contains(where: { $0.contains(driver) || $0.hasSuffix(prebuilt) || $0.contains(prebuilt + "/") }) { return localGlideEngineLine }
        return nil
    }
    func own(_ app: DriverObject) -> Bool { ownLine(app) != nil }
    func root(_ app: DriverObject) throws -> DriverLocalNode {
        if let fixture = fixture {
            if fixture["trusted"] as? Bool == false { throw LocalToolError("Accessibility permission unavailable (-25211)") }
            if let error = app["rootError"] as? String { throw LocalToolError(error) }
            guard let tree = app["tree"] as? DriverObject ?? fixture["tree"] as? DriverObject else { throw LocalToolError("Accessibility process unavailable") }
            return DriverLocalNode(fake: tree, io: self)
        }
        guard AXIsProcessTrusted(), let pid = driverInteger(app["pid"]), pid > 0 else { throw LocalToolError("Accessibility permission unavailable (-25211)") }
        return DriverLocalNode(AXUIElementCreateApplication(pid_t(pid)), self)
    }
    func cg() -> [DriverObject] {
        if let fixture = fixture { return fixture["cg"] as? [DriverObject] ?? [] }
        return CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [DriverObject] ?? []
    }
    func frontPID() -> Int? {
        if let fixture = fixture { return driverInteger(fixture["frontPID"]) }
        return NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) }
    }
    func realClick(_ item: DriverLocalNode, args: DriverObject) throws {
        var waited: Double = 0
        while try idle() < 2 {
            if waited >= 10 { throw LocalToolError("the person at the Mac kept typing or using the mouse for 10 s, and this icon needs a real click; nothing was clicked. Tell the user, and retry when they have paused") }
            try sleep(0.5); waited += 0.5
        }
        let pos = try item.point("AXPosition"), size = try item.point("AXSize")
        let point = CGPoint(x: pos.x + size.x / 2, y: pos.y + size.y / 2)
        var pid: pid_t = 0
        if let native = item.native { guard AXUIElementGetPid(native, &pid) == .success else { throw DriverFault("IDENTITY_UNVERIFIED") } }
        else if let value = driverInteger(item.fake?["pid"]), value > 0, value <= Int(Int32.max) { pid = pid_t(value) }
        try requireClickWindow(args, pid: Int(pid))
        guard try idle() >= 2 else { throw LocalToolError("User input at the Mac") }
        if fixture != nil {
            try request.check(); try requireClickWindow(args, pid: Int(pid))
            guard try idle() >= 2 else { throw LocalToolError("User input at the Mac") }
            try request.admitInput()
            for type in [1, 2] { events.append(["post", elapsed, 0, ["type": type, "point": ["x": point.x, "y": point.y], "button": 0]]) }
            events.append(["restore", fixture?["saved"] ?? ["x": 400, "y": 500]]); return
        }
        guard let saved = CGEvent(source: nil)?.location,
              let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { throw LocalToolError("Cannot create mouse event") }
        try request.check(); try requireClickWindow(args, pid: Int(pid))
        guard try idle() >= 2 else { throw LocalToolError("User input at the Mac") }
        try request.admitInput()
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap); CGWarpMouseCursorPosition(saved)
    }

    func checkInputLease(_ lease: DriverObject?, appID: String, pid: Int, identity: DriverObject?) throws {
        guard let path = lease?["path"] as? String, !path.isEmpty,
              let token = lease?["token"] as? String, !token.isEmpty else { throw LocalToolError("The input lease is unavailable") }
        let record: DriverObject
        if let fake = fixture?["lease"] as? DriverObject { record = fake }
        else if fixture != nil { throw LocalToolError("The input lease is unavailable") }
        else {
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)), data.count <= 131072,
                  let decoded = try? DriverJSON.decode(data) else { throw LocalToolError("The input lease is unavailable") }
            record = decoded
        }
        guard record["token"] as? String == token,
              (record["expires"] as? Double ?? 0) > Date().timeIntervalSince1970 * 1000,
              (record["window"] as? DriverObject)?["appId"] as? String == appID else { throw LocalToolError("Input lease ownership lost or expired") }
        if let identity = identity {
            guard let id = identity["windowId"] as? String, let start = identity["processStart"] as? String else { throw LocalToolError("The leased window changed") }
            let window = record["window"] as? DriverObject ?? [:]
            // Both the runtime's identity key and the relay's displayed window
            // must name the same verified process and window.
            let exact = window["title"] as? String == localJSON([id, pid, start]) && window["url"] is NSNull
            let displayed = window["title"] as? String == identity["title"] as? String &&
                (window["url"] == nil || window["url"] is NSNull) &&
                (driverInteger(window["windowNumber"]).map { String($0) == id } ?? false)
            guard exact || displayed else { throw LocalToolError("The leased window changed") }
        }
    }
    private func requireClickWindow(_ args: DriverObject, pid: Int) throws {
        guard let identity = args["driverIdentity"] as? DriverObject,
              let appID = identity["bundleId"] as? String else { throw LocalToolError("The leased window changed") }
        try checkInputLease(args["lease"] as? DriverObject, appID: appID, pid: pid, identity: identity)
        try requireCurrentSpace(pid, identity: identity)
    }
    // Bind only the lease's window. A visible sibling cannot replace it, and a
    // missing binding never falls back to an arbitrary window for this PID.
    private lazy var spaceCore = DriverCore(fixture: fixture.map { $0["spaceInventory"] as? DriverObject ?? [:] })
    func requireCurrentSpace(_ pid: Int, identity: DriverObject?) throws {
        guard pid > 0, pid <= Int32.max, let identity = identity,
              identity["identityVerified"] as? Bool == true, driverInteger(identity["pid"]) == pid,
              let id = identity["windowId"] as? String, let number = UInt32(id), number > 0,
              let start = identity["processStart"] as? String, !start.isEmpty,
              let bundle = identity["bundleId"] as? String, !bundle.isEmpty,
              identity["title"] is String else { try spaceCore.requireCurrentSpace([:], request: request); return }
        let params: DriverObject = ["windowId": id, "processStart": start]
        let input = DriverRequest(copying: request, method: "stuckMenuEscape", params: params)
        let bound = try spaceCore.boundWindow(params, request: input)
        guard driverInteger(bound.window["pid"]) == pid, bound.window["bundleId"] as? String == bundle,
              bound.window["title"] as? String == identity["title"] as? String,
              bound.window["identityVerified"] as? Bool == true else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-metadata") }
        try spaceCore.requireCurrentSpace(bound.window, request: request)
    }
    func requireStatusInput(_ args: DriverObject, app: DriverObject) throws {
        guard let pid = driverInteger(app["pid"]),
              let appID = app["appId"] as? String,
              let identity = args["driverIdentity"] as? DriverObject,
              identity["bundleId"] as? String == appID else { throw LocalToolError("The leased window changed") }
        try requireClickWindow(args, pid: pid)
    }
}

final class DriverLocalTools {
    private var frontCalls: [String: DriverObject] = [:]
    private var frontOrder: [String] = []
    func run(_ script: String, _ args: DriverObject, _ io: DriverLocalIO) throws -> DriverObject {
        switch script {
        case "select-window.js": return try select(args, io)
        case "menubar.js": return try menu(args, io)
        case "open-file-window.js": return try document(args, io)
        case "stuck-escape.js": return try escape(args, io)
        case "front-restore.js": return try front(args, io)
        case "app-health.js": return try probe(args, io)
        case "keyboard-taps.js": return try taps(io)
        default: throw DriverFault("INVALID_PARAMS")
        }
    }
    private func select(_ args: DriverObject, _ io: DriverLocalIO) throws -> DriverObject {
        guard let name = args["app"] as? String, !name.isEmpty,
              (args["title"] != nil) != (args["url"] != nil),
              args["title"] == nil || args["title"] is String else { throw LocalToolError("Supply app and exactly one of title or file URL") }
        if args["url"] != nil && localFile(args["url"] as? String) == nil { throw LocalToolError("URL must be a file URL") }
        if args["windowNumber"] != nil && (driverInteger(args["windowNumber"]) ?? 0) <= 0 { throw LocalToolError("Invalid window number") }
        let apps = io.matches(name)
        if let line = apps.compactMap(io.ownLine).first { throw LocalToolError(line) }
        guard apps.count == 1, let appID = apps[0]["appId"] as? String, !appID.isEmpty else { throw LocalToolError("Selection needs one running app with a bundle ID") }
        let app = apps[0]
        if let expected = args["expectedAppId"] as? String, expected != appID { throw LocalToolError("The running app changed after its lease was acquired") }
        let windows = try io.root(app).nodes("AXWindows"), title = args["title"] as? String
        func windowTitle(_ node: DriverLocalNode) -> String? { (try? node.value("AXTitle")) as? String }
        var cgRows: [DriverObject]?
        func number(_ node: DriverLocalNode) -> Int? {
            if let id = driverInteger(try? node.value("AXWindowNumber")), id > 0 { return id }
            guard let p = try? node.point("AXPosition"), let s = try? node.point("AXSize") else { return nil }
            if cgRows == nil { cgRows = io.cg() }
            let rows = cgRows!.filter {
                guard driverInteger($0["kCGWindowOwnerPID"]) == driverInteger(app["pid"]), driverInteger($0["kCGWindowLayer"]) == 0,
                      let b = $0["kCGWindowBounds"] as? DriverObject else { return false }
                return zip(["X", "Y", "Width", "Height"], [p.x, p.y, s.x, s.y]).allSatisfy { abs((b[$0.0] as? Double ?? .infinity) - Double($0.1)) < 0.5 }
            }
            return rows.count == 1 ? driverInteger(rows[0]["kCGWindowNumber"]) : nil
        }
        func valid(_ node: DriverLocalNode) -> Bool { node.text("AXDocument").isEmpty || localFile(node.text("AXDocument")) != nil }
        func numbered(_ node: DriverLocalNode) -> Bool { args["windowNumber"] == nil || number(node) == driverInteger(args["windowNumber"]) }
        var selected = windows.filter { node in
            valid(node) && numbered(node) && (title != nil ? windowTitle(node).map { localEqual($0, title!) } == true : localFile(node.text("AXDocument")) == localFile(args["url"] as? String))
        }
        var ending = false
        if let title = title, !windows.contains(where: { windowTitle($0).map { localEqual($0, title) } == true }) {
            let count = title.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.filter {
                ![.format, .nonspacingMark, .spacingMark, .enclosingMark].contains($0.properties.generalCategory)
            }.count
            if count >= 12 {
                let suffixes = windows.filter { node in
                    guard let value = windowTitle(node) else { return false }
                    let text = Array(value.utf16), suffix = Array(title.utf16)
                    guard text.count >= suffix.count, text.suffix(suffix.count).elementsEqual(suffix) else { return false }
                    return text.count == suffix.count || localSpace(text[text.count - suffix.count - 1])
                }
                if suffixes.count > 1 {
                    let shown = Array(suffixes.prefix(5)), titles = shown.map { node -> String in
                        let scalars = Array(node.text("AXTitle").unicodeScalars)
                        return scalars.count > 200 ? String(String.UnicodeScalarView(scalars.prefix(197))) + "..." : node.text("AXTitle")
                    }
                    throw LocalToolError("Title ending found \(suffixes.count) windows: \(localJSON(titles))\(suffixes.count > 5 ? " and \(suffixes.count - 5) more" : ""). Window numbers: \(localJSON(shown.map { number($0) as Any? ?? NSNull() }))")
                }
                if suffixes.count == 1 && valid(suffixes[0]) && numbered(suffixes[0]) { selected = suffixes; ending = true }
            }
        }
        if selected.isEmpty {
            let titles = windows.compactMap(windowTitle), shown = titles.prefix(5).map { localJSON($0.utf16.count > 120 ? String($0.prefix(117)) + "..." : $0) }
            throw LocalToolError("Expected exactly one matching window, found 0. \(app["name"] as? String ?? name) has \(titles.count) window\(titles.count == 1 ? "" : "s") now" +
                (titles.isEmpty ? "" : ": " + shown.joined(separator: ", ") + (titles.count > 5 ? " and \(titles.count - 5) more" : "")) +
                ". No exact title: unique ending after whitespace; 12+ code points after trim(), excluding Cf/M. A window that navigated or was renamed is still the same window: select it by the title it has now, or act on it through the handle you have.")
        }
        guard selected.count == 1 else { throw LocalToolError("Expected exactly one matching window, found \(selected.count). Window numbers: \(localJSON(selected.map { number($0) as Any? ?? NSNull() }))") }
        let target = selected[0], before = windowTitle(selected[0]), url = target.text("AXDocument")
        guard let front = io.frontPID() else { throw LocalToolError("Window selection unconfirmed: foreground app unavailable") }
        try target.perform("AXRaise"); try target.main()
        guard target.bool("AXMain") == true else { throw LocalToolError("Window selection unconfirmed: AXMain is false") }
        let after = windowTitle(target)
        let sameTitle = before.map { first in after.map { localEqual($0, first) } == true } ?? (after == nil)
        guard sameTitle, localEqual(target.text("AXDocument"), url) else { throw LocalToolError("Window selection unconfirmed: identity changed during selection") }
        if app["active"] as? Bool != true && (io.fixture?["activates"] as? Bool == true || io.frontPID() != front) { throw LocalToolError("Window selection changed the foreground app") }
        var result: DriverObject = ["ok": true, "target": ["appId": appID, "app": app["name"] ?? name, "title": before as Any? ?? NSNull(), "url": url.isEmpty ? NSNull() : url as Any],
            "identity": ["pid": app["pid"] ?? NSNull(), "windowNumber": number(target) as Any? ?? NSNull()]]
        if ending { result["note"] = "matched by its title ending: \(before ?? "")" }; return result
    }

    private func extrasBar(_ root: DriverLocalNode) -> DriverLocalNode? {
        if let bar = root.node("AXExtrasMenuBar") { return bar }
        let bars = root.nodes().filter { $0.text("AXRole") == "AXMenuBar" }
        return bars.count > 1 ? bars[1] : nil
    }
    private func status(_ name: String, _ io: DriverLocalIO) throws -> (DriverObject, DriverLocalNode, [DriverLocalNode]) {
        let apps = io.applications().filter { localEqual($0["name"] as? String ?? "", name) }
        guard apps.count == 1 else { throw LocalToolError("\(name) isn't running") }
        if let line = io.ownLine(apps[0]) { throw LocalToolError(line) }
        let root = try io.root(apps[0])
        guard let bar = extrasBar(root) else { throw LocalToolError("\(name) has no status item in the menu bar. Its own menus (File, Edit, Format…) are in its tree: use js.") }
        return (apps[0], root, bar.nodes())
    }
    private func menus(_ node: DriverLocalNode) -> [DriverLocalNode] { node.nodes().filter { $0.text("AXRole") == "AXMenu" } }
    private func popovers(_ root: DriverLocalNode) -> [DriverLocalNode] { root.nodes("AXWindows").filter { $0.text("AXSubrole") != "AXStandardWindow" } }
    private func readMenu(_ menu: DriverLocalNode, _ depth: Int = 0) -> [DriverObject] {
        menu.nodes().compactMap { node in
            let title = node.text("AXTitle"); if title.isEmpty { return nil }
            var item: DriverObject = ["title": title]
            if node.bool("AXEnabled") == false { item["disabled"] = true }
            if !node.text("AXMenuItemMarkChar").isEmpty { item["checked"] = true }
            if depth < 3, let sub = menus(node).first { item["submenu"] = readMenu(sub, depth + 1) }; return item
        }
    }
    private let roles = ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXTextField", "AXStaticText", "AXLink", "AXSwitch"]
    private func elements(_ root: DriverLocalNode) -> [DriverLocalNode] {
        var found: [DriverLocalNode] = []
        func walk(_ node: DriverLocalNode, _ depth: Int) {
            if depth > 12 || found.count > 300 { return }
            // Never expose secure field metadata, including descendants.
            if node.text("AXRole") == "AXSecureTextField" || node.text("AXSubrole") == "AXSecureTextField" { return }
            if roles.contains(node.text("AXRole")) { found.append(node) }
            for child in node.nodes() { walk(child, depth + 1) }
        }
        walk(root, 0); return found
    }
    private func readWindow(_ win: DriverLocalNode) -> [DriverObject] {
        elements(win).enumerated().map { index, node in
            let role = String(node.text("AXRole").dropFirst(2))
            let text = ["AXTitle", "AXDescription", "AXValue", "AXHelp", "AXIdentifier"].compactMap { key -> String? in
                guard let value = try? node.value(key) else { return nil }
                let text = driverBoolean(value).map { $0 ? "true" : "false" } ?? String(describing: value)
                return text.isEmpty || ["group", "text", "button", "image", "scroll area"].contains(text) ? nil : text
            }.joined(separator: " · ")
            var fallback = "\(role) \(index)"
            if let origin = try? win.point("AXPosition"), let pos = try? node.point("AXPosition") { fallback = "\(role) at (\(Int((pos.x - origin.x).rounded())), \(Int((pos.y - origin.y).rounded())))" }
            return ["element": index, "role": role, "text": text.isEmpty ? fallback : text]
        }
    }
    private func menu(_ args: DriverObject, _ io: DriverLocalIO) throws -> DriverObject {
        guard let op = args["op"] as? String else { throw LocalToolError("unknown op") }
        let allowed = args["caller"] as? String == "menu_bar" ? ["apps", "open", "choose", "press", "close"]
            : args["caller"] as? String == "notifications" ? ["notifications", "notify-press"] : []
        guard allowed.contains(op) else { throw LocalToolError("Invalid menu helper caller or op") }
        if op == "apps" {
            var names: [String] = [], firstError: Error?, readable = 0
            for app in io.applications() where !io.own(app) {
                do {
                    let root = try io.root(app); readable += 1
                    if extrasBar(root) != nil { names.append(app["name"] as? String ?? "") }
                } catch { if firstError == nil { firstError = error } }
            }
            if readable == 0, let error = firstError { throw error }
            return ["ok": true, "apps": names]
        }
        if ["notifications", "notify-press"].contains(op) { return try notifications(args, io) }
        guard let name = args["app"] as? String, !name.isEmpty else { throw LocalToolError("menu_bar needs app") }
        if args["item"] != nil && driverInteger(args["item"]) == nil { throw LocalToolError("Invalid status item index") }
        if op == "choose", (args["path"] as? [String])?.isEmpty != false { throw LocalToolError("choose needs a menu path") }
        let (app, root, items) = try status(name, io), index = driverInteger(args["item"]) ?? 0
        guard index >= 0, index < items.count else { throw LocalToolError("no status item \(index); this app has \(items.count)") }
        let item = items[index]
        if ["open", "choose", "press", "close"].contains(op) { try io.requireStatusInput(args, app: app) }
        if op == "close" {
            if let menu = menus(item).first { try? menu.perform("AXCancel") }
            if !popovers(root).isEmpty { try io.realClick(item, args: args); try io.sleep(0.3) }
            var result: DriverObject = ["ok": true, "app": name, "closed": true]
            if !popovers(root).isEmpty { result["windowStillOpen"] = true }; return result
        }
        if op == "press" {
            guard let win = popovers(root).last else { throw LocalToolError("\(name) has no open window from its status item; use open first") }
            let nodes = elements(win)
            guard let n = driverInteger(args["element"]), n >= 0, n < nodes.count else { throw LocalToolError("no element \(args["element"] ?? "undefined")") }
            try nodes[n].perform("AXPress"); try io.sleep(0.3)
            return ["ok": true, "app": name, "pressed": n, "elements": popovers(root).last.map(readWindow) ?? []]
        }
        guard ["open", "choose"].contains(op) else { throw LocalToolError("unknown op \(op)") }
        let hasMenu = !menus(item).isEmpty, before = popovers(root).count
        try item.perform("AXPress")
        func wait(_ seconds: Double) throws -> Bool {
            for _ in 0..<Int(seconds * 10) { try io.sleep(0.1); if popovers(root).count > before { return true } }; return false
        }
        if !hasMenu {
            let opened = try wait(0.6)
            if !opened { try io.realClick(item, args: args); _ = try wait(1.5) }
        }
        if hasMenu, let first = menus(item).first {
            if op == "open" { let menu = readMenu(first); try? first.perform("AXCancel"); return ["ok": true, "app": name, "opened": "menu", "menu": menu] }
            let path = args["path"] as? [String] ?? []
            guard !path.isEmpty else { try? first.perform("AXCancel"); throw LocalToolError("choose needs a menu path") }
            var menu = first
            for (at, title) in path.enumerated() {
                guard let mi = menu.nodes().first(where: { $0.text("AXTitle") == title }) else { try? first.perform("AXCancel"); throw LocalToolError("no menu item \"\(title)\"") }
                if at == path.count - 1 { try mi.perform("AXPress"); return ["ok": true, "app": name, "chose": path] }
                guard let next = menus(mi).first else { try? first.perform("AXCancel"); throw LocalToolError("no submenu \"\(title)\"") }; menu = next
            }
        }
        let wins = popovers(root)
        if op == "choose" { throw LocalToolError("\(name)'s status item opened a \(wins.isEmpty ? "nothing visible" : "window"), not a menu") }
        if let win = wins.last { return ["ok": true, "app": name, "opened": "window", "elements": readWindow(win)] }
        return ["ok": true, "app": name, "opened": "nothing visible"]
    }
    private func notifications(_ args: DriverObject, _ io: DriverLocalIO) throws -> DriverObject {
        let app = io.applications().first {
            localEqual($0["name"] as? String ?? "", "NotificationCenter") ||
            URL(fileURLWithPath: $0["executable"] as? String ?? "").lastPathComponent == "NotificationCenter"
        }
        var found: [(DriverLocalNode, [String], [(String, String)])] = []
        func walk(_ node: DriverLocalNode, _ depth: Int) {
            if depth > 8 { return }
            if node.text("AXRole") == "AXSecureTextField" || node.text("AXSubrole") == "AXSecureTextField" { return }
            let buttons = node.actions().compactMap { action -> (String, String)? in
                let name = String(action.split(separator: "\n", omittingEmptySubsequences: false).first ?? "")
                return name.hasPrefix("Name:") ? (String(name.dropFirst(5)), action) : nil
            }
            let texts = node.nodes().filter { $0.text("AXRole") == "AXStaticText" }.map { $0.text("AXValue") }.filter { !$0.isEmpty }
            if !buttons.isEmpty && !texts.isEmpty { found.append((node, texts, buttons)); return }
            for child in node.nodes() { walk(child, depth + 1) }
        }
        if let app = app { for win in try io.root(app).nodes("AXWindows") { walk(win, 0) } }
        if args["op"] as? String == "notifications" {
            return ["ok": true, "banners": found.enumerated().map { index, b in ["banner": index, "texts": b.1, "buttons": b.2.map { $0.0 }] as DriverObject }]
        }
        guard let index = driverInteger(args["banner"]), index >= 0, index < found.count else { throw LocalToolError("no banner \(args["banner"] ?? "undefined")") }
        let b = found[index]
        guard let name = args["button"] as? String else { throw LocalToolError("A banner button name is required") }
        guard let button = b.2.first(where: { $0.0 == name }) else { throw LocalToolError("banner \(index) has no \"\(name)\" button; it has \(b.2.map { $0.0 }.joined(separator: ", "))") }
        try b.0.refuseClipboardNotification(button.0)
        try b.0.perform(button.1); return ["ok": true, "pressed": name, "banner": index]
    }

    private func document(_ args: DriverObject, _ io: DriverLocalIO) throws -> DriverObject {
        guard let appID = args["appId"] as? String, !appID.isEmpty, let path = args["path"] as? String, path.hasPrefix("/") else { throw LocalToolError("Invalid open-file target") }
        if args["op"] as? String == "open" {
            // Parent openDocument validates policy and lstat immediately before
            // this call. Repeat the file checks at the native dispatch boundary.
            let runnable = ["command", "tool", "sh", "bash", "zsh", "csh", "ksh", "fish", "py", "pyc", "pyw", "rb", "pl", "php", "js", "mjs", "jar", "app", "pkg", "mpkg", "dmg", "scpt", "scptd", "applescript", "workflow", "action", "shortcut", "terminal", "osax", "plugin", "kext", "so", "dylib"]
            let launchers = ["org.python.pythonlauncher", "com.apple.jarlauncher", "com.apple.installer", "com.apple.archiveutility", "com.apple.scriptmenuapp", "com.apple.automator.runner", "com.apple.shortcuts", "com.apple.systemevents", "com.apple.applescriptutility", "com.apple.terminal", "com.googlecode.iterm2"]
            guard !runnable.contains(URL(fileURLWithPath: path).pathExtension.lowercased()), !launchers.contains(appID.lowercased()), !appID.lowercased().hasPrefix("com.openai.") else { throw LocalToolError("open_file doesn't open scripts, apps or installers or apps that run them") }
            let actual = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
            if [path, actual].contains(where: { $0.precomposedStringWithCanonicalMapping.lowercased().range(of: "/library/application support/sleight(?:/|$)", options: .regularExpression) != nil }) { throw LocalToolError("open_file doesn't open sleight's own settings files; only the user changes them.") }
            var info = stat()
            guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o111 == 0 else { throw LocalToolError("open_file needs a regular, nonexecutable file") }
            if io.fixture != nil { io.events.append(["open", appID, path]); return ["ok": true] }
            guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appID),
                  Bundle(url: appURL)?.bundleIdentifier == appID else { throw LocalToolError("The resolved application changed") }
            try io.request.check(); try io.request.admitInput()
            let config = NSWorkspace.OpenConfiguration(); config.activates = false
            let complete = DispatchSemaphore(value: 0)
            var failure: Error?
            NSWorkspace.shared.open([URL(fileURLWithPath: path)], withApplicationAt: appURL, configuration: config) { _, error in failure = error; complete.signal() }
            while complete.wait(timeout: .now() + min(0.02, io.request.remaining)) != .success { try io.request.check() }
            try io.request.check()
            if let failure = failure { throw LocalToolError(failure.localizedDescription) }; return ["ok": true]
        }
        let apps = io.applications().filter { $0["appId"] as? String == appID }
        guard apps.count == 1, apps[0]["hidden"] as? Bool == false else { return ["ok": true, "matches": false] }
        guard let root = try? io.root(apps[0]), (try? root.value("AXWindows")) != nil else { return ["ok": false, "matches": false] }
        let wins = root.nodes("AXWindows")
        guard wins.count <= 64 else { return ["ok": false, "matches": false] }
        let expected = URL(fileURLWithPath: path).absoluteString
        return ["ok": true, "matches": wins.contains { $0.text("AXDocument") == expected && $0.bool("AXMinimized") == false && $0.bool("AXVisible") == true && $0.bool("AXMain") == true }]
    }

    private func menuState(_ app: DriverObject, _ io: DriverLocalIO) throws -> DriverObject {
        io.axDeadline = 0.2
        if let state = io.fixture?["menuState"] as? DriverObject { return state }
        let root = try io.root(app), bar = root.node("AXMenuBar")
        var state: DriverObject = ["selected": NSNull(), "open": NSNull()]
        if let bar = bar, (try? bar.value("AXChildren")) != nil { state["selected"] = bar.nodes().contains { $0.bool("AXSelected") == true } }
        if (try? root.value("AXChildren")) != nil {
            let focus = root.node("AXFocusedUIElement")?.text("AXRole") ?? ""
            state["open"] = root.nodes().contains { $0.text("AXRole") == "AXMenu" } || ["AXMenu", "AXMenuItem"].contains(focus)
        }; return state
    }
    private func escape(_ args: DriverObject, _ io: DriverLocalIO) throws -> DriverObject {
        var posted = false
        var released = false
        var releaseError: String?
        do {
            let check = args["op"] as? String == "check", lease = args["lease"] as? DriverObject
            let driverIdentity = args["driverIdentity"] as? DriverObject
            guard let appID = args["appId"] as? String, !appID.isEmpty, let pid = driverInteger(args["pid"]), pid > 0, pid <= Int32.max,
                  driverIdentity != nil || (args["processStart"] as? Double)?.isFinite == true else { throw LocalToolError("Invalid stuck-menu Escape target") }
            if args["driverIdentity"] != nil && driverIdentity == nil { throw LocalToolError("Invalid stuck-menu Escape target") }
            if let identity = driverIdentity {
                guard identity["bundleId"] as? String == appID, driverInteger(identity["pid"]) == pid,
                      identity["processStart"] as? String == args["processStart"] as? String else { throw LocalToolError("Invalid stuck-menu Escape target") }
                _ = try io.boundIdentity(identity)
            }
            let quiet = args["quietSeconds"] as? Double ?? 0, wait = args["waitSeconds"] as? Double ?? -1
            if !check && (lease?["path"] as? String == nil || (lease?["token"] as? String ?? "").isEmpty || !(0.5...5).contains(quiet) || !(0...2).contains(wait)) { throw LocalToolError("Invalid stuck-menu Escape target") }
            let resultAt = args["resultAt"] as? Double
            if driverIdentity != nil && !check && resultAt == nil { throw LocalToolError("Invalid stuck-menu Escape target") }
            if args["resultAt"] != nil && (resultAt == nil || !resultAt!.isFinite || resultAt! <= 0) { throw LocalToolError("Invalid stuck-menu Escape target") }
            let age = resultAt.map { (Date().timeIntervalSince1970 * 1000 - $0) / 1000 }
            let started = io.fixture != nil ? io.elapsed : ProcessInfo.processInfo.systemUptime
            func checkResultIdle() throws {
                guard let age = age else { return }
                let elapsed = (io.fixture != nil ? io.elapsed : ProcessInfo.processInfo.systemUptime) - started
                if age < 0 { throw LocalToolError("User input at the Mac") }
                if !(try io.idle() >= age + elapsed) { throw LocalToolError("User input at the Mac") }
            }
            let apps = io.applications().filter { $0["appId"] as? String == appID }
            guard apps.count == 1 else { throw LocalToolError("Stuck-menu Escape needs one running app") }
            let app = apps[0]
            guard driverInteger(app["pid"]) == pid,
                  driverIdentity != nil || app["processStart"] as? Double == args["processStart"] as? Double else { throw LocalToolError("The target process changed") }
            let kernelStart = io.fixture == nil ? driverStart(pid_t(pid)) : nil
            if io.fixture == nil && kernelStart == nil { throw LocalToolError("The target process changed") }
            if let line = io.ownLine(app) { throw LocalToolError(line) }
            if check {
                var result = try menuState(app, io)
                if let identity = driverIdentity { _ = try io.boundIdentity(identity) }
                result["ok"] = true; return result
            }
            try checkResultIdle()
            var waited: Double = 0
            while true {
                let idle = try io.idle(); if idle >= quiet { break }
                let step = max(0.1, quiet - (idle.isFinite ? idle : 0))
                if waited + step > wait { throw LocalToolError("User input at the Mac") }
                try io.sleep(step); waited += step
            }
            func checkLease() throws {
                try io.checkInputLease(lease, appID: appID, pid: pid, identity: driverIdentity)
            }
            try checkLease()
            let before = try menuState(app, io)
            guard before["selected"] as? Bool == true, before["open"] as? Bool == false else { throw LocalToolError("The menu bar shows no stuck menu") }
            // Recheck the running process after the HID wait and AX read.
            guard let current = io.applications().first(where: { driverInteger($0["pid"]) == pid }),
                  current["appId"] as? String == appID,
                  driverIdentity != nil || current["processStart"] as? Double == args["processStart"] as? Double,
                  io.fixture != nil || driverStart(pid_t(pid)) == kernelStart else { throw LocalToolError("The target process changed") }
            if let identity = driverIdentity { _ = try io.boundIdentity(identity) }
            try checkLease()
            try checkResultIdle()
            try io.requireCurrentSpace(pid, identity: driverIdentity)
            try checkResultIdle()
            guard try io.idle() >= quiet else { throw LocalToolError("User input at the Mac") }
            let postDown: () -> Void
            let postUp: () throws -> Void
            if io.fixture != nil {
                postDown = { io.events.append(["key", pid, 53, true, 0]) }
                postUp = {
                    io.events.append(["release-attempt", pid])
                    if io.fixture?["escapeReleaseFails"] as? Bool == true { throw LocalToolError("Escape release failed") }
                    io.events.append(["key", pid, 53, false, 0])
                }
            } else {
                guard let source = CGEventSource(stateID: .privateState),
                      let down = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: false) else { throw LocalToolError("Cannot create Escape event") }
                down.flags = []; up.flags = []
                postDown = { down.postToPid(pid_t(pid)) }
                postUp = { up.postToPid(pid_t(pid)) }
            }
            func release() {
                do {
                    // No AX, window, lease or deadline gate may prevent cleanup.
                    if let identity = driverIdentity { try io.verifyReleaseProcess(identity) }
                    else if io.fixture == nil {
                        guard let start = kernelStart, driverStart(pid_t(pid)) == start else { throw LocalToolError("The target process changed") }
                    }
                    try postUp(); released = true
                } catch {
                    releaseError = (error as? LocalToolError)?.message ?? String(describing: error)
                }
            }
            try io.request.check(); try io.requireCurrentSpace(pid, identity: driverIdentity)
            try checkResultIdle()
            guard try io.idle() >= quiet else { throw LocalToolError("User input at the Mac") }
            try io.request.admitInput()
            postDown(); posted = true
            do {
                if io.fixture?["escapeWaitFails"] as? Bool == true { throw LocalToolError("Escape wait failed") }
                try io.sleep(0.03)
            } catch {
                // Preserve the original fault and the separate cleanup outcome.
                release()
                throw error
            }
            release()
            if let releaseError = releaseError { throw LocalToolError(releaseError) }
            try io.sleep(0.15)
            let selected = io.fixture?["afterEscape"] ?? (try? menuState(app, io)["selected"]) ?? NSNull()
            return ["ok": true, "posted": true, "released": released, "selected": selected]
        } catch {
            var result: DriverObject = ["ok": false, "posted": posted, "error": (error as? LocalToolError)?.message ?? (error as? DriverFault)?.message ?? "Stuck-menu Escape failed"]
            if posted {
                result["released"] = released
                if let releaseError = releaseError { result["releaseError"] = releaseError }
            }
            return result
        }
    }

    private func front(_ args: DriverObject, _ io: DriverLocalIO) throws -> DriverObject {
        func identity(_ app: DriverObject?) -> Bool { app?["bundleId"] as? String != nil && !(app?["bundleId"] as? String ?? "").isEmpty && (driverInteger(app?["pid"]) ?? 0) > 0 }
        func same(_ a: DriverObject?, _ b: DriverObject?) -> Bool { identity(a) && identity(b) && a?["bundleId"] as? String == b?["bundleId"] as? String && driverInteger(a?["pid"]) == driverInteger(b?["pid"]) }
        func observe(_ selector: String, _ previous: DriverObject? = nil) -> DriverObject {
            if let fixture = io.fixture { return fixture["frontState"] as? DriverObject ?? [:] }
            let time = ProcessInfo.processInfo.systemUptime
            func info(_ app: NSRunningApplication?) -> DriverObject? {
                guard let app = app, !app.isTerminated, let id = app.bundleIdentifier else { return nil }
                return ["bundleId": id, "pid": Int(app.processIdentifier), "app": app.localizedName ?? ""]
            }
            var state: DriverObject = ["time": time, "targets": io.matches(selector, insensitive: true).map { ["bundleId": $0["appId"] ?? "", "pid": $0["pid"] ?? 0, "app": $0["name"] ?? ""] },
                "idleSeconds": [CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown].map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0]
            state["front"] = info(NSWorkspace.shared.frontmostApplication)
            if let pid = driverInteger(previous?["pid"]) { state["previous"] = info(NSRunningApplication(processIdentifier: pid_t(pid))) }; return state
        }
        func quiet(_ state: DriverObject, _ call: DriverObject) -> Bool {
            guard let time = state["time"] as? Double, let idle = state["idleSeconds"] as? Double, let started = call["started"] as? Double else { return false }
            return time.isFinite && idle.isFinite && time >= started && time - started < 600 && idle >= time - started
        }
        if args["action"] as? String == "begin" {
            guard let selector = args["selector"] as? String, !selector.isEmpty else { return [:] }
            let state = observe(selector)
            guard let front = state["front"] as? DriverObject, identity(front), (state["targets"] as? [DriverObject])?.isEmpty == true,
                  let time = state["time"] as? Double, time.isFinite, let idle = state["idleSeconds"] as? Double, idle.isFinite else { return [:] }
            if frontOrder.count >= 128 { frontCalls.removeValue(forKey: frontOrder.removeFirst()) }
            let token = io.fixture?["token"] as? String ?? UUID().uuidString; frontOrder.append(token)
            frontCalls[token] = ["selector": selector, "previous": front, "started": time, "armed": false]; return ["token": token]
        }
        guard let token = args["token"] as? String, var call = frontCalls[token], let selector = call["selector"] as? String, let previous = call["previous"] as? DriverObject else { return ["armed": false, "restored": false] }
        func consume() { frontCalls.removeValue(forKey: token); frontOrder.removeAll { $0 == token } }
        if args["action"] as? String == "arm" {
            let state = observe(selector, previous)
            if call["armed"] as? Bool == true || !same(state["front"] as? DriverObject, previous) || (state["targets"] as? [DriverObject])?.isEmpty != true || !quiet(state, call) { consume(); return ["armed": false] }
            call["armed"] = true; frontCalls[token] = call; return ["armed": true]
        }
        consume()
        guard args["action"] as? String == "finish", args["success"] as? Bool == true, call["armed"] as? Bool == true else { return ["restored": false] }
        let state = observe(selector, previous), targets = state["targets"] as? [DriverObject] ?? []
        guard targets.count == 1, same(state["front"] as? DriverObject, targets.first), same(state["previous"] as? DriverObject, previous),
              identity(targets.first), targets[0]["bundleId"] as? String != previous["bundleId"] as? String,
              driverInteger(targets[0]["pid"]) != driverInteger(previous["pid"]), quiet(state, call) else { return ["restored": false] }
        if io.fixture != nil {
            io.events.append(["activate", previous]); if io.fixture?["activationOK"] as? Bool == false { return ["restored": false] }
        } else {
            guard let pid = driverInteger(previous["pid"]), let app = NSRunningApplication(processIdentifier: pid_t(pid)),
                  !app.isTerminated, app.bundleIdentifier == previous["bundleId"] as? String else { return ["restored": false] }
            try io.request.check(); try io.request.admitInput()
            guard app.activate(options: []) else { return ["restored": false] }
            var confirmed = false
            for _ in 0..<10 {
                try io.sleep(0.01)
                if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier == app.processIdentifier,
                   front.bundleIdentifier == previous["bundleId"] as? String { confirmed = true; break }
            }
            if !confirmed { return ["restored": false] }
        }
        var result = previous; result["restored"] = true; return result
    }

    private var spacesBindingTried = false
    private var connection: Int32 = 0
    private var spacesFunction: (@convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?)?
    private func heldWindows(_ ids: [Int], _ io: DriverLocalIO) -> Int? {
        if let fixture = io.fixture {
            guard let spaces = fixture["spaces"] as? DriverObject else { return nil }
            if !spacesBindingTried {
                spacesBindingTried = true; io.events.append(["bind", "CGSMainConnectionID"])
                connection = fixture["bindThrows"] as? Bool == true ? 0 : Int32(driverInteger(fixture["connection"]) ?? 7)
            }
            guard connection > 0 else { return nil }
            var count = 0
            for id in ids {
                guard id > 0 else { return nil }; io.events.append(["spaces", Int(connection), 7, id])
                guard let list = spaces[String(id)] as? [Any] else { return nil }; if !list.isEmpty { count += 1 }
            }; return count
        }
        if !spacesBindingTried {
            spacesBindingTried = true
            if let handle = dlopen(nil, RTLD_LAZY), let main = dlsym(handle, "CGSMainConnectionID"), let spaces = dlsym(handle, "CGSCopySpacesForWindows") {
                connection = unsafeBitCast(main, to: (@convention(c) () -> Int32).self)()
                spacesFunction = unsafeBitCast(spaces, to: (@convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?).self)
                dlclose(handle)
            }
        }
        guard connection > 0, let spaces = spacesFunction else { return nil }
        var count = 0
        for id in ids {
            guard id > 0, io.request.remaining > 0, let list = spaces(connection, 7, [id] as CFArray)?.takeRetainedValue() as? [Any] else { return nil }
            if !list.isEmpty { count += 1 }
        }; return count
    }
    private func probe(_ args: DriverObject, _ io: DriverLocalIO) throws -> DriverObject {
        if io.fixture?["trusted"] as? Bool == false || io.fixture == nil && !AXIsProcessTrusted() { return ["status": "denied"] }
        guard let selector = args["app"] as? String, !selector.isEmpty else { return ["status": "unknown"] }
        let apps = io.matches(selector, insensitive: true)
        if apps.isEmpty { return ["status": "absent"] }
        guard apps.count == 1, let pid = driverInteger(apps[0]["pid"]) else { return ["status": "unknown"] }
        let app = apps[0], rows = io.cg().filter {
            guard driverInteger($0["kCGWindowOwnerPID"]) == pid, driverInteger($0["kCGWindowLayer"]) == 0,
                  ($0["kCGWindowAlpha"] as? Double ?? 1) > 0, let b = $0["kCGWindowBounds"] as? DriverObject else { return false }
            return (b["Width"] as? Double ?? 0) >= 100 && (b["Height"] as? Double ?? 0) >= 100
        }
        let accessory = app["accessory"] as? Bool == true
        var result: DriverObject = ["hidden": app["hidden"] as? Bool ?? false, "menuBarOnly": accessory,
            "onScreen": rows.filter { $0["kCGWindowIsOnscreen"] as? Bool == true }.count, "allWindows": rows.count]
        // Keep INT14's health identity metadata when the same probe uses RT15.
        result["windowNumbers"] = rows.map { $0["kCGWindowNumber"] ?? NSNull() }
        if let start = app["processStart"] as? Double, start.isFinite, start > 0 { result["processStart"] = start }
        if accessory { result["app"] = app["name"] ?? "" }
        if let count = heldWindows(rows.map { driverInteger($0["kCGWindowNumber"]) ?? 0 }, io) { result["spaceWindows"] = count }
        if let fixture = io.fixture { result["fullScreenSpace"] = fixture["fullScreen"] as? Bool ?? false }
        else if let front = NSWorkspace.shared.frontmostApplication {
            let node = DriverLocalNode(AXUIElementCreateApplication(front.processIdentifier), io)
            if let win = node.node("AXFocusedWindow") { result["fullScreenSpace"] = win.bool("AXFullScreen") ?? false }
        }
        io.axDeadline = args["deadlineSeconds"] as? Double ?? 0.5
        guard io.axDeadline.isFinite, io.axDeadline > 0, io.axDeadline <= 3 else { throw DriverFault("INVALID_PARAMS") }
        var windows: [DriverLocalNode] = [], error = 0
        if let fixture = io.fixture {
            io.events.append(["create", pid]); io.events.append(["deadline", io.axDeadline])
            if fixture["timeoutError"] as? Int != nil && fixture["timeoutError"] as? Int != 0 { result["status"] = "unknown"; return result }
            io.events.append(["read", "AXWindows"])
            error = fixture["error"] as? Int ?? 0
            if error == 0 { windows = try io.root(app).nodes("AXWindows") }
        } else {
            let node = AXUIElementCreateApplication(pid_t(pid)); var values: CFTypeRef?
            guard AXUIElementSetMessagingTimeout(node, Float(min(io.axDeadline, io.request.remaining))) == .success else { result["status"] = "unknown"; return result }
            let status = AXUIElementCopyAttributeValue(node, "AXWindows" as CFString, &values); error = Int(status.rawValue)
            if status == .success { windows = (values as? [AXUIElement] ?? []).map { DriverLocalNode($0, io) } }
        }
        result["pid"] = pid
        if error != 0 { result["status"] = error == -25204 ? "timeout" : error == -25211 ? "denied" : "unknown"; result["error"] = error; return result }
        result["status"] = "responding"; result["windows"] = windows.count
        result["minimized"] = windows.filter { if io.fixture != nil { io.events.append(["read", "AXMinimized"]) }; return $0.bool("AXMinimized") == true }.count
        if windows.count > 1 && windows.count <= 64 {
            let titles = windows.map { try? $0.value("AXTitle") as? String }
            if titles.allSatisfy({ $0 != nil }) { result["windowTitles"] = titles.map { $0! } }
        }
        if windows.isEmpty && !rows.isEmpty && rows.allSatisfy({ $0["kCGWindowName"] as? String == "Save Panel Accessory View" }) {
            result["savePanelOnly"] = true; result["app"] = app["name"] ?? ""
            result["savePanelWindowIds"] = rows.compactMap { driverInteger($0["kCGWindowNumber"]) }.filter { $0 > 0 }
        }; return result
    }
    private func taps(_ io: DriverLocalIO) throws -> DriverObject {
        if let fixture = io.fixture { return ["ok": true, "taps": filterTaps(fixture["taps"] as? [DriverObject] ?? [], io)] }
        var count: UInt32 = 0
        guard CGGetEventTapList(0, nil, &count) == .success, count <= 16384 else { throw LocalToolError("CGGetEventTapList failed") }
        if count == 0 { return ["ok": true, "taps": []] }
        var entries = [CGEventTapInformation](repeating: CGEventTapInformation(), count: Int(count)), actual: UInt32 = 0
        let status = entries.withUnsafeMutableBufferPointer { CGGetEventTapList(count, $0.baseAddress, &actual) }
        guard status == .success, actual <= count else { throw LocalToolError("CGGetEventTapList failed") }
        return ["ok": true, "taps": filterTaps(entries.prefix(Int(actual)).map {
            ["pid": Int($0.tappingProcess), "enabled": $0.enabled, "options": Int($0.options.rawValue), "events": $0.eventsOfInterest]
        }, io)]
    }
    private func filterTaps(_ rows: [DriverObject], _ io: DriverLocalIO) -> [DriverObject] {
        rows.compactMap { row in
            let keys: UInt64 = (1 << 10) | (1 << 11) | (1 << 12)
            guard row["enabled"] as? Bool == true, driverInteger(row["options"]) == 0,
                  let events = row["events"] as? UInt64, events & keys != 0, let pid = driverInteger(row["pid"]) else { return nil }
            let app = io.applications().first { driverInteger($0["pid"]) == pid }
            return ["pid": pid, "app": app?["name"] ?? "", "bundleId": app?["appId"] ?? ""]
        }
    }
}

extension DriverRuntime {
    func registerLocalTools(readOnly: Bool = true) {
        let tools = DriverLocalTools()
        register(method: "localTool") { request, core in
            try request.keys(["args"])
            guard let args = request.params["args"] as? [Any], args.count == 2, let script = args[0] as? String,
                  let params = args[1] as? DriverObject else { throw DriverFault("INVALID_PARAMS") }
            // The preview uses the same timeout boundary as the full transport,
            // but admits only reads until the live input gates pass.
            if readOnly {
                let allowed = script == "keyboard-taps.js" || script == "app-health.js" ||
                    script == "menubar.js" && ["apps", "notifications"].contains(params["op"] as? String ?? "") ||
                    script == "stuck-escape.js" && params["op"] as? String == "check" ||
                    script == "open-file-window.js" && params["op"] == nil
                guard allowed else { throw DriverFault("METHOD_NOT_FOUND") }
            }
            // Leave time to serialize a cooperative timeout before the shared
            // watchdog. A blocked OS provider still uses the parent's restart.
            let local = DriverRequest(copying: request, method: request.method, params: request.params, reserving: 0.25)
            let io = DriverLocalIO(local, fixture: core.inventory.fixture.map { $0["localTools"] as? DriverObject ?? [:] })
            io.verifyDriverIdentity = { identity in
                try local.check()
                let bound = try core.boundWindow(["windowId": identity["windowId"] ?? NSNull(),
                    "processStart": identity["processStart"] ?? NSNull()], request: local)
                if core.inventory.fixture == nil {
                    guard let pid = driverInteger(bound.window["pid"]), let root = bound.root.ax else { throw DriverFault("IDENTITY_UNVERIFIED") }
                    let app = AXUIElementCreateApplication(pid_t(pid))
                    guard AXUIElementSetMessagingTimeout(app, Float(min(0.2, local.remaining))) == .success else { throw DriverFault("IDENTITY_UNVERIFIED") }
                    var focused: CFTypeRef?
                    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused) == .success,
                          let focused = focused, CFGetTypeID(focused) == AXUIElementGetTypeID(),
                          CFEqual(root, focused) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-root") }
                }
                return bound.window
            }
            if script == "stuck-escape.js" && params["op"] as? String != "check" && params["driverIdentity"] == nil {
                throw DriverFault("INVALID_PARAMS")
            }
            do {
                let result = try tools.run(script, params, io)
                try local.check(); return result
            } catch let fault as DriverFault where fault.code == "DEADLINE_EXCEEDED" {
                var result: DriverObject = ["ok": false, "timedOut": true, "helperHealthy": true,
                    "delivery": local.inputAdmitted ? "unknown" : "not-sent", "retry": local.inputAdmitted ? "read-first" : "safe",
                    "error": "Local tool timed out; the shared helper is still healthy." + (local.inputAdmitted ? " Input may have been delivered. Read again before repeating." : " Nothing was sent.")]
                if script == "stuck-escape.js" {
                    result["posted"] = local.inputAdmitted
                    result["uncertain"] = local.inputAdmitted
                }
                return result
            } catch let error as LocalToolError {
                return localToolFailure(error)
            }
        }
    }
}
