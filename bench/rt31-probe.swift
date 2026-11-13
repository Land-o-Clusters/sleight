import AppKit
import ApplicationServices
import Carbon
import Darwin
import Foundation

// A single-row diagnostic. Dump mode never inspects apps, samples input, or posts.
struct ProbeFault: Error {
    let code: String
    var details: [String: Double] = [:]
    init(_ code: String, details: [String: Double] = [:]) { self.code = code; self.details = details }
}
func probeRequire(_ condition: Bool, _ code: String = "INVALID_REQUEST") throws {
    if !condition { throw ProbeFault(code) }
}
func probeNumber(_ value: Any?, max: Double = 2147483647, zero: Bool = false) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let n = number.doubleValue
    return n.isFinite && n >= (zero ? 0 : 1) && n <= max ? n : nil
}
struct ProbeRequest {
    let pid: Int32, window: Int
    let row: String, mode: String
    let point: [Double]?
    let idleSeconds: Double, toolbarHeight: Double, titleBarHeight: Double
    let coordinateMapping: String?
    init(_ r: [String: Any]) throws {
        guard let row = r["row"] as? String, let mode = r["mode"] as? String,
              let pid = probeNumber(r["pid"]), pid.rounded() == pid,
              let window = probeNumber(r["window"]), window.rounded() == window,
              probeNumber(r["version"]) == 1 else { throw ProbeFault("INVALID_REQUEST") }
        var keys: Set<String> = ["version", "pid", "window", "row", "mode"]
        if row == "move" || row == "click" { keys.formUnion(["point", "toolbarHeight", "titleBarHeight", "coordinateMapping"]) }
        if row == "unicode" { keys.insert("mappedQConfirmed") }
        if r["idleSeconds"] != nil { keys.insert("idleSeconds") }
        try probeRequire(Set(r.keys) == keys && ["move", "click", "mapped-keys", "belief-keys", "unicode"].contains(row))
        try probeRequire(["background", "foreground"].contains(mode))
        if let value = r["idleSeconds"] {
            guard let idle = probeNumber(value, max: 3600), idle >= 2 else { throw ProbeFault("INVALID_REQUEST") }
            idleSeconds = idle
        } else { idleSeconds = 2 }
        if row == "belief-keys" { try probeRequire(mode == "background", "BELIEF_REQUIRES_BACKGROUND") }
        if row == "unicode" {
            guard let confirmed = r["mappedQConfirmed"] as? NSNumber, CFGetTypeID(confirmed) == CFBooleanGetTypeID(), confirmed.boolValue,
                  mode == "foreground" else { throw ProbeFault("UNICODE_REQUIRES_MAPPED_Q") }
        }
        if row == "move" || row == "click" {
            guard let p = r["point"] as? [Any], p.count == 2,
                  let x = probeNumber(p[0], max: 100000, zero: true), let y = probeNumber(p[1], max: 100000, zero: true) else { throw ProbeFault("INVALID_POINT") }
            self.point = [x, y]
            guard let band = probeNumber(r["toolbarHeight"], max: 512),
                  let title = probeNumber(r["titleBarHeight"], max: 512),
                  r["coordinateMapping"] as? String == "window-bottom-left-to-cg-top-left" else { throw ProbeFault("INVALID_REQUEST") }
            toolbarHeight = band; titleBarHeight = title; coordinateMapping = r["coordinateMapping"] as? String
        } else { self.point = nil; toolbarHeight = 0; titleBarHeight = 0; coordinateMapping = nil }
        self.pid = Int32(pid); self.window = Int(window); self.row = row; self.mode = mode
    }
}
struct ProbeEvent {
    let type: String
    var delayMs = 0
    var point: [Double]?
    var pressure: Double?
    var clickCount: Int?
    var keyCode: Int?
    var unicode: String?
    var release: ProbeEvent? { // Every attempted down has an already prepared up.
        if type == "leftMouseDown" { return ProbeEvent(type: "leftMouseUp", delayMs: 50, point: point, pressure: 0, clickCount: 1) }
        if type == "keyDown" { return ProbeEvent(type: "keyUp", delayMs: 10, keyCode: keyCode, unicode: unicode) }
        return nil
    }
    var token: String { keyCode.map { "key-\($0)" } ?? "mouse-left" }
    func metadata(_ r: ProbeRequest) -> [String: Any] {
        var result: [String: Any] = ["pid": r.pid, "window": r.window, "source": "private", "flags": 0,
            "timestamp": "monotonic-at-post", "type": type, "delayBeforeMs": delayMs]
        if let point = point { result["point"] = point; result["pressure"] = pressure!; result["clickCount"] = clickCount!; result["eventNumber"] = 0 }
        if let keyCode = keyCode {
            result["keyCode"] = keyCode; result["autorepeat"] = false; result["keyboardType"] = "host-LMGetKbdType"
            let text = unicode ?? (keyCode == 12 ? "q" : keyCode == 123 ? "\u{f702}" : "\r")
            result["point"] = [0, 0]; result["characters"] = text; result["charactersIgnoringModifiers"] = text
            if let unicode = unicode { result["unicode"] = unicode }
        }
        if point == nil && keyCode == nil {
            result["point"] = [0, 0]; result["subtype"] = type; result["data1"] = 0; result["data2"] = 0
        }
        return result
    }
}
func probeEvents(_ r: ProbeRequest) -> [ProbeEvent] {
    if r.row == "move" { return [ProbeEvent(type: "mouseMoved", point: r.point, pressure: 0, clickCount: 0)] }
    if r.row == "click" { return [ProbeEvent(type: "mouseMoved", point: r.point, pressure: 0, clickCount: 0),
        ProbeEvent(type: "leftMouseDown", point: r.point, pressure: 1, clickCount: 1),
        ProbeEvent(type: "leftMouseUp", delayMs: 50, point: r.point, pressure: 0, clickCount: 1)] }
    if r.row == "unicode" { return [ProbeEvent(type: "keyDown", keyCode: 0, unicode: "q"), ProbeEvent(type: "keyUp", delayMs: 10, keyCode: 0, unicode: "q")] }
    let keys = [12, 123, 36].flatMap { [ProbeEvent(type: "keyDown", keyCode: $0), ProbeEvent(type: "keyUp", delayMs: 10, keyCode: $0)] }
    return r.row == "belief-keys" ? [ProbeEvent(type: "applicationActivated")] + keys + [ProbeEvent(type: "applicationDeactivated")] : keys
}
func probePlan(_ r: ProbeRequest, _ events: [ProbeEvent]) -> [String: Any] {
    var plan: [String: Any] = ["version": 1, "row": r.row, "mode": r.mode, "coordinateSpace": "window-bottom-left-points",
     "beliefWaitMs": r.row == "belief-keys" ? 150 : 0, "beliefLimitMs": r.row == "belief-keys" ? 400 : 0,
     "events": events.map { $0.metadata(r) }]
    if let mapping = r.coordinateMapping {
        plan["coordinateMapping"] = mapping; plan["titleBarHeight"] = r.titleBarHeight; plan["toolbarHeight"] = r.toolbarHeight
    }
    return plan
}

