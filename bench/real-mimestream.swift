// Private navigation fixture. Mail text crosses only the helper's captured IPC;
// no text is written to files or errors. AX capability gaps refuse the task.
import AppKit
import ApplicationServices

struct FixtureError: Error { let code: String; init(_ code: String) { self.code = code } }
func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) + Data([10]))
}
func read(_ node: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(node, attribute as CFString, &value)
    if code == .attributeUnsupported || code == .noValue { return nil }
    guard code == .success else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
    return value
}
func text(_ node: AXUIElement, _ attribute: String = kAXTitleAttribute) throws -> String { try read(node, attribute) as? String ?? "" }
func nodes(_ node: AXUIElement, _ attribute: String = kAXChildrenAttribute) throws -> [AXUIElement] { try read(node, attribute) as? [AXUIElement] ?? [] }
func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func walk(_ root: AXUIElement, depth: Int = 12) throws -> [AXUIElement] {
    var result: [AXUIElement] = [], seen: [AXUIElement] = []
    func visit(_ node: AXUIElement, _ left: Int) throws {
        guard !seen.contains(where: { CFEqual($0, node) }) else { return }
        guard result.count < 6000 else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
        seen.append(node); result.append(node)
        if left > 0 { for child in try nodes(node) { try visit(child, left - 1) } }
    }
    try visit(root, depth); return result
}
func strings(_ node: AXUIElement) throws -> [String] {
    try [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute].map { try text(node, $0) }.filter { !$0.isEmpty }
}
func explicitCount(_ values: [String], unread: Bool) throws -> Int {
    let pattern = unread ? "(?:^|[,; ])([0-9][0-9,]*) unread(?: messages)?(?:$|[,; ])" : "^([0-9][0-9,]*) messages$"
    let regex = try NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    let matches = values.flatMap { value -> [Int] in
        regex.matches(in: value, range: NSRange(value.startIndex..., in: value)).compactMap { match in
            guard let range = Range(match.range(at: 1), in: value) else { return nil }
            return Int(value[range].replacingOccurrences(of: ",", with: ""))
        }
    }
    guard Set(matches).count == 1, let number = matches.first else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
    return number
}
func explicitRead(read: Bool?, unread: Bool?, labels: [String]) throws -> Bool {
    if let read { guard read && unread != true else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }; return true }
    if let unread { guard !unread else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }; return true }
    let markers = labels.map { $0.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) }
    guard markers.contains("read message") || markers.contains("read conversation"), !markers.contains("unread message"), !markers.contains("unread conversation") else {
        throw FixtureError("MIMESTREAM_BASELINE_UNPROVED")
    }
    return true
}
func category(_ title: String, modal: Bool) -> String? {
    let value = title.lowercased()
    if value.contains("permission") || value.contains("accessibility") || value.contains("screen recording") || value.hasPrefix("allow ") || value.contains("would like to control") { return "permission" }
    if value.contains("sign in") || value.contains("sign-in") || value.contains("log in") { return "signin" }
    if value.contains("account") || value.contains("google authorization") { return "account" }
    if value.contains("welcome") || value.contains("get started") { return "first-run" }
    return modal ? "unrelated-modal" : nil
}
func unchangedCounts(_ beforeUnread: Int, _ afterUnread: Int, _ beforeFolder: Int, _ afterFolder: Int) throws {
    guard beforeUnread == afterUnread, beforeFolder == afterFolder else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
}
func labelProof(_ isLabel: Bool, _ total: Int, _ unread: Int) throws {
    guard isLabel, total > 0, unread == 0 else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
}
func uniqueSubjectProof(_ count: Int, _ complete: Bool, _ read: Bool) throws {
    guard count == 1, complete, read else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
}
func searchBound(_ fieldQuery: String, _ listQuery: String?, _ expected: String, _ targetSelected: Bool) -> Bool {
    fieldQuery == expected && listQuery == expected && targetSelected
}
final class Creation {
    var issued = false, pending = false
    var initial: [AXUIElement] = [], created: [AXUIElement] = []
    func receive(_ node: AXUIElement) {
        if issued && !initial.contains(where: { CFEqual($0, node) }) && !created.contains(where: { CFEqual($0, node) }) { created.append(node) }
    }
    func retained() throws -> AXUIElement? {
        guard issued, created.count <= 1 else { throw FixtureError("MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED") }
        return created.first
    }
}

