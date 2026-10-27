// Benchmark host interface. Scoped UI and card access, never global input or process signals.
import AppKit
import ApplicationServices
import Foundation

func refuse(_ message: String) throws -> Never { throw NSError(domain: "Cursor benchmark", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
func emit(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
func identity(_ app: NSRunningApplication) throws -> [String: Any] {
    guard let bundle = app.bundleIdentifier, let executable = app.executableURL?.path, let birth = app.launchDate else { try refuse("Cursor launch identity unavailable") }
    return ["pid": Int(app.processIdentifier), "bundleId": bundle, "executable": executable, "launchAt": birth.timeIntervalSince1970 * 1000]
}
func owned(_ wanted: [String: Any], _ expectedExecutable: String) throws -> NSRunningApplication {
    guard let pid = wanted["pid"] as? Int, pid > 0, pid <= Int(Int32.max),
          let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated else { try refuse("Cursor approval stop: process absent") }
    let actual = try identity(app)
    for key in ["pid", "bundleId", "executable", "launchAt"] {
        guard let a = actual[key] as? NSObject, let b = wanted[key] as? NSObject, a == b else { try refuse("Cursor approval stop: launch binding changed") }
    }
    guard ["com.todesktop.230313mzl4w4u92", "co.anysphere.cursor-computer-use"].contains(app.bundleIdentifier ?? "") else { try refuse("Cursor approval stop: bundle") }
    if app.bundleIdentifier == "com.todesktop.230313mzl4w4u92" {
        guard expectedExecutable.hasPrefix("/"), expectedExecutable.hasSuffix("/Cursor.app/Contents/MacOS/Cursor"),
              app.executableURL?.path == expectedExecutable else { try refuse("Cursor approval stop: installed executable differs") }
    } else {
        guard app.executableURL?.path.hasSuffix("/Contents/MacOS/CUCursorService") == true else { try refuse("Cursor approval stop: helper executable differs") }
    }
    return app
}
func attr(_ node: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(node, key as CFString, &value) == .success else { return nil }
    return value
}
func strings(_ node: AXUIElement) -> [String] {
    ["AXTitle", "AXDescription", "AXValue"].compactMap { attr(node, $0) as? String }.filter { !$0.isEmpty }
}
struct Card {
    let row: [String: Any]
    let button: AXUIElement?
}
func cards(_ data: [String: Any]) throws -> [Card] {
    guard let owners = data["owners"] as? [[String: Any]], !owners.isEmpty, owners.count <= 2,
          let apps = data["apps"] as? [String: String], let expectedExecutable = data["expectedExecutable"] as? String else { try refuse("Cursor approval stop: invalid owner set") }
    var result: [Card] = []
    for owner in owners {
        let app = try owned(owner, expectedExecutable), pid = app.processIdentifier, root = AXUIElementCreateApplication(pid)
        if app.bundleIdentifier == "com.todesktop.230313mzl4w4u92" {
            // Chromium builds web AX lazily. This touches only the bound installed app.
            guard AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success else { try refuse("Cursor approval stop: web accessibility unavailable") }
        }
        guard AXUIElementSetMessagingTimeout(root, 2) == .success,
              let windows = attr(root, "AXWindows") as? [AXUIElement] else { try refuse("Cursor approval stop: AX windows unavailable") }
        var visited = 0
        // A card is the smallest AX container holding its title and session button.
        func scan(_ node: AXUIElement, _ path: String, _ depth: Int) throws -> (titles: Set<String>, buttons: [AXUIElement], source: Bool, found: Bool) {
            visited += 1
            guard visited <= 12000, depth <= 40 else { try refuse("Cursor approval stop: AX tree truncated") }
            var elementPID: pid_t = 0
            guard AXUIElementGetPid(node, &elementPID) == .success, elementPID == pid else { try refuse("Cursor approval stop: AX pid mismatch") }
            let text = strings(node)
            var titles = Set(text.filter { $0.hasPrefix("Allow Cursor to use ") && $0.hasSuffix("?") })
            var buttons: [AXUIElement] = [], found = false, source = text.contains("Computer Use")
            if attr(node, "AXRole") as? String == "AXButton", attr(node, "AXTitle") as? String == "Allow in this chat" { buttons.append(node) }
            for (index, child) in (attr(node, "AXChildren") as? [AXUIElement] ?? []).enumerated() {
                let part = try scan(child, path + "." + String(index), depth + 1)
                titles.formUnion(part.titles); buttons += part.buttons; source = source || part.source; found = found || part.found
            }
            if !found && !titles.isEmpty && !buttons.isEmpty {
                guard titles.count == 1, buttons.count == 1, source, let title = titles.first else { try refuse("Cursor approval stop: ambiguous card or absent Computer Use source") }
                let name = String(title.dropFirst("Allow Cursor to use ".count).dropLast())
                let bundles = apps.filter { $0.value == name }.map { $0.key }
                let row: [String: Any] = ["owner": owner, "id": path, "title": title, "name": name,
                    "bundleId": bundles.count == 1 ? bundles[0] : "unknown", "source": "Computer Use", "button": "Allow in this chat"]
                result.append(Card(row: row, button: buttons[0])); found = true
            }
            return (titles, buttons, source, found)
        }
        for (index, window) in windows.enumerated() {
            let part = try scan(window, String(index), 0)
            let covered = Set(result.compactMap { $0.row["title"] as? String })
            if !part.titles.isSubset(of: covered) { try refuse("Cursor approval stop: unknown card buttons") }
        }
    }
    return result
}
// Every UI operation rebinds the exact process and window. Unknown controls refuse.
func ui(_ data: [String: Any]) throws -> Any {
    guard let owner = data["owner"] as? [String: Any], let executable = data["expectedExecutable"] as? String,
          executable == "/Applications/Cursor.app/Contents/MacOS/Cursor", let action = data["action"] as? String else { try refuse("Cursor UI binding missing") }
    let app = try owned(owner, executable), root = AXUIElementCreateApplication(app.processIdentifier)
    guard AXUIElementSetMessagingTimeout(root, 2) == .success else { try refuse("Cursor UI timeout setup failed") }
    func number(_ window: AXUIElement) -> Int? { (attr(window, "AXWindowNumber") as? NSNumber)?.intValue }
    if action == "bind" {
        guard let focused = attr(root, "AXFocusedWindow"), CFGetTypeID(focused) == AXUIElementGetTypeID() else { try refuse("Cursor focused window unavailable") }
        let window = unsafeBitCast(focused, to: AXUIElement.self)
        guard let id = number(window) else { try refuse("Cursor window identity unavailable") }
        return ["window": id]
    }
    guard let id = data["window"] as? Int, let windows = attr(root, "AXWindows") as? [AXUIElement] else { try refuse("Cursor UI window binding missing") }
    let matches = windows.filter { number($0) == id }
    guard matches.count == 1 else { try refuse("Cursor bound window disappeared") }
    let window = matches[0]
    var nodes: [AXUIElement] = [], visited = 0
    func scan(_ node: AXUIElement, _ depth: Int) throws {
        visited += 1
        guard visited <= 12000, depth <= 40 else { try refuse("Cursor UI tree truncated") }
        var pid: pid_t = 0
        guard AXUIElementGetPid(node, &pid) == .success, pid == app.processIdentifier else { try refuse("Cursor UI pid changed") }
        nodes.append(node)
        for child in attr(node, "AXChildren") as? [AXUIElement] ?? [] { try scan(child, depth + 1) }
    }
    try scan(window, 0)
    func role(_ node: AXUIElement) -> String { attr(node, "AXRole") as? String ?? "" }
    func named(_ node: AXUIElement, _ name: String) -> Bool {
        ["AXTitle", "AXDescription", "AXHelp"].contains { attr(node, $0) as? String == name }
    }
    func buttons(_ names: [String]) -> [AXUIElement] {
        nodes.filter { node in ["AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox"].contains(role(node)) && names.contains(where: { named(node, $0) }) }
    }
    func unique(_ rows: [AXUIElement]) throws -> AXUIElement {
        guard rows.count == 1 else { try refuse("Cursor UI control absent or ambiguous") }; return rows[0]
    }
    func press(_ node: AXUIElement) throws {
        guard attr(node, "AXEnabled") as? Bool != false,
              AXUIElementPerformAction(node, "AXPress" as CFString) == .success else { try refuse("Cursor UI AXPress refused") }
    }
    func input() throws -> AXUIElement {
        try unique(nodes.filter { node in ["AXTextArea", "AXTextField"].contains(role(node)) && ["Ask", "Ask anything", "Agent input"].contains(where: { named(node, $0) }) })
    }
    func inMenu(_ node: AXUIElement) -> Bool {
        var current = node
        for _ in 0..<16 {
            if ["AXMenu", "AXList", "AXListBox"].contains(role(current)) { return true }
            guard let parent = attr(current, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
            current = unsafeBitCast(parent, to: AXUIElement.self)
        }
        return false
    }
    if action == "bind-chat" || data["composerId"] != nil {
        guard let composer = data["composerId"] as? String, !composer.isEmpty, composer.count <= 100,
              nodes.filter({ attr($0, "AXIdentifier") as? String == composer || attr($0, "AXIdentifier") as? String == "composer-" + composer }).count == 1 else { try refuse("Cursor run chat UI binding unavailable or changed; supervised UI calibration required") }
        if action == "bind-chat" { return ["bound": true] }
    }
    if ["new-chat", "choose", "fill", "submit", "cancel"].contains(action), nodes.contains(where: { role($0) == "AXSheet" || attr($0, "AXSubrole") as? String == "AXDialog" }) { try refuse("Cursor UI dialog requires the owner") }
    switch action {
    case "readiness":
        let login = !buttons(["Account", "Manage Account"]).isEmpty && buttons(["Sign In", "Log In"]).isEmpty && !buttons(["New Chat", "New Agent"]).isEmpty
        return ["loggedIn": login, "busy": !buttons(["Stop", "Stop generating"]).isEmpty]
    case "selection":
        guard let labels = data["controls"] as? [String: String], labels.count == 5 else { try refuse("Cursor selection controls missing") }
        var result: [String: String] = [:]
        for (key, label) in labels {
            let node = try unique(buttons([label]))
            let recorded = attr(node, "AXValue") as? String
            let title = attr(node, "AXTitle") as? String
            guard let value = recorded?.isEmpty == false ? recorded : (title != label ? title : nil), !value.isEmpty, value.count <= 160 else { try refuse("Cursor selection value unavailable; supervised UI calibration required") }
            result[key] = value
        }
        return result
    case "choose":
        guard let control = data["control"] as? String, ["Select model", "Reasoning effort", "Speed", "Computer Use", "Computer Use target"].contains(control),
              let value = data["value"] as? String, !value.isEmpty, value.count <= 160,
              !["always allow", "allow in this chat", "allow", "decline", "sign in", "log in"].contains(value.lowercased()) else { try refuse("Cursor selection refused") }
        // Menu state can change after opening. Resolve the option from a fresh tree.
        if data["menuOpen"] as? Bool == true {
            try press(try unique(nodes.filter { ["AXMenuItem", "AXButton", "AXRadioButton"].contains(role($0)) && named($0, value) && inMenu($0) }))
        } else { try press(try unique(buttons([control]))) }
        return ["ok": true]
    case "new-chat": try press(try unique(buttons(["New Chat", "New Agent"]))); return ["ok": true]
    case "fill":
        guard let text = data["text"] as? String, text.count <= 100000, !text.contains("\0") else { try refuse("Cursor prompt refused") }
        let node = try input()
        // A newly created empty chat is required. Never overwrite an owner's draft.
        guard (attr(node, "AXValue") as? String ?? "").isEmpty else { try refuse("Cursor new chat has a draft; refusing overwrite") }
        guard AXUIElementSetAttributeValue(node, "AXValue" as CFString, text as CFString) == .success else { try refuse("Cursor prompt fill refused") }
        return ["ok": true]
    case "submit":
        guard let text = data["text"] as? String, attr(try input(), "AXValue") as? String == text else { try refuse("Cursor prompt changed before submit") }
        try press(try unique(buttons(["Send", "Submit"]))); return ["ok": true]
    case "cancel":
        let stop = buttons(["Stop", "Stop generating"])
        if !stop.isEmpty { try press(try unique(stop)) }; return ["ok": true]
    case "cards-visible":
        return ["visible": nodes.contains { node in strings(node).contains { $0.hasPrefix("Allow Cursor to use ") && $0.hasSuffix("?") } }]
    default: try refuse("Unknown Cursor UI operation")
    }
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args.count == 2, let bytes = args[1].data(using: .utf8), let data = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { try refuse("invalid Cursor host arguments") }
    switch args[0] {
    case "ui": try emit(try ui(data))
    case "inventory":
        guard let executable = data["executable"] as? String else { try refuse("missing executable") }
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier == "com.todesktop.230313mzl4w4u92" || $0.bundleIdentifier == "co.anysphere.cursor-computer-use" || $0.executableURL?.path == executable
        }
        try emit(try apps.map(identity))
    case "cards": try emit(try cards(data).map { $0.row })
    case "press":
        guard let requested = data["card"] as? NSDictionary, requested["button"] as? String == "Allow in this chat" else { try refuse("Cursor approval stop: button") }
        let current = try cards(data).filter { NSDictionary(dictionary: $0.row).isEqual(requested) }
        guard current.count == 1, let button = current[0].button,
              let owner = current[0].row["owner"] as? [String: Any], let expectedExecutable = data["expectedExecutable"] as? String else { try refuse("Cursor approval stop: stale card") }
        _ = try owned(owner, expectedExecutable)
        var actions: CFArray?
        guard AXUIElementCopyActionNames(button, &actions) == .success,
              (actions as? [String])?.contains("AXPress") == true,
              AXUIElementPerformAction(button, "AXPress" as CFString) == .success else { try refuse("Cursor approval stop: AXPress refused") }
        try emit(["pressed": true])
    default: try refuse("unknown Cursor host operation")
    }
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