func probeConstruct(_ e: ProbeEvent, request r: ProbeRequest, source: CGEventSource) throws -> CGEvent {
    let now = ProcessInfo.processInfo.systemUptime
    let ns: NSEvent?
    if let point = e.point {
        let type: NSEvent.EventType = e.type == "mouseMoved" ? .mouseMoved : e.type == "leftMouseDown" ? .leftMouseDown : .leftMouseUp
        ns = NSEvent.mouseEvent(with: type, location: NSPoint(x: point[0], y: point[1]), modifierFlags: [], timestamp: now,
            windowNumber: r.window, context: nil, eventNumber: 0, clickCount: e.clickCount!, pressure: Float(e.pressure!))
    } else if let code = e.keyCode {
        let text = e.unicode ?? (code == 12 ? "q" : code == 123 ? "\u{f702}" : "\r")
        ns = NSEvent.keyEvent(with: e.type == "keyDown" ? .keyDown : .keyUp, location: .zero, modifierFlags: [],
            timestamp: now, windowNumber: r.window, context: nil, characters: text, charactersIgnoringModifiers: text,
            isARepeat: false, keyCode: UInt16(code))
    } else {
        let subtype: NSEvent.EventSubtype = e.type == "applicationActivated" ? .applicationActivated : .applicationDeactivated
        ns = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: now,
            windowNumber: r.window, context: nil, subtype: subtype.rawValue, data1: 0, data2: 0)
    }
    guard let event = ns?.cgEvent else { throw ProbeFault("EVENT_CONSTRUCTION_FAILED") }
    event.setSource(source); event.flags = []
    if e.keyCode != nil {
        event.setIntegerValueField(.keyboardEventAutorepeat, value: 0)
        event.setIntegerValueField(.keyboardEventKeyboardType, value: Int64(LMGetKbdType()))
        if let unicode = e.unicode {
            let utf16 = Array(unicode.utf16)
            utf16.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
        }
    }
    // Public round trip must preserve the requested window, point, type and keycode.
    guard let back = NSEvent(cgEvent: event), back.windowNumber == r.window,
          back.type == ns!.type else { throw ProbeFault("EVENT_CONSTRUCTION_FAILED") }
    if let point = e.point {
        try probeRequire(back.locationInWindow == NSPoint(x: point[0], y: point[1]) && back.clickCount == e.clickCount!, "EVENT_CONSTRUCTION_FAILED")
    }
    if let code = e.keyCode { try probeRequire(back.keyCode == UInt16(code) && !back.isARepeat, "EVENT_CONSTRUCTION_FAILED") }
    if e.keyCode == nil && e.point == nil { try probeRequire(back.subtype == ns!.subtype, "EVENT_CONSTRUCTION_FAILED") }
    return event
}