final class Session {
    let app: AXUIElement, target: NSRunningApplication, request: [String: Any]
    let creation = Creation()
    var observer: AXObserver?, viewer: AXUIElement?, sidebar: AXUIElement?, list: AXUIElement?, folderNode: AXUIElement?
    var selected: AXUIElement?, scrollbar: AXUIElement?, thread: AXUIElement?, bodyArea: AXUIElement?, bodyScrollArea: AXUIElement?
    var thirdFingerprint: [String] = []
    var folderName = "", subject = "", fingerprint: [String] = [], expected = "", labels: [String] = []
    var stopped = false, cleanupComplete = false
    var kind: String { request["kind"] as! String }
    init(_ target: NSRunningApplication, _ request: [String: Any]) throws {
        self.target = target; self.request = request; app = AXUIElementCreateApplication(target.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 0.5)
        creation.initial = try nodes(app, kAXWindowsAttribute)
    }
    deinit {
        if let observer { AXObserverRemoveNotification(observer, app, kAXWindowCreatedNotification as CFString); CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode) }
    }
    func ensureDialog() throws {
        if stopped { throw FixtureError("MIMESTREAM_APP_DIALOG_STOP") }
        var candidates = try nodes(app, kAXWindowsAttribute)
        for window in candidates { candidates += try nodes(window, "AXSheets") }
        let system = AXUIElementCreateSystemWide()
        if let focusedApp = element(try read(system, kAXFocusedApplicationAttribute)), let focused = element(try read(focusedApp, kAXFocusedWindowAttribute)) {
            let role = try text(focused, kAXRoleAttribute), subrole = try text(focused, kAXSubroleAttribute)
            let modal = try read(focused, kAXModalAttribute) as? Bool
            if role == kAXSheetRole || subrole == kAXDialogSubrole || modal == true { candidates.append(focused) }
        }
        for node in candidates {
            let modalValue = try read(node, kAXModalAttribute) as? Bool
            let subrole = try text(node, kAXSubroleAttribute), role = try text(node, kAXRoleAttribute)
            let modal = modalValue == true || subrole == kAXDialogSubrole || role == kAXSheetRole
            if let value = category(try text(node), modal: modal) {
                stopped = true; try emit(["stage": "app-dialog", "category": value, "actionTaken": creation.issued]); throw FixtureError("MIMESTREAM_APP_DIALOG_STOP")
            }
        }
    }
    func wait() throws { CFRunLoopRunInMode(.defaultMode, 0.1, false); try ensureDialog() }
    func press(_ node: AXUIElement) throws {
        try ensureDialog()
        guard AXUIElementPerformAction(node, kAXPressAction as CFString) == .success else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
    }
    func set(_ node: AXUIElement, _ attribute: String, _ value: CFTypeRef) throws {
        try ensureDialog()
        guard AXUIElementSetAttributeValue(node, attribute as CFString, value) == .success else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
    }
    func select(_ node: AXUIElement) throws {
        try set(node, kAXSelectedAttribute, kCFBooleanTrue); try wait()
        guard (try read(node, kAXSelectedAttribute) as? Bool) == true else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
    }
    func newWindow() throws {
        try ensureDialog()
        let callback: AXObserverCallback = { _, node, _, raw in
            guard let raw else { return }; Unmanaged<Session>.fromOpaque(raw).takeUnretainedValue().creation.receive(node)
        }
        guard AXObserverCreate(target.processIdentifier, callback, &observer) == .success, let observer,
            AXObserverAddNotification(observer, app, kAXWindowCreatedNotification as CFString, Unmanaged.passUnretained(self).toOpaque()) == .success else { throw FixtureError("MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED") }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
        guard let bar = element(try read(app, kAXMenuBarAttribute)) else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
        let files = try nodes(bar).filter { try text($0) == "File" }
        guard files.count == 1 else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
        try press(files[0])
        let items = try walk(files[0]).filter { try text($0) == "New Window" && text($0, kAXRoleAttribute) == kAXMenuItemRole }
        guard items.count == 1, (try read(items[0], kAXEnabledAttribute) as? Bool) == true else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
        creation.issued = true; creation.pending = true; try press(items[0])
        for _ in 0..<100 {
            try wait()
            if let node = try creation.retained() {
                try wait(); guard let same = try creation.retained(), CFEqual(same, node) else { throw FixtureError("MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED") }
                viewer = node; creation.pending = false; return
            }
        }
        throw FixtureError("MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED")
    }
    func currentTree() throws -> [AXUIElement] {
        guard let viewer else { throw FixtureError("MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED") }
        return try walk(viewer)
    }
    func bindLayout(_ window: AXUIElement) throws {
        viewer = window
        let tree = try currentTree()
        let outlines = try tree.filter { try text($0, kAXRoleAttribute) == kAXOutlineRole }
        let tables = try tree.filter { try text($0, kAXRoleAttribute) == kAXTableRole }
        guard outlines.count == 1, tables.count == 1 else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
        sidebar = outlines[0]; list = tables[0]
    }
    func folderTitle(_ row: AXUIElement) throws -> String {
        let names = try walk(row, depth: 2).flatMap { node -> [String] in
            let role = try text(node, kAXRoleAttribute)
            if role != kAXRowRole && role != kAXStaticTextRole { return [] }
            return try [text(node), text(node, kAXValueAttribute)].filter { !$0.isEmpty && !$0.contains("unread") && !$0.contains(" messages") && Int($0) == nil }
        }
        guard Set(names).count == 1, let name = names.first else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }; return name
    }
    func isLabel(_ row: AXUIElement) throws -> Bool {
        let identifier = try text(row, kAXIdentifierAttribute).lowercased()
        let description = try text(row, kAXDescriptionAttribute).lowercased()
        if identifier == "gmail-label" || identifier.hasPrefix("gmail-label.") || description == "gmail label" { return true }
        guard let parent = element(try read(row, "AXDisclosedByRow")) else { return false }
        return try folderTitle(parent) == "Labels"
    }
    func observeLabels() throws {
        guard let sidebar else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        let observed = try nodes(sidebar, kAXRowsAttribute).flatMap { try rowText($0) }
        labels = Array(Set(labels + observed)).sorted()
        try emit(["stage": "private-terms", "labels": labels])
    }
    func rowText(_ row: AXUIElement) throws -> [String] { try walk(row, depth: 3).flatMap { try strings($0) } }
    func readProof(_ row: AXUIElement) throws -> Bool {
        try explicitRead(read: read(row, "AXRead") as? Bool, unread: read(row, "AXUnread") as? Bool, labels: rowText(row))
    }
    func rows() throws -> [AXUIElement] {
        guard let list else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
        let rows = try nodes(list, kAXRowsAttribute)
        guard !rows.isEmpty else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }; return rows
    }
    func subjectOf(_ row: AXUIElement) throws -> String {
        let candidates = try walk(row, depth: 3).filter { node in
            let identifier = try text(node, kAXIdentifierAttribute).lowercased()
            return identifier == "subject" || identifier.hasSuffix(".subject") || identifier == "message-subject"
        }
        guard candidates.count == 1 else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
        let values = try strings(candidates[0]).filter { !$0.isEmpty && $0.lowercased() != "subject" }
        guard Set(values).count == 1, let subject = values.first else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }; return subject
    }
    func fullUnread() throws -> Int {
        guard let sidebar else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        let all = try nodes(sidebar, kAXRowsAttribute).filter { try rowText($0).contains("All Mail") }
        guard all.count == 1 else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        return try explicitCount(rowText(all[0]), unread: true)
    }
    func folderCount() throws -> Int {
        guard let folderNode else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        return try explicitCount(rowText(folderNode), unread: false)
    }
    func selectedFolder() throws -> Bool {
        guard let folderNode else { return false }; return (try read(folderNode, kAXSelectedAttribute) as? Bool) == true
    }
    func selectedMessage() throws -> AXUIElement {
        let candidates = try rows().filter { try rowText($0) == fingerprint }
        guard candidates.count == 1 else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        return candidates[0]
    }
    func snapshot() throws -> [String: Any] {
        try ensureDialog()
        let row = try selectedMessage(); _ = try readProof(row)
        let messageSelected = (try read(row, kAXSelectedAttribute) as? Bool) == true
        var scroll: Double?, bodyRegion = false
        if let scrollbar, let bodyArea, let bodyScrollArea {
            let current = try currentTree(), retained = current.contains(where: { CFEqual($0, bodyArea) }) && current.contains(where: { CFEqual($0, bodyScrollArea) })
            let contained = try walk(bodyScrollArea).contains(where: { CFEqual($0, scrollbar) })
            bodyRegion = retained && contained
            if bodyRegion { scroll = try read(scrollbar, kAXValueAttribute) as? Double }
        }
        var thirdShown = false
        if thread != nil && messageSelected {
            let disclosed = try read(row, "AXDisclosing") as? Bool
            let replies = try nodes(row, "AXDisclosedRows")
            if disclosed == true && replies.count >= 3 {
                let hidden = try read(replies[2], "AXHidden") as? Bool
                let sameThird = try rowText(replies[2]) == thirdFingerprint
                let allRead = try replies.allSatisfy { try readProof($0) }
                thirdShown = hidden == false && sameThird && allRead
            }
        }
        let searches = try currentTree().filter { try text($0, kAXSubroleAttribute) == "AXSearchField" }
        let query = searches.count == 1 ? try text(searches[0], kAXValueAttribute) : ""
        let listQuery = try list.flatMap { try read($0, "AXSearchQuery") as? String }
        var nav: [String: Any] = [:]
        nav["folderId"] = try selectedFolder() ? "target-folder" : "other-folder"
        nav["messageId"] = messageSelected ? "target-message" : NSNull()
        nav["threadId"] = thirdShown ? "target-thread" : NSNull()
        nav["thirdMessageId"] = thirdShown ? "target-third-message" : NSNull()
        nav["threadMessagesRead"] = thirdShown
        nav["scrollPosition"] = scroll as Any? ?? NSNull()
        nav["scrollRegion"] = bodyRegion ? "message-body" : NSNull()
        nav["scrollBottom"] = bodyRegion && (scroll ?? -1) >= 0.99
        nav["searchQuery"] = query
        nav["searchResultsBound"] = searchBound(query, listQuery, subject, messageSelected)
        return ["source": "mimestream-ax", "nonce": request["nonce"]!,
            "fullList": ["scope": "all-mail", "unreadCount": try fullUnread(), "countProof": "ax-explicit-count"],
            "folder": ["id": "target-folder", "messageCount": try folderCount(), "countProof": "ax-explicit-count"],
            "target": ["id": "target-message", "read": true, "readProof": "ax-explicit-read"], "navigation": nav]
    }
    func setup() throws {
        try ensureDialog()
        guard creation.initial.count == 1 else { throw FixtureError("MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED") }
        try bindLayout(creation.initial[0]); try observeLabels()
        let beforeUnread = try fullUnread()
        let folders = try nodes(sidebar!, kAXRowsAttribute)
        let currentFolders = try folders.filter { (try read($0, kAXSelectedAttribute) as? Bool) == true }
        guard currentFolders.count == 1 else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        let initialFolderName = try folderTitle(currentFolders[0]), initialFolderTotal = try explicitCount(rowText(currentFolders[0]), unread: false)
        folderNode = currentFolders[0]
        // New windows may restore a selected message. An explicitly all-read
        // source folder and selected rows are required before creating one.
        guard try explicitCount(rowText(currentFolders[0]), unread: true) == 0 else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        for row in try rows() where (try read(row, kAXSelectedAttribute) as? Bool) == true { _ = try readProof(row) }
        let choices = try folders.filter { try isLabel($0) && folderTitle($0) != initialFolderName }
        guard let choice = choices.first else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        let targetTotal = try explicitCount(rowText(choice), unread: false), targetUnread = try explicitCount(rowText(choice), unread: true)
        try labelProof(isLabel(choice), targetTotal, targetUnread)
        folderName = try folderTitle(choice)
        try newWindow()
        guard let owned = viewer else { throw FixtureError("MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED") }
        try bindLayout(owned); try observeLabels()
        let restoredFolders = try nodes(sidebar!, kAXRowsAttribute).filter { (try read($0, kAXSelectedAttribute) as? Bool) == true }
        guard restoredFolders.count == 1, try folderTitle(restoredFolders[0]) == initialFolderName else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        folderNode = restoredFolders[0]
        try unchangedCounts(beforeUnread, fullUnread(), initialFolderTotal, folderCount())
        let ownedFolders = try nodes(sidebar!, kAXRowsAttribute), matches = try ownedFolders.filter { try folderTitle($0) == folderName && isLabel($0) }
        guard matches.count == 1 else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        folderNode = matches[0]; try select(matches[0])
        try unchangedCounts(beforeUnread, fullUnread(), targetTotal, folderCount())
        let alreadyRead = try rows().filter { (try? readProof($0)) == true }
        guard alreadyRead.count >= 2 else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
        let row = alreadyRead[1]; selected = row; fingerprint = try rowText(row); subject = try subjectOf(row); expected = subject
        let allRows = try rows(), subjectMatches = try allRows.filter { try subjectOf($0) == subject }
        try uniqueSubjectProof(subjectMatches.count, allRows.count == targetTotal, readProof(row))
        var prompt = "Open the \"\(folderName)\" folder and report the subject of the second already-read message shown in its current list order."
        if kind != "label" { prompt = "In \"\(folderName)\", open the already-read message with the exact subject \"\(subject)\" and report its subject." }
        if kind == "thread" {
            let replies = try nodes(row, "AXDisclosedRows")
            guard replies.count >= 3, try replies.allSatisfy({ try readProof($0) }) else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
            thread = row; expected = try subjectOf(replies[2])
            thirdFingerprint = try rowText(replies[2])
            prompt = "In \"\(folderName)\", open the already-read thread with subject \"\(subject)\" and report the subject of its third displayed message."
        }
        if kind == "scroll" {
            // Selecting is safe only after explicit read proof; it cannot unread a message.
            _ = try readProof(row); try select(row)
            let detail = try currentTree(), textAreas = try detail.filter { try text($0, kAXRoleAttribute) == kAXTextAreaRole }
            guard textAreas.count == 1 else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
            var ancestor: AXUIElement? = textAreas[0], scrollArea: AXUIElement?
            for _ in 0..<10 {
                guard let node = ancestor else { break }
                if try text(node, kAXRoleAttribute) == kAXScrollAreaRole { scrollArea = node; break }
                ancestor = element(try read(node, kAXParentAttribute))
            }
            guard let scrollArea else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
            let scrollbars = try walk(scrollArea).filter { try text($0, kAXRoleAttribute) == kAXScrollBarRole && text($0, kAXOrientationAttribute) == kAXVerticalOrientationValue }
            guard scrollbars.count == 1 else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
            let lines = try text(textAreas[0], kAXValueAttribute).split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            guard let last = lines.last, last.count < 2000 else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
            scrollbar = scrollbars[0]; bodyArea = textAreas[0]; bodyScrollArea = scrollArea; expected = last
            try set(scrollbars[0], kAXValueAttribute, NSNumber(value: 0)); try wait()
            prompt = "Scroll the already-read message with subject \"\(subject)\" to the bottom and report the last nonempty line of its message body."
        }
        if kind == "search" { prompt = "Search this folder for the exact subject \"\(subject)\", open that already-read result, and report its subject." }
        var before = try snapshot()
        try unchangedCounts(beforeUnread, fullUnread(), targetTotal, folderCount())
        if kind == "label" {
            let reset = try ownedFolders.filter { try folderTitle($0) == initialFolderName }
            guard reset.count == 1 else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
            try select(reset[0]); try unchangedCounts(beforeUnread, fullUnread(), initialFolderTotal, explicitCount(rowText(reset[0]), unread: false))
            var navigation = before["navigation"] as! [String: Any]; navigation["folderId"] = "other-folder"; before["navigation"] = navigation
        }
        let target: [String: Any] = ["folderId": "target-folder", "messageId": "target-message", "threadId": kind == "thread" ? "target-thread" : NSNull(),
            "searchQuery": kind == "search" ? subject : NSNull(), "thirdMessageId": kind == "thread" ? "target-third-message" : NSNull()]
        let receipt: [String: Any] = ["running": true, "launched": false, "retainedWindow": true, "creationOwned": true,
            "actionTaken": true, "before": before, "target": target, "expected": expected, "labels": labels, "prompt": prompt]
        try emit(["stage": "ready", "receipt": receipt])
    }
    func cleanup() throws {
        try ensureDialog()
        guard creation.issued else { cleanupComplete = true; return }
        guard !creation.pending else { throw FixtureError("MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED") }
        guard let viewer else { cleanupComplete = true; return }
        guard let retained = try creation.retained(), CFEqual(retained, viewer), !creation.initial.contains(where: { CFEqual($0, viewer) }),
            let close = element(try read(viewer, kAXCloseButtonAttribute)) else { throw FixtureError("MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED") }
        try press(close)
        for _ in 0..<50 {
            try wait()
            let windows = try nodes(app, kAXWindowsAttribute)
            if !windows.contains(where: { CFEqual($0, viewer) }) { cleanupComplete = true; try emit(["stage": "closed", "appQuit": false]); return }
        }
        throw FixtureError("MIMESTREAM_CLEANUP_UNCONFIRMED")
    }
    func schema() throws {
        try ensureDialog()
        let windows = try nodes(app, kAXWindowsAttribute)
        guard windows.count == 1 else { throw FixtureError("MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED") }
        viewer = windows[0]
        let outlines = try walk(windows[0]).filter { try text($0, kAXRoleAttribute) == kAXOutlineRole }
        if outlines.count == 1 { sidebar = outlines[0]; try observeLabels() }
        var roles: [String: Int] = [:], attributes: [String: Set<String>] = [:], actions: [String: Set<String>] = [:]
        for node in try walk(windows[0]) {
            let role = try text(node, kAXRoleAttribute)
            // Only generic API names and role counts leave schema mode.
            guard role.hasPrefix("AX"), role.count < 64 else { continue }
            roles[role, default: 0] += 1
            var names: CFArray?, actionNames: CFArray?
            if AXUIElementCopyAttributeNames(node, &names) == .success { attributes[role, default: []].formUnion(names as? [String] ?? []) }
            if AXUIElementCopyActionNames(node, &actionNames) == .success { actions[role, default: []].formUnion(actionNames as? [String] ?? []) }
        }
        try emit(["schema": true, "windowCount": windows.count, "roles": roles,
            "attributes": attributes.mapValues { $0.sorted() }, "actions": actions.mapValues { $0.sorted() }])
    }
}

