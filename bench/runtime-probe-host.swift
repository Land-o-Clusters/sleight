import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Vision
import Carbon
import Darwin

// The harness owns this process. No input is generated here, and no app receives Apple events.
// --selftest does not initialize NSApplication or create a window.
let bundles: Set<String> = ["com.apple.calculator", "com.apple.TextEdit", "com.apple.finder", "com.apple.Safari", "com.microsoft.Word", "com.microsoft.Excel"]
func fixtureProcessAgeAllowed(bundle: String, launched: Date, started: Date) -> Bool {
    bundles.contains(bundle) && (bundle == "com.apple.finder" || launched >= started)
}
var probeBoundedOutput = false
let probeOutputLimit = 65536
var probeOutputDroppedRows = 0, probeOutputDroppedBytes = 0
let probeOutputLock = NSRecursiveLock()
func probeOutputFailure(_ row: [String: Any], reason: String, remaining: Int) -> Never {
    probeOutputDroppedRows += 1; probeOutputDroppedBytes += remaining
    try? FileHandle.standardError.write(contentsOf: Data("runtime-probe-host: stdout unavailable: \(reason); final summary follows on stderr\n".utf8))
    if row["record"] as? String == "summary" {
        var failed = row; failed["status"] = 74; failed["reason"] = "stdout-unavailable"
        failed["stdoutDroppedRows"] = probeOutputDroppedRows; failed["stdoutDroppedBytes"] = probeOutputDroppedBytes
        emit(failed, to: .standardError)
    } else { probeSummary.finish("stdout-unavailable", status: 74, output: .standardError) }
    exit(74)
}
func emit(_ row: [String: Any], to output: FileHandle = .standardOutput) {
    probeOutputLock.lock(); defer { probeOutputLock.unlock() }
    guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(70) }
    let line = data + Data([10])
    if probeBoundedOutput && output.fileDescriptor == STDOUT_FILENO {
        // Retain only this row. Do not queue closures or accumulate later rows.
        // FileHandle may retry internally, so use nonblocking POSIX writes and
        // one monotonic deadline, including after partial writes or EINTR.
        guard line.count <= probeOutputLimit else {
            probeOutputDroppedRows += 1; probeOutputDroppedBytes += line.count
            return
        }
        var offset = 0
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while offset < line.count {
            let written = line.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress!.advanced(by: offset), $0.count - offset) }
            if written > 0 { offset += written }
            else if written < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
                probeOutputFailure(row, reason: "write failed (errno \(errno))", remaining: line.count - offset)
            }
            if offset == line.count { break }
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { probeOutputFailure(row, reason: "write deadline expired after 2000 ms", remaining: line.count - offset) }
            var descriptor = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
            _ = Darwin.poll(&descriptor, 1, Int32(min(remaining * 1000, 20).rounded(.up)))
        }
        return
    }
    do { try output.write(contentsOf: line) } catch { exit(0) }
}
func boundProbeOutput() {
    // A stalled reader may delay the current callback for at most two seconds.
    signal(SIGPIPE, SIG_IGN)
    let flags = fcntl(STDOUT_FILENO, F_GETFL)
    guard flags >= 0, fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else { probeFailure("cannot bound stdout writes", status: 74) }
    probeBoundedOutput = true
}

// RT25 receiving witness. The replay and layout branches run before NSApplication.shared.
// No event taps, input posts, app launches, AX mutations or screenshots in this mode.
enum ProbeFixture {
    static let appName = "RT25 Probe Witness", bundleID = "org.sleight.bench.rt25-witness"
    static let width = 640.0, height = 560.0, pageHeight = 240.0, documentHeight = 2400.0
    static let stateMs = 20.0, windowsMs = 50.0
    static let controls: [[String: Any]] = [
        ["id": "probe-button", "kind": "button", "frame": [20, 510, 180, 30]],
        ["id": "plain", "kind": "text-field", "frame": [20, 460, 280, 28]],
        ["id": "secure", "kind": "secure-text-field", "frame": [330, 460, 280, 28]],
        ["id": "scroll", "kind": "scroll-view", "frame": [20, 180, 590, 240],
         "pageHeight": pageHeight, "documentHeight": documentHeight],
        ["id": "drag-item", "kind": "draggable", "frame": [20, 50, 180, 90]],
        ["id": "drop-target", "kind": "drop-target", "frame": [330, 50, 280, 90]],
    ]
    static func frame(_ id: String) -> NSRect {
        let values = controls.first { $0["id"] as? String == id }!["frame"] as! [Int]
        return NSRect(x: values[0], y: values[1], width: values[2], height: values[3])
    }
    static func dragGeometry(size: NSSize, from: NSRect, to: NSRect) -> [String: Any] {
        // Views convert to window-base coordinates before entering here. The
        // full frame includes the title bar; screenshot points start at its top.
        ["dragWidth": size.width, "dragHeight": size.height,
         "dragFromX": from.midX, "dragFromY": size.height - from.midY,
         "dragToX": to.midX, "dragToY": size.height - to.midY]
    }
    static func layout() -> [String: Any] {
        ["schema": "sleight.runtime-probe-fixture/1", "windowsCreated": 0, "inputGenerated": false,
         "app": ["name": appName, "bundle": bundleID],
         "windowSize": [width, height], "coordinateSpace": "content-bottom-left-points",
         "sampling": ["stateMs": stateMs, "windowsMs": windowsMs], "controls": controls,
         "save": ["title": "Save", "keyEquivalent": "s", "modifiers": ["command"], "logs": "performKeyEquivalent"],
         "lifetime": ["defaultMaxSeconds": 1800, "maximumMaxSeconds": 1800, "quitKeyEquivalent": "q"],
         "secureFocusOperation": "focus-secure"]
    }
}

