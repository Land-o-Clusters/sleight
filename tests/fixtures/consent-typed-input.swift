// Local AppKit dispatch only. No NSEvent subclass, event posting, app activation or window ordering.
var fixtureKeyWindow: NSWindow?
var fixtureCurrentEvent: NSEvent?
var fixtureHIDMouseDownAge = Double.infinity
var fixtureMouseLocation = NSPoint.zero
var fixtureWindowsFrontToBack: [NSWindow] = []
func fixtureWindowNumber(at point: NSPoint, belowWindowWithWindowNumber number: Int) -> Int {
    check(number == 0, "HID lookup starts at the topmost window")
    return fixtureWindowsFrontToBack.first { $0.frame.contains(point) }?.windowNumber ?? 0
}
var fixtureVoiceOver = false
var fixtureSwitchControl = false
var fixtureKeyAllowed = true
var trustedEvents = Set<ObjectIdentifier>()
var fixtureVisibleWindows = Set<ObjectIdentifier>()
let fixtureWorkspaceCenter = NotificationCenter(), fixtureUnlockCenter = NotificationCenter()
let fixtureWindowServerPID: Int64 = 424242
var fixtureSourcePID: Int64 = 0
var fixtureSourceState = CGEventSourceStateID.hidSystemState
var fixtureSourceData: Int64 = 0
var preflightKeyEquivalents = false
// Project only CG provenance. AppKit still dispatches the original NSEvent with its real text, window,
// timestamp and repeat flag. Both the shared helper and word field run the production personInput check.
func fixtureCGEvent(_ event: NSEvent) -> CGEvent? {
    guard let cg = event.cgEvent?.copy() else { return nil }
    if trustedEvents.contains(ObjectIdentifier(event)) {
        cg.setIntegerValueField(.eventSourceUnixProcessID, value: fixtureSourcePID)
        cg.setIntegerValueField(.eventSourceStateID, value: Int64(fixtureSourceState.rawValue))
        cg.setIntegerValueField(.eventSourceUserData, value: fixtureSourceData)
    }
    return cg
}
func fixturePidPath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer, _ size: UInt32) -> Int32 {
    let path = pid == Int32(fixtureWindowServerPID)
        ? "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer"
        : "/fixture/posted-input"
    let bytes = Array(path.utf8CString)
    guard bytes.count <= Int(size) else { return 0 }
    bytes.withUnsafeBytes { buffer.copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
    return Int32(bytes.count - 1)
}
func fixtureMakeKey(_ window: NSWindow) {
    check(window.canBecomeKey, "only an explicitly focused handoff may become key")
    if fixtureKeyAllowed && window.canBecomeKey { fixtureKeyWindow = window }
}
final class FixtureApplication: NSApplication {
    override var keyWindow: NSWindow? { fixtureKeyWindow }
    override var currentEvent: NSEvent? { fixtureCurrentEvent }
    override func sendEvent(_ event: NSEvent) {
        // A prohibited, inactive application has no interactive key-equivalent preflight.
        // Exercise that real NSWindow dispatcher explicitly before the normal application path.
        if preflightKeyEquivalents, event.type == .keyDown,
            event.window?.performKeyEquivalent(with: event) == true { return }
        if event.type == .keyDown { event.window?.sendEvent(event); return }
        super.sendEvent(event)
    }
}
let application = FixtureApplication.shared
application.setActivationPolicy(.prohibited)
var checks = 0
var failures: [String] = []
var dispatches = ["window": 0, "application": 0, "equivalent": 0]
func check(_ value: Bool, _ name: String) {
    checks += 1
    if !value { failures.append(name) }
}
final class TypedReceipt: NSObject {
    var choices: [String] = []
    var duringAction: (() -> Void)?
    @objc func accept(_ sender: NSButton) { choices.append(sender.title); duringAction?() }
}
func prepare(_ window: NSWindow, _ field: ConsentWordField) {
    window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
    // NSAlert defers its backing window. This accessor allocates its number without ordering it.
    _ = window.windowRef
    check(window.windowNumber > 0, "real window number allocated")
    check(!window.isVisible && NSScreen.screens.allSatisfy { !window.frame.intersects($0.frame) }, "window unordered and offscreen")
    fixtureKeyWindow = window
    // Simulate a card that has already been visible, without ordering it or waiting in real time.
    consentArming(window).presented(at: ProcessInfo.processInfo.systemUptime - 10)
    check(window.makeFirstResponder(field), "field can receive focus without an editor")
    check(window.firstResponder === field, "field owns first responder")
}
func word(_ view: ConsentTyping, _ title: String) -> String {
    let line = view.instructions.stringValue.components(separatedBy: "\n").first { $0.hasPrefix(title + ": type ") }!
    return line.components(separatedBy: ": type ")[1].components(separatedBy: ",")[0]
}
let codes: [Character: UInt16] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46]
func key(_ text: String, in window: NSWindow, code: UInt16? = nil, trusted: Bool = true,
    flags: NSEvent.ModifierFlags = [], age: Double = 0, repeated: Bool = false) -> NSEvent {
    let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
        timestamp: ProcessInfo.processInfo.systemUptime - age, windowNumber: window.windowNumber,
        context: nil, characters: text, charactersIgnoringModifiers: text, isARepeat: repeated,
        keyCode: code ?? codes[text.lowercased().first ?? "a"] ?? 0)!
    // Mark chosen local events for hardware-shaped CG provenance without rebridging the NSEvent.
    if trusted { trustedEvents.insert(ObjectIdentifier(event)) }
    check(event.window === window, "NSEvent resolves actual card window")
    return event
}
enum Route: String, CaseIterable { case window, application, equivalent }
func send(_ event: NSEvent, _ route: Route = .window, current: Bool = true) {
    fixtureCurrentEvent = current ? event : nil
    defer { fixtureCurrentEvent = nil; trustedEvents.remove(ObjectIdentifier(event)); preflightKeyEquivalents = false }
    dispatches[route.rawValue]! += 1
    switch route {
    case .window: event.window!.sendEvent(event)
    case .application: NSApp.sendEvent(event)
    case .equivalent:
        preflightKeyEquivalents = true
        NSApp.sendEvent(event)
    }
}
func type(_ text: String, _ view: ConsentTyping, _ route: Route = .window) {
    for char in text {
        send(key(String(char), in: view.window!), route)
        check(view.field.stringValue.allSatisfy { $0 == "•" }, "display contains only bullets")
        check(view.field.accessibilityValue() == String(repeating: "•", count: view.field.stringValue.count), "AX exposes only masked length")
    }
}
func checkMaskedText(_ field: ConsentWordField, count: Int) {
    let mask = String(repeating: "•", count: count), full = NSRange(location: 0, length: count)
    let caret = NSRange(location: count, length: 0)
    check(field.stringValue == mask, "stringValue holds only the masked word")
    check(field.attributedStringValue.string == mask, "attributed display holds only the masked word")
    check(field.cell?.stringValue == mask, "drawing cell holds only the masked word")
    check(field.accessibilityValue() == mask, "AXValue is masked")
    check(field.accessibilityString(for: full) == mask, "AXStringForRange is masked")
    check(field.accessibilityAttributedString(for: full)?.string == mask, "AXAttributedStringForRange is masked")
    check(field.accessibilitySelectedText() == "", "AXSelectedText is empty without selection")
    check(field.accessibilitySelectedTextRange() == caret, "AXSelectedTextRange is the masked caret")
    check(field.accessibilityNumberOfCharacters() == count, "AXNumberOfCharacters is the masked length")
    check(field.accessibilityVisibleCharacterRange() == full, "AXVisibleCharacterRange covers the mask")
    for (attribute, expected) in [(NSAccessibility.Attribute.value, mask), (.selectedText, "")] {
        check(field.accessibilityAttributeValue(attribute) as? String == expected, "legacy \(attribute.rawValue) is masked")
    }
    check((field.accessibilityAttributeValue(.numberOfCharacters) as? NSNumber)?.intValue == count, "legacy AXNumberOfCharacters is masked length")
    check((field.accessibilityAttributeValue(.selectedTextRange) as? NSValue)?.rangeValue == caret, "legacy AXSelectedTextRange is masked caret")
    check((field.accessibilityAttributeValue(.visibleCharacterRange) as? NSValue)?.rangeValue == full, "legacy AXVisibleCharacterRange covers mask")
    for range in [full, NSRange(location: min(1, count), length: max(0, count - 1)), caret] {
        let expected = String(repeating: "•", count: range.length), value = NSValue(range: range)
        check(field.accessibilityString(for: range) == expected, "AX substring is masked")
        check(field.accessibilityAttributedString(for: range)?.string == expected, "AX attributed substring is masked")
        check(field.accessibilityAttributeValue(.stringForRange, forParameter: value) as? String == expected, "legacy AXStringForRange is masked")
        check((field.accessibilityAttributeValue(.attributedStringForRange, forParameter: value) as? NSAttributedString)?.string == expected, "legacy AXAttributedStringForRange is masked")
    }
    for range in [NSRange(location: count + 1, length: 1), NSRange(location: NSNotFound, length: 1), NSRange(location: 1, length: Int.max)] {
        check(field.accessibilityString(for: range) == nil, "invalid AX string range returns no text")
        check(field.accessibilityAttributedString(for: range) == nil, "invalid AX attributed range returns no text")
        check(field.accessibilityAttributeValue(.stringForRange, forParameter: NSValue(range: range)) == nil, "invalid legacy AX string range returns no text")
        check(field.accessibilityAttributeValue(.attributedStringForRange, forParameter: NSValue(range: range)) == nil, "invalid legacy AX attributed range returns no text")
    }
    for parameter: Any? in [nil, "oak", NSNumber(value: 3), NSValue(point: .zero)] {
        check(field.accessibilityAttributeValue(.stringForRange, forParameter: parameter) == nil, "malformed legacy AX string parameter returns no text")
        check(field.accessibilityAttributeValue(.attributedStringForRange, forParameter: parameter) == nil, "malformed legacy AX attributed parameter returns no text")
    }
}
func mouse(_ view: ConsentTyping, trusted: Bool = true, age: Double = 0, type: NSEvent.EventType = .leftMouseDown) -> NSEvent {
    let event = NSEvent.mouseEvent(with: type, location: view.field.convert(.zero, to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime - age, windowNumber: view.window!.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    if trusted { trustedEvents.insert(ObjectIdentifier(event)) }
    return event
}
func click(_ action: ConsentInputAction, _ button: NSButton, _ up: NSEvent, downAt: Double? = nil) -> Bool {
    let down = NSEvent.mouseEvent(with: .leftMouseDown, location: up.locationInWindow, modifierFlags: [],
        timestamp: downAt ?? up.timestamp, windowNumber: up.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    if trustedEvents.contains(ObjectIdentifier(up)) { trustedEvents.insert(ObjectIdentifier(down)) }
    fixtureCurrentEvent = up
    defer { fixtureCurrentEvent = nil; trustedEvents.remove(ObjectIdentifier(down)) }
    var accepted = false
    action.trackMouseDown(down) { accepted = action.press(button) }
    return accepted
}
func enter(_ view: ConsentTyping, _ route: Route = .equivalent, code: UInt16 = 36, trusted: Bool = true, current: Bool = true) {
    send(key(code == 76 ? "\u{3}" : "\r", in: view.window!, code: code, trusted: trusted, flags: code == 76 ? .numericPad : []), route, current: current)
}
func modal(_ protectedDefault: Bool = false) -> (NSAlert, ConsentTyping, [ConsentInputAction], TypedReceipt) {
    let alert = NSAlert(), receipt = TypedReceipt()
    let labels = protectedDefault ? ["Always allow", "Don't allow"] : ["Don't allow", "Always allow"]
    let choices = protectedDefault ? ["always", "cancel"] : ["cancel", "always"]
    for label in labels {
        let button = alert.addButton(withTitle: label)
        button.target = receipt; button.action = #selector(TypedReceipt.accept(_:))
    }
    let actions = consentInputActions(alert, choices: choices, kind: "debugger")
    let view = actions[0].typing!
    prepare(alert.window, view.field)
    check(alert.buttons[0].keyEquivalent == (protectedDefault ? "" : "\r"), "only Cancel can retain the NSAlert Return default")
    check(!protectedDefault || alert.window.defaultButtonCell == nil, "protected first button is not the default cell")
    return (alert, view, actions, receipt)
}

// These catch a missing Return key-equivalent claim and a claim outside the field's responder scope.
for protectedDefault in [false, true] {
    for route in Route.allCases {
        for code: UInt16 in [36, 76] {
            let (alert, view, actions, receipt) = modal(protectedDefault)
            type("wrong", view, route)
            enter(view, route, code: code)
            check(receipt.choices.isEmpty, "wrong word Return fires no NSAlert button (\(protectedDefault), \(route), \(code)): \(receipt.choices)")
            check(view.field.isEnabled && view.field.stringValue.isEmpty, "wrong word leaves an enabled empty field")
            type(word(view, "Always allow"), view, route)
            enter(view, route, code: code)
            check(receipt.choices == ["Always allow"], "correct word fires exact NSAlert choice (\(protectedDefault), \(route), \(code)): \(receipt.choices)")
            check(!view.field.isEnabled && view.field.stringValue.isEmpty, "accepted field loses typed authority")
            check(!alert.window.isVisible, "NSAlert never ordered")
            _ = actions // retain guarded action targets for the whole scenario
        }
    }
}
for (protectedDefault, code) in [(false, UInt16(36)), (false, 76), (true, 36), (true, 76)] {
    // Empty Return may cancel, but cannot activate a protected first button.
    let (alert, view, actions, receipt) = modal(protectedDefault)
    enter(view, code: code)
    check(receipt.choices == (protectedDefault ? [] : ["Don't allow"]), "empty Return never approves")
    check(view.field.isEnabled, "default Return did not consume typed control")
    _ = alert; _ = actions
    let (unfocusedAlert, unfocused, held, otherReceipt) = modal(protectedDefault)
    type(word(unfocused, "Always allow"), unfocused)
    check(unfocusedAlert.window.makeFirstResponder(unfocusedAlert.buttons[0]), "button can take responder")
    enter(unfocused, code: code)
    check(otherReceipt.choices == (protectedDefault ? [] : ["Don't allow"]), "unfocused Return never approves")
    _ = held
}

// C3R2: WindowServer-origin Return must work at both the field and the final action, including
// passive handoff cards. Empty Return never approves a protected button.
for pid in [Int64(0), fixtureWindowServerPID] {
    fixtureSourcePID = pid
    for code: UInt16 in [36, 76] {
        let (alert, view, actions, receipt) = modal(true)
        enter(view, code: code)
        check(receipt.choices.isEmpty, "protected first button refuses physical Return from pid \(pid), key \(code)")
        type(word(view, "Always allow"), view); enter(view, code: code)
        check(receipt.choices == ["Always allow"], "typed confirmation accepts physical Return from pid \(pid), key \(code)")
        check(!view.field.isEnabled, "typed success invalidates after WindowServer/default dispatch")
        _ = alert; _ = actions
        var answers: [String] = []
        let card = AskCardPanel(AskCard(question: "Fixture?", detail: "", host: "sleight", icon: "", kind: "handoff", choices: ["cancel", "continue"]), deadline: Date().timeIntervalSince1970 * 1000 + 60000) { answers.append($0) }
        prepare(card.panel, card.typing!.field)
        type(word(card.typing!, "Continue"), card.typing!); enter(card.typing!, code: code)
        check(answers == ["continue"] && card.finished, "mouseOnly card accepts focused physical word from pid \(pid), key \(code)")
        card.close()
    }
}
fixtureSourcePID = 0

// C7: picker, pause and status-menu callers use the strict default, unlike consent.
for caller in ["picker", "pause", "status menu"] {
    let (alert, view, actions, receipt) = modal(true)
    fixtureSourcePID = fixtureWindowServerPID
    let event = key("\r", in: alert.window, code: 36)
    for bad in [(CGEventSourceStateID.combinedSessionState, Int64(0)), (.privateState, 0), (.hidSystemState, 9)] {
        fixtureSourceState = bad.0; fixtureSourceData = bad.1
        check(!personActivation(event, windowMatches: true, consent: true), "WindowServer plus bad provenance refuses \(caller)")
    }
    fixtureSourceState = .hidSystemState; fixtureSourceData = 0
    check(!personActivation(event, windowMatches: true), "\(caller) refuses WindowServer pid")
    if caller == "pause" {
        let control = CursorPauseControl()
        control.send = { _ in failures.append("refused pause must send nothing"); return false }
        check(!control.click(event, windowMatches: true) && control.pending == nil, "actual pause refuses WindowServer pid")
    } else {
        // Picker selection and status-menu actions both enter this production function.
        let menu = CursorPickerMenu(), item = NSMenuItem(title: caller, action: nil, keyEquivalent: "")
        menu.addItem(item); menu.trackingWindow = alert.window; menu.lastHighlighted = item
        fixtureCurrentEvent = event
        check(!personMenuActivation(item), "actual \(caller) menu refuses WindowServer pid")
        fixtureCurrentEvent = nil
    }
    check(personActivation(event, windowMatches: true, consent: true), "consent alone accepts WindowServer pid")
    let repeatEvent = key("\r", in: alert.window, code: 36, repeated: true)
    check(!personActivation(repeatEvent, windowMatches: true, consent: true), "consent independently refuses repeated key-down")
    trustedEvents.remove(ObjectIdentifier(event)); trustedEvents.remove(ObjectIdentifier(repeatEvent))
    fixtureSourcePID = 0
    let accepted = key("\r", in: alert.window, code: 36)
    if caller == "pause" {
        let control = CursorPauseControl()
        var sent = 0
        control.send = { _ in sent += 1; return true }
        check(control.click(accepted, windowMatches: true) && control.pending != nil && sent > 0, "actual pause accepts pid zero")
    } else {
        let menu = CursorPickerMenu(), item = NSMenuItem(title: caller, action: nil, keyEquivalent: "")
        menu.addItem(item); menu.trackingWindow = alert.window; menu.lastHighlighted = item
        fixtureCurrentEvent = accepted
        check(personMenuActivation(item), "actual \(caller) menu accepts pid zero")
        fixtureCurrentEvent = nil
    }
    trustedEvents.remove(ObjectIdentifier(accepted))
    check(receipt.choices.isEmpty, "provenance classifier emits no choice")
    _ = view; _ = actions
}

// All three NSAlert sites retain their original button indexes, with no protected Return default.
for (kind, choice, title) in [("action", "once", "Allow once"), ("opt-in", "enable", "Allow this session"),
    ("resume", "resume", "Allow this session"), ("turbo-off", "turbo-off", "Turn Off")] {
    for route in Route.allCases {
        for code: UInt16 in [36, 76] {
            let alert = NSAlert(), receipt = TypedReceipt()
            let protected = alert.addButton(withTitle: title), cancel = alert.addButton(withTitle: "Cancel")
            for button in alert.buttons { button.target = receipt; button.action = #selector(TypedReceipt.accept(_:)) }
            let actions = consentInputActions(alert, choices: [choice, "cancel"], kind: kind), view = actions[0].typing!
            prepare(alert.window, view.field)
            alert.layout()
            check(alert.buttons[0] === protected && alert.buttons[1] === cancel, "\(kind) response indexes unchanged")
            check(protected.keyEquivalent.isEmpty && alert.window.defaultButtonCell == nil, "\(kind) has no protected default after relayout")
            enter(view, route, code: code)
            check(receipt.choices.isEmpty, "\(kind) bare Return refuses through \(route), key \(code)")
            let early = mouse(view, age: 0.2, type: .leftMouseUp), arming = consentArming(alert.window)
            arming.presented(at: early.timestamp - consentArmingDelay + 0.001)
            fixtureCurrentEvent = early
            check(!click(actions[0], protected, early) && receipt.choices.isEmpty, "\(kind) queued alert click inside 500 ms refuses")
            fixtureCurrentEvent = nil; trustedEvents.remove(ObjectIdentifier(early))
            arming.presented()
            send(key("o", in: alert.window), route)
            check(view.field.stringValue.isEmpty, "\(kind) early alert letter cannot build a word")
            arming.presented(at: ProcessInfo.processInfo.systemUptime - 10)
            type(word(view, title), view, route); enter(view, route, code: code)
            check(receipt.choices == [title], "\(kind) typed word approves exact choice")
            receipt.choices = []
            let boundary = mouse(view, type: .leftMouseUp)
            arming.presented(at: boundary.timestamp - consentArmingDelay)
            fixtureCurrentEvent = boundary
            check(click(actions[0], protected, boundary) && receipt.choices == [title], "\(kind) alert click exactly at 500 ms approves")
            fixtureCurrentEvent = nil; trustedEvents.remove(ObjectIdentifier(boundary))
            receipt.choices = []
            arming.presented()
            _ = cancel.sendAction(cancel.action, to: cancel.target)
            check(receipt.choices == ["Cancel"], "\(kind) alert Cancel stays immediate")
            _ = actions
        }
    }
}

// Arming uses event timestamps, so queued early input still refuses. No sleeps or visible UI.
for kind in ["action", "debugger", "relaunch", "handoff", "app"] {
    let choice = kind == "relaunch" ? "relaunch" : kind == "handoff" ? "continue" : "always"
    var answers: [String] = []
    let card = AskCardPanel(AskCard(question: "Fixture?", detail: "", host: "sleight", icon: "", kind: kind,
        choices: ["cancel", choice]), deadline: Date().timeIntervalSince1970 * 1000 + 60000) { answers.append($0) }
    let view = card.typing!, action = card.actions[0], button = action.button!, arming = consentArming(card.panel)
    prepare(card.panel, view.field)
    let early = mouse(view, age: 0.2, type: .leftMouseUp)
    arming.presented(at: early.timestamp - consentArmingDelay + 0.001)
    fixtureCurrentEvent = early
    check(!click(action, button, early) && answers.isEmpty, "\(kind) queued input at 499 ms refuses after dispatch at 699 ms")
    check(card.feedback.stringValue == consentTimingMessage, "\(kind) timing refusal has its own message")
    fixtureCurrentEvent = nil; trustedEvents.remove(ObjectIdentifier(early))
    let letter = key("o", in: card.panel)
    arming.presented(at: letter.timestamp - consentArmingDelay + 0.001)
    send(letter)
    check(view.field.stringValue.isEmpty && answers.isEmpty, "\(kind) early word input does nothing")
    arming.presented(at: ProcessInfo.processInfo.systemUptime - 10)
    type(word(view, button.title), view)
    fixtureVisibleWindows.insert(ObjectIdentifier(card.panel))
    NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: card.panel)
    fixtureVisibleWindows.remove(ObjectIdentifier(card.panel))
    enter(view)
    check(answers.isEmpty && view.field.stringValue.isEmpty, "\(kind) key activation rearms and clears pending word")
    for notification in [NSApplication.willBecomeActiveNotification, NSApplication.didBecomeActiveNotification] {
        arming.presented(at: ProcessInfo.processInfo.systemUptime - 10)
        fixtureVisibleWindows.insert(ObjectIdentifier(card.panel))
        NotificationCenter.default.post(name: notification, object: NSApp)
        fixtureVisibleWindows.remove(ObjectIdentifier(card.panel))
        let fresh = mouse(view)
        check(!arming.accepts(fresh), "\(kind) app activation rearms visible card")
        trustedEvents.remove(ObjectIdentifier(fresh))
    }
    let boundary = mouse(view)
    arming.presented(at: boundary.timestamp - consentArmingDelay)
    check(arming.accepts(boundary), "\(kind) exactly 500 ms arms")
    arming.presented(at: boundary.timestamp - consentArmingDelay - 0.001)
    check(arming.accepts(boundary), "\(kind) 501 ms arms")
    arming.presented() // The hook used after show() and review().
    check(!arming.accepts(boundary), "\(kind) re-show refuses pre-show event")
    trustedEvents.remove(ObjectIdentifier(boundary))
    _ = card.buttons[0].sendAction(card.buttons[0].action, to: card.buttons[0].target)
    check(answers == ["cancel"], "\(kind) Cancel stays immediate")
    card.close()
}

// A fully armed inactive card accepts its first activating click, but an early press cannot be held through the delay.
for downDelay in [0.7, 0.5, 0.2] {
    let (alert, view, actions, receipt) = modal(true)
    let action = actions[0], button = alert.buttons[0], arming = consentArming(alert.window)
    let up = mouse(view, type: .leftMouseUp), shown = up.timestamp - 0.75
    let down = NSEvent.mouseEvent(with: .leftMouseDown, location: up.locationInWindow, modifierFlags: [],
        timestamp: shown + downDelay, windowNumber: up.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    trustedEvents.insert(ObjectIdentifier(down))
    arming.presented(at: shown)
    fixtureVisibleWindows.insert(ObjectIdentifier(alert.window)); fixtureKeyWindow = nil
    fixtureCurrentEvent = down
    NotificationCenter.default.post(name: NSApplication.willBecomeActiveNotification, object: NSApp)
    fixtureKeyWindow = alert.window
    NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: alert.window)
    var accepted = false
    action.trackMouseDown(down) {
        fixtureCurrentEvent = down
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        fixtureCurrentEvent = up
        accepted = action.press(button)
    }
    check(accepted == (downDelay >= consentArmingDelay), "inactive card click at \(downDelay * 1000) ms, up at 750 ms")
    check(receipt.choices == (downDelay >= consentArmingDelay ? ["Always allow"] : []), "activating click emits exact expected choice")
    check(button.acceptsFirstMouse(for: down), "protected button accepts the first inactive click")
    fixtureCurrentEvent = nil; fixtureVisibleWindows.remove(ObjectIdentifier(alert.window))
    trustedEvents.remove(ObjectIdentifier(down)); trustedEvents.remove(ObjectIdentifier(up))
}

// Invalid mouse events must rearm even if a separate, recent HID down could satisfy the fallback.
for row in ["posted down", "future down", "stale up", "old down"] {
    let (alert, view, actions, receipt) = modal(true)
    let arming = consentArming(alert.window), shown = ProcessInfo.processInfo.systemUptime - 10
    arming.presented(at: shown)
    let event = mouse(view, trusted: row != "posted down", age: row == "future down" ? -1 : row == "old down" ? 2 : 0,
        type: row == "stale up" ? .leftMouseUp : .leftMouseDown)
    fixtureCurrentEvent = event
    fixtureHIDMouseDownAge = 0.01; fixtureMouseLocation = NSPoint(x: alert.window.frame.midX, y: alert.window.frame.midY)
    fixtureWindowsFrontToBack = [alert.window]
    fixtureVisibleWindows.insert(ObjectIdentifier(alert.window))
    NotificationCenter.default.post(name: NSApplication.willBecomeActiveNotification, object: NSApp)
    check(arming.presentedAt > shown, "\(row) activation rearms instead of exempting")
    check(!arming.accepts(mouse(view, trusted: false)), "\(row) starts a new delay")
    check(receipt.choices.isEmpty, "\(row) grants nothing")
    fixtureCurrentEvent = nil; fixtureHIDMouseDownAge = .infinity; fixtureWindowsFrontToBack = []
    fixtureVisibleWindows.remove(ObjectIdentifier(alert.window))
    trustedEvents.remove(ObjectIdentifier(event)); _ = actions
}

// An app-defined or absent current event uses HID timing and global AppKit pointer coordinates, without reading live input.
for appDefined in [false, true] {
    for (age, inside, covered, armed, expected) in [
        (0.05, true, false, true, true), (0.05, true, true, true, false),
        (0.05, false, false, true, false), (0.1, true, false, true, false),
        (1.0, true, false, true, false), (-0.01, true, false, true, false), (Double.infinity, true, false, true, false),
        (Double.nan, true, false, true, false), (0.05, true, false, false, false)
    ] {
        let (alert, view, actions, receipt) = modal(true)
        let arming = consentArming(alert.window), shown = ProcessInfo.processInfo.systemUptime - (armed ? 10 : 0.2)
        arming.presented(at: shown)
        fixtureCurrentEvent = appDefined ? NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0) : nil
        fixtureHIDMouseDownAge = age
        fixtureMouseLocation = inside ? NSPoint(x: alert.window.frame.midX, y: alert.window.frame.midY) : .zero
        let cover = NSWindow(contentRect: alert.window.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        if covered {
            check(cover.frame.contains(fixtureMouseLocation) && alert.window.frame.contains(fixtureMouseLocation), "another window overlaps the card under the pointer")
        }
        fixtureWindowsFrontToBack = covered ? [cover, alert.window] : [alert.window]
        fixtureVisibleWindows.insert(ObjectIdentifier(alert.window))
        NotificationCenter.default.post(name: NSApplication.willBecomeActiveNotification, object: NSApp)
        check((arming.presentedAt == shown) == expected, "HID fallback app-defined=\(appDefined), age=\(age), inside=\(inside), covered=\(covered), armed=\(armed)")
        if !expected { check(!arming.accepts(mouse(view, trusted: false)), "HID refusal starts a new delay") }
        check(receipt.choices.isEmpty, "HID exemption grants nothing")
        fixtureCurrentEvent = nil; fixtureHIDMouseDownAge = .infinity; fixtureMouseLocation = .zero
        fixtureWindowsFrontToBack = []
        fixtureVisibleWindows.remove(ObjectIdentifier(alert.window)); _ = actions; _ = view
    }
}
for downDelay in [0.7, 0.2] {
    let (alert, view, actions, receipt) = modal(true)
    let arming = consentArming(alert.window), up = mouse(view, type: .leftMouseUp), down = mouse(view, age: 0.05)
    let shown = down.timestamp - downDelay
    arming.presented(at: shown)
    fixtureVisibleWindows.insert(ObjectIdentifier(alert.window))
    fixtureCurrentEvent = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [],
        timestamp: up.timestamp, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0)
    // Model activation 50 ms after the down; both paths must require the card to have armed before that down.
    fixtureHIDMouseDownAge = 0.05
    fixtureMouseLocation = NSPoint(x: alert.window.frame.midX, y: alert.window.frame.midY)
    fixtureWindowsFrontToBack = [alert.window]
    NotificationCenter.default.post(name: NSApplication.willBecomeActiveNotification, object: NSApp)
    check((arming.presentedAt == shown) == (downDelay == 0.7), "HID activation preserves only an armed presentation")
    let accepted = click(actions[0], alert.buttons[0], up, downAt: down.timestamp)
    check(accepted == (downDelay == 0.7), "HID activating click at \(downDelay * 1000) ms validates both ends")
    check(receipt.choices == (downDelay == 0.7 ? ["Always allow"] : []), "HID activating click emits exact expected choice")
    fixtureCurrentEvent = nil; fixtureHIDMouseDownAge = .infinity; fixtureMouseLocation = .zero
    fixtureWindowsFrontToBack = []
    fixtureVisibleWindows.remove(ObjectIdentifier(alert.window))
    trustedEvents.remove(ObjectIdentifier(down)); trustedEvents.remove(ObjectIdentifier(up))
}
do {
    let (alert, view, actions, receipt) = modal(true)
    let arming = consentArming(alert.window), up = mouse(view, type: .leftMouseUp), shown = up.timestamp - 0.75
    arming.presented(at: shown)
    check(!click(actions[0], alert.buttons[0], up, downAt: shown + 0.2), "press at 200 ms held until 750 ms refuses")
    check(receipt.choices.isEmpty, "held early press emits nothing")
    arming.presented(at: shown)
    fixtureCurrentEvent = up
    check(!actions[0].press(alert.buttons[0]), "mouse-up without tracked mouse-down refuses")
    fixtureCurrentEvent = nil; trustedEvents.remove(ObjectIdentifier(up))
}
for foreign in [false, true] {
    let (alert, view, actions, receipt) = modal(true)
    let (other, otherView, otherActions, _) = modal(true)
    let arming = consentArming(alert.window), shown = ProcessInfo.processInfo.systemUptime - 10
    arming.presented(at: shown)
    fixtureVisibleWindows.insert(ObjectIdentifier(alert.window))
    let event = foreign ? mouse(otherView, type: .leftMouseDown) : key("o", in: alert.window)
    fixtureHIDMouseDownAge = foreign ? 0.01 : .infinity
    fixtureMouseLocation = NSPoint(x: alert.window.frame.midX, y: alert.window.frame.midY)
    fixtureWindowsFrontToBack = [alert.window]
    fixtureCurrentEvent = event
    NotificationCenter.default.post(name: NSApplication.willBecomeActiveNotification, object: NSApp)
    check(arming.presentedAt > shown, "keyboard or another window's mouse activation rearms the card")
    check(!arming.accepts(mouse(view, trusted: false)), "another window's down cannot use the fresh HID fallback")
    check(receipt.choices.isEmpty, "foreign activation grants nothing")
    fixtureCurrentEvent = nil; fixtureVisibleWindows.remove(ObjectIdentifier(alert.window))
    fixtureHIDMouseDownAge = .infinity; fixtureMouseLocation = .zero; fixtureWindowsFrontToBack = []
    trustedEvents.remove(ObjectIdentifier(event)); _ = actions; _ = otherActions; _ = other; _ = view; _ = receipt
}

// All re-exposure signals rearm visible cards, while hidden cards keep their presentation timestamp.
for (center, notification, object) in [
    (NotificationCenter.default, NSWindow.didBecomeKeyNotification, true),
    (.default, NSApplication.willBecomeActiveNotification, false),
    (.default, NSApplication.didBecomeActiveNotification, false),
    (.default, NSWindow.didChangeOcclusionStateNotification, true),
    (fixtureWorkspaceCenter, NSWorkspace.activeSpaceDidChangeNotification, false),
    (fixtureWorkspaceCenter, NSWorkspace.sessionDidBecomeActiveNotification, false),
    (fixtureUnlockCenter, Notification.Name("com.apple.screenIsUnlocked"), false)
] {
    for visible in [false, true] {
        let (alert, view, actions, receipt) = modal(true)
        let arming = consentArming(alert.window), shown = ProcessInfo.processInfo.systemUptime - 10
        arming.presented(at: shown)
        if visible { fixtureVisibleWindows.insert(ObjectIdentifier(alert.window)) }
        center.post(name: notification, object: object ? alert.window : nil)
        check((arming.presentedAt > shown) == visible, "\(notification.rawValue) rearms only a visible card")
        let fresh = mouse(view)
        check(arming.accepts(fresh) == !visible, "\(notification.rawValue) enforces a new delay")
        fixtureVisibleWindows.remove(ObjectIdentifier(alert.window)); trustedEvents.remove(ObjectIdentifier(fresh))
        _ = actions; _ = receipt
    }
}

// A protected native button requires the word for keyboard dispatch. Complete mouse clicks still work.
// Every accepted event is spent once.
for pid in [Int64(0), fixtureWindowServerPID] {
    fixtureSourcePID = pid
    for mouseOnly in [false, true] {
        let receipt = TypedReceipt()
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 200, height: 80), styleMask: .borderless, backing: .buffered, defer: false)
        let button = NSButton(title: "Confirm", target: receipt, action: #selector(TypedReceipt.accept(_:)))
        window.contentView!.addSubview(button); _ = window.windowRef
        let action = ConsentInputAction(button, mouseOnly: mouseOnly)
        consentArming(window).presented(at: ProcessInfo.processInfo.systemUptime - 10)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp, .keyDown, .keyUp] {
            let event: NSEvent
            if type == .leftMouseDown || type == .leftMouseUp {
                event = NSEvent.mouseEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            } else {
                event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "a", charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0)!
            }
            trustedEvents.insert(ObjectIdentifier(event)); fixtureCurrentEvent = event
            let before = receipt.choices.count, allowed = type == .leftMouseUp
            let accepted = allowed ? click(action, button, event) : action.press(button)
            check(accepted == allowed, "native consent dispatch preserves pid \(pid), type \(type), mouseOnly \(mouseOnly)")
            check(receipt.choices.count == before + (allowed ? 1 : 0), "button emits only the expected receipt")
            if allowed { check(!click(action, button, event), "same consent mouse-up cannot dispatch twice") }
            else { check(!action.press(button), "refused key or mouse-down still cannot dispatch") }
            trustedEvents.remove(ObjectIdentifier(event)); fixtureCurrentEvent = nil
        }
        check(!window.isVisible, "native button regression window never ordered")
    }
}
fixtureSourcePID = 0

