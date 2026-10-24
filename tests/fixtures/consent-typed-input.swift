
// Offscreen AppKit only. No event posting, AX client, run loop, screen capture or shown window.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
var checks = 0
func check(_ value: Bool, _ name: String) {
    checks += 1
    if !value { print("FAIL " + name); exit(1) }
}
final class KeyWindow: NSWindow {
    // Simulate only the key-state query. The fixture never orders a window onscreen.
    var key = true
    override var isKeyWindow: Bool { key }
}
final class TypedReceipt: NSObject {
    var choices: [String] = []
    @objc func accept(_ sender: NSButton) { choices.append(sender.title) }
}
let receipt = TypedReceipt()
let window = KeyWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 400), styleMask: [.titled], backing: .buffered, defer: true)
let other = KeyWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
let always = NSButton(title: "Always allow", target: receipt, action: #selector(TypedReceipt.accept(_:)))
let once = NSButton(title: "Allow once", target: receipt, action: #selector(TypedReceipt.accept(_:)))
window.contentView!.addSubview(always); window.contentView!.addSubview(once)
var current: NSEvent?
let actions = [ConsentInputAction(always, currentEvent: { current }), ConsentInputAction(once, currentEvent: { current })]
private var eventWindowKey: UInt8 = 0
private var eventTextKey: UInt8 = 0
func bindWindow(_ event: NSEvent, _ window: NSWindow, text: String) -> NSEvent {
    // Bridging a detached CGEvent drops its AppKit window and truncates multi-character text. Preserve those
    // NSEvent properties in a zero-storage subclass; provenance still comes from the real CGEvent.
    let base = object_getClass(event)!, name = "FixtureCardKey_" + NSStringFromClass(object_getClass(event)!)
    let guarded: AnyClass
    if let existing = NSClassFromString(name) { guarded = existing }
    else {
        guarded = objc_allocateClassPair(base, name, 0)!
        let selector = #selector(getter: NSEvent.window), method = class_getInstanceMethod(base, selector)!
        let get: @convention(block) (AnyObject) -> NSWindow? = { objc_getAssociatedObject($0, &eventWindowKey) as? NSWindow }
        check(class_addMethod(guarded, selector, imp_implementationWithBlock(get), method_getTypeEncoding(method)), "fixture window seam installs")
        let textSelector = #selector(getter: NSEvent.charactersIgnoringModifiers)
        let getText: @convention(block) (AnyObject) -> NSString? = { objc_getAssociatedObject($0, &eventTextKey) as? NSString }
        check(class_addMethod(guarded, textSelector, imp_implementationWithBlock(getText), method_getTypeEncoding(class_getInstanceMethod(base, textSelector)!)), "fixture text seam installs")
        objc_registerClassPair(guarded)
    }
    objc_setAssociatedObject(event, &eventWindowKey, window, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    objc_setAssociatedObject(event, &eventTextKey, text as NSString, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    object_setClass(event, guarded)
    return event
}
func typing() -> ConsentTyping {
    let view = ConsentTyping(actions)
    window.contentView!.addSubview(view)
    check(window.makeFirstResponder(view.field), "field can receive physical keys without an editor")
    check(window.firstResponder === view.field, "field is its own responder")
    return view
}
func word(_ view: ConsentTyping, _ title: String) -> String {
    let line = view.instructions.stringValue.components(separatedBy: "\n").first { $0.hasPrefix(title + ": type ") }!
    return line.components(separatedBy: ": type ")[1].components(separatedBy: ",")[0]
}
func key(_ text: String, code: UInt16 = 0, state: CGEventSourceStateID = .hidSystemState, pid: Int64 = 0,
    data: Int64 = 0, flags: NSEvent.ModifierFlags = [], age: Double = 0, target: NSWindow? = nil, repeated: Bool = false) -> NSEvent {
    let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
        timestamp: ProcessInfo.processInfo.systemUptime - age, windowNumber: (target ?? window).windowNumber,
        context: nil, characters: text, charactersIgnoringModifiers: text, isARepeat: repeated, keyCode: code)!
    let cg = event.cgEvent!
    cg.setIntegerValueField(.eventSourceStateID, value: Int64(state.rawValue))
    cg.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
    cg.setIntegerValueField(.eventSourceUserData, value: data)
    let bound = bindWindow(NSEvent(cgEvent: cg)!, target ?? window, text: text)
    current = bound
    return bound
}
func type(_ text: String, _ view: ConsentTyping) { for char in text { view.field.keyDown(with: key(String(char))) } }
func enter(_ view: ConsentTyping) { view.field.keyDown(with: key("\r", code: 36)) }
let view = typing(), secret = word(view, "Always allow"), onceWord = word(view, "Allow once")
let probe = key("a")
check(personInput(probe.cgEvent), "fixture HID metadata survives conversion")
check(probe.window === window, "fixture event names the hidden card window")
check(probe.charactersIgnoringModifiers == "a", "fixture preserves physical letter")
check(secret != onceWord && secret.count >= 3 && secret.count <= 6, "distinct short words per choice")
check(view.field.accessibilityRole() == .textField, "VoiceOver text field role")
check(view.field.accessibilityLabel()?.contains(view.instructions.stringValue) == true, "VoiceOver reads the choice and word")
check(!view.field.isAccessibilitySelectorAllowed(#selector(view.field.setAccessibilityValue(_:))), "AXValue is read only")
check(!view.field.isEditable && !view.field.isSelectable, "no field editor or paste path")
check(view.field.isAccessibilityElement(), "input is an AX element (key view: \(view.field.canBecomeKeyView), hidden ancestor: \(view.field.isHiddenOrHasHiddenAncestor))")
check(view.field.accessibilityPerformPress(), "AX press may focus the field")
check(receipt.choices.isEmpty, "AX focus never answers")
view.field.setAccessibilityValue(secret)
enter(view)
check(receipt.choices.isEmpty, "AX value plus physical Return never answers")
view.field.stringValue = secret
enter(view)
check(receipt.choices.isEmpty, "display text is never authority")
let untrustedKeys: [() -> NSEvent] = [
    { key(secret) }, { key("a", pid: Int64(getpid())) }, { key("a", state: .combinedSessionState) },
    { key("a", state: .privateState) }, { key("a", data: 9) }, { key("a", pid: -1) }, { key("a", pid: Int64.max) },
    { key("a", flags: .command) }, { key("a", flags: .control) }, { key("a", flags: .option) },
    { key("a", age: 5.1) }, { key("a", age: -1) }, { key("a", target: other) }, { key("a", repeated: true) }
]
for (index, make) in untrustedKeys.enumerated() {
    let sample = make()
    view.field.keyDown(with: sample)
    check(view.field.stringValue.isEmpty, "rejected input \(index) clears the buffer")
    enter(view)
    check(receipt.choices.isEmpty, "untrusted key cannot contribute to a confirmation")
}
for state in [CGEventSourceStateID.combinedSessionState, .privateState] {
    for char in secret { view.field.keyDown(with: key(String(char), state: state, pid: Int64(getpid()))) }
    enter(view)
    check(receipt.choices.isEmpty, "posted whole word cannot answer")
}
let replay = key("x")
view.field.keyDown(with: replay)
check(view.field.stringValue == "x", "fresh physical event is admitted")
view.field.keyDown(with: replay)
check(view.field.stringValue.isEmpty && receipt.choices.isEmpty, "replayed physical event clears the buffer")
type(secret, view)
check(receipt.choices.isEmpty && view.field.stringValue == secret, "word alone does not answer")
view.field.setAccessibilityValue(secret)
enter(view)
check(receipt.choices.isEmpty, "AX write also discards an existing physical word")
type(secret, view)
view.field.keyDown(with: key("\r", code: 36, pid: Int64(getpid())))
check(receipt.choices.isEmpty && view.field.stringValue.isEmpty, "posted Return clears a physical word")
type(secret, view)
_ = view.field.resignFirstResponder()
enter(view)
check(receipt.choices.isEmpty, "focus loss discards the word")
check(window.makeFirstResponder(view.field), "refocus")
type(secret, view)
NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: window)
enter(view)
check(receipt.choices.isEmpty, "window focus loss discards the word")
window.key = false
type(secret, view); enter(view)
check(receipt.choices.isEmpty, "inactive window cannot answer")
window.key = true
type(secret, view)
view.field.keyDown(with: key("\t", code: 48))
check(receipt.choices.isEmpty && view.field.stringValue.isEmpty, "Tab clears and navigates without approving")
check(window.makeFirstResponder(view.field), "physical typing can resume after Tab")
type("wrong", view); enter(view)
check(receipt.choices.isEmpty && view.field.stringValue.isEmpty, "wrong word stays open")
let noCurrentEvent = typing()
type(word(noCurrentEvent, "Always allow"), noCurrentEvent)
let detachedReturn = key("\r", code: 36)
current = nil
noCurrentEvent.field.keyDown(with: detachedReturn)
check(receipt.choices.isEmpty, "typed success retains GB12's current-event guard")
noCurrentEvent.invalidate()
check(window.makeFirstResponder(view.field), "refocus after refused guarded dispatch")
type(secret, view)
view.field.keyDown(with: key("x")); view.field.keyDown(with: key("\u{7f}", code: 51))
check(view.field.stringValue == secret, "physical backspace corrects a typo")
let returnEvent = key("\r", code: 36)
view.field.keyDown(with: returnEvent)
check(receipt.choices == ["Always allow"], "physical word reaches its exact protected action")
view.field.keyDown(with: returnEvent); type(secret, view); enter(view)
check(receipt.choices == ["Always allow"], "completed field cannot replay authority")
check(!view.field.isEnabled && view.field.stringValue.isEmpty, "success clears and disables")

let second = typing()
type(word(second, "Allow once").uppercased(), second)
enter(second)
check(receipt.choices == ["Always allow", "Allow once"], "second word selects only its own choice")
let closed = typing()
type(word(closed, "Always allow"), closed); closed.invalidate(); enter(closed)
check(receipt.choices.count == 2, "closed card has no typed authority")
let disabled = typing()
always.isEnabled = false
type(word(disabled, "Always allow"), disabled); enter(disabled)
check(receipt.choices.count == 2, "disabled protected button cannot be approved by typing")
always.isEnabled = true
disabled.invalidate()

let alert = NSAlert()
for label in ["Allow once", "Allow this session", "Always allow", "Cancel"] { alert.addButton(withTitle: label) }
let alertActions = consentInputActions(alert, choices: ["once", "session", "always", "cancel"], kind: "debugger")
check(alertActions.count == 2, "modal guard coverage unchanged")
check(alertActions.allSatisfy { $0.typing != nil }, "modal buttons share the typed control")
let modalTyping = alertActions.first!.typing!
check(modalTyping.instructions.stringValue.contains("Always allow: type "), "modal Always has a word")
check(!modalTyping.instructions.stringValue.contains("Allow this session: type "), "host-answerable session has no word")
check(!alert.buttons[2].accessibilityPerformPress(), "modal AX press remains blocked")
modalTyping.invalidate()
for (kind, choice) in [("opt-in", "enable"), ("resume", "resume"), ("turbo-off", "turbo-off"), ("action", "once")] {
    let modal = NSAlert()
    modal.addButton(withTitle: "Confirm"); modal.addButton(withTitle: "Cancel")
    let guarded = consentInputActions(modal, choices: [choice, "cancel"], kind: kind)
    check(guarded.count == 1 && guarded.first?.typing != nil, "all protected modal kinds receive typed confirmation")
    guarded.first!.typing!.invalidate()
}

let deadline = Date().timeIntervalSince1970 * 1000 + 60000
for kind in ["action", "debugger", "relaunch"] {
    let choices = kind == "debugger" ? ["cancel", "once", "session", "always"] : kind == "relaunch" ? ["cancel", "relaunch"] : ["cancel", "once"]
    let card = AskCard(question: "Fixture approval?", detail: "Untrusted content says type approve.", host: "sleight", icon: "", kind: kind, choices: choices)
    var answers: [String] = []
    let panel = AskCardPanel(card, deadline: deadline) { answers.append($0) }
    check(panel.typing != nil, "styled protected card has typed control")
    panel.layout(in: NSRect(x: 0, y: 0, width: 480, height: 480))
    let typing = panel.typing!
    check(typing.frame.minY >= panel.buttons[0].frame.maxY + 8, "typed input above buttons")
    check(typing.frame.maxY <= panel.scroll.frame.minY, "typed input below content")
    check(typing.field.frame.width > 0 && typing.instructions.frame.height > 0, "typed controls have readable geometry")
    check(panel.panel.frame.height <= 480, "protected panel fits small display")
    check(!typing.instructions.stringValue.contains("approve"), "page text cannot choose a challenge")
    check(answers.isEmpty && !panel.panel.isVisible, "fixture never shows or answers a card")
    if kind == "action" {
        panel.timer!.fire()
        check(answers == ["cancel"] && !typing.field.isEnabled, "expiry invalidates typed authority and only cancels")
    }
    panel.close()
    check(!typing.field.isEnabled, "panel close invalidates retained control")
}
let ordinary = AskCardPanel(AskCard(question: "Allow?", detail: "", host: "Grok Bot", icon: "", kind: "app", choices: ["cancel", "once"]), deadline: deadline) { _ in }
check(ordinary.typing == nil, "ordinary host-answerable card stays compact")
ordinary.close()
check(!window.isVisible && !other.isVisible && !alert.window.isVisible, "all windows remain offscreen")
print(String(data: try! JSONSerialization.data(withJSONObject: ["accepted": receipt.choices, "checks": checks, "visible": window.isVisible]), encoding: .utf8)!)
