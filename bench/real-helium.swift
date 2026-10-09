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
    private(set) var commandIssued = false
    var count: Int { elements.count }
    let equal: (Element, Element) -> Bool
    init(equal: @escaping (Element, Element) -> Bool) { self.equal = equal }
    func created(_ element: Element) {
        if !elements.contains(where: { equal($0, element) }) { elements.append(element) }
    }
    func unique() throws -> Element? {
        guard elements.count <= 1 else { throw FixtureError("Ambiguous new browser windows; no window inspected") }
        return elements.first
    }
    func requireEmpty() throws {
        guard elements.isEmpty else { throw FixtureError("Browser window created before fixture command; ownership refused") }
    }
    func beginCommand() throws { try requireEmpty(); commandIssued = true }
}

func fixtureCandidate<Element>(_ state: CreatedWindow<Element>, matches: (Element) throws -> Bool) throws -> Element? {
    guard let candidate = try state.unique(), try matches(candidate) else { return nil }
    return candidate
}

func navigateRetained<Element>(_ state: CreatedWindow<Element>, ownerAway: Bool = false, blank: (Element) throws -> Bool,
    retain: (Element) -> Void, navigate: (Element) throws -> Void) throws {
    guard ownerAway else { throw FixtureError("Safari blank-window navigation requires an explicit owner-away boundary") }
    guard state.commandIssued else { throw FixtureError("Browser creation command was not issued; navigation refused") }
    guard let candidate = try fixtureCandidate(state, matches: blank) else { throw FixtureError("New blank browser window unconfirmed") }
    retain(candidate)
    try navigate(candidate)
}

func safariWindowCommand(_ titles: [String]) throws -> Int {
    let plain = titles.indices.filter { titles[$0] == "New Window" }
    if plain.count == 1 { return plain[0] }
    guard plain.isEmpty, let profile = titles.indices.first(where: {
        titles[$0].hasPrefix("New ") && titles[$0].hasSuffix(" Window") && titles[$0] != "New Private Window"
    }) else { throw FixtureError("Safari new-window command unavailable or ambiguous") }
    return profile
}

func emit(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}

func recoverRetained<Element>(_ window: Element?, present: (Element) throws -> Bool, close: (Element) throws -> Void, wait: () -> Void) throws -> String {
    guard let window else { return "unconfirmed" }
    if try !present(window) { return "closed retained fixture" }
    try close(window)
    for _ in 0..<30 { wait(); if try !present(window) { return "closed retained fixture" } }
    throw FixtureError("Retained Helium fixture cleanup unconfirmed")
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
    let unrelated = CreatedWindow<String>(equal: ==)
    unrelated.created("owner-created-window")
    var retained: String?
    retained = try fixtureCandidate(unrelated, matches: { _ in false })
    guard retained == nil else { throw FixtureError("Unmatched window acquired") }
    do { retained = try fixtureCandidate(unrelated, matches: { _ in throw FixtureError("Read failed") }) } catch {}
    guard retained == nil else { throw FixtureError("Unreadable window acquired") }
    var open = true
    let recovery = try recoverRetained("fixture", present: { _ in open }, close: { value in
        guard value == "fixture" else { throw FixtureError("Another window closed") }; open = false
    }, wait: {})
    guard recovery == "closed retained fixture", try recoverRetained(nil as String?, present: { _ in true },
        close: { _ in throw FixtureError("Missing reference closed") }, wait: {}) == "unconfirmed" else { throw FixtureError("Retained recovery failed") }
    let fresh = CreatedWindow<String>(equal: ==)
    try fresh.beginCommand()
    fresh.created("fixture")
    var navigation: [String] = []
    retained = nil
    try navigateRetained(fresh, ownerAway: true, blank: { $0 == "fixture" }, retain: { retained = $0 }, navigate: {
        guard retained == $0 else { throw FixtureError("Navigation preceded retention") }; navigation.append($0)
    })
    guard navigation == ["fixture"] else { throw FixtureError("Owner window navigated") }
    for candidate in [unrelated, state] {
        do { try navigateRetained(candidate, ownerAway: true, blank: { _ in true }, retain: { _ in },
            navigate: { _ in navigation.append("unexpected") }) } catch {}
    }
    guard navigation == ["fixture"] else { throw FixtureError("Unproven window navigated") }
    guard try safariWindowCommand(["New Private Window", "New Personal Window", "New Work Window"]) == 1 else { throw FixtureError("Private profile command selected") }
    var ambiguousCommandRefused = false
    do { _ = try safariWindowCommand(["New Window", "New Window"]) } catch { ambiguousCommandRefused = true }
    guard ambiguousCommandRefused else { throw FixtureError("Ambiguous menu command admitted") }
    var preActionBlankRefused = false
    do { try unrelated.requireEmpty() } catch { preActionBlankRefused = true }
    guard preActionBlankRefused else { throw FixtureError("Pre-command owner blank window admitted") }
    let delayed = CreatedWindow<String>(equal: ==)
    try delayed.beginCommand()
    delayed.created("owner-created-before-delayed-fixture")
    var postCommandBlankRefused = false
    do { try navigateRetained(delayed, blank: { _ in true }, retain: { _ in }, navigate: { _ in navigation.append("owner") }) }
    catch { postCommandBlankRefused = true }
    delayed.created("delayed-fixture")
    guard postCommandBlankRefused, navigation == ["fixture"] else { throw FixtureError("Post-command owner blank window navigated") }
    try emit(["delayedFixture": true, "ambiguousCreationRefused": true, "existingWindowsRead": 0, "retainedRecovery": true, "unmatchedCreationUnowned": true, "retainedNavigation": true, "profileCommands": true, "preActionBlankRefused": true, "postCommandBlankRefused": true])
}