// Exercise both provenance layers with real CGEvent fields, so widening the consent event set never
// admits a posted process, invalid pid, non-HID source or user-data marker.
for source in [(Int64(7), CGEventSourceStateID.hidSystemState, Int64(0)),
    (-1, .hidSystemState, 0), (Int64(Int32.max) + 1, .hidSystemState, 0),
    (0, .combinedSessionState, 0), (0, .privateState, 0), (0, .hidSystemState, 9),
    (fixtureWindowServerPID, .combinedSessionState, 0), (fixtureWindowServerPID, .privateState, 0),
    (fixtureWindowServerPID, .hidSystemState, 9)] {
    let (alert, view, actions, receipt) = modal(true)
    type(word(view, "Always allow"), view)
    fixtureSourcePID = source.0; fixtureSourceState = source.1; fixtureSourceData = source.2
    enter(view)
    check(receipt.choices.isEmpty && view.field.isEnabled && view.field.stringValue.isEmpty, "bad provenance cannot confirm or fall through to protected default")
    let event = key("\r", in: alert.window, code: 36)
    fixtureCurrentEvent = event
    check(!actions[0].press(alert.buttons[0]) && receipt.choices.isEmpty, "final consent action independently refuses bad provenance")
    trustedEvents.remove(ObjectIdentifier(event)); fixtureCurrentEvent = nil
    fixtureSourcePID = 0; fixtureSourceState = .hidSystemState; fixtureSourceData = 0
}

