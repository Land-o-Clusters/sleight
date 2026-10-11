// Private AX observer. No engine, input events, AX actions, message values, or body titles.
import AppKit
import ApplicationServices

struct ChatError: Error { let code: String; init(_ code: String) { self.code = code } }
let bundles = ["slack": "com.tinyspeck.slackmacgap", "discord": "com.hnc.Discord", "whatsapp": "net.whatsapp.WhatsApp"]
func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) + Data([10]))
}
func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
func conversation(_ id: String) -> Bool { matches(id, "^(conversation|channel|chat)-[A-Za-z0-9_.-]+$") }
func author(_ id: String) -> Bool { matches(id, "^(message-username|message-author|sender)-[0-9]+$") }
func category(_ title: String, modal: Bool) -> String? {
    let value = title.lowercased()
    if matches(value, "sign[ -]?in|log[ -]?in|first[ -]?run|welcome|qr code") { return "signin" }
    if matches(value, "updat(e|ing)|upgrade|restart to") { return "update" }
    if matches(value, "permission|accessibility|screen recording|allow access|would like to") { return "permission" }
    return modal ? "unrelated-modal" : nil
}

final class Observer {
    let app: AXUIElement
    let deadline = Date().addingTimeInterval(30)
    var count = 0, roles: [String: Int] = [:], seen: [AXUIElement] = [], dialogs = Set<String>()
    var settings: [String: [String: Any]] = [:], changed: [(String, Bool)] = []
    init(_ pid: pid_t) {
        app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2)
    }
    func read(_ node: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
        guard Date() < deadline else { throw ChatError("CHAT_NATIVE_TIMEOUT") }
        var value: CFTypeRef?
        let code = AXUIElementCopyAttributeValue(node, attribute as CFString, &value)
        if code == .attributeUnsupported || code == .noValue { return nil }
        guard code == .success else { throw ChatError("CHAT_AX_UNAVAILABLE") }
        return value
    }
    func text(_ node: AXUIElement, _ attribute: String) throws -> String { try read(node, attribute) as? String ?? "" }
    func windows() throws -> [AXUIElement] { try read(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] }
    func enable() throws {
        for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            var settable: DarwinBoolean = false
            let code = AXUIElementIsAttributeSettable(app, name as CFString, &settable)
            guard let old = try read(app, name) as? Bool else {
                settings[name] = ["set": code == .attributeUnsupported ? "unsupported" : "unreadable", "restored": true]
                continue
            }
            if old { settings[name] = ["set": "already-enabled", "restored": true]; continue }
            guard code == .success, settable.boolValue else {
                settings[name] = ["set": "unsupported", "restored": true]; continue
            }
            // Record restoration before the write, including a failed or interrupted write.
            changed.append((name, old))
            let status = AXUIElementSetAttributeValue(app, name as CFString, kCFBooleanTrue)
            settings[name] = ["set": status == .success ? "enabled" : "refused", "restored": false]
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    }
    func restore() -> Bool {
        var restored = true
        for (name, old) in changed.reversed() {
            let code = AXUIElementSetAttributeValue(app, name as CFString, old ? kCFBooleanTrue : kCFBooleanFalse)
            var actual: CFTypeRef?
            let readCode = AXUIElementCopyAttributeValue(app, name as CFString, &actual)
            let okay = code == .success && readCode == .success && (actual as? Bool) == old
            settings[name]?["restored"] = okay
            restored = restored && okay
        }
        changed = []
        return restored
    }
    func scan(_ node: AXUIElement, depth: Int = 0, scroll: [String: Double]? = nil) throws -> [String: Any]? {
        if seen.contains(where: { CFEqual($0, node) }) { return nil }
        guard count < 6000, depth <= 32 else { throw ChatError("CHAT_AX_LIMIT") }
        seen.append(node); count += 1
        let role = try text(node, kAXRoleAttribute)
        if matches(role, "^AX[A-Za-z]{1,48}$") { roles[role, default: 0] += 1 }
        let id = try text(node, kAXIdentifierAttribute)
        let selected = (try read(node, kAXSelectedAttribute) as? Bool) == true
        var result: [String: Any] = ["role": role, "identifier": id, "selected": selected]
        // Window and dialog titles stay inside this process and become category codes only.
        let subrole = try text(node, kAXSubroleAttribute)
        if role == kAXWindowRole || role == kAXSheetRole || subrole == "AXDialog" || subrole == "AXSystemDialog" {
            let explicitModal = (try read(node, kAXModalAttribute) as? Bool) == true
            let modal = role == kAXSheetRole || subrole == "AXDialog" || subrole == "AXSystemDialog" || explicitModal
            if let value = category(try text(node, kAXTitleAttribute), modal: modal) { dialogs.insert(value) }
        }
        if (selected && conversation(id) && ["AXRow", "AXLink", "AXTab", "AXButton"].contains(role)) ||
            (author(id) && ["AXStaticText", "AXButton", "AXLink"].contains(role)) {
            let value = try text(node, kAXTitleAttribute)
            guard value.count <= 1024 else { throw ChatError("CHAT_AX_LIMIT") }
            result["title"] = value
        }
        var position = scroll
        if role == kAXScrollAreaRole {
            position = nil
            if let value = try read(node, kAXVerticalScrollBarAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() {
                let bar = value as! AXUIElement
                if let current = try read(bar, kAXValueAttribute) as? Double,
                    let min = try read(bar, kAXMinValueAttribute) as? Double,
                    let max = try read(bar, kAXMaxValueAttribute) as? Double {
                    position = ["value": current, "min": min, "max": max]
                }
            }
        }
        if ["chat-messages", "message-list", "messages"].contains(id), let position { result["scroll"] = position }
        let children = try read(node, kAXChildrenAttribute) as? [AXUIElement] ?? []
        result["children"] = try children.compactMap { try scan($0, depth: depth + 1, scroll: position) }
        return result
    }
    func snapshot() -> [String: Any] {
        var output: [String: Any] = [:]
        var problem: String?
        do {
            // The tree as the app gives it, the way the engine reads it. Turning on AXManualAccessibility
            // or AXEnhancedUserInterface and restoring it couldn't be confirmed in Slack or WhatsApp
            // (2026-10-11), and the engine read Slack's 161 elements without either.
            let initial = try windows()
            output["nodes"] = try initial.compactMap { try scan($0) }
            let after = try windows()
            guard initial.count == after.count, initial.allSatisfy({ window in after.contains(where: { CFEqual(window, $0) }) }) else {
                throw ChatError("CHAT_WINDOW_OWNERSHIP_UNPROVED")
            }
            if initial.count != 1 && dialogs.isEmpty { throw ChatError("CHAT_WINDOW_OWNERSHIP_UNPROVED") }
        } catch { problem = (error as? ChatError)?.code ?? "CHAT_AX_UNAVAILABLE" }
        if !restore() { problem = "CHAT_AX_RESTORE_UNCONFIRMED" }
        if let problem { output["failureCode"] = problem; output["nodes"] = [] }
        output["dialogs"] = dialogs.sorted()
        output["diagnostics"] = ["nodeCount": count, "roles": roles, "accessibility": settings]
        return output
    }
}

