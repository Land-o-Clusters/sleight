// Calculator and Chess window arrangement for locked trials. No app launches.
import AppKit

func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func position(_ window: AXUIElement) throws -> CGPoint {
    guard let value = attr(window, "AXPosition"), CFGetTypeID(value) == AXValueGetTypeID() else {
        throw NSError(domain: "window position unavailable", code: 1)
    }
    var point = CGPoint.zero
    guard AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point) else {
        throw NSError(domain: "invalid window position", code: 1)
    }
    return point
}
func move(_ window: AXUIElement, _ point: CGPoint) throws {
    var point = point
    guard let value = AXValueCreate(.cgPoint, &point),
          AXUIElementSetAttributeValue(window, "AXPosition" as CFString, value) == .success else {
        throw NSError(domain: "window position write refused", code: 1)
    }
}
var output: [String: Any] = ["ok": false]
do {
    let request = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
    guard let appName = request["app"] as? String, ["Calculator", "Chess"].contains(appName), let op = request["op"] as? String,
          ["prepare", "restore"].contains(op) else { throw NSError(domain: "invalid fixture request", code: 1) }
    let title = request["windowTitle"] as? String ?? (appName == "Calculator" ? "Calculator" : "")
    guard !title.isEmpty else { throw NSError(domain: "an exact window title is required", code: 1) }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: appName == "Calculator" ? "com.apple.calculator" : "com.apple.Chess")
    guard apps.count == 1 else { throw NSError(domain: "fixture app must already be running", code: 1) }
    let app = apps[0]
    if op == "restore" && (request["pid"] as? Int != Int(app.processIdentifier)) {
        throw NSError(domain: "fixture app process changed", code: 1)
    }
    let windows = attr(AXUIElementCreateApplication(app.processIdentifier), "AXWindows") as? [AXUIElement] ?? []
    let matches = windows.filter { attr($0, "AXTitle") as? String == title }
    guard matches.count == 1 else { throw NSError(domain: "fixture window title is ambiguous or absent", code: 1) }
    let window = matches[0]
    let old = try position(window)
    let requested: CGPoint
    if op == "prepare" {
        let screen = CGDisplayBounds(CGMainDisplayID())
        requested = CGPoint(x: screen.minX + 100, y: screen.minY + 100)
        guard let value = attr(window, "AXSize"), CFGetTypeID(value) == AXValueGetTypeID() else {
            throw NSError(domain: "window size unavailable", code: 1)
        }
        var size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgSize, &size),
              screen.contains(CGRect(origin: requested, size: size)) else {
            throw NSError(domain: "fixture window must fit on one display", code: 1)
        }
    }
    else {
        guard let x = request["x"] as? Double, let y = request["y"] as? Double,
              x.isFinite, y.isFinite else { throw NSError(domain: "invalid saved position", code: 1) }
        requested = CGPoint(x: x, y: y)
    }
    // Return the checkpoint even if a later stage fails, so finally can restore it.
    output["checkpoint"] = ["app": appName, "windowTitle": title, "op": "restore", "pid": Int(app.processIdentifier), "x": old.x, "y": old.y]
    try move(window, requested)
    if op == "prepare" {
        output["raised"] = AXUIElementPerformAction(window, "AXRaise" as CFString).rawValue
        output["activationAccepted"] = app.activate(options: [])
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    let actual = try position(window)
    output["position"] = [actual.x, actual.y]
    output["frontPid"] = NSWorkspace.shared.frontmostApplication?.processIdentifier
    output["ok"] = abs(actual.x - requested.x) < 1 && abs(actual.y - requested.y) < 1
} catch { output["error"] = String(describing: error) }
let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