let deadline = Date().timeIntervalSince1970 * 1000 + 60000
for route in Route.allCases {
    for code: UInt16 in [36, 76] {
        var answers: [String] = []
        let panel = AskCardPanel(AskCard(question: "Fixture?", detail: "", host: "sleight", icon: "", kind: "debugger", choices: ["cancel", "once", "session", "always"]), deadline: deadline) { answers.append($0) }
        let view = panel.typing!
        prepare(panel.panel, view.field)
        enter(view, route, code: code)
        check(answers.isEmpty && view.field.isEnabled && panel.feedback.stringValue.isEmpty, "empty panel Return has no default or refusal")
        type("wrong", view, route); enter(view, route, code: code)
        check(answers.isEmpty && view.field.isEnabled, "wrong panel word has no action")
        let choice = code == 36 ? "Allow once" : "Always allow"
        type(word(view, choice), view, route); enter(view, route, code: code)
        check(answers == [code == 36 ? "once" : "always"], "panel delivers exact typed choice through \(route), \(code): \(answers)")
        check(!view.field.isEnabled && panel.finished && !panel.panel.isVisible, "panel closes and invalidates once")
        type("oak", view, route); enter(view, route, code: code)
        check(answers.count == 1, "closed panel cannot answer twice")
        panel.close()
    }
}

