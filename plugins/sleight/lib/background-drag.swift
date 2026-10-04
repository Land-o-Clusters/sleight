// Experimental process-targeted drag. No activation, HID posting or cursor warp.
import AppKit
import Carbon
import Darwin

final class Cancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws {
        lock.lock(); let value = cancelled; lock.unlock()
        if value { throw failure("drag cancelled") }
    }
}
let cancellation = Cancellation()
let signalSources = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
    source.setEventHandler { cancellation.cancel() }
    source.resume()
    return source
}

struct Request: Decodable {
    let app: String
    let from: [Double]
    let to: [Double]
    let windowTitle: String?
    let windowId: UInt32?
    let abortAfterStep: Int? // diagnostic: exercise release after an interrupted burst
    var holdMs: Int = 500
    var steps: Int = 25
    var settleMs: Int = 1500
    var mode: String = "window-location"
    var select: Bool = false // benchmark only: double click before the drag
    enum CodingKeys: String, CodingKey { case app, from, to, windowTitle, windowId, holdMs, steps, settleMs, mode, select, abortAfterStep }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        app = try c.decode(String.self, forKey: .app)
        from = try c.decode([Double].self, forKey: .from)
        to = try c.decode([Double].self, forKey: .to)
        windowTitle = try c.decodeIfPresent(String.self, forKey: .windowTitle)
        windowId = try c.decodeIfPresent(UInt32.self, forKey: .windowId)
        abortAfterStep = try c.decodeIfPresent(Int.self, forKey: .abortAfterStep)
        holdMs = try c.decodeIfPresent(Int.self, forKey: .holdMs) ?? 500
        steps = try c.decodeIfPresent(Int.self, forKey: .steps) ?? 25
        settleMs = try c.decodeIfPresent(Int.self, forKey: .settleMs) ?? 1500
        mode = try c.decodeIfPresent(String.self, forKey: .mode) ?? "window-location"
        select = try c.decodeIfPresent(Bool.self, forKey: .select) ?? false
    }
}

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
func failure(_ message: String) -> NSError {
    NSError(domain: "background-drag", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
func perform(_ request: Request) throws -> [String: Any] {
    guard request.from.count == 2, request.to.count == 2,
          (request.from + request.to).allSatisfy({ $0.isFinite }),
          (0...5000).contains(request.holdMs), (1...100).contains(request.steps),
          (0...5000).contains(request.settleMs),
          request.abortAfterStep == nil || (1...request.steps).contains(request.abortAfterStep!),
          ["pid", "window", "key-window", "nsevent", "nsevent-command", "window-location", "key-window-location"].contains(request.mode) else {
        throw failure("invalid coordinates, timing, steps or mode")
    }
    guard AXIsProcessTrusted() else { throw failure("Accessibility permission is required") }
    guard let app = NSWorkspace.shared.runningApplications.first(where: {
        $0.localizedName == request.app || $0.bundleIdentifier == request.app || $0.bundleURL?.path == request.app
    }) else { throw failure("\(request.app) isn't running") }
    let pid = app.processIdentifier
    func frontPid() -> Int32 {
        // NSWorkspace receives activation notifications on the run loop. Pump it
        // before reading, instead of keeping its first observation for the burst.
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.001))
        return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    }
    let front = frontPid()
    guard front != 0 else { throw failure("cannot read the front application") }
    guard pid != front else { throw failure("target must be in the background") }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]] ?? []
    let own = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 && (request.windowTitle == nil || ($0[kCGWindowName as String] as? String) == request.windowTitle) && (request.windowId == nil || ($0[kCGWindowNumber as String] as? UInt32) == request.windowId) }
    func bounds(_ w: [String: Any]) -> CGRect {
        CGRect(dictionaryRepresentation: w[kCGWindowBounds as String] as! CFDictionary)!
    }
    guard let main = own.max(by: { bounds($0).width * bounds($0).height < bounds($1).width * bounds($1).height }),
          let window = main[kCGWindowNumber as String] as? UInt32 else { throw failure("no window on screen") }
    let frame = bounds(main)
    for p in [request.from, request.to] {
        guard p[0] >= 0, p[1] >= 0, p[0] < frame.width, p[1] < frame.height else { throw failure("point outside target window") }
    }
    let start = CGPoint(x: frame.minX + request.from[0], y: frame.minY + request.from[1])
    let end = CGPoint(x: frame.minX + request.to[0], y: frame.minY + request.to[1])
    func pointer() -> CGPoint { CGEvent(source: nil)!.location }
    let saved = pointer()
    var samples: [[String: Any]] = []
    func sample(_ stage: String) {
        let p = pointer()
        samples.append(["stage": stage, "pointer": [Double(p.x), Double(p.y)], "frontPid": frontPid()])
    }
    sample("before")
    var keyStatuses: [Int32] = []
    if request.mode.hasPrefix("key-window") {
        guard let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW),
              let symbol = dlsym(library, "SLPSPostEventRecordTo") else { throw failure("SLPSPostEventRecordTo unavailable") }
        defer { dlclose(library) }
        typealias Post = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UnsafeMutableRawPointer) -> Int32
        let post = unsafeBitCast(symbol, to: Post.self)
        var psn = ProcessSerialNumber()
        guard let services = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW),
              let getSymbol = dlsym(services, "GetProcessForPID") else { throw failure("GetProcessForPID unavailable") }
        defer { dlclose(services) }
        typealias GetPSN = @convention(c) (Int32, UnsafeMutablePointer<ProcessSerialNumber>) -> Int32
        let getPSN = unsafeBitCast(getSymbol, to: GetPSN.self)
        guard getPSN(pid, &psn) == 0 else { throw failure("GetProcessForPID failed") }
        // Layout from yabai's window_manager_make_key_window. Private ABI.
        var bytes = [UInt8](repeating: 0, count: 0xf8)
        bytes[0x04] = 0xf8
        bytes[0x3a] = 0x10
        withUnsafeBytes(of: window.littleEndian) { bytes.replaceSubrange(0x3c..<0x40, with: $0) }
        // Offscreen finite coordinates avoid passing NaN mouse locations.
        let offscreen: Double = -1_000_000
        withUnsafeBytes(of: offscreen) {
            bytes.replaceSubrange(0x20..<0x28, with: $0)
            bytes.replaceSubrange(0x28..<0x30, with: $0)
        }
        if request.mode == "key-window-location" {
            bytes[0x08] = 0x0d
            bytes[0x8a] = 0x01
            keyStatuses.append(bytes.withUnsafeMutableBytes { post(&psn, $0.baseAddress!) })
            bytes[0x8a] = 0
            usleep(40_000)
        }
        for kind: UInt8 in [1, 2] {
            bytes[0x08] = kind
            keyStatuses.append(bytes.withUnsafeMutableBytes { post(&psn, $0.baseAddress!) })
        }
        guard keyStatuses.allSatisfy({ $0 == 0 }) else { throw failure("key-window post failed: \(keyStatuses)") }
    }
    func wait(_ ms: Int) throws {
        for _ in 0..<ms / 10 { try cancellation.check(); usleep(10_000); sample("wait") }
    }
    let graphics = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW)
    defer { if let graphics { dlclose(graphics) } }
    typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    var setWindowLocation: SetWindowLocation?
    if request.mode.hasSuffix("window-location") {
        guard let graphics, let symbol = dlsym(graphics, "CGEventSetWindowLocation") else { throw failure("CGEventSetWindowLocation unavailable") }
        setWindowLocation = unsafeBitCast(symbol, to: SetWindowLocation.self)
    }
    func makeEvent(_ type: CGEventType, _ point: CGPoint, clicks: Int64 = 1) throws -> CGEvent {
        let event: CGEvent
        if request.mode.hasPrefix("nsevent") || request.mode.hasSuffix("window-location") {
            let nsType: NSEvent.EventType = type == .leftMouseDown ? .leftMouseDown : type == .leftMouseUp ? .leftMouseUp : type == .leftMouseDragged ? .leftMouseDragged : .mouseMoved
            guard let nsEvent = NSEvent.mouseEvent(with: nsType,
                    location: CGPoint(x: point.x - frame.minX, y: frame.height - (point.y - frame.minY)),
                    modifierFlags: (request.mode == "nsevent-command" || request.mode.hasSuffix("window-location")) ? .command : [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(window),
                    context: nil, eventNumber: 1, clickCount: Int(clicks), pressure: type == .leftMouseUp ? 0 : 1),
                  let cg = nsEvent.cgEvent else { throw failure("NSEvent creation failed") }
            event = cg
            event.location = point
            setWindowLocation?(event, CGPoint(x: point.x - frame.minX, y: point.y - frame.minY))
            event.setIntegerValueField(.mouseEventSubtype, value: 3)
        } else {
            guard let cg = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { throw failure("event creation failed") }
            event = cg
        }
        event.setIntegerValueField(.mouseEventClickState, value: clicks)
        if request.mode != "pid" {
            event.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(window))
            event.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(window))
        }
        return event
    }
    func post(_ type: CGEventType, _ point: CGPoint, clicks: Int64 = 1) throws {
        try cancellation.check()
        guard frontPid() == front else { throw failure("front app changed during drag") }
        let event = try makeEvent(type, point, clicks: clicks)
        event.postToPid(pid)
        sample("event-\(type.rawValue)")
    }
    try wait(request.settleMs)
    var release = try makeEvent(.leftMouseUp, start, clicks: 2)
    var pressed = false
    defer { if pressed { release.timestamp = DispatchTime.now().uptimeNanoseconds; release.postToPid(pid) } }
    if request.select {
        try post(.leftMouseDown, start, clicks: 2)
        pressed = true
        try post(.leftMouseUp, start, clicks: 2)
        pressed = false
        try wait(600)
    }
    try post(.mouseMoved, start)
    try wait(50)
    // Prepare a fully window-targeted release before pressing. A bare CGEvent
    // release is dropped by the inactive app, just like the failed controls.
    release = try makeEvent(.leftMouseUp, end)
    try post(.leftMouseDown, start)
    pressed = true
    try wait(request.holdMs)
    for i in 1...request.steps {
        let t = Double(i) / Double(request.steps)
        try post(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t))
        try wait(20)
        if request.abortAfterStep == i { throw failure("requested probe abort") }
    }
    try post(.leftMouseUp, end)
    pressed = false
    try wait(200)
    sample("after")
    let unchanged = samples.allSatisfy { ($0["pointer"] as! [Double]) == [Double(saved.x), Double(saved.y)] }
    let stayedBackground = samples.allSatisfy { ($0["frontPid"] as! Int32) == front }
    return ["ok": true, "posted": true, "deliveryVerified": false, "pid": pid, "window": window,
            "mode": request.mode, "keyStatuses": keyStatuses, "pointerUnchanged": unchanged,
            "stayedBackground": stayedBackground, "samples": samples]
}
do {
    guard CommandLine.arguments.count == 2 else { throw failure("expected one JSON request") }
    let request = try JSONDecoder().decode(Request.self, from: Data(CommandLine.arguments[1].utf8))
    emit(try perform(request))
} catch { emit(["ok": false, "error": error.localizedDescription]); exit(1) }
withExtendedLifetime(signalSources) {}