func main() throws {
    guard let data = CommandLine.arguments.dropFirst().first?.data(using: .utf8),
        let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        request["ownerPresent"] as? Bool == true else { throw ChatError("CHAT_OWNER_PRESENT_UNPROVED") }
    guard let kind = request["kind"] as? String, let bundle = bundles[kind],
        let operation = request["operation"] as? String, ["table", "launch", "observe", "quit"].contains(operation) else { throw ChatError("CHAT_SETUP_FAILED") }
    func running() -> [NSRunningApplication] { NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundle && !$0.isTerminated } }
    func table() -> [String: Any] {
        let processes: [[String: Any]] = running().map { ["pid": Int($0.processIdentifier), "launchedAt": $0.launchDate?.timeIntervalSince1970 as Any? ?? NSNull()] }
        let frontmost: Any = NSWorkspace.shared.frontmostApplication?.bundleIdentifier as Any? ?? NSNull()
        return ["processes": processes, "frontmost": frontmost, "trusted": AXIsProcessTrusted()]
    }
    if operation == "launch" {
        guard AXIsProcessTrusted() else { throw ChatError("CHAT_ACCESSIBILITY_UNAVAILABLE") }
        // Recheck at the actual launch boundary, after helper preparation.
        if !running().isEmpty { var output = table(); output["launched"] = false; output["openIssued"] = false; try emit(output); return }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        child.arguments = ["-g", "-b", bundle]
        child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        let boundary = Date()
        var launchFailed = false
        do {
            try child.run()
            let deadline = Date().addingTimeInterval(15)
            while child.isRunning && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
            if child.isRunning {
                child.terminate()
                let collection = Date().addingTimeInterval(5)
                while child.isRunning && Date() < collection { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
                guard !child.isRunning else { throw ChatError("CHAT_HELPER_UNCOLLECTED") }
                launchFailed = true
            }
            child.waitUntilExit()
            launchFailed = launchFailed || child.terminationStatus != 0
        } catch let error as ChatError { throw error }
        catch { launchFailed = true }
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline && (running().isEmpty || running().contains(where: { !$0.isFinishedLaunching })) {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        let candidates = running()
        guard candidates.count <= 1 else { throw ChatError("CHAT_PROCESS_AMBIGUOUS") }
        // A process from before the dispatch belongs to the owner, including a late table arrival.
        let owned = candidates.first?.launchDate.map { $0 >= boundary } ?? false
        var output = table(); output["launched"] = owned; output["openIssued"] = true
        if candidates.isEmpty || launchFailed { output["failureCode"] = "CHAT_LAUNCH_FAILED" }
        try emit(output); return
    }
    if operation == "table" {
        if request["waitForLaunch"] as? Bool == true {
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline && (running().isEmpty || running().contains(where: { !$0.isFinishedLaunching })) {
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            }
        }
        try emit(table()); return
    }
    guard let identity = request["identity"] as? [String: Any], let pid = identity["pid"] as? Int32,
        let launchedAt = identity["launchedAt"] as? Double else { throw ChatError("CHAT_PROCESS_CHANGED") }
    let candidates = running()
    guard candidates.count <= 1 else { throw ChatError("CHAT_PROCESS_AMBIGUOUS") }
    guard let target = candidates.first else {
        if operation == "quit" { try emit(["quit": true]); return }
        throw ChatError("CHAT_NOT_RUNNING")
    }
    guard target.processIdentifier == pid, target.launchDate?.timeIntervalSince1970 == launchedAt else { throw ChatError("CHAT_PROCESS_CHANGED") }
    if operation == "quit" {
        // Never select another process by bundle for cleanup, and never force-quit.
        guard target.terminate() else { throw ChatError("CHAT_CLEANUP_UNCONFIRMED") }
        let deadline = Date().addingTimeInterval(10)
        while !target.isTerminated && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        guard target.isTerminated else { throw ChatError("CHAT_CLEANUP_UNCONFIRMED") }
        try emit(["quit": true]); return
    }
    guard AXIsProcessTrusted() else { throw ChatError("CHAT_ACCESSIBILITY_UNAVAILABLE") }
    let output = Observer(pid).snapshot()
    guard !target.isTerminated, target.launchDate?.timeIntervalSince1970 == launchedAt else { throw ChatError("CHAT_PROCESS_CHANGED") }
    try emit(output)
}
do { try main() }
catch { FileHandle.standardError.write(Data(((error as? ChatError)?.code ?? "CHAT_SETUP_FAILED").utf8) + Data([10])); exit(1) }
