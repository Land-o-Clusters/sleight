
func check(_ ok: Bool, _ what: String) { if !ok { print("FAIL " + what); exit(1) } }
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
final class Receipt: NSObject {
    var choices: [String] = []
    @objc func accept(_ sender: NSButton) { choices.append(sender.title) }
}
let receipt = Receipt()
// Detached AppKit controls defer AX activation until they are visible. This helper dispatches the AX action
// synchronously so the real runtime subclass and target guard can be tested without displaying a window.
final class AXFixtureButton: NSButton {
    override func accessibilityPerformPress() -> Bool { sendAction(action, to: target) }
    override func accessibilityPerformAction(_ action: NSAccessibility.Action) {
        if action == .press { _ = accessibilityPerformPress() }
    }
}
// Each protected button sits in its own window, created but never ordered in, because a person's event must name the
// button's window and spends that window's events. Field 51 is the window number AppKit reads from a CGEvent.
var windows: [NSWindow] = []
func button(_ title: String) -> NSButton {
    let button = AXFixtureButton(title: title, target: receipt, action: #selector(Receipt.accept(_:)))
    let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 200, height: 40), styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView!.addSubview(button); windows.append(window)
    consentArming(window).presented(at: ProcessInfo.processInfo.systemUptime - 10)
    return button
}
var eventWindow = 0
func event(_ state: CGEventSourceStateID, _ pid: Int64 = 0, _ data: Int64 = 0, key: Bool = false) -> NSEvent {
    let source = CGEventSource(stateID: state)!
    let cg = key ? CGEvent(keyboardEventSource: source, virtualKey: 49, keyDown: true)!
        : CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: .zero, mouseButton: .left)!
    cg.setIntegerValueField(.eventSourceStateID, value: Int64(state.rawValue))
    cg.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
    cg.setIntegerValueField(.eventSourceUserData, value: data)
    cg.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(eventWindow))
    cg.timestamp = DispatchTime.now().uptimeNanoseconds
    return NSEvent(cgEvent: cg)!
}
// No NSApplication run loop, windows, global AX calls or posted input. These are the actual button/action objects.
let always = button("Always allow")
var current: NSEvent?
let guarded = ConsentInputAction(always, currentEvent: { current })
eventWindow = always.window!.windowNumber
check(!always.accessibilityPerformPress(), "AXPress refused")
check(receipt.choices.isEmpty, "AX writes no pre-approval receipt")
guarded.press(always)
check(receipt.choices.isEmpty, "no current event writes nothing")
for sample in [event(.combinedSessionState, Int64(getpid())), event(.privateState, Int64(getpid())),
    event(.hidSystemState, Int64(getpid())), event(.hidSystemState, 0, 9), event(.combinedSessionState, 0, key: true),
    event(.hidSystemState, Int64(getpid()), key: true)] {
    current = sample; guarded.press(always)
    check(receipt.choices.isEmpty, "posted input writes no pre-approval receipt")
}
// Even a leftover genuine event cannot turn AXPress into a person's click.
current = event(.hidSystemState)
check(personInput(current!.cgEvent), "HID metadata survives AppKit conversion")
check(ProcessInfo.processInfo.systemUptime - current!.timestamp < 1, "fresh HID timestamp")
check(!always.accessibilityPerformPress(), "AX refused with a current HID event")
always.accessibilityPerformAction(.press)
check(receipt.choices.isEmpty, "legacy AX refused even with current HID event")
let refused = receipt.choices
guarded.press(always)
check(receipt.choices == ["Always allow"], "HID click reaches original action exactly once")
guarded.press(always)
check(receipt.choices == ["Always allow"], "the same HID event is spent after one action")
let loose = AXFixtureButton(title: "Always allow", target: receipt, action: #selector(Receipt.accept(_:)))
let looseGuard = ConsentInputAction(loose, currentEvent: { current })
current = event(.hidSystemState); looseGuard.press(loose)
check(receipt.choices == ["Always allow"], "a button without a window refuses a fresh HID click")
current = event(.hidSystemState, 0, key: true); guarded.press(always)
check(receipt.choices.count == 1, "HID key without a typed word refuses")
current = event(.hidSystemState); guarded.press(always)
check(receipt.choices.count == 2, "a second deliberate HID click reaches original action")
let session = button("Allow this session"), decline = button("Decline")
session.accessibilityPerformAction(.press)
decline.accessibilityPerformAction(.press)
check(receipt.choices.suffix(2) == ["Allow this session", "Decline"], "unprotected AX reaches original action")
for kind in ["debugger", "relaunch", "action", "opt-in", "resume", "turbo-off"] {
    for choice in ["always", "once", "relaunch", "enable", "resume", "turbo-off"] { check(personChoice(kind, choice), "protected consent") }
    for choice in ["session", "cancel", "decline"] { check(!personChoice(kind, choice), "host-answerable choice") }
}
check(personChoice("app", "always") && !personChoice("app", "once"), "ordinary app approval scope")
check(!personInput(nil), "missing CGEvent")
let old = event(.hidSystemState).cgEvent!
old.timestamp = 1
current = NSEvent(cgEvent: old); guarded.press(always)
check(receipt.choices.count == 4, "old hardware event is refused")
// A busy main thread may dispatch a genuine event after more than one second. A fresh window has spent nothing yet.
let late = button("Always allow")
let lateGuard = ConsentInputAction(late, currentEvent: { current })
eventWindow = late.window!.windowNumber
func aged(_ seconds: Double) -> NSEvent {
    let cg = event(.hidSystemState).cgEvent!
    cg.timestamp = DispatchTime.now().uptimeNanoseconds - UInt64(seconds * 1_000_000_000)
    return NSEvent(cgEvent: cg)!
}
current = aged(5.1); lateGuard.press(late)
check(receipt.choices.count == 4, "HID click beyond five seconds is refused")
current = aged(4); lateGuard.press(late)
check(receipt.choices.count == 5, "four-second HID click is accepted")
current = aged(4.5); lateGuard.press(late)
check(receipt.choices.count == 5, "an event older than one this window spent is refused")
let future = event(.hidSystemState).cgEvent!
future.timestamp = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
current = NSEvent(cgEvent: future); guarded.press(always)
check(receipt.choices.count == 5, "future event is refused")
// Exercise installation on NSAlert's actual buttons too, without running or displaying the alert.
let alert = NSAlert()
alert.informativeText = "Private fixture details"
for label in ["Allow once", "Allow this session", "Always allow", "Cancel"] { alert.addButton(withTitle: label) }
let actions = consentInputActions(alert, choices: ["once", "session", "always", "cancel"], kind: "debugger")
let sessionTarget = alert.buttons[1].target, sessionAction = alert.buttons[1].action
let cancelTarget = alert.buttons[3].target, cancelAction = alert.buttons[3].action
check(actions.count == 2 && actions.allSatisfy { $0.originalAction != nil }, "real alert modal actions wrapped")
alert.layout()
check(alert.buttons[1].target === sessionTarget && alert.buttons[1].action == sessionAction, "session action unchanged")
check(alert.buttons[3].target === cancelTarget && alert.buttons[3].action == cancelAction, "cancel action unchanged")
check(alert.buttons[2].target === actions[1], "layout retains the guarded target")
func textFields(_ view: NSView) -> [NSTextField] { (view as? NSTextField).map { [$0] } ?? view.subviews.flatMap(textFields) }
let feedback = textFields(alert.accessoryView!).first { $0 !== actions.first?.typing?.instructions && !($0 is ConsentWordField) }!
check(feedback.stringValue.isEmpty, "feedback starts blank")
check(!alert.buttons[2].accessibilityPerformPress(), "real alert AXPress refused")
check(feedback.stringValue == consentInputMessage, "AX refusal shows the fixed line")
feedback.stringValue = ""
alert.buttons[2].accessibilityPerformAction(.press)
check(feedback.stringValue == consentInputMessage, "legacy AX refusal shows the fixed line")
feedback.stringValue = ""
_ = alert.buttons[2].sendAction(alert.buttons[2].action, to: alert.buttons[2].target)
check(feedback.stringValue == consentInputMessage, "action refusal shows the fixed line")
check(alert.informativeText == "Private fixture details", "refusal preserves private card body")
check(alert.buttons[2].isEnabled && alert.buttons[2].target === actions[1], "refused card stays answerable")
check(!alert.window.isVisible, "fixture never opens a window")
// The field's focus guard uses the production CGEvent classifier, with no HID seam.
final class PersonFocusPanel: NSPanel, ConsentWordFocusing {
    var focusCalls = 0
    func focusWordField(_ field: ConsentWordField) -> Bool { focusCalls += 1; return true }
}
let focusPanel = PersonFocusPanel(contentRect: NSRect(x: -20000, y: -20000, width: 300, height: 100), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
let focusField = ConsentWordField([:], instructions: "Fixture")
focusPanel.contentView!.addSubview(focusField); _ = focusPanel.windowRef
let postedMouse = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: focusPanel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
check(postedMouse.window === focusPanel, "posted-style event names the actual field window")
check(!personInput(postedMouse.cgEvent), "local NSEvent has non-HID provenance")
focusField.mouseDown(with: postedMouse)
check(focusPanel.focusCalls == 0, "posted-style mouse cannot request field focus")
check(!focusPanel.isVisible, "focus fixture stays unordered")
// G1B: the same action used by the Continue card, with no window or event posting.
check(personChoice("handoff", "continue"), "Continue is person-only")
let continuation = button("Continue")
var continueEvent: NSEvent?
let continueGuard = ConsentInputAction(continuation, mouseOnly: true, currentEvent: { continueEvent })
eventWindow = continuation.window!.windowNumber
let beforeContinue = receipt.choices
check(!continuation.accessibilityPerformPress(), "Continue refuses AXPress")
continuation.accessibilityPerformAction(.press)
for sample in [event(.combinedSessionState, Int64(getpid())), event(.hidSystemState, Int64(getpid())),
    event(.hidSystemState, 0, key: true)] {
    continueEvent = sample; continueGuard.press(continuation)
}
check(receipt.choices == beforeContinue, "Continue refuses posted events and Space")
continueEvent = event(.hidSystemState); continueGuard.press(continuation)
check(receipt.choices == beforeContinue + ["Continue"], "deliberate HID Continue click reaches original action")
receipt.choices = beforeContinue
check(windows.allSatisfy { !$0.isVisible }, "button windows stay unordered")
let result: [String: Any] = ["refused": refused, "accepted": receipt.choices]
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