func boxed<T>(_ value: T?) -> Any { if let value = value { return value }; return NSNull() }
func probeNumber(_ value: Any?, integer: Bool = false, minimum: Double = -Double.greatestFiniteMagnitude) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
    let n = number.doubleValue
    return n.isFinite && n >= minimum && (!integer || n.rounded() == n)
}
func probeBool(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
}
func probeNullable(_ value: Any?, _ validate: (Any?) -> Bool) -> Bool { value is NSNull || validate(value) }
func validEventLog(_ row: [String: Any]) -> Bool {
    guard let record = row["record"] as? String else { return false }
    let keys = Set(row.keys)
    if record == "secureEvent" {
        return keys == ["record", "type", "count"] && probeNumber(row["type"], integer: true, minimum: 0) &&
            probeNumber(row["count"], integer: true, minimum: 1)
    }
    guard probeNumber(row["timestamp"], minimum: 0) else { return false }
    switch record {
    case "event":
        guard keys == ["record", "type", "subtype", "timestamp", "receivedAt", "flags", "keyCode", "keyboardType",
                       "sourceStateID", "sourceUnixProcessID", "clickState", "field91", "field92", "windowNumber",
                       "location", "deltaX", "deltaY", "phase", "momentumPhase", "precise"],
              probeNumber(row["type"], integer: true, minimum: 0), probeNumber(row["receivedAt"], minimum: 0),
              probeNumber(row["flags"], integer: true, minimum: 0),
              let location = row["location"] as? [Any], location.count == 2,
              location.allSatisfy({ probeNumber($0) }) else { return false }
        for name in ["subtype", "keyCode", "keyboardType", "sourceStateID", "sourceUnixProcessID", "clickState", "field91", "field92", "windowNumber", "phase", "momentumPhase"] {
            if !probeNullable(row[name], { probeNumber($0, integer: true) }) { return false }
        }
        return ["deltaX", "deltaY"].allSatisfy { probeNullable(row[$0], { probeNumber($0) }) } && probeNullable(row["precise"], probeBool)
    case "state":
        return keys == ["record", "timestamp", "isActive", "keyWindow", "frontmostPID", "hidIdleMs", "secureInput", "secureInputPID", "secureFieldFocused"] &&
            probeBool(row["isActive"]) && probeBool(row["secureInput"]) && probeBool(row["secureFieldFocused"]) &&
            ["keyWindow", "frontmostPID", "secureInputPID"].allSatisfy { probeNullable(row[$0], { probeNumber($0, integer: true, minimum: 0) }) } &&
            probeNullable(row["hidIdleMs"], { probeNumber($0, minimum: 0) })
    case "summary":
        guard keys == ["record", "timestamp", "reason", "status", "elapsedMs", "maxSeconds", "eventCount", "secureEventCount", "stateIntervalsMs", "windowIntervalsMs", "stdoutDroppedRows", "stdoutDroppedBytes"],
              let reason = row["reason"] as? String, reason.utf8.count <= 80,
              ["status", "eventCount", "secureEventCount", "stdoutDroppedRows", "stdoutDroppedBytes"].allSatisfy({ probeNumber(row[$0], integer: true, minimum: 0) }),
              probeNumber(row["elapsedMs"], minimum: 0), probeNumber(row["maxSeconds"], minimum: 0) else { return false }
        return ["stateIntervalsMs", "windowIntervalsMs"].allSatisfy { key in
            guard let intervals = row[key] as? [String: Any], Set(intervals.keys) == ["count", "median", "p95", "max"],
                  probeNumber(intervals["count"], integer: true, minimum: 0) else { return false }
            return ["median", "p95", "max"].allSatisfy { probeNullable(intervals[$0], { probeNumber($0, minimum: 0) }) }
        }
    case "windows":
        return keys == ["record", "timestamp", "onScreenWindows"] && probeNullable(row["onScreenWindows"], { probeNumber($0, integer: true, minimum: 0) })
    case "callback":
        let names: Set<String> = ["performKeyEquivalent", "save", "textChange", "scroll", "dragBegin", "dragEnd", "dragEntered", "drop", "button", "probeStart", "probeStop", "fixtureReady", "secureFocus", "deliveryState", "contextMenuReady", "contextMenuClosed"]
        guard keys == ["record", "timestamp", "name", "target", "details"], let name = row["name"] as? String, names.contains(name),
              let target = row["target"] as? String, target.utf8.count <= 80,
              let details = row["details"] as? [String: Any], details.count <= 16 else { return false }
        return details.allSatisfy { key, value in
            key.utf8.count <= 80 && (probeBool(value) || probeNumber(value) || value is NSNull || ((value as? String).map { $0.utf8.count <= 80 } ?? false))
        }
    default: return false
    }
}
struct ProbeIntervals {
    var previous: Double?
    var gaps: [Double] = []
    mutating func sample(_ now: Double) {
        if let prior = previous { gaps.append(max(0, (now - prior) * 1000)) }
        previous = now
    }
    func row() -> [String: Any] {
        let sorted = gaps.sorted(), count = sorted.count
        let median: Double? = count == 0 ? nil : (sorted[(count - 1) / 2] + sorted[count / 2]) / 2
        let p95: Double? = count == 0 ? nil : sorted[Int(ceil(Double(count) * 0.95)) - 1]
        return ["count": count, "median": boxed(median), "p95": boxed(p95), "max": boxed(sorted.last)]
    }
}
final class ProbeSummary {
    let began = ProcessInfo.processInfo.systemUptime
    var maxSeconds = 1800.0, eventCount = 0, secureEventCount = 0
    var state = ProbeIntervals(), windows = ProbeIntervals()
    var finished = false
    func finish(_ reason: String, status: Int32, output: FileHandle = .standardOutput) {
        probeOutputLock.lock(); defer { probeOutputLock.unlock() }
        guard !finished else { return }; finished = true
        let now = ProcessInfo.processInfo.systemUptime
        emit(["record": "summary", "timestamp": now, "reason": reason, "status": status,
              "elapsedMs": max(0, (now - began) * 1000), "maxSeconds": maxSeconds,
              "eventCount": eventCount, "secureEventCount": secureEventCount,
              "stdoutDroppedRows": probeOutputDroppedRows, "stdoutDroppedBytes": probeOutputDroppedBytes,
              "stateIntervalsMs": state.row(), "windowIntervalsMs": windows.row()], to: output)
    }
}
let probeSummary = ProbeSummary()
// Windowed mode installs its cleanup path. Headless failures use the same final row.
var probeFailureCleanup: ((String, Int32) -> Void)?
func probeFailure(_ reason: String, status: Int32) -> Never {
    // Reasons contain schema field names only, never record values or secure input.
    try? FileHandle.standardError.write(contentsOf: Data(("runtime-probe-host: " + reason + "\n").utf8))
    if let cleanup = probeFailureCleanup { cleanup(reason, status) }
    probeSummary.finish(reason, status: status); exit(status)
}
func eventLog(_ row: [String: Any]) {
    guard validEventLog(row) else {
        for name in ["timestamp", "receivedAt", "deltaX", "deltaY", "hidIdleMs"] {
            if let value = row[name], !(value is NSNull), !probeNumber(value) { probeFailure("invalid log number: \(name)", status: 70) }
        }
        probeFailure("invalid log row: fields or values do not match schema", status: 70)
    }
    if row["record"] as? String == "event" { probeSummary.eventCount += 1 }
    if row["record"] as? String == "secureEvent" { probeSummary.secureEventCount += 1 }
    emit(row)
}