// Non-letter keys must preserve a partially typed word and must not show an automation refusal.
for (text, code, flags) in [(" ", UInt16(49), NSEvent.ModifierFlags()), ("1", 18, []), (".", 47, []), ("\u{f702}", 123, [.function, .numericPad])] {
    let (keyAlert, keys, keyActions, keyReceipt) = modal()
    let secret = word(keys, "Always allow")
    let feedback = objc_getAssociatedObject(keyAlert.buttons[1], &consentFeedbackKey) as! NSTextField
    for char in secret {
        type(String(char), keys)
        let before = keys.field.stringValue
        send(key(text, in: keyAlert.window, code: code, flags: flags))
        check(keys.field.stringValue == before && feedback.stringValue.isEmpty, "non-letter key preserves buffer without refusal (\(code))")
    }
    check(keys.field.stringValue == String(repeating: "•", count: secret.count), "ignored keys do not alter word length")
    enter(keys)
    check(keyReceipt.choices == ["Always allow"], "word with ignored keys still confirms")
    _ = keyActions
}

for character in ["ф", "ั"] {
    let (layoutAlert, layout, layoutActions, layoutReceipt) = modal()
    let layoutWord = word(layout, "Always allow")
    for char in layoutWord { send(key(character, in: layoutAlert.window, code: codes[char]!)) }
    check(layout.field.stringValue == String(repeating: "•", count: layoutWord.count), "non-Latin letters and combining marks keep masked length")
    enter(layout)
    check(layoutReceipt.choices == ["Always allow"], "non-Latin layout reaches intended action")
    _ = layoutActions
}