struct ProbeEnvironment {
    var now: () -> Double
    var pause: (Double) -> Void
    var check: () throws -> Void
    var identity: () throws -> Void
    var releaseIdentity: () throws -> Void
    var noHold: () throws -> Void
    var pointerGeometry: () throws -> Void
    var belief: () throws -> Bool
    var post: (ProbeEvent) throws -> Void
}
struct ProbeResult {
    var ok = false, reason = "SENT_UNVERIFIED", attempted = 0, releases = 0, pending = 0
    var beliefCleared = true, elapsedMs = 0.0, maxCriticalSectionMs = 0.0
    var criticalSectionExceeded = false
    var details: [String: Double] = [:]
    var metadata: [String: Any] {
        var value: [String: Any] = ["record": "summary", "ok": ok, "reason": reason, "attempted": attempted,
         "releases": releases, "pending": pending, "beliefCleared": beliefCleared, "elapsedMs": elapsedMs,
         "maxCriticalSectionMs": maxCriticalSectionMs, "criticalSectionExceeded": criticalSectionExceeded]
        for (key, number) in details { value[key] = number }
        return value
    }
}
// The fake and live providers share this lifecycle and guard wiring.
func probeRun(_ events: [ProbeEvent], env: ProbeEnvironment) -> ProbeResult {
    let started = env.now()
    var result = ProbeResult(), pending: [(String, ProbeEvent)] = []
    var heldAt: Double?, releaseRefusal: Error?
    func measureHeldSection() {
        if let at = heldAt {
            result.maxCriticalSectionMs = max(result.maxCriticalSectionMs, max(0, env.now() - at) * 1000)
        }
    }
    var activeAt: Double?, deactivationNeeded = false
    func guardInput() throws {
        try probeRequire(env.now() - started <= 2, "DEADLINE_EXCEEDED")
        if let at = activeAt { try probeRequire(env.now() - at <= 0.4, "BELIEF_INTERVAL_EXCEEDED") }
        try env.check(); try env.identity()
        try probeRequire(env.now() - started <= 2, "DEADLINE_EXCEEDED")
        if let at = activeAt { try probeRequire(env.now() - at <= 0.4, "BELIEF_INTERVAL_EXCEEDED") }
    }
    func waitBelief(_ expected: Bool, cleanup: Bool = false) throws {
        let end = env.now() + 0.15
        while true {
            if !cleanup { try guardInput() } else { try env.identity() }
            let believed = try env.belief()
            try probeRequire(env.now() <= end, "BELIEF_TIMEOUT")
            if believed == expected { return }
            try probeRequire(env.now() < end, "BELIEF_TIMEOUT")
            env.pause(min(0.02, end - env.now()))
        }
    }
    func post(_ e: ProbeEvent) throws {
        // Re-read AX frames before pointer moves and presses. Prepared releases
        // use the press's geometry, so AX cannot lengthen a held input pair.
        if e.point != nil && e.type != "leftMouseUp" && e.type != "keyUp" {
            try env.pointerGeometry()
            // AX can consume time. Recheck owner and identity before new input.
            try guardInput()
        }
        // Every post checks the hold. A safety release completes before its
        // refusal stops the row, so a mid-pair hold cannot strand a guest input.
        do { try env.noHold() }
        catch {
            if e.type == "keyUp" || e.type == "leftMouseUp" || e.type == "applicationDeactivated" { releaseRefusal = error }
            else { throw error }
        }
        result.attempted += 1
        if e.release != nil { heldAt = env.now() }
        try env.post(e)
        if e.type == "keyUp" || e.type == "leftMouseUp" { measureHeldSection(); heldAt = nil }
    }
    do {
        var skipIndex: Int?
        for (index, e) in events.enumerated() {
            if index == skipIndex { continue }
            try probeRequire(e.delayMs == 0, "INVALID_REQUEST")
            try guardInput()
            if e.type == "applicationActivated" {
                activeAt = env.now(); deactivationNeeded = true; result.beliefCleared = false
                try post(e); try waitBelief(true)
            } else if e.type == "applicationDeactivated" {
                try post(e); try waitBelief(false, cleanup: true)
                deactivationNeeded = false; result.beliefCleared = true
                if let fault = releaseRefusal { throw fault }
            } else {
                if let release = e.release {
                    // The guest needs a 10 ms key or 50 ms button hold. Releases
                    // skip AX geometry reads. SIGSTOP is uncatchable.
                    try probeRequire(index + 1 < events.count && events[index + 1].type == release.type &&
                        events[index + 1].token == release.token && events[index + 1].delayMs == release.delayMs, "EVENT_NOT_PREPARED")
                    pending.append((e.token, release))
                    var pairFault: Error?
                    let attemptsBeforePress = result.attempted
                    do { try post(e); env.pause(Double(release.delayMs) / 1000) }
                    catch { pairFault = error }
                    if result.attempted == attemptsBeforePress {
                        // A hold refused before the down reached its sink. There
                        // is no held input to release to the guest.
                        pending.removeAll { $0.0 == e.token }
                        throw pairFault ?? ProbeFault("PROBE_FAILED")
                    }
                    // Exactly one kernel start read. Even a failed read or changed
                    // start cannot prevent the prepared release of this pair.
                    do { try env.releaseIdentity() } catch { if pairFault == nil { pairFault = error } }
                    do {
                        try post(release)
                        pending.removeAll { $0.0 == e.token }; result.releases += 1; skipIndex = index + 1
                    } catch { if pairFault == nil { pairFault = error } }
                    try probeRequire(result.maxCriticalSectionMs <= 100, "CRITICAL_SECTION_EXCEEDED")
                    if let fault = pairFault ?? releaseRefusal { throw fault }
                    try guardInput()
                } else {
                    try post(e)
                }
            }
        }
        try guardInput(); result.ok = true
    } catch {
        result.reason = (error as? ProbeFault)?.code ?? "PROBE_FAILED"
        result.details = (error as? ProbeFault)?.details ?? [:]
    }
    // Cleanup ignores interruption, takeover and deadline. PID identity remains mandatory.
    result.pending = pending.count
    for (_, release) in pending.reversed() {
        do { try env.identity(); try post(release); result.releases += 1; result.pending -= 1 }
        catch { result.ok = false }
    }
    if deactivationNeeded {
        do {
            try env.identity(); try post(ProbeEvent(type: "applicationDeactivated")); try waitBelief(false, cleanup: true)
            result.beliefCleared = true
        } catch { result.ok = false }
    }
    if result.pending > 0 || !result.beliefCleared { result.ok = false; result.reason = "CLEANUP_UNCONFIRMED" }
    measureHeldSection()
    if releaseRefusal != nil { result.ok = false; if result.reason == "SENT_UNVERIFIED" { result.reason = "TIMED_WINDOW_HOLD" } }
    result.criticalSectionExceeded = result.maxCriticalSectionMs > 100
    if result.criticalSectionExceeded {
        result.ok = false
        if result.reason != "CLEANUP_UNCONFIRMED" { result.reason = "CRITICAL_SECTION_EXCEEDED" }
    }
    if let at = activeAt, env.now() - at > 0.4 { result.ok = false; if result.reason == "SENT_UNVERIFIED" { result.reason = "BELIEF_INTERVAL_EXCEEDED" } }
    result.elapsedMs = max(0, env.now() - started) * 1000
    return result
}

