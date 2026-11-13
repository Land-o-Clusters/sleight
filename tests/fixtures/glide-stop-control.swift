func check(_ yes: Bool, _ message: String) { if !yes { print(message); exit(1) } }
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let button = GlideStopButton()
let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 220, height: 60), styleMask: .borderless, backing: .buffered, defer: false)
window.contentView!.addSubview(button)
var stops = 0
button.stop = { stops += 1 }
check(!button.accessibilityPerformPress(), "AX press accepted")
button.accessibilityPerformAction(.press)
check(stops == 0, "legacy AX press accepted")
func event(_ state: CGEventSourceStateID, pid: Int64, type: CGEventType, data: Int64 = 0) -> NSEvent {
    let source = CGEventSource(stateID: state)!
    let cg = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: .zero, mouseButton: .left)!
    cg.setIntegerValueField(.eventSourceStateID, value: Int64(state.rawValue))
    cg.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
    cg.setIntegerValueField(.eventSourceUserData, value: data)
    cg.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(window.windowNumber))
    cg.timestamp = DispatchTime.now().uptimeNanoseconds
    return NSEvent(cgEvent: cg)!
}
for state in [CGEventSourceStateID.privateState, .combinedSessionState, .hidSystemState] {
    let down = event(state, pid: Int64(getpid()), type: .leftMouseDown)
    let up = event(state, pid: Int64(getpid()), type: .leftMouseUp)
    button.mouseDown(with: down); check(stops == 0, "posted event accepted")
}
let down = event(.hidSystemState, pid: 0, type: .leftMouseDown)
let up = event(.hidSystemState, pid: 0, type: .leftMouseUp)
button.mouseDown(with: down)
check(stops == 1, "person click refused")
button.mouseDown(with: down)
check(stops == 1, "same click accepted twice")
check(stops == 1, "one person click, one stop")
func key(pid: Int64, repeatKey: Bool = false) -> NSEvent {
    let source = CGEventSource(stateID: .hidSystemState)!
    let cg = CGEvent(keyboardEventSource: source, virtualKey: 49, keyDown: true)!
    cg.setIntegerValueField(.eventSourceStateID, value: Int64(CGEventSourceStateID.hidSystemState.rawValue))
    cg.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
    cg.setIntegerValueField(.eventSourceUserData, value: 0)
    cg.setIntegerValueField(.keyboardEventAutorepeat, value: repeatKey ? 1 : 0)
    cg.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(window.windowNumber))
    cg.timestamp = DispatchTime.now().uptimeNanoseconds
    return NSEvent(cgEvent: cg)!
}
check(window.makeFirstResponder(button), "button cannot receive a person's key")
button.keyDown(with: key(pid: Int64(getpid())))
button.keyDown(with: key(pid: 0, repeatKey: true))
check(stops == 1, "posted or repeated key accepted")
button.keyDown(with: key(pid: 0))
check(stops == 2, "person key refused")
_ = window.makeFirstResponder(nil)
button.keyDown(with: key(pid: 0))
check(stops == 2, "unfocused key accepted")
let target = CGRect(x: 100, y: 100, width: 600, height: 500)
let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
let rect = glideStopRect(target: target, screens: [screen])
check(rect != nil && screen.contains(rect!) && !rect!.intersects(target), "Stop covers target")
check(glideStopRect(target: screen, screens: [screen]) != nil, "full-screen control missing")
check(glideStopRect(target: screen, screens: [CGRect(x: 0, y: 0, width: 100, height: 30)]) == nil, "tiny display admitted")
let frame = GlideStopFrame(nonce: String(repeating: "a", count: 64), token: String(repeating: "b", count: 32), phase: "begin", pid: 42, window: 7)
for lostTarget in [false, true] {
    var sent: [[String: Any]] = []
    let tracker = GlideStopTracker(frame) { sent.append($0) }
    check(tracker.refresh(target: target, screens: [screen], place: { _ in }), "initial placement failed")
    check(!tracker.refresh(target: lostTarget ? nil : target, screens: [], place: { _ in }), "unavailable placement accepted")
    check(sent.count == 1 && sent[0]["phase"] as? String == "control-unavailable", "geometry manufactured Stop")
    check(!tracker.refresh(target: target, screens: [screen], place: { _ in }), "unavailable control revived")
    check(sent.count == 1, "geometry emitted twice")
}
// The 40 Hz window poll uses a fake window provider and placement sink here.
// This measures poll/geometry overhead, excluding WindowServer and drawing.
let tracker = GlideStopTracker(frame) { _ in }
var polls = 0
var usageBefore = rusage(), usageAfter = rusage()
getrusage(RUSAGE_SELF, &usageBefore)
let started = ProcessInfo.processInfo.systemUptime
let pollTimer = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { timer in
    _ = tracker.refresh(target: target, screens: [screen], place: { _ in polls += 1 })
    if polls >= 100 { timer.invalidate(); CFRunLoopStop(CFRunLoopGetCurrent()) }
}
CFRunLoopRun()
pollTimer.invalidate()
let elapsed = ProcessInfo.processInfo.systemUptime - started
getrusage(RUSAGE_SELF, &usageAfter)
func cpu(_ u: rusage) -> Double {
    Double(u.ru_utime.tv_sec + u.ru_stime.tv_sec) + Double(u.ru_utime.tv_usec + u.ru_stime.tv_usec) / 1_000_000
}
print("polls=\(polls) wallMs=\(elapsed * 1000) cpuMs=\((cpu(usageAfter) - cpu(usageBefore)) * 1000) cpuPercent=\((cpu(usageAfter) - cpu(usageBefore)) / elapsed * 100)")
check(!window.isVisible, "fixture showed a window")
print("AX=2 posted=4 person=2 replay=2 focus=1 placement=4 lost=2 visible=0")