func selfTest() throws {
    guard try explicitCount(["All Mail, 13 unread messages"], unread: true) == 13,
        try explicitCount(["1,234 messages"], unread: false) == 1234 else { throw FixtureError("MIMESTREAM_BASELINE_UNPROVED") }
    for values in [["All Mail", "13"], ["10 conversations"], ["10 messages", "11 messages"]] {
        do { _ = try explicitCount(values, unread: false); throw FixtureError("SELF_TEST_FAILED") }
        catch let error as FixtureError { guard error.code == "MIMESTREAM_BASELINE_UNPROVED" else { throw error } }
    }
    _ = try explicitRead(read: true, unread: nil, labels: [])
    _ = try explicitRead(read: nil, unread: false, labels: [])
    do { _ = try explicitRead(read: nil, unread: nil, labels: ["Invented row"]); throw FixtureError("SELF_TEST_FAILED") }
    catch let error as FixtureError { guard error.code == "MIMESTREAM_BASELINE_UNPROVED" else { throw error } }
    let creation = Creation(); creation.issued = true
    creation.created = [AXUIElementCreateApplication(1), AXUIElementCreateApplication(2)]
    do { _ = try creation.retained(); throw FixtureError("SELF_TEST_FAILED") }
    catch let error as FixtureError { guard error.code == "MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED" else { throw error } }
    guard category("Sign in", modal: false) == "signin", category("Google account", modal: false) == "account",
        category("Allow Accessibility", modal: false) == "permission", category("Invented", modal: true) == "unrelated-modal" else { throw FixtureError("SELF_TEST_FAILED") }
    try unchangedCounts(3, 3, 60, 60); try labelProof(true, 60, 0); try uniqueSubjectProof(1, true, true)
    let refused: [() throws -> Void] = [{ try unchangedCounts(3, 2, 60, 60) }, { try unchangedCounts(3, 3, 60, 59) },
        { try labelProof(false, 60, 0) }, { try labelProof(true, 60, 1) }, { try uniqueSubjectProof(2, true, true) },
        { try uniqueSubjectProof(1, false, true) }, { try uniqueSubjectProof(1, true, false) }]
    for operation in refused {
        do { try operation(); throw FixtureError("SELF_TEST_FAILED") }
        catch let error as FixtureError { guard error.code == "MIMESTREAM_BASELINE_UNPROVED" else { throw error } }
    }
    guard searchBound("Invented query", "Invented query", "Invented query", true), !searchBound("Invented query", nil, "Invented query", true),
        !searchBound("Invented query", "Different query", "Invented query", true), !searchBound("Invented query", "Invented query", "Invented query", false) else { throw FixtureError("SELF_TEST_FAILED") }
    try emit(["selfTest": true, "explicitCountRequired": true, "explicitReadRequired": true, "ambiguousCreationRefused": true, "dialogStops": true, "existingWindowsClosed": 0,
        "preactionCountsRequired": true, "onlyProvedLabels": true, "unreadSelectionRefused": true, "duplicateSubjectsRefused": true, "searchQueryBoundRequired": true])
}
func main() throws {
    if CommandLine.arguments.dropFirst().first == "--self-test" { try selfTest(); return }
    let schema = CommandLine.arguments.dropFirst().first == "--schema"
    var request: [String: Any] = [:]
    if !schema {
        guard let data = CommandLine.arguments.dropFirst().first?.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["ownerAway"] as? Bool == true, object["control"] is String, object["nonce"] is String,
            let kind = object["kind"] as? String, ["label", "message", "thread", "scroll", "search"].contains(kind) else { throw FixtureError("MIMESTREAM_OWNER_AWAY_UNPROVED") }
        request = object
    }
    guard AXIsProcessTrusted() else { try emit(["stage": "untouched", "actionTaken": false]); throw FixtureError("MIMESTREAM_ACCESSIBILITY_UNAVAILABLE") }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.mimestream.Mimestream")
    guard running.count <= 1 else { try emit(["stage": "untouched", "actionTaken": false]); throw FixtureError("MIMESTREAM_PROCESS_AMBIGUOUS") }
    guard let target = running.first else { try emit(["stage": "untouched", "actionTaken": false]); throw FixtureError("MIMESTREAM_NOT_RUNNING") }
    let session = try Session(target, request)
    if schema { try session.schema(); return }
    do {
        try session.setup()
        let control = request["control"] as! String
        var last = ""
        while true {
            try session.wait()
            guard let data = FileManager.default.contents(atPath: control), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let id = command["id"] as? String, id != last else { continue }
            last = id
            if command["command"] as? String == "close" { try session.cleanup(); return }
            if command["command"] as? String == "snapshot" { try emit(["stage": "snapshot", "id": id, "snapshot": session.snapshot()]) }
        }
    } catch {
        if !session.stopped { try? session.cleanup() }
        try emit(["stage": "setup-failure", "actionTaken": session.creation.issued, "cleanup": session.cleanupComplete ? "closed creation-owned window" : "unconfirmed"])
        throw error
    }
}
do { try main() }
catch { FileHandle.standardError.write(Data(((error as? FixtureError)?.code ?? "MIMESTREAM_SETUP_FAILED") .utf8) + Data([10])); exit(1) }