var freshSetup = false, createdFixture = false, actionTaken = false
var retryStarted: Date?
var retryWaitMs = 0

func read(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    var code = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    while freshSetup && !createdFixture && (code == .cannotComplete || code == .attributeUnsupported) {
        retryStarted = retryStarted ?? Date()
        guard Date().timeIntervalSince(retryStarted!) < 15 else { break }
        let before = Date()
        wait()
        retryWaitMs = Int(Date().timeIntervalSince(retryStarted!) * 1000)
        try emit(["stage": "retry", "code": code.rawValue, "waitMs": Int(Date().timeIntervalSince(before) * 1000), "totalWaitMs": retryWaitMs])
        code = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    }
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

func children(_ element: AXUIElement) throws -> [AXUIElement] { try read(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func press(_ element: AXUIElement) throws {
    actionTaken = true
    try emit(["stage": "action", "actionTaken": true])
    guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { throw FixtureError("Safari fixture press failed") }
}
func newSafariWindow(_ app: AXUIElement, beforeCreate: () throws -> Void) throws {
    guard let bar = try read(app, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else { throw FixtureError("Safari File menu unavailable") }
    let files = try children(bar as! AXUIElement).filter { try text($0, kAXTitleAttribute) == "File" }
    guard files.count == 1 else { throw FixtureError("Safari File menu ambiguous") }
    var menus: [AXUIElement] = []
    do {
        try press(files[0])
        menus = try children(files[0]).filter { try text($0, kAXRoleAttribute) == kAXMenuRole }
        guard menus.count == 1 else { throw FixtureError("Safari File menu contents unconfirmed") }
        let items = try children(menus[0])
        let index = try safariWindowCommand(items.map { try text($0, kAXTitleAttribute) })
        try beforeCreate()
        try press(items[index])
    } catch {
        guard AXUIElementPerformAction(menus.first ?? files[0], "AXCancel" as CFString) == .success else { throw FixtureError("Safari failed-menu cancellation unconfirmed: \(error)") }
        try emit(["stage": "menu-cancel", "menuCancelled": true, "menuCancelMethod": "AXCancel"])
        throw error
    }
}
func blankSafariWindow(_ window: AXUIElement) throws -> Bool {
    let document = try text(window, kAXDocumentAttribute), title = try text(window, kAXTitleAttribute)
    return (document.isEmpty || document == "about:blank") && (title.isEmpty || title == "Start Page" || title == "Untitled")
}
func navigateSafariWindow(_ window: AXUIElement, target: String) throws {
    func fields(_ element: AXUIElement, _ depth: Int) throws -> [AXUIElement] {
        guard depth > 0 else { return [] }
        var result: [AXUIElement] = []
        for child in try children(element) {
            let role = try text(child, kAXRoleAttribute)
            if role == kAXTextFieldRole {
                if try text(child, kAXDescriptionAttribute) == "Smart Search Field" { result.append(child) }
            }
            if [kAXGroupRole, kAXToolbarRole, kAXSplitGroupRole, kAXComboBoxRole].contains(role) { result += try fields(child, depth - 1) }
        }
        return result
    }
    let addresses = try fields(window, 8)
    try emit(["stage": "navigation", "navigation": ["addressFieldCount": addresses.count]])
    guard addresses.count == 1 else { throw FixtureError("Retained Safari address field unavailable or ambiguous") }
    let field = addresses[0]
    var settable: DarwinBoolean = false
    var actions: CFArray?
    guard AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
          AXUIElementCopyActionNames(field, &actions) == .success,
          (actions as? [String] ?? []).contains(kAXConfirmAction) else { throw FixtureError("Retained Safari address field cannot navigate without keyboard input") }
    guard try blankSafariWindow(window) else { throw FixtureError("New Safari window changed before navigation") }
    actionTaken = true
    guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, target as CFString) == .success,
          AXUIElementPerformAction(field, kAXConfirmAction as CFString) == .success else { throw FixtureError("Retained Safari navigation failed") }
}

func recoverSetup(_ owned: AXUIElement?) throws -> String {
    try recoverRetained(owned, present: present, close: { window in
        guard let button = try read(window, kAXCloseButtonAttribute), CFGetTypeID(button) == AXUIElementGetTypeID(),
              AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success else {
            throw FixtureError("Retained Helium fixture close failed")
        }
    }, wait: wait)
}

func fixture(_ argument: String) throws {
    guard let data = argument.data(using: .utf8),
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let bundle = request["bundle"] as? String, ["net.imput.helium", "com.apple.Safari"].contains(bundle),
          request["mode"] as? String == "window",
          let target = request["target"] as? String, target.hasPrefix("http://127.0.0.1:"),
          let token = request["token"] as? String, !token.isEmpty,
          let control = request["control"] as? String else { throw FixtureError("Invalid Helium fixture request") }
    guard AXIsProcessTrusted() else { throw FixtureError("Accessibility unavailable; Helium fixture not opened") }
    let safari = bundle == "com.apple.Safari"
    guard !safari || request["ownerAway"] as? Bool == true else { throw FixtureError("Safari setup requires an explicit owner-away boundary") }
    var applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
    let running = !applications.isEmpty
    if safari {
        try emit(["stage": "launch", "running": running])
        var reportedPID: pid_t?
        for _ in 0..<100 {
            applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
            if applications.count == 1, reportedPID == nil {
                reportedPID = applications[0].processIdentifier
                try emit(["stage": "launched", "pid": reportedPID!])
            }
            if applications.count == 1 && applications[0].isFinishedLaunching { break }
            wait()
        }
    }
    guard applications.count == 1, applications[0].isFinishedLaunching else {
        try emit(["stage": "untouched"])
        throw FixtureError("Helium must already be running with one real profile process")
    }
    let pid = applications[0].processIdentifier
    try emit(["stage": "identified", "running": running, "pid": pid])
    freshSetup = safari && !running
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    var setup = true
    var owned: AXUIElement?
    do {
    let created = CreatedWindow<AXUIElement>(equal: { CFEqual($0, $1) })
    var observer: AXObserver?
    let callback: AXObserverCallback = { _, element, notification, refcon in
        guard notification as String == kAXWindowCreatedNotification, let refcon else { return }
        createdFixture = true
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
        guard current.bundleIdentifier == bundle else { throw FixtureError("Browser fixture process changed") }
        return !current.isTerminated
    }
    try emit(["stage": "armed", "running": running, "pid": pid])
    while command() != "opened" {
        if command() == "close" { throw FixtureError("Helium opening cancelled before identity recorded") }
        wait()
    }
    if safari {
        try newSafariWindow(app, beforeCreate: { wait(); try created.beginCommand() })
        for _ in 0..<30 {
            wait()
            if try created.unique() != nil { break }
        }
        wait()
        var creation: [String: Any] = ["count": created.count]
        if let candidate = try created.unique() {
            let document = try text(candidate, kAXDocumentAttribute), title = try text(candidate, kAXTitleAttribute)
            creation["blank"] = try blankSafariWindow(candidate)
            creation["documentScheme"] = document.isEmpty ? "absent" : String(document.prefix(while: { $0 != ":" }).prefix(32))
            creation["titleKind"] = title.isEmpty ? "empty" : title == "Start Page" ? "start-page" : title == "Untitled" ? "untitled" : "other"
        }
        try emit(["stage": "creation", "creation": creation])
        try navigateRetained(created, ownerAway: request["ownerAway"] as? Bool == true, blank: blankSafariWindow, retain: { owned = $0; createdFixture = true },
            navigate: { try navigateSafariWindow($0, target: target) })
    }
    var ready = false
    for _ in 0..<200 {
        if command() == "close" { throw FixtureError("Helium opening cancelled before identity recorded") }
        guard try sameProcess() else { throw FixtureError("Helium exited during fixture setup") }
        // Pump first so all queued creation events are checked for ambiguity.
        wait()
        if !safari { owned = nil }
        if let candidate = try fixtureCandidate(created, matches: { try matches($0, target: target, token: token) }) {
            owned = candidate; ready = true; break
        }
    }
    guard ready, let owned else { throw FixtureError("New Helium fixture identity unconfirmed") }
    AXObserverRemoveNotification(observer, app, kAXWindowCreatedNotification as CFString)
    try emit(["stage": "ready", "pid": pid, "fresh": !running, "totalWaitMs": retryWaitMs])
    setup = false
    freshSetup = false
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
            freshSetup = false
            var event: [String: Any] = ["stage": "setup-failure", "fresh": !running, "actionTaken": actionTaken, "totalWaitMs": retryWaitMs, "pid": pid]
            do {
                if let current = NSRunningApplication(processIdentifier: pid), !current.isTerminated {
                    guard current.bundleIdentifier == bundle else { throw FixtureError("Browser process changed before recovery") }
                    if let owned, try present(owned), try !matches(owned, target: target, token: token) && !(safari && (try blankSafariWindow(owned))) {
                        event["cleanup"] = "unconfirmed"
                    } else { event["cleanup"] = try recoverSetup(owned) }
                } else { event["cleanup"] = owned == nil ? "unconfirmed" : "closed retained fixture" }
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
