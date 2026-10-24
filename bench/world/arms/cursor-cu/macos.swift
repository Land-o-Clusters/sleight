// Benchmark host interface. Inventory and AX card access only, never global input or process signals.
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
func owned(_ wanted: [String: Any]) throws -> NSRunningApplication {
    guard let pid = wanted["pid"] as? Int, pid > 0, pid <= Int(Int32.max),
          let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated else { try refuse("Cursor approval stop: process absent") }
    let actual = try identity(app)
    for key in ["pid", "bundleId", "executable", "launchAt"] {
        guard let a = actual[key] as? NSObject, let b = wanted[key] as? NSObject, a == b else { try refuse("Cursor approval stop: launch binding changed") }
    }
    guard ["com.todesktop.230313mzl4w4u92", "co.anysphere.cursor-computer-use"].contains(app.bundleIdentifier ?? "") else { try refuse("Cursor approval stop: bundle") }
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
          let apps = data["apps"] as? [String: String] else { try refuse("Cursor approval stop: invalid owner set") }
    var result: [Card] = []
    for owner in owners {
        let app = try owned(owner), pid = app.processIdentifier, root = AXUIElementCreateApplication(pid)
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
do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args.count == 2, let bytes = args[1].data(using: .utf8), let data = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { try refuse("invalid Cursor host arguments") }
    switch args[0] {
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
              let owner = current[0].row["owner"] as? [String: Any] else { try refuse("Cursor approval stop: stale card") }
        _ = try owned(owner)
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
