// Select only the benchmark document; measure glyph bounds through Accessibility.
import AppKit

func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func textArea(_ element: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if attr(element, "AXRole") as? String == "AXTextArea" { return element }
    guard depth < 12 else { return nil }
    for child in attr(element, "AXChildren") as? [AXUIElement] ?? [] {
        if let found = textArea(child, depth: depth + 1) { return found }
    }
    return nil
}
func rangeValue(_ location: Int, _ length: Int) -> AXValue {
    var range = CFRange(location: location, length: length)
    return AXValueCreate(.cfRange, &range)!
}
func rect(_ area: AXUIElement, _ location: Int, _ length: Int) -> CGRect? {
    var result: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(area, "AXBoundsForRange" as CFString, rangeValue(location, length), &result) == .success,
          let result, CFGetTypeID(result) == AXValueGetTypeID() else { return nil }
    var rect = CGRect.zero
    return AXValueGetValue(unsafeBitCast(result, to: AXValue.self), .cgRect, &rect) ? rect : nil
}
let wanted = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath().path
let op = CommandLine.arguments[2]
var output: [String: Any] = ["ok": false]
if let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").first {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    let windows = attr(element, "AXWindows") as? [AXUIElement] ?? []
    if let window = windows.first(where: {
        guard let document = attr($0, "AXDocument") as? String, let url = URL(string: document) else { return false }
        return url.resolvingSymlinksInPath().path == wanted
    }), let area = textArea(window) {
        if op == "select" {
            let status = AXUIElementSetAttributeValue(area, "AXSelectedTextRange" as CFString, rangeValue(0, 5))
            let start = rect(area, 0, 5)
            let end = rect(area, 16, 0)
            var point = CGPoint.zero
            if let pos = attr(window, "AXPosition"), CFGetTypeID(pos) == AXValueGetTypeID() {
                _ = AXValueGetValue(unsafeBitCast(pos, to: AXValue.self), .cgPoint, &point)
            }
            output = ["ok": status == .success, "selected": attr(area, "AXSelectedText") as? String ?? "",
                      "active": app.isActive]
            if let start, let end {
                output["from"] = [Double(start.midX - point.x), Double(start.midY - point.y)]
                output["to"] = [Double(end.midX - point.x + 3), Double(end.midY - point.y)]
            }
            let title = attr(window, "AXTitle") as? String
            let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]] ?? []
            let matches = info.filter {
                guard ($0[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier),
                      ($0[kCGWindowName as String] as? String) == title,
                      let b = $0[kCGWindowBounds as String] as? NSDictionary,
                      let rect = CGRect(dictionaryRepresentation: b) else { return false }
                return rect.origin == point
            }
            if matches.count == 1 { output["windowId"] = matches[0][kCGWindowNumber as String] }
            else { output["ok"] = false }
        } else {
            output = ["ok": true, "text": attr(area, "AXValue") as? String ?? "", "active": app.isActive]
        }
    }
}
let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
