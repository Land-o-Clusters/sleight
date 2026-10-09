// Native AX window-created events provide references without inspecting any
// existing owner window. No Automation permission or browser profile override.
import AppKit
import ApplicationServices

struct FixtureError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

final class CreatedWindow<Element> {
    private var elements: [Element] = []
    let equal: (Element, Element) -> Bool
    init(equal: @escaping (Element, Element) -> Bool) { self.equal = equal }
    func created(_ element: Element) {
        if !elements.contains(where: { equal($0, element) }) { elements.append(element) }
    }
    func unique() throws -> Element? {
        guard elements.count <= 1 else { throw FixtureError("Ambiguous new Helium windows; no window inspected") }
        return elements.first
    }
}

func emit(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}

func exactMatches<Element>(_ windows: [Element], title: String, readTitle: (Element) throws -> String) throws -> [Element] {
    let matches = try windows.filter { try readTitle($0) == title }
    guard matches.count <= 1 else { throw FixtureError("Exact Helium fixture title is ambiguous") }
    return matches
}

// Pure regression: switching between two pre-existing windows cannot grant
// ownership. Only a creation event grants a candidate; two events refuse it.
func selfTest() throws {
    let state = CreatedWindow<String>(equal: ==)
    let ownerWindows = ["owner-a", "owner-b"]
    for _ in ownerWindows { guard try state.unique() == nil else { throw FixtureError("Existing window admitted") } }
    state.created("fixture")
    state.created("fixture")
    guard try state.unique() == "fixture" else { throw FixtureError("Delayed creation lost") }
    state.created("concurrent-new-window")
    var refused = false
    do { _ = try state.unique() } catch { refused = true }
    guard refused else { throw FixtureError("Ambiguous creation admitted") }
    let titles = ["owner": "private title", "prefix": "Form abc extra", "own": "Form abc"]
    guard try exactMatches(["owner", "prefix", "own"], title: "Form abc", readTitle: { titles[$0]! }) == ["own"],
          try exactMatches(["owner", "prefix"], title: "Form abc", readTitle: { titles[$0]! }).isEmpty else {
        throw FixtureError("Exact-title recovery admitted another window")
    }
    var recoveryRefused = false
    do { _ = try exactMatches(["own", "own"], title: "Form abc", readTitle: { titles[$0]! }) } catch { recoveryRefused = true }
    guard recoveryRefused else { throw FixtureError("Ambiguous recovery admitted") }
    try emit(["delayedFixture": true, "ambiguousCreationRefused": true, "existingWindowsRead": 0, "exactTitleRecovery": true])
}

func read(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if code == .attributeUnsupported || code == .noValue { return nil }
    guard code == .success else { throw FixtureError("AX fixture read failed: \(code.rawValue)") }
    return value
}
func text(_ element: AXUIElement, _ name: String) throws -> String {
    try read(element, name) as? String ?? ""
}
func present(_ window: AXUIElement) throws -> Bool {
    var role: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(window, kAXRoleAttribute as CFString, &role)
    if code == .invalidUIElement { return false }
    guard code == .success else { throw FixtureError("AX fixture existence failed: \(code.rawValue)") }
    return role as? String == kAXWindowRole
}
func matches(_ window: AXUIElement, target: String, token: String) throws -> Bool {
    let document = try text(window, kAXDocumentAttribute)
    if !document.isEmpty { return document == target || document.hasPrefix(target + "#") }
    return try text(window, kAXTitleAttribute).contains(token)
}
func wait() { CFRunLoopRunInMode(.defaultMode, 0.1, false) }

func recoverSetup(_ app: AXUIElement, title: String) throws -> String {
    func ownWindows() throws -> [AXUIElement] {
        guard let windows = try read(app, kAXWindowsAttribute) as? [AXUIElement] else {
            throw FixtureError("Helium windows unavailable for exact-title recovery")
        }
        return try exactMatches(windows, title: title, readTitle: { try text($0, kAXTitleAttribute) })
    }
    let windows = try ownWindows()
    guard windows.count <= 1 else { throw FixtureError("Exact Helium fixture title is ambiguous") }
    guard let owned = windows.first else { return "nothing created" }
    guard let button = try read(owned, kAXCloseButtonAttribute), CFGetTypeID(button) == AXUIElementGetTypeID(),
          AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success else {
        throw FixtureError("Exact Helium fixture close failed")
    }
    for _ in 0..<30 { wait(); if try ownWindows().isEmpty { return "closed own fixture" } }
    throw FixtureError("Exact Helium fixture cleanup unconfirmed")
}