final class ProbeCancellation {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
}
struct ProbeHostSnapshot {
    let pid: Int32, start: ProbeStartTime
    let window: CFTypeRef?
    let pointer: CGPoint
    static func sample() throws -> ProbeHostSnapshot {
        // Query AX and the kernel on every sample, without a run-loop cache.
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.01)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &focused) == .success,
              let focused = focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { throw ProbeFault("HOST_STATE_UNAVAILABLE") }
        let ax = unsafeBitCast(focused, to: AXUIElement.self)
        var pid: pid_t = 0
        guard AXUIElementGetPid(ax, &pid) == .success, pid > 0,
              let pointer = CGEvent(source: nil)?.location else { throw ProbeFault("HOST_STATE_UNAVAILABLE") }
        let start = try probeKernelStart(pid)
        AXUIElementSetMessagingTimeout(ax, 0.01)
        var window: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &window)
        try probeRequire(status == .success || status == .noValue || status == .attributeUnsupported, "HOST_STATE_UNAVAILABLE")
        if let window = window { try probeRequire(CFGetTypeID(window) == AXUIElementGetTypeID(), "HOST_STATE_UNAVAILABLE") }
        try probeRequire(try probeKernelStart(pid) == start, "HOST_STATE_UNAVAILABLE")
        return ProbeHostSnapshot(pid: pid, start: start, window: window, pointer: pointer)
    }
    func sameFocus(_ other: ProbeHostSnapshot) -> Bool {
        guard pid == other.pid, start == other.start else { return false }
        if let a = window, let b = other.window { return CFEqual(a, b) }
        return window == nil && other.window == nil
    }
}

struct ProbeStartTime: Equatable {
    let seconds: UInt64, microseconds: UInt64
}
func probeNoHold(_ path: String = "/tmp/sleight-hold", inspect: (String, UnsafeMutablePointer<stat>) -> Int32 = { Darwin.lstat($0, $1) }) throws {
    var info = stat()
    let status = inspect(path, &info)
    try probeRequire(status == -1 && errno == ENOENT, "TIMED_WINDOW_HOLD")
}
func probeKernelStart(_ pid: Int32) throws -> ProbeStartTime {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_pid == UInt32(pid), info.pbi_start_tvsec > 0,
          info.pbi_start_tvusec < 1_000_000 else { throw ProbeFault("PROCESS_IDENTITY_UNAVAILABLE") }
    return ProbeStartTime(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
}
struct ProbeProcessIdentity: Equatable {
    let pid: Int32, bundle: String, start: ProbeStartTime, executable: URL
}
func probeVerifyProcess(_ current: ProbeProcessIdentity, request: ProbeRequest, expected: ProbeProcessIdentity? = nil) throws {
    try probeRequire(current.pid == request.pid && current.bundle == "com.utmapp.UTM" &&
        current.executable.path == "/Applications/UTM.app/Contents/MacOS/UTM", "NOT_EXACT_UTM")
    if let expected = expected { try probeRequire(current == expected, "PROCESS_IDENTITY_CHANGED") }
}
func probeSelectWindow(_ rows: [[String: Any]], _ r: ProbeRequest) throws -> (CGRect, String) {
    // Count every layer, including panels, alerts and menu-bar windows. No exemptions.
    let owned = rows.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == r.pid }
    if owned.count != 1 { throw ProbeFault("WINDOW_AMBIGUOUS", details: ["cgWindowCount": Double(owned.count)]) }
    guard let w = owned.first, (w[kCGWindowNumber as String] as? NSNumber)?.intValue == r.window,
          (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let raw = w[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: raw as CFDictionary), rect.width > 0, rect.height > 0 else { throw ProbeFault("WINDOW_IDENTITY_CHANGED") }
    return (rect, w[kCGWindowName as String] as? String ?? "")
}

func probeIdle(_ idleMs: Double, threshold: Double) throws {
    try probeRequire(idleMs.isFinite && idleMs >= 0, "HOST_STATE_UNAVAILABLE")
    if idleMs < threshold {
        throw ProbeFault("PERSON_ACTIVE", details: ["hidIdleMs": idleMs, "idleThresholdMs": threshold])
    }
}

func probeContentPoint(_ r: ProbeRequest, bounds: CGRect) throws {
    guard let p = r.point else { return }
    try probeRequire(p[0] >= 0 && p[0] < bounds.width && p[1] >= 0 && p[1] < bounds.height, "POINT_OUTSIDE_CONTENT")
}

func probeGlobalPoint(_ r: ProbeRequest, bounds: CGRect) throws -> CGPoint? {
    try probeContentPoint(r, bounds: bounds)
    guard let p = r.point else { return nil }
    try probeRequire(r.coordinateMapping == "window-bottom-left-to-cg-top-left")
    let point = CGPoint(x: bounds.minX + p[0], y: bounds.maxY - p[1])
    try probeRequire(point.x.isFinite && point.y.isFinite, "INVALID_POINT")
    return point
}

func probeAXAttribute(_ element: AXUIElement, _ name: String, optional: Bool = false) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if optional && (status == .noValue || status == .attributeUnsupported) { return nil }
    try probeRequire(status == .success && value != nil, "WINDOW_UNAVAILABLE")
    return value
}

func probeVerifyWindowUI(role: String, subrole: String, sheetCount: Int, childRoles: [String], modal: Bool) throws {
    let blocking = ["AXSheet", "AXDialog", "AXAlert", "AXSystemDialog", "AXPopover", "AXPanel"]
    try probeRequire(role == kAXWindowRole && subrole == kAXStandardWindowSubrole &&
        sheetCount == 0 && !modal && !childRoles.contains(where: { blocking.contains($0) }), "WINDOW_BLOCKED")
}