// Latin layouts keep their own characters even when physical positions differ from ABC.
let (latinAlert, latin, latinActions, latinReceipt) = modal()
let latinWord = word(latin, "Always allow")
for char in latinWord { send(key(String(char).uppercased(), in: latinAlert.window, code: 0, flags: [.shift, .capsLock])) }
check(latin.field.stringValue == String(repeating: "•", count: latinWord.count), "Latin layout characters and uppercase keep masked length")
enter(latin)
check(latinReceipt.choices == ["Always allow"], "Latin layout confirms its typed word")
_ = latinActions

// A Return refused by the typed path must be consumed before NSAlert can activate any default.
for code: UInt16 in [36, 76] {
    for refused in ["posted", "stale", "repeat", "shortcut"] {
        let (alert, view, actions, receipt) = modal(true)
        type(word(view, "Always allow"), view)
        send(key(code == 36 ? "\r" : "\u{3}", in: alert.window, code: code,
            trusted: refused != "posted", flags: refused == "shortcut" ? .command : [],
            age: refused == "stale" ? 6 : 0, repeated: refused == "repeat"), .equivalent)
        check(receipt.choices.isEmpty && view.field.isEnabled && view.field.stringValue.isEmpty, "refused \(refused) Return cannot reach protected default (\(code))")
        _ = actions
    }
}

