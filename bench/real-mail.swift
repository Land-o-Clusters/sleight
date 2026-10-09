// Mail fixture lifecycle. Only creation events confer window ownership. Native
// AX and AppKit avoid Apple Events, account inventories and Library/Mail reads.
import AppKit
import ApplicationServices

struct MailError: Error, CustomStringConvertible {
    let description: String
    init(_ value: String) { description = value }
}
var beforeMutation: (() throws -> Void)?
func dialogCategory(_ title: String, modal: Bool) -> String? {
    let value = title.lowercased()
    if value.contains("permission") || value.contains("accessibility") || value.contains("screen recording") || value.hasPrefix("allow ") { return "permission" }
    if value.contains("sign in") || value.contains("sign-in") || value.contains("add account") || value.contains("choose a mail account") { return "signin" }
    if value.contains("welcome to mail") || value.contains("get started") || value.contains("first run") { return "first-run" }
    if value.contains("activation") || value.contains("license") { return "licensing" }
    return modal ? "unrelated-modal" : nil
}
func fixtureDialogTitle(_ title: String) -> Bool {
    ["Import", "Import Mailboxes", "Export Mailbox", "Choose", "Open", "Select", "Delete Mailbox", "Go to the folder:", "Go to Folder"].contains(title)
}
final class Creation<Element> {
    var issued = false
    var elements: [Element] = []
    let equal: (Element, Element) -> Bool
    init(_ equal: @escaping (Element, Element) -> Bool) { self.equal = equal }
    func begin() throws {
        guard elements.isEmpty else { throw MailError("MAIL_PRECOMMAND_CREATION: ownership refused") }
        issued = true
    }
    func created(_ element: Element) {
        if !elements.contains(where: { equal($0, element) }) { elements.append(element) }
    }
    func unique() throws -> Element? {
        guard issued, elements.count <= 1 else { throw MailError("MAIL_AMBIGUOUS_CREATION: ownership refused") }
        return elements.first
    }
}
func localImportProof(_ text: [String], name: String) throws {
    guard text.contains(where: { $0.contains(name) }) else { throw MailError("MAIL_IMPORT_SOURCE_UNPROVED: nonce fixture missing from retained import preview") }
    guard text.contains(where: { $0.contains("On My Mac") }) else { throw MailError("MAIL_IMPORT_LOCAL_DESTINATION_UNPROVED: retained import preview does not prove a local destination") }
}
func requireSettledCreation(_ pending: Bool) throws {
    guard !pending else { throw MailError("MAIL_CREATION_CLEANUP_UNCONFIRMED: a creation command has no retained completion reference") }
}
func selfTest() throws {
    let state = Creation<String>(==)
    try state.begin()
    guard try state.unique() == nil else { throw MailError("Owner focus change admitted") }
    state.created("owned"); state.created("owned")
    guard try state.unique() == "owned" else { throw MailError("Creation identity lost") }
    state.created("concurrent")
    do { _ = try state.unique(); throw MailError("Ambiguous creation admitted") }
    catch let e as MailError { guard e.description.contains("AMBIGUOUS") else { throw e } }
    do { try localImportProof(["Sleight-Mail-nonce", "Import"], name: "Sleight-Mail-nonce"); throw MailError("Account destination admitted") }
    catch let e as MailError { guard e.description.contains("LOCAL_DESTINATION") else { throw e } }
    try localImportProof(["Sleight-Mail-nonce", "On My Mac"], name: "Sleight-Mail-nonce")
    do { try requireSettledCreation(true); throw MailError("Unsettled creation cleanup admitted") }
    catch let e as MailError { guard e.description.contains("CREATION_CLEANUP") else { throw e } }
    try requireSettledCreation(false)
    guard dialogCategory("Sign in", modal: false) == "signin", dialogCategory("Welcome to Mail", modal: false) == "first-run",
        dialogCategory("Allow Accessibility", modal: false) == "permission", dialogCategory("unexpected", modal: true) == "unrelated-modal",
        fixtureDialogTitle("Import"), !fixtureDialogTitle("Sign in") else { throw MailError("Dialog classification failed") }
    try emit(["selfTest": true, "existingWindowsRead": 0, "ambiguousCreationRefused": true, "localDestinationRequired": true, "unsettledCreationRefused": true, "dialogStops": true])
}
func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) + Data([10]))
}
func wait() { CFRunLoopRunInMode(.defaultMode, 0.1, false) }
func read(_ element: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if code == .attributeUnsupported || code == .noValue { return nil }
    guard code == .success else { throw MailError("MAIL_AX_READ: \(code.rawValue)") }
    return value
}
func text(_ element: AXUIElement, _ attribute: String = kAXTitleAttribute) throws -> String { try read(element, attribute) as? String ?? "" }
func children(_ element: AXUIElement, _ attribute: String = kAXChildrenAttribute) throws -> [AXUIElement] { try read(element, attribute) as? [AXUIElement] ?? [] }
func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func press(_ node: AXUIElement) throws {
    try beforeMutation?()
    guard AXUIElementPerformAction(node, kAXPressAction as CFString) == .success else { throw MailError("MAIL_AX_PRESS: retained control unavailable") }
}
func set(_ node: AXUIElement, _ attribute: String, _ value: CFTypeRef) throws {
    try beforeMutation?()
    guard AXUIElementSetAttributeValue(node, attribute as CFString, value) == .success else { throw MailError("MAIL_AX_SET: retained control unavailable") }
}
func walk(_ root: AXUIElement, depth: Int = 10) throws -> [AXUIElement] {
    guard depth > 0 else { return [] }
    var result: [AXUIElement] = []
    for node in try children(root) { result.append(node); result += try walk(node, depth: depth - 1) }
    guard result.count < 4000 else { throw MailError("MAIL_OWNED_TREE_LIMIT") }
    return result
}
func button(_ root: AXUIElement, _ titles: [String]) throws -> AXUIElement {
    let found = try walk(root).filter { try text($0, kAXRoleAttribute) == kAXButtonRole && titles.contains(text($0)) }
    guard found.count == 1 else { throw MailError("MAIL_OWNED_BUTTON_UNPROVED: \(titles.joined(separator: "/"))") }
    return found[0]
}
func menu(_ app: AXUIElement, _ name: String, _ titles: [String], beforePress: () throws -> Void = {}) throws {
    guard let bar = element(try read(app, kAXMenuBarAttribute)) else { throw MailError("MAIL_MENU_UNAVAILABLE") }
    let matches = try children(bar).filter { try text($0) == name }
    guard matches.count == 1 else { throw MailError("MAIL_MENU_AMBIGUOUS") }
    try press(matches[0])
    let menus = try children(matches[0]).filter { try text($0, kAXRoleAttribute) == kAXMenuRole }
    do {
        guard menus.count == 1 else { throw MailError("MAIL_MENU_CONTENTS_UNAVAILABLE") }
        let items = try children(menus[0]).filter { try titles.contains(text($0)) }
        guard items.count == 1, (try read(items[0], kAXEnabledAttribute) as? Bool) == true else { throw MailError("MAIL_MENU_COMMAND_UNAVAILABLE: \(titles.joined(separator: "/"))") }
        try beforePress(); try press(items[0])
    } catch {
        do { try beforeMutation?(); if let current = menus.first { _ = AXUIElementPerformAction(current, kAXCancelAction as CFString) } } catch {}
        throw error
    }
}
// A server-side AX text predicate returns only matching nonce/local nodes. An
// unsupported predicate stops setup; it never falls back to walking owner mail.
func search(_ root: AXUIElement, _ needle: String) throws -> [AXUIElement] {
    var value: CFTypeRef?
    let query: [String: Any] = ["AXSearchText": needle, "AXSearchKey": ["AXAnyTypeSearchKey"], "AXResultsLimit": 2,
        "AXDirection": "AXDirectionNext", "AXImmediateDescendantsOnly": false]
    let code = AXUIElementCopyParameterizedAttributeValue(root, "AXUIElementsForSearchPredicate" as CFString, query as CFDictionary, &value)
    guard code == .success else { throw MailError("MAIL_SCOPED_AX_QUERY_UNAVAILABLE: \(code.rawValue); owner mail inventory refused") }
    return value as? [AXUIElement] ?? []
}
func present(_ node: AXUIElement) throws -> Bool {
    var role: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(node, kAXRoleAttribute as CFString, &role)
    if code == .invalidUIElement { return false }
    guard code == .success else { throw MailError("MAIL_RETAINED_EXISTENCE_UNPROVED") }
    return true
}
func close(_ node: AXUIElement) throws {
    try beforeMutation?()
    if try !present(node) { return }
    if let control = element(try read(node, kAXCloseButtonAttribute)) { try press(control) }
    else if AXUIElementPerformAction(node, kAXCancelAction as CFString) != .success { throw MailError("MAIL_RETAINED_CANCEL_UNAVAILABLE") }
    for _ in 0..<50 { wait(); try beforeMutation?(); if try !present(node) { return } }
    throw MailError("MAIL_RETAINED_CLOSE_UNCONFIRMED")
}