func probeNoBlockingUI(_ pid: Int32) throws -> [String: Double] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.01)
    var counts: [String: Double] = [:]
    do {
    // A sheet may be attached to a window without its own CGWindowList row.
    guard let windows = try probeAXAttribute(app, kAXWindowsAttribute) as? [AXUIElement] else { throw ProbeFault("WINDOW_BLOCKED") }
    counts["axWindowCount"] = Double(windows.count)
    try probeRequire(windows.count == 1, "WINDOW_BLOCKED")
    let window = windows[0]
    AXUIElementSetMessagingTimeout(window, 0.01)
    guard let role = try probeAXAttribute(window, kAXRoleAttribute) as? String,
          let subrole = try probeAXAttribute(window, kAXSubroleAttribute) as? String else { throw ProbeFault("WINDOW_BLOCKED") }
    var sheetCount = 0, isModal = false
    if let sheets = try probeAXAttribute(window, "AXSheets", optional: true) {
        guard let list = sheets as? [AXUIElement] else { throw ProbeFault("WINDOW_BLOCKED") }
        sheetCount = list.count
    }
    if let modal = try probeAXAttribute(window, kAXModalAttribute, optional: true) {
        try probeRequire(CFGetTypeID(modal) == CFBooleanGetTypeID(), "WINDOW_BLOCKED")
        isModal = CFEqual(modal, kCFBooleanTrue)
    }
    // Cocoa also exposes attached sheets as direct children, even when AXSheets
    // is unsupported. Read roles only, never guest text or values.
    guard let children = try probeAXAttribute(window, kAXChildrenAttribute) as? [AXUIElement], children.count <= 64 else { throw ProbeFault("WINDOW_BLOCKED") }
    var childRoles: [String] = []
    for child in children {
        AXUIElementSetMessagingTimeout(child, 0.01)
        guard let childRole = try probeAXAttribute(child, kAXRoleAttribute) as? String else { throw ProbeFault("WINDOW_BLOCKED") }
        childRoles.append(childRole)
    }
    counts["sheetCount"] = Double(sheetCount); counts["childCount"] = Double(children.count)
    counts["modalCount"] = isModal ? 1 : 0
    counts["blockingChildCount"] = Double(childRoles.filter { ["AXSheet", "AXDialog", "AXAlert", "AXSystemDialog", "AXPopover", "AXPanel"].contains($0) }.count)
    try probeVerifyWindowUI(role: role, subrole: subrole, sheetCount: sheetCount, childRoles: childRoles, modal: isModal)
    if let focused = try probeAXAttribute(app, kAXFocusedWindowAttribute, optional: true) {
        try probeRequire(CFGetTypeID(focused) == AXUIElementGetTypeID() && CFEqual(focused, window), "WINDOW_BLOCKED")
    }
    return counts
    } catch {
        let fault = (error as? ProbeFault) ?? ProbeFault("WINDOW_UNAVAILABLE")
        throw ProbeFault(fault.code, details: fault.details.merging(counts) { _, new in new })
    }
}

struct ProbeAXGeometry {
    let window: CGRect, toolbar: CGRect, content: CGRect
    func validate(_ request: ProbeRequest, bounds: CGRect) throws {
        _ = try measurements(bounds: bounds)
        guard request.point != nil else { return }
        let titleBarHeight = Double(toolbar.minY - window.minY), toolbarHeight = Double(content.minY - toolbar.minY)
        try probeRequire(abs(request.titleBarHeight - titleBarHeight) <= 2 &&
            abs(request.toolbarHeight - toolbarHeight) <= 2, "HEIGHT_MISMATCH")
        guard let point = try probeGlobalPoint(request, bounds: bounds) else { throw ProbeFault("INVALID_POINT") }
        try probeRequire(content.contains(point), "POINT_OUTSIDE_CONTENT")
    }
    func measurements(bounds: CGRect) throws -> [String: Any] {
        for frame in [window, toolbar, content] {
            try probeRequire([frame.minX, frame.minY, frame.width, frame.height].allSatisfy { $0.isFinite && abs($0) <= 200000 } &&
                frame.width > 0 && frame.height > 0, "WINDOW_UNAVAILABLE")
        }
        let title = Double(toolbar.minY - window.minY), bar = Double(content.minY - toolbar.minY)
        try probeRequire(window == bounds && window.contains(toolbar) && window.contains(content) &&
            abs(toolbar.maxY - content.minY) <= 1 && title >= 1 && title <= 512 && bar >= 1 && bar <= 512 &&
            title + bar < window.height, "WINDOW_UNAVAILABLE")
        func numbers(_ frame: CGRect) -> [Double] { [Double(frame.minX), Double(frame.minY), Double(frame.width), Double(frame.height)] }
        return ["axWindowFrame": numbers(window), "axToolbarFrame": numbers(toolbar), "axContentFrame": numbers(content),
            "titleBarHeight": title, "toolbarHeight": bar]
    }
}
func probeAXFrame(_ element: AXUIElement) throws -> CGRect {
    guard let position = try probeAXAttribute(element, kAXPositionAttribute),
          let size = try probeAXAttribute(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { throw ProbeFault("WINDOW_UNAVAILABLE") }
    let p = position as! AXValue, s = size as! AXValue
    var origin = CGPoint.zero, dimensions = CGSize.zero
    try probeRequire(AXValueGetType(p) == .cgPoint && AXValueGetType(s) == .cgSize &&
        AXValueGetValue(p, .cgPoint, &origin) && AXValueGetValue(s, .cgSize, &dimensions), "WINDOW_UNAVAILABLE")
    return CGRect(origin: origin, size: dimensions)
}
func probeAXGeometry(_ pid: Int32) throws -> ProbeAXGeometry {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.01)
    guard let windows = try probeAXAttribute(app, kAXWindowsAttribute) as? [AXUIElement], windows.count == 1 else { throw ProbeFault("WINDOW_UNAVAILABLE") }
    let window = windows[0]
    AXUIElementSetMessagingTimeout(window, 0.01)
    guard let children = try probeAXAttribute(window, kAXChildrenAttribute) as? [AXUIElement], children.count <= 64 else { throw ProbeFault("WINDOW_UNAVAILABLE") }
    var toolbars: [AXUIElement] = [], candidates: [AXUIElement] = []
    for child in children {
        AXUIElementSetMessagingTimeout(child, 0.01)
        guard let role = try probeAXAttribute(child, kAXRoleAttribute) as? String else { throw ProbeFault("WINDOW_UNAVAILABLE") }
        if role == "AXToolbar" { toolbars.append(child) }
        if ["AXSplitGroup", "AXScrollArea", "AXGroup"].contains(role) { candidates.append(child) }
    }
    if let contents = try probeAXAttribute(window, "AXContents", optional: true) {
        if CFGetTypeID(contents) == AXUIElementGetTypeID() { candidates = [contents as! AXUIElement] }
        else if let list = contents as? [AXUIElement] { candidates = list }
        else { throw ProbeFault("WINDOW_UNAVAILABLE") }
    }
    // Never infer an unexposed or ambiguous content origin from operator numbers.
    try probeRequire(toolbars.count == 1 && candidates.count == 1, "WINDOW_UNAVAILABLE")
    AXUIElementSetMessagingTimeout(candidates[0], 0.01)
    return ProbeAXGeometry(window: try probeAXFrame(window), toolbar: try probeAXFrame(toolbars[0]), content: try probeAXFrame(candidates[0]))
}

