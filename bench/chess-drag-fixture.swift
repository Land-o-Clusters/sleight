// Only owned temporary games or exact recorded window IDs are changed.
import AppKit

func failure(_ message: String) -> NSError { NSError(domain: message, code: 1) }
func ownedGameURL(_ path: String) throws -> URL {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    guard path.hasPrefix("/private/tmp/sleight-chess-stacked-"), url.pathExtension == "game",
          !path.split(separator: "/").contains("..") else { throw failure("owned game path required") }
    return url
}
func reportedPath(_ url: URL) -> String {
    let path = url.standardizedFileURL.path
    return path.hasPrefix("/tmp/") ? "/private" + path : path
}
func sameDocument(_ document: URL, _ expected: URL) -> Bool {
    reportedPath(document) == reportedPath(expected)
}
func closeSequence(_ actions: [() throws -> Void], remainsOpen: () -> Bool) throws -> Bool {
    for action in actions {
        try action()
        if !remainsOpen() { return true }
    }
    return false
}
func absentAppResult(_ op: String) throws -> [String: Any] {
    if op == "snapshot" { return ["ok": true, "running": false, "windows": []] }
    if op == "close" { return ["ok": false, "error": "Chess exited; document cleanup unconfirmed; restored games may reopen"] }
    throw failure("Chess is not running")
}
func publishedTitle(_ title: String) -> String {
    title.isEmpty || title.hasPrefix("sleight-stacked-") ? title : "[unowned Chess window]"
}
func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
    return value
}
func frame(_ el: AXUIElement) throws -> CGRect {
    guard let p = attr(el, "AXPosition"), let s = attr(el, "AXSize"),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { throw failure("AX frame unavailable") }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { throw failure("AX frame invalid") }
    return CGRect(origin: point, size: size)
}
func list(_ pid: pid_t) -> [[String: Any]] {
    (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], 0) as? [[String: Any]] ?? []).filter {
        ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0
    }
}
func match(_ window: AXUIElement, _ info: [String: Any]) -> Bool {
    if let id = attr(window, "AXWindowNumber") as? Int { return id == info[kCGWindowNumber as String] as? Int }
    guard let title = attr(window, "AXTitle") as? String, title == info[kCGWindowName as String] as? String,
          let bounds = info[kCGWindowBounds as String] as? NSDictionary, let cg = CGRect(dictionaryRepresentation: bounds),
          let ax = try? frame(window) else { return false }
    return abs(cg.minX - ax.minX) < 1 && abs(cg.minY - ax.minY) < 1 && abs(cg.width - ax.width) < 1 && abs(cg.height - ax.height) < 1
}
func squares(_ window: AXUIElement) throws -> [[String: Any]] {
    var visited = 0, result: [[String: Any]] = []
    func walk(_ el: AXUIElement, _ depth: Int) throws {
        visited += 1
        guard visited <= 300 && depth <= 12 else { throw failure("fixture AX limit") }
        if attr(el, "AXRole") as? String == "AXButton", let rect = try? frame(el) {
            let title = (attr(el, "AXTitle") as? String) ?? (attr(el, "AXDescription") as? String) ?? ""
            if title.hasSuffix("e2") || title.hasSuffix("e4") {
                result.append(["title": title, "center": [rect.midX, rect.midY]])
            }
        }
        for child in attr(el, "AXChildren") as? [AXUIElement] ?? [] { try walk(child, depth + 1) }
    }
    try walk(window, 0)
    return result
}
var output: [String: Any] = ["ok": false]
do {
    let request = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
    guard let op = request["op"] as? String, ["snapshot", "place", "read", "close", "path-check", "close-check"].contains(op) else { throw failure("invalid operation") }
    if op == "close-check" {
        var actions = 0
        let closed = try closeSequence([{ actions += 1 }, { throw failure("stale close button accessed") }], remainsOpen: { false })
        let titles: [String] = [publishedTitle("sleight-stacked-1-target.game"), publishedTitle(""), publishedTitle("Game 1 | Owner - Computer")]
        let checked: [String: Any] = ["ok": closed, "actions": actions, "absentAppClose": try absentAppResult("close"), "publishedTitles": titles]
        let data = try JSONSerialization.data(withJSONObject: checked)
        print(String(data: data, encoding: .utf8)!)
        exit(0) // Pure close sequencing test, without AX or app access.
    }
    if op == "path-check" {
        guard let path = request["path"] as? String else { throw failure("owned game path required") }
        let url = try ownedGameURL(path)
        var checked: [String: Any] = ["ok": true, "canonical": url.path, "reported": reportedPath(url)]
        if let document = request["document"] as? String, let other = URL(string: document) { checked["sameDocument"] = sameDocument(other, url) }
        print(String(data: try JSONSerialization.data(withJSONObject: checked), encoding: .utf8)!)
        exit(0) // Pure validation: no AX query, app lookup or launch.
    }
    guard AXIsProcessTrusted() else { throw failure("Accessibility unavailable; fixture stopped before opening a game") }
    if op == "close" {
        guard let path = request["path"] as? String else { throw failure("exact owned document path required for close") }
        _ = try ownedGameURL(path)
    }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Chess")
    if apps.isEmpty { output = try absentAppResult(op) }
    else {
        guard apps.count == 1 else { throw failure("exactly one Chess process is required") }
        let app = apps[0], info = list(apps[0].processIdentifier)
        guard let windows = attr(AXUIElementCreateApplication(app.processIdentifier), "AXWindows") as? [AXUIElement] else { throw failure("Chess AX windows unavailable; cleanup unconfirmed") }
        if op == "snapshot" {
            let ownedAXWindows: [[String: Any]] = windows.compactMap { window -> [String: Any]? in
                let title = attr(window, "AXTitle") as? String ?? ""
                guard title.hasPrefix("sleight-stacked-") else { return nil }
                var record: [String: Any] = ["title": title]
                if let document = attr(window, "AXDocument") as? String, let url = URL(string: document) {
                    record["path"] = reportedPath(url)
                }
                return record
            }
            let records: [[String: Any]] = info.map { entry -> [String: Any] in
                var record: [String: Any] = ["id": entry[kCGWindowNumber as String] ?? 0, "title": publishedTitle(entry[kCGWindowName as String] as? String ?? "")]
                let matches = windows.filter { match($0, entry) }
                if matches.count == 1, let document = attr(matches[0], "AXDocument") as? String, let url = URL(string: document) {
                    record["path"] = reportedPath(url)
                }
                return record
            }
            output = ["ok": true, "running": true, "ownedAXWindows": ownedAXWindows, "windows": records]
        } else {
            let wanted: [AXUIElement]
            if let path = request["path"] as? String {
                let url = try ownedGameURL(path)
                wanted = windows.filter { window in
                    guard let value = attr(window, "AXDocument") as? String, let document = URL(string: value) else { return false }
                    return sameDocument(document, url)
                }
            } else if op == "close", let id = request["windowId"] as? Int {
                if let entry = info.first(where: { $0[kCGWindowNumber as String] as? Int == id }) {
                    wanted = windows.filter { match($0, entry) }
                    guard wanted.count == 1 else { throw failure("recorded CG window cannot match one AX window") }
                } else { wanted = [] }
            } else { throw failure("owned path or recorded cleanup ID required") }
            if op == "close" && wanted.isEmpty { output = ["ok": true, "alreadyClosed": true] }
            else {
                guard wanted.count == 1 else { throw failure("owned AX window absent or ambiguous") }
                let window = wanted[0]
                if op == "close" {
                    guard let path = request["path"] as? String else { throw failure("exact owned document path required for close") }
                    let expected = try ownedGameURL(path)
                    func remainsOpen() -> Bool {
                        guard let current = attr(AXUIElementCreateApplication(app.processIdentifier), "AXWindows") as? [AXUIElement] else { return true }
                        return current.contains { el in
                            guard let value = attr(el, "AXDocument") as? String, let document = URL(string: value) else { return false }
                            return sameDocument(document, expected)
                        }
                    }
                    _ = app.activate(options: [])
                    output["mainAccepted"] = AXUIElementSetAttributeValue(window, "AXMain" as CFString, kCFBooleanTrue).rawValue
                    output["raised"] = AXUIElementPerformAction(window, "AXRaise" as CFString).rawValue
                    Thread.sleep(forTimeInterval: 0.3)
                    guard let close = attr(window, "AXCloseButton"), CFGetTypeID(close) == AXUIElementGetTypeID() else { throw failure("owned close button absent") }
                    let closed = try closeSequence([{
                        guard AXUIElementPerformAction(unsafeBitCast(close, to: AXUIElement.self), "AXPress" as CFString) == .success else { throw failure("owned window close refused") }
                        Thread.sleep(forTimeInterval: 1)
                    }, {
                    let closeRect = try frame(unsafeBitCast(close, to: AXUIElement.self))
                    let closePoint = CGPoint(x: closeRect.midX, y: closeRect.midY)
                    let ownEntries = list(app.processIdentifier).filter { match(window, $0) }
                    let visible = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]] ?? []
                    let top = visible.first { entry in
                        guard let bounds = entry[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds) else { return false }
                        return rect.contains(closePoint) && !(entry[kCGWindowOwnerName as String] as? String ?? "").hasSuffix("Computer Use")
                    }
                    output["closePointTopWindow"] = top?[kCGWindowNumber as String]
                    if ownEntries.count == 1, let id = ownEntries[0][kCGWindowNumber as String] as? Int,
                       top?[kCGWindowNumber as String] as? Int == id, let saved = CGEvent(source: nil)?.location {
                        defer { CGWarpMouseCursorPosition(saved) }
                        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: closePoint, mouseButton: .left),
                              let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: closePoint, mouseButton: .left),
                              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: closePoint, mouseButton: .left) else { throw failure("owned close mouse unavailable") }
                        down.setIntegerValueField(.mouseEventClickState, value: 1); up.setIntegerValueField(.mouseEventClickState, value: 1)
                        move.post(tap: .cghidEventTap); Thread.sleep(forTimeInterval: 0.05)
                        down.post(tap: .cghidEventTap); Thread.sleep(forTimeInterval: 0.05); up.post(tap: .cghidEventTap)
                        output["closeClickSent"] = true
                        Thread.sleep(forTimeInterval: 1)
                    }
                    }, {
                    // Chess can accept AXPress on its close button without closing.
                    // Cmd+W is permitted only while this exact owned window has focus.
                    let appElement = AXUIElementCreateApplication(app.processIdentifier)
                    if let focused = attr(appElement, "AXFocusedWindow"), CFGetTypeID(focused) == AXUIElementGetTypeID(),
                       CFEqual(focused, window), NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier {
                        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 13, keyDown: true),
                              let up = CGEvent(keyboardEventSource: nil, virtualKey: 13, keyDown: false) else { throw failure("owned close key unavailable") }
                        down.flags = .maskCommand; up.flags = .maskCommand
                        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
                        output["closeKeySent"] = true
                        Thread.sleep(forTimeInterval: 1)
                    }
                    }], remainsOpen: remainsOpen)
                    var buttons: [[String: String]] = []
                    func readButtons(_ el: AXUIElement, _ depth: Int) {
                        guard depth < 8 && buttons.count < 100 else { return }
                        let role = attr(el, "AXRole") as? String ?? ""
                        let title = attr(el, "AXTitle") as? String ?? ""
                        let description = attr(el, "AXDescription") as? String ?? ""
                        if role == "AXButton" || role == "AXStaticText" { buttons.append(["role": role, "title": title, "description": description, "value": attr(el, "AXValue") as? String ?? ""]) }
                        for child in attr(el, "AXChildren") as? [AXUIElement] ?? [] { readButtons(child, depth + 1) }
                    }
                    if !closed { for sheet in attr(window, "AXSheets") as? [AXUIElement] ?? [] { readButtons(sheet, 0) } }
                    output["ownedSheets"] = buttons
                    if !closed { readButtons(window, 0) }
                    output["ownedChildren"] = buttons
                    let remaining = attr(AXUIElementCreateApplication(app.processIdentifier), "AXWindows") as? [AXUIElement] ?? []
                    output["remainingOwnedDocuments"] = remaining.compactMap { el -> String? in
                        guard let value = attr(el, "AXDocument") as? String, let url = URL(string: value),
                              url.path.contains("sleight-chess-stacked-") else { return nil }
                        return url.path
                    }
                    guard closed else { throw failure("owned window remains open") }
                    output = ["ok": true, "closed": true]
                } else {
                    if op == "place" {
                        let display = CGDisplayBounds(CGMainDisplayID())
                        var point = CGPoint(x: display.minX + 100, y: display.minY + 100)
                        let current = try frame(window)
                        guard display.contains(CGRect(origin: point, size: current.size)), let value = AXValueCreate(.cgPoint, &point),
                              AXUIElementSetAttributeValue(window, "AXPosition" as CFString, value) == .success else { throw failure("owned window placement refused") }
                        _ = AXUIElementSetAttributeValue(window, "AXMain" as CFString, kCFBooleanTrue)
                        guard AXUIElementPerformAction(window, "AXRaise" as CFString) == .success else { throw failure("owned window raise refused") }
                        _ = app.activate(options: [])
                        Thread.sleep(forTimeInterval: 1)
                    }
                    let entries = list(app.processIdentifier).filter { match(window, $0) }
                    guard entries.count == 1, let id = entries[0][kCGWindowNumber as String] as? Int else { throw failure("owned CG window absent or ambiguous") }
                    let rect = try frame(window)
                    output = ["ok": true, "windowId": id, "title": attr(window, "AXTitle") as? String ?? "", "bounds": [rect.minX, rect.minY, rect.width, rect.height], "squares": try squares(window)]
                }
            }
        }
    }
} catch { output["error"] = String(describing: error) }
print(String(data: try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
