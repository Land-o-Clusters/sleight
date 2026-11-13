// Linked only into the private benchmark build. A timer observes the ordinary HandHost delegate.
// The owned person stand-in supplies window identity only. Input and placement use the production path.
import AppKit
import Foundation
import QuartzCore

var stageBenchInstalled: ((PerchHost, PerchPlan, PerchMetrics, SpriteStagePose?, Double) -> Void)?
var stageBenchPlanned: ((Int, PerchPlan, PerchMetrics) -> Void)?
// CAR3's production pointer path references these benchmark hooks. Observation never overrides or injects input.
let stageBenchPointerPosition: CGPoint? = nil
var stageBenchPersonWindow: StageWindowKey?
var check4PersonPanel: NSPanel?
// Five-minute task evidence needs room for late frames. Production keeps its ordinary 2 MiB cap.
func check4MakeTrace() -> StageTrace { StageTrace(limit: 16 * 1024 * 1024) }
func check4PanelRect(_ frame: CGRect, primaryTop: CGFloat) -> [Double] {
    [Double(frame.minX), Double(primaryTop - frame.maxY), Double(frame.width), Double(frame.height)]
}
func check4PreparePerson() {
    guard check4PersonPanel == nil, let screen = NSScreen.screens.first else { return }
    let visible = screen.visibleFrame
    let panel = NSPanel(contentRect: CGRect(x: visible.minX + 20, y: visible.minY + 20, width: 220, height: 122),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false; panel.hasShadow = false
    panel.level = .normal; panel.backgroundColor = .white; panel.title = "Person stand-in"
    panel.setAccessibilityElement(false); panel.ignoresMouseEvents = true
    panel.orderFrontRegardless()
    check4PersonPanel = panel
    stageBenchPersonWindow = StageWindowKey(pid: getpid(), window: UInt32(panel.windowNumber))
}
let stageBenchPointerObserved: (([StageEffect], Int?, CGRect?, Double) -> Void)? = nil
func stageBenchMain(_ args: [String]) {
    guard args == ["--status-selftest"] else { exit(64) }
    let host = HandHost(), key = StageWindowKey(pid: 42, window: 9)
    host.perch.stage.wideWindows.insert(key)
    host.perch.stage.wideObservedFrames[key] = CGRect(x: 100, y: 50, width: 20, height: 30)
    host.perch.stage.unmappableDrags.insert(key)
    host.perch.stage.hideReasonCounts["call"] = 2
    host.perch.stage.maxWindowBoundsDifferencePt = 0.5
    var row = host.perch.diagnostics
    row["windowsCreated"] = 0
    let trace = check4MakeTrace()
    for i in 0..<2300 { trace.append(["op": "fixture", "i": i, "padding": String(repeating: "x", count: 1024)]) }
    trace.append(["op": "receive", "event": ["state": "drag"]])
    row["tracePast2MiB"] = !trace.overflow && trace.bytes > 2 * 1024 * 1024 &&
        (trace.rows.last?["input"] as? [String: Any])?["op"] as? String == "receive"
    row["traceLimitBytes"] = trace.limit
    let unknown = HandHost()
    unknown.unknownAppHidden = true
    unknown.perch.stage.wideWindows.insert(key)
    func event(_ state: String, ok: Bool = false, area: String? = nil) -> RingEvent {
        var value = RingEvent(seq: 1, state: state, pid: 42, windowId: area == "app" ? 0 : 9,
            at: state == "aim" ? CGPoint(x: 100, y: 100) : nil, rect: nil, label: nil, ok: ok)
        value.area = area; return value
    }
    var lifecycle = [unknown.keepUnknownAppHidden(event("waiting", area: "app"))]
    lifecycle.append(unknown.keepUnknownAppHidden(event("done", ok: true, area: "app")) && !unknown.perch.stage.wideWindows.isEmpty)
    lifecycle.append(unknown.keepUnknownAppHidden(event("done", area: "app")) && unknown.perch.stage.wideWindows.isEmpty)
    lifecycle.append(unknown.keepUnknownAppHidden(event("thinking")))
    lifecycle.append(unknown.keepUnknownAppHidden(event("thinking", area: "app")))
    unknown.unknownAppHidden = true
    lifecycle.append(unknown.keepUnknownAppHidden(event("aim")))
    row["unknownAppLifecycle"] = lifecycle
    row["panelFrameSelftest"] = check4PanelRect(CGRect(x: 10, y: 20, width: 30, height: 40), primaryTop: 1000)
    row["endingStatusSelftest"] = check4EndingStatus(["shown": true, "panelID": 42, "panel": [1, 2, 3, 4], "turnTargets": 2])
    check4LastStatus = ["shown": true, "panelID": 42, "panel": [1, 2, 3, 4], "turnTargets": 2]
    check4PublishStatus(ending: true)
    guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(70) }
    FileHandle.standardOutput.write(data + Data([10]))
}
var check4Observer: DispatchSourceTimer?
var check4LastStatus: [String: Any]?
func check4EndingStatus(_ row: [String: Any]) -> [String: Any] {
    var ending = row
    ending["shown"] = false; ending["panelID"] = NSNull(); ending["panel"] = NSNull()
    ending["hideReason"] = "host-exit"
    return ending
}
func check4PublishStatus(ending: Bool = false) {
    guard let path = ProcessInfo.processInfo.environment["SLEIGHT_CHECK4_STATUS"] else { return }
    if ending {
        // AppKit may already have cleared its delegate when atexit runs.
        guard let previous = check4LastStatus else { return }
        var row = check4EndingStatus(previous)
        row["hostTimeMs"] = CACurrentMediaTime() * 1000
        guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        return
    }
    guard let host = NSApp?.delegate as? HandHost else { return }
    if let panel = host.perch.panel {
        panel.title = "sleight check 4 character"
        panel.setAccessibilityIdentifier("sleight.check4.character")
        panel.setAccessibilityElement(true)
    }
    var row = host.perch.diagnostics
    row["pid"] = getpid(); row["panelID"] = host.perch.panel?.windowNumber as Any? ?? NSNull()
    row["hostTimeMs"] = CACurrentMediaTime() * 1000
    row["panel"] = host.perch.panel.map { check4PanelRect($0.frame, primaryTop: NSScreen.screens.first?.frame.maxY ?? 0) } as Any? ?? NSNull()
    row["plannedPanel"] = host.perch.panel.map { _ in stageTraceRect(host.perch.frame) } as Any? ?? NSNull()
    row["requestedSize"] = host.perch.stage.options.size
    row["eventState"] = host.perch.stage.event?.state as Any? ?? NSNull()
    row["characterReady"] = host.perch.loaded != nil
    check4LastStatus = row
    guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(70) }
    do { try data.write(to: URL(fileURLWithPath: path), options: .atomic) } catch { exit(74) }
}
func check4StartObserver() {
    guard ProcessInfo.processInfo.environment["SLEIGHT_CHECK4_STATUS"] != nil,
          let tracePath = ProcessInfo.processInfo.environment["SLEIGHT_CHECK4_TRACE"] else { exit(64) }
    // Publish the installed frame, not a timer's previous rung, and leave no
    // stale shown receipt after orderly process exit. These hooks only observe.
    stageBenchInstalled = { _, _, _, _, _ in DispatchQueue.main.async { check4PublishStatus() } }
    atexit { check4PublishStatus(ending: true) }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    var tick = 0
    timer.schedule(deadline: .now(), repeating: .milliseconds(50), leeway: .milliseconds(1))
    timer.setEventHandler {
        guard let host = NSApp.delegate as? HandHost else { return }
        check4PreparePerson()
        if host.perch.stage.trace == nil { host.perch.stage.trace = check4MakeTrace() }
        check4PublishStatus()
        tick += 1
        if tick % 5 == 0, let trace = host.perch.stage.trace?.json,
           let data = try? JSONSerialization.data(withJSONObject: trace, options: [.sortedKeys]) {
            do { try data.write(to: URL(fileURLWithPath: tracePath), options: .atomic) } catch { exit(74) }
        }
    }
    check4Observer = timer; timer.resume()
}