// Only host-facing operations are replaceable. Validation, prepared lookup, guard ordering,
// timestamp assignment and the destination PID stay in ProbeSystem for fake-based tests.
struct ProbeServices {
    var now: () -> Double
    var pause: (Double) -> Void
    var accessibility: () -> Bool
    var process: (Int32) throws -> ProbeProcessIdentity
    var startTime: (Int32) throws -> ProbeStartTime
    var noHold: () throws -> Void
    var window: (ProbeRequest) throws -> (CGRect, String)
    var geometry: (Int32) throws -> ProbeAXGeometry
    var noBlockingUI: (Int32) throws -> [String: Double]
    var host: () throws -> ProbeHostSnapshot
    var idleMs: () throws -> Double
    var secureInput: () -> Bool
    var modifiers: () -> CGEventFlags
    var belief: (Int32) throws -> Bool
    var sendToPid: (CGEvent, Int32) throws -> Void
    static var live: ProbeServices {
        ProbeServices(now: { ProcessInfo.processInfo.systemUptime }, pause: { Thread.sleep(forTimeInterval: $0) },
            accessibility: { AXIsProcessTrusted() }, process: ProbeSystem.app, startTime: probeKernelStart,
            noHold: { try probeNoHold() }, window: ProbeSystem.window, geometry: probeAXGeometry,
            noBlockingUI: probeNoBlockingUI, host: ProbeHostSnapshot.sample, idleMs: ProbeSystem.hidIdleMs,
            secureInput: { IsSecureEventInputEnabled() }, modifiers: { CGEventSource.flagsState(.hidSystemState) },
            belief: { pid in
                let ax = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(ax, 0.01)
                var value: CFTypeRef?
                guard AXUIElementCopyAttributeValue(ax, kAXFrontmostAttribute as CFString, &value) == .success,
                      let value = value, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw ProbeFault("BELIEF_UNAVAILABLE") }
                return CFEqual(value, kCFBooleanTrue)
            }, sendToPid: { event, pid in event.postToPid(pid) })
    }
}

