// The test inserts production functions here. Every platform call is a fake;
// this executable imports neither AppKit nor ApplicationServices.
import Foundation
typealias CFString = String
typealias CFTypeRef = AnyObject
typealias CGKeyCode = UInt16
typealias CGEventFlags = Set<Int>
enum AXError: Int32 {
    case success = 0, cannotComplete = -25204, attributeUnsupported = -25205
    case noValue = -25212, invalidUIElement = -25202, apiDisabled = -25211
    case parameterizedAttributeUnsupported = -25213, notImplemented = -25208
}
final class AXUIElement {
    var values: [String: AnyObject] = [:]
    var present = true
}
let kAXRoleAttribute = "role", kAXTitleAttribute = "title", kAXChildrenAttribute = "children"
let kAXPressAction = "press", kAXCancelAction = "cancel", kAXRaiseAction = "raise"
let kAXMenuBarAttribute = "bar", kAXMenuRole = "menu", kAXEnabledAttribute = "enabled"
let kAXButtonRole = "button", kAXCloseButtonAttribute = "close", kAXFocusedWindowAttribute = "focused"
let kAXMainWindowAttribute = "main", kAXWindowRole = "window", kAXGroupRole = "group"
let kAXValueAttribute = "value"
let kAXModalAttribute = "modal", kAXSubroleAttribute = "subrole", kAXDialogSubrole = "dialog", kAXSheetRole = "sheet"
var beforeMutation: (() throws -> Void)?
var actionTaken = false
var dialog = false
var dispatched: [String] = []
var failures: [String: [AXError]] = [:]
var reads: [String: Int] = [:]
var timeouts: [Float] = []
var rejectedDispatch = false
var invalidDispatches: [String] = []
var application: AXUIElement?
func require(_ value: Bool, _ message: String) throws {
    if !value { throw MailError(message) }
}
func dispatch(_ label: String) -> Bool {
    // This observation happens inside the fake native call, even when it fails.
    if !actionTaken || dialog { invalidDispatches.append(label); return false }
    dispatched.append(label)
    return !rejectedDispatch
}
func AXUIElementSetMessagingTimeout(_ node: AXUIElement, _ seconds: Float) -> AXError {
    timeouts.append(seconds); return .success
}
func AXUIElementCopyAttributeValue(_ node: AXUIElement, _ attribute: String, _ result: inout CFTypeRef?) -> AXError {
    reads[attribute, default: 0] += 1
    if !(failures[attribute] ?? []).isEmpty {
        let code = failures[attribute]!.removeFirst()
        result = "stale" as NSString
        return code
    }
    guard node.present else { return .invalidUIElement }
    result = node.values[attribute]
    return result == nil ? .noValue : .success
}
func AXUIElementPerformAction(_ node: AXUIElement, _ action: String) -> AXError {
    let accepted = dispatch(action)
    if action == kAXRaiseAction { application?.values[kAXFocusedWindowAttribute] = node }
    if action == kAXCancelAction {
        node.present = false
        if (application?.values[kAXFocusedWindowAttribute] as? AXUIElement) === node {
            application?.values.removeValue(forKey: kAXFocusedWindowAttribute)
        }
    }
    return accepted ? .success : .cannotComplete
}
func AXUIElementSetAttributeValue(_ node: AXUIElement, _ attribute: String, _ value: CFTypeRef) -> AXError {
    dispatch("set") ? .success : .cannotComplete
}
func CFEqual(_ first: AXUIElement, _ second: AXUIElement) -> Bool { first === second }
func element(_ value: CFTypeRef?) -> AXUIElement? { value as? AXUIElement }
func wait() {}
final class Target {
    let bundleIdentifier = "com.apple.mail"
    let processIdentifier: Int32 = 42
    var isTerminated = false
    func activate(options: [Int]) -> Bool { dispatch("activate") }
    func terminate() -> Bool { isTerminated = true; return dispatch("terminate") }
}
final class CGEvent {
    var flags: CGEventFlags = []
    init?(keyboardEventSource: Int?, virtualKey: CGKeyCode, keyDown: Bool) {}
    func postToPid(_ pid: Int32) { _ = dispatch("key") }
}
func requireSettledCreation(_ pending: Bool) throws {}
func emit(_ event: [String: Any]) throws {
    if CommandLine.arguments.count > 1 {
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: event) + Data([10]))
    }
}
func search(_ root: AXUIElement, _ needle: String) throws -> [AXUIElement] { fatalError("Unexpected search") }
// PRODUCTION_GLOBALS
final class Session {
    struct Capture { var elements: [AXUIElement] = [] }
    var capture = Capture()
    let target = Target(), app = AXUIElement()
    let pid: Int32 = 42
    var launched = true, imported = false, removed = false, creationPending = false
    var owned: [AXUIElement] = []
    var mailbox: AXUIElement?, sidebar: AXUIElement?
    var request: [String: Any] = [:]
    var blockedDialog: [String: Any]?
    func safeWait() throws { try checkDialog() }
    func select(_ node: AXUIElement) throws { fatalError("Unexpected import cleanup") }
    func created(_ action: () throws -> Void) throws -> AXUIElement { fatalError("Unexpected creation") }
    // PRODUCTION_METHODS
}

