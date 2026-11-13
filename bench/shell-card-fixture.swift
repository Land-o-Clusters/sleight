// GB18Q FIXTURE. Appended only after the production entry point has been removed.
// No relay, broker, sockets, grant store or external action is connected to stdout.
var shellStep = "setup"
let app = NSApplication.shared
let host = ConsentHost()
var shellTargets: [String: [String: Any]] = [:]
var shellSequence = 0
var shellNonce = String(repeating: "a", count: 64)
let shellHandNonce = String(repeating: "b", count: 64)
var shellMouseMonitor: Any?
var shellMouseSamples = 0
guard CommandLine.arguments.count == 4, CommandLine.arguments[1].hasPrefix("/"),
    CommandLine.arguments[1].hasSuffix("/assets/icon.png"),
    ["synthetic", "person", "visibility"].contains(CommandLine.arguments[2]),
    UUID(uuidString: CommandLine.arguments[3]) != nil else { exit(64) }
let shellIcon = CommandLine.arguments[1]
let shellPhase = CommandLine.arguments[2], shellFixture = CommandLine.arguments[3]

func shellReceipt(_ outcome: String, _ fields: [String: Any] = [:]) {
    var record = fields
    record["outcome"] = outcome; record["step"] = shellStep
    record["pid"] = getpid(); record["pgid"] = getpgrp()
    record["phase"] = shellPhase; record["fixture"] = shellFixture
    if ["accepted", "refused"].contains(outcome),
        let id = fields["id"] as? String ?? host.activeAsk?.id, let target = shellTargets[id] {
        for (key, value) in target { record[key] = value }
    }
    if let event = NSApp.currentEvent?.cgEvent {
        record["receivedEvent"] = ["type": event.type.rawValue,
            "sourceState": event.getIntegerValueField(.eventSourceStateID),
            "sourcePid": event.getIntegerValueField(.eventSourceUnixProcessID),
            "userData": event.getIntegerValueField(.eventSourceUserData)]
    }
    guard let bytes = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { exit(70) }
    FileHandle.standardOutput.write(bytes + Data([10]))
}
func shellButtons(_ view: NSView?) -> [NSButton] {
    guard let view = view else { return [] }
    return (view as? NSButton).map { [$0] } ?? view.subviews.flatMap { shellButtons($0) }
}
func shellCards() -> Int {
    NSApp.windows.filter { $0.isVisible && shellButtons($0.contentView).contains { $0.title == "Allow once" } }.count
}
@discardableResult func shellSubmit() -> String {
    shellSequence += 1
    let id = String(format: "gb18q-%04d", shellSequence)
    let presentation: [String: Any] = ["style": "ask", "question": "Fake request: test Allow once?",
        "detail": "This fixture cannot approve any app, pay, persist grants or send a real action. Wait for the terminal's physical-click prompt.",
        "host": "Grok Bot", "icon": shellIcon, "kind": "action"]
    let data: [String: Any] = ["view": ["clientSession": "Grok Bot"],
        "operation": ["request": "Fake request only"], "presentation": presentation]
    let frame: [String: Any] = ["id": id, "nonce": shellNonce, "choices": ["once", "cancel"],
        "deadline": Date().timeIntervalSince1970 * 1000 + 180000, "data": data]
    host.receive(frame)
    return id
}
func shellReady() {
    if host.activeAsk == nil { shellSubmit() }
    // Allow AppKit's initial ordering animation to finish before publishing target geometry.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { shellReadyReceipt() }
}
func shellReadyReceipt() {
    guard let active = host.activeAsk,
        let button = shellButtons(active.panel.panel.contentView).first(where: { $0.title == "Allow once" }),
        let screen = NSScreen.screens.first else { shellReceipt("target-missing"); return }
    let panel = active.panel.panel
    shellTargets[active.id] = ["id": active.id, "window": panel.windowNumber, "button": button.title]
    let rect = panel.convertToScreen(button.convert(button.bounds, to: nil))
    let buttons = shellButtons(panel.contentView)
    shellReceipt("ready", ["pid": getpid(), "window": panel.windowNumber, "id": active.id,
        "x": rect.midX, "y": screen.frame.maxY - rect.midY,
        "visible": panel.isVisible, "cards": shellCards(),
        "protected": active.panel.actions.count == 1 && button.target === active.panel.actions.first && button.isEnabled,
        "returnDefault": panel.defaultButtonCell != nil || buttons.contains { $0.keyEquivalent == "\r" }])
}
func shellLifecycle() {
    guard let first = host.activeAsk else { shellReceipt("lifecycle", ["ok": false]); return }
    let firstPanel = first.panel
    let immediate = firstPanel.panel.isVisible && shellCards() == 1
    let second = shellSubmit()
    let queued = host.pending.count == 2 && host.activeAsk?.id == first.id && shellCards() == 1
    let row = NSMenuItem()
    row.representedObject = first.id
    host.review(row)
    let reviewed = host.activeAsk?.panel === firstPanel && shellCards() == 1
    row.representedObject = second
    host.review(row)
    let queuedReview = host.activeAsk?.panel === firstPanel && shellCards() == 1
    // Cancellation enters the production finish/respond path; the fixture never calls an Allow action.
    firstPanel.finish("cancel")
    let cancelled = firstPanel.finished && !firstPanel.panel.isVisible && host.activeAsk?.id == second && host.pending.count == 1
    let secondPanel = host.activeAsk?.panel
    host.channelClosed()
    let channel = host.activeAsk == nil && host.pending.isEmpty && shellCards() == 0 && secondPanel?.panel.isVisible == false
    // Direct method coverage of shared-host reset. Pipe replacement and hand-host integration need a separate run.
    host.consentOpen = true
    shellSubmit()
    let resetPanel = host.activeAsk?.panel
    host.receive(["hand": "consent-reset", "nonce": shellHandNonce, "token": String(repeating: "c", count: 32)])
    let reset = host.activeAsk == nil && host.pending.isEmpty && host.nonce == nil &&
        nonceBook.nonce("consent") == nil && nonceBook.nonce("hand") == shellHandNonce &&
        resetPanel?.panel.isVisible == false && shellCards() == 0
    shellNonce = String(repeating: "d", count: 64)
    let checks = ["immediateVisible": immediate, "oneCard": queued, "reviewIdentity": reviewed,
        "queuedReviewIdentity": queuedReview, "cancel": cancelled, "channelClose": channel, "channelReset": reset]
    shellReceipt("lifecycle", ["ok": checks.values.allSatisfy { $0 }, "checks": checks, "entry": "direct-production-methods"])
}
func shellStop(_ reason: String) -> Never {
    if let monitor = shellMouseMonitor { NSEvent.removeMonitor(monitor); shellMouseMonitor = nil }
    host.channelClosed()
    host.visibility?.cancel(); host.hookupTimer?.invalidate()
    NSStatusBar.system.removeStatusItem(host.item)
    shellReceipt("cleanup", ["visible": shellCards(), "pending": host.pending.count, "reason": reason])
    exit(0)
}
func shellAccessibilityState() -> [String: Any] {
    let windows = app.accessibilityWindows()
    let panel = host.activeAsk?.panel.panel
    let targetIncluded = windows?.contains { value in
        guard let target = panel, let candidate = value as? NSWindow else { return false }
        return candidate === target
    } ?? false
    return ["appAXWindows": windows?.count ?? -1,
        "targetInAXWindows": targetIncluded,
        "targetVisible": panel?.isVisible ?? false,
        "targetAccessibilityElement": panel?.isAccessibilityElement() ?? false,
        "hidesOnDeactivate": panel?.hidesOnDeactivate ?? false,
        "targetInAppWindows": app.windows.contains { candidate in panel.map { candidate === $0 } ?? false },
        "targetOnActiveSpace": panel?.isOnActiveSpace ?? false,
        "appActive": app.isActive, "appHidden": app.isHidden]
}
final class ShellFixture: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        host.shared = true; host.input = nil
        _ = nonceBook.admit("hand", shellHandNonce)
        shellReceipt("boot", ["pid": getpid(), "fake": true])
        // Observe only events already delivered to this fake app. Return each event unchanged.
        if shellPhase == "synthetic" {
            shellMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { event in
                if shellMouseSamples < 8, ["pid", "hid"].contains(shellStep),
                    let panel = host.activeAsk?.panel.panel,
                    let button = shellButtons(panel.contentView).first(where: { $0.title == "Allow once" }) {
                    shellMouseSamples += 1
                    let local = button.convert(event.locationInWindow, from: nil)
                    var mouse: [String: Any] = ["type": event.type.rawValue, "window": event.windowNumber,
                        "targetWindow": panel.windowNumber, "sameWindow": event.window === panel,
                        "clickCount": event.clickCount, "eventNumber": event.eventNumber,
                        "appActive": app.isActive, "keyWindow": panel.isKeyWindow,
                        "acceptsFirstMouse": button.acceptsFirstMouse(for: event),
                        "windowPoint": ["x": event.locationInWindow.x, "y": event.locationInWindow.y],
                        "insideButton": event.window === panel && button.bounds.contains(local)]
                    if let cg = event.cgEvent {
                        mouse["screenPoint"] = ["x": cg.location.x, "y": cg.location.y]
                        mouse["routingWindow"] = cg.getIntegerValueField(.mouseEventWindowUnderMousePointer)
                        mouse["handlingWindow"] = cg.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)
                        mouse["sourcePid"] = cg.getIntegerValueField(.eventSourceUnixProcessID)
                        mouse["sourceState"] = cg.getIntegerValueField(.eventSourceStateID)
                    }
                    shellReceipt("mouse-observed", ["mouse": mouse])
                }
                return event
            }
        }
        // Independent ceiling if the controlling runner disappears without delivering EOF.
        DispatchQueue.main.asyncAfter(deadline: .now() + 240) { shellStop("watchdog") }
        DispatchQueue.global().async {
            while let line = readLine() {
                guard line.utf8.count < 1024, let bytes = line.data(using: .utf8),
                    let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: String],
                    let op = command["op"], let step = command["step"],
                    (shellPhase == "synthetic" ? ["setup", "ax", "pid", "hid"] : shellPhase == "visibility" ? ["setup"] : ["setup", "person-click"]).contains(step),
                    (shellPhase == "synthetic" || op != "lifecycle") else {
                    DispatchQueue.main.async { shellStop("invalid-command") }; return
                }
                DispatchQueue.main.async {
                    shellStep = step
                    switch op {
                    case "show": shellReady()
                    case "lifecycle": shellLifecycle()
                    case "arm": shellMouseSamples = 0; shellReceipt("armed", ["accessibility": shellAccessibilityState()])
                    case "visibility-hide", "visibility-show":
                        guard shellPhase == "visibility", let panel = host.activeAsk?.panel.panel else { shellStop("invalid-visibility-command") }
                        panel.hidesOnDeactivate = op == "visibility-hide"
                        // Each phase uses the same show operation and settling interval.
                        panel.makeKeyAndOrderFront(nil)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            shellReceipt("visibility-ready", ["accessibility": shellAccessibilityState()])
                        }
                    default: shellStop("invalid-command")
                    }
                }
            }
            DispatchQueue.main.async { shellStop("stdin-eof") }
        }
    }
}
let fixture = ShellFixture()
app.setActivationPolicy(.accessory)
app.delegate = fixture
app.run()
shellStop("app-loop-ended")