final class ProbeSystem {
    let request: ProbeRequest, cancellation: ProbeCancellation
    let process: ProbeProcessIdentity, bounds: CGRect, windowTitle: String
    let host: ProbeHostSnapshot, began: Double
    let source: CGEventSource
    let services: ProbeServices
    var prepared: [String: CGEvent] = [:]
    var appKitCGPoint: [Double]?, uiCounts: [String: Double] = [:]
    var focusChanged = false, pointerChanged = false, personInput = false
    let hidIdleBeforeMs: Double
    static func hidIdleMs() throws -> Double {
        // UInt32.max is the documented kCGAnyInputEventType, not the null event.
        let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!)
        try probeRequire(idle.isFinite && idle >= 0, "HOST_STATE_UNAVAILABLE")
        return idle * 1000
    }
    static func app(_ pid: Int32) throws -> ProbeProcessIdentity {
        let start = try probeKernelStart(pid)
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { throw ProbeFault("PROCESS_IDENTITY_UNAVAILABLE") }
        let executable = URL(fileURLWithPath: String(cString: path))
        let bundleURL = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard let bundle = Bundle(url: bundleURL)?.bundleIdentifier else { throw ProbeFault("PROCESS_IDENTITY_UNAVAILABLE") }
        try probeRequire(try probeKernelStart(pid) == start, "PROCESS_IDENTITY_CHANGED")
        return ProbeProcessIdentity(pid: pid, bundle: bundle, start: start, executable: executable)
    }
    static func window(_ r: ProbeRequest) throws -> (CGRect, String) {
        guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { throw ProbeFault("WINDOW_UNAVAILABLE") }
        return try probeSelectWindow(rows, r)
    }
    init(_ r: ProbeRequest, cancellation: ProbeCancellation, services: ProbeServices = .live) throws {
        self.request = r; self.cancellation = cancellation; self.services = services
        try services.noHold()
        // Refuse a missing grant without displaying a permission prompt.
        try probeRequire(services.accessibility(), "ACCESSIBILITY_REQUIRED")
        process = try services.process(r.pid)
        try probeVerifyProcess(process, request: r)
        guard let source = CGEventSource(stateID: .privateState) else { throw ProbeFault("PROCESS_IDENTITY_UNAVAILABLE") }
        self.source = source
        let window = try services.window(r); bounds = window.0; windowTitle = window.1
        if r.point != nil { try services.geometry(r.pid).validate(r, bounds: bounds) }
        host = try services.host(); hidIdleBeforeMs = try services.idleMs(); began = services.now()
        try probeIdle(hidIdleBeforeMs, threshold: r.idleSeconds * 1000)
        try probeRequire((r.mode == "foreground") == (host.pid == r.pid), "WRONG_FOREGROUND_STATE")
        for e in probeEvents(r) + probeEvents(r).compactMap({ $0.release }) {
            let event = try probeConstruct(e, request: r, source: source)
            // Set the public CG location explicitly instead of relying on an AppKit
            // lookup of a window owned by a different process.
            if e.point != nil, let global = try probeGlobalPoint(r, bounds: bounds) {
                appKitCGPoint = [event.location.x, event.location.y]
                event.location = global
                try probeRequire(event.location == global, "EVENT_CONSTRUCTION_FAILED")
            }
            prepared[key(e)] = event
        }
        try check(); try identity()
    }
    func key(_ e: ProbeEvent) -> String { "\(e.type)-\(e.keyCode ?? -1)" }
    func identity() throws {
        try probeVerifyProcess(services.process(request.pid), request: request, expected: process)
    }
    func releaseIdentity() throws {
        try probeRequire(try services.startTime(request.pid) == process.start, "PROCESS_IDENTITY_CHANGED")
    }
    func pointerGeometry() throws {
        let currentWindow = try services.window(request)
        try probeRequire(currentWindow.0 == bounds && currentWindow.1 == windowTitle, "WINDOW_IDENTITY_CHANGED")
        try services.geometry(request.pid).validate(request, bounds: currentWindow.0)
    }
    func belief() throws -> Bool {
        try services.belief(request.pid)
    }
    func check() throws {
        try services.noHold()
        try probeRequire(!cancellation.isCancelled && probeInterrupted == 0, "CANCELLED")
        uiCounts = try services.noBlockingUI(request.pid)
        let currentWindow = try services.window(request)
        try probeRequire(currentWindow.0 == bounds && currentWindow.1 == windowTitle, "WINDOW_IDENTITY_CHANGED")
        try probeContentPoint(request, bounds: currentWindow.0)
        // AX inspection can take time. Sample owner state afterward, near dispatch.
        try probeRequire(!services.secureInput(), "SECURE_INPUT_ACTIVE")
        let held: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]
        try probeRequire(services.modifiers().intersection(held).isEmpty, "PERSON_HOLDS_MODIFIER")
        let current = try services.host()
        let elapsed = services.now() - began, idle = try services.idleMs()
        personInput = personInput || idle / 1000 < elapsed
        focusChanged = focusChanged || !host.sameFocus(current); pointerChanged = pointerChanged || host.pointer != current.pointer
        try probeRequire(!cancellation.isCancelled && probeInterrupted == 0, "CANCELLED")
        try probeIdle(idle, threshold: request.idleSeconds * 1000)
        try probeRequire(!personInput && !focusChanged && !pointerChanged, "PERSON_OR_HOST_CHANGED")
    }
    var environment: ProbeEnvironment {
        ProbeEnvironment(now: services.now, pause: services.pause,
            check: { try self.check() }, identity: { try self.identity() },
            releaseIdentity: { try self.releaseIdentity() }, noHold: services.noHold,
            pointerGeometry: { try self.pointerGeometry() },
            belief: { try self.belief() }, post: { e in
                guard let event = self.prepared[self.key(e)] else { throw ProbeFault("EVENT_NOT_PREPARED") }
                event.timestamp = DispatchTime.now().uptimeNanoseconds
                try self.services.sendToPid(event, self.request.pid)
            })
    }
    func inspection() throws -> [String: Any] {
        try check(); try identity()
        let geometry = try services.geometry(request.pid)
        let measurements = try geometry.measurements(bounds: bounds)
        try geometry.validate(request, bounds: bounds)
        try check(); try identity()
        var value: [String: Any] = ["record": "inspection", "ok": true, "reason": "INSPECTED_NO_POST",
            "attempted": 0, "releases": 0, "pending": 0, "beliefCleared": true, "maxCriticalSectionMs": 0,
            "pid": request.pid, "window": request.window, "row": request.row, "cgWindowCount": 1,
            "windowFrame": [Double(bounds.minX), Double(bounds.minY), Double(bounds.width), Double(bounds.height)],
            "hostPid": host.pid, "processStartSeconds": process.start.seconds, "processStartMicroseconds": process.start.microseconds,
            "hostStartSeconds": host.start.seconds, "hostStartMicroseconds": host.start.microseconds,
            "hidIdleBeforeMs": hidIdleBeforeMs]
        for (key, number) in uiCounts { value[key] = number }
        for (key, measurement) in measurements { value[key] = measurement }
        if let p = request.point, let raw = appKitCGPoint,
           let event = prepared[key(probeEvents(request)[0])] {
            value["windowPoint"] = p; value["appKitCGPoint"] = raw
            value["cgPoint"] = [Double(event.location.x), Double(event.location.y)]
            value["coordinateMapping"] = request.coordinateMapping
        }
        return value
    }
}

func probeEmit(_ value: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(70) }
    let line = bytes + Data([10])
    line.withUnsafeBytes { buffer in
        var offset = 0
        while offset < buffer.count {
            let count = Darwin.write(STDOUT_FILENO, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { exit(70) }
            offset += count
        }
    }
}