var requestNonce: String? = "fake"
var dialogBlocked = CommandLine.arguments.contains("--dialog")
func main() throws { throw MailError("FAKE_SETUP_STOP") }
if CommandLine.arguments.count > 1 {
    actionTaken = CommandLine.arguments.contains("--action")
    // PRODUCTION_FAILURE
}

do {
    let node = AXUIElement(), session = Session()
    application = session.app
    node.values[kAXRoleAttribute] = kAXWindowRole as NSString
    session.app.values[kAXFocusedWindowAttribute] = node
    // PRODUCTION_GUARD
    node.values[kAXTitleAttribute] = "Sign in" as NSString
    do { try session.checkDialog(); throw MailError("Dialog classification admitted") }
    catch let error as MailError { try require(error.description.contains("MAIL_APP_DIALOG_STOP"), error.description) }
    try require(dialogBlocked && session.blockedDialog != nil && !actionTaken, "Blocked dialog lost receipt suppression")
    node.values.removeValue(forKey: kAXTitleAttribute)
    let operations: [(String, () throws -> Void, [String])] = [
        ("press", { try press(node) }, ["press"]),
        ("set", { try set(node, "value", "fake" as NSString) }, ["set"]),
        ("close", { node.present = true; try close(node) }, ["cancel"]),
        ("focus", { node.present = true; try session.focus(node) }, ["raise", "activate"]),
        ("key", { node.present = true; try session.key(1, [], in: node) }, ["raise", "activate", "key", "key"]),
        ("quit", { try session.cleanup() }, ["terminate"]),
    ]
    for (label, operation, expected) in operations {
        actionTaken = false; dispatched = []; dialog = false; session.blockedDialog = nil
        try operation()
        try require(actionTaken && dispatched == expected, "Dispatch sequence failed: \(label)")
        actionTaken = false; dispatched = []; dialog = true; session.blockedDialog = ["category": "signin"]
        do { try operation(); throw MailError("Dialog admitted: \(label)") }
        catch let error as MailError { try require(error.description == "MAIL_APP_DIALOG_STOP", error.description) }
        try require(!actionTaken && dispatched.isEmpty, "Dialog changed mutation proof: \(label)")
    }
    dialog = false; session.blockedDialog = nil
    let bar = AXUIElement(), item = AXUIElement(), content = AXUIElement()
    session.app.values[kAXMenuBarAttribute] = bar
    bar.values[kAXChildrenAttribute] = [item] as NSArray
    item.values[kAXTitleAttribute] = "File" as NSString
    item.values[kAXChildrenAttribute] = [content] as NSArray
    content.values[kAXRoleAttribute] = kAXMenuRole as NSString
    content.values[kAXChildrenAttribute] = [] as NSArray
    actionTaken = false; dispatched = []
    do {
        try menu(session.app, "File", ["Missing"], beforePress: {})
        throw MailError("Missing menu command admitted")
    } catch let error as MailError { try require(error.description.contains("MAIL_MENU_COMMAND_UNAVAILABLE"), error.description) }
    try require(actionTaken && dispatched == ["press", "cancel"], "Menu cancellation was not tracked")
    rejectedDispatch = true; actionTaken = false; dispatched = []
    do { try press(node); throw MailError("Failed action admitted") }
    catch let error as MailError { try require(error.description.contains("MAIL_AX_PRESS"), error.description) }
    try require(actionTaken && dispatched == ["press"], "Failed action lost mutation proof or retried")
    rejectedDispatch = false
    try require(invalidDispatches.isEmpty, "Untracked or dialog-blocked mutation dispatched")

    var attributeAttempts: [String: Int] = [:]
    node.present = true
    for attribute in [kAXRoleAttribute, kAXChildrenAttribute, kAXMainWindowAttribute] {
        reads = [:]; timeouts = []
        failures[attribute] = [.cannotComplete, .cannotComplete]
        node.values[attribute] = "fresh" as NSString
        let value = try read(node, attribute) as? String
        try require(value == "fresh" && reads[attribute] == 3, "Read did not retry/discard stale value: \(attribute)")
        try require(timeouts == [2], "Read timeout was not scoped to its element")
        attributeAttempts[attribute] = reads[attribute]
        for code in [AXError.cannotComplete, .invalidUIElement, .apiDisabled] {
            reads = [:]; failures[attribute] = Array(repeating: code, count: 4)
            do { _ = try read(node, attribute); throw MailError("Failed read admitted") }
            catch let error as MailError {
                try require(error.description.contains("MAIL_AX_READ") && error.description.contains(String(code.rawValue)), "Wrong read error: \(error)")
            }
            try require(reads[attribute] == (code == .cannotComplete ? 3 : 1), "Wrong failure bound")
        }
        failures[attribute] = [.attributeUnsupported]
        let unsupported = try read(node, attribute)
        try require(unsupported == nil, "Unsupported read lost nil semantics")
        failures[attribute] = [.noValue]
        let missing = try read(node, attribute)
        try require(missing == nil, "Missing read lost nil semantics")
        failures[attribute] = []
    }
    print("{\"mutationSites\":9,\"dialogStops\":6,\"failedActionAttempts\":1,\"readAttempts\":{\"role\":3,\"children\":3,\"main\":3}}")
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(1)
}