// Refusal at the final GB12 dispatch must leave an answerable field. Nested dispatch cannot replay the word.
let (retryAlert, retry, retryActions, retryReceipt) = modal()
type(word(retry, "Always allow"), retry)
enter(retry, .window, current: false)
check(retryReceipt.choices.isEmpty && retry.field.isEnabled, "refused action does not invalidate field")
type(word(retry, "Always allow"), retry)
retryReceipt.duringAction = { retryReceipt.duringAction = nil; enter(retry, .equivalent) }
enter(retry)
check(retryReceipt.choices == ["Always allow"], "retry succeeds once even under nested dispatch")
check(!retry.field.isEnabled, "successful retry invalidates")
_ = retryAlert; _ = retryActions

// Keep GB12's trust, freshness, focus and AX/value boundaries covered with real locally dispatched events.
let (guardAlert, guarded, guardActions, guardReceipt) = modal()
check(guarded.field.isAccessibilityElement() && guarded.field.accessibilityRole() == .textField, "VoiceOver field role")
check(guarded.field.accessibilityLabel()?.contains(guarded.instructions.stringValue) == true, "AX label names words and choices")
check(!guarded.field.isEditable && !guarded.field.isSelectable, "field has no editable paste surface")
check(!guarded.field.isAccessibilitySelectorAllowed(#selector(guarded.field.setAccessibilityValue(_:))), "AXValue setter denied")
check(!guardAlert.buttons[1].accessibilityPerformPress(), "protected button AX press denied")
check(guarded.field.accessibilityPerformPress(), "AX may focus field")
for event in [key("letters", in: guardAlert.window), key("a", in: guardAlert.window, trusted: false), key("a", in: guardAlert.window, flags: .command), key("a", in: guardAlert.window, flags: .control), key("a", in: guardAlert.window, flags: .option), key("a", in: guardAlert.window, age: 5.1), key("a", in: guardAlert.window, age: -1), key("a", in: guardAlert.window, repeated: true)] {
    type("o", guarded)
    send(event)
    check(guarded.field.stringValue.isEmpty && guarded.field.isEnabled, "untrusted or stale input clears pending authority")
}
let replay = key("a", in: guardAlert.window)
send(replay)
trustedEvents.insert(ObjectIdentifier(replay)); send(replay)
check(guarded.field.stringValue.isEmpty, "replayed timestamp refused")
type(word(guarded, "Always allow"), guarded)
let legacyValue = guarded.field.accessibilityAttributeValue(.value) as? String
check(legacyValue == nil || legacyValue == String(repeating: "•", count: guarded.field.stringValue.count), "legacy AX value never returns the typed buffer")
guarded.field.setAccessibilityValue("oak")
check(guarded.field.stringValue.isEmpty && guardReceipt.choices.isEmpty, "AX write clears physical buffer")
guarded.field.stringValue = word(guarded, "Always allow")
checkMaskedText(guarded.field, count: 0)
guarded.field.attributedStringValue = NSAttributedString(string: word(guarded, "Always allow"))
checkMaskedText(guarded.field, count: 0)
guarded.field.objectValue = word(guarded, "Always allow")
checkMaskedText(guarded.field, count: 0)
enter(guarded, .window)
check(guardReceipt.choices.isEmpty, "display value grants no typed authority")
type(word(guarded, "Always allow"), guarded); enter(guarded, .window, trusted: false)
check(guardReceipt.choices.isEmpty && guarded.field.stringValue.isEmpty, "posted Return cannot confirm physical word")
type("o", guarded)
send(key("x", in: guardAlert.window)); send(key("\u{7f}", in: guardAlert.window, code: 51))
check(guarded.field.stringValue == "•", "Backspace removes one masked physical letter")
send(key("\t", in: guardAlert.window, code: 48))
check(guarded.field.stringValue.isEmpty && guardReceipt.choices.isEmpty, "Tab only navigates and clears")
check(guardAlert.window.makeFirstResponder(guarded.field), "refocus after Tab")
type("o", guarded); _ = guardAlert.window.makeFirstResponder(guardAlert.buttons[0])
check(guarded.field.stringValue.isEmpty, "focus loss clears")
_ = guardAlert.window.makeFirstResponder(guarded.field)
type("o", guarded)
NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: guardAlert.window)
check(guarded.field.stringValue.isEmpty, "window deactivation clears")
fixtureKeyWindow = nil
type("o", guarded)
check(guarded.field.stringValue.isEmpty && guardReceipt.choices.isEmpty, "inactive card refuses physical typing")
fixtureKeyWindow = guardAlert.window
guardAlert.buttons[1].isEnabled = false
type(word(guarded, "Always allow"), guarded); enter(guarded, .window)
check(guardReceipt.choices.isEmpty && guarded.field.isEnabled, "disabled action cannot confirm")
guarded.invalidate()
check(!guarded.field.isEnabled && guarded.field.stringValue.isEmpty, "dismissal burns authority")
_ = guardActions

// Preserve modal-kind coverage and panel dismissal/expiry from the original typed fixture.
for (kind, choice) in [("opt-in", "enable"), ("resume", "resume"), ("turbo-off", "turbo-off"), ("action", "once")] {
    let alert = NSAlert()
    alert.addButton(withTitle: "Confirm"); alert.addButton(withTitle: "Cancel")
    let actions = consentInputActions(alert, choices: [choice, "cancel"], kind: kind)
    check(actions.count == 1 && actions[0].typing != nil, "protected modal kind has typed control: \(kind)")
    actions[0].typing!.invalidate()
}
for kind in ["action", "debugger", "relaunch"] {
    let choices = kind == "debugger" ? ["cancel", "once", "session", "always"] : kind == "relaunch" ? ["cancel", "relaunch"] : ["cancel", "once"]
    var answers: [String] = []
    let panel = AskCardPanel(AskCard(question: "Fixture?", detail: "", host: "sleight", icon: "", kind: kind, choices: choices), deadline: deadline) { answers.append($0) }
    let view = panel.typing!
    panel.layout(in: NSRect(x: -20000, y: -20000, width: 480, height: 480))
    prepare(panel.panel, view.field)
    check(view.frame.minY >= panel.buttons[0].frame.maxY + 8 && view.frame.maxY <= panel.scroll.frame.minY, "typed controls fit between buttons and content")
    type("o", view)
    panel.timer!.fire()
    check(answers == ["cancel"] && !view.field.isEnabled && view.field.stringValue.isEmpty, "expiry cancels and invalidates: \(kind)")
    panel.close()
}
let ordinary = AskCardPanel(AskCard(question: "Allow?", detail: "", host: "Fixture", icon: "", kind: "app", choices: ["cancel", "once"]), deadline: deadline) { _ in }
check(ordinary.typing == nil, "ordinary host-answerable approval has no typed field")
ordinary.close()

// Handoff starts outside the keyboard path. Only explicit focus of its word field
// permits a key window; real page-window events keep their own window association.
for route in Route.allCases {
    for focus in ["press", "focused", "mouse"] {
        fixtureVoiceOver = focus == "press"
        fixtureSwitchControl = focus == "focused"
        var answers: [String] = []
        let target: [String: Any] = ["kind": "handoff", "session": "fixture-session", "turn": "fixture-turn", "tab": "t1"]
        let card = AskCardPanel(automaticCard(target, ["continue", "cancel"])!, deadline: deadline) { answers.append($0) }
        let view = card.typing!, window = card.panel
        card.layout(in: NSRect(x: -20000, y: -20000, width: 480, height: 480)); _ = window.windowRef
        consentArming(window).presented(at: ProcessInfo.processInfo.systemUptime - 10)
        check(view.frame.minY >= card.buttons[0].frame.maxY + 8 && view.frame.maxY <= card.scroll.frame.minY, "handoff word field fits below its explanation")
        check(window.frame.height <= 480 && window.frame.width <= 480, "handoff fits a small display")
        let page = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 400, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
        _ = page.windowRef
        let pageField = ConsentWordField([:], instructions: "Fixture page")
        page.contentView!.addSubview(pageField); _ = page.makeFirstResponder(pageField)
        fixtureKeyWindow = page
        check(window.styleMask.contains(.nonactivatingPanel) && !window.canBecomeMain, "handoff stays nonactivating and never main")
        check(!window.canBecomeKey, "handoff cannot become key before explicit word focus")
        check(window.firstResponder !== view.field, "handoff field is not initially focused")
        for char in word(view, "Continue") + " \r" {
            send(key(String(char), in: page, code: char == "\r" ? 36 : char == " " ? 49 : nil), route)
        }
        check(answers.isEmpty && view.field.stringValue.isEmpty && fixtureKeyWindow === page, "page typing never reaches handoff")
        check(!card.buttons[1].accessibilityPerformPress(), "AX cannot press handoff Continue")
        if focus == "press" { check(view.field.accessibilityPerformPress(), "AX press focuses handoff field") }
        else if focus == "focused" { view.field.setAccessibilityFocused(true) }
        else {
            let event = mouse(view)
            view.field.mouseDown(with: event)
            trustedEvents.remove(ObjectIdentifier(event))
        }
        check(window.canBecomeKey && fixtureKeyWindow === window && window.firstResponder === view.field, "explicit \(focus) focus opens handoff keyboard path")
        enter(view, route)
        send(key(" ", in: window, code: 49), route)
        check(answers.isEmpty, "empty Return and Space cannot Continue")
        // Even a focused protected button must retain its mouse-only guard.
        _ = window.makeFirstResponder(card.buttons[1])
        for (text, code) in [(" ", UInt16(49)), ("\r", 36)] { send(key(text, in: window, code: code), route) }
        check(answers.isEmpty, "button focus cannot turn ordinary Space or Return into Continue")
        fixtureVoiceOver = true
        check(view.field.accessibilityPerformPress(), "field can be refocused")
        type("wrong", view, route); enter(view, route)
        check(answers.isEmpty && view.field.isEnabled, "wrong handoff word is retryable")
        type(word(view, "Continue"), view, route); enter(view, route, trusted: false)
        check(answers.isEmpty && view.field.stringValue.isEmpty, "posted Return cannot complete handoff word")
        type(word(view, "Continue"), view, route)
        checkMaskedText(view.field, count: word(view, "Continue").count)
        view.field.stringValue = "overwritten"
        checkMaskedText(view.field, count: word(view, "Continue").count)
        view.field.attributedStringValue = NSAttributedString(string: "overwritten")
        checkMaskedText(view.field, count: word(view, "Continue").count)
        view.field.objectValue = "overwritten"
        checkMaskedText(view.field, count: word(view, "Continue").count)
        // A page event with the same Return never completes a card's pending word.
        send(key("\r", in: page, code: 36), route)
        check(answers.isEmpty, "foreign page Return cannot complete handoff word")
        enter(view, route, code: focus == "focused" ? 76 : 36)
        check(answers == ["continue"] && card.finished && !view.field.isEnabled, "focused physical word confirms handoff exactly once: \(route), \(focus)")
        checkMaskedText(view.field, count: 0)
        check(!window.isVisible && !page.isVisible, "handoff and page were never ordered")
        card.close()
    }
}
// AX without an active assistive technology and posted/stale pointer events cannot steal page focus.
for attempt in ["press", "focused", "posted", "stale", "future", "failed-key"] {
    fixtureVoiceOver = false; fixtureSwitchControl = false
    var answers: [String] = []
    let card = AskCardPanel(AskCard(question: "Finish signing in", detail: "", host: "sleight", icon: "", kind: "handoff", choices: ["cancel", "continue"]), deadline: deadline) { answers.append($0) }
    let view = card.typing!, window = card.panel
    window.setFrameOrigin(NSPoint(x: -20000, y: -20000)); _ = window.windowRef
    consentArming(window).presented(at: ProcessInfo.processInfo.systemUptime - 10)
    let page = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 400, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
    fixtureKeyWindow = page
    if attempt == "press" { check(!view.field.accessibilityPerformPress(), "ordinary AX press is refused") }
    else if attempt == "focused" { view.field.setAccessibilityFocused(true) }
    else {
        fixtureKeyAllowed = attempt != "failed-key"
        let event = mouse(view, trusted: attempt != "posted", age: attempt == "stale" ? 5.1 : attempt == "future" ? -1 : 0)
        if attempt == "posted" { check(!personInput(event.cgEvent), "posted-style mouse has non-HID provenance") }
        view.field.mouseDown(with: event)
        trustedEvents.remove(ObjectIdentifier(event)); fixtureKeyAllowed = true
    }
    check(fixtureKeyWindow === page && !window.canBecomeKey, "\(attempt) leaves page key and resets handoff permission")
    check(answers.isEmpty && view.field.stringValue.isEmpty, "\(attempt) supplies no typed authority")
    card.close()
}
fixtureVoiceOver = true
// Inject the assistive-technology state independently of the workspace defaults.
for state in [(false, false), (true, false), (false, true), (true, true)] {
    for focus in ["press", "focused"] {
        let panel = HandoffPanel(contentRect: NSRect(x: -20000, y: -20000, width: 400, height: 200), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        let field = ConsentWordField([:], instructions: "Fixture", accessibilityState: { (state.0, state.1) })
        panel.contentView!.addSubview(field)
        fixtureKeyWindow = nil
        if focus == "press" { check(field.accessibilityPerformPress() == (state.0 || state.1), "AX press follows injected state \(state)") }
        else { field.setAccessibilityFocused(true) }
        check((fixtureKeyWindow === panel) == (state.0 || state.1), "AX \(focus) only makes key for active assistive technology \(state)")
        check(panel.canBecomeKey == (state.0 || state.1), "AX \(focus) retains permission only when allowed \(state)")
        panel.resignKey(); fixtureKeyWindow = nil
    }
}
for ending in ["expiry", "dismiss", "focus-loss"] {
    var answers: [String] = []
    let card = AskCardPanel(AskCard(question: "Finish signing in", detail: "", host: "sleight", icon: "", kind: "handoff", choices: ["cancel", "continue"]), deadline: deadline) { answers.append($0) }
    let view = card.typing!, window = card.panel
    window.setFrameOrigin(NSPoint(x: -20000, y: -20000)); _ = window.windowRef
    _ = view.field.accessibilityPerformPress()
    type(word(view, "Continue"), view)
    if ending == "expiry" { card.timer!.fire() }
    else if ending == "dismiss" { card.close() }
    else { window.resignKey(); fixtureKeyWindow = nil }
    check(view.field.stringValue.isEmpty, "\(ending) clears handoff word")
    if ending == "focus-loss" {
        check(!window.canBecomeKey, "focus loss resets handoff key permission")
        check(view.field.accessibilityPerformPress(), "explicit field focus may resume after focus loss")
        enter(view)
        check(answers.isEmpty, "refocus cannot replay previous word")
    } else { check(!view.field.isEnabled, "\(ending) invalidates handoff field") }
    card.close()
}

let result: [String: Any] = ["checks": checks, "failures": failures, "dispatches": dispatches, "visible": application.windows.contains { $0.isVisible }]
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
exit(failures.isEmpty ? 0 : 1)