var probeInterrupted: sig_atomic_t = 0
func probeSignal(_ value: Int32) { probeInterrupted = 1 }
func probeInstallSignals() {
    probeInterrupted = 0 // Force Swift's global initializer before any handler can run.
    signal(SIGPIPE, SIG_IGN)
    // Stop/continue cancel rather than suspend or resume a row holding input.
    // Handlers only set sig_atomic_t storage. Cleanup stays on the main path.
    for value in [SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGTSTP, SIGCONT] { signal(value, probeSignal) }
}

#if !RT31_TEST
@main enum RT31Probe {
    static func main() {
        probeInstallSignals()
        let cancellation = ProbeCancellation()
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            if args == ["--help"] {
                let usage = "RT31: --dump or --dump-clock (offline); --inspect (host reads, zero posts); --live (one row). JSON on stdin. First inspect a mapped-keys row to read AX window, toolbar and content frames and measured titleBarHeight/toolbarHeight. Copy measured heights to pointer requests with coordinateMapping=window-bottom-left-to-cg-top-left, then inspect each point. Never pause or stop the helper: SIGSTOP and SIGKILL cannot be caught and can leave input held. Keys hold 10 ms, clicks 50 ms; no full identity read inside pairs. Pointer rows read AX window, toolbar and content frames at startup and before every pointer post. Heights must match within 2 points and the point must be inside measured content. Before release: one kernel start-time read, a hold lstat, and AX geometry for pointer input. A failed check still releases held input, then stops. Every row reports maxCriticalSectionMs; above 100 ms stops the sitting. lstat checks /tmp/sleight-hold before each post; held inputs release before a hold stops the row.\n"
                _ = usage.withCString { Darwin.write(STDOUT_FILENO, $0, strlen($0)) }; return
            }
            try probeRequire(args == ["--dump"] || args == ["--dump-clock"] || args == ["--inspect"] || args == ["--live"])
            let line = try probeReadLine()
            guard let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { throw ProbeFault("INVALID_REQUEST") }
            let r = try ProbeRequest(object), events = probeEvents(r)
            if args == ["--dump-clock"] {
                guard let source = CGEventSource(stateID: .privateState) else { throw ProbeFault("EVENT_CONSTRUCTION_FAILED") }
                let event = try probeConstruct(events[0], request: r, source: source)
                let uptime = DispatchTime.now().uptimeNanoseconds, timestamp = event.timestamp
                probeEmit(["record": "clock", "eventTimestampNs": timestamp, "uptimeTimestampNs": uptime,
                    "differenceNs": abs(Double(uptime) - Double(timestamp))]); return
            }
            if args == ["--dump"] {
                guard let source = CGEventSource(stateID: .privateState) else { throw ProbeFault("EVENT_CONSTRUCTION_FAILED") }
                for e in events { _ = try probeConstruct(e, request: r, source: source) }
                probeEmit(probePlan(r, events)); return
            }
            if args == ["--inspect"] {
                let system = try ProbeSystem(r, cancellation: cancellation)
                probeEmit(try system.inspection()); return
            }
            // The parent keeps stdin open. EOF or any control line cancels.
            DispatchQueue.global().async {
                var byte: UInt8 = 0
                _ = Darwin.read(STDIN_FILENO, &byte, 1)
                cancellation.cancel()
            }
            let system = try ProbeSystem(r, cancellation: cancellation)
            let result = probeRun(events, env: system.environment)
            var metadata = result.metadata
            do {
                let final = try ProbeHostSnapshot.sample()
                metadata["hidIdleBeforeMs"] = system.hidIdleBeforeMs; metadata["hidIdleAfterMs"] = try ProbeSystem.hidIdleMs()
                system.focusChanged = system.focusChanged || !system.host.sameFocus(final)
                system.pointerChanged = system.pointerChanged || system.host.pointer != final.pointer
            } catch { metadata["ok"] = false; metadata["reason"] = "HOST_STATE_UNAVAILABLE" }
            if system.focusChanged || system.pointerChanged { metadata["ok"] = false; metadata["reason"] = "PERSON_OR_HOST_CHANGED" }
            metadata["focusChanged"] = system.focusChanged; metadata["pointerChanged"] = system.pointerChanged; metadata["personInput"] = system.personInput
            metadata["pid"] = r.pid; metadata["window"] = r.window; metadata["row"] = r.row
            probeEmit(metadata)
            exit(metadata["ok"] as? Bool == true ? 0 : result.reason == "CANCELLED" ? 130 : 1)
        } catch {
            let reason = (error as? ProbeFault)?.code ?? "INVALID_REQUEST"
            var metadata: [String: Any] = ["record": "summary", "ok": false, "reason": reason, "attempted": 0, "releases": 0, "pending": 0, "maxCriticalSectionMs": 0]
            for (key, number) in (error as? ProbeFault)?.details ?? [:] { metadata[key] = number }
            probeEmit(metadata)
            exit(65)
        }
    }
}
func probeReadLine() throws -> Data {
    var bytes = Data(), byte: UInt8 = 0
    while bytes.count <= 4096 {
        let count = Darwin.read(STDIN_FILENO, &byte, 1)
        // Darwin signal() uses SA_RESTART. Keep EINTR handling for other interruptions;
        // no input is held while this initial request is being read.
        if count < 0 && errno == EINTR { if probeInterrupted != 0 { throw ProbeFault("CANCELLED") }; continue }
        try probeRequire(count == 1, "INVALID_REQUEST")
        if byte == 10 { return bytes }
        bytes.append(byte)
    }
    throw ProbeFault("INPUT_LIMIT")
}
#endif
