// A window that logs every mouse event it receives, to see what the engine's
// drag sends between press and release. Built by build.sh into
// .dev/DragProbe.app. Log: ~/Library/Logs/sleight/drag-probe.log
import AppKit

let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/sleight/drag-probe.log")

func log(_ line: String) {
    let stamp = String(format: "%.3f", Date().timeIntervalSince1970)
    let data = "\(stamp) \(line)\n".data(using: .utf8)!
    if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    } else {
        try? data.write(to: logURL)
    }
}

final class ProbeView: NSView {
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    private func record(_ name: String, _ event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        log("\(name) x=\(Int(p.x)) y=\(Int(p.y)) pressure=\(event.pressure)")
    }
    override func mouseDown(with event: NSEvent) { record("down", event) }
    override func mouseDragged(with event: NSEvent) { record("dragged", event) }
    override func mouseUp(with event: NSEvent) { record("up", event) }
    override func mouseMoved(with event: NSEvent) { record("moved", event) }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
        ("Drag probe: drag anywhere in this window." as NSString)
            .draw(at: NSPoint(x: 20, y: 20), withAttributes: [.font: NSFont.systemFont(ofSize: 14)])
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 500, height: 300),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Drag Probe"
        let view = ProbeView(frame: window.contentView!.bounds)
        view.setAccessibilityElement(true)
        view.setAccessibilityRole(.group)
        view.setAccessibilityLabel("Drag area")
        window.contentView = view
        window.acceptsMouseMovedEvents = true
        window.makeKeyAndOrderFront(nil)
        log("launched")
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