func fixture(_ argument: String) throws {
    guard let data = argument.data(using: .utf8),
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          request["bundle"] as? String == "net.imput.helium",
          request["mode"] as? String == "window",
          let target = request["target"] as? String, target.hasPrefix("http://127.0.0.1:"),
          let token = request["token"] as? String, !token.isEmpty,
          let control = request["control"] as? String else { throw FixtureError("Invalid Helium fixture request") }
    guard AXIsProcessTrusted() else { throw FixtureError("Accessibility unavailable; Helium fixture not opened") }
    let applications = NSRunningApplication.runningApplications(withBundleIdentifier: "net.imput.helium")
    guard applications.count == 1 else {
        try emit(["stage": "untouched"])
        throw FixtureError("Helium must already be running with one real profile process")
    }
    let pid = applications[0].processIdentifier
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    var setup = true
    do {
    let created = CreatedWindow<AXUIElement>(equal: { CFEqual($0, $1) })
    var observer: AXObserver?
    let callback: AXObserverCallback = { _, element, notification, refcon in
        guard notification as String == kAXWindowCreatedNotification, let refcon else { return }
        Unmanaged<CreatedWindow<AXUIElement>>.fromOpaque(refcon).takeUnretainedValue().created(element)
    }
    guard AXObserverCreate(pid, callback, &observer) == .success, let observer else {
        throw FixtureError("Helium window-created observer unavailable")
    }
    let refcon = Unmanaged.passUnretained(created).toOpaque()
    guard AXObserverAddNotification(observer, app, kAXWindowCreatedNotification as CFString, refcon) == .success else {
        throw FixtureError("Helium window-created notification unavailable")
    }
    let source = AXObserverGetRunLoopSource(observer)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
    defer {
        AXObserverRemoveNotification(observer, app, kAXWindowCreatedNotification as CFString)
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .defaultMode)
        withExtendedLifetime(created) {}
    }
    func command() -> String {
        guard let data = FileManager.default.contents(atPath: control),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return "" }
        return object["command"] ?? ""
    }
    func sameProcess() throws -> Bool {
        guard let current = NSRunningApplication(processIdentifier: pid) else { return false }
        guard current.bundleIdentifier == "net.imput.helium" else { throw FixtureError("Helium fixture process changed") }
        return !current.isTerminated
    }
    try emit(["stage": "armed", "running": true])
    while command() != "opened" {
        if command() == "close" { throw FixtureError("Helium opening cancelled before identity recorded") }
        wait()
    }
    var owned: AXUIElement?
    for _ in 0..<200 {
        if command() == "close" { throw FixtureError("Helium opening cancelled before identity recorded") }
        guard try sameProcess() else { throw FixtureError("Helium exited during fixture setup") }
        // Pump first so all queued creation events are checked for ambiguity.
        wait()
        if let candidate = try created.unique(), try matches(candidate, target: target, token: token) {
            owned = candidate; break
        }
    }
    guard let owned else { throw FixtureError("New Helium fixture identity unconfirmed") }
    AXObserverRemoveNotification(observer, app, kAXWindowCreatedNotification as CFString)
    try emit(["stage": "ready", "pid": pid])
    setup = false
    while command() != "close" { wait() }
    if try sameProcess(), try present(owned) {
        guard try matches(owned, target: target, token: token) else { throw FixtureError("Owned Helium document identity changed") }
        guard let button = try read(owned, kAXCloseButtonAttribute), CFGetTypeID(button) == AXUIElementGetTypeID() else {
            throw FixtureError("Owned Helium window has no close button")
        }
        guard AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success else {
            throw FixtureError("Owned Helium close failed")
        }
        var closed = false
        for _ in 0..<30 { wait(); if try !present(owned) { closed = true; break } }
        guard closed else { throw FixtureError("Owned Helium window is still open") }
    }
    try emit(["stage": "closed"])
    } catch {
        if setup {
            var event: [String: Any] = ["stage": "setup-failure", "fresh": false, "actionTaken": false, "totalWaitMs": 0]
            do {
                guard request["fixtureTitle"] as? String == "Form \(token)" else { throw FixtureError("No exact Helium fixture title") }
                if let current = NSRunningApplication(processIdentifier: pid), !current.isTerminated {
                    guard current.bundleIdentifier == "net.imput.helium" else { throw FixtureError("Helium process changed before recovery") }
                    event["cleanup"] = try recoverSetup(app, title: "Form \(token)")
                } else { event["cleanup"] = "nothing created" }
            } catch { event["cleanupError"] = String(describing: error) }
            try emit(event)
        }
        throw error
    }
}

do {
    if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--self-test" { try selfTest() }
    else {
        guard CommandLine.arguments.count == 2 else { throw FixtureError("One fixture request required") }
        try fixture(CommandLine.arguments[1])
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