// Bounded NDJSON reader shared by replay and the future sitting's start/stop pipe.
// A partial final line is allowed; invalid records stop before any later record.
func eventLines(_ receive: (Data) -> Void) {
    var pending = Data()
    // availableData returns as soon as the pipe holds bytes. read(upToCount:) waited for 4096 bytes or EOF, so a
    // one-line command reached the witness only when stdin closed (first live owner-away observation, 2026-11-01).
    while case let chunk = FileHandle.standardInput.availableData, !chunk.isEmpty {
        for byte in chunk {
            if byte == 10 { receive(pending); pending.removeAll(keepingCapacity: true) }
            else { guard pending.count < 65536 else { probeFailure("input line exceeds 65536 bytes", status: 65) }; pending.append(byte) }
        }
    }
    if !pending.isEmpty { receive(pending) }
}
if CommandLine.arguments.dropFirst() == ["--help"] {
    let usage = """
    Usage: runtime-probe-host --witness-events [--max-seconds N]
           runtime-probe-host --dry-run | --serve-events | --selftest
    Witness commands on stdin: {"op":"start"}, {"op":"stop"},
      {"op":"focus-secure"}, {"op":"quit"}.
    The default and maximum lifetime is 1800 seconds. Collect stdout and stderr.
    Stdout retains at most 65536 pending bytes and retries a row for up to 2 seconds.
    Oversized rows are dropped; the summary reports stdoutDroppedRows and stdoutDroppedBytes.
    A write deadline exits 74 with a reason and final summary on stderr.
    Secure-input probe: type only a dummy value. State rows still expose keystroke
    timing through hidIdleMs every 20 ms, including typing in other apps.
    focus-secure does not activate the app. The harness or person must bring the
    witness to the front first. After focus-secure, wait for a state row with
    secureFieldFocused true, secureInput true and secureInputPID equal to the witness pid.
    """
    try? FileHandle.standardOutput.write(contentsOf: Data((usage + "\n").utf8)); exit(0)
}
if CommandLine.arguments.dropFirst() == ["--dry-run"] { emit(ProbeFixture.layout()); exit(0) }
if CommandLine.arguments.dropFirst() == ["--dump-drag-geometry"] {
    emit(ProbeFixture.dragGeometry(size: NSSize(width: 640, height: 582),
         from: ProbeFixture.frame("drag-item"), to: ProbeFixture.frame("drop-target"))); exit(0)
}
if CommandLine.arguments.dropFirst() == ["--serve-events"] {
    eventLines { data in
        guard let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { probeFailure("invalid log JSON object", status: 65) }
        guard validEventLog(row) else { probeFailure("invalid replay log row: fields or values do not match schema", status: 65) }
        eventLog(row)
    }
    exit(0)
}

