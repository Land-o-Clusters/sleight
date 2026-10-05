// A bounded TextEdit experiment. Never activates an app or changes AXFocused.
import AppKit

func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func matches(_ title: String?, _ document: String?, _ kind: String, _ wanted: String) -> Bool {
    if kind == "title" { return title == wanted }
    guard kind == "url", let document, let url = URL(string: document), url.isFileURL,
          let expected = URL(string: wanted), expected.isFileURL else { return false }
    func canonical(_ file: URL) -> String {
        file.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent(file.lastPathComponent).path
    }
    return canonical(url) == canonical(expected)
}
if CommandLine.arguments.dropFirst().first == "--test" {
    precondition(matches("a.txt", nil, "title", "a.txt"))
    precondition(!matches("ba.txt", nil, "title", "a.txt"))
    precondition(matches(nil, "file:///tmp/a%20b.txt", "url", "file:///private/tmp/a%20b.txt"))
    precondition(!matches(nil, "file:///tmp/b.txt", "url", "file:///tmp/a.txt"))
    precondition(!matches(nil, nil, "url", "file:///tmp/a.txt"))
    precondition(!matches(nil, "https://example.com/a", "url", "https://example.com/a"))
    print("6 AX selector checks passed")
    exit(0)
}
guard CommandLine.arguments.count == 4 else { exit(2) }
let op = CommandLine.arguments[1], kind = CommandLine.arguments[2], wanted = CommandLine.arguments[3]
var output: [String: Any] = ["ok": false, "selector": kind, "wanted": wanted]
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit")
if apps.count == 1 {
    let app = apps[0], element = AXUIElementCreateApplication(apps[0].processIdentifier)
    func observation() -> [String: Any] {
        var state: [String: Any] = ["active": app.isActive,
            "frontmostPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1]
        if let value = attr(element, "AXMainWindow"), CFGetTypeID(value) == AXUIElementGetTypeID() {
            let main = unsafeBitCast(value, to: AXUIElement.self)
            // Do not publish another session's document identity.
            state["mainMatchesTarget"] = matches(attr(main, "AXTitle") as? String,
                attr(main, "AXDocument") as? String, kind, wanted)
        }
        return state
    }
    output["before"] = observation()
    let windows = attr(element, "AXWindows") as? [AXUIElement] ?? []
    let selected = windows.filter { matches(attr($0, "AXTitle") as? String,
        attr($0, "AXDocument") as? String, kind, wanted) }
    output["matches"] = selected.count
    if selected.count == 1 {
        let window = selected[0]
        output["title"] = attr(window, "AXTitle") as? String
        output["document"] = attr(window, "AXDocument") as? String
        if op == "raise" {
            output["raiseStatus"] = AXUIElementPerformAction(window, "AXRaise" as CFString).rawValue
            output["mainStatus"] = AXUIElementSetAttributeValue(window, "AXMain" as CFString, kCFBooleanTrue).rawValue
        }
        output["ok"] = op == "raise" || op == "observe"
    }
    output["after"] = observation()
}
print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
