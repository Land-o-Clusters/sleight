import AppKit
import CoreGraphics
import Foundation
import IOKit

// Only this process's two windows. Input is dispatched to its own AppKit window, never posted to the OS.
// --selftest validates stdin and exercises the input model without constructing NSApplication or any window.
func emit(_ value: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(70) }
    do { try FileHandle.standardOutput.write(contentsOf: bytes + Data([10])) } catch { exit(0) }
}
func idle() -> Double? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    guard service != 0 else { return nil }; defer { IOObjectRelease(service) }
    return (IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber).map { $0.doubleValue / 1e9 }
}
func valid(_ row: [String: Any], token: Bool = true) -> Bool {
    guard let op = row["op"] as? String else { return false }
    var fields: Set<String> = ["op"]
    if token {
        fields.insert("token")
        guard let t = row["token"] as? String, t.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { return false }
    }
    switch op {
    case "click", "geometry":
        fields.insert("index")
        guard let index = row["index"] as? Int, (0...(op == "click" ? 1 : 2)).contains(index) else { return false }
    case "drag":
        fields.insert("to")
        guard let p = row["to"] as? [Double], p.count == 2, p.allSatisfy({ $0.isFinite }),
              (400...500).contains(p[0]), (80...160).contains(p[1]) else { return false }
    case "caption":
        fields.formUnion(["text", "notice"])
        guard let text = row["text"] as? String, text.utf8.count <= 1024,
              let notice = row["notice"] as? String, notice.utf8.count <= 12000 else { return false }
    case "panels":
        fields.insert("host")
        guard let pid = row["host"] as? Int32, pid > 0 else { return false }
    default: return false
    }
    return Set(row.keys) == fields
}
struct InputModel {
    var clicks = 0, drags = 0, tile = CGPoint(x: 100, y: 120), grabbed = false
    mutating func down(_ p: CGPoint) {
        grabbed = hypot(p.x - tile.x, p.y - tile.y) < 35
        if p.y > 200 { clicks += 1 }
    }
    mutating func drag(_ p: CGPoint) { if grabbed { tile = p } }
    mutating func up() { if grabbed { drags += 1 }; grabbed = false }
}
let arguments = CommandLine.arguments
func displayRefusal(_ asleep: Bool, _ locked: Bool?, _ visible: CGSize?) -> String? {
    guard let locked = locked else { return "screen-lock-state-unknown" }
    if locked { return "screen-locked" }
    if asleep { return "display-asleep" }
    guard let visible = visible, visible.width >= 850, visible.height >= 780 else { return "screen-too-small" }
    return nil
}
if arguments.count == 2 && arguments[1] == "--display-selftest" {
    guard let row = try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any],
          let asleep = row["asleep"] as? Bool else { exit(65) }
    let visible: CGSize?
    if let width = row["width"] as? Double, let height = row["height"] as? Double { visible = CGSize(width: width, height: height) }
    else { visible = nil }
    emit(["windowsCreated": 0, "reason": displayRefusal(asleep, row["locked"] as? Bool, visible) as Any? ?? NSNull()]); exit(0)
}
if arguments.count == 2 && arguments[1] == "--preflight" {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let locked = session.map { $0["CGSSessionScreenIsLocked"] as? Bool ?? false }
    if let reason = displayRefusal(CGDisplayIsAsleep(CGMainDisplayID()) != 0, locked, NSScreen.main?.visibleFrame.size) { emit(["ok": false, "error": reason]) }
    else { emit(["ok": true]) }
    exit(0)
}
let noticeFrame = CGRect(x: 24, y: 365, width: 752, height: 304)
let noticeFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
func noticeLayout(_ text: String) -> [String: Any] {
    let size = (text as NSString).boundingRect(with: CGSize(width: noticeFrame.width - 8, height: 10000),
        options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: noticeFont]).size
    return ["width": Double(size.width), "height": Double(size.height), "availableHeight": Double(noticeFrame.height),
        "fontPoints": 13, "gifWidth": 720, "gifFontPixels": 13 * 720.0 / 800,
        "fits": size.height + 8 <= noticeFrame.height && size.width <= noticeFrame.width - 8]
}
if arguments.count == 2 && arguments[1] == "--layout-selftest" {
    guard let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8), text.utf8.count <= 12000 else { exit(65) }
    emit(noticeLayout(text).merging(["windowsCreated": 0]) { _, b in b }); exit(0)
}
if arguments.count == 2 && arguments[1] == "--selftest" {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count < 16384, let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any], valid(row, token: false) else { exit(65) }
    var model = InputModel(); model.down(CGPoint(x: 180, y: 220)); model.up()
    model.down(model.tile); model.drag(CGPoint(x: 440, y: 120)); model.up()
    emit(["windowsCreated": 0, "valid": true, "clicks": model.clicks, "drags": model.drags, "destination": [Int(model.tile.x), Int(model.tile.y)]])
    exit(0)
}
guard arguments.count == 2, arguments[1] == "--serve",
      ProcessInfo.processInfo.environment["TMPDIR"]?.hasPrefix("/private/tmp/sleight-dm1-") == true else { exit(64) }