func receivingEvent(_ event: NSEvent) -> [String: Any] {
    let cg = event.cgEvent
    let key = [.keyDown, .keyUp, .flagsChanged].contains(event.type)
    let scroll = event.type == .scrollWheel
    let hasSubtype = [.appKitDefined, .systemDefined, .applicationDefined, .leftMouseDown, .leftMouseUp,
                      .rightMouseDown, .rightMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged,
                      .otherMouseDown, .otherMouseUp, .otherMouseDragged].contains(event.type)
    func field(_ name: CGEventField) -> Any { boxed(cg?.getIntegerValueField(name)) }
    return ["record": "event", "type": event.type.rawValue, "subtype": hasSubtype ? Int(event.subtype.rawValue) as Any : NSNull(),
            "timestamp": event.timestamp, "receivedAt": ProcessInfo.processInfo.systemUptime,
            "flags": event.modifierFlags.rawValue, "keyCode": key ? Int(event.keyCode) as Any : NSNull(),
            "keyboardType": field(.keyboardEventKeyboardType), "sourceStateID": field(.eventSourceStateID),
            "sourceUnixProcessID": field(.eventSourceUnixProcessID), "clickState": field(.mouseEventClickState),
            "field91": field(CGEventField(rawValue: 91)!), "field92": field(CGEventField(rawValue: 92)!),
            "windowNumber": event.windowNumber, "location": [event.locationInWindow.x, event.locationInWindow.y],
            "deltaX": scroll ? event.scrollingDeltaX as Any : NSNull(), "deltaY": scroll ? event.scrollingDeltaY as Any : NSNull(),
            "phase": scroll ? event.phase.rawValue as Any : NSNull(), "momentumPhase": scroll ? event.momentumPhase.rawValue as Any : NSNull(),
            "precise": scroll ? event.hasPreciseScrollingDeltas as Any : NSNull()]
}
func probeCallback(_ name: String, _ target: String, _ details: [String: Any] = [:]) {
    eventLog(["record": "callback", "timestamp": ProcessInfo.processInfo.systemUptime, "name": name, "target": target, "details": details])
}
func probeKeyEquivalent(_ event: NSEvent, target: String, phase: String, handled: Bool? = nil, secure: Bool) {
    guard !secure else { return }
    var details: [String: Any] = ["phase": phase, "keyCode": Int(event.keyCode), "flags": event.modifierFlags.rawValue]
    if let handled = handled { details["handled"] = handled }
    probeCallback("performKeyEquivalent", target, details)
}
func secureInputHolderPID(_ session: [String: Any]?) -> Int32? {
    guard let value = session?["kCGSSessionSecureInputPID"], probeNumber(value, integer: true, minimum: 1),
          let number = value as? NSNumber, number.doubleValue <= Double(Int32.max) else { return nil }
    return number.int32Value
}
final class ProbeActivity {
    private(set) var token: NSObjectProtocol?
    func start() {
        guard token == nil else { return }
        token = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "RT25 probe sampling")
    }
    func stop() {
        if let held = token { ProcessInfo.processInfo.endActivity(held); token = nil }
    }
}
final class ProbeDeadline {
    private var timer: DispatchSourceTimer?
    func arm(seconds: Double, expire: @escaping () -> Void) {
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(deadline: .now() + seconds, leeway: .milliseconds(1))
        source.setEventHandler(handler: expire); timer = source; source.resume()
    }
    func cancel() { timer?.cancel(); timer = nil }
}
func probeMaxSeconds(_ arguments: [String]) -> Double? {
    if arguments.count == 1 { return 1800 }
    guard arguments.count == 3, arguments[1] == "--max-seconds", let seconds = Double(arguments[2]),
          seconds.isFinite, seconds > 0, seconds <= 1800 else { return nil }
    return seconds
}
final class ReceivingLog {
    private let dequeued = NSHashTable<NSEvent>(options: [.weakMemory, .objectPointerPersonality])
    var secureFocused: () -> Bool = { false }
    private var secureCount = 0
    private func record(_ event: NSEvent) {
        if secureFocused() {
            secureCount += 1
            eventLog(["record": "secureEvent", "type": event.type.rawValue, "count": secureCount])
        } else { eventLog(receivingEvent(event)) }
    }
    func receiveFromQueue(_ event: NSEvent) { record(event); dequeued.add(event) }
    func dispatch(_ event: NSEvent) {
        if !dequeued.contains(event) { record(event) }
        dequeued.remove(event)
    }
}
if ["--selftest-events", "--selftest-secure-events"].contains(CommandLine.arguments.dropFirst().first ?? ""), CommandLine.arguments.count == 2 {
    // Construct only. Nothing is posted, dispatched, drawn or registered with NSApplication.
    guard let source = CGEventSource(stateID: .privateState),
          let key = CGEvent(keyboardEventSource: source, virtualKey: 1, keyDown: true),
          let activation = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: 124,
                                             windowNumber: 0, context: nil, subtype: 1, data1: 0, data2: 0),
          let mouseCG = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
                                mouseCursorPosition: CGPoint(x: 12.5, y: 20), mouseButton: .left) else { exit(70) }
    key.flags = [.maskCommand]; key.timestamp = 123456789000
    key.setIntegerValueField(.keyboardEventKeyboardType, value: 40)
    key.setIntegerValueField(CGEventField(rawValue: 91)!, value: 17)
    key.setIntegerValueField(CGEventField(rawValue: 92)!, value: 23)
    key.setIntegerValueField(.eventSourceUnixProcessID, value: 321)
    mouseCG.timestamp = 125000000000
    mouseCG.setIntegerValueField(.mouseEventClickState, value: 2)
    mouseCG.setIntegerValueField(CGEventField(rawValue: 91)!, value: 17)
    mouseCG.setIntegerValueField(CGEventField(rawValue: 92)!, value: 23)
    guard let keyEvent = NSEvent(cgEvent: key), let mouse = NSEvent(cgEvent: mouseCG) else { exit(70) }
    let log = ReceivingLog()
    if CommandLine.arguments[1] == "--selftest-secure-events" {
        log.secureFocused = { true }
        log.receiveFromQueue(keyEvent); log.dispatch(keyEvent)
        log.dispatch(activation); log.dispatch(mouse)
        for target in ["menu:Main", "window"] {
            probeKeyEquivalent(keyEvent, target: target, phase: "begin", secure: true)
            probeKeyEquivalent(keyEvent, target: target, phase: "end", handled: true, secure: true)
        }
        probeSummary.finish("selftest-secure-events", status: 0); exit(0)
    }
    log.receiveFromQueue(keyEvent); log.dispatch(keyEvent)
    log.receiveFromQueue(activation) // A tracking loop can consume an event without sendEvent.
    log.dispatch(mouse) // Direct dispatch is also recorded.
    probeCallback("fixtureReady", "selftest", ["originalKeyStateID": key.getIntegerValueField(.eventSourceStateID),
        "originalKeyPID": key.getIntegerValueField(.eventSourceUnixProcessID), "originalKey91": key.getIntegerValueField(CGEventField(rawValue: 91)!),
        "originalMouse91": mouseCG.getIntegerValueField(CGEventField(rawValue: 91)!), "originalMouse92": mouseCG.getIntegerValueField(CGEventField(rawValue: 92)!)])
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--selftest-lifecycle"] {
    let activity = ProbeActivity(); activity.start(); activity.start()
    let held = activity.token != nil; activity.stop(); activity.stop()
    guard held, activity.token == nil,
          probeMaxSeconds(["--witness-events"]) == 1800,
          probeMaxSeconds(["--witness-events", "--max-seconds", "1800"]) == 1800,
          secureInputHolderPID(["kCGSSessionSecureInputPID": 321]) == 321,
          secureInputHolderPID(nil) == nil,
          [0, -1, 1.5, Double.infinity, Double(Int32.max) + 1].allSatisfy({ secureInputHolderPID(["kCGSSessionSecureInputPID": $0]) == nil }),
          secureInputHolderPID(["kCGSSessionSecureInputPID": true]) == nil,
          secureInputHolderPID(["kCGSSessionSecureInputPID": "321"]) == nil else { exit(70) }
    for now in [1.0, 1.02, 1.04, 1.06, 1.26] { probeSummary.state.sample(now) }
    probeSummary.state.previous = nil // A paused probe must not count the pause as a stretched sample.
    for now in [10.0, 10.02] { probeSummary.state.sample(now) }
    for now in [1.0, 1.05, 1.1] { probeSummary.windows.sample(now) }
    probeCallback("fixtureReady", "selftest-lifecycle", ["activityHeld": held, "activityReleased": activity.token == nil,
        "secureInputPID": boxed(secureInputHolderPID(["kCGSSessionSecureInputPID": 321])), "windowsCreated": 0, "inputGenerated": false])
    probeSummary.finish("selftest-lifecycle", status: 0); probeSummary.finish("duplicate", status: 0); exit(0)
}
if CommandLine.arguments.dropFirst() == ["--selftest-invalid-log"] {
    var row = receivingEvent(NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: 1,
        windowNumber: 0, context: nil, subtype: 1, data1: 0, data2: 0)!)
    row["deltaX"] = Double.nan; eventLog(row); exit(70)
}
@MainActor enum ProbeFocus {
    static weak var secureField: NSSecureTextField?
}
@MainActor func probeSecureFieldFocused() -> Bool {
    guard let field = ProbeFocus.secureField, let window = field.window, let responder = window.firstResponder else { return false }
    return responder === field || (field.currentEditor().map { responder === $0 } ?? false)
}
@MainActor final class ProbeApplication: NSApplication {
    private let receipts = ReceivingLog()
    override func nextEvent(matching mask: NSEvent.EventTypeMask, until expiration: Date?, inMode mode: RunLoop.Mode, dequeue flag: Bool) -> NSEvent? {
        let event = super.nextEvent(matching: mask, until: expiration, inMode: mode, dequeue: flag)
        receipts.secureFocused = { MainActor.assumeIsolated { probeSecureFieldFocused() } }
        if flag, let event = event { receipts.receiveFromQueue(event) }
        return event
    }
    override func sendEvent(_ event: NSEvent) {
        receipts.secureFocused = { MainActor.assumeIsolated { probeSecureFieldFocused() } }
        receipts.dispatch(event)
        super.sendEvent(event)
    }
}
@MainActor final class ProbeMenu: NSMenu {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let secure = probeSecureFieldFocused()
        probeKeyEquivalent(event, target: "menu:\(title)", phase: "begin", secure: secure)
        let handled = super.performKeyEquivalent(with: event)
        probeKeyEquivalent(event, target: "menu:\(title)", phase: "end", handled: handled, secure: secure || probeSecureFieldFocused())
        return handled
    }
}
@MainActor final class ProbeWindow: NSWindow {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let secure = probeSecureFieldFocused()
        probeKeyEquivalent(event, target: "window", phase: "begin", secure: secure)
        let handled = super.performKeyEquivalent(with: event)
        probeKeyEquivalent(event, target: "window", phase: "end", handled: handled, secure: secure || probeSecureFieldFocused())
        return handled
    }
}
@MainActor final class ProbeDragItem: NSView, NSDraggingSource {
    static let token = "RT25-owned-item"
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemBlue.setFill(); bounds.fill()
        ("Drag RT25 item" as NSString).draw(at: NSPoint(x: 12, y: 35), withAttributes: [.foregroundColor: NSColor.white])
    }
    override func mouseDown(with event: NSEvent) {}
    override func mouseDragged(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: Self.token as NSString)
        item.setDraggingFrame(bounds, contents: NSImage(size: bounds.size, flipped: false) { rect in
            NSColor.systemBlue.setFill(); rect.fill(); return true
        })
        probeCallback("dragBegin", "drag-item", ["item": Self.token])
        beginDraggingSession(with: [item], event: event, source: self)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        probeCallback("dragEnd", "drag-item", ["operation": operation.rawValue, "x": screenPoint.x, "y": screenPoint.y])
    }
}
@MainActor final class ProbeDropTarget: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemGreen.setFill(); bounds.fill()
        ("Drop RT25 item here" as NSString).draw(at: NSPoint(x: 12, y: 35), withAttributes: [.foregroundColor: NSColor.white])
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let accepted = sender.draggingSource as? ProbeDragItem != nil && sender.draggingPasteboard.string(forType: .string) == ProbeDragItem.token
        probeCallback("dragEntered", "drop-target", ["accepted": accepted])
        return accepted ? .copy : []
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        sender.draggingSource as? ProbeDragItem != nil && sender.draggingPasteboard.string(forType: .string) == ProbeDragItem.token
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let accepted = prepareForDragOperation(sender), point = convert(sender.draggingLocation, from: nil)
        probeCallback("drop", "drop-target", ["accepted": accepted, "item": accepted ? ProbeDragItem.token : "refused", "x": point.x, "y": point.y])
        return accepted
    }
}
@MainActor final class ProbeDocumentView: NSView {
    override var isFlipped: Bool { true }
}
@MainActor final class EventWitness: NSObject, NSTextFieldDelegate, NSApplicationDelegate, NSWindowDelegate {
    var window: ProbeWindow!
    var stateTimer: Timer?, windowTimer: Timer?, parentTimer: Timer?
    var scrollObserver: NSObjectProtocol?
    var saves = 0
    var measurementMenu: NSMenu?
    var sittingSecureInput = false
    let activity = ProbeActivity(), deadline = ProbeDeadline()
    var closing = false
    func build() {
        window = ProbeWindow(contentRect: NSRect(x: 100, y: 100, width: ProbeFixture.width, height: ProbeFixture.height),
                             styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = ProbeFixture.appName; window.isReleasedWhenClosed = false
        window.delegate = self
        let content = window.contentView!
        let button = NSButton(title: "Probe button", target: self, action: #selector(buttonPressed))
        button.frame = ProbeFixture.frame("probe-button"); button.setAccessibilityIdentifier("probe-button"); content.addSubview(button)
        for (id, field) in [("plain", NSTextField()), ("secure", NSSecureTextField())] {
            field.frame = ProbeFixture.frame(id); field.placeholderString = id == "plain" ? "Plain text" : "Secure text"
            field.identifier = NSUserInterfaceItemIdentifier(id); field.setAccessibilityIdentifier(id)
            field.delegate = self; content.addSubview(field)
            if let secure = field as? NSSecureTextField { ProbeFocus.secureField = secure }
        }
        let scroll = NSScrollView(frame: ProbeFixture.frame("scroll"))
        scroll.setAccessibilityIdentifier("scroll"); scroll.hasVerticalScroller = true
        // No border/scroller inset in the vertical axis: the content viewport is exactly one known page.
        scroll.borderType = .noBorder; scroll.scrollerStyle = .overlay
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
        let document = ProbeDocumentView(frame: NSRect(x: 0, y: 0, width: 590, height: ProbeFixture.documentHeight))
        for n in 0..<10 {
            let label = NSTextField(labelWithString: "RT25 page \(n + 1) of 10")
            label.frame = NSRect(x: 16, y: Double(n) * ProbeFixture.pageHeight + 100, width: 400, height: 24)
            document.addSubview(label)
        }
        scroll.documentView = document; content.addSubview(scroll)
        scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView)
        scroll.contentView.postsBoundsChangedNotifications = true
        scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { _ in
            MainActor.assumeIsolated {
                let p = scroll.contentView.bounds.origin
                probeCallback("scroll", "scroll", ["x": p.x, "y": p.y, "pageHeight": scroll.contentView.bounds.height])
            }
        }
        let drag = ProbeDragItem(frame: ProbeFixture.frame("drag-item"))
        drag.setAccessibilityElement(true); drag.setAccessibilityLabel("Drag RT25 item"); drag.setAccessibilityIdentifier("drag-item"); content.addSubview(drag)
        let drop = ProbeDropTarget(frame: ProbeFixture.frame("drop-target"))
        drop.setAccessibilityElement(true); drop.setAccessibilityLabel("Drop RT25 item here")
        drop.setAccessibilityIdentifier("drop-target"); drop.registerForDraggedTypes([.string]); content.addSubview(drop)
        let menu = ProbeMenu(title: "Main"), file = ProbeMenu(title: "File")
        let appMenu = ProbeMenu(title: "Witness"), appItem = NSMenuItem(title: "Witness", action: nil, keyEquivalent: "")
        appItem.submenu = appMenu; menu.addItem(appItem)
        let quit = NSMenuItem(title: "Quit Probe Witness", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.keyEquivalentModifierMask = [.command]; appMenu.addItem(quit)
        let fileItem = NSMenuItem(title: "File", action: nil, keyEquivalent: ""); fileItem.submenu = file; menu.addItem(fileItem)
        let save = NSMenuItem(title: "Save", action: #selector(savePressed), keyEquivalent: "s")
        save.keyEquivalentModifierMask = [.command]; save.target = self; file.addItem(save); NSApp.mainMenu = menu
        window.orderFront(nil)
        probeCallback("fixtureReady", "fixture", ["windowNumber": window.windowNumber, "pid": getpid()])
    }
    @objc func buttonPressed() { probeCallback("button", "probe-button") }
    func deliveryState() {
        // Full screen alone does not prove Split View. No Space or tiling mutation.
        var details: [String: Any] = ["onActiveSpace": window.isOnActiveSpace,
            "visible": window.isVisible, "miniaturized": window.isMiniaturized,
            "fullScreen": window.styleMask.contains(.fullScreen), "windowNumber": window.windowNumber]
        if let content = window.contentView {
            let sources = content.subviews.filter { $0 is ProbeDragItem }, targets = content.subviews.filter { $0 is ProbeDropTarget }
            if sources.count == 1, targets.count == 1 {
                details.merge(ProbeFixture.dragGeometry(size: window.frame.size,
                    from: sources[0].convert(sources[0].bounds, to: nil), to: targets[0].convert(targets[0].bounds, to: nil))) { _, value in value }
            }
        }
        probeCallback("deliveryState", "fixture", details)
    }
    func openMeasurementMenu() {
        guard measurementMenu == nil, window.isOnActiveSpace, !window.isMiniaturized else {
            probeCallback("contextMenuClosed", "fixture", ["opened": false]); return
        }
        let menu = NSMenu(title: "SIT1-context"); menu.autoenablesItems = false
        let item = NSMenuItem(title: "Owned measurement item", action: nil, keyEquivalent: "")
        item.isEnabled = false; menu.addItem(item); measurementMenu = menu
        let ready = Timer(timeInterval: 0.08, repeats: false) { _ in
            MainActor.assumeIsolated { probeCallback("contextMenuReady", "fixture") }
        }
        let close = Timer(timeInterval: 2, repeats: false) { _ in
            MainActor.assumeIsolated { menu.cancelTrackingWithoutAnimation() }
        }
        for timer in [ready, close] {
            RunLoop.main.add(timer, forMode: .common); RunLoop.main.add(timer, forMode: .eventTracking)
        }
        // The owned fixture opens and dismisses its own menu. No click, key,
        // AX action, activation or pointer motion is used to arrange it.
        let selected = menu.popUp(positioning: nil, at: NSPoint(x: 250, y: 150), in: window.contentView)
        ready.invalidate(); close.invalidate(); measurementMenu = nil
        probeCallback("contextMenuClosed", "fixture", ["selected": selected])
    }
    @objc func savePressed() { saves += 1; probeCallback("save", "save", ["count": saves]) }
    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField else { return }
        guard !(field is NSSecureTextField) else { return }
        // The secure value is never copied into the log. Plain text is counted too.
        probeCallback("textChange", field.identifier?.rawValue ?? "unknown", ["length": field.stringValue.utf16.count])
    }
    func sampleState(recordInterval: Bool = true) {
        let now = ProcessInfo.processInfo.systemUptime
        if recordInterval { probeSummary.state.sample(now) }
        let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!) * 1000
        eventLog(["record": "state", "timestamp": now, "isActive": NSApp.isActive,
                  "keyWindow": boxed(NSApp.keyWindow?.windowNumber), "frontmostPID": boxed(NSWorkspace.shared.frontmostApplication?.processIdentifier),
                  "hidIdleMs": idle.isFinite && idle >= 0 ? idle as Any : NSNull(), "secureInput": IsSecureEventInputEnabled(),
                  "secureInputPID": boxed(secureInputHolderPID(CGSessionCopyCurrentDictionary() as? [String: Any])),
                  "secureFieldFocused": probeSecureFieldFocused()])
    }
    func sampleWindows() {
        let now = ProcessInfo.processInfo.systemUptime; probeSummary.windows.sample(now)
        let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        let count = entries.map { $0.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == getpid() }.count }
        eventLog(["record": "windows", "timestamp": now, "onScreenWindows": boxed(count)])
    }
    func start() {
        guard stateTimer == nil else { return }
        activity.start()
        probeSummary.state.previous = nil; probeSummary.windows.previous = nil
        probeCallback("probeStart", "fixture"); sampleState(); sampleWindows()
        let state = Timer(timeInterval: ProbeFixture.stateMs / 1000, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.sampleState() } }
        let windows = Timer(timeInterval: ProbeFixture.windowsMs / 1000, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.sampleWindows() } }
        stateTimer = state; windowTimer = windows
        state.tolerance = 0; windows.tolerance = 0
        RunLoop.main.add(state, forMode: .common); RunLoop.main.add(windows, forMode: .common)
    }
    func stop() {
        let running = stateTimer != nil
        stateTimer?.invalidate(); windowTimer?.invalidate(); stateTimer = nil; windowTimer = nil
        activity.stop(); probeSummary.state.previous = nil; probeSummary.windows.previous = nil
        if running { probeCallback("probeStop", "fixture", ["stateMaxGapMs": boxed(probeSummary.state.gaps.max()), "windowMaxGapMs": boxed(probeSummary.windows.gaps.max())]) }
    }
    func focusSecure() {
        let accepted = ProbeFocus.secureField.map { window.makeFirstResponder($0) } ?? false
        probeCallback("secureFocus", "secure", ["accepted": accepted, "secureFieldFocused": probeSecureFieldFocused(), "isActive": NSApp.isActive])
        sampleState(recordInterval: stateTimer != nil)
    }
    func finish(_ reason: String, status: Int32 = 0) -> Never {
        if closing { exit(status) }; closing = true
        stop(); parentTimer?.invalidate(); deadline.cancel()
        if sittingSecureInput { DisableSecureEventInput(); sittingSecureInput = false }
        if let observer = scrollObserver { NotificationCenter.default.removeObserver(observer) }
        probeSummary.finish(reason, status: status)
        window?.delegate = nil
        window?.close()
        exit(status)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { finish("cmd-q") }
    func windowShouldClose(_ sender: NSWindow) -> Bool { finish("window-close") }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
if CommandLine.arguments.dropFirst().first == "--selftest-deadline" {
    guard let seconds = probeMaxSeconds(Array(CommandLine.arguments.dropFirst())) else { exit(64) }
    probeSummary.maxSeconds = seconds
    MainActor.assumeIsolated {
        // Exercise the real cleanup path without build(), NSApplication or a window.
        let receiver = EventWitness(); receiver.activity.start()
        receiver.deadline.arm(seconds: seconds) { MainActor.assumeIsolated { receiver.finish("max-seconds") } }
    }
    dispatchMain()
}
if CommandLine.arguments.dropFirst() == ["--selftest-output-stall"] {
    boundProbeOutput()
    for count in 0..<10000 { probeCallback("probeStart", "selftest-output-stall", ["count": count]) }
    probeSummary.finish("selftest-output-stall", status: 0); exit(0)
}
if CommandLine.arguments.dropFirst() == ["--selftest-output-cap"] {
    boundProbeOutput()
    emit(["padding": String(repeating: "x", count: probeOutputLimit)])
    probeCallback("probeStart", "selftest-output-cap")
    probeSummary.finish("selftest-output-cap", status: 0); exit(0)
}
if CommandLine.arguments.dropFirst() == ["--selftest-output-partial"] {
    boundProbeOutput()
    // Large rows exercise the offset when a nonblocking write is short.
    for count in 0..<16 { emit(["count": count, "padding": String(repeating: "x", count: 60000)]) }
    probeSummary.finish("selftest-output-partial", status: 0); exit(0)
}
if CommandLine.arguments.dropFirst().first == "--selftest-shutdown" {
    guard CommandLine.arguments.count == 3,
          ["cmd-q", "window-close", "stdin-quit", "stdin-eof", "parent-exit"].contains(CommandLine.arguments[2]) else { exit(64) }
    MainActor.assumeIsolated {
        let receiver = EventWitness(); receiver.activity.start()
        receiver.finish(CommandLine.arguments[2])
    }
}
if CommandLine.arguments.dropFirst().first == "--witness-events" {
    guard let seconds = probeMaxSeconds(Array(CommandLine.arguments.dropFirst())) else {
        try? FileHandle.standardError.write(contentsOf: Data("--max-seconds must be finite, greater than 0 and at most 1800\n".utf8)); exit(64)
    }
    probeSummary.maxSeconds = seconds
    boundProbeOutput()
    let parentPID = getppid()
    let application = ProbeApplication.shared
    application.setActivationPolicy(.regular)
    let receiver = MainActor.assumeIsolated { EventWitness() }
    MainActor.assumeIsolated {
        application.delegate = receiver
        probeFailureCleanup = { reason, status in
            if Thread.isMainThread { MainActor.assumeIsolated { receiver.finish(reason, status: status) } }
            else { DispatchQueue.main.sync { receiver.finish(reason, status: status) } }
        }
        receiver.deadline.arm(seconds: seconds) { MainActor.assumeIsolated { receiver.finish("max-seconds") } }
        receiver.build()
        let parentTimer = Timer(timeInterval: 1, repeats: true) { _ in
            MainActor.assumeIsolated { if getppid() != parentPID { receiver.finish("parent-exit") } }
        }
        receiver.parentTimer = parentTimer; RunLoop.main.add(parentTimer, forMode: .common)
    }
    DispatchQueue.global().async {
        eventLines { data in
            guard let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any], Set(row.keys) == ["op"],
                  let op = row["op"] as? String, ["start", "stop", "quit", "focus-secure", "secure-on", "secure-off", "delivery-state", "context-menu-open", "order-back"].contains(op) else { probeFailure("invalid witness operation", status: 65) }
            DispatchQueue.main.async {
                switch op {
                case "start": receiver.start()
                case "stop": receiver.stop()
                case "focus-secure": receiver.focusSecure()
                case "order-back": receiver.window.orderBack(nil)
                case "delivery-state": receiver.deliveryState()
                case "context-menu-open": receiver.openMeasurementMenu()
                case "secure-on":
                    if !receiver.sittingSecureInput {
                        guard EnableSecureEventInput() == noErr else { receiver.finish("secure-input-unavailable", status: 70) }
                        receiver.sittingSecureInput = true
                    }
                    receiver.focusSecure()
                case "secure-off":
                    if receiver.sittingSecureInput { DisableSecureEventInput(); receiver.sittingSecureInput = false }
                    receiver.sampleState(recordInterval: receiver.stateTimer != nil)
                default: receiver.finish("stdin-quit")
                }
            }
        }
        DispatchQueue.main.async { receiver.finish("stdin-eof") }
    }
    application.run(); MainActor.assumeIsolated { receiver.finish("run-returned") }
}