final class Session {
    let request: [String: Any]
    let target: NSRunningApplication
    let app: AXUIElement
    let pid: pid_t
    var capture = Creation<AXUIElement>({ CFEqual($0, $1) })
    var observer: AXObserver?
    var owned: [AXUIElement] = []
    var viewer: AXUIElement?
    var mailbox: AXUIElement?
    var imported = false
    var removed = false
    var launched = false
    var creationPending = false
    var blockedDialog: [String: Any]?
    func checkDialog() throws {
        if blockedDialog != nil { throw MailError("MAIL_APP_DIALOG_STOP") }
        guard let focused = element(try read(app, kAXFocusedWindowAttribute)) else { return }
        var windows = [focused]; windows += try children(focused, "AXSheets")
        for node in windows {
            let title = try text(node)
            let modalValue = try read(node, kAXModalAttribute) as? Bool
            let subrole = try text(node, kAXSubroleAttribute)
            let role = try text(node, kAXRoleAttribute)
            let modal = modalValue == true || subrole == kAXDialogSubrole || role == kAXSheetRole
            let retained = owned.contains(where: { CFEqual($0, node) }) || owned.contains(where: { parent in
                ((try? children(parent, "AXSheets")) ?? []).contains(where: { CFEqual($0, node) })
            }) || (creationPending && capture.elements.count == 1 && CFEqual(capture.elements[0], node))
            if retained && fixtureDialogTitle(title) { continue }
            if let category = dialogCategory(title, modal: modal) {
                blockedDialog = ["app": "Mail", "bundle": "com.apple.mail", "category": category]
                throw MailError("MAIL_APP_DIALOG_STOP: \(category)")
            }
        }
    }
    func safeWait() throws { wait(); try checkDialog() }
    init(_ request: [String: Any], _ target: NSRunningApplication, launched: Bool) throws {
        self.request = request; self.target = target; self.pid = target.processIdentifier; self.app = AXUIElementCreateApplication(pid); self.launched = launched
        AXUIElementSetMessagingTimeout(app, 0.5)
        let callback: AXObserverCallback = { _, node, _, raw in
            guard let raw else { return }
            let session = Unmanaged<Session>.fromOpaque(raw).takeUnretainedValue()
            session.capture.created(node)
        }
        guard AXObserverCreate(pid, callback, &observer) == .success, let observer else { throw MailError("MAIL_CREATION_OBSERVER_UNAVAILABLE") }
        guard AXObserverAddNotification(observer, app, kAXWindowCreatedNotification as CFString, Unmanaged.passUnretained(self).toOpaque()) == .success else { throw MailError("MAIL_CREATION_NOTIFICATION_UNAVAILABLE") }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
    }
    deinit {
        if let observer { AXObserverRemoveNotification(observer, app, kAXWindowCreatedNotification as CFString); CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode) }
    }
    func created(_ operation: () throws -> Void) throws -> AXUIElement {
        try requireSettledCreation(creationPending)
        capture = Creation<AXUIElement>({ CFEqual($0, $1) })
        try safeWait(); try capture.begin(); creationPending = true; try operation()
        for _ in 0..<150 {
            try safeWait()
            if let node = try capture.unique() {
                // Pump again before retention to refuse queued concurrent events.
                try safeWait(); guard let unique = try capture.unique(), CFEqual(node, unique) else { throw MailError("MAIL_CREATION_CHANGED") }
                owned.append(unique); creationPending = false; return unique
            }
        }
        throw MailError("MAIL_CREATED_WINDOW_UNCONFIRMED")
    }
    func focus(_ node: AXUIElement) throws {
        try checkDialog()
        guard try present(node), AXUIElementPerformAction(node, kAXRaiseAction as CFString) == .success else { throw MailError("MAIL_RETAINED_RAISE_UNAVAILABLE") }
        guard target.activate(options: []) else { throw MailError("MAIL_OWNED_ACTIVATION_UNAVAILABLE") }
        try safeWait()
        guard let focused = element(try read(app, kAXFocusedWindowAttribute)), CFEqual(focused, node) else { throw MailError("MAIL_RETAINED_FOCUS_LOST") }
    }
    func key(_ key: CGKeyCode, _ flags: CGEventFlags, in node: AXUIElement) throws {
        try focus(node)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else { throw MailError("MAIL_OWNED_KEY_UNAVAILABLE") }
        down.flags = flags; up.flags = flags; down.postToPid(pid); up.postToPid(pid)
        try checkDialog()
    }
    func choosePath(_ dialog: AXUIElement, _ path: String) throws {
        try key(5, [.maskCommand, .maskShift], in: dialog)
        var sheet: AXUIElement?
        for _ in 0..<30 {
            let sheets = try children(dialog, "AXSheets")
            guard sheets.count <= 1 else { throw MailError("MAIL_PATH_SHEET_AMBIGUOUS") }
            if let found = sheets.first { sheet = found; break }; try safeWait()
        }
        guard let sheet else { throw MailError("MAIL_OWNED_PATH_SHEET_UNAVAILABLE") }
        let fields = try walk(sheet).filter { try text($0, kAXRoleAttribute) == kAXTextFieldRole || text($0, kAXRoleAttribute) == kAXComboBoxRole }
        guard fields.count == 1 else { throw MailError("MAIL_OWNED_PATH_FIELD_AMBIGUOUS") }
        try set(fields[0], kAXValueAttribute, path as CFString)
        guard try text(fields[0], kAXValueAttribute) == path else { throw MailError("MAIL_OWNED_PATH_READBACK_FAILED") }
        // Return is sent only to the exact retained chooser PID while away.
        try key(36, [], in: dialog)
        for _ in 0..<30 { try safeWait(); if try !present(sheet) { break } }
        guard try !present(sheet) else { throw MailError("MAIL_PATH_SELECTION_UNCONFIRMED") }
        try press(button(dialog, ["Choose", "Open", "Select"]))
    }
    func setup() throws {
        let name = request["name"] as! String, source = request["root"] as! String
        let view = try created { try menu(app, "File", ["New Viewer Window"]) }
        viewer = view
        try focus(view)
        guard try search(view, name).isEmpty else { throw MailError("MAIL_NONCE_ALREADY_PRESENT") }
        let local = try search(view, "On My Mac")
        guard local.count == 1 else { throw MailError("MAIL_LOCAL_SECTION_UNPROVED") }
        let wizard = try created { try menu(app, "File", ["Import Mailboxes…", "Import Mailboxes..."]) }
        let radios = try walk(wizard).filter { try text($0, kAXRoleAttribute) == kAXRadioButtonRole && text($0).contains("Files in mbox format") }
        guard radios.count == 1 else { throw MailError("MAIL_MBOX_IMPORT_SOURCE_UNAVAILABLE") }
        try press(radios[0])
        let chooser = try created { try press(button(wizard, ["Continue"])) }
        try choosePath(chooser, source)
        let preview = try walk(wizard).map { try text($0, kAXValueAttribute).isEmpty ? text($0) : text($0, kAXValueAttribute) }
        // A generic Import destination proves neither local ownership nor account
        // isolation. Missing local evidence stops BEFORE pressing Import.
        try localImportProof(preview, name: name)
        imported = true
        try press(button(wizard, ["Import", "Continue"]))
        for _ in 0..<100 { try safeWait(); if let done = try? button(wizard, ["Done"]) { try press(done); break } }
        try focus(view)
        let roots = try search(view, name)
        guard roots.count == 1, try text(roots[0]) == name else { throw MailError("MAIL_IMPORTED_ROOT_UNPROVED") }
        var ancestor: AXUIElement? = roots[0], localOwned = false
        for _ in 0..<20 {
            guard let node = ancestor else { break }
            if CFEqual(node, local[0]) { localOwned = true; break }
            ancestor = element(try read(node, kAXParentAttribute))
        }
        guard localOwned else { throw MailError("MAIL_IMPORTED_LOCAL_ANCESTRY_UNPROVED") }
        mailbox = roots[0]
        try emit(["stage": "ready", "nonce": request["nonce"]!, "localOnly": true, "retainedWindow": true, "retainedMailbox": true, "launched": launched, "pid": pid])
    }
    func select(_ node: AXUIElement) throws {
        guard let viewer else { throw MailError("MAIL_RETAINED_VIEWER_MISSING") }
        try focus(viewer); try set(node, kAXSelectedAttribute, kCFBooleanTrue)
        guard (try read(node, kAXSelectedAttribute) as? Bool) == true else { throw MailError("MAIL_NONCE_SELECTION_UNPROVED") }
    }
    func snapshot(_ command: [String: Any]) throws {
        try checkDialog()
        guard let mailbox, let viewer else { throw MailError("MAIL_IMPORTED_REFERENCES_MISSING") }
        let folders = request["folders"] as! [String], bank = command["output"] as! String
        var exports: [[String: String]] = []
        for (index, folder) in folders.enumerated() {
            var current = mailbox
            for part in folder.split(separator: "/") {
                let candidates = try search(current, String(part)).filter { try text($0) == String(part) }
                guard candidates.count == 1 else { throw MailError("MAIL_IMPORTED_FOLDER_UNPROVED: \(folder)") }
                current = candidates[0]
            }
            try select(current)
            let output = bank + "/\(index)"
            try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
            let chooser = try created { try menu(app, "Mailbox", ["Export Mailbox…", "Export Mailbox..."]) }
            try choosePath(chooser, output)
            for _ in 0..<100 {
                try safeWait()
                let packages = try FileManager.default.contentsOfDirectory(atPath: output).filter { $0.hasSuffix(".mbox") }
                if packages.count == 1, FileManager.default.fileExists(atPath: output + "/" + packages[0] + "/mbox") {
                    exports.append(["folder": folder, "path": output + "/" + packages[0] + "/mbox"]); break
                }
            }
            guard exports.count == index + 1 else { throw MailError("MAIL_APP_EXPORT_UNCONFIRMED: \(folder)") }
            try focus(viewer)
        }
        try emit(["stage": "snapshot", "id": command["id"]!, "exports": exports, "topology": try topology(mailbox),
            "flagReadCoverage": "MAIL_FLAG_READ_COVERAGE_UNPROVED"])
    }
    func topology(_ root: AXUIElement) throws -> [String: Any] {
        var folders: [String] = [], seen: [AXUIElement] = []
        func descend(_ node: AXUIElement, _ prefix: String) throws {
            try checkDialog()
            guard seen.count < 200, !seen.contains(where: { CFEqual($0, node) }) else { throw MailError("MAIL_TOPOLOGY_AMBIGUOUS") }
            seen.append(node)
            var canExpand = DarwinBoolean(false)
            let code = AXUIElementIsAttributeSettable(node, "AXDisclosing" as CFString, &canExpand)
            guard code == .success else { throw MailError("MAIL_TOPOLOGY_DISCLOSURE_UNPROVED") }
            if canExpand.boolValue {
                try set(node, "AXDisclosing", kCFBooleanTrue)
                guard (try read(node, "AXDisclosing") as? Bool) == true else { throw MailError("MAIL_TOPOLOGY_EXPANSION_UNPROVED") }
            }
            guard let rows = try read(node, "AXDisclosedRows") as? [AXUIElement] else { throw MailError("MAIL_TOPOLOGY_CHILDREN_UNPROVED") }
            for child in rows {
                guard let parent = element(try read(child, "AXDisclosedByRow")) else { throw MailError("MAIL_TOPOLOGY_PARENT_UNPROVED") }
                if !CFEqual(parent, node) { continue }
                let name = try text(child)
                guard !name.isEmpty, !name.contains("/"), !name.contains("\n") else { throw MailError("MAIL_TOPOLOGY_FOLDER_NAME_UNPROVED") }
                let path = prefix.isEmpty ? name : prefix + "/" + name
                folders.append(path); try descend(child, path)
            }
        }
        try descend(root, "")
        guard !folders.isEmpty, Set(folders).count == folders.count else { throw MailError("MAIL_TOPOLOGY_EMPTY_OR_AMBIGUOUS") }
        return ["complete": true, "folders": folders.sorted()]
    }
    func cleanup() throws {
        try checkDialog()
        try requireSettledCreation(creationPending)
        if imported && !removed {
            guard let mailbox, let viewer, try text(mailbox) == request["name"] as! String else { throw MailError("MAIL_IMPORTED_CLEANUP_UNCONFIRMED: retained nonce mailbox unavailable") }
            try select(mailbox)
            let confirm = try created { try menu(app, "Mailbox", ["Delete Mailbox…", "Delete Mailbox..."]) }
            let values = try walk(confirm).map { try text($0, kAXValueAttribute) + text($0) }
            guard values.contains(where: { $0.contains(request["name"] as! String) }) else { throw MailError("MAIL_DELETE_CONFIRMATION_NONCE_UNPROVED") }
            try press(button(confirm, ["Delete"]))
            for _ in 0..<50 { try safeWait(); if try search(viewer, request["name"] as! String).isEmpty { removed = true; break } }
            guard removed else { throw MailError("MAIL_IMPORTED_REMOVAL_UNCONFIRMED") }
        }
        for node in owned.reversed() { try close(node) }
        if launched {
            guard target.bundleIdentifier == "com.apple.mail", target.processIdentifier == pid else { throw MailError("MAIL_LAUNCHED_IDENTITY_CHANGED") }
            guard target.terminate() else { throw MailError("MAIL_LAUNCHED_QUIT_REFUSED") }
            for _ in 0..<50 { try safeWait(); if target.isTerminated { break } }
            guard target.isTerminated else { throw MailError("MAIL_LAUNCHED_QUIT_UNCONFIRMED") }
        }
        try emit(["stage": "closed", "removed": !imported || removed, "appQuit": launched])
    }
}

