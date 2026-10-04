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
        if op == "place" {
            let display = CGDisplayBounds(CGMainDisplayID())
            let large = CommandLine.arguments[3] == "other"
            // Settle activation before sizing an owned window. TextEdit can
            // otherwise apply a newly opened window's default size afterward.
            _ = app.activate(options: [])
            _ = AXUIElementPerformAction(window, "AXRaise" as CFString)
            Thread.sleep(forTimeInterval: 0.5)
            var point = CGPoint(x: display.minX + 100, y: display.minY + 100)
            var size = CGSize(width: large ? 800 : 600, height: large ? 500 : 400)
            if large {
                let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]] ?? []
                for entry in info where (entry[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier) && (entry[kCGWindowLayer as String] as? Int) == 0 {
                    if let bounds = entry[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds) {
                        size.width = max(size.width, rect.width + 100)
                        size.height = max(size.height, rect.height + 100)
                    }
                }
            }
            let p = AXValueCreate(.cgPoint, &point)!
            let s = AXValueCreate(.cgSize, &size)!
            let sized = AXUIElementSetAttributeValue(window, "AXSize" as CFString, s)
            let placed = AXUIElementSetAttributeValue(window, "AXPosition" as CFString, p)
            let raised = AXUIElementPerformAction(window, "AXRaise" as CFString)
            output = ["ok": sized == .success && placed == .success && raised == .success,
                      "requestedSize": [size.width, size.height], "requestedPosition": [point.x, point.y]]
        } else if op == "select" || op == "select-drag" {
            let status = AXUIElementSetAttributeValue(area, "AXSelectedTextRange" as CFString, rangeValue(0, 5))
            let start = op == "select-drag" ? rect(area, 2, 1) : rect(area, 0, 5)
            let end = op == "select-drag" ? rect(area, 15, 1) : rect(area, 16, 0)
            let lastGlyph = rect(area, 15, 1)
            var point = CGPoint.zero
            if let pos = attr(window, "AXPosition"), CFGetTypeID(pos) == AXValueGetTypeID() {
                _ = AXValueGetValue(unsafeBitCast(pos, to: AXValue.self), .cgPoint, &point)
            }
            output = ["ok": status == .success, "selected": attr(area, "AXSelectedText") as? String ?? "",
                      "active": app.isActive]
            if let start, let end {
                output["from"] = [Double(start.midX - point.x), Double(start.midY - point.y)]
                output["to"] = [Double((op == "select-drag" ? end.maxX : end.midX) - point.x + 3), Double(end.midY - point.y)]
                output["sourceRect"] = [start.minX, start.minY, start.width, start.height]
                output["lastGlyphRect"] = [end.minX, end.minY, end.width, end.height]
            }
            if let start, let lastGlyph {
                output["startBounds"] = [Double(start.minX), Double(start.minY), Double(start.width), Double(start.height)]
                output["endGlyphBounds"] = [Double(lastGlyph.minX), Double(lastGlyph.minY), Double(lastGlyph.width), Double(lastGlyph.height)]
                output["windowOrigin"] = [Double(point.x), Double(point.y)]
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
            if matches.count == 1 {
                output["windowId"] = matches[0][kCGWindowNumber as String]
                let own = info.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier) && ($0[kCGWindowLayer as String] as? Int) == 0 }
                let largest = own.max { a, b in
                    let ra = CGRect(dictionaryRepresentation: a[kCGWindowBounds as String] as! NSDictionary)!
                    let rb = CGRect(dictionaryRepresentation: b[kCGWindowBounds as String] as! NSDictionary)!
                    return ra.width * ra.height < rb.width * rb.height
                }
                output["isLargestWindow"] = (largest?[kCGWindowNumber as String] as? Int) == (matches[0][kCGWindowNumber as String] as? Int)
                let chosen = CGRect(dictionaryRepresentation: matches[0][kCGWindowBounds as String] as! NSDictionary)!
                output["isStrictlyLargestWindow"] = own.allSatisfy { entry in
                    if (entry[kCGWindowNumber as String] as? Int) == (matches[0][kCGWindowNumber as String] as? Int) { return true }
                    let other = CGRect(dictionaryRepresentation: entry[kCGWindowBounds as String] as! NSDictionary)!
                    return chosen.width * chosen.height > other.width * other.height
                }
            }
            else { output["ok"] = false }
        } else if op == "ax-drag" {
            var names: CFArray?
            let status = AXUIElementCopyActionNames(area, &names)
            let actions = names as? [String] ?? []
            // An action must be advertised by this exact text area. AXPick is
            // obsolete selection, not a drag API. Never substitute text editing.
            let drag = actions.first { $0 == "AXDrag" }
            let drop = actions.first { $0 == "AXDrop" }
            output = ["ok": false, "active": app.isActive, "actionsStatus": status.rawValue, "actions": actions,
                      "text": attr(area, "AXValue") as? String ?? ""]
            if let drag, let drop, !app.isActive {
                let dragStatus = AXUIElementPerformAction(area, drag as CFString)
                output["dragStatus"] = dragStatus.rawValue
                if dragStatus == .success {
                    let dropStatus = AXUIElementPerformAction(area, drop as CFString)
                    output["dropStatus"] = dropStatus.rawValue
                    output["ok"] = dropStatus == .success
                }
            } else { output["error"] = "TextEdit does not advertise AXDrag and AXDrop, or is active" }
        } else {
            output = ["ok": true, "text": attr(area, "AXValue") as? String ?? "", "selected": attr(area, "AXSelectedText") as? String ?? "", "active": app.isActive]
        }
    }
}
let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