func validRequest(_ row: [String: Any]) -> Bool {
    guard let op = row["op"] as? String else { return false }
    let keys = Set(row.keys)
    switch op {
    case "inventory", "uncover", "before-new", "retain-new", "close-new": return keys == ["op"]
    case "bind": return keys == ["op", "bundle"] && bundles.contains(row["bundle"] as? String ?? "")
    case "sample", "cover":
        guard keys == ["op", "marker"], let marker = row["marker"] as? String else { return false }
        return marker.utf8.count <= 80 && marker.rangeOfCharacter(from: .controlCharacters) == nil
    case "image":
        guard keys == ["op", "base64", "marker"], let encoded = row["base64"] as? String,
              let marker = row["marker"] as? String else { return false }
        return !encoded.isEmpty && encoded.utf8.count <= 24 * 1024 * 1024 && !marker.isEmpty && marker.utf8.count <= 80
    default: return false
    }
}
if CommandLine.arguments.dropFirst() == ["--validate"] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let row = data.count <= 65536 ? (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) : nil
    let valid = row.map(validRequest) ?? false
    emit(["valid": valid, "windowsCreated": 0]); exit(valid ? 0 : 65)
}
if CommandLine.arguments.dropFirst() == ["--selftest"] {
    let now = Date(), old = Date.distantPast
    guard fixtureProcessAgeAllowed(bundle: "com.apple.finder", launched: old, started: now),
          !fixtureProcessAgeAllowed(bundle: "com.apple.TextEdit", launched: old, started: now),
          fixtureProcessAgeAllowed(bundle: "com.apple.TextEdit", launched: now, started: now),
          !fixtureProcessAgeAllowed(bundle: "com.apple.Terminal", launched: now, started: now) else { exit(70) }
    emit(["windowsCreated": 0, "apps": bundles.count, "inputGenerated": false]); exit(0)
}
guard CommandLine.arguments.dropFirst() == ["--serve"] else { exit(64) }
let started = Date(), parent = getppid()
@MainActor final class Witness {
    var cover: NSPanel?
    var pinned: (pid: pid_t, bundle: String, started: Date)?
    var priorWindows: [AXUIElement] = [], createdWindow: AXUIElement?
    var walkFailed = false
    func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success ? value : nil
    }
    func children(_ e: AXUIElement, _ name: String = "AXChildren") -> [AXUIElement] { attr(e, name) as? [AXUIElement] ?? [] }
    func frame(_ e: AXUIElement) -> CGRect? {
        guard let position = attr(e, "AXPosition"), let size = attr(e, "AXSize"), CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s) else { return nil }
        return CGRect(origin: p, size: s)
    }
    func rect(_ r: CGRect) -> [Double] { [Double(r.minX), Double(r.minY), Double(r.width), Double(r.height)] }
    func live() -> NSRunningApplication? {
        guard let p = pinned, let app = NSRunningApplication(processIdentifier: p.pid), !app.isTerminated,
              app.bundleIdentifier == p.bundle, app.launchDate == p.started else { return nil }
        return app
    }
    func windows(_ app: NSRunningApplication) -> [AXUIElement] {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ax, 0.3)
        return children(ax, "AXWindows")
    }
    func walk(_ root: AXUIElement) -> [AXUIElement] {
        var result: [AXUIElement] = [], queue = [root]
        let deadline = Date().addingTimeInterval(1)
        while !queue.isEmpty && result.count < 3000 && Date() < deadline { let e = queue.removeLast(); result.append(e); queue += children(e) }
        if !queue.isEmpty { walkFailed = true; return [] }
        return result
    }
    func receive(_ row: [String: Any]) -> [String: Any] {
        walkFailed = false
        guard validRequest(row), let op = row["op"] as? String else { return ["error": "INVALID_REQUEST"] }
        switch op {
        case "inventory":
            guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { return ["error": "RUNTIME_GRANTS_REQUIRED"] }
            return ["apps": NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && bundles.contains($0.bundleIdentifier ?? "") }
                .map { ["bundle": $0.bundleIdentifier!, "pid": $0.processIdentifier] as [String: Any] }]
        case "bind":
            guard let bundle = row["bundle"] as? String, bundles.contains(bundle) else { return ["error": "INVALID_BUNDLE"] }
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }
            // Finder stays running. The release fixture owns a separate retained
            // window; sample/cover still require its unique fixture marker.
            guard apps.count == 1, let date = apps[0].launchDate,
                  fixtureProcessAgeAllowed(bundle: bundle, launched: date, started: started) else { return ["error": "FIXTURE_IDENTITY"] }
            pinned = (apps[0].processIdentifier, bundle, date)
            priorWindows = []; createdWindow = nil
            return ["pid": apps[0].processIdentifier]
        case "before-new":
            guard let app = live(), createdWindow == nil else { return ["error": "IDENTITY_CHANGED"] }
            priorWindows = windows(app); return ["ok": true]
        case "retain-new":
            guard let app = live(), !priorWindows.isEmpty else { return ["error": "FIXTURE_IDENTITY"] }
            let list = windows(app).filter { item in !priorWindows.contains { CFEqual(item, $0) } }
            guard list.count == 1 else { return ["error": "NEW_WINDOW_UNCONFIRMED"] }
            createdWindow = list[0]; return ["ok": true]
        case "close-new":
            guard let app = live(), let owned = createdWindow else { return ["error": "FIXTURE_IDENTITY"] }
            let deadline = Date().addingTimeInterval(10)
            var closeSent = false
            while Date() < deadline {
                if FileManager.default.fileExists(atPath: "/tmp/sleight-hold") { return ["error": "HOLD"] }
                guard live() != nil else { return ["error": "IDENTITY_CHANGED"] }
                if !windows(app).contains(where: { CFEqual($0, owned) }) { createdWindow = nil; return ["confirmed": true] }
                let sheets = children(owned, "AXSheets") + children(owned).filter { attr($0, "AXRole") as? String == "AXSheet" }
                // Only this retained new window's attached sheet may receive Don't Save.
                let unique = sheets.reduce(into: [AXUIElement]()) { out, item in if !out.contains(where: { CFEqual($0, item) }) { out.append(item) } }
                if unique.count == 1 {
                    let buttons = walk(unique[0]).filter { attr($0, "AXRole") as? String == "AXButton" }
                    let allowed = ["Don't Save", "Don’t Save", "Save", "Cancel", ""]
                    let discard = buttons.filter { ["Don't Save", "Don’t Save"].contains(attr($0, "AXTitle") as? String ?? "") }
                    guard discard.count == 1, buttons.allSatisfy({ allowed.contains(attr($0, "AXTitle") as? String ?? "") }),
                          AXUIElementPerformAction(discard[0], "AXPress" as CFString) == .success else { return ["error": "DISCARD_UNCONFIRMED"] }
                } else if unique.isEmpty && !closeSent {
                    guard let raw = attr(owned, "AXCloseButton"), CFGetTypeID(raw) == AXUIElementGetTypeID(),
                          AXUIElementPerformAction(raw as! AXUIElement, "AXPress" as CFString) == .success else { return ["error": "CLOSE_UNCONFIRMED"] }
                    closeSent = true
                } else if unique.count > 1 { return ["error": "DISCARD_UNCONFIRMED"] }
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }
            return ["error": "CLOSE_UNCONFIRMED"]
        case "sample", "cover":
            guard let app = live() else {
                if let pin = pinned, NSRunningApplication.runningApplications(withBundleIdentifier: pin.bundle).isEmpty {
                    return ["gone": true, "background": true, "idleMs": CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!) * 1000]
                }
                return ["error": "IDENTITY_CHANGED"]
            }
            let list = windows(app)
            let marker = row["marker"] as? String ?? ""
            if pinned?.bundle == "com.apple.finder" && !marker.hasPrefix("RT13-") { return ["error": "FIXTURE_IDENTITY"] }
            let matches = list.filter { item in createdWindow.map { CFEqual(item, $0) } ?? (marker.isEmpty || (attr(item, "AXTitle") as? String ?? "").contains(marker)) }
            let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!) * 1000
            let background = NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier
            if matches.isEmpty { return ["gone": true, "background": background, "idleMs": idle] }
            guard matches.count == 1, let f = frame(matches[0]) else { return ["error": "FIXTURE_WINDOW_AMBIGUOUS"] }
            let w = matches[0], nodes = walk(w)
            if walkFailed { return ["error": "WITNESS_AX_BUDGET"] }
            let visible = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let targetVisible = visible.contains { entry in
                guard entry[kCGWindowOwnerPID as String] as? Int32 == app.processIdentifier,
                      let raw = entry[kCGWindowBounds as String] as? [String: Any], let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return false }
                return abs(bounds.minX - f.minX) < 2 && abs(bounds.minY - f.minY) < 2 && abs(bounds.width - f.width) < 2 && abs(bounds.height - f.height) < 2
            }
            guard targetVisible else { return ["error": "FIXTURE_OFFSCREEN"] }
            let close = attr(w, "AXCloseButton").flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? frame($0 as! AXUIElement) : nil }
            let editable = nodes.filter { ["AXTextArea", "AXTextField"].contains(attr($0, "AXRole") as? String ?? "") &&
                !["AXSecureTextField"].contains(attr($0, "AXSubrole") as? String ?? "") }
            let body = editable.filter { (attr($0, "AXValue") as? String ?? "").contains(marker) }
            let screenTop = CGDisplayBounds(CGMainDisplayID()).maxY
            let appKitFrame = CGRect(x: f.minX, y: screenTop - f.maxY, width: f.width, height: f.height)
            guard let screen = NSScreen.screens.first(where: { $0.frame.contains(appKitFrame) }) else { return ["error": "FIXTURE_SPANS_DISPLAYS"] }
            let scale = screen.backingScaleFactor
            if op == "cover" {
                if cover == nil {
                    cover = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                    cover!.level = .floating; cover!.ignoresMouseEvents = true; cover!.backgroundColor = .systemGray
                    cover!.collectionBehavior = [.transient, .ignoresCycle, .stationary]
                }
                cover!.setFrame(appKitFrame, display: true)
                cover!.orderFrontRegardless()
            }
            var result: [String: Any] = ["gone": false, "background": background, "idleMs": idle, "frame": rect(f), "scale": scale,
                "sheet": !children(w, "AXSheets").isEmpty || nodes.contains { attr($0, "AXRole") as? String == "AXSheet" },
                "covered": cover?.isVisible == true, "pid": app.processIdentifier]
            if let c = close { result["closePoint"] = [(c.midX - f.minX) * scale, (c.midY - f.minY) * scale] }
            if body.count == 1, let b = frame(body[0]) { result["bodyPoint"] = [(b.midX - f.minX) * scale, (b.midY - f.minY) * scale] }
            if body.count == 1, let value = attr(body[0], "AXSelectedTextRange"), CFGetTypeID(value) == AXValueGetTypeID() {
                var range = CFRange()
                if AXValueGetValue(value as! AXValue, .cfRange, &range) { result["caretRange"] = [range.location, range.length] }
            }
            let menus = walk(AXUIElementCreateApplication(app.processIdentifier)).filter { attr($0, "AXRole") as? String == "AXMenu" }
            let visibility = menus.map { attr($0, "AXVisible") as? Bool }
            if visibility.allSatisfy({ $0 != nil }) { result["menuOpen"] = visibility.contains { $0 == true } }
            if walkFailed { return ["error": "WITNESS_AX_BUDGET"] }
            return result
        case "uncover": cover?.orderOut(nil); return ["ok": true]
        case "image":
            guard let encoded = row["base64"] as? String, encoded.utf8.count <= 24 * 1024 * 1024,
                  let data = Data(base64Encoded: encoded), let image = NSImage(data: data),
                  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
                  let marker = row["marker"] as? String, !marker.isEmpty else { return ["error": "IMAGE_INVALID"] }
            let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
            do { try VNImageRequestHandler(cgImage: cg).perform([request]) } catch { return ["error": "IMAGE_OCR_FAILED"] }
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            return ["matches": text.contains(marker), "width": cg.width, "height": cg.height]
        default: return ["error": "UNKNOWN_OPERATION"]
        }
    }
}
let witness = MainActor.assumeIsolated { Witness() }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.global().async {
    while let line = readLine() {
        guard line.utf8.count <= 32 * 1024 * 1024, let data = line.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { exit(65) }
        DispatchQueue.main.async { emit(witness.receive(row)) }
    }
    DispatchQueue.main.async { witness.cover?.close(); exit(0) }
}
let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in if getppid() != parent { DispatchQueue.main.async { witness.cover?.close(); exit(0) } } }
app.run()