final class DemoView: NSView {
    var model = InputModel()
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirty: NSRect) {
        NSColor(calibratedRed: 0.96, green: 0.96, blue: 0.98, alpha: 1).setFill(); bounds.fill()
        let font: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .medium), .foregroundColor: NSColor.darkGray]
        for (i, x) in [CGFloat(120), CGFloat(320)].enumerated() {
            NSColor.white.setFill(); NSBezierPath(roundedRect: CGRect(x: x, y: 202, width: 120, height: 36), xRadius: 8, yRadius: 8).fill()
            "\(i == 0 ? "Prepare" : "Arrange")".draw(at: CGPoint(x: x + 24, y: 210), withAttributes: font)
        }
        NSColor.gray.setStroke(); let tray = NSBezierPath(roundedRect: CGRect(x: 400, y: 80, width: 100, height: 80), xRadius: 12, yRadius: 12); tray.lineWidth = 2; tray.stroke()
        NSColor(calibratedRed: 0.24, green: 0.47, blue: 0.91, alpha: 1).setFill()
        NSBezierPath(roundedRect: CGRect(x: model.tile.x - 24, y: model.tile.y - 24, width: 48, height: 48), xRadius: 8, yRadius: 8).fill()
        "Clicks \(model.clicks)     Drags \(model.drags)".draw(at: CGPoint(x: 30, y: 24), withAttributes: font)
    }
    override func mouseDown(with event: NSEvent) { model.down(convert(event.locationInWindow, from: nil)); needsDisplay = true }
    override func mouseDragged(with event: NSEvent) { model.drag(convert(event.locationInWindow, from: nil)); needsDisplay = true }
    override func mouseUp(with event: NSEvent) { model.up(); needsDisplay = true }
}
final class Fixture: NSObject, NSApplicationDelegate {
    var backdrop: NSWindow!, target: NSWindow!, canvas = DemoView(), label = NSTextField(wrappingLabelWithString: ""), notice = NSTextField(wrappingLabelWithString: "")
    var watch: Timer?, parent = getppid(), sources: [DispatchSourceSignal] = []
    var originTop: CGFloat { CGDisplayBounds(CGMainDisplayID()).maxY }
    func top(_ r: CGRect) -> [Double] { [Double(r.minX), Double(originTop - r.maxY), Double(r.width), Double(r.height)] }
    func global(_ p: CGPoint) -> [Double] { let s = target.convertPoint(toScreen: p); return [Double(s.x), Double(originTop - s.y)] }
    func position(_ index: Int) -> CGPoint { index == 2 ? canvas.model.tile : CGPoint(x: index == 0 ? 180 : 380, y: 220) }
    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard let screen = NSScreen.main, screen.visibleFrame.width >= 850, screen.visibleFrame.height >= 780 else { finish(2) }
        let frame = CGRect(x: screen.visibleFrame.midX - 400, y: screen.visibleFrame.midY - 370, width: 800, height: 740)
        backdrop = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        backdrop.isReleasedWhenClosed = false; backdrop.backgroundColor = NSColor(calibratedRed: 0.08, green: 0.1, blue: 0.15, alpha: 1)
        backdrop.sharingType = .readOnly; backdrop.ignoresMouseEvents = true
        label.frame = CGRect(x: 24, y: 675, width: 752, height: 52); label.font = .systemFont(ofSize: 12); label.textColor = .white
        notice.frame = noticeFrame; notice.font = noticeFont; notice.textColor = .white
        backdrop.contentView?.addSubview(label); backdrop.contentView?.addSubview(notice)
        target = NSWindow(contentRect: CGRect(x: frame.minX + 80, y: frame.minY + 30, width: 640, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        target.title = "sleight demo fixture"; target.isReleasedWhenClosed = false; target.sharingType = .readOnly
        target.contentView = canvas
        backdrop.orderFrontRegardless(); target.orderFrontRegardless()
        emit(["event": "ready", "pid": Int(getpid()), "fixture": backdrop.windowNumber, "target": target.windowNumber, "frame": top(target.frame), "crop": top(backdrop.frame)])
        watch = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self = self else { return }; if getppid() != self.parent { self.finish(0) }
            guard let p = CGEvent(source: nil)?.location, let seconds = idle() else { emit(["event": "input", "idle": NSNull()]); return }
            emit(["event": "input", "t": Date().timeIntervalSince1970 * 1000, "x": Double(p.x), "y": Double(p.y), "idle": seconds])
        }
        for number in [SIGINT, SIGTERM, SIGHUP] {
            signal(number, SIG_IGN); let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { self.finish(0) }; source.resume(); sources.append(source)
        }
        DispatchQueue.global().async {
            while let line = readLine() {
                guard line.utf8.count <= 16384, let data = line.data(using: .utf8), let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any], valid(row) else { DispatchQueue.main.async { self.finish(65) }; return }
                DispatchQueue.main.async { self.receive(row) }
            }
            DispatchQueue.main.async { self.finish(0) }
        }
    }
    func finish(_ code: Int32) -> Never { watch?.invalidate(); target?.close(); backdrop?.close(); exit(code) }
    func mouse(_ type: NSEvent.EventType, _ at: CGPoint, number: Int) {
        guard let event = NSEvent.mouseEvent(with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: target.windowNumber,
                                            context: nil, eventNumber: number, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) else { finish(65) }
        // AppKit dispatch, confined to our own window number. No CGEvent posting, Apple events or system pointer movement.
        target.sendEvent(event)
    }
    func reply(_ token: String, _ extra: [String: Any] = [:]) {
        emit(["event": "reply", "token": token, "clicks": canvas.model.clicks, "drags": canvas.model.drags].merging(extra) { _, b in b })
    }
    func receive(_ row: [String: Any]) {
        let token = row["token"] as! String, op = row["op"] as! String
        switch op {
        case "caption":
            let text = row["notice"] as! String, layout = noticeLayout(text)
            guard layout["fits"] as? Bool == true else { reply(token, ["error": "notice-clipped"]); return }
            label.stringValue = row["text"] as! String; notice.stringValue = text; reply(token, ["noticeLayout": layout])
        case "geometry":
            let p = position(row["index"] as! Int), r = target.convertToScreen(CGRect(x: p.x - 60, y: p.y - 18, width: 120, height: 36))
            reply(token, ["at": global(p), "rect": top(r)])
        case "click":
            let p = position(row["index"] as! Int); mouse(.leftMouseDown, p, number: 1)
            emit(["event": "action", "kind": "click", "at": global(p), "path": [global(p)]])
            mouse(.leftMouseUp, p, number: 2)
            reply(token, ["at": global(p)])
        case "drag":
            let dest = row["to"] as! [Double], start = canvas.model.tile, to = CGPoint(x: dest[0], y: dest[1])
            mouse(.leftMouseDown, start, number: 1)
            emit(["event": "action", "kind": "drag", "at": global(start), "path": [global(start), global(to)]])
            // Timed AppKit drag sequence, confined to the fixture's content, with an acknowledgment only after mouseUp.
            for i in 1...24 {
                DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) / 30) {
                    let fraction = CGFloat(i) / 24, p = CGPoint(x: start.x + (to.x - start.x) * fraction, y: start.y + (to.y - start.y) * fraction)
                    self.mouse(.leftMouseDragged, p, number: i + 1)
                    if i == 24 { self.mouse(.leftMouseUp, to, number: 26); self.reply(token, ["at": self.global(to)]) }
                }
            }
        case "panels":
            let host = row["host"] as! Int32
            var path = [CChar](repeating: 0, count: 4096)
            let wanted = URL(fileURLWithPath: arguments[0]).deletingLastPathComponent().appendingPathComponent("consent-host").path
            guard host != getpid(), getpgid(host) == getpgid(getpid()), proc_pidpath(host, &path, UInt32(path.count)) > 0, String(cString: path) == wanted else { finish(65) }
            let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let panels = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == host && ($0[kCGWindowAlpha as String] as? Double ?? 0) > 0 }
                .compactMap { item -> [String: Any]? in guard let id = item[kCGWindowNumber as String] as? Int else { return nil }; return ["id": id] }
            reply(token, ["panels": panels])
        default: finish(65)
        }
    }
}
let app = NSApplication.shared, fixture = Fixture()
app.setActivationPolicy(.accessory); app.delegate = fixture; app.run()
