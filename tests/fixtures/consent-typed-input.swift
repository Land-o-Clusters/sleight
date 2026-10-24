// Local AppKit dispatch only. No NSEvent subclass, event posting, app activation or window ordering.
var fixtureKeyWindow: NSWindow?
var fixtureCurrentEvent: NSEvent?
var trustedEvents = Set<ObjectIdentifier>()
var preflightKeyEquivalents = false
func fixturePersonInput(_ event: NSEvent) -> Bool { trustedEvents.contains(ObjectIdentifier(event)) }
func fixtureMakeKey(_ window: NSWindow) {
    check(window.canBecomeKey, "only an explicitly focused handoff may become key")
    if window.canBecomeKey { fixtureKeyWindow = window }
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
    // NSEvent.keyEvent creates process-origin input. Admit chosen fixture events through the extraction seam,
    // without editing, rebridging or subclassing any NSEvent or changing its window/text properties.
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
    for char in text { send(key(String(char), in: view.window!), route) }
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
    check(alert.buttons[0].keyEquivalent == "\r", "NSAlert has its real Return default")
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
    // Before G14 an empty buffer leaves Return to the existing default. It must still do so.
    let (alert, view, actions, receipt) = modal(protectedDefault)
    enter(view, code: code)
    check(receipt.choices == [protectedDefault ? "Always allow" : "Don't allow"], "empty Return retains NSAlert default")
    check(view.field.isEnabled, "default Return did not consume typed control")
    _ = alert; _ = actions
    let (unfocusedAlert, unfocused, held, otherReceipt) = modal(protectedDefault)
    type(word(unfocused, "Always allow"), unfocused)
    check(unfocusedAlert.window.makeFirstResponder(unfocusedAlert.buttons[0]), "button can take responder")
    enter(unfocused, code: code)
    check(otherReceipt.choices == [protectedDefault ? "Always allow" : "Don't allow"], "field does not intercept another responder's Return")
    _ = held
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
    check(keys.field.stringValue == secret, "ignored keys do not alter word")
    enter(keys)
    check(keyReceipt.choices == ["Always allow"], "word with ignored keys still confirms")
    _ = keyActions
}

for character in ["ф", "ั"] {
    let (layoutAlert, layout, layoutActions, layoutReceipt) = modal()
    let layoutWord = word(layout, "Always allow")
    for char in layoutWord { send(key(character, in: layoutAlert.window, code: codes[char]!)) }
    check(layout.field.stringValue == layoutWord, "non-Latin letters and combining marks use ABC physical key codes")
    enter(layout)
    check(layoutReceipt.choices == ["Always allow"], "non-Latin layout reaches intended action")
    _ = layoutActions
}

// Latin layouts keep their own characters even when physical positions differ from ABC.
let (latinAlert, latin, latinActions, latinReceipt) = modal()
let latinWord = word(latin, "Always allow")
for char in latinWord { send(key(String(char).uppercased(), in: latinAlert.window, code: 0, flags: [.shift, .capsLock])) }
check(latin.field.stringValue == latinWord, "Latin layout characters and uppercase survive key-code fallback")
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
guarded.field.setAccessibilityValue("oak")
check(guarded.field.stringValue.isEmpty && guardReceipt.choices.isEmpty, "AX write clears physical buffer")
guarded.field.stringValue = word(guarded, "Always allow")
enter(guarded, .window)
check(guardReceipt.choices.isEmpty, "display value grants no typed authority")
type(word(guarded, "Always allow"), guarded); enter(guarded, .window, trusted: false)
check(guardReceipt.choices.isEmpty && guarded.field.stringValue.isEmpty, "posted Return cannot confirm physical word")
type("o", guarded)
send(key("x", in: guardAlert.window)); send(key("\u{7f}", in: guardAlert.window, code: 51))
check(guarded.field.stringValue == "o", "Backspace removes one physical letter")
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
        var answers: [String] = []
        let target: [String: Any] = ["kind": "handoff", "session": "fixture-session", "turn": "fixture-turn", "tab": "t1"]
        let card = AskCardPanel(automaticCard(target, ["continue", "cancel"])!, deadline: deadline) { answers.append($0) }
        let view = card.typing!, window = card.panel
        card.layout(in: NSRect(x: -20000, y: -20000, width: 480, height: 480)); _ = window.windowRef
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
            let event = NSEvent.mouseEvent(with: .leftMouseDown, location: view.field.convert(.zero, to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            view.field.mouseDown(with: event)
        }
        check(window.canBecomeKey && fixtureKeyWindow === window && window.firstResponder === view.field, "explicit \(focus) focus opens handoff keyboard path")
        enter(view, route)
        send(key(" ", in: window, code: 49), route)
        check(answers.isEmpty, "empty Return and Space cannot Continue")
        // Even a focused protected button must retain its mouse-only guard.
        _ = window.makeFirstResponder(card.buttons[1])
        for (text, code) in [(" ", UInt16(49)), ("\r", 36)] { send(key(text, in: window, code: code), route) }
        check(answers.isEmpty, "button focus cannot turn ordinary Space or Return into Continue")
        check(view.field.accessibilityPerformPress(), "field can be refocused")
        type("wrong", view, route); enter(view, route)
        check(answers.isEmpty && view.field.isEnabled, "wrong handoff word is retryable")
        type(word(view, "Continue"), view, route); enter(view, route, trusted: false)
        check(answers.isEmpty && view.field.stringValue.isEmpty, "posted Return cannot complete handoff word")
        type(word(view, "Continue"), view, route)
        // A page event with the same Return never completes a card's pending word.
        send(key("\r", in: page, code: 36), route)
        check(answers.isEmpty, "foreign page Return cannot complete handoff word")
        enter(view, route, code: focus == "focused" ? 76 : 36)
        check(answers == ["continue"] && card.finished && !view.field.isEnabled, "focused physical word confirms handoff exactly once: \(route), \(focus)")
        check(!window.isVisible && !page.isVisible, "handoff and page were never ordered")
        card.close()
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