func main() throws {
    if CommandLine.arguments.dropFirst().first == "--self-test" { try selfTest(); return }
    guard let data = CommandLine.arguments.dropFirst().first?.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        request["ownerAway"] as? Bool == true, let control = request["control"] as? String,
        let name = request["name"] as? String, name.hasPrefix("Sleight-Mail-"), let root = request["root"] as? String, root.hasSuffix("/" + name), request["folders"] is [String] else { throw MailError("MAIL_OWNER_AWAY_OR_REQUEST_UNPROVED") }
    guard AXIsProcessTrusted() else { throw MailError("MAIL_ACCESSIBILITY_UNAVAILABLE: no permission request made") }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.mail")
    guard running.count <= 1 else { throw MailError("MAIL_PROCESS_AMBIGUOUS") }
    // A fresh Mail launch can display account setup and restored owner mail.
    // Without a prelaunch scoped readiness proof, preserve the installed app.
    guard let target = running.first else {
        try emit(["stage": "untouched", "actionTaken": false, "running": false, "launched": false])
        throw MailError("MAIL_NOT_RUNNING: fresh launch account/restoration boundary unproved; no app launched")
    }
    let session = try Session(request, target, launched: false)
    beforeMutation = { [weak session] in try session?.checkDialog() }
    defer { beforeMutation = nil }
    do {
        try session.setup()
        var last = ""
        while true {
            try session.safeWait()
            guard let bytes = FileManager.default.contents(atPath: control), let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let id = command["id"] as? String, id != last else { continue }
            last = id
            if command["command"] as? String == "close" { try session.cleanup(); return }
            if command["command"] as? String == "snapshot" { try session.snapshot(command) }
        }
    } catch {
        if let dialog = session.blockedDialog {
            try emit(["stage": "app-dialog", "dialog": dialog, "cleanup": "unconfirmed"])
            try emit(["stage": "setup-failure", "actionTaken": !session.owned.isEmpty, "cleanup": "unconfirmed", "imported": session.imported])
            // No AX cleanup follows a permission/account/first-run/modal stop.
            throw error
        }
        var cleanup = "unconfirmed", cleanupError: String?
        do { try session.cleanup(); cleanup = "closed retained fixture" } catch let failure { cleanupError = String(describing: failure) }
        if let dialog = session.blockedDialog { try emit(["stage": "app-dialog", "dialog": dialog, "cleanup": "unconfirmed"]) }
        try emit(["stage": "setup-failure", "actionTaken": !session.owned.isEmpty, "cleanup": cleanup, "cleanupError": cleanupError ?? "", "imported": session.imported])
        throw error
    }
}
do { try main() } catch { FileHandle.standardError.write(Data((String(describing: error) + "\n").utf8)); exit(1) }
