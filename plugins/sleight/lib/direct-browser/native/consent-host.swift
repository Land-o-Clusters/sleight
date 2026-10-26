// Original sleight source. UI choices come only from native button/menu events.
// No accessibility grant, synthetic input, browser launch or page bridge.
// With --hand the same binary is the ghost hand's host instead: it only draws, and never writes stdout.
import AppKit
import Foundation
import CoreFoundation
import QuartzCore
import ImageIO
import Carbon.HIToolbox
import ObjectiveC
import Darwin
import os.log
import LocalAuthentication
import CryptoKit

// BEGIN PERSON INPUT
private var consentFeedbackKey: UInt8 = 0
let consentInputMessage = "This button needs your own click or key press."
func refuseConsentInput(_ button: NSButton? = nil) {
    if let button = button, let label = objc_getAssociatedObject(button, &consentFeedbackKey) as? NSTextField {
        label.stringValue = consentInputMessage
    }
    os_log("PERSON_INPUT_REQUIRED", log: OSLog(subsystem: "com.sleight.consent", category: "input"), type: .error)
    FileHandle.standardError.write(Data("sleight consent refused: PERSON_INPUT_REQUIRED\n".utf8))
}
// Source state alone is insufficient: a poster can select the HID state table too.
func personInput(_ event: CGEvent?) -> Bool {
    guard let event = event, [.leftMouseDown, .leftMouseUp, .keyDown, .keyUp].contains(event.type),
        event.getIntegerValueField(.eventSourceStateID) == Int64(CGEventSourceStateID.hidSystemState.rawValue),
        event.getIntegerValueField(.eventSourceUserData) == 0 else { return false }
    let pid = event.getIntegerValueField(.eventSourceUnixProcessID)
    if pid == 0 { return true }
    guard pid > 0, pid <= Int64(Int32.max) else { return false }
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(Int32(pid), &path, UInt32(path.count)) > 0 else { return false }
    // Canonicalize process paths through filesystem metadata only, without loading a file or resource.
    let systemServer = ("/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer" as NSString).resolvingSymlinksInPath
    return (String(cString: path) as NSString).resolvingSymlinksInPath == systemServer
}
// One activation rule for consent, the cursor picker and the pause control. AX entry points refuse separately,
// even if AppKit still has a fresh hardware event from an earlier interaction.
func personActivation(_ event: NSEvent?, windowMatches: Bool, keyboard: Bool = true,
    highlighted: Bool = true, accessibility: Bool = false, now: Double = ProcessInfo.processInfo.systemUptime) -> Bool {
    guard !accessibility, let event = event, windowMatches,
        event.timestamp.isFinite, event.timestamp >= 0, event.timestamp <= now, now - event.timestamp < 5,
        let cg = event.cgEvent, cg.getIntegerValueField(.eventSourceUnixProcessID) == 0, personInput(cg) else { return false }
    if event.type == .leftMouseUp { return true }
    return keyboard && highlighted && event.type == .keyDown && !event.isARepeat && [36, 49, 76].contains(event.keyCode)
}
func personActivation(_ event: NSEvent?, in window: NSWindow?, keyboard: Bool = true, highlighted: Bool = true) -> Bool {
    personActivation(event, windowMatches: event?.window === window, keyboard: keyboard, highlighted: highlighted)
}
func personChoice(_ kind: String, _ choice: String) -> Bool {
    if ["cancel", "decline", "session"].contains(choice) { return false }
    // A debugger's Once is also a consent to debugging. Plain session app approvals remain host-answerable.
    return choice == "always" || ["action", "debugger", "relaunch", "opt-in", "resume", "turbo-off", "handoff"].contains(kind)
}
// NSAlert owns its NSButtons and their private subclasses. Add only an AX override to a zero-storage runtime
// subclass of the actual button class, preserving its layout, key equivalents and original modal action.
func refuseAccessibilityPress(_ button: NSButton) -> Bool {
    guard let base = object_getClass(button) else { return false }
    // Layout may have put a KVO subclass above ours. Never replace that observer's class.
    var ancestor: AnyClass? = base
    while let next = ancestor {
        if NSStringFromClass(next).hasPrefix("SleightPersonInput_") { return true }
        ancestor = class_getSuperclass(next)
    }
    let name = "SleightPersonInput_" + NSStringFromClass(base)
    if let guarded = NSClassFromString(name) { object_setClass(button, guarded); return true }
    let selector = #selector(NSButton.accessibilityPerformPress)
    let legacySelector = #selector(NSButton.accessibilityPerformAction(_:))
    guard let method = class_getInstanceMethod(base, selector), let types = method_getTypeEncoding(method),
        let legacy = class_getInstanceMethod(base, legacySelector), let legacyTypes = method_getTypeEncoding(legacy),
        let guarded = objc_allocateClassPair(base, name, 0) else { return false }
    let reject: @convention(block) (AnyObject) -> Bool = { sender in refuseConsentInput(sender as? NSButton); return false }
    let implementation = imp_implementationWithBlock(reject)
    typealias LegacyAction = @convention(c) (AnyObject, Selector, NSString) -> Void
    let previous = unsafeBitCast(method_getImplementation(legacy), to: LegacyAction.self)
    let rejectLegacy: @convention(block) (AnyObject, NSString) -> Void = { sender, action in
        if action as String == NSAccessibility.Action.press.rawValue { refuseConsentInput(sender as? NSButton) }
        else { previous(sender, legacySelector, action) }
    }
    let legacyImplementation = imp_implementationWithBlock(rejectLegacy)
    guard class_addMethod(guarded, selector, implementation, types),
        class_addMethod(guarded, legacySelector, legacyImplementation, legacyTypes) else {
        imp_removeBlock(implementation); imp_removeBlock(legacyImplementation); objc_disposeClassPair(guarded); return false
    }
    objc_registerClassPair(guarded)
    object_setClass(button, guarded)
    return true
}
final class ConsentInputAction: NSObject {
    weak var button: NSButton?
    weak var typing: ConsentTyping?
    let originalTarget: AnyObject?, originalAction: Selector?
    let currentEvent: () -> NSEvent?
    let mouseOnly: Bool
    init(_ button: NSButton, mouseOnly: Bool = false, currentEvent: @escaping () -> NSEvent? = { NSApp.currentEvent }) {
        self.button = button
        originalTarget = button.target; originalAction = button.action; self.currentEvent = currentEvent; self.mouseOnly = mouseOnly
        super.init()
        // Failure leaves the protected button disabled. It must never fall back to the unguarded action.
        guard refuseAccessibilityPress(button) else { button.isEnabled = false; refuseConsentInput(button); return }
        button.target = self; button.action = #selector(press(_:))
    }
    @objc @discardableResult func press(_ sender: NSButton) -> Bool {
        return dispatch(sender)
    }
    func pressTyped(_ sender: NSButton, from field: ConsentWordField) -> Bool {
        guard typing?.field === field, field.isEnabled, let window = sender.window,
            window.isKeyWindow, window.firstResponder === field else { refuseConsentInput(sender); return false }
        return dispatch(sender, typed: true)
    }
    private func dispatch(_ sender: NSButton, typed: Bool = false) -> Bool {
        let event = currentEvent()
        guard let event = event,
            !typed || event.type == .keyDown,
            personActivation(event, in: sender.window, keyboard: !mouseOnly || typed)
            else { refuseConsentInput(sender); return false }
        return sender.sendAction(originalAction, to: originalTarget)
    }
}

protocol ConsentWordFocusing: AnyObject {
    func focusWordField(_ field: ConsentWordField) -> Bool
}
// No field editor: only keyDown can change the private buffer. AX reads only its masked length.
final class ConsentWordField: NSTextField {
    private static let abcLayout: CFData? = {
        let filter = [kTISPropertyInputSourceID as String: "com.apple.keylayout.ABC"] as CFDictionary
        guard let sources = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource],
            let source = sources.first,
            let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        return Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue()
    }()
    private static func letter(_ event: NSEvent) -> String? {
        guard let text = event.charactersIgnoringModifiers?.lowercased(), text.count == 1 else { return nil }
        func latin(_ value: String) -> String? {
            guard value.utf8.count == 1, let byte = value.utf8.first, (97...122).contains(byte) else { return nil }
            return value
        }
        if let letter = latin(text) { return letter }
        // Retain Latin layouts' own letters. For a non-Latin letter, use the same physical key in ABC.
        guard text.unicodeScalars.allSatisfy({ CharacterSet.letters.contains($0) }),
            let data = abcLayout, let bytes = CFDataGetBytePtr(data) else { return nil }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        var deadKey: UInt32 = 0, count = 0
        var characters = [UniChar](repeating: 0, count: 4)
        let status = UCKeyTranslate(layout, event.keyCode, UInt16(kUCKeyActionDown), 0,
            UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKey,
            characters.count, &count, &characters)
        guard status == noErr, count == 1 else { return nil }
        return latin(String(utf16CodeUnits: characters, count: count).lowercased())
    }
    private var entries: [String: ConsentInputAction]
    private var typed = ""
    private var maskedText: String { String(repeating: "•", count: typed.count) }
    private var dispatching = false
    private var lastTimestamp: TimeInterval = -.infinity
    private var focusObserver: NSObjectProtocol?
    let accessibilityState: () -> (voiceOver: Bool, switchControl: Bool)
    init(_ entries: [String: ConsentInputAction], instructions: String,
        accessibilityState: @escaping () -> (voiceOver: Bool, switchControl: Bool) = {
            (NSWorkspace.shared.isVoiceOverEnabled, NSWorkspace.shared.isSwitchControlEnabled)
        }) {
        self.entries = entries
        self.accessibilityState = accessibilityState
        super.init(frame: .zero)
        isEditable = false; isSelectable = false; isBezeled = true; drawsBackground = true
        setAccessibilityElement(true)
        placeholderString = "Type a word, then Return"
        setAccessibilityLabel("Keyboard confirmation. " + instructions)
        setAccessibilityHelp("Use your physical keyboard in this sleight card. Pasting and automated input cannot confirm.")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { if let observer = focusObserver { NotificationCenter.default.removeObserver(observer) } }
    override var acceptsFirstResponder: Bool { isEnabled }
    override var canBecomeKeyView: Bool { isEnabled && !isHiddenOrHasHiddenAncestor }
    // Keep plaintext out of NSTextField and its drawing cell, including programmatic value writes.
    override var stringValue: String {
        get { super.stringValue }
        set { super.stringValue = maskedText }
    }
    override var attributedStringValue: NSAttributedString {
        get { super.attributedStringValue }
        set { super.stringValue = maskedText }
    }
    override var objectValue: Any? {
        get { super.objectValue }
        set { super.stringValue = maskedText }
    }
    override func accessibilityRole() -> NSAccessibility.Role? { .textField }
    override func accessibilityValue() -> String? { maskedText }
    override func accessibilityString(for range: NSRange) -> String? {
        guard range.location >= 0, range.length >= 0,
            range.location <= typed.count, range.length <= typed.count - range.location else { return nil }
        return String(repeating: "•", count: range.length)
    }
    override func accessibilityAttributedString(for range: NSRange) -> NSAttributedString? {
        guard let text = accessibilityString(for: range) else { return nil }
        return NSAttributedString(string: text)
    }
    override func accessibilitySelectedText() -> String? { "" }
    override func accessibilitySelectedTextRange() -> NSRange { NSRange(location: typed.count, length: 0) }
    override func accessibilityNumberOfCharacters() -> Int { typed.count }
    override func accessibilityVisibleCharacterRange() -> NSRange { NSRange(location: 0, length: typed.count) }
    override func accessibilityAttributeValue(_ attribute: NSAccessibility.Attribute) -> Any? {
        switch attribute {
        case .value: return accessibilityValue()
        case .selectedText: return accessibilitySelectedText()
        case .selectedTextRange: return NSValue(range: accessibilitySelectedTextRange())
        case .numberOfCharacters: return accessibilityNumberOfCharacters()
        case .visibleCharacterRange: return NSValue(range: accessibilityVisibleCharacterRange())
        default: return super.accessibilityAttributeValue(attribute)
        }
    }
    override func accessibilityAttributeValue(_ attribute: NSAccessibility.ParameterizedAttribute, forParameter parameter: Any?) -> Any? {
        if attribute == .stringForRange || attribute == .attributedStringForRange {
            guard let value = parameter as? NSValue,
                String(cString: value.objCType) == String(cString: NSValue(range: NSRange()).objCType) else { return nil }
            let range = value.rangeValue
            return attribute == .stringForRange ? accessibilityString(for: range) : accessibilityAttributedString(for: range)
        }
        return super.accessibilityAttributeValue(attribute, forParameter: parameter)
    }
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if selector == #selector(setAccessibilityValue(_:)) { return false }
        return super.isAccessibilitySelectorAllowed(selector)
    }
    override func setAccessibilityValue(_ value: Any?) { refuse() }
    private func focusForTyping() -> Bool {
        guard isEnabled else { return false }
        if let panel = window as? ConsentWordFocusing { return panel.focusWordField(self) }
        return window?.makeFirstResponder(self) ?? false
    }
    private func focusFromAccessibility() -> Bool {
        if window is ConsentWordFocusing {
            let state = accessibilityState()
            guard state.voiceOver || state.switchControl else { refuse(); return false }
        }
        return focusForTyping()
    }
    override func setAccessibilityFocused(_ focused: Bool) {
        if focused { guard focusFromAccessibility() else { return } }
        else if window?.firstResponder === self { _ = window?.makeFirstResponder(nil) }
        super.setAccessibilityFocused(focused)
    }
    override func accessibilityPerformPress() -> Bool {
        return focusFromAccessibility()
    }
    override func mouseDown(with event: NSEvent) {
        let now = ProcessInfo.processInfo.systemUptime
        guard event.type == .leftMouseDown, event.window === window,
            event.timestamp <= now, now - event.timestamp < 5,
            personInput(event.cgEvent) else { refuse(); return }
        _ = focusForTyping()
    }
    override func resignFirstResponder() -> Bool { clear(); return super.resignFirstResponder() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow(); clear()
        if let observer = focusObserver { NotificationCenter.default.removeObserver(observer); focusObserver = nil }
        if let window = window {
            focusObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: nil) { [weak self] _ in self?.clear() }
        }
    }
    private func clear() { typed = ""; stringValue = "" }
    private func refuse() { clear(); refuseConsentInput(entries.values.first?.button) }
    func invalidate() { clear(); entries.removeAll(); isEnabled = false }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Let an empty field retain the card's existing default. A pending word owns both Return keys,
        // including a wrong word, refused event or nested dispatch, so NSAlert cannot send them to another button.
        guard window?.firstResponder === self, !typed.isEmpty || dispatching,
            event.type == .keyDown, event.keyCode == 36 || event.keyCode == 76 else {
            return super.performKeyEquivalent(with: event)
        }
        keyDown(with: event)
        return true
    }
    override func keyDown(with event: NSEvent) {
        guard !dispatching else { return }
        if typed.isEmpty && (event.keyCode == 36 || event.keyCode == 76) { return }
        let letter = Self.letter(event)
        // Navigation, digits, punctuation and dead keys do not change or refuse a pending word.
        let multipleCharacters = (event.charactersIgnoringModifiers?.count ?? 0) > 1
        guard [36, 76, 48, 51].contains(event.keyCode) || letter != nil || multipleCharacters else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard isEnabled, !entries.isEmpty, let window = window, window.isKeyWindow,
            window.firstResponder === self, event.window === window, event.type == .keyDown,
            event.timestamp <= now, now - event.timestamp < 5, event.timestamp > lastTimestamp,
            !event.isARepeat, personInput(event.cgEvent),
            event.modifierFlags.intersection([.command, .control, .option, .function]).isEmpty else { refuse(); return }
        lastTimestamp = event.timestamp
        // Tab changes the responder only. It never answers, including when Switch Control focuses this field through AX.
        if event.keyCode == 48 {
            clear()
            if event.modifierFlags.contains(.shift) { window.selectPreviousKeyView(self) } else { window.selectNextKeyView(self) }
            return
        }
        if event.keyCode == 36 || event.keyCode == 76 {
            guard let action = entries[typed], let button = action.button, button.isEnabled,
                button.window === window else { refuse(); return }
            // Clear the word and block nested input before dispatch, but leave the field answerable if press refuses.
            clear(); dispatching = true
            let pressed = action.pressTyped(button, from: self)
            dispatching = false
            if pressed { invalidate() }
            return
        }
        if event.keyCode == 51 { if !typed.isEmpty { typed.removeLast() } }
        else {
            guard let letter = letter, typed.count < 12 else { refuse(); return }
            typed += letter
        }
        stringValue = maskedText
    }
}

final class ConsentTyping: NSView {
    let instructions: NSTextField
    let field: ConsentWordField
    init(_ actions: [ConsentInputAction]) {
        // Words are local UI challenges, not secrets or bearer tokens. Provenance is checked on every key, including Return.
        let words = ["birch", "cedar", "coral", "daisy", "fern", "finch", "lake", "leaf", "maple", "moss", "oak", "pearl", "pine", "plum", "reed", "rose"].shuffled()
        let entries = zip(words, actions).map { (word: $0.0, action: $0.1) }
        let text = entries.map { "\($0.action.button?.title ?? "Confirm"): type \($0.word), then Return." }.joined(separator: "\n")
        instructions = NSTextField(wrappingLabelWithString: text)
        instructions.font = .systemFont(ofSize: 11); instructions.textColor = .secondaryLabelColor
        field = ConsentWordField(Dictionary(uniqueKeysWithValues: entries.map { ($0.word, $0.action) }), instructions: text)
        super.init(frame: .zero)
        addSubview(instructions); addSubview(field)
        for action in actions { action.typing = self }
        _ = fit(width: 360)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @discardableResult func fit(width: CGFloat) -> CGFloat {
        instructions.preferredMaxLayoutWidth = width
        let height = ceil(instructions.sizeThatFits(NSSize(width: width, height: 10000)).height)
        field.frame = NSRect(x: 0, y: 0, width: width, height: 24)
        instructions.frame = NSRect(x: 0, y: 30, width: width, height: height)
        frame.size = NSSize(width: width, height: height + 30)
        return frame.height
    }
    func invalidate() { field.invalidate() }
}
func consentInputActions(_ alert: NSAlert, choices: [String], kind: String) -> [ConsentInputAction] {
    // Reserve a line before layout so a refusal does not resize or dismiss the card. Only fixed text goes here.
    let feedback = NSTextField(wrappingLabelWithString: "")
    feedback.frame = NSRect(x: 0, y: 0, width: 360, height: 36)
    feedback.widthAnchor.constraint(equalToConstant: 360).isActive = true
    feedback.heightAnchor.constraint(equalToConstant: 36).isActive = true
    feedback.textColor = .secondaryLabelColor
    let previous = alert.accessoryView
    if let previous = previous {
        let stack = NSStackView(views: [previous, feedback])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: max(360, previous.frame.width), height: previous.frame.height + 44)
        alert.accessoryView = stack
    } else { alert.accessoryView = feedback }
    // Set the class before NSAlert's stack view registers KVO, then wrap the modal actions layout installed.
    let buttons = zip(alert.buttons, choices).compactMap { button, choice -> NSButton? in
        guard personChoice(kind, choice) else { return nil }
        objc_setAssociatedObject(button, &consentFeedbackKey, feedback, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        guard refuseAccessibilityPress(button) else { button.isEnabled = false; refuseConsentInput(button); return nil }
        return button
    }
    alert.layout()
    let actions = buttons.map { ConsentInputAction($0) }
    if !actions.isEmpty {
        let typing = ConsentTyping(actions)
        typing.widthAnchor.constraint(equalToConstant: 360).isActive = true
        typing.heightAnchor.constraint(equalToConstant: typing.frame.height).isActive = true
        let stack = NSStackView(views: [typing, alert.accessoryView!])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 360, height: typing.frame.height + alert.accessoryView!.frame.height + 8)
        alert.accessoryView = stack
        alert.layout()
    }
    return actions
}
// END PERSON INPUT

// BEGIN PERSON CONFIRM
// High-stakes settings changes (person-confirm.mjs names them) wait for macOS's own Touch ID or
// password sheet, which an agent can't answer: it has no finger, and the password sheet is the system's, which sleight's
// tools refuse to drive (own-host.mjs). The sheet's reason comes only from this table: a key, and at most a bundle id or one
// of the browser names below. On macOS it reads "consent-host is trying to <reason>."
let personConfirmReasons: [String: (plain: String, subject: String?)] = [
    "turbo-on": ("turn on sleight turbo", "turn on sleight turbo for %@"),
    "turbo-app-on": ("let sleight turbo drive an app", "let sleight turbo drive %@"),
    "permissions-unblock": ("lift one of sleight's blocks", "let sleight act in %@ again"),
    "permissions-sites": ("change the sites sleight may act on", nil),
    "permissions-repair": ("repair sleight's permissions file", nil),
    "routine-add": ("install a sleight routine", nil),
    "routine-unlock": ("clear a sleight routine's run lock", nil),
    "watch-add": ("install a sleight watch", nil),
    "watch-unlock": ("clear a sleight watch's run lock", nil),
    "settings": ("change sleight's settings", nil),
]
let personConfirmBrowsers: Set<String> = ["Google Chrome", "Helium", "Google Chrome Beta", "Google Chrome Dev", "Google Chrome Canary",
    "Chromium", "Brave Browser", "Microsoft Edge", "Vivaldi"]
func personConfirmSubject(_ value: String) -> Bool {
    personConfirmBrowsers.contains(value) || value.count <= 100 && value.range(of: #"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$"#, options: .regularExpression) != nil
}
/// The sheet's reason for [key] or [key, subject], or nil for anything the table doesn't hold.
func personConfirmReason(_ arguments: [String]) -> String? {
    guard (1...2).contains(arguments.count), let entry = personConfirmReasons[arguments[0]] else { return nil }
    if arguments.count == 1 { return entry.plain }
    guard let template = entry.subject, personConfirmSubject(arguments[1]) else { return nil }
    return template.replacingOccurrences(of: "%@", with: arguments[1])
}
// The helper's exit codes, which person-confirm.mjs reads.
enum PersonConfirmResult: Int32 { case confirmed = 0, failed = 1, cancelled = 2, timedOut = 3, unavailable = 69 }
/// The seam around LocalAuthentication: whether the Mac can ask, ask once (done is called once), and withdraw the sheet.
/// Tests pass a stand-in; nothing else replaces localAuthentication().
struct PersonEvaluator {
    let available: () -> Bool
    let evaluate: (String, @escaping (PersonConfirmResult) -> Void) -> Void
    let cancel: () -> Void
}
func localAuthentication() -> PersonEvaluator {
    let context = LAContext()
    return PersonEvaluator(
        available: { var error: NSError?; return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) },
        evaluate: { reason, done in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { passed, error in
                let code = (error as? LAError)?.code
                done(passed ? .confirmed : code == .userCancel || code == .systemCancel || code == .appCancel ? .cancelled : .failed)
            }
        },
        cancel: { context.invalidate() })
}
/// One answer per ask, on `queue`: the person's, unavailable when the Mac can't ask (no Touch ID and no password), or timedOut
/// after `timeout` seconds, when the sheet is withdrawn. The returned function cancels: it withdraws the sheet and answers
/// cancelled. Only confirmed lets a change through.
@discardableResult
func confirmPerson(_ reason: String, evaluator: PersonEvaluator, timeout: Double = 60, queue: DispatchQueue = .main,
    done: @escaping (PersonConfirmResult) -> Void) -> () -> Void {
    guard evaluator.available() else { queue.async { done(.unavailable) }; return {} }
    var answered = false
    let finish: (PersonConfirmResult) -> Void = { result in queue.async { if !answered { answered = true; done(result) } } }
    let timer = DispatchWorkItem { evaluator.cancel(); finish(.timedOut) }
    queue.asyncAfter(deadline: .now() + timeout, execute: timer)
    evaluator.evaluate(reason) { result in timer.cancel(); finish(result) }
    return { timer.cancel(); evaluator.cancel(); finish(.cancelled) }
}
// END PERSON CONFIRM

// BEGIN SESSION FRAME
func sessionFrame(_ data: [String: Any], _ choices: [String]) -> (kind: String, session: String)? {
    guard Set(data.keys) == Set(["kind", "session", "epoch"]),
        let kind = data["kind"] as? String, ["opt-in", "resume"].contains(kind),
        let session = data["session"] as? String, !session.isEmpty, session.count <= 128,
        session.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
        let epoch = data["epoch"] as? NSNumber, CFGetTypeID(epoch) != CFBooleanGetTypeID(),
        epoch.doubleValue >= 0, epoch.doubleValue.rounded() == epoch.doubleValue,
        choices == [kind == "opt-in" ? "enable" : "resume", "cancel"] else { return nil }
    return (kind, session)
}
// END SESSION FRAME

// BEGIN OPERATION TEXT
func operationCardText(_ operation: [String: Any], scope: String?) -> (body: String, allow: String)? {
    guard let bytes = try? JSONSerialization.data(withJSONObject: operation, options: [.prettyPrinted, .sortedKeys]),
        let text = String(data: bytes, encoding: .utf8) else { return nil }
    return ((scope.map { $0 + "\n\n" } ?? "") + "Page labels are observations. Review this exact operation:\n" + text,
        scope == "Allow for this Grok Bot session only" ? "Allow this session" : "Allow once")
}
// END OPERATION TEXT

// BEGIN APP FRAME
// Debugger and relaunch cards for an Electron app. Exact keys and exact choice sets: Always is offered only on a
// debugger card for a persistent profile, and a relaunch card never offers a standing choice.
func appFrame(_ data: [String: Any], _ choices: [String]) -> (kind: String, app: [String: Any], session: String, turn: String)? {
    func text(_ value: Any?, _ limit: Int) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= limit,
            value.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f && !(0x80...0x9f).contains($0.value) }) else { return nil }
        return value
    }
    func count(_ value: Any?) -> Bool {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return false }
        return value.doubleValue >= 1 && value.doubleValue.rounded() == value.doubleValue
    }
    // A process, or the unlaunched form (pid 0 with birth "unlaunched", as electron-identity validates it) on a
    // debugger card only: the card names the code before sleight starts it. A relaunch card needs a running process.
    func process(_ kind: String, _ app: [String: Any]) -> Bool {
        guard let birth = text(app["pidBirth"], 64) else { return false }
        if count(app["pid"]) { return birth != "unlaunched" }
        guard let pid = app["pid"] as? NSNumber, CFGetTypeID(pid) != CFBooleanGetTypeID() else { return false }
        return kind == "debugger" && pid.doubleValue == 0 && birth == "unlaunched"
    }
    guard Set(data.keys) == Set(["kind", "app", "session", "turn", "epoch"]),
        let kind = data["kind"] as? String, ["debugger", "relaunch"].contains(kind),
        let app = data["app"] as? [String: Any],
        Set(app.keys) == Set(["name", "bundleId", "signer", "version", "runtime", "profile", "temporary", "pid", "pidBirth", "executable", "cdhash"]),
        text(app["executable"], 4096)?.hasPrefix("/") == true,
        text(app["cdhash"], 64)?.range(of: "^([0-9a-f]{40}|[0-9a-f]{64})$", options: .regularExpression) != nil,
        text(app["name"], 256) != nil, text(app["signer"], 256) != nil, text(app["version"], 128) != nil, text(app["runtime"], 128) != nil,
        process(kind, app),
        let bundle = text(app["bundleId"], 255), bundle.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil,
        let profile = text(app["profile"], 4096), profile.hasPrefix("/"),
        let temporary = app["temporary"] as? NSNumber, CFGetTypeID(temporary) == CFBooleanGetTypeID(),
        let session = data["session"] as? String, !session.isEmpty, session.count <= 128,
        session.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
        let turn = text(data["turn"], 4096),
        count(data["epoch"]),
        choices == (kind == "relaunch" ? ["relaunch", "cancel"] : temporary.boolValue ? ["once", "session", "cancel"] : ["once", "session", "always", "cancel"])
        else { return nil }
    return (kind, app, session, turn)
}
func appCardText(_ card: (kind: String, app: [String: Any], session: String, turn: String)) -> (title: String, body: String, summary: String, identity: String) {
    let name = card.app["name"] as? String ?? "", version = card.app["version"] as? String ?? ""
    let bundle = card.app["bundleId"] as? String ?? "", profile = card.app["profile"] as? String ?? ""
    let pid = (card.app["pid"] as? NSNumber)?.intValue ?? 0
    let executable = card.app["executable"] as? String ?? "", signer = card.app["signer"] as? String ?? ""
    // pid 0: no process with the debugger yet. A copy the user is running without it gets its own relaunch card next.
    let process = pid == 0 ? "not connected yet (sleight starts or reopens it only after your approval)" : "\(pid)"
    let identity = "\(name) \(version)\nBundle: \(bundle)\nSigner: \(signer)\nExecutable: \(executable)\nProfile: \(profile)\nProcess: \(process)\nSession: \(card.session)"
    let title: String, explanation: String
    if card.kind == "relaunch" {
        title = "Quit and reopen " + name + " for sleight?"
        explanation = "sleight will ask " + name + " to quit through its own Quit command, then reopen it on the same profile with the debugger connection. It may come to the front briefly. Unsaved work follows the app's own prompts, and sleight answers none of them. Cancel keeps " + name + " as it is. This approval is for this process only, once."
    } else {
        title = "Let sleight control " + name + "?"
        let standing = (card.app["temporary"] as? NSNumber)?.boolValue == true ? "" : " Always allow stays until you revoke it for this build and profile."
        explanation = "The debugger lets sleight read the pages in " + name + " and operate them in the background, including anything open or signed in. This is separate from the app approval you already gave. Once ends with this turn. This session ends with the session." + standing
    }
    let summary = "\(name) \(version) · \(bundle)\n\n" + explanation
    return (title, explanation + "\n\n" + identity, summary, identity)
}
// END APP FRAME

// BEGIN STATUS MENU
// The menu bar item shows only while turbo is in use: connected, idle, paused or waiting for cleanup, or while a request
// waits for the person. Disconnected with nothing pending, it is hidden. The menu is a status block (coloured dot, bold
// state, quiet detail lines), the session controls, Turn Turbo Off… (confirmed first), Settings & Help…, and the version.
// The worker's choices map to labels here and nowhere else.
enum StatusRow: Equatable {
    case status(title: String, dot: String, details: [String])
    case action(String, choice: String)
    case confirm(String, choice: String)
    case toggle(String, choice: String, on: Bool)
    case permissions([PermissionRow])
    case usage(String)
    case help
    case separator
    case footer(String)
}
let stateWords = ["connected": "Connected", "connected-idle": "Connected", "paused": "Paused", "cleanup-required": "Cleanup needed", "disconnected": "Disconnected"]
let dotColours = ["connected": "green", "connected-idle": "green", "paused": "orange", "cleanup-required": "red", "disconnected": "gray"]
let choiceWords = ["pause": "Pause", "resume": "Resume", "disconnect": "Disconnect", "connect": "Connect", "cleanup": "Clean Up", "turbo-off": "Turn Turbo Off…", "cancel": "Cancel",
    "hand-on": "Ghost Hand", "hand-off": "Ghost Hand", "block-site": "Never Act on This Site"]
let paymentWords = ["ask": "Payments: asks unless you named the amount", "always": "Payments: always asks", "never": "Payments: asks only for ones you didn't request"]
let optOutFailed = "Couldn't turn turbo off. Run sleight-mcp turbo off."
func statusVisible(_ status: String?, requests: Int) -> Bool {
    requests > 0 || ["connected", "connected-idle", "paused", "cleanup-required"].contains(status ?? "")
}
func statusRows(_ data: [String: Any], _ choices: [String]) -> [StatusRow]? {
    // The Ghost Hand row shows the hand's setting with a checkmark, and its one choice flips it.
    let hand = data["hand"] as? String, handChoices = choices.filter { $0.hasPrefix("hand-") }
    // Never Act on <site>: the site turbo last worked on, a bare http(s) origin, and only with its choice.
    let site = (data["site"] as? String).flatMap { $0.range(of: #"^https?://[a-z0-9.-]{1,253}(:[0-9]{1,5})?$"#, options: .regularExpression) != nil ? $0 : nil }
    guard let status = data["status"] as? String, let word = stateWords[status], let dot = dotColours[status],
        choices.allSatisfy({ choiceWords[$0] != nil }), data["hand"] == nil || hand == "on" || hand == "off",
        data["site"] == nil || site != nil, !choices.contains("block-site") || site != nil,
        handChoices.isEmpty || handChoices == [hand == "on" ? "hand-off" : "hand-on"] && hand != nil else { return nil }
    let browser = (data["browser"] as? String).flatMap { name in
        !name.isEmpty && name.count <= 40 && name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == " " }) ? name : nil }
    let title = browser.map { status.hasPrefix("connected") ? word + " to " + $0 : word + " · " + $0 } ?? word
    var details: [String] = []
    // The host as the session's MCP client introduced itself ("Claude Code 2.1.289"), never a guess, and no model:
    // no host reports one through MCP.
    if let host = (data["host"] as? String).flatMap({ name in
        name.count <= 72 && name.range(of: "^[A-Za-z0-9][A-Za-z0-9 ._+-]*$", options: .regularExpression) != nil ? name : nil }) {
        details.append("Host: " + host)
    }
    if status == "connected-idle" { details.append("Its session has ended") }
    if status == "paused" { details.append("Resumes when Claude next asks, with your OK") }
    if let payments = data["payments"] as? String, let words = paymentWords[payments] { details.append(words) }
    if data["optOut"] as? String == "failed" { details.append(optOutFailed) }
    var rows: [StatusRow] = [.status(title: title, dot: dot, details: details)]
    let session = choices.filter { $0 != "turbo-off" && $0 != "block-site" && !$0.hasPrefix("hand-") }
    if !session.isEmpty { rows.append(.separator); rows += session.map { .action(choiceWords[$0]!, choice: $0) } }
    if let site = site, choices.contains("block-site") {
        if session.isEmpty { rows.append(.separator) }
        rows.append(.action("Never Act on " + (site.hasPrefix("https://") ? String(site.dropFirst(8)) : site), choice: "block-site"))
    }
    rows.append(.separator)
    if let choice = handChoices.first { rows.append(.toggle(choiceWords[choice]!, choice: choice, on: hand == "on")) }
    if choices.contains("turbo-off") { rows.append(.confirm(choiceWords["turbo-off"]!, choice: "turbo-off")) }
    rows.append(.help)
    if let version = data["version"] as? String, version.range(of: #"^\d{1,3}\.\d{1,3}\.\d{1,3}$"#, options: .regularExpression) != nil {
        rows += [.separator, .footer("sleight " + version)]
    }
    return rows
}
// The picker stays reachable for this host's lifetime whenever the hand is on, including between actions.
func menuVisible(_ status: String?, requests: Int, handEnabled: Bool) -> Bool {
    statusVisible(status, requests: requests) || handEnabled
}
// The usage row (1.4.0): the opt-in action log's last 7 days from the hand channel's menu frame, as numbers this host words.
// Exact keys: saved, with native, turbo or both, each that path's median seconds per action (paths are never mixed). Seconds
// run 0 to 3600, and reads saved is a whole number.
struct UsageStats: Equatable { let native: Double?, turbo: Double?, saved: Int }
func usageData(_ value: Any?) -> UsageStats? {
    func seconds(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
            number.doubleValue >= 0, number.doubleValue <= 3600 else { return nil }
        return number.doubleValue
    }
    guard let data = value as? [String: Any], data["saved"] != nil, data["native"] != nil || data["turbo"] != nil,
        Set(data.keys).isSubset(of: ["native", "turbo", "saved"]), let saved = data["saved"] as? NSNumber, CFGetTypeID(saved) != CFBooleanGetTypeID(),
        saved.doubleValue.rounded() == saved.doubleValue, saved.doubleValue >= 0, saved.doubleValue <= 1e9 else { return nil }
    var native: Double?, turbo: Double?
    if data["native"] != nil { guard let value = seconds(data["native"]) else { return nil }; native = value }
    if data["turbo"] != nil { guard let value = seconds(data["turbo"]) else { return nil }; turbo = value }
    return UsageStats(native: native, turbo: turbo, saved: Int(saved.doubleValue))
}
func usageWords(_ usage: UsageStats) -> String {
    var parts: [String] = []
    if let native = usage.native { parts.append(String(format: "%.1f s per native action", native)) }
    if let turbo = usage.turbo { parts.append(String(format: "%.1f s per turbo action", turbo)) }
    parts.append(usage.saved == 1 ? "1 read saved" : "\(usage.saved) reads saved")
    return "Last 7 days: " + parts.joined(separator: " · ")
}
// Without turbo, the hand's own block: its toggle, the Permissions submenu, the usage row, Settings & Help and the version.
func handRows(enabled: Bool, version: String?, permissions: [PermissionRow]? = nil, usage: UsageStats? = nil) -> [StatusRow] {
    var rows: [StatusRow] = [.toggle("Ghost Hand", choice: "hand-toggle", on: enabled)]
    if let permissions = permissions { rows.append(.permissions(permissions)) }
    if let usage = usage { rows.append(.usage(usageWords(usage))) }
    rows += [.separator, .help]
    if let version = version, version.range(of: #"^\d{1,3}\.\d{1,3}\.\d{1,3}$"#, options: .regularExpression) != nil {
        rows += [.separator, .footer("sleight " + version)]
    }
    return rows
}
// With turbo, the hand channel's toggle (unless a status frame already has one), its Permissions submenu and its usage row join
// the turbo menu before Turn Turbo Off.
func withHand(_ rows: [StatusRow], enabled: Bool, permissions: [PermissionRow]? = nil, usage: UsageStats? = nil) -> [StatusRow] {
    guard let at = rows.firstIndex(where: { if case .confirm = $0 { return true }; return $0 == .help }) else { return rows }
    var added: [StatusRow] = []
    if !rows.contains(where: { if case .toggle = $0 { return true }; return false }) { added.append(.toggle("Ghost Hand", choice: "hand-toggle", on: enabled)) }
    if let permissions = permissions { added.append(.permissions(permissions)) }
    if let usage = usage { added.append(.usage(usageWords(usage))) }
    var merged = rows
    merged.insert(contentsOf: added, at: at)
    return merged
}
// The Permissions submenu, from the hand channel's menu frame: each standing permission (an always-allowed app, an app's debugger
// grant, turbo's browser) with its own Revoke, Revoke All, Never Act in the app sleight last acted in, the blocks, and ChatGPT's own
// list, which only ChatGPT's settings change. Every click removes access; nothing here grants or lifts a block, which only
// `sleight-mcp permissions unblock` does.
struct PermissionGrant: Equatable { let title: String, detail: String, used: Double?, target: String }
struct PermissionApp: Equatable { let title: String, target: String }
struct PermissionsData: Equatable { let grants: [PermissionGrant], current: PermissionApp?, blocked: [String], only: [String]? }
enum PermissionRow: Equatable {
    case grant(String, target: String)
    case revokeAll
    case block(String, target: String)
    case info(String)
    case separator
}
func permissionText(_ value: Any?, _ limit: Int) -> String? {
    guard let value = value as? String, !value.isEmpty, value.count <= limit,
        value.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f && !(0x80...0x9f).contains($0.value) }) else { return nil }
    return value
}
let bundlePattern = #"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$"#
let grantTargetPattern = #"^(app:.{1,255}|electron:[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+|turbo)$"#
// Exact keys only; used is seconds since 1970 or null.
func permissionsData(_ value: Any?) -> PermissionsData? {
    guard let data = value as? [String: Any], Set(data.keys).isSubset(of: ["grants", "current", "blocked", "only"]),
        let rawGrants = data["grants"] as? [Any], rawGrants.count <= 24, let rawBlocked = data["blocked"] as? [Any], rawBlocked.count <= 24 else { return nil }
    var grants: [PermissionGrant] = []
    for raw in rawGrants {
        guard let grant = raw as? [String: Any], Set(grant.keys) == ["title", "detail", "used", "target"],
            let title = permissionText(grant["title"], 80), let detail = permissionText(grant["detail"], 40),
            let target = permissionText(grant["target"], 300), target.range(of: grantTargetPattern, options: .regularExpression) != nil else { return nil }
        var used: Double?
        if let number = grant["used"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite, number.doubleValue >= 0 { used = number.doubleValue }
        else if !(grant["used"] is NSNull) { return nil }
        grants.append(PermissionGrant(title: title, detail: detail, used: used, target: target))
    }
    let blocked = rawBlocked.compactMap { permissionText($0, 80) }
    guard blocked.count == rawBlocked.count else { return nil }
    var current: PermissionApp?
    if let raw = data["current"] {
        guard let app = raw as? [String: Any], Set(app.keys) == ["title", "target"], let title = permissionText(app["title"], 80),
            let target = permissionText(app["target"], 255), target.range(of: bundlePattern, options: .regularExpression) != nil else { return nil }
        current = PermissionApp(title: title, target: target)
    }
    var only: [String]?
    if let raw = data["only"] {
        guard let list = raw as? [Any], (1...12).contains(list.count) else { return nil }
        let sites = list.compactMap { permissionText($0, 80) }
        guard sites.count == list.count else { return nil }
        only = sites
    }
    return PermissionsData(grants: grants, current: current, blocked: blocked, only: only)
}
func usedWords(_ used: Double?, now: Double) -> String {
    guard let used = used else { return "not used yet" }
    let seconds = max(0, now - used)
    if seconds < 60 { return "used just now" }
    if seconds < 3600 { return "used \(Int(seconds / 60))m ago" }
    if seconds < 86400 { return "used \(Int(seconds / 3600))h ago" }
    return "used \(Int(seconds / 86400))d ago"
}
func permissionRows(_ data: PermissionsData, now: Double) -> [PermissionRow] {
    // Turbo's row has no Revoke: Turn Turbo Off… is turbo's one path, with its one confirmation. Revoke All leaves turbo too.
    var rows: [PermissionRow] = data.grants.isEmpty ? [.info("Nothing beyond this session's approvals")] : data.grants.flatMap { grant -> [PermissionRow] in
        let words = grant.title + " · " + grant.detail + " · " + usedWords(grant.used, now: now)
        return grant.target == "turbo" ? [.info(words), .info("Turn Turbo Off… or sleight-mcp turbo off stops turbo")] : [.grant(words, target: grant.target)]
    }
    if data.grants.contains(where: { $0.target != "turbo" }) { rows.append(.revokeAll) }
    if let current = data.current { rows += [.separator, .block("Never Act in " + current.title, target: current.target)] }
    if !data.blocked.isEmpty || data.only != nil {
        rows.append(.separator)
        rows += data.blocked.map { .info("Blocked: " + $0) }
        if let only = data.only { rows.append(.info("Acts only on: " + only.joined(separator: ", "))) }
        rows.append(.info("sleight-mcp permissions changes these"))
    }
    rows += [.separator, .info("ChatGPT's own Always allow list: in ChatGPT's settings")]
    return rows
}
// END STATUS MENU

// BEGIN HOOKUP
// Fable's menu bar glove (2026-10-18, picked by the owner): an open glove whose wrist breaks into the icon's square dabs, with
// the pointer at its fingertips. A vector template image, drawn by macOS in the bar's own colour.
let menuGlyph = ##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 18" width="24" height="18"><g fill="none" stroke="#000" stroke-width="2" stroke-linecap="round"><line x1="5"  y1="3.5" x2="5"  y2="10"/><line x1="8"  y1="2"   x2="8"  y2="10"/><line x1="11" y1="2.8" x2="11" y2="10"/><line x1="14" y1="4.5" x2="14" y2="10"/><line x1="5.5" y1="12.5" x2="1.8" y2="8.5"/></g><path fill="#000" d="M4 9 H15 V11 L14 13.5 H6 L5 11 Z"/><rect x="6"    y="14.5" width="2"   height="2"   fill="#000"/><rect x="9.5"  y="15"   width="2"   height="2"   fill="#000"/><rect x="13"   y="14.5" width="2"   height="2"   fill="#000"/><rect x="2.5"  y="16"   width="2"   height="2"   fill="#000"/><path fill="#000" d="M16.5 1 L16.5 9.75 L18.6 7.86 L20.4 11.22 L21.68 10.59 L19.95 7.44 L22.94 7.44 Z"/></svg>"##
// Turbo's connect hookup (LAWS): when turbo connects, the glove's four dabs rise into the wrist one after another, 150 ms apart,
// fading in on an ease-out the way the ghost hand's dabs trail it, and settle on the glyph. 10 frames 80 ms apart (0.8 s), on
// the menu bar button only: no window, no focus.
let hookupFrameCount = 10, hookupInterval = 0.08
func hookupConnects(from previous: String?, to status: String) -> Bool {
    status == "connected" && previous != "connected" && previous != "connected-idle"
}
func hookupFrame(_ glyph: String, _ index: Int) -> String {
    let t = Double(index + 1) / Double(hookupFrameCount)
    guard t < 1, let dabs = try? NSRegularExpression(pattern: #"<rect x="([\d.]+)"\s+y="([\d.]+)"[^>]*/>"#) else { return glyph }
    var frame = "", last = glyph.startIndex, dab = 0
    for match in dabs.matches(in: glyph, range: NSRange(glyph.startIndex..., in: glyph)) {
        guard let whole = Range(match.range, in: glyph), let xs = Range(match.range(at: 1), in: glyph), let ys = Range(match.range(at: 2), in: glyph),
            let x = Double(glyph[xs]), let y = Double(glyph[ys]) else { continue }
        let progress = min(1, max(0, (t - 0.15 * Double(dab)) / 0.4)), eased = 1 - pow(1 - progress, 3)
        frame += String(glyph[last..<whole.lowerBound]) + "<rect x=\"\(x)\" y=\"\(y + 4 * (1 - eased))\" width=\"2\" height=\"2\" fill=\"#000\" fill-opacity=\"\(eased)\"/>"
        last = whole.upperBound; dab += 1
    }
    return frame + String(glyph[last...])
}
// END HOOKUP

// BEGIN MODAL GUARD
// The card on screen, if any. When its sender's channel ends the card is aborted, so no button stays up that answers nothing.
final class ModalGuard {
    private var abort: (() -> Void)?
    var active: Bool { abort != nil }
    func run<T>(abort: @escaping () -> Void, _ body: () -> T) -> T {
        self.abort = abort
        defer { self.abort = nil }
        return body()
    }
    func close() { let abort = self.abort; self.abort = nil; abort?() }
}
// END MODAL GUARD

// BEGIN FOCUS RETURN
// The click that answers a card activates this accessory host (the card is a titled panel, and runModal activates it for an
// alert), and the host then stays active with no window. When it later exits, macOS activates another app, and in the
// Electron qualification (2026-10-22) that was the VS Code copy the card was about: in front 1034 of 1039 samples once the
// worker and its host exited. So when the last card closes, the host hands activation back to the person's latest app: the
// one in front just before the host activated, or else when the card appeared. It does so only if the host itself, the
// card's app or no app holds activation, and it never activates the card's app or a relaunched copy of a recorded one.
// Accepted trade-off: a card that times out or is aborted while the card's own app is in front returns focus too, even if
// the person chose that app themselves.
struct AppIdentity: Equatable { let pid: pid_t; let bundle: String?; let launched: Double? }
struct CardTargets {
    var pids: Set<pid_t> = [], bundles: Set<String> = []
    mutating func add(_ data: [String: Any]) {
        guard let target = cardTarget(data) else { return }
        if let pid = target.pid { pids.insert(pid) }
        if let bundle = target.bundle { bundles.insert(bundle) }
    }
    mutating func merge(_ other: CardTargets) { pids.formUnion(other.pids); bundles.formUnion(other.bundles) }
    func contains(_ app: AppIdentity) -> Bool { pids.contains(app.pid) || app.bundle.map { bundles.contains($0) } == true }
}
final class FocusReturn {
    let host: pid_t
    let frontmost: () -> pid_t?, identify: (pid_t) -> AppIdentity?, hostActive: () -> Bool, activate: (pid_t) -> Void
    private(set) var previous: AppIdentity?
    private(set) var open = 0
    // The apps the open cards are about, and those of the cards closed since the last record.
    private var targets = CardTargets(), recent = CardTargets()
    init(host: pid_t, frontmost: @escaping () -> pid_t?, identify: @escaping (pid_t) -> AppIdentity?, hostActive: @escaping () -> Bool,
        activate: @escaping (pid_t) -> Void) {
        self.host = host; self.frontmost = frontmost; self.identify = identify; self.hostActive = hostActive; self.activate = activate
    }
    // Activation moves asynchronously, so right after a card closes the frontmost app can still name this host or the card's
    // app. Neither is ever recorded: the earlier record carries over until another app is in front.
    private func record() {
        guard let pid = frontmost(), pid != host, let app = identify(pid), !targets.contains(app), !recent.contains(app) else { return }
        previous = app; recent = CardTargets()
    }
    // A card or alert is about to show.
    func presenting(_ data: [String: Any]) { open += 1; targets.add(data); record() }
    // NSApplication.willBecomeActiveNotification: the app in front now is the person's latest choice.
    func hostActivating() { if open > 0 { record() } }
    // A card or alert closed: answered, timed out or aborted. Returns the pid it activated.
    @discardableResult func dismissed() -> pid_t? {
        guard open > 0 else { return nil }
        open -= 1
        guard open == 0 else { return nil }
        let closed = targets
        targets = CardTargets(); recent.merge(closed)
        guard let previous = previous, !closed.contains(previous), identify(previous.pid) == previous else { return nil }
        // While the host is active the workspace's frontmost app can lag, so activity decides.
        if !hostActive(), let pid = frontmost(), pid != host {
            guard let app = identify(pid), closed.contains(app) else { return nil }
        }
        activate(previous.pid)
        return previous.pid
    }
}
// The app a debugger or relaunch card is about: its pid (none before launch) and bundle. Other cards name no app.
func cardTarget(_ data: [String: Any]) -> (pid: pid_t?, bundle: String?)? {
    guard let app = data["app"] as? [String: Any] else { return nil }
    let pid = (app["pid"] as? NSNumber).map { $0.int32Value }.flatMap { $0 > 0 ? $0 : nil }
    return (pid, app["bundleId"] as? String)
}
// END FOCUS RETURN

// BEGIN ASK CARD
// The ask.js layout in the nonce-bound host. Protected actions retain GB12's native event guard.
struct AskCard {
    let question: String, detail: String, host: String, icon: String, kind: String
    let choices: [String]
    var diagnostics: String = ""
    var labels: [String] {
        if kind == "app" || kind == "action" { return ["Don't allow", kind == "app" ? "Allow this session" : "Allow once"] }
        let names = ["once": "Allow once", "session": "Allow this session", "always": "Always allow", "relaunch": "Quit and reopen", "continue": "Continue", "cancel": ["relaunch", "handoff"].contains(kind) ? "Cancel" : "Don't allow"]
        return choices.map { names[$0] ?? "Cancel" }
    }
}
func askCard(_ data: [String: Any], _ choices: [String]) -> AskCard? {
    guard Set(data.keys) == ["view", "operation", "presentation"],
        let view = data["view"] as? [String: Any], view["clientSession"] as? String == "Grok Bot",
        let operation = data["operation"] as? [String: Any],
        let text = data["presentation"] as? [String: Any],
        Set(text.keys) == ["style", "question", "detail", "host", "icon", "kind"], text["style"] as? String == "ask",
        let question = text["question"] as? String, !question.isEmpty, question.utf8.count <= 16384,
        let detail = text["detail"] as? String, detail.utf8.count <= 16384,
        let host = text["host"] as? String, host == "Grok Bot",
        let icon = text["icon"] as? String, icon.hasPrefix("/"), icon.hasSuffix("/assets/icon.png"),
        let kind = text["kind"] as? String, ["app", "action"].contains(kind),
        choices == ["once", "cancel"] else { return nil }
    // Only an app grant for this session may use the host-answerable Allow button.
    if kind == "app" {
        guard view["scope"] as? String == "Allow for this Grok Bot session only",
            operation["scope"] as? String == "Allow for this Grok Bot session only", operation["request"] is String else { return nil }
    }
    return AskCard(question: question, detail: detail, host: host, icon: icon, kind: kind, choices: ["cancel", "once"])
}

func consentIconPath(_ icon: String = ProcessInfo.processInfo.environment["SLEIGHT_CONSENT_ICON"] ?? "") -> String {
    // Only the trusted native launcher supplies this value, from its installed assets directory.
    guard icon.hasPrefix("/"), icon.hasSuffix("/assets/icon.png") else { return "" }
    return icon
}
// No page words or credential fields enter this card. Tab/session identifiers
// come from the worker, and Continue is protected by the same person input guard.
func handoffFrame(_ data: [String: Any], _ choices: [String]) -> (session: String, tab: String?, app: String?)? {
    func identifier(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= 4096,
            value.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f && !(0x80...0x9f).contains($0.value) }) else { return nil }
        return value
    }
    let native = data["app"] != nil
    guard Set(data.keys) == Set(["kind", "session", "turn", native ? "app" : "tab"]), data["kind"] as? String == "handoff",
        let session = identifier(data["session"]), identifier(data["turn"]) != nil,
        choices == ["continue", "cancel"] else { return nil }
    if native {
        guard let app = identifier(data["app"]), app.count <= 255,
            app.range(of: "^[A-Za-z0-9][A-Za-z0-9-]*(\\.[A-Za-z0-9-]+)+$", options: .regularExpression) != nil else { return nil }
        return (session, nil, app)
    }
    guard let tab = identifier(data["tab"]), tab.range(of: "^t[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else { return nil }
    return (session, tab, nil)
}
func automaticCard(_ data: [String: Any], _ choices: [String]) -> AskCard? {
    if data["presentation"] != nil { return askCard(data, choices) }
    if let handoff = handoffFrame(data, choices) {
        let target = handoff.tab.map { "tab " + $0 } ?? (handoff.app ?? "")
        let continuation = handoff.app != nil ? "Continue acquires and reads the same app fresh, including its new window. "
            : "Continue reads this tab or its owned opener again. "
        return AskCard(question: "Finish signing in or entering your code in " + target,
            detail: "Use the app or your password manager yourself. sleight is paused. Confirm Continue only after the secret fields are gone. To use the keyboard, focus the confirmation field first. " + continuation + "Payments and submits still need their usual checks. Cancel leaves your work open. This request expires in at most four minutes.",
            host: "sleight", icon: consentIconPath(), kind: "handoff", choices: ["cancel", "continue"], diagnostics: "Session: " + handoff.session)
    }
    guard let card = appFrame(data, choices) else { return nil }
    let words = appCardText(card)
    return AskCard(question: words.title, detail: words.summary, host: "sleight", icon: consentIconPath(), kind: card.kind,
        choices: ["cancel"] + choices.filter { $0 != "cancel" }, diagnostics: words.identity)
}

final class HandoffPanel: NSPanel, ConsentWordFocusing {
    private var wordFocusAllowed = false
    override var canBecomeKey: Bool { wordFocusAllowed }
    override var canBecomeMain: Bool { false }
    func focusWordField(_ field: ConsentWordField) -> Bool {
        guard field.window === self, field.isEnabled else { return false }
        wordFocusAllowed = true
        guard makeFirstResponder(field) else { wordFocusAllowed = false; return false }
        // A nonactivating panel takes keys only after the person focuses this
        // field. Showing or reviewing the card never calls this method.
        makeKey()
        wordFocusAllowed = isKeyWindow
        guard wordFocusAllowed else { _ = makeFirstResponder(nil); return false }
        return firstResponder === field
    }
    override func resignKey() {
        wordFocusAllowed = false
        _ = makeFirstResponder(nil)
        super.resignKey()
    }
}
final class AskCardPanel: NSObject {
    let panel: NSPanel
    let passive: Bool
    let answer: (String) -> Void
    var actions: [ConsentInputAction] = []
    var typing: ConsentTyping?
    var timer: Timer?
    var finished = false
    let choices: [String]
    let content = NSView()
    let text = NSView()
    let scroll = NSScrollView()
    let detailsScroll = NSScrollView()
    let detailsText = NSTextField(wrappingLabelWithString: "")
    let disclosure = NSButton(title: "Details", target: nil, action: nil)
    let feedback = AskCardFeedback(wrappingLabelWithString: "")
    let icon = NSImageView()
    var fields: [NSTextField] = []
    var buttons: [NSButton] = []
    var expanded = false
    var area: NSRect
    init(_ card: AskCard, deadline: Double, answer: @escaping (String) -> Void) {
        self.answer = answer
        passive = card.kind == "handoff"
        choices = card.choices
        func label(_ text: String, _ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor) -> NSTextField {
            let field = NSTextField(wrappingLabelWithString: text)
            field.font = .systemFont(ofSize: size, weight: weight); field.textColor = color
            return field
        }
        let eyebrow = label(card.host == "sleight" ? "sleight · computer use" : "sleight · " + card.host + " computer use", 10, .medium, .tertiaryLabelColor)
        let title = label(card.question, 13, .semibold, .labelColor)
        let body = label(card.detail, 11, .regular, .secondaryLabelColor)
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        area = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1024, height: 768)
        panel = passive ? HandoffPanel(contentRect: .zero,
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
            : NSPanel(contentRect: .zero, styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        if passive { panel.becomesKeyOnlyIfNeeded = true }
        panel.title = "sleight"; panel.titlebarAppearsTransparent = true; panel.titleVisibility = .hidden
        panel.isMovableByWindowBackground = true; panel.isOpaque = false; panel.backgroundColor = .clear
        // Keep the card visible while the accessory host is inactive.
        panel.hidesOnDeactivate = false
        panel.level = .modalPanel; panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { panel.standardWindowButton(button)?.isHidden = true }
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView(frame: .zero)
            glass.cornerRadius = 22; glass.contentView = content; panel.contentView = glass
        } else {
            let frost = NSVisualEffectView(frame: .zero)
            frost.material = .hudWindow; frost.blendingMode = .behindWindow; frost.state = .active
            frost.wantsLayer = true; frost.layer?.cornerRadius = 16; frost.layer?.masksToBounds = true
            frost.addSubview(content); panel.contentView = frost
        }
        icon.image = NSImage(contentsOfFile: card.icon) ?? NSImage(systemSymbolName: "hand.raised.fill", accessibilityDescription: "sleight")
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.wantsLayer = true; icon.layer?.cornerRadius = 12; icon.layer?.masksToBounds = true; content.addSubview(icon)
        fields = [eyebrow, title, body]
        for field in fields { text.addSubview(field) }
        scroll.drawsBackground = false
        scroll.documentView = text; content.addSubview(scroll)
        feedback.font = .systemFont(ofSize: 10); feedback.textColor = .secondaryLabelColor; content.addSubview(feedback)
        feedback.changed = { [weak self] in self?.layout() }
        detailsText.stringValue = card.diagnostics; detailsText.font = .systemFont(ofSize: 10)
        detailsText.textColor = .secondaryLabelColor; detailsText.isSelectable = true
        detailsScroll.drawsBackground = false; detailsScroll.hasVerticalScroller = true
        detailsScroll.documentView = detailsText; content.addSubview(detailsScroll)
        disclosure.setButtonType(.momentaryPushIn); disclosure.isBordered = false
        disclosure.alignment = .left; disclosure.imagePosition = .imageLeading
        disclosure.target = self; disclosure.action = #selector(toggleDetails(_:))
        disclosure.font = .systemFont(ofSize: 11); content.addSubview(disclosure)
        let labels = card.labels, choices = card.choices
        for index in choices.indices {
            let button = NSButton(title: labels[index], target: self, action: #selector(press(_:)))
            button.tag = index
            button.controlSize = .large
            if index == 0 { button.keyEquivalent = "\u{1b}" }
            // Return has no default action, as in ask.js.
            // A resting accent can look like a different choice was pressed when the panel activates.
            // Let AppKit highlight only the button the person is pressing.
            if #available(macOS 26.0, *) { button.tintProminence = .none }
            content.addSubview(button)
            buttons.append(button)
            if personChoice(card.kind, choices[index]) {
                objc_setAssociatedObject(button, &consentFeedbackKey, feedback, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
                actions.append(ConsentInputAction(button, mouseOnly: passive))
            }
        }
        if !actions.isEmpty {
            typing = ConsentTyping(actions)
            content.addSubview(typing!)
        }
        layout()
        timer = Timer.scheduledTimer(withTimeInterval: max(0.001, deadline / 1000 - Date().timeIntervalSince1970), repeats: false) { [weak self] _ in self?.finish("cancel") }
    }
    func layout(in availableArea: NSRect? = nil) {
        let area = availableArea ?? self.area
        self.area = area
        let pad: CGFloat = 20, textX: CGFloat = 92, gap: CGFloat = 8, buttonHeight: CGFloat = 28
        let intrinsicWidths = buttons.map { ceil($0.intrinsicContentSize.width) }
        let preferredWidths = intrinsicWidths.map { max(96, $0 + 12) }
        let gaps = gap * CGFloat(max(0, buttons.count - 1))
        let preferredRow = preferredWidths.reduce(0, +) + gaps
        let minimumRow = intrinsicWidths.reduce(0, +) + gaps
        let buttonPad = max(8, min(pad, (area.width - minimumRow) / 2))
        let width = max(minimumRow + buttonPad * 2, min(max(400, textX + preferredRow + pad), area.width))
        let textWidth = width - textX - pad
        // On a narrow display the row may use the icon column, preserving every label on one line.
        let buttonX = textWidth >= minimumRow ? textX : buttonPad
        let rowWidth = width - buttonX - buttonPad
        let baseWidths = rowWidth >= preferredRow ? preferredWidths : intrinsicWidths
        let extraWidth = (rowWidth - baseWidths.reduce(0, +) - gaps) / CGFloat(buttons.count)
        let widths = baseWidths.map { $0 + extraWidth }
        func measure(_ field: NSTextField, _ width: CGFloat) -> CGFloat {
            field.preferredMaxLayoutWidth = width
            return ceil(field.sizeThatFits(NSSize(width: width, height: 100000)).height)
        }
        let heights = fields.map { measure($0, textWidth) }
        let textHeight = heights.reduce(0, +) + 6
        let hasDetails = !detailsText.stringValue.isEmpty
        let disclosureHeight: CGFloat = hasDetails ? 26 : 0
        let feedbackHeight: CGFloat = feedback.stringValue.isEmpty ? 0 : measure(feedback, textWidth) + gap
        let typingHeight = typing.map { $0.fit(width: textWidth) + gap } ?? 0
        let fixedHeight = pad * 2 + 18 + buttonHeight + disclosureHeight + feedbackHeight + typingHeight
        let detailsWanted = expanded && hasDetails ? measure(detailsText, textWidth - 18) : 0
        // Reserve a readable Details viewport before a long summary consumes the available height.
        let detailsReserved = min(detailsWanted, min(120, max(0, area.height - fixedHeight - 56 - 48)))
        let summaryBudget = area.height - fixedHeight - 40 - (detailsReserved > 0 ? detailsReserved + gap : 0)
        let topHeight = min(max(56, textHeight), max(56, summaryBudget))
        let detailHeight = min(detailsWanted, max(0, area.height - fixedHeight - topHeight - 48))
        let detailsHeight = detailHeight > 0 ? detailHeight + gap : 0
        let height = fixedHeight + topHeight + detailsHeight
        // Preserve the top edge during disclosure/refusal so the existing controls never change consent targets.
        let wasSized = panel.frame.width > 0
        let origin = wasSized ? NSPoint(x: max(area.minX, min(panel.frame.minX, area.maxX - width)),
            y: max(area.minY, min(area.maxY - height, panel.frame.maxY - height))) :
            NSPoint(x: area.midX - width / 2, y: area.minY + (area.height - height) * 0.62)
        panel.setFrame(NSRect(origin: origin, size: NSSize(width: width, height: height)), display: false)
        content.frame = NSRect(x: 0, y: 0, width: width, height: height)
        panel.contentView?.frame = content.frame
        icon.frame = NSRect(x: pad, y: height - pad - 56, width: 56, height: 56)
        text.frame = NSRect(x: 0, y: 0, width: textWidth, height: textHeight)
        var y = textHeight
        for index in fields.indices {
            y -= [0.0, 2.0, 4.0][index] + heights[index]
            fields[index].frame = NSRect(x: 0, y: y, width: textWidth, height: heights[index])
        }
        scroll.frame = NSRect(x: textX, y: height - pad - topHeight, width: textWidth, height: topHeight)
        scroll.hasVerticalScroller = textHeight > topHeight
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, textHeight - topHeight)))
        disclosure.isHidden = !hasDetails
        disclosure.frame = NSRect(x: textX, y: scroll.frame.minY - disclosureHeight, width: 90, height: 22)
        disclosure.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        disclosure.setAccessibilityValue(expanded ? "Expanded" : "Collapsed")
        detailsScroll.isHidden = detailHeight == 0
        detailsScroll.frame = NSRect(x: textX, y: disclosure.frame.minY - detailsHeight, width: textWidth, height: detailHeight)
        detailsText.isHidden = detailHeight == 0
        detailsText.frame = NSRect(x: 0, y: 0, width: textWidth - 18, height: measure(detailsText, textWidth - 18))
        detailsScroll.contentView.scroll(to: NSPoint(x: 0, y: detailsText.isFlipped ? 0 : max(0, detailsText.frame.height - detailHeight)))
        feedback.isHidden = feedbackHeight == 0
        feedback.frame = NSRect(x: textX, y: pad, width: textWidth, height: max(0, feedbackHeight - gap))
        typing?.frame.origin = NSPoint(x: textX, y: pad + feedbackHeight + buttonHeight + gap)
        var x = buttonX
        for index in buttons.indices {
            buttons[index].frame = NSRect(x: x, y: pad + feedbackHeight, width: widths[index], height: buttonHeight)
            x += widths[index] + gap
        }
    }
    @objc func toggleDetails(_ sender: NSButton) { expanded.toggle(); layout() }
    func show() {
        if passive { panel.orderFrontRegardless() } else { panel.makeKeyAndOrderFront(nil) }
        NSSound(named: "Glass")?.play()
    }
    func review() { if passive { panel.orderFrontRegardless() } else { panel.makeKeyAndOrderFront(nil) } }
    @objc func press(_ sender: NSButton) {
        guard choices.indices.contains(sender.tag) else { return }
        finish(choices[sender.tag])
    }
    func finish(_ choice: String) {
        guard !finished else { return }
        close(); answer(choice)
    }
    func close() {
        finished = true; timer?.invalidate(); timer = nil; typing?.invalidate(); panel.orderOut(nil)
        // The guarded action retains its original target (this card). Break that cycle after dismissal.
        actions.removeAll()
    }
}
final class AskCardFeedback: NSTextField {
    var changed: (() -> Void)?
    override var stringValue: String { didSet { changed?() } }
}
// END ASK CARD

// One nonce per channel in the shared host: the hand's sender and turbo's worker each bind their own, and neither binds the other's.
final class NonceBook {
    let lock = NSLock()
    var bound: [String: String] = [:]
    func admit(_ channel: String, _ nonce: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let mine = bound[channel] { return mine == nonce }
        if bound.values.contains(nonce) { return false }
        bound[channel] = nonce
        return true
    }
    func resetConsent() { lock.lock(); defer { lock.unlock() }; bound.removeValue(forKey: "consent") }
    func nonce(_ channel: String) -> String? { lock.lock(); defer { lock.unlock() }; return bound[channel] }
}
let nonceBook = NonceBook()
// The person's click on the Ghost Hand row, the hand channel's only output, on the shared host's stdout. No hand frame is ever
// answered; the relay writes hand.json from this.
func writeHandToggle(_ enabled: Bool) {
    guard let nonce = nonceBook.nonce("hand"),
        let bytes = try? JSONSerialization.data(withJSONObject: ["hand": "toggle", "nonce": nonce, "enabled": enabled], options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(bytes + Data([10]))
}
// A Permissions row's click, on the hand channel's stdout beside the toggle: revoke or block with its target, or revoke-all.
func writePermissionEvent(_ event: [String: String]) {
    guard let nonce = nonceBook.nonce("hand"), let op = event["permissions"], ["revoke", "revoke-all", "block"].contains(op),
        let bytes = try? JSONSerialization.data(withJSONObject: event.merging(["nonce": nonce]) { $1 }, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(bytes + Data([10]))
}
func glyphImage(_ svg: String) -> NSImage? {
    guard let data = svg.data(using: .utf8), let image = NSImage(data: data) else { return nil }
    image.size = NSSize(width: 24, height: 18)
    image.isTemplate = true
    return image
}

final class ConsentHost: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var pending: [String: [String: Any]] = [:]
    var nonce: String?
    let outputLock = NSLock()
    // The consent channel: stdin and stdout, or fds 3 and 4 in the shared host, where its end leaves the hand running. The
    // hand-only host (--menu) has none. The shared host ends when both its channels have.
    var input: FileHandle? = FileHandle.standardInput, output = FileHandle.standardOutput, shared = false
    var consentOpen = true, handOpen = true
    var activeAsk: (id: String, panel: AskCardPanel)?
    func closeAsk() { guard let ask = activeAsk else { return }; ask.panel.close(); activeAsk = nil; if !ask.panel.passive { focus.dismissed() } }
    func reviewAsk(_ id: String) -> Bool {
        guard let frame = pending[id], let data = frame["data"] as? [String: Any],
            let choices = frame["choices"] as? [String], automaticCard(data, choices) != nil else { return false }
        if activeAsk?.id == id { activeAsk?.panel.review() } else { showNextAsk() }
        return true
    }
    func showNextAsk() {
        guard activeAsk == nil, !modal.active else { return }
        for id in pending.keys.sorted() {
            guard let frame = pending[id], let data = frame["data"] as? [String: Any],
                let choices = frame["choices"] as? [String], let card = automaticCard(data, choices),
                let deadline = frame["deadline"] as? Double else { continue }
            if deadline <= Date().timeIntervalSince1970 * 1000 { pending.removeValue(forKey: id); continue }
            let panel = AskCardPanel(card, deadline: deadline) { [weak self] choice in
                guard let self = self, self.activeAsk?.id == id else { return }
                self.activeAsk = nil; if card.kind != "handoff" { self.focus.dismissed() }; self.respond(id, choice); self.showNextAsk()
            }
            activeAsk = (id, panel); if !panel.passive { focus.presenting(data) }; panel.show(); return
        }
        rebuildMenu()
    }
    let modal = ModalGuard()
    let focus = FocusReturn(host: getpid(), frontmost: { NSWorkspace.shared.frontmostApplication?.processIdentifier },
        identify: { pid in
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return nil }
            return AppIdentity(pid: pid, bundle: app.bundleIdentifier, launched: app.launchDate?.timeIntervalSince1970)
        },
        hostActive: { NSApp.isActive },
        activate: { pid in
            guard let app = NSRunningApplication(processIdentifier: pid) else { return }
            if #available(macOS 14.0, *) { NSApp.yieldActivation(to: app); _ = app.activate(from: .current, options: []) }
            else { _ = app.activate(options: []) }
        })
    override init() {
        super.init()
        // Posted on the main thread before the activating click is handled; nil queue runs it there and then.
        NotificationCenter.default.addObserver(forName: NSApplication.willBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in
            self?.focus.hostActivating()
        }
    }
    func personModal(_ alert: NSAlert, choices: [String], kind: String) -> NSApplication.ModalResponse {
        let actions = consentInputActions(alert, choices: choices, kind: kind)
        defer { for action in actions { action.typing?.invalidate() } }
        focus.presenting([:])
        let result = withExtendedLifetime(actions) { modal.run(abort: { NSApp.abortModal() }) { alert.runModal() } }
        focus.dismissed()
        // A shell card received during the modal waits until its run loop has ended.
        DispatchQueue.main.async { self.showNextAsk() }
        return result
    }
    // The hand channel's state in the shared host: its setting, the version for its block, and when sleight last acted.
    var hand: (enabled: Bool, version: String)?
    // The Permissions submenu's rows from the hand channel; its times are worded again each time the submenu opens.
    var permissions: PermissionsData?
    var usage: UsageStats?
    let cursorPicker = CursorPickerHost()
    var hookupTimer: Timer?

    var status: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let image = glyphImage(menuGlyph) { item.button?.image = image } else { item.button?.title = "sleight" }
        item.isVisible = false
        item.menu = NSMenu()
        guard let input = input else { consentOpen = false; return }
        DispatchQueue.global().async { [weak self] in
            var buffer = Data()
            while let self = self {
                let chunk = input.availableData
                if chunk.isEmpty {
                    DispatchQueue.main.async { if self.shared { self.channelClosed() } else { NSApp.terminate(nil) } }
                    return
                }
                buffer.append(chunk)
                if buffer.count > 131072 { exit(65) }
                while let end = buffer.firstIndex(of: 10) {
                    let line = buffer.prefix(upTo: end)
                    buffer.removeSubrange(...end)
                    guard line.count <= 65536,
                        let frame = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { exit(65) }
                    DispatchQueue.main.async { self.receive(frame) }
                }
            }
        }
    }
    func receive(_ frame: [String: Any], resetDeadline: Date? = nil) {
        // Parent-only reset on the consent pipe, after every byte from the exited worker.
        // It carries the hand channel's secret, which no worker receives.
        if shared, frame["hand"] as? String == "consent-reset" {
            // The first worker can exit before this host has read its initial hand menu.
            // Wait for that channel to bind itself; a reset never binds its secret on the worker's behalf.
            let deadline = resetDeadline ?? Date().addingTimeInterval(2)
            if nonceBook.nonce("hand") == nil && Date() < deadline {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { self.receive(frame, resetDeadline: deadline) }
                return
            }
            guard Set(frame.keys) == ["hand", "nonce", "token"],
                let incoming = frame["nonce"] as? String, incoming == nonceBook.nonce("hand"),
                let token = frame["token"] as? String, token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { exit(65) }
            closeAsk(); modal.close(); pending.removeAll(); status = nil; nonce = nil
            nonceBook.resetConsent(); rebuildMenu()
            if let bytes = try? JSONSerialization.data(withJSONObject: ["hand": "consent-ready", "nonce": incoming, "token": token]) {
                FileHandle.standardOutput.write(bytes + Data([10]))
            }
            return
        }
        if frame["dismiss"] != nil {
            guard Set(frame.keys) == ["id", "nonce", "dismiss"], frame["dismiss"] as? Bool == true,
                let id = frame["id"] as? String, !id.isEmpty,
                let incoming = frame["nonce"] as? String, incoming == nonceBook.nonce("consent") else { exit(65) }
            pending.removeValue(forKey: id)
            if activeAsk?.id == id { closeAsk() }
            rebuildMenu(); showNextAsk(); return
        }
        guard let id = frame["id"] as? String, !id.isEmpty,
            let incoming = frame["nonce"] as? String, incoming.count == 64,
            nonceBook.admit("consent", incoming),
            let choices = frame["choices"] as? [String], !choices.isEmpty,
            let deadline = frame["deadline"] as? Double,
            deadline > Date().timeIntervalSince1970 * 1000,
            let data = frame["data"] as? [String: Any], pending.count < 32 else { exit(65) }
        nonce = incoming
        guard pending[id] == nil else { exit(65) }
        pending[id] = frame
        if data["presentation"] != nil { guard askCard(data, choices) != nil else { exit(65) } }
        if let status = data["status"] as? String {
            // Status is broker-owned; page observations belong only in the sheet.
            guard statusRows(data, choices) != nil else { exit(65) }
            let previous = self.status
            self.status = status
            if hookupConnects(from: previous, to: status) { DispatchQueue.main.async { if self.item.isVisible { self.hookup() } } }
            item.button?.toolTip = "sleight turbo: " + (stateWords[status] ?? status)
            item.button?.appearsDisabled = status == "paused"
            for old in Array(pending.keys) where old != id && (pending[old]?["data"] as? [String: Any])?["status"] != nil {
                pending.removeValue(forKey: old)
            }
        } else if data["kind"] as? String == "handoff" {
            guard handoffFrame(data, choices) != nil else { exit(65) }
        } else if data["kind"] as? String == "debugger" || data["kind"] as? String == "relaunch" {
            guard appFrame(data, choices) != nil else { exit(65) }
        } else if data["kind"] != nil {
            guard sessionFrame(data, choices) != nil else { exit(65) }
        } else {
            // A payment or operation sheet offers exactly what consent-ui sends: Allow once or Don't allow.
            guard choices == ["once", "cancel"] else { exit(65) }
        }
        rebuildMenu()
        // Opening is independent of the status item's visibility, including macOS menu-bar overflow.
        showNextAsk()
    }
    func add(_ rows: [StatusRow], to menu: NSMenu, id: String) {
        for row in rows {
            switch row {
            case let .status(title, dot, details):
                let entry = NSMenuItem(); entry.view = statusView(title, dot: dot, details: details); menu.addItem(entry)
            case let .action(title, choice), let .confirm(title, choice):
                let entry = NSMenuItem(title: title, action: row == .confirm(title, choice: choice) ? #selector(confirmOff(_:)) : #selector(control(_:)), keyEquivalent: "")
                entry.target = self; entry.representedObject = ["id": id, "choice": choice]; menu.addItem(entry)
            case let .toggle(title, choice, on):
                // The hand channel's toggle answers on the hand channel; a status frame's own answers that frame.
                let entry = NSMenuItem(title: title, action: choice == "hand-toggle" ? #selector(handToggle(_:)) : #selector(control(_:)), keyEquivalent: "")
                entry.state = on ? .on : .off
                entry.target = self; entry.representedObject = ["id": id, "choice": choice]; menu.addItem(entry)
            case .permissions:
                let entry = NSMenuItem(title: "Permissions", action: nil, keyEquivalent: ""), submenu = NSMenu()
                submenu.delegate = self
                fillPermissions(submenu)
                entry.submenu = submenu; menu.addItem(entry)
            case .help:
                let entry = NSMenuItem(title: "Settings & Help…", action: #selector(help(_:)), keyEquivalent: "")
                entry.target = self; menu.addItem(entry)
            case .separator: menu.addItem(NSMenuItem.separator())
            case let .footer(text): menu.addItem(NSMenuItem(title: text, action: nil, keyEquivalent: ""))
            case let .usage(text): menu.addItem(NSMenuItem(title: text, action: nil, keyEquivalent: ""))
            }
        }
    }
    func rebuildMenu() {
        let menu = NSMenu()
        var statusShown = false
        for id in pending.keys.sorted() {
            guard let frame = pending[id], let choices = frame["choices"] as? [String],
                let data = frame["data"] as? [String: Any] else { continue }
            if data["status"] != nil {
                let rows = statusRows(data, choices) ?? []
                add(hand.map { withHand(rows, enabled: $0.enabled, permissions: permissionMenu, usage: usage) } ?? rows, to: menu, id: id)
                statusShown = true
            } else {
                let row = NSMenuItem(title: "Review sleight request", action: #selector(review(_:)), keyEquivalent: "")
                row.target = self; row.representedObject = id; menu.addItem(row)
            }
        }
        if !statusShown, let hand = hand {
            if !menu.items.isEmpty { menu.addItem(NSMenuItem.separator()) }
            add(handRows(enabled: hand.enabled, version: hand.version, permissions: permissionMenu, usage: usage), to: menu, id: "")
        }
        cursorPicker.install(in: menu, enabled: hand?.enabled == true)
        menu.delegate = self
        item.menu = menu
        let requests = pending.values.filter { ($0["data"] as? [String: Any])?["status"] == nil }.count
        item.isVisible = menuVisible(status, requests: requests, handEnabled: hand?.enabled ?? false)
    }
    // The shared host's consent channel ended (its worker exited): an open card is aborted, its requests and status go, and the
    // hand stays.
    func channelClosed() { closeAsk(); modal.close(); pending.removeAll(); status = nil; consentOpen = false; rebuildMenu(); if !handOpen { NSApp.terminate(nil) } }
    // The hand channel ended or faulted: its state goes, and turbo's channel, if open, keeps the host.
    func handGone() { handOpen = false; hand = nil; permissions = nil; usage = nil; rebuildMenu(); if !consentOpen { NSApp.terminate(nil) } }
    func handState(enabled: Bool, version: String, permissions: PermissionsData?, usage: UsageStats?) {
        hand = (enabled, version); self.permissions = permissions; self.usage = usage; rebuildMenu()
    }
    var permissionMenu: [PermissionRow]? { permissions.map { permissionRows($0, now: Date().timeIntervalSince1970) } }
    func fillPermissions(_ submenu: NSMenu) {
        submenu.removeAllItems()
        for row in permissionMenu ?? [] {
            switch row {
            case let .grant(title, target):
                let entry = NSMenuItem(title: title, action: nil, keyEquivalent: ""), inner = NSMenu()
                let revoke = NSMenuItem(title: "Revoke", action: #selector(permissionClick(_:)), keyEquivalent: "")
                revoke.target = self; revoke.representedObject = ["permissions": "revoke", "target": target]
                inner.addItem(revoke); entry.submenu = inner; submenu.addItem(entry)
            case .revokeAll:
                let entry = NSMenuItem(title: "Revoke All", action: #selector(permissionClick(_:)), keyEquivalent: "")
                entry.target = self; entry.representedObject = ["permissions": "revoke-all"]; submenu.addItem(entry)
            case let .block(title, target):
                let entry = NSMenuItem(title: title, action: #selector(permissionClick(_:)), keyEquivalent: "")
                entry.target = self; entry.representedObject = ["permissions": "block", "target": target]; submenu.addItem(entry)
            case let .info(text): submenu.addItem(NSMenuItem(title: text, action: nil, keyEquivalent: ""))
            case .separator: submenu.addItem(NSMenuItem.separator())
            }
        }
    }
    // Opening the submenu words the last-use times against the current time. Only Permissions submenus have this delegate.
    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === item.menu { if hand?.enabled == true { writeCursorPickerEvent(["op": "refresh"]) }; return }
        fillPermissions(menu)
    }
    // Revoke and block only remove access, so they don't ask.
    @objc func permissionClick(_ sender: NSMenuItem) {
        guard let event = sender.representedObject as? [String: String] else { return }
        writePermissionEvent(event)
    }
    @objc func handToggle(_ sender: NSMenuItem) {
        guard let hand = hand else { return }
        writeHandToggle(!hand.enabled)
    }
    // Turbo's connect hookup on the menu bar button: a template image per frame, then the glyph, and the timer is gone.
    func hookup() {
        hookupTimer?.invalidate()
        var index = 0
        hookupTimer = Timer.scheduledTimer(withTimeInterval: hookupInterval, repeats: true) { [weak self] timer in
            guard let self = self, index < hookupFrameCount else { timer.invalidate(); return }
            if let image = glyphImage(hookupFrame(menuGlyph, index)) { self.item.button?.image = image }
            index += 1
            if index == hookupFrameCount { timer.invalidate(); self.hookupTimer = nil }
        }
    }
    @objc func control(_ sender: NSMenuItem) {
        guard let event = sender.representedObject as? [String: String], let id = event["id"], let choice = event["choice"] else { return }
        respond(id, choice)
    }
    // Turning turbo off lasts past this session and reaches every session, so it asks once.
    @objc func confirmOff(_ sender: NSMenuItem) {
        guard let event = sender.representedObject as? [String: String], let id = event["id"], let choice = event["choice"] else { return }
        let alert = NSAlert()
        alert.messageText = "Turn turbo off?"
        alert.informativeText = "Turbo stops in every Claude Code session within a minute, and browsers go back to the engine's slower path. Run sleight-mcp turbo on to turn it back on."
        alert.addButton(withTitle: "Turn Off")
        alert.addButton(withTitle: "Cancel")
        let answer = personModal(alert, choices: ["turbo-off", "cancel"], kind: "turbo-off")
        if answer == .alertFirstButtonReturn { respond(id, choice) }
    }
    @objc func help(_ sender: NSMenuItem) {
        if let url = URL(string: "https://github.com/Land-o-Clusters/sleight/blob/main/docs/settings.md#" + (status == nil ? "ghost-hand" : "turbo")) { NSWorkspace.shared.open(url) }
    }
    // The status block: a coloured dot and the state in bold, then quiet detail lines under it. A view, so it never highlights.
    func statusView(_ title: String, dot: String, details: [String]) -> NSView {
        let colours: [String: NSColor] = ["green": .systemGreen, "orange": .systemOrange, "red": .systemRed, "gray": .systemGray]
        let mark = NSImageView()
        if let circle = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 8, weight: .regular).applying(.init(paletteColors: [colours[dot] ?? .systemGray]))) {
            mark.image = circle
        }
        let heading = NSTextField(labelWithString: title)
        heading.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
        let top = NSStackView(views: [mark, heading]); top.spacing = 6
        let stack = NSStackView(views: [top]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 3
        stack.edgeInsets = NSEdgeInsets(top: 6, left: 14, bottom: 6, right: 16)
        for line in details {
            let label = NSTextField(labelWithString: line)
            label.font = .systemFont(ofSize: NSFont.smallSystemFontSize); label.textColor = .secondaryLabelColor
            let indented = NSStackView(views: [label]); indented.edgeInsets = NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 0)
            stack.addArrangedSubview(indented)
        }
        stack.frame = NSRect(origin: .zero, size: stack.fittingSize)
        return stack
    }
    @objc func review(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let frame = pending[id],
            let data = frame["data"] as? [String: Any], let choices = frame["choices"] as? [String],
            pending[id] != nil else { return }
        if reviewAsk(id) { return }
        if let session = sessionFrame(data, choices) {
            let alert = NSAlert()
            alert.messageText = session.kind == "opt-in" ? "Enable sleight turbo for " + session.session : "Resume sleight turbo for " + session.session
            alert.informativeText = "This choice applies only to this session. Site permissions and action confirmations still apply."
            for choice in choices { alert.addButton(withTitle: choice == "cancel" ? "Don't allow" : "Allow this session") }
            let result = personModal(alert, choices: choices, kind: session.kind).rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            respond(id, result >= 0 && result < choices.count ? choices[result] : "cancel")
            return
        }
        guard
            let privateOperation = data["operation"] as? [String: Any],
            let view = data["view"] as? [String: Any],
            let session = view["clientSession"] as? String, let origin = view["origin"] as? String,
            let words = operationCardText(privateOperation, scope: view["scope"] as? String) else { return }
        let alert = NSAlert()
        // A document inside an Electron app is named as one. It never reads as a web address.
        if view["documentKind"] as? String == "app-document" {
            alert.messageText = "sleight request for " + session + " in app document " + origin + " of " + (view["app"] as? String ?? "an app")
        } else { alert.messageText = "sleight request for " + session + " at " + origin }
        // Native plain text, outside the page. Exact destination, payload and
        // payment terms are visible to the person, and never emitted on stdout.
        alert.informativeText = words.body
        for choice in choices {
            alert.addButton(withTitle: choice == "once" ? words.allow : "Don't allow")
        }
        let result = personModal(alert, choices: choices, kind: "action").rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        if result >= 0 && result < choices.count { respond(id, choices[result]) }
        else { respond(id, "cancel") }
    }
    func respond(_ id: String, _ choice: String) {
        guard let frame = pending.removeValue(forKey: id), let choices = frame["choices"] as? [String],
            choices.contains(choice), let deadline = frame["deadline"] as? Double,
            deadline > Date().timeIntervalSince1970 * 1000, let nonce = nonce,
            let bytes = try? JSONSerialization.data(withJSONObject: ["id": id, "choice": choice, "nonce": nonce]) else { rebuildMenu(); return }
        outputLock.lock(); defer { outputLock.unlock() }
        output.write(bytes + Data([10]))
        rebuildMenu()
    }
}

// BEGIN HAND FRAME
// The ghost hand's stdin frames: a kind and global top-left screen points, nonce-bound and never answered. Exact keys only.
struct HandAct {
    let seq: Int, kind: String, pid: Int32, windowId: UInt32, at: CGPoint, path: [CGPoint], delay: Double, beats: Int
    var label: String? = nil
    var rect: CGRect? = nil, caretX: Double? = nil
}
// menu: the hand's setting, capture mode and the plugin version, for the shared host's Ghost Hand row.
// permissions: the Permissions submenu's rows (permissionsData), when the relay has them. usage: the usage row (usageData),
// when this session writes the action log and it has timed actions. A usage value this host can't admit drops only that row:
// a bad number must never take the glove down.
struct RingEvent {
    let seq: Int, state: String, pid: Int32, windowId: UInt32, at: CGPoint?, rect: CGRect?, label: String?
    var path: [CGPoint] = []
    var beats: Int = 1
    var caretX: Double? = nil, holdMs = 0, ok = false
}
// Labels are plain text: control, format (bidi overrides included) and separator characters go, then 40 characters and at
// most 80 scalars, so a stacked cluster cannot stretch the chip.
func handLabel(_ raw: Any?) -> String? {
    guard let text = raw as? String else { return nil }
    let dropped: [Unicode.GeneralCategory] = [.control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned]
    let kept = text.unicodeScalars.filter { !dropped.contains($0.properties.generalCategory) }
    var result = ""
    for character in String(String.UnicodeScalarView(kept)).prefix(40) {
        guard result.unicodeScalars.count + character.unicodeScalars.count <= 80 else { break }
        result.append(character)
    }
    return result
}
// END HAND FRAME
// BEGIN CURSOR PICKER
// C3 keeps picker messages and rendering separate from the action planners and consent cards.
struct CursorPickerMessage {
    let op: String, data: [String: Any]
    static func parse(_ data: [String: Any]) -> CursorPickerMessage? {
        guard let op = data["op"] as? String else { return nil }
        let base: Set<String> = ["hand", "nonce", "op"]
        switch op {
        case "catalog":
            guard Set(data.keys) == base.union(["rows"]), let rows = data["rows"] as? [[String: Any]], rows.count <= 512,
                rows.allSatisfy({ CursorPickerRow.valid($0) }) else { return nil }
        case "thumbnail":
            guard Set(data.keys) == base.union(["key", "frame"]), let key = data["key"] as? String,
                key.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                let raw = data["frame"] as? [String: Any], let frame = spriteFrame(raw), frame.table.count == 1,
                frame.table["idle"]?.columns.count == 1 else { return nil }
        case "style":
            guard Set(data.keys) == base.union(["style"]), let style = data["style"] as? String,
                ["ring", "seam", "glove", "sprite"].contains(style) else { return nil }
        case "notice":
            guard Set(data.keys) == base.union(["text"]), let text = data["text"] as? String, !text.isEmpty,
                text.utf8.count <= 12000, text.unicodeScalars.allSatisfy({ $0.value == 10 || !CharacterSet.controlCharacters.contains($0) && !CharacterSet.illegalCharacters.contains($0) }) else { return nil }
        case "input-check", "menu-check": guard Set(data.keys) == base else { return nil }
        case "options":
            // Perch mode (A2): the sprite's perch and lines settings, from the relay after a character frame.
            guard Set(data.keys) == base.union(["perch", "lines"]), let perch = data["perch"] as? NSNumber, let lines = data["lines"] as? NSNumber,
                CFGetTypeID(perch) == CFBooleanGetTypeID(), CFGetTypeID(lines) == CFBooleanGetTypeID() else { return nil }
        default: return nil
        }
        return CursorPickerMessage(op: op, data: data)
    }
}
enum CursorPickerRow {
    static func valid(_ row: [String: Any], nested: Bool = false) -> Bool {
        guard let title = row["title"] as? String, (1...60).contains(title.count),
            title.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) && $0.properties.generalCategory != .format }),
            Set(row.keys).isSubset(of: ["title", "op", "style", "character", "selected", "key", "children"]) else { return false }
        if let children = row["children"] as? [[String: Any]] {
            return !nested && Set(row.keys) == ["title", "children"] && children.count <= 512 && children.allSatisfy { valid($0, nested: true) }
        }
        switch row["op"] as? String {
        case "select":
            guard !nested, let style = row["style"] as? String, let on = row["selected"] as? NSNumber,
                CFGetTypeID(on) == CFBooleanGetTypeID() else { return false }
            if style == "sprite" {
                return Set(row.keys) == ["title", "op", "style", "character", "selected"] &&
                    (row["character"] as? String)?.range(of: "^[a-z0-9-]{1,48}$", options: .regularExpression) != nil
            }
            return ["ring", "seam", "glove"].contains(style) && Set(row.keys) == ["title", "op", "style", "selected"]
        case "import":
            return nested && Set(row.keys) == ["title", "op", "key"] &&
                (row["key"] as? String)?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        case "folder": return !nested && Set(row.keys) == ["title", "op"]
        case "lines":
            guard let on = row["selected"] as? NSNumber, CFGetTypeID(on) == CFBooleanGetTypeID() else { return false }
            return !nested && Set(row.keys) == ["title", "op", "selected"]
        default: return false
        }
    }
    static func defaults(_ style: String) -> [[String: Any]] {
        var rows: [[String: Any]] = [("ring", "Ring (Split Seam+)"), ("seam", "Plain ring"), ("glove", "Glove")].map {
            ["title": $0.1, "op": "select", "style": $0.0, "selected": style == $0.0]
        }
        rows.append(["title": "Add your Codex pets", "children": [[String: Any]]()])
        rows.append(["title": "Open characters folder", "op": "folder"])
        return rows
    }
}
func writeCursorPickerEvent(_ event: [String: String]) {
    guard let nonce = nonceBook.nonce("hand"), let bytes = try? JSONSerialization.data(withJSONObject:
        event.merging(["hand": "picker", "nonce": nonce]) { $1 }, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(bytes + Data([10]))
}

// The cache contains only 32x32 PNGs generated from the checked child's pixels. Cache hits decode in that child too.
enum CursorThumbnailCache {
    struct Result { let image: CGImage, path: String, cached: Bool }
    static func root() -> String {
        let env = ProcessInfo.processInfo.environment
        if env["SLEIGHT_CURSOR_TEST"] == "1", let value = env["SLEIGHT_CURSOR_THUMBS_ROOT"], value.hasPrefix("/private/tmp/") { return value }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/sleight/thumbs").path
    }
    static func canonical(_ path: String) -> Bool {
        var name = [CChar](repeating: 0, count: Int(PATH_MAX))
        return realpath(path, &name) != nil && String(cString: name) == path
    }
    static func directory(_ root: String) throws -> Int32 {
        var ancestor = root
        while access(ancestor, F_OK) != 0 { ancestor = (ancestor as NSString).deletingLastPathComponent }
        guard canonical(ancestor) else { throw SpriteLoadError.path }
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard canonical(root) else { throw SpriteLoadError.path }
        // The private bank and its sleight parent follow the same owner/write rules as character storage.
        for path in [root, (root as NSString).deletingLastPathComponent] {
            var st = stat()
            guard lstat(path, &st) == 0, st.st_mode & S_IFMT == S_IFDIR, st.st_uid == getuid(), st.st_mode & 0o7022 == 0 else { throw SpriteLoadError.permissions }
        }
        let fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard fd >= 0 else { throw SpriteLoadError.path }
        var opened = stat(), name = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fstat(fd, &opened) == 0, opened.st_mode & S_IFMT == S_IFDIR, opened.st_uid == getuid(), opened.st_mode & 0o7022 == 0,
            fcntl(fd, F_GETPATH, &name) == 0, String(cString: name) == root else { close(fd); throw SpriteLoadError.path }
        return fd
    }
    static func read(_ path: String, cancelled: @escaping () -> Bool) throws -> CGImage {
        var before = stat()
        guard lstat(path, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_uid == getuid(),
            before.st_nlink == 1, before.st_mode & 0o7777 == 0o600 else { throw SpriteLoadError.permissions }
        guard before.st_size > 0, before.st_size <= 65536 else { throw SpriteLoadError.size }
        let fd = open(path, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw SpriteLoadError.path }; defer { close(fd) }
        var opened = stat(), name = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fstat(fd, &opened) == 0, opened.st_dev == before.st_dev, opened.st_ino == before.st_ino,
            opened.st_mode == before.st_mode, opened.st_uid == before.st_uid, opened.st_nlink == 1,
            opened.st_size == before.st_size, fcntl(fd, F_GETPATH, &name) == 0, String(cString: name) == path else { throw SpriteLoadError.changed }
        var header = [UInt8](repeating: 0, count: 64)
        let count = pread(fd, &header, 64, 0)
        guard count > 0, let h = spriteSheetHeader(Array(header.prefix(count))), h.format == "png", h.width == 32, h.height == 32 else { throw SpriteLoadError.type }
        let bytes = try spriteDecodeInChild(fd: fd, width: 32, height: 32, format: "png", cancelled: cancelled)
        guard let provider = CGDataProvider(dataInfo: nil, data: bytes, size: 4096, releaseData: { _, data, _ in free(UnsafeMutableRawPointer(mutating: data)) }) else { free(bytes); throw SpriteLoadError.decode }
        var after = stat()
        guard fstat(fd, &after) == 0, after.st_size == opened.st_size, after.st_nlink == 1, after.st_mode == opened.st_mode,
            after.st_mtimespec.tv_sec == opened.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == opened.st_mtimespec.tv_nsec,
            after.st_ctimespec.tv_sec == opened.st_ctimespec.tv_sec, after.st_ctimespec.tv_nsec == opened.st_ctimespec.tv_nsec,
            let space = CGColorSpace(name: CGColorSpace.sRGB), let image = CGImage(width: 32, height: 32, bitsPerComponent: 8,
                bitsPerPixel: 32, bytesPerRow: 128, space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { throw SpriteLoadError.changed }
        return image
    }
    static func entries(_ dir: Int32) -> [(String, stat)] {
        guard let stream = fdopendir(dup(dir)) else { return [] }; defer { closedir(stream) }
        // dup shares the directory offset. Rewind so later maintenance sees the whole bank too.
        rewinddir(stream)
        var entries: [(String, stat)] = []
        while let entry = readdir(stream) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
            }
            var st = stat()
            if fstatat(dir, name, &st, AT_SYMLINK_NOFOLLOW) == 0,
                st.st_mode & S_IFMT == S_IFREG, st.st_uid == getuid(), st.st_mode & 0o7777 == 0o600 {
                entries.append((name, st))
            }
        }
        return entries
    }
    static func unlinkChecked(_ name: String, _ st: stat, dir: Int32) {
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(dir, F_GETPATH, &path) == 0, String(cString: path) == root(), canonical(root()) else { return }
        var current = stat()
        if fstatat(dir, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
            current.st_dev == st.st_dev, current.st_ino == st.st_ino, current.st_uid == getuid(),
            current.st_mode == st.st_mode, current.st_nlink == st.st_nlink {
            _ = unlinkat(dir, name, 0)
        }
    }
    static func maintain(_ dir: Int32, limit: Int = 64) {
        let now = Date().timeIntervalSince1970
        for (name, st) in entries(dir) where name.hasPrefix(".thumb-") &&
            (st.st_nlink == 1 || st.st_nlink == 2) &&
            now - (Double(st.st_mtimespec.tv_sec) + Double(st.st_mtimespec.tv_nsec) / 1e9) > 600 {
            unlinkChecked(name, st, dir: dir)
        }
        let published = entries(dir).filter { name, st in
            name.range(of: "^[0-9a-f]{64}\\.png$", options: .regularExpression) != nil && st.st_nlink == 1
        }.sorted { a, b in
            if a.1.st_mtimespec.tv_sec != b.1.st_mtimespec.tv_sec { return a.1.st_mtimespec.tv_sec < b.1.st_mtimespec.tv_sec }
            if a.1.st_mtimespec.tv_nsec != b.1.st_mtimespec.tv_nsec { return a.1.st_mtimespec.tv_nsec < b.1.st_mtimespec.tv_nsec }
            return a.0 < b.0
        }
        for (name, st) in published.prefix(max(0, published.count - limit)) { unlinkChecked(name, st, dir: dir) }
    }
    static func repairStagingLink(_ name: String, dir: Int32) -> Bool {
        var st = stat()
        guard fstatat(dir, name, &st, AT_SYMLINK_NOFOLLOW) == 0, st.st_mode & S_IFMT == S_IFREG,
            st.st_uid == getuid(), st.st_mode & 0o7777 == 0o600, st.st_nlink == 2 else { return false }
        // Repair only a link pair left by our staging protocol, never an alias outside this directory.
        guard let staging = entries(dir).first(where: { $0.0.hasPrefix(".thumb-") && $0.1.st_nlink == 2 &&
            $0.1.st_dev == st.st_dev && $0.1.st_ino == st.st_ino }) else { return false }
        unlinkChecked(name, st, dir: dir)
        var remaining = stat()
        if fstatat(dir, staging.0, &remaining, AT_SYMLINK_NOFOLLOW) == 0,
            remaining.st_dev == st.st_dev, remaining.st_ino == st.st_ino, remaining.st_nlink == 1 {
            unlinkChecked(staging.0, remaining, dir: dir)
        }
        var absent = stat()
        return fstatat(dir, name, &absent, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT
    }
    static func load(_ frame: SpriteFrame, key: String, cancelled: @escaping () -> Bool = { false }) throws -> Result {
        guard !cancelled() else { throw SpriteLoadError.cancelled }
        guard key.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw SpriteLoadError.path }
        let root = root(), dir = try directory(root); defer { close(dir) }
        maintain(dir)
        let name = key + ".png", path = root + "/" + name
        var st = stat()
        if fstatat(dir, name, &st, AT_SYMLINK_NOFOLLOW) == 0 {
            if !repairStagingLink(name, dir: dir) {
                do { return Result(image: try read(path, cancelled: cancelled), path: path, cached: true) }
                catch {
                    guard !cancelled(), st.st_mode & S_IFMT == S_IFREG, st.st_uid == getuid(),
                        st.st_nlink == 1, st.st_mode & 0o7022 == 0 else { throw error }
                    // A refused owned regular entry (mode, size or corrupt PNG) gets one regeneration attempt.
                    unlinkChecked(name, st, dir: dir)
                    var absent = stat()
                    guard fstatat(dir, name, &absent, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw error }
                }
            }
        } else if errno != ENOENT { throw SpriteLoadError.path }
        let loaded = SpriteCharacter.check(frame, cancelled: cancelled)
        guard let character = loaded.character, let idle = frame.table["idle"], let sheet = character.images[idle.sheet],
            let first = idle.columns.first, let cell = sheet.cropping(to: CGRect(x: CGFloat(first) * frame.cell.width,
                y: CGFloat(idle.row) * frame.cell.height, width: frame.cell.width, height: frame.cell.height)),
            let space = CGColorSpace(name: CGColorSpace.sRGB), let context = CGContext(data: nil, width: 32, height: 32,
                bitsPerComponent: 8, bytesPerRow: 128, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw SpriteLoadError.decode }
        let scale = min(32 / frame.cell.width, 32 / frame.cell.height), width = frame.cell.width * scale, height = frame.cell.height * scale
        if idle.flip { context.translateBy(x: 32, y: 0); context.scaleBy(x: -1, y: 1) }
        context.interpolationQuality = .high
        context.draw(cell, in: CGRect(x: (32 - width) / 2, y: (32 - height) / 2, width: width, height: height))
        guard let image = context.makeImage() else { throw SpriteLoadError.decode }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { throw SpriteLoadError.decode }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination), data.length <= 65536 else { throw SpriteLoadError.decode }
        guard !cancelled() else { throw SpriteLoadError.cancelled }
        // Write under the checked directory descriptor, never through a followed link or an existing filename.
        let staging = ".thumb-" + UUID().uuidString
        let output = openat(dir, staging, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard output >= 0 else { throw SpriteLoadError.path }
        defer { close(output); unlinkat(dir, staging, 0); maintain(dir) }
        var currentName = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fchmod(output, 0o600) == 0, write(output, data.bytes, data.length) == data.length,
            canonical(root), fcntl(dir, F_GETPATH, &currentName) == 0, String(cString: currentName) == root else { throw SpriteLoadError.changed }
        if ProcessInfo.processInfo.environment["SLEIGHT_CURSOR_TEST"] == "1",
            ProcessInfo.processInfo.environment["SLEIGHT_CURSOR_THUMB_FAULT"] == "eexist", root.hasPrefix("/private/tmp/") {
            _ = linkat(dir, staging, dir, name, 0)
        }
        if linkat(dir, staging, dir, name, 0) != 0 {
            // Another host won publication. Our already decoded pixels are still safe to use.
            guard errno == EEXIST else { throw SpriteLoadError.changed }
            return Result(image: image, path: path, cached: false)
        }
        // Removing the private staging name restores the single-link rule before anyone reads the published PNG.
        guard unlinkat(dir, staging, 0) == 0 else { throw SpriteLoadError.changed }
        return Result(image: image, path: path, cached: false)
    }
}

final class CursorPickerNoticePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
final class CursorPickerGeneration {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int { lock.lock(); defer { lock.unlock() }; value += 1; return value }
    func contains(_ ticket: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return value == ticket }
}
final class CursorPickerMenuItem: NSMenuItem {
    var refused: (() -> Void)?
    override func accessibilityPerformPress() -> Bool { refused?(); return false }
    override func accessibilityPerformAction(_ action: NSAccessibility.Action) {
        if action == .press { refused?() } else { super.accessibilityPerformAction(action) }
    }
}
// NSMenu exposes no public window property. A non-drawing, one-point spacer observes the window AppKit
// actually attaches our submenu to; no guessed current-event window or private AppKit class is trusted.
final class CursorPickerWindowProbe: NSView {
    weak var owner: CursorPickerMenu?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window = window { owner?.trackingWindow = window }
    }
}
final class CursorPickerMenu: NSMenu {
    weak var trackingWindow: NSWindow?
    weak var lastHighlighted: NSMenuItem?
    func addWindowProbe() {
        let probe = CursorPickerWindowProbe(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
        probe.owner = self; probe.setAccessibilityElement(false)
        let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        item.view = probe; item.isEnabled = false; addItem(item)
    }
}
final class CursorPickerHost: NSObject, NSMenuDelegate {
    var rows = CursorPickerRow.defaults("glove"), images: [String: NSImage] = [:]
    var imageKeys: [String: String] = [:]
    var characterItems: [String: NSMenuItem] = [:]
    var noticeSink: ((String) -> Void)?
    var notice: NSPanel?, generation = 0
    let epoch = CursorPickerGeneration()
    let thumbnails = DispatchQueue(label: "com.sleight.cursor-thumbnails", qos: .utility)
    weak var submenu: NSMenu?
    func install(in menu: NSMenu, enabled: Bool) {
        guard enabled else { return }
        let entry = NSMenuItem(title: "Cursor", action: nil, keyEquivalent: ""), inner = CursorPickerMenu()
        inner.delegate = self
        entry.submenu = inner; submenu = inner; fill(inner)
        // Keep the controls above help and the version footer, also in a turbo menu.
        let help = menu.items.firstIndex { $0.action == #selector(ConsentHost.help(_:)) } ?? menu.numberOfItems
        let at = help > 0 && menu.item(at: help - 1)?.isSeparatorItem == true ? help - 1 : help
        menu.insertItem(NSMenuItem.separator(), at: at); menu.insertItem(entry, at: at + 1)
    }
    func fill(_ menu: NSMenu) {
        menu.removeAllItems()
        characterItems.removeAll()
        (menu as? CursorPickerMenu)?.addWindowProbe()
        func item(_ row: [String: Any]) -> NSMenuItem {
            let entry = CursorPickerMenuItem(title: row["title"] as! String, action: nil, keyEquivalent: "")
            entry.refused = { [weak self] in self?.refuseSelection() }
            if let children = row["children"] as? [[String: Any]] {
                let inner = CursorPickerMenu(); inner.delegate = self; inner.addWindowProbe()
                children.forEach { inner.addItem(item($0)) }
                if children.isEmpty { inner.addItem(NSMenuItem(title: "No new Codex pets found", action: nil, keyEquivalent: "")) }
                entry.submenu = inner
            } else {
                entry.target = self; entry.action = #selector(click(_:)); entry.representedObject = row
                entry.state = row["selected"] as? Bool == true ? .on : .off
                if let id = row["character"] as? String { entry.image = images[id]; characterItems[id] = entry }
            }
            return entry
        }
        rows.forEach { menu.addItem(item($0)) }
    }
    func menuWillOpen(_ menu: NSMenu) { (menu as? CursorPickerMenu)?.lastHighlighted = nil }
    func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
        if let item = item { (menu as? CursorPickerMenu)?.lastHighlighted = item }
    }
    @objc func click(_ sender: NSMenuItem) {
        let current = NSApp.currentEvent
        guard let menu = sender.menu as? CursorPickerMenu, let window = menu.trackingWindow,
            personActivation(current, in: window, highlighted: sender.isHighlighted || menu.lastHighlighted === sender)
            else { refuseSelection(); return }
        guard let row = sender.representedObject as? [String: Any], CursorPickerRow.valid(row, nested: row["op"] as? String == "import") else { return }
        if row["op"] as? String == "folder" {
            // A click opens the existing folder in Finder. No shell or script receives the path.
            do {
                let directory = try CursorThumbnailCache.directory(SpriteCharacter.root()); close(directory)
                if !NSWorkspace.shared.open(URL(fileURLWithPath: SpriteCharacter.root(), isDirectory: true)) { showNotice("The characters folder could not open.") }
            } catch { showNotice("The characters folder is unsafe to open. Check its owner, permissions and links.") }
            return
        }
        var event: [String: String] = [:]
        for key in ["op", "style", "character", "key"] { if let value = row[key] as? String { event[key] = value } }
        if row["op"] as? String == "lines" { event["lines"] = row["selected"] as? Bool == true ? "off" : "on" } // the toggle's new value
        writeCursorPickerEvent(event)
    }
    func refuseSelection() { refuseConsentInput(); showNotice("Choose with the mouse or keyboard") }
    func setThumbnail(_ image: NSImage, id: String, key: String) {
        images[id] = image; imageKeys[id] = key
        characterItems[id]?.image = image
    }
    func receive(_ message: CursorPickerMessage) {
        switch message.op {
        case "catalog":
            generation = epoch.next(); rows = message.data["rows"] as! [[String: Any]]
            let ids = Set(rows.compactMap { $0["character"] as? String }); images = images.filter { ids.contains($0.key) }
            imageKeys = imageKeys.filter { ids.contains($0.key) }
            if let menu = submenu { fill(menu) }
        case "thumbnail":
            let raw = message.data["frame"] as! [String: Any], frame = spriteFrame(raw)!, key = message.data["key"] as! String, ticket = generation
            guard imageKeys[frame.id] != key else { return }
            let epoch = self.epoch
            thumbnails.async { [weak self] in
                guard let result = try? CursorThumbnailCache.load(frame, key: key, cancelled: { !epoch.contains(ticket) }) else { return }
                DispatchQueue.main.async {
                    guard let self = self, self.generation == ticket else { return }
                    let image = NSImage(cgImage: result.image, size: NSSize(width: 16, height: 16))
                    self.setThumbnail(image, id: frame.id, key: key)
                }
            }
        case "notice": showNotice(message.data["text"] as! String)
        default: break
        }
    }
    func showNotice(_ text: String) {
        if let sink = noticeSink { sink(text); return }
        notice?.close()
        let panel = CursorPickerNoticePanel(contentRect: NSRect(x: 0, y: 0, width: 390, height: 240), styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "sleight character"; panel.level = .floating; panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]; panel.sharingType = .none
        let scroll = NSScrollView(frame: NSRect(x: 12, y: 12, width: 366, height: 216)); scroll.hasVerticalScroller = true
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 346, height: 216)); view.isEditable = false; view.isSelectable = true
        view.font = NSFont.systemFont(ofSize: 12); view.string = text; view.textContainer?.widthTracksTextView = true
        scroll.documentView = view; panel.contentView?.addSubview(scroll)
        if let screen = NSScreen.main { panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.maxX - 410, y: screen.visibleFrame.maxY - 12)) }
        notice = panel; panel.orderFrontRegardless()
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self, weak panel] in
            if self?.notice === panel { panel?.close(); self?.notice = nil }
        }
    }
}
func cursorMenuDump() {
    var bound: String?
    while let line = readLine() {
        guard line.utf8.count <= 65536, let bytes = line.data(using: .utf8), let raw = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
            raw["hand"] as? String == "picker", let nonce = raw["nonce"] as? String,
            nonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil, bound == nil || bound == nonce,
            let message = CursorPickerMessage.parse(raw) else { exit(65) }
        bound = nonce
        var out: [String: Any] = [:]
        switch message.op {
        case "catalog": out = ["rows": message.data["rows"]!]
        case "menu-check":
            // Objects only. No application loop, ordered windows, event posting or image drawing.
            let picker = CursorPickerHost(), menu = NSMenu()
            picker.rows = [
                ["title": "Cat", "op": "select", "style": "sprite", "character": "cat", "selected": true],
                ["title": "Dog", "op": "select", "style": "sprite", "character": "dog", "selected": false]]
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Settings & Help", action: #selector(ConsentHost.help(_:)), keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "sleight 1.5.1", action: nil, keyEquivalent: ""))
            picker.install(in: menu, enabled: true)
            let inner = picker.submenu!, cat = picker.characterItems["cat"]!, dog = picker.characterItems["dog"]!
            let image = NSImage(size: NSSize(width: 16, height: 16))
            picker.setThumbnail(image, id: "cat", key: "fixture")
            var notices: [String] = []; picker.noticeSink = { notices.append($0) }
            let ax = (cat as! CursorPickerMenuItem).accessibilityPerformPress()
            cat.accessibilityPerformAction(.press)
            out = ["sameItems": inner.item(at: 1) === cat && inner.item(at: 2) === dog,
                "onlyCatChanged": cat.image === image && dog.image == nil && cat.state == .on,
                "separator": menu.item(at: 0)?.isSeparatorItem == true && menu.item(at: 1)?.title == "Cursor",
                "aboveHelp": menu.items.firstIndex(where: { $0.title == "Cursor" })! < menu.items.firstIndex(where: { $0.title == "Settings & Help" })!,
                "axRefused": !ax, "notices": notices]
        case "input-check":
            func check(_ pid: Int64 = 0, _ type: CGEventType = .leftMouseUp, age: Double = 0,
                key: CGKeyCode = 49, highlighted: Bool = true, windowMatches: Bool = true, ax: Bool = false) -> Bool {
                guard let source = CGEventSource(stateID: .hidSystemState), let cg = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true) else { return false }
                cg.type = type; cg.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
                cg.setIntegerValueField(.eventSourceUserData, value: 0)
                cg.timestamp = DispatchTime.now().uptimeNanoseconds - UInt64(max(0, age) * 1_000_000_000)
                guard let event = NSEvent(cgEvent: cg) else { return false }
                return personActivation(event, windowMatches: windowMatches, highlighted: highlighted, accessibility: ax,
                    now: age < 0 ? event.timestamp - 1 : ProcessInfo.processInfo.systemUptime)
            }
            let item = CursorPickerMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
            var refused = 0; item.refused = { refused += 1 }
            let axResult = item.accessibilityPerformPress(); item.accessibilityPerformAction(.press)
            out = ["hardware": check(), "synthetic": check(1234), "keyboard": check(0, .keyDown),
                "return": check(0, .keyDown, key: 36), "enter": check(0, .keyDown, key: 76),
                "otherKey": check(0, .keyDown, key: 0), "unhighlighted": check(0, .keyDown, highlighted: false),
                "old": check(age: 5.1), "future": check(age: -1), "mouseDown": check(0, .leftMouseDown),
                "wrongWindow": check(windowMatches: false), "ax": check(ax: true),
                "axMethodsRefused": !axResult && refused == 2,
                "absent": personActivation(nil, windowMatches: true)]
        case "thumbnail":
            do {
                let result = try CursorThumbnailCache.load(spriteFrame(message.data["frame"] as! [String: Any])!, key: message.data["key"] as! String)
                out = ["loaded": true, "cached": result.cached, "path": result.path]
            } catch { out = ["loaded": false, "reason": (error as? SpriteLoadError)?.rawValue ?? "decode"] }
        case "notice": out = ["text": message.data["text"]!]
        default: out = ["style": message.data["style"]!]
        }
        let bytesOut = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
        FileHandle.standardOutput.write(bytesOut + Data([10]))
    }
}
// END CURSOR PICKER
// BEGIN HAND FRAME TAIL
enum HandFrame { case picker(String, CursorPickerMessage), character(String, SpriteFrame), act(String, HandAct), aim(String, RingEvent), status(String, RingEvent), hide(String), menu(String, enabled: Bool, capture: String, version: String, permissions: PermissionsData?, usage: UsageStats?) }
let handKinds: Set<String> = ["click", "double", "right", "key", "type", "drag", "scroll"]
func handFrame(_ data: [String: Any]) -> HandFrame? {
    func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
        return value.doubleValue
    }
    func integer(_ value: Any?, _ range: ClosedRange<Double>) -> Int? {
        guard let value = number(value), value.rounded() == value, range.contains(value) else { return nil }
        return Int(value)
    }
    func point(_ value: Any?) -> CGPoint? {
        guard let pair = value as? [Any], pair.count == 2, let x = number(pair[0]), let y = number(pair[1]),
            abs(x) <= 100000, abs(y) <= 100000 else { return nil }
        return CGPoint(x: x, y: y)
    }
    // nil for a bad rect, .some(nil) for none.
    func rectValue(_ raw: Any?) -> CGRect?? {
        guard let raw = raw else { return .some(nil) }
        guard let values = raw as? [Any], values.count == 4,
            let origin = point(Array(values.prefix(2))), let w = number(values[2]), let h = number(values[3]),
            w > 0, h > 0, w <= 100000, h <= 100000 else { return nil }
        return .some(CGRect(origin: origin, size: CGSize(width: w, height: h)))
    }
    guard let nonce = data["nonce"] as? String, nonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { return nil }
    if data["hand"] as? String == "picker" { return CursorPickerMessage.parse(data).map { .picker(nonce, $0) } }
    if data["hand"] as? String == "character" { return spriteFrame(data).map { .character(nonce, $0) } }
    if data["hand"] as? String == "hide" { return Set(data.keys) == ["hand", "nonce"] ? .hide(nonce) : nil }
    if data["hand"] as? String == "menu" {
        let keys: Set<String> = ["hand", "nonce", "enabled", "capture", "version"]
        guard keys.isSubset(of: Set(data.keys)), Set(data.keys).subtracting(keys).isSubset(of: ["permissions", "usage"]),
            let enabled = data["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(),
            let capture = data["capture"] as? String, ["hidden", "visible"].contains(capture),
            let version = data["version"] as? String, version.range(of: #"^\d{1,3}\.\d{1,3}\.\d{1,3}$"#, options: .regularExpression) != nil
            else { return nil }
        let permissions = data["permissions"].map { permissionsData($0) }
        if let parsed = permissions, parsed == nil { return nil }
        return .menu(nonce, enabled: enabled.boolValue, capture: capture, version: version, permissions: permissions ?? nil, usage: usageData(data["usage"]))
    }
    if let tag = data["hand"] as? String, ["aim", "status"].contains(tag) {
        let keys: Set<String> = tag == "aim" ? ["hand", "nonce", "seq", "kind", "pid", "windowId", "at"] : ["hand", "nonce", "seq", "state", "pid", "windowId"]
        let optional: Set<String> = tag == "aim" ? ["rect", "holdMs", "label"] : ["at", "ok"]
        guard keys.isSubset(of: Set(data.keys)), Set(data.keys).subtracting(keys).isSubset(of: optional),
            data["ok"] == nil || (data["state"] as? String == "done" && (data["ok"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } == true),
            let seq = integer(data["seq"], 0...9007199254740991),
            let pid = integer(data["pid"], 1...2147483647), let window = integer(data["windowId"], 1...4294967295),
            data["at"] == nil || point(data["at"]) != nil,
            data["label"] == nil || data["label"] is String else { return nil }
        guard let rect = rectValue(data["rect"]) else { return nil }
        let state: String
        if tag == "aim" {
            guard let kind = data["kind"] as? String, handKinds.contains(kind),
                data["holdMs"] == nil || integer(data["holdMs"], 0...600) != nil else { return nil }
            state = "aim"
        } else {
            guard let value = data["state"] as? String, ["waiting", "error", "done", "handback", "thinking"].contains(value) else { return nil }
            state = value
        }
        let event = RingEvent(seq: seq, state: state, pid: Int32(pid), windowId: UInt32(window), at: point(data["at"]), rect: rect,
            label: handLabel(data["label"]), holdMs: integer(data["holdMs"], 0...600) ?? 0, ok: (data["ok"] as? NSNumber)?.boolValue ?? false)
        return tag == "aim" ? .aim(nonce, event) : .status(nonce, event)
    }
    let actKeys: Set<String> = ["hand", "nonce", "seq", "kind", "pid", "windowId", "at", "path", "delayMs", "beats"]
    guard data["hand"] as? String == "act", actKeys.isSubset(of: Set(data.keys)),
        Set(data.keys).subtracting(actKeys).isSubset(of: ["label", "rect", "caretX"]), data["label"] == nil || data["label"] is String,
        let rect = rectValue(data["rect"]), data["caretX"] == nil || ((data["kind"] as? String).map { ["type", "key"].contains($0) } == true
            && number(data["caretX"]).map { abs($0) <= 100000 } == true),
        let seq = integer(data["seq"], 0...9007199254740991), let kind = data["kind"] as? String, handKinds.contains(kind),
        let pid = integer(data["pid"], 1...2147483647), let windowId = integer(data["windowId"], 1...4294967295),
        let at = point(data["at"]), let raw = data["path"] as? [Any], (1...64).contains(raw.count),
        let delay = integer(data["delayMs"], 0...10000), let beats = integer(data["beats"], 1...20) else { return nil }
    let path = raw.compactMap(point)
    guard path.count == raw.count else { return nil }
    return .act(nonce, HandAct(seq: seq, kind: kind, pid: Int32(pid), windowId: UInt32(windowId), at: at, path: path,
        delay: Double(delay) / 1000, beats: beats, label: handLabel(data["label"]), rect: rect, caretX: number(data["caretX"])))
}
// Consecutive repeats dropped, so a one-point route means the hand appears there without a glide.
func handPoints(_ points: [CGPoint]) -> [CGPoint] {
    points.enumerated().filter { $0.offset == 0 || points[$0.offset - 1] != $0.element }.map { $0.element }
}
// The panel's frame for a route: the route's box plus 48 pt, before clipping to the target window.
func handBox(_ points: [CGPoint]) -> CGRect {
    let xs = points.map { $0.x }, ys = points.map { $0.y }
    guard let left = xs.min(), let right = xs.max(), let top = ys.min(), let bottom = ys.max() else { return .null }
    return CGRect(x: left - 48, y: top - 48, width: right - left + 96, height: bottom - top + 96)
}
// END HAND FRAME TAIL

// BEGIN HAND ART
// The one place for the ghost hand's look and motion: the art director's H7 deliverables (2026-10-18, approved by the owner at
// 85% opacity). Every state is a vector SVG on one 48 pt canvas with the hotspot, the index fingertip or the pinch in grab, at
// (10, 10). The dabs are their own layer under the glove, shared by every state. No arrow: the real cursor is data.
enum HandState: String, CaseIterable { case rest, point, press, grab, scroll, dabs }
enum HandArt {
    static let canvas: CGFloat = 48, hotspot = CGPoint(x: 10, y: 10)
    static let opacity = 0.85, lifted = 0.6
    // The hand's axis from tip to wrist in top-left screen points. Entry, hold, lift and fade move along it.
    static let axis = CGVector(dx: 0.574, dy: 0.819)
    static var anchor: CGPoint { CGPoint(x: hotspot.x / canvas, y: 1 - hotspot.y / canvas) }
    // A frame's kind to the glove's content while it approaches and while it acts. After the act it lifts as rest.
    static let states: [String: (approach: HandState, act: HandState)] = ["click": (.point, .press), "double": (.point, .press),
        "right": (.point, .press), "key": (.point, .point), "type": (.point, .point), "scroll": (.scroll, .scroll), "drag": (.point, .grab)]
    // The deliverables verbatim (rest, point, press, grab, scroll, dabs), the way the menu glyph is embedded.
    static let svg: [HandState: String] = [
        .rest: ##"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<!-- sleight ghost hand, state "rest". Canvas 48 pt, hotspot (10,10) = the index fingertip (grab: the pinch). Generated by gen.mjs. -->
<g transform="translate(0.6 0.6)"><g transform="translate(10 10) rotate(-35)"><path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M0.83 13.52 L-5.04 7.13 A1.25 1.25 0 0 0 -6.93 8.76 L-1.43 15.48 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M6.15 11.51 L5.17 -0.67 A1.2 1.2 0 0 0 2.77 -0.53 L3.25 11.69 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M9.85 11.59 L9.51 0.29 A1.2 1.2 0 0 0 7.11 0.31 L6.95 11.61 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M13.5 11.68 L13.68 3.81 A1.15 1.15 0 0 0 11.39 3.68 L10.7 11.52 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/>
<path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M0.83 13.52 L-5.04 7.13 A1.25 1.25 0 0 0 -6.93 8.76 L-1.43 15.48 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M6.15 11.51 L5.17 -0.67 A1.2 1.2 0 0 0 2.77 -0.53 L3.25 11.69 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.85 11.59 L9.51 0.29 A1.2 1.2 0 0 0 7.11 0.31 L6.95 11.61 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 11.68 L13.68 3.81 A1.15 1.15 0 0 0 11.39 3.68 L10.7 11.52 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M0.83 13.52 L-5.04 7.13 A1.25 1.25 0 0 0 -6.93 8.76 L-1.43 15.48 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M6.15 11.51 L5.17 -0.67 A1.2 1.2 0 0 0 2.77 -0.53 L3.25 11.69 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M9.85 11.59 L9.51 0.29 A1.2 1.2 0 0 0 7.11 0.31 L6.95 11.61 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M13.5 11.68 L13.68 3.81 A1.15 1.15 0 0 0 11.39 3.68 L10.7 11.52 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/></g></g>
<g transform="translate(10 10) rotate(-35)"><path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#B9BFC9"/><path d="M-2.02 12.19 Q-2.2 10.8 -0.8 10.8 L10 10.8 Q11.4 10.8 11.24 12.19 L10.86 15.61 Q10.7 17 9.89 18.14 L9.81 18.26 Q9 19.4 7.6 19.4 L5 19.4 Q3.6 19.4 2.34 18.79 L-0.14 17.61 Q-1.4 17 -1.58 15.61 Z" fill="#EFE9DC"/>
<path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#B9BFC9"/><path d="M-4 14 A2 2.8 0 1 0 0 14 A2 2.8 0 1 0 -4 14 Z" fill="#EFE9DC"/>
<path d="M0.83 13.52 L-5.04 7.13 A1.25 1.25 0 0 0 -6.93 8.76 L-1.43 15.48 Z" fill="#B9BFC9"/><path d="M0.83 13.51 L-5.21 6.91 A0.78 0.78 0 0 0 -6.38 7.93 L-0.57 14.74 Z" fill="#EFE9DC"/>
<path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#B9BFC9"/><path d="M1.35 11.58 L0.36 0.91 A0.74 0.74 0 0 0 -1.12 1.03 L-0.45 11.72 Z" fill="#EFE9DC"/>
<path d="M6.15 11.51 L5.17 -0.67 A1.2 1.2 0 0 0 2.77 -0.53 L3.25 11.69 Z" fill="#B9BFC9"/><path d="M5.05 11.59 L4.24 -0.88 A0.74 0.74 0 0 0 2.75 -0.8 L3.25 11.68 Z" fill="#EFE9DC"/>
<path d="M9.85 11.59 L9.51 0.29 A1.2 1.2 0 0 0 7.11 0.31 L6.95 11.61 Z" fill="#B9BFC9"/><path d="M8.75 11.6 L8.59 0.04 A0.74 0.74 0 0 0 7.1 0.04 L6.95 11.6 Z" fill="#EFE9DC"/>
<path d="M13.5 11.68 L13.68 3.81 A1.15 1.15 0 0 0 11.39 3.68 L10.7 11.52 Z" fill="#B9BFC9"/><path d="M12.43 11.63 L12.82 3.52 A0.71 0.71 0 0 0 11.39 3.42 L10.7 11.51 Z" fill="#EFE9DC"/>
</g>
</svg>
"""##,
        .point: ##"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<!-- sleight ghost hand, state "point". Canvas 48 pt, hotspot (10,10) = the index fingertip (grab: the pinch). Generated by gen.mjs. -->
<g transform="translate(0.6 0.6)"><g transform="translate(10 10) rotate(-35)"><path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M0.81 13.5 L-3.13 9.49 A1.25 1.25 0 0 0 -4.99 11.17 L-1.41 15.5 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M6.2 11.6 L6.05 8.75 A1.35 1.35 0 0 0 3.35 8.75 L3.2 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M9.9 11.6 L9.75 9.15 A1.35 1.35 0 0 0 7.05 9.15 L6.9 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M13.5 11.6 L13.36 9.76 A1.26 1.26 0 0 0 10.84 9.76 L10.7 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/>
<path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M0.81 13.5 L-3.13 9.49 A1.25 1.25 0 0 0 -4.99 11.17 L-1.41 15.5 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M6.2 11.6 L6.05 8.75 A1.35 1.35 0 0 0 3.35 8.75 L3.2 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.9 11.6 L9.75 9.15 A1.35 1.35 0 0 0 7.05 9.15 L6.9 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 11.6 L13.36 9.76 A1.26 1.26 0 0 0 10.84 9.76 L10.7 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M0.81 13.5 L-3.13 9.49 A1.25 1.25 0 0 0 -4.99 11.17 L-1.41 15.5 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M6.2 11.6 L6.05 8.75 A1.35 1.35 0 0 0 3.35 8.75 L3.2 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M9.9 11.6 L9.75 9.15 A1.35 1.35 0 0 0 7.05 9.15 L6.9 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M13.5 11.6 L13.36 9.76 A1.26 1.26 0 0 0 10.84 9.76 L10.7 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/></g></g>
<g transform="translate(10 10) rotate(-35)"><path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#B9BFC9"/><path d="M-2.02 12.19 Q-2.2 10.8 -0.8 10.8 L10 10.8 Q11.4 10.8 11.24 12.19 L10.86 15.61 Q10.7 17 9.89 18.14 L9.81 18.26 Q9 19.4 7.6 19.4 L5 19.4 Q3.6 19.4 2.34 18.79 L-0.14 17.61 Q-1.4 17 -1.58 15.61 Z" fill="#EFE9DC"/>
<path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#B9BFC9"/><path d="M-4 14 A2 2.8 0 1 0 0 14 A2 2.8 0 1 0 -4 14 Z" fill="#EFE9DC"/>
<path d="M0.81 13.5 L-3.13 9.49 A1.25 1.25 0 0 0 -4.99 11.17 L-1.41 15.5 Z" fill="#B9BFC9"/><path d="M0.81 13.49 L-3.32 9.27 A0.78 0.78 0 0 0 -4.45 10.32 L-0.56 14.75 Z" fill="#EFE9DC"/>
<path d="M6.2 11.6 L6.05 8.75 A1.35 1.35 0 0 0 3.35 8.75 L3.2 11.6 Z" fill="#B9BFC9"/><path d="M4.94 11.61 L4.9 8.41 A0.78 0.78 0 0 0 3.34 8.39 L3.2 11.59 Z" fill="#EFE9DC"/>
<path d="M9.9 11.6 L9.75 9.15 A1.35 1.35 0 0 0 7.05 9.15 L6.9 11.6 Z" fill="#B9BFC9"/><path d="M8.64 11.61 L8.6 8.81 A0.78 0.78 0 0 0 7.03 8.79 L6.9 11.59 Z" fill="#EFE9DC"/>
<path d="M13.5 11.6 L13.36 9.76 A1.26 1.26 0 0 0 10.84 9.76 L10.7 11.6 Z" fill="#B9BFC9"/><path d="M12.32 11.62 L12.28 9.45 A0.73 0.73 0 0 0 10.82 9.42 L10.7 11.58 Z" fill="#EFE9DC"/>
<path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#B9BFC9"/><path d="M1.35 11.58 L0.36 0.91 A0.74 0.74 0 0 0 -1.12 1.03 L-0.45 11.72 Z" fill="#EFE9DC"/>
<path d="M3.2 11.1 H13.6" stroke="#A3ABB7" stroke-width="0.7" stroke-linecap="round" fill="none"/></g>
</svg>
"""##,
        .press: ##"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<!-- sleight ghost hand, state "press". Canvas 48 pt, hotspot (10,10) = the index fingertip (grab: the pinch). Generated by gen.mjs. -->
<g transform="translate(0.6 0.6)"><g transform="translate(10 10) rotate(-35)"><path d="M-2 11.19 Q-2.2 9.6 -0.6 9.6 L12.4 9.6 Q14 9.6 13.82 11.19 L13.48 14.21 Q13.3 15.8 12.56 17.22 L11.94 18.38 Q11.2 19.8 9.6 19.8 L5.2 19.8 Q3.6 19.8 2.35 18.8 L-0.15 16.8 Q-1.4 15.8 -1.6 14.21 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M-3.8 13.4 A2.5 3.3 0 1 0 1.2 13.4 A2.5 3.3 0 1 0 -3.8 13.4 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M0.81 12.3 L-3.13 8.29 A1.25 1.25 0 0 0 -4.99 9.97 L-1.41 14.3 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M6.2 11.6 L6.05 7.55 A1.35 1.35 0 0 0 3.35 7.55 L3.2 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M9.9 11.6 L9.75 7.95 A1.35 1.35 0 0 0 7.05 7.95 L6.9 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M13.5 11.6 L13.36 8.56 A1.26 1.26 0 0 0 10.84 8.56 L10.7 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M2.49 10.26 L1.47 1.21 A1.35 1.35 0 0 0 -1.21 1.47 L-0.49 10.54 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/>
<path d="M-2 11.19 Q-2.2 9.6 -0.6 9.6 L12.4 9.6 Q14 9.6 13.82 11.19 L13.48 14.21 Q13.3 15.8 12.56 17.22 L11.94 18.38 Q11.2 19.8 9.6 19.8 L5.2 19.8 Q3.6 19.8 2.35 18.8 L-0.15 16.8 Q-1.4 15.8 -1.6 14.21 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M-3.8 13.4 A2.5 3.3 0 1 0 1.2 13.4 A2.5 3.3 0 1 0 -3.8 13.4 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M0.81 12.3 L-3.13 8.29 A1.25 1.25 0 0 0 -4.99 9.97 L-1.41 14.3 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M6.2 11.6 L6.05 7.55 A1.35 1.35 0 0 0 3.35 7.55 L3.2 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.9 11.6 L9.75 7.95 A1.35 1.35 0 0 0 7.05 7.95 L6.9 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 11.6 L13.36 8.56 A1.26 1.26 0 0 0 10.84 8.56 L10.7 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M2.49 10.26 L1.47 1.21 A1.35 1.35 0 0 0 -1.21 1.47 L-0.49 10.54 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M-2 11.19 Q-2.2 9.6 -0.6 9.6 L12.4 9.6 Q14 9.6 13.82 11.19 L13.48 14.21 Q13.3 15.8 12.56 17.22 L11.94 18.38 Q11.2 19.8 9.6 19.8 L5.2 19.8 Q3.6 19.8 2.35 18.8 L-0.15 16.8 Q-1.4 15.8 -1.6 14.21 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M-3.8 13.4 A2.5 3.3 0 1 0 1.2 13.4 A2.5 3.3 0 1 0 -3.8 13.4 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M0.81 12.3 L-3.13 8.29 A1.25 1.25 0 0 0 -4.99 9.97 L-1.41 14.3 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M6.2 11.6 L6.05 7.55 A1.35 1.35 0 0 0 3.35 7.55 L3.2 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M9.9 11.6 L9.75 7.95 A1.35 1.35 0 0 0 7.05 7.95 L6.9 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M13.5 11.6 L13.36 8.56 A1.26 1.26 0 0 0 10.84 8.56 L10.7 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M2.49 10.26 L1.47 1.21 A1.35 1.35 0 0 0 -1.21 1.47 L-0.49 10.54 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/></g></g>
<g transform="translate(10 10) rotate(-35)"><path d="M-2 11.19 Q-2.2 9.6 -0.6 9.6 L12.4 9.6 Q14 9.6 13.82 11.19 L13.48 14.21 Q13.3 15.8 12.56 17.22 L11.94 18.38 Q11.2 19.8 9.6 19.8 L5.2 19.8 Q3.6 19.8 2.35 18.8 L-0.15 16.8 Q-1.4 15.8 -1.6 14.21 Z" fill="#B9BFC9"/><path d="M-2.02 10.99 Q-2.2 9.6 -0.8 9.6 L10 9.6 Q11.4 9.6 11.24 10.99 L10.86 14.41 Q10.7 15.8 10.15 17.09 L9.55 18.51 Q9 19.8 7.6 19.8 L5 19.8 Q3.6 19.8 2.51 18.93 L-0.31 16.67 Q-1.4 15.8 -1.58 14.41 Z" fill="#EFE9DC"/>
<path d="M-3.8 13.4 A2.5 3.3 0 1 0 1.2 13.4 A2.5 3.3 0 1 0 -3.8 13.4 Z" fill="#B9BFC9"/><path d="M-4 12.8 A2 2.8 0 1 0 0 12.8 A2 2.8 0 1 0 -4 12.8 Z" fill="#EFE9DC"/>
<path d="M0.81 12.3 L-3.13 8.29 A1.25 1.25 0 0 0 -4.99 9.97 L-1.41 14.3 Z" fill="#B9BFC9"/><path d="M0.81 12.29 L-3.32 8.07 A0.78 0.78 0 0 0 -4.45 9.12 L-0.56 13.55 Z" fill="#EFE9DC"/>
<path d="M6.2 11.6 L6.05 7.55 A1.35 1.35 0 0 0 3.35 7.55 L3.2 11.6 Z" fill="#B9BFC9"/><path d="M4.94 11.61 L4.9 7.21 A0.78 0.78 0 0 0 3.34 7.19 L3.2 11.59 Z" fill="#EFE9DC"/>
<path d="M9.9 11.6 L9.75 7.95 A1.35 1.35 0 0 0 7.05 7.95 L6.9 11.6 Z" fill="#B9BFC9"/><path d="M8.64 11.61 L8.6 7.61 A0.78 0.78 0 0 0 7.04 7.59 L6.9 11.59 Z" fill="#EFE9DC"/>
<path d="M13.5 11.6 L13.36 8.56 A1.26 1.26 0 0 0 10.84 8.56 L10.7 11.6 Z" fill="#B9BFC9"/><path d="M12.32 11.61 L12.29 8.24 A0.73 0.73 0 0 0 10.83 8.22 L10.7 11.59 Z" fill="#EFE9DC"/>
<path d="M2.49 10.26 L1.47 1.21 A1.35 1.35 0 0 0 -1.21 1.47 L-0.49 10.54 Z" fill="#B9BFC9"/><path d="M1.18 10.39 L0.25 0.96 A0.76 0.76 0 0 0 -1.26 1.09 L-0.49 10.54 Z" fill="#EFE9DC"/>
<path d="M3.2 9.9 H13.6" stroke="#A3ABB7" stroke-width="0.7" stroke-linecap="round" fill="none"/></g>
</svg>
"""##,
        .grab: ##"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<!-- sleight ghost hand, state "grab". Canvas 48 pt, hotspot (10,10) = the index fingertip (grab: the pinch). Generated by gen.mjs. -->
<g transform="translate(0.6 0.6)"><g transform="translate(10 10) rotate(-35)"><path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M-3.1 14.2 A2.5 3.3 0 1 0 1.9 14.2 A2.5 3.3 0 1 0 -3.1 14.2 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M7.5 11.6 L7.35 8.95 A1.35 1.35 0 0 0 4.65 8.95 L4.5 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M10.9 11.6 L10.75 9.25 A1.35 1.35 0 0 0 8.05 9.25 L7.9 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M13.8 11.6 L13.66 9.86 A1.26 1.26 0 0 0 11.14 9.86 L11 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M1.69 13.61 L-0.06 2.14 A1.2 1.2 0 0 0 -2.44 2.44 L-1.29 13.99 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M3.25 11.54 L2.91 5.89 A1.35 1.35 0 0 0 0.21 6.01 L0.35 11.66 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M2.9 5.84 L1.31 0.8 A1.15 1.15 0 0 0 -0.9 1.41 L0.3 6.56 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/>
<path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M-3.1 14.2 A2.5 3.3 0 1 0 1.9 14.2 A2.5 3.3 0 1 0 -3.1 14.2 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M7.5 11.6 L7.35 8.95 A1.35 1.35 0 0 0 4.65 8.95 L4.5 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M10.9 11.6 L10.75 9.25 A1.35 1.35 0 0 0 8.05 9.25 L7.9 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.8 11.6 L13.66 9.86 A1.26 1.26 0 0 0 11.14 9.86 L11 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M1.69 13.61 L-0.06 2.14 A1.2 1.2 0 0 0 -2.44 2.44 L-1.29 13.99 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M3.25 11.54 L2.91 5.89 A1.35 1.35 0 0 0 0.21 6.01 L0.35 11.66 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M2.9 5.84 L1.31 0.8 A1.15 1.15 0 0 0 -0.9 1.41 L0.3 6.56 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M-3.1 14.2 A2.5 3.3 0 1 0 1.9 14.2 A2.5 3.3 0 1 0 -3.1 14.2 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M7.5 11.6 L7.35 8.95 A1.35 1.35 0 0 0 4.65 8.95 L4.5 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M10.9 11.6 L10.75 9.25 A1.35 1.35 0 0 0 8.05 9.25 L7.9 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M13.8 11.6 L13.66 9.86 A1.26 1.26 0 0 0 11.14 9.86 L11 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M1.69 13.61 L-0.06 2.14 A1.2 1.2 0 0 0 -2.44 2.44 L-1.29 13.99 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M3.25 11.54 L2.91 5.89 A1.35 1.35 0 0 0 0.21 6.01 L0.35 11.66 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M2.9 5.84 L1.31 0.8 A1.15 1.15 0 0 0 -0.9 1.41 L0.3 6.56 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/></g></g>
<g transform="translate(10 10) rotate(-35)"><path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#B9BFC9"/><path d="M-2.02 12.19 Q-2.2 10.8 -0.8 10.8 L10 10.8 Q11.4 10.8 11.24 12.19 L10.86 15.61 Q10.7 17 9.89 18.14 L9.81 18.26 Q9 19.4 7.6 19.4 L5 19.4 Q3.6 19.4 2.34 18.79 L-0.14 17.61 Q-1.4 17 -1.58 15.61 Z" fill="#EFE9DC"/>
<path d="M-3.1 14.2 A2.5 3.3 0 1 0 1.9 14.2 A2.5 3.3 0 1 0 -3.1 14.2 Z" fill="#B9BFC9"/><path d="M-3.3 13.6 A2 2.8 0 1 0 0.7 13.6 A2 2.8 0 1 0 -3.3 13.6 Z" fill="#EFE9DC"/>
<path d="M7.5 11.6 L7.35 8.95 A1.35 1.35 0 0 0 4.65 8.95 L4.5 11.6 Z" fill="#B9BFC9"/><path d="M6.24 11.61 L6.2 8.61 A0.78 0.78 0 0 0 4.63 8.59 L4.5 11.59 Z" fill="#EFE9DC"/>
<path d="M10.9 11.6 L10.75 9.25 A1.35 1.35 0 0 0 8.05 9.25 L7.9 11.6 Z" fill="#B9BFC9"/><path d="M9.64 11.61 L9.6 8.91 A0.78 0.78 0 0 0 8.03 8.89 L7.9 11.59 Z" fill="#EFE9DC"/>
<path d="M13.8 11.6 L13.66 9.86 A1.26 1.26 0 0 0 11.14 9.86 L11 11.6 Z" fill="#B9BFC9"/><path d="M12.62 11.62 L12.58 9.55 A0.73 0.73 0 0 0 11.12 9.52 L11 11.58 Z" fill="#EFE9DC"/>
<path d="M1.69 13.61 L-0.06 2.14 A1.2 1.2 0 0 0 -2.44 2.44 L-1.29 13.99 Z" fill="#B9BFC9"/><path d="M1.69 13.6 L-0.09 1.87 A0.74 0.74 0 0 0 -1.56 2.07 L-0.16 13.85 Z" fill="#EFE9DC"/>
<path d="M3.25 11.54 L2.91 5.89 A1.35 1.35 0 0 0 0.21 6.01 L0.35 11.66 Z" fill="#B9BFC9"/><path d="M2.15 11.59 L1.86 5.64 A0.84 0.84 0 0 0 0.19 5.71 L0.35 11.66 Z" fill="#EFE9DC"/>
<path d="M2.9 5.84 L1.31 0.8 A1.15 1.15 0 0 0 -0.9 1.41 L0.3 6.56 Z" fill="#B9BFC9"/><path d="M1.92 6.12 L0.4 0.8 A0.71 0.71 0 0 0 -0.98 1.16 L0.3 6.55 Z" fill="#EFE9DC"/>
<path d="M4.4 11.1 H13.9" stroke="#A3ABB7" stroke-width="0.7" stroke-linecap="round" fill="none"/></g>
</svg>
"""##,
        .scroll: ##"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<!-- sleight ghost hand, state "scroll". Canvas 48 pt, hotspot (10,10) = the index fingertip (grab: the pinch). Generated by gen.mjs. -->
<g transform="translate(0.6 0.6)"><g transform="translate(10 10) rotate(-35)"><path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M0.8 13.48 L-2.13 10.67 A1.25 1.25 0 0 0 -3.97 12.37 L-1.4 15.52 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M9.9 11.6 L9.75 9.15 A1.35 1.35 0 0 0 7.05 9.15 L6.9 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M13.5 11.6 L13.36 9.76 A1.26 1.26 0 0 0 10.84 9.76 L10.7 11.6 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/><path d="M6.15 11.53 L5.36 0.14 A1.2 1.2 0 0 0 2.96 0.26 L3.25 11.67 Z" fill="#141A26" fill-opacity="0.08" stroke="#141A26" stroke-opacity="0.08" stroke-width="3" stroke-linejoin="round"/>
<path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M0.8 13.48 L-2.13 10.67 A1.25 1.25 0 0 0 -3.97 12.37 L-1.4 15.52 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.9 11.6 L9.75 9.15 A1.35 1.35 0 0 0 7.05 9.15 L6.9 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 11.6 L13.36 9.76 A1.26 1.26 0 0 0 10.84 9.76 L10.7 11.6 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/><path d="M6.15 11.53 L5.36 0.14 A1.2 1.2 0 0 0 2.96 0.26 L3.25 11.67 Z" fill="#141A26" fill-opacity="0.12" stroke="#141A26" stroke-opacity="0.12" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M0.8 13.48 L-2.13 10.67 A1.25 1.25 0 0 0 -3.97 12.37 L-1.4 15.52 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M9.9 11.6 L9.75 9.15 A1.35 1.35 0 0 0 7.05 9.15 L6.9 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M13.5 11.6 L13.36 9.76 A1.26 1.26 0 0 0 10.84 9.76 L10.7 11.6 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/><path d="M6.15 11.53 L5.36 0.14 A1.2 1.2 0 0 0 2.96 0.26 L3.25 11.67 Z" fill="#141A26" fill-opacity="0.2" stroke="#141A26" stroke-opacity="0.2" stroke-width="0.8" stroke-linejoin="round"/></g></g>
<g transform="translate(10 10) rotate(-35)"><path d="M-2 12.39 Q-2.2 10.8 -0.6 10.8 L12.4 10.8 Q14 10.8 13.82 12.39 L13.48 15.41 Q13.3 17 12.56 18.42 L11.94 19.58 Q11.2 21 9.6 21 L5.2 21 Q3.6 21 2.35 20 L-0.15 18 Q-1.4 17 -1.6 15.41 Z" fill="#B9BFC9"/><path d="M-2.02 12.19 Q-2.2 10.8 -0.8 10.8 L10 10.8 Q11.4 10.8 11.24 12.19 L10.86 15.61 Q10.7 17 9.89 18.14 L9.81 18.26 Q9 19.4 7.6 19.4 L5 19.4 Q3.6 19.4 2.34 18.79 L-0.14 17.61 Q-1.4 17 -1.58 15.61 Z" fill="#EFE9DC"/>
<path d="M-3.8 14.6 A2.5 3.3 0 1 0 1.2 14.6 A2.5 3.3 0 1 0 -3.8 14.6 Z" fill="#B9BFC9"/><path d="M-4 14 A2 2.8 0 1 0 0 14 A2 2.8 0 1 0 -4 14 Z" fill="#EFE9DC"/>
<path d="M0.8 13.48 L-2.13 10.67 A1.25 1.25 0 0 0 -3.97 12.37 L-1.4 15.52 Z" fill="#B9BFC9"/><path d="M0.79 13.47 L-2.32 10.45 A0.78 0.78 0 0 0 -3.44 11.52 L-0.55 14.76 Z" fill="#EFE9DC"/>
<path d="M9.9 11.6 L9.75 9.15 A1.35 1.35 0 0 0 7.05 9.15 L6.9 11.6 Z" fill="#B9BFC9"/><path d="M8.64 11.61 L8.6 8.81 A0.78 0.78 0 0 0 7.03 8.79 L6.9 11.59 Z" fill="#EFE9DC"/>
<path d="M13.5 11.6 L13.36 9.76 A1.26 1.26 0 0 0 10.84 9.76 L10.7 11.6 Z" fill="#B9BFC9"/><path d="M12.32 11.62 L12.28 9.45 A0.73 0.73 0 0 0 10.82 9.42 L10.7 11.58 Z" fill="#EFE9DC"/>
<path d="M2.44 11.48 L1.3 1.09 A1.2 1.2 0 0 0 -1.09 1.3 L-0.44 11.72 Z" fill="#B9BFC9"/><path d="M1.35 11.58 L0.36 0.91 A0.74 0.74 0 0 0 -1.12 1.03 L-0.45 11.72 Z" fill="#EFE9DC"/>
<path d="M6.15 11.53 L5.36 0.14 A1.2 1.2 0 0 0 2.96 0.26 L3.25 11.67 Z" fill="#B9BFC9"/><path d="M5.05 11.59 L4.43 -0.07 A0.74 0.74 0 0 0 2.94 -0.01 L3.25 11.66 Z" fill="#EFE9DC"/>
<path d="M3.2 11.1 H13.6" stroke="#A3ABB7" stroke-width="0.7" stroke-linecap="round" fill="none"/></g>
</svg>
"""##,
        .dabs: ##"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<!-- sleight ghost hand, state "dabs". Canvas 48 pt, hotspot (10,10) = the index fingertip (grab: the pinch). Generated by gen.mjs. -->
<g transform="translate(10 10) rotate(-35)"><rect x="-1.95" y="-1.95" width="3.9" height="3.9" rx="0.86" fill="#4E79D9" fill-opacity="0.2" transform="translate(4.2 23) rotate(8)"/><rect x="-1.6" y="-1.6" width="3.2" height="3.2" rx="0.51" fill="#4E79D9" fill-opacity="0.92" transform="translate(4.2 23) rotate(8)"/>
<rect x="-1.83" y="-1.83" width="3.66" height="3.66" rx="0.81" fill="#7299EA" fill-opacity="0.2" transform="translate(8.8 23.5) rotate(-6)"/><rect x="-1.5" y="-1.5" width="3" height="3" rx="0.48" fill="#7299EA" fill-opacity="0.92" transform="translate(8.8 23.5) rotate(-6)"/>
<rect x="-1.71" y="-1.71" width="3.42" height="3.42" rx="0.75" fill="#7299EA" fill-opacity="0.2" transform="translate(6.5 26.5) rotate(4)"/><rect x="-1.4" y="-1.4" width="2.8" height="2.8" rx="0.45" fill="#7299EA" fill-opacity="0.92" transform="translate(6.5 26.5) rotate(4)"/>
<rect x="-1.59" y="-1.59" width="3.17" height="3.17" rx="0.7" fill="#A9C4F5" fill-opacity="0.2" transform="translate(11.5 26.2) rotate(-11)"/><rect x="-1.3" y="-1.3" width="2.6" height="2.6" rx="0.42" fill="#A9C4F5" fill-opacity="0.92" transform="translate(11.5 26.2) rotate(-11)"/>
<rect x="-1.34" y="-1.34" width="2.68" height="2.68" rx="0.59" fill="#A9C4F5" fill-opacity="0.2" transform="translate(2.6 27.5) rotate(-4)"/><rect x="-1.1" y="-1.1" width="2.2" height="2.2" rx="0.35" fill="#A9C4F5" fill-opacity="0.92" transform="translate(2.6 27.5) rotate(-4)"/>
<rect x="-1.34" y="-1.34" width="2.68" height="2.68" rx="0.59" fill="#7299EA" fill-opacity="0.2" transform="translate(9.2 29.6) rotate(7)"/><rect x="-1.1" y="-1.1" width="2.2" height="2.2" rx="0.35" fill="#7299EA" fill-opacity="0.92" transform="translate(9.2 29.6) rotate(7)"/>
<rect x="-1.1" y="-1.1" width="2.2" height="2.2" rx="0.48" fill="#A9C4F5" fill-opacity="0.2" transform="translate(13.9 29.2) rotate(3)"/><rect x="-0.9" y="-0.9" width="1.8" height="1.8" rx="0.29" fill="#A9C4F5" fill-opacity="0.92" transform="translate(13.9 29.2) rotate(3)"/>
<rect x="-0.98" y="-0.98" width="1.95" height="1.95" rx="0.43" fill="#A9C4F5" fill-opacity="0.2" transform="translate(5.6 30.6) rotate(-8)"/><rect x="-0.8" y="-0.8" width="1.6" height="1.6" rx="0.26" fill="#A9C4F5" fill-opacity="0.92" transform="translate(5.6 30.6) rotate(-8)"/></g>
</svg>
"""##,
    ]
    static func image(_ state: HandState, scale: CGFloat) -> CGImage? {
        let pixels = Int(canvas * scale), size = CGSize(width: canvas, height: canvas)
        guard let data = svg[state]?.data(using: .utf8), let picture = NSImage(data: data),
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = size
        NSGraphicsContext.saveGraphicsState(); defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        picture.draw(in: NSRect(origin: .zero, size: size))
        return rep.cgImage
    }
}
typealias HandCurve = (Double, Double, Double, Double)
// Seconds, points and cubic Bezier curves, from the spec's timing table.
enum HandTiming {
    static let entry = 0.16, glideBase = 0.22, glidePerPoint = 0.00025, glideMax = 0.42, flourish = 0.15, scroll = 0.2, grab = 0.09
    static let lift = 0.22, silence = 1.5, fade = 0.3, crossfade = 0.07, trail = 0.05
    static let entryOffset: CGFloat = 18, hold: CGFloat = 3, liftOffset: CGFloat = 10, fadeOffset: CGFloat = 14, scrollDrop: CGFloat = 5
    static let typeStep: CGFloat = 1.5, pecks = 6, pressScale = 0.93, grabScale = 0.95, tilt = -0.22
    static let out: HandCurve = (0.2, 0.8, 0.2, 1), glideCurve: HandCurve = (0.35, 0, 0.15, 1), fadeCurve: HandCurve = (0.4, 0, 1, 1)
    static let inOut: HandCurve = (0.42, 0, 0.58, 1)
    static func glide(_ distance: CGFloat) -> Double { min(glideMax, glideBase + glidePerPoint * Double(distance)) }
}
// END HAND ART

// BEGIN HAND MOTION
// The y of a cubic Bezier easing curve at x, solved by bisection.
func handEase(_ curve: HandCurve, _ x: Double) -> Double {
    func bezier(_ a: Double, _ b: Double, _ s: Double) -> Double { 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s }
    var low = 0.0, high = 1.0
    for _ in 0..<30 { let mid = (low + high) / 2; if bezier(curve.0, curve.2, mid) < x { low = mid } else { high = mid } }
    return bezier(curve.1, curve.3, (low + high) / 2)
}
func handLength(_ points: [CGPoint]) -> CGFloat { zip(points, points.dropFirst()).map { hypot($1.x - $0.x, $1.y - $0.y) }.reduce(0, +) }
func handMix(_ a: CGPoint, _ b: CGPoint, _ f: Double) -> CGPoint { CGPoint(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f) }
// The point a fraction of the way along a route, by length.
func handAlong(_ points: [CGPoint], _ fraction: Double) -> CGPoint {
    var left = handLength(points) * fraction
    for (a, b) in zip(points, points.dropFirst()) {
        let step = hypot(b.x - a.x, b.y - a.y)
        if left <= step, step > 0 { return handMix(a, b, Double(left / step)) }
        left -= step
    }
    return points.last ?? .zero
}
func handBack(_ point: CGPoint, _ distance: CGFloat) -> CGPoint { CGPoint(x: point.x + HandArt.axis.dx * distance, y: point.y + HandArt.axis.dy * distance) }
// One property's keyframes from t = 0. Eased moves are sampled into 20 ms linear steps, so one animation carries every beat.
struct HandTrack<Value> {
    var times: [Double] = [0], values: [Value]
    let mix: (Value, Value, Double) -> Value
    init(_ start: Value, mix: @escaping (Value, Value, Double) -> Value) { values = [start]; self.mix = mix }
    var end: Double { times.last ?? 0 }
    var last: Value { values[values.count - 1] }
    var moved: Bool { times.count > 1 }
    mutating func wait(until time: Double) { if time > end { times.append(time); values.append(last) } }
    mutating func move(at start: Double, over duration: Double, curve: HandCurve, _ value: (Double) -> Value) {
        wait(until: start)
        let steps = max(1, Int((duration / 0.02).rounded(.up)))
        for step in 1...steps {
            let x = Double(step) / Double(steps)
            times.append(start + duration * x); values.append(value(handEase(curve, x)))
        }
    }
    mutating func move(to value: Value, at start: Double, over duration: Double, curve: HandCurve) {
        wait(until: start)
        let from = last, mix = self.mix
        move(at: start, over: duration, curve: curve) { mix(from, value, $0) }
    }
    // A content swap: the old value until start, the new one crossfaded in by the end of the 70 ms.
    mutating func swap(to value: Value, at start: Double) { wait(until: start); times.append(start + HandTiming.crossfade); values.append(value) }
    func animation(_ keyPath: String, begin: Double, _ box: (Value) -> Any) -> CAKeyframeAnimation? {
        guard moved, end > 0 else { return nil }
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values.map(box); animation.keyTimes = times.map { NSNumber(value: $0 / end) }
        animation.duration = end; animation.beginTime = begin; animation.calculationMode = .linear; animation.fillMode = .backwards
        return animation
    }
}
let handMixDouble: (Double, Double, Double) -> Double = { $0 + ($1 - $0) * $2 }
// Everything one frame does, as tracks from its start: positions in global top-left points, offsets in layer points.
struct HandPlan {
    var position: HandTrack<CGPoint>, opacity: HandTrack<Double>, contents: HandTrack<HandState>
    var scale = HandTrack<Double>(1, mix: handMixDouble), rotation = HandTrack<Double>(0, mix: handMixDouble)
    var offset = HandTrack<CGPoint>(.zero, mix: handMix)
    var rest = CGPoint.zero, fadeTo = CGPoint.zero, points: [CGPoint] = [], total = 0.0
}
// start is where the hand is on screen when it is already showing over the same window, with its opacity and content.
func handPlan(_ act: HandAct, from start: (point: CGPoint, opacity: Double, state: HandState)?, secure: Bool) -> HandPlan {
    let t = HandTiming.self, kind = act.kind
    let (lead, acting) = HandArt.states[kind] ?? (.point, .press)
    let pecking = kind == "key" || kind == "type"
    let target = handBack(act.at, pecking ? t.hold : 0)
    let route = handPoints((start.map { [$0.point] } ?? []) + (kind == "drag" ? [act.at] : act.path + [target]))
    let carry = kind == "drag" ? handPoints([act.at] + act.path) : []
    let entryFrom = handBack(route[0], t.entryOffset)
    var plan = HandPlan(position: HandTrack(start?.point ?? entryFrom, mix: handMix), opacity: HandTrack(start?.opacity ?? 0, mix: handMixDouble),
        contents: HandTrack(start?.state ?? lead, mix: { $2 < 1 ? $0 : $1 }))
    var time = 0.0
    plan.opacity.move(to: HandArt.opacity, at: 0, over: t.entry, curve: t.out)
    if start == nil { plan.position.move(to: route[0], at: 0, over: t.entry, curve: t.out); time = t.entry }
    else if start?.state != lead { plan.contents.swap(to: lead, at: 0) }
    if route.count > 1 {
        let glide = t.glide(handLength(route))
        plan.position.move(at: time, over: glide, curve: t.glideCurve) { handAlong(route, $0) }
        time += glide
    }
    // The layer's y runs up, so a move down the screen is negative.
    let peck = CGPoint(x: -HandArt.axis.dx * t.hold, y: HandArt.axis.dy * t.hold)
    switch kind {
    case "click", "double", "right":
        plan.contents.swap(to: acting, at: time)
        for _ in 0..<act.beats {
            for _ in 0..<(kind == "double" ? 2 : 1) {
                if kind == "right" { plan.rotation.move(to: t.tilt, at: time, over: t.flourish * 0.4, curve: t.inOut); plan.rotation.move(to: 0, at: time + t.flourish * 0.4, over: t.flourish * 0.6, curve: t.inOut) }
                else { plan.scale.move(to: t.pressScale, at: time, over: t.flourish * 0.4, curve: t.inOut); plan.scale.move(to: 1, at: time + t.flourish * 0.4, over: t.flourish * 0.6, curve: t.inOut) }
                time += t.flourish
            }
        }
    case "key" where !secure, "type" where !secure:
        // Held 3 pt back, each beat pecks to the point and back; typing steps 1.5 pt right per beat. Secure input skips the pecks.
        for beat in 0..<min(act.beats, t.pecks) {
            if kind == "type" && beat > 0 {
                let next = CGPoint(x: target.x + t.typeStep * CGFloat(beat), y: target.y)
                plan.position.move(to: next, at: time, over: 0.03, curve: t.inOut)
            }
            plan.offset.move(to: peck, at: time, over: t.flourish * 0.35, curve: t.inOut)
            plan.offset.move(to: .zero, at: time + t.flourish * 0.55, over: t.flourish * 0.45, curve: t.inOut)
            time += t.flourish
        }
    case "scroll":
        for _ in 0..<act.beats {
            plan.offset.move(to: CGPoint(x: 0, y: -t.scrollDrop), at: time, over: t.scroll / 2, curve: t.inOut)
            plan.offset.move(to: .zero, at: time + t.scroll / 2, over: t.scroll / 2, curve: t.inOut)
            time += t.scroll
        }
    case "drag":
        plan.contents.swap(to: .grab, at: time)
        plan.scale.move(to: t.grabScale, at: time, over: t.grab, curve: t.inOut); time += t.grab
        if carry.count > 1 {
            let glide = t.glide(handLength(carry))
            plan.position.move(at: time, over: glide, curve: t.glideCurve) { handAlong(carry, $0) }
            time += glide
        }
        plan.contents.swap(to: .rest, at: time)
        plan.scale.move(to: 1, at: time, over: t.grab, curve: t.inOut); time += t.grab
    default: break
    }
    // The lift: the hand opens and steps 10 pt back at 60%, uncovering the target.
    let acted = plan.position.last
    plan.rest = handBack(acted, t.liftOffset); plan.fadeTo = handBack(acted, t.fadeOffset)
    if plan.contents.last != .rest { plan.contents.swap(to: .rest, at: time) }
    plan.position.move(to: plan.rest, at: time, over: t.lift, curve: t.out)
    plan.opacity.move(to: HandArt.lifted, at: time, over: t.lift, curve: t.out)
    plan.total = time + t.lift
    plan.points = (start == nil ? [entryFrom] : []) + route + carry + [acted, plan.rest, plan.fadeTo]
    return plan
}
// END HAND MOTION

// BEGIN RING PLAN
// The agent cursor's ring. A theme (palette, timings and which moves it has) feeds one state machine of per-state planners.
// Each move is a value tween. The plan samples the tweens once when a frame arrives and hands Core Animation one keyframe
// track per layer property, so no Swift code runs per frame. Split Seam+ (D2) is the default theme, plain Split Seam the other.
struct RingTheme {
    var name: String
    var warm: [Double] = [1, 122.0/255, 61.0/255, 1], cool: [Double] = [91.0/255, 141.0/255, 1, 1]
    var ink: [Double] = [11.0/255, 13.0/255, 20.0/255, 0.55], white: [Double] = [1, 1, 1, 1], error: [Double] = [1, 61.0/255, 96.0/255, 1]
    var silence = 1.2, fade = 0.22, gap = 6.0, size = 28.0, carry = 0.42, waitingCap = 120.0
    var wrap = true          // type, scroll and drag wrap the target's rect (aim always does)
    var momentum = true      // wind-up, stretch, lean, overshoot and the squash settle
    var reach = true         // the reach line and the spark's glance in a glide's first 70 ms
    var pixels = true        // thinking and waiting pixels
    var caret = true         // the bottom seam rides the caret
    var burst = true         // the success burst on a confirmed done
    var seeded = true        // seeded click variation and entrance
    static let seamPlus = RingTheme(name: "ring")
    static let seam = RingTheme(name: "seam", fade: 0.3, gap: 8, wrap: false, momentum: false, reach: false, pixels: false, caret: false,
        burst: false, seeded: false)
}
enum Seam {
    static let linear: (Double) -> Double = { $0 }
    static let out: (Double) -> Double = { 1 - pow(1 - $0, 3) }
    static let cubicIn: (Double) -> Double = { $0 * $0 * $0 }
    static let inOut: (Double) -> Double = { $0 < 0.5 ? 4 * $0 * $0 * $0 : 1 - pow(-2 * $0 + 2, 3) / 2 }
    static let back: (Double) -> Double = { let c = 1.70158; return 1 + (c + 1) * pow($0 - 1, 3) + c * pow($0 - 1, 2) }
    static let quadIn: (Double) -> Double = { $0 * $0 }
    static let quadOut: (Double) -> Double = { 1 - (1 - $0) * (1 - $0) }
    static let step = 0.025
}
// Deterministic per session seed, frame seq and use: never random per frame.
func seamRandom(_ seed: UInt64, _ seq: Int, _ salt: Int) -> Double {
    var z: UInt64 = seed &+ UInt64(truncatingIfNeeded: seq) &* 0x9E3779B97F4A7C15
    z ^= UInt64(truncatingIfNeeded: salt) &* 0xD1B54A32D192ED03
    z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
    z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
    z ^= z >> 31
    return Double(z >> 11) / 9007199254740992.0
}
// A rounded rect centred on 0,0. One lap is 9 segments from the top-left corner's midpoint, clockwise: half corner, top,
// corner, right, corner, bottom, corner, left, half corner. A circle has the same segments with empty sides, so a wrap
// interpolates cleanly. [0, P/2] of a lap is the cool upper-right half.
struct SeamGeo {
    let r: Double, w: Double, h: Double, ew: Double, eh: Double, a: Double, P: Double
    init(_ w0: Double, _ h0: Double, _ rr: Double) {
        let w1 = max(0.5, w0), h1 = max(0.5, h0), r1 = max(0.01, min(rr, w1 / 2, h1 / 2))
        w = w1; h = h1; r = r1; ew = w1 - 2 * r1; eh = h1 - 2 * r1; a = Double.pi * r1 / 2
        P = 2 * ew + 2 * eh + 4 * a
    }
    var x: Double { -w / 2 }
    var y: Double { -h / 2 }
    // A cubic for the arc from a0 to a1 degrees: command 4 is control 1, control 2, end.
    func arc(_ cx: Double, _ cy: Double, _ a0: Double, _ a1: Double, _ ox: Double, _ oy: Double) -> [Double] {
        let t0 = a0 * Double.pi / 180, t1 = a1 * Double.pi / 180, k = 4.0 / 3.0 * tan((t1 - t0) / 4)
        let x0 = cx + r * cos(t0), y0 = cy + r * sin(t0), x3 = cx + r * cos(t1), y3 = cy + r * sin(t1)
        return [4, x0 - k * r * sin(t0) + ox, y0 + k * r * cos(t0) + oy, x3 + k * r * sin(t1) + ox, y3 - k * r * cos(t1) + oy, x3 + ox, y3 + oy]
    }
    func path(_ ox: Double, _ oy: Double, laps: Int, close: Bool = false) -> [[Double]] {
        let s = Double.pi * 225 / 180
        var result: [[Double]] = [[0, x + r + r * cos(s) + ox, y + r + r * sin(s) + oy]]
        let lap: [[Double]] = [arc(x + r, y + r, 225, 270, ox, oy), [1, x + w - r + ox, y + oy], arc(x + w - r, y + r, 270, 360, ox, oy),
            [1, x + w + ox, y + h - r + oy], arc(x + w - r, y + h - r, 0, 90, ox, oy), [1, x + r + ox, y + h + oy],
            arc(x + r, y + h - r, 90, 180, ox, oy), [1, x + ox, y + r + oy], arc(x + r, y + r, 180, 225, ox, oy)]
        for _ in 0..<laps { result += lap }
        if close { result.append([3]) }
        return result
    }
    // The point and outward normal at distance s along a lap.
    func point(_ s0: Double) -> (x: Double, y: Double, nx: Double, ny: Double) {
        var s = s0.truncatingRemainder(dividingBy: P)
        if s < 0 { s += P }
        // Segment i alternates corner (even) and side (odd); no allocation, since planning samples this per pixel.
        let x = self.x, y = self.y
        for i in 0..<9 {
            let length = i == 0 || i == 8 ? a / 2 : (i % 2 == 0 ? a : (i == 1 || i == 5 ? ew : eh))
            if s <= length || i == 8 {
                let f = length > 0 ? min(1, max(0, s / length)) : 0
                if i % 2 == 0 {
                    let cx = i == 2 || i == 4 ? x + w - r : x + r, cy = i == 4 || i == 6 ? y + h - r : y + r
                    let from = i == 0 ? 225.0 : Double(i / 2) * 90 + 180, span = i == 0 || i == 8 ? 45.0 : 90
                    let angle = (from.truncatingRemainder(dividingBy: 360) + span * f) * Double.pi / 180
                    return (cx + r * cos(angle), cy + r * sin(angle), cos(angle), sin(angle))
                }
                switch i {
                case 1: return (x + r + ew * f, y, 0, -1)
                case 3: return (x + w, y + r + eh * f, 1, 0)
                case 5: return (x + w - r - ew * f, y + h, 0, 1)
                default: return (x, y + h - r - eh * f, -1, 0)
                }
            }
            s -= length
        }
        return (0, 0, 0, 0)
    }
    // The rotation, in laps, that puts the bottom seam under local x.
    func rotation(under x0: Double) -> Double {
        let X = min(max(x0, x + r), x + w - r), bottom = a / 2 + ew + a + eh + a
        return (bottom + (x + w - r) - X - P / 2) / P
    }
}
enum RingValue: Equatable {
    case number(Double), vector([Double]), path([[Double]])
    var json: Any {
        switch self { case let .number(n): return n; case let .vector(v): return v; case let .path(p): return p }
    }
    var number: Double { if case let .number(n) = self { return n }; return 0 }
}
// A typed layer: the adapter builds exactly this. Global layers use screen points, the rest the cursor's.
struct RingLayer {
    enum Kind: String { case shape, group, gradient, text }
    var name: String, kind: Kind = .shape, parent = "cursor", global = false, under = false
    var stroke: [Double]? = nil, fill: [Double]? = nil, width = 0.0, dash: [Double] = [], keyline = false
    var colors: [[Double]] = [], text: String? = nil, frame: CGRect? = nil
    var props: [String: RingValue] = [:]
    var json: [String: Any] {
        var result: [String: Any] = ["name": name, "kind": kind.rawValue, "parent": parent, "global": global, "width": width,
            "keyline": keyline, "props": props.mapValues { $0.json }]
        if let stroke = stroke { result["color"] = stroke }
        if let fill = fill { result["fill"] = fill }
        if !dash.isEmpty { result["dash"] = dash }
        if let text = text { result["text"] = text }
        return result
    }
}
// One CAKeyframeAnimation: values at keyTimes (0 to 1) over [begin, begin + duration] seconds after the frame. Built from
// sorted sample times, so keyTimes never decrease.
struct RingTrack {
    let layer: String, keyPath: String, begin: Double, duration: Double, values: [RingValue], times: [Double]
    var json: [String: Any] {
        ["layer": layer, "keyPath": keyPath, "beginTime": begin, "duration": duration, "from": values.first?.json ?? 0,
         "to": values.last?.json ?? 0, "values": values.map { $0.json }, "times": times]
    }
}
struct RingChip {
    let frame: CGRect, tether: [[Double]]
    var json: [String: Any] { ["frame": [frame.minX, frame.minY, frame.width, frame.height], "tether": tether] }
}
// park removes the finished animations, fade dims the root, release drops the panel. Times are seconds after the frame.
struct RingTimer { let at: Double, action: String }
struct RingPlan {
    var state: String, at: CGPoint
    var sprite: SpritePlan? = nil
    var layers: [RingLayer] = [], tracks: [RingTrack] = []
    var total = 0.0, glide = 0.0, glideEnd = 0.0, fade = 0.22
    var dropped = false
    var label: String?, rect: CGRect?, oldLabel: String?, chip: RingChip?
    var points: [CGPoint] = [], positions: [(Double, CGPoint)] = [], shape: [String: Double] = [:]
    var phases: [String: [Double]] = [:], timers: [RingTimer] = [], budget: [String: Double] = [:]
    var entrance: String?, variation: Double?
    var pid: Int32 = 0, window: UInt32 = 0, ok = false   // the drawn frame's window and done result, for perch mode
    func position(at time: Double) -> CGPoint {
        guard let first = positions.first else { return at }
        if time <= first.0 { return first.1 }
        for (a, b) in zip(positions, positions.dropFirst()) where time <= b.0 {
            let f = b.0 > a.0 ? (time - a.0) / (b.0 - a.0) : 1
            return CGPoint(x: a.1.x + (b.1.x - a.1.x) * f, y: a.1.y + (b.1.y - a.1.y) * f)
        }
        return positions.last?.1 ?? at
    }
    var json: [String: Any] {
        ["state": state, "at": [at.x, at.y], "layers": layers.map { $0.json }, "animations": tracks.map { $0.json }, "total": total,
         "glide": glide, "glideEnd": glideEnd, "dropped": dropped, "label": label as Any? ?? NSNull(),
         "rect": rect.map { [$0.minX, $0.minY, $0.width, $0.height] } as Any? ?? NSNull(), "chip": chip?.json as Any? ?? NSNull(),
         "phases": phases, "timers": timers.map { [$0.at, $0.action] as [Any] }, "budget": budget, "shape": shape,
         "entrance": entrance as Any? ?? NSNull(), "variation": variation as Any? ?? NSNull(), "sprite": sprite.map { $0.json(self) } as Any? ?? NSNull()]
    }
}
func ringChip(_ text: String, at: CGPoint, clip: CGRect) -> RingChip {
    let width = min(Double(clip.width), min(240, Double(text.count) * 8 + 12)), height = min(16, Double(clip.height))
    let right = Double(at.x) + 18 + width <= Double(clip.maxX), above = Double(at.y) - 25 - height >= Double(clip.minY)
    let x = min(max(Double(clip.minX), right ? Double(at.x) + 18 : Double(at.x) - 18 - width), Double(clip.maxX) - width)
    let y = min(max(Double(clip.minY), above ? Double(at.y) - 25 - height : Double(at.y) + 25), Double(clip.maxY) - height)
    return RingChip(frame: CGRect(x: x, y: y, width: width, height: height),
        tether: [[0, Double(at.x) + (right ? 11 : -11), Double(at.y) - 11], [1, right ? x : x + width, above ? y + height : y]])
}
struct RingContext {
    var from: CGPoint?, destination: CGPoint? = nil, previous: RingPlan?, elapsed = Double.infinity
    var reduced = false, secure = false, clip = CGRect(x: 0, y: 0, width: 1000, height: 1000), seed: UInt64 = 1
}
// The planner's state values. A typo is a compile error, and a state is a plain array indexed by the key.
enum RingKey: Int, CaseIterable {
    case o, w, h, rr, qz, ox, oy, gap, fray, rot, sep, sq, sqa, tw, tc, fillO, sp, ss, sr, sx, sy, hol, err, sh, ml, ho, xo,
         px, pstep, pdim, pdis, porb, tph, pm, burst, bo, bx, by, bs
    var name: String { String(describing: self) }
    static let names = allCases.map { $0.name }
}
// The value tweens of one plan. A later tween of a value overrides an earlier one from its start, as in D2's engine.
final class SeamTimeline {
    struct Tween { let start: Double, duration: Double, from: Double, to: Double, ease: (Double) -> Double }
    struct Move { let start: Double, duration: Double, a: CGPoint, c: CGPoint, b: CGPoint, ux: Double, uy: Double, windup: Bool, curved: Bool,
        ease: (Double) -> Double }
    let initial: [Double], origin: CGPoint
    var tweens: [[Tween]] = Array(repeating: [], count: RingKey.allCases.count), moves: [Move] = [], marks: [Double] = [0]
    init(_ initial: [Double], origin: CGPoint) { self.initial = initial; self.origin = origin }
    func value(_ key: RingKey, _ t: Double) -> Double { value(key.rawValue, t) }
    func value(_ key: Int, _ t: Double) -> Double {
        let list = tweens[key]
        var i = list.count - 1
        while i >= 0, list[i].start > t + 1e-9 { i -= 1 }
        guard i >= 0 else { return initial[key] }
        let tween = list[i]
        if tween.duration <= 0 || t >= tween.start + tween.duration { return tween.to }
        return tween.from + (tween.to - tween.from) * tween.ease((t - tween.start) / tween.duration)
    }
    // Every value at one time. Index loops, because the host is built without optimization and ranges cost there.
    func state(_ t: Double) -> [Double] {
        var result = initial, key = 0
        let count = result.count
        while key < count {
            let list = tweens[key]
            var i = list.count - 1
            while i >= 0, list[i].start > t + 1e-9 { i -= 1 }
            if i >= 0 {
                let tween = list[i]
                result[key] = tween.duration <= 0 || t >= tween.start + tween.duration ? tween.to
                    : tween.from + (tween.to - tween.from) * tween.ease((t - tween.start) / tween.duration)
            }
            key += 1
        }
        return result
    }
    @discardableResult func to(_ targets: [RingKey: Double], _ start: Double, _ duration: Double, _ ease: @escaping (Double) -> Double = Seam.out) -> Double {
        for (key, target) in targets {
            let tween = Tween(start: start, duration: duration, from: value(key, start), to: target, ease: ease)
            var i = tweens[key.rawValue].count
            while i > 0, tweens[key.rawValue][i - 1].start > start { i -= 1 }
            tweens[key.rawValue].insert(tween, at: i)
        }
        marks += [start, start + duration]
        return start + duration
    }
    func set(_ targets: [RingKey: Double], _ at: Double) { to(targets, at, 0, Seam.linear) }
    func move(_ m: Move) { moves.append(m); marks += [m.start, m.start + m.duration] }
    func current(_ t: Double) -> Move? {
        var i = moves.count - 1
        while i >= 0, moves[i].start > t + 1e-9 { i -= 1 }
        return i >= 0 ? moves[i] : nil
    }
    func position(_ t: Double) -> CGPoint {
        guard let m = current(t) else { return origin }
        if m.duration <= 0 || t >= m.start + m.duration { return m.b }
        let q = m.ease((t - m.start) / m.duration), u = 1 - q
        var x = u * u * Double(m.a.x) + 2 * u * q * Double(m.c.x) + q * q * Double(m.b.x)
        var y = u * u * Double(m.a.y) + 2 * u * q * Double(m.c.y) + q * q * Double(m.b.y)
        if m.windup, q < 0.18 { let k = sin(Double.pi * q / 0.18) * 2.2; x -= m.ux * k; y -= m.uy * k }
        return CGPoint(x: x, y: y)
    }
    // Points per millisecond inside a curved move, from the move's own bezier and easing.
    func velocity(_ t: Double) -> (Double, Double)? {
        guard let m = current(t), m.curved, m.duration > 0, t < m.start + m.duration else { return nil }
        let t0 = max(m.start, t - 0.004), t1 = min(m.start + m.duration - 1e-6, t + 0.004)
        guard t1 > t0 else { return nil }
        let a = position(t0), b = position(t1), dt = (t1 - t0) * 1000
        return (Double(b.x - a.x) / dt, Double(b.y - a.y) / dt)
    }
}
// Orbit pixel paths by shape and phase. Plans run on one thread (the host's main thread, or the dump's).
var ringOrbitCache: [[Double]: [RingValue]] = [:]
// Per-state planners shared by every theme. Statuses and aim glide from the last point like acts.
final class RingPlanner {
    static let base: [RingKey: Double] = [.o: 1, .w: 28, .h: 28, .rr: 14, .qz: 0, .ox: 0, .oy: 0, .gap: 6, .fray: 0, .rot: 0,
        .sep: 0, .sq: 0, .sqa: 0, .tw: 0, .tc: 0, .fillO: 0, .sp: 0, .ss: 1, .sr: 0, .sx: 0, .sy: 0, .hol: 0, .err: 0,
        .sh: 0, .ml: 0, .ho: 1, .xo: 0, .px: 0, .pstep: 0, .pdim: 0, .pdis: 0, .porb: 0, .tph: 0, .pm: 0, .burst: 0,
        .bo: 0, .bx: 0, .by: 0, .bs: 0]
    static let orbitHome: [Double] = [0, 0.035, 0.07, 0.5, 0.535, 0.57], orbitSpeed: [Double] = [1, 2, -1, 1, -2, 1]
    static let pixels = ["px0", "px1", "px2", "px3"]
    struct Segment { let start: Double, duration: Double, a: CGPoint, c: CGPoint, b: CGPoint, ease: (Double) -> Double }
    let event: RingEvent, theme: RingTheme, c: RingContext, tl: SeamTimeline, route: [CGPoint]
    var t = 0.0, at: CGPoint, phases: [String: [Double]] = [:]
    var ribbon: [Segment] = [], reach: Segment?
    var tintPath: [[Double]]?, markPath: [[Double]]?, cross = false
    var wrap: CGRect?, glideEnd = 0.0, glideTime = 0.0, entrance: String?, variation: Double?
    init(_ event: RingEvent, _ theme: RingTheme, _ c: RingContext) {
        self.event = event; self.theme = theme; self.c = c
        let at = event.at ?? c.destination ?? c.from ?? .zero
        var route = handPoints((c.from.map { [$0] } ?? []) + [at])
        if c.from == nil, event.path.count > 1, event.state != "drag" { route = handPoints(event.path + [at]) }
        self.at = at; self.route = route
        var initial = RingKey.allCases.map { Self.base[$0] ?? 0 }
        initial[RingKey.gap.rawValue] = theme.gap; initial[RingKey.w.rawValue] = theme.size; initial[RingKey.h.rawValue] = theme.size
        initial[RingKey.rr.rawValue] = theme.size / 2
        if let end = c.previous?.shape { for key in RingKey.allCases { if let value = end[key.name] { initial[key.rawValue] = value } } }
        tl = SeamTimeline(initial, origin: route.first ?? at)
        wrap = c.previous?.rect
    }
    var reduced: Bool { c.reduced }
    func r(_ salt: Int) -> Double { theme.seeded ? seamRandom(c.seed, event.seq, salt) : 0.5 }
    func v(_ key: RingKey) -> Double { tl.value(key, t) }
    var wrapped: Bool { max(v(.w), v(.h)) > theme.size + 1 }
    func mark(_ name: String, _ start: Double) { phases[name] = [start, t - start] }
    var circle: [RingKey: Double] { [.w: theme.size, .h: theme.size, .rr: theme.size / 2, .rot: 0, .gap: theme.gap, .ox: 0, .oy: 0, .qz: 0] }
    func shape(_ rect: CGRect, pad: Double, radius: Double, _ extra: [RingKey: Double]) -> [RingKey: Double] {
        [.w: Double(rect.width) + pad, .h: Double(rect.height) + pad, .rr: radius, .ox: Double(rect.midX - at.x),
         .oy: Double(rect.midY - at.y)].merging(extra) { $1 }
    }
    // The act's own rect, else the one the halves already wrap when the act lands inside it.
    func target() -> CGRect? { event.rect ?? wrap.flatMap { $0.insetBy(dx: -1, dy: -1).contains(at) ? $0 : nil } }
    // Reduced motion crossfades a shape change instead of morphing it.
    func wrapTo(_ values: [RingKey: Double], _ duration: Double) {
        if reduced { tl.to([.o: 0], t, 0.06, Seam.linear); tl.set(values, t + 0.06); t = tl.to([.o: 1], t + 0.06, 0.08, Seam.linear) }
        else { t = tl.to(values, t, duration) }
    }
    func plan() -> RingPlan {
        if c.previous == nil { enter() } else { leave(c.previous?.state ?? "") }
        glide()
        switch event.state {
        case "aim": aim()
        case "click": click()
        case "double": double()
        case "right": right()
        case "type": type(single: false)
        case "key": type(single: true)
        case "scroll": scroll()
        case "drag": drag()
        case "thinking": thinking()
        case "waiting": waiting()
        case "error": error()
        default: done()
        }
        return finish()
    }
    // Entrance, seeded per appearance: the halves clasp in from their corners, pixels assemble, or the spark pops.
    func enter() {
        if reduced || !theme.seeded {
            tl.set([.o: 0], 0); t = tl.to([.o: 1], 0, 0.12, Seam.linear); entrance = "fade"; mark("entrance", 0); return
        }
        let pick = Int(r(1) * 3) % 3
        entrance = ["clasp", "assemble", "pop"][pick]
        switch pick {
        case 0: tl.set([.o: 0, .sep: 10], 0); t = tl.to([.o: 1, .sep: 0], 0, 0.18, Seam.back)
        case 1:
            tl.set([.ho: 0, .pm: 1, .px: 1, .pdis: 1], 0); t = tl.to([.pdis: 0], 0, 0.15)
            t = tl.to([.px: 0, .ho: 1], t, 0.07, Seam.linear); tl.set([.pm: 0], t)
        default:
            tl.set([.fray: 22, .sp: 1, .ss: 0], 0); tl.to([.ss: 1.4], 0, 0.09); tl.to([.ss: 1, .sp: 0], 0.09, 0.11, Seam.linear)
            t = tl.to([.fray: 0], 0, 0.2, Seam.back)
        }
        mark("entrance", 0)
    }
    // The way out of a held state when another state arrives.
    func leave(_ previous: String) {
        guard previous != event.state else { return }
        let start = t
        switch previous {
        case "thinking": t = tl.to([.fray: 0, .porb: 0, .sx: 0, .sy: 0, .sp: 0, .ss: 1, .o: 1], t, 0.12)
        case "waiting": t = tl.to([.ho: 1, .fray: 0, .px: 0, .pdim: 0, .hol: 0, .sp: 0, .ss: 1, .sep: 0, .gap: theme.gap, .qz: 0], t, 0.14)
        case "error": t = tl.to([.err: 0, .sep: 0, .xo: 0, .gap: theme.gap], t, 0.16)
        default: return
        }
        mark("exit", start)
    }
    // The whole route is one glide timed by its total length (160 to 320 ms, 60 ms when the frame lands mid-glide), split
    // by segment length. A drag's carry is the same move capped at the theme's carry time.
    func glide(_ points: [CGPoint]? = nil, carry: Bool = false) {
        let points = points ?? route
        guard points.count > 1 else { return }
        let lengths = zip(points, points.dropFirst()).map { hypot(Double($1.x - $0.x), Double($1.y - $0.y)) }
        let distance = lengths.reduce(0, +)
        guard distance >= 0.5 else { return }
        let snap = !carry && c.previous != nil && c.elapsed < (c.previous?.glideEnd ?? 0)
        let duration = carry ? theme.carry : snap ? 0.06 : min(0.32, max(0.16, 0.14 + distance * 0.00055))
        let start = t, unwrap = !carry && wrapped
        if unwrap { wrap = nil; if !reduced { tl.to(circle, t, 0.12) } }
        if reduced {
            tl.to([.o: 0], t, 0.07, Seam.linear)
            tl.move(.init(start: t + 0.07, duration: 0, a: points[0], c: points[0], b: points[points.count - 1], ux: 0, uy: 0, windup: false,
                curved: false, ease: Seam.linear))
            if unwrap { tl.set(circle, t + 0.07) }
            t = tl.to([.o: 1], t + 0.07, 0.07, Seam.linear)
        } else {
            var time = t
            let momentum = theme.momentum && !carry && !snap
            for (i, (a, b)) in zip(points, points.dropFirst()).enumerated() {
                let d = lengths[i], ms = duration * d / distance, first = i == 0, last = i == lengths.count - 1
                guard d > 0 else { continue }
                let ux = Double(b.x - a.x) / d, uy = Double(b.y - a.y) / d, bow = min(d * 0.12, 26)
                let control = CGPoint(x: Double(a.x + b.x) / 2 - uy * bow, y: Double(a.y + b.y) / 2 + ux * bow)
                let over = last && momentum ? min(4, d * 0.025) * (0.55 + 0.45 * r(10)) : 0
                let end = CGPoint(x: Double(b.x) + ux * over, y: Double(b.y) + uy * over)
                let ease: (Double) -> Double
                if lengths.count == 1 { ease = snap ? Seam.out : Seam.inOut } else if first { ease = Seam.quadIn } else if last { ease = Seam.quadOut } else { ease = Seam.linear }
                tl.move(.init(start: time, duration: ms, a: a, c: control, b: end, ux: ux, uy: uy, windup: first && momentum,
                    curved: theme.momentum && !snap, ease: ease))
                ribbon.append(Segment(start: time, duration: ms, a: a, c: control, b: b, ease: ease))
                if last, theme.reach, !carry, !snap, d >= 30 {
                    let from = CGPoint(x: Double(a.x) + theme.size / 2 * sqrt(0.5), y: Double(a.y) - theme.size / 2 * sqrt(0.5))
                    reach = Segment(start: time, duration: ms, a: from, c: control, b: b, ease: ease)
                }
                time += ms
                if last {
                    tl.set([.sqa: atan2(uy, ux)], time)
                    if momentum {
                        tl.move(.init(start: time, duration: 0.06, a: end, c: CGPoint(x: (end.x + b.x) / 2, y: (end.y + b.y) / 2), b: b, ux: 0, uy: 0,
                            windup: false, curved: false, ease: Seam.out))
                        tl.to([.sq: -0.12], time, 0.06); tl.to([.sq: 0], time + 0.06, 0.09, Seam.back)
                    }
                }
            }
            if theme.reach, !carry, !snap, let a = points.first, let b = points.last {
                let ux = Double(b.x - a.x) / distance, uy = Double(b.y - a.y) / distance
                tl.to([.sx: ux * 3, .sy: uy * 3, .sp: 0.7, .ss: 0.7], t, 0.07)
                tl.to([.sx: 0, .sy: 0, .sp: 0, .ss: 1], t + 0.07, max(0.06, duration - 0.07), Seam.inOut)
            }
            t = time
        }
        at = points[points.count - 1]
        if !carry { glideEnd = t; glideTime = t - start; mark(snap ? "snap" : "glide", start) } else { mark("carry", start) }
    }
    // Aim: wrap the rect with the seams open, or open the seams on the circle, then breathe through the hold. The host never
    // waits for the hold.
    func aim() {
        let start = t, hold = Double(event.holdMs) / 1000
        if let rect = event.rect {
            wrap = rect
            wrapTo(shape(rect, pad: 8, radius: 7, [.gap: 16, .sp: 0.55, .ss: 0.8, .sx: 0, .sy: 0, .rot: 0, .qz: 0]), 0.14)
            mark("wrap", start)
            breathe([.qz: -2.5], [.qz: 0], 1.2, hold)
        } else {
            t = tl.to(reduced ? [.gap: 14, .sp: 0.55] : [.gap: 14, .qz: -4, .sp: 0.55, .ss: 0.8], t, 0.12)
            mark("open", start)
            breathe([.qz: -2.6], [.qz: -4.4], 0.9, hold)
        }
    }
    func breathe(_ low: [RingKey: Double], _ high: [RingKey: Double], _ period: Double, _ total: Double) {
        guard total > 0, !reduced else { return }
        let start = t
        var elapsed = 0.0, down = true
        while elapsed < total - 1e-9 {
            let d = min(period / 2, total - elapsed)
            t = tl.to(down ? low : high, t, d, Seam.inOut); elapsed += d; down.toggle()
        }
        mark("hold", start)
    }
    func useTint() {
        let g = SeamGeo(v(.w), v(.h), v(.rr))
        tintPath = g.path(v(.ox), v(.oy), laps: 1, close: true)
    }
    // Click: the seams snap shut, the shape squeezes, the spark flashes at a seeded angle and size, and it rebounds.
    func click() {
        let start = t, value = r(20), wide = wrapped, q = wide ? 6.0 : 8.0
        variation = value
        if wide { useTint() }
        tl.set([.sr: value * 45], t)
        if reduced {
            tl.to([.gap: 0, .sp: 1, .fillO: wide ? 0.25 : 0], t, 0.06, Seam.linear)
            t = tl.to([.gap: theme.gap, .sp: 0, .fillO: 0], t + 0.06, 0.15)
        } else {
            tl.to([.gap: 0, .qz: q, .sp: 1, .ss: 1.5 + 0.4 * value, .fillO: wide ? 0.28 : 0, .sx: 0, .sy: 0], t, 0.06, Seam.cubicIn)
            tl.to([.qz: -(1 + 1.6 * value), .sp: 0, .ss: 1, .fillO: 0, .gap: theme.gap], t + 0.06, 0.09)
            t = tl.to([.qz: 0], t + 0.15, 0.06, Seam.inOut)
        }
        mark("click", start)
    }
    func double() {
        let start = t, value = r(21), wide = wrapped, q = reduced ? 0 : (wide ? 6.0 : 8.0)
        variation = value
        if wide { useTint() }
        tl.set([.sr: value * 45], t)
        tl.to([.gap: 0, .qz: q * 0.8, .sp: 1, .ss: reduced ? 1 : 1.2 + 0.2 * value, .fillO: wide ? 0.2 : 0], t, 0.05, Seam.cubicIn)
        tl.to([.gap: 4, .qz: q * 0.1, .sp: 0.3, .ss: 1, .fillO: wide ? 0.04 : 0], t + 0.05, 0.06)
        tl.to([.gap: 0, .qz: q, .sp: 1, .ss: reduced ? 1 : 1.7 + 0.3 * value, .sr: value * 45 + 45, .fillO: wide ? 0.3 : 0], t + 0.13, 0.05, Seam.cubicIn)
        t = tl.to([.gap: theme.gap, .qz: 0, .sp: 0, .ss: 1, .fillO: 0], t + 0.18, 0.07)
        mark("double", start)
    }
    // Right: the seams twist a quarter lap and back, and a corner mark shows where the menu opens.
    func right() {
        let start = t, turn = v(.rot), q = wrapped ? 5.0 : 6.0, w = v(.w), h = v(.h), ox = v(.ox), oy = v(.oy)
        markPath = [[0, ox + w / 2 + 3, oy + h / 2 - 5], [1, ox + w / 2 + 3, oy + h / 2 + 3], [1, ox + w / 2 - 5, oy + h / 2 + 3]]
        if reduced { tl.to([.gap: 0, .ml: 1], t, 0.09); t = tl.to([.gap: theme.gap, .ml: 0], t + 0.09, 0.13) }
        else { tl.to([.rot: turn + 0.25, .gap: 0, .qz: q, .ml: 1], t, 0.09); t = tl.to([.rot: turn, .gap: theme.gap, .qz: 0, .ml: 0], t + 0.09, 0.13, Seam.inOut) }
        mark("right", start)
    }
    // Type wraps the field (or shrinks the circle) and taps the halves in turn per key. The bottom seam rides the caret from
    // its known x at an estimated 5.5 pt per key. Secure input shows no taps and no caret.
    func type(single: Bool) {
        let start = t, caret = !c.secure && theme.caret ? event.caretX : nil
        var riding = false
        if !single {
            if theme.wrap, let rect = target() {
                wrap = rect
                var values = shape(rect, pad: 8, radius: 7, [.gap: 3, .qz: 0, .rot: 0, .sp: 0])
                if let x = caret, let w = values[.w], let h = values[.h], let ox = values[.ox], let oy = values[.oy] {
                    let local = x - Double(at.x) - ox
                    values[.rot] = SeamGeo(w, h, 7).rotation(under: local)
                    values[.sx] = ox + min(max(local, -w / 2 + 7), w / 2 - 7); values[.sy] = oy + h / 2; values[.sp] = 0.95; values[.ss] = 0.6
                    riding = true
                }
                wrapTo(values, 0.14)
            } else {
                var values: [RingKey: Double] = [.qz: reduced ? 0 : theme.size - 19, .gap: 8]
                if let x = caret { values[.ox] = x - Double(at.x); riding = true }
                t = tl.to(values, t, 0.12)
            }
            mark("enter", start)
        }
        guard !c.secure else { return }
        let keys = t
        for i in 0..<(single ? 1 : event.beats) {
            let half: RingKey = i % 2 == 0 ? .tw : .tc
            if !reduced { tl.to([half: 1.8], t, 0.025); tl.to([half: 0], t + 0.025, 0.035) }
            if riding, let x0 = caret {
                let x = x0 + 5.5 * Double(i + 1) - Double(at.x)
                if wrapped {
                    let w = v(.w), local = x - v(.ox)
                    tl.to([.rot: SeamGeo(w, v(.h), v(.rr)).rotation(under: local), .sx: v(.ox) + min(max(local, -w / 2 + 7), w / 2 - 7)], t, 0.04)
                } else { tl.to([.ox: x], t, 0.04) }
            }
            t += 0.06
        }
        mark("keys", keys)
    }
    // Scroll wraps the list and treads the halves around it, one step per tick, at most 4.
    func scroll() {
        let start = t
        if theme.wrap, let rect = target() { wrap = rect; wrapTo(shape(rect, pad: 8, radius: 7, [.sp: 0, .gap: theme.gap, .rot: 0, .qz: 0]), 0.14) }
        else { t = tl.to([.sp: 0, .gap: theme.gap], t, 0.14) }
        mark("enter", start)
        let turn = v(.rot), ticks = t
        for i in 0..<min(event.beats, 4) {
            if !reduced { tl.to([.rot: turn + 0.035 * Double(i + 1)], t, 0.12, Seam.inOut) }
            t += 0.12
        }
        mark("ticks", ticks)
        let exit = t
        t = tl.to([.rot: turn], t, 0.12)
        mark("exit", exit)
    }
    // Drag: grab wraps the card with the seams shut, the carry follows the path, drop opens the seams wide with a tint.
    func drag() {
        let start = t
        if theme.wrap, let rect = target() { wrap = rect; wrapTo(shape(rect, pad: 4, radius: 6, [.gap: 0, .sp: 0, .qz: 0]), 0.12) }
        else { t = tl.to([.gap: 0, .qz: reduced ? 0 : 3, .sp: 0.9, .ss: 0.75], t, 0.09) }
        mark("grab", start)
        glide(handPoints([at] + event.path), carry: true)
        let drop = t, wide = wrapped
        if wide { useTint() }
        tl.to([.gap: 14, .qz: reduced ? 0 : -8, .fillO: wide ? 0.25 : 0, .sp: 0], t, 0.09)
        t = tl.to([.gap: theme.gap, .qz: 0, .fillO: 0], t + 0.09, 0.11)
        mark("drop", drop)
    }
    // Thinking: the seams fray and six pixels orbit at mixed speeds while the spark glances around, three 1.6 s cycles, then
    // it parks still. The plain theme dims.
    func thinking() {
        let start = t
        guard theme.pixels else { t = tl.to([.o: 0.35], t, 0.12); mark("enter", start); return }
        tl.set([.tph: 0], t)
        t = tl.to([.fray: 4.5, .porb: 1, .sp: 0.8, .ss: 0.75], t, 0.14)
        mark("enter", start)
        guard !reduced else { return }
        let cycles = t
        for cycle in 0..<3 {
            tl.to([.tph: Double(cycle + 1)], t, 1.6, Seam.linear)
            var elapsed = 0.0, k = 0
            while elapsed + 0.14 <= 1.6 + 1e-9 {
                let angle = r(100 + cycle * 8 + k) * 2 * Double.pi
                tl.to([.sx: cos(angle) * 2.6, .sy: sin(angle) * 2.6], t + elapsed, 0.14, Seam.inOut)
                elapsed += 0.533; k += 1
            }
            t += 1.6
        }
        mark("cycles", cycles)
        let settle = t
        t = tl.to([.sx: 0, .sy: 0], t, 0.16, Seam.inOut)
        mark("settle", settle)
    }
    // Waiting: the halves unravel into twelve pixels, every other one dim, that step once per 800 ms with a hollow spark's
    // nod, six steps, then park. The plain theme opens its seams wide.
    func waiting() {
        let start = t
        guard theme.pixels else { t = tl.to([.gap: 18, .sep: 5, .qz: -2, .sp: 0], t, 0.16); mark("enter", start); return }
        tl.set([.pm: 0, .pstep: 0, .pdim: 1], t)
        t = tl.to([.ho: 0, .fray: 6, .px: 1, .sp: 0.9, .hol: 1, .ss: 1.1, .sx: 0, .sy: 0, .gap: theme.gap, .qz: 0], t, 0.16)
        mark("enter", start)
        guard !reduced else { return }
        let steps = t
        for n in 0..<6 {
            tl.to([.sy: -1.4], t, 0.1); tl.to([.sy: 0], t + 0.1, 0.16, Seam.inOut)
            tl.to([.pstep: Double(n + 1) / 12], t, 0.2, Seam.inOut)
            t += 0.8
        }
        mark("steps", steps)
    }
    // Error: the halves turn red and recoil along the diagonal, a cross shows in the gap, and it shakes once.
    func error() {
        let start = t
        cross = true
        tl.to([.err: 1, .sep: 3.5, .xo: 1, .gap: 14, .sp: 0, .ho: 1, .px: 0, .porb: 0, .o: 1], t, 0.09)
        if !reduced { var s = t; for value in [3.0, -3, 2, -2, 1, 0] { tl.to([.sh: value], s, 0.04, Seam.inOut); s += 0.04 } }
        t += 0.24
        mark("error", start)
    }
    // Done and handback dissolve into pixels that drift apart on the diagonal. A done with a confirmed ok bursts first.
    func done() {
        if event.state == "done", event.ok, theme.burst, !reduced {
            let start = t
            tl.set([.bx: v(.sx), .by: v(.sy), .bs: r(30) * 60, .burst: 0, .bo: 1], t)
            t = tl.to([.burst: 1], t, 0.22); tl.set([.bo: 0], t)
            mark("burst", start)
        }
        let start = t
        if reduced { t = tl.to([.o: 0], t, 0.38) }
        else {
            tl.set([.pm: 1, .pdis: 0, .pstep: 0, .pdim: 0, .porb: 0], t)
            tl.to([.ho: 0, .px: 1, .sp: 0, .xo: 0], t, 0.06)
            t = tl.to([.pdis: 1], t + 0.06, 0.32); tl.set([.o: 0], t)
        }
        mark("dissolve", start)
    }
    func ribbonHead(_ time: Double, _ lengths: [Double], _ whole: Double) -> Double {
        var done = 0.0
        for (i, seg) in ribbon.enumerated() {
            if time < seg.start { return done / whole }
            if time < seg.start + seg.duration { return (done + seg.ease((time - seg.start) / seg.duration) * lengths[i]) / whole }
            done += lengths[i]
        }
        return 1
    }
    func squares(_ list: [(Double, Double, Double)]) -> [[Double]] {
        guard let first = list.first else { return [] }
        var result: [[Double]] = []
        result.reserveCapacity(30)
        for i in 0..<6 {
            let (x, y, s) = i < list.count ? list[i] : first, e = s / 2
            result.append([0, x - e, y - e]); result.append([1, x + e, y - e]); result.append([1, x + e, y + e])
            result.append([1, x - e, y + e]); result.append([3])
        }
        return result
    }
    // The halves' path changes only when the shape does; one array serves every sample with the same shape, so comparing
    // samples is a reference check.
    var pathCache: (key: [Double], path: [[Double]])?
    func ringPath(_ g: SeamGeo, _ ox: Double, _ oy: Double) -> [[Double]] {
        let key = [g.w, g.h, g.r, ox, oy]
        if let cached = pathCache, cached.key == key { return cached.path }
        let path = g.path(ox, oy, laps: 3)
        pathCache = (key, path)
        return path
    }
    // The last sample, so a group of channels whose inputs did not change copies its values instead of rebuilding them.
    var lastState: [Double]?, lastRow: [RingValue?] = [], lastMoving = true, halvesSlots = 0..<0, sparkSlots = 0..<0
    // Channels whose value differed between two samples; only these become tracks.
    var changed: [Bool] = []
    static let halvesKeys = ([.sq, .sqa, .w, .h, .qz, .rr, .ox, .oy, .gap, .fray, .ho, .rot, .sep, .tc, .tw, .err] as [RingKey]).map { $0.rawValue }
    static let sparkKeys = ([.ss, .sr, .sx, .sy, .sp, .hol] as [RingKey]).map { $0.rawValue }
    static let pixelKeys = ([.bo, .burst, .bs, .bx, .by, .porb, .tph, .px, .pm, .pstep, .pdis, .pdim, .rot, .w, .h, .qz, .rr, .ox, .oy] as [RingKey]).map { $0.rawValue }
    var pixelSlots = 0..<0
    // Every layer property at one time, as channels in a fixed order. The first call also records the channel names.
    func derive(_ time: Double, lengths: [Double], whole: Double, into out: inout [RingValue?], names: inout [String]) {
        let s = tl.state(time), first = names.isEmpty, velocity = tl.velocity(time)
        defer { lastState = s; lastRow = out; lastMoving = velocity != nil }
        func same(_ keys: [Int]) -> Bool {
            guard let last = lastState else { return false }
            var i = 0
            while i < keys.count { if last[keys[i]] != s[keys[i]] { return false }; i += 1 }
            return true
        }
        func n(_ key: RingKey) -> Double { s[key.rawValue] }
        func put(_ name: @autoclosure () -> String, _ value: RingValue?) {
            if first { names.append(name()); changed.append(false) } else if !changed[out.count], lastRow[out.count] != value { changed[out.count] = true }
            out.append(value)
        }
        func mix(_ a: [Double], _ b: [Double], _ f: Double) -> [Double] { [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f] }
        let pos = tl.position(time), o = min(1, max(0, n(.o)))
        put("cursor/position", .vector([Double(pos.x), Double(pos.y)]))
        put("cursor/opacity", .number(o))
        put("cursor/transform.translation.x", .number(n(.sh)))
        let g = SeamGeo(n(.w) - n(.qz), n(.h) - n(.qz), n(.rr)), ox = n(.ox), oy = n(.oy), P = g.P, d = sqrt(0.5)
        if velocity == nil, !lastMoving, !first, same(Self.halvesKeys) { out.append(contentsOf: lastRow[halvesSlots]) } else {
        let halvesStart = out.count
        var sq = n(.sq), angle = n(.sqa), lx = 0.0, ly = 0.0
        if let (vx, vy) = velocity {
            let speed = hypot(vx, vy), stretch = min(0.28, max(0, speed * 0.13))
            sq += stretch
            if speed > 0.05 { angle = atan2(vy, vx) }
            if speed > 0 {
                let lean = 3 * stretch / 0.28, along = (vx - vy) * sqrt(0.5) / speed
                lx = vx / speed * lean * along; ly = vy / speed * lean * along
            }
        }
        let ca = cos(angle), sa = sin(angle), kx = 1 + sq, ky = 1 - 0.6 * sq
        put("halves/transform", .vector([ca * ca * kx + sa * sa * ky, ca * sa * (kx - ky), ca * sa * (kx - ky), sa * sa * kx + ca * ca * ky, 0, 0]))
        let path = RingValue.path(ringPath(g, ox, oy)), length = P / 2 - n(.gap) - 2 * n(.fray)
        let shown = RingValue.number(min(1, max(0, length > 0.2 ? n(.ho) : 0))), span = max(length, 0.001)
        let coolStart = P + max(-0.9, min(0.9, n(.rot))) * P + n(.gap) / 2 + n(.fray)
        for (side, begin) in [("C", coolStart), ("W", coolStart + P / 2)] {
            let shift = RingValue.vector(side == "C" ? [lx + d * n(.sep) - d * n(.tc), ly - d * n(.sep) + d * n(.tc)]
                : [-lx - d * n(.sep) + d * n(.tw), -ly + d * n(.sep) - d * n(.tw)])
            let start = RingValue.number(max(0, min(1, begin / (3 * P)))), end = RingValue.number(max(0, min(1, (begin + span) / (3 * P))))
            for layer in ["k", "a"] {
                put(layer + side + "/path", path); put(layer + side + "/strokeStart", start); put(layer + side + "/strokeEnd", end)
                put(layer + side + "/transform.translation", shift); put(layer + side + "/opacity", shown)
            }
        }
        put("aW/strokeColor", .vector(mix(theme.warm, theme.error, n(.err))))
        put("aC/strokeColor", .vector(mix(theme.cool, theme.error, n(.err))))
        halvesSlots = halvesStart..<out.count
        }
        if tintPath != nil { put("tint/opacity", .number(n(.fillO))) }
        if !first, same(Self.sparkKeys) { out.append(contentsOf: lastRow[sparkSlots]) } else {
            let sparkStart = out.count, ss = n(.ss), sr = n(.sr) * Double.pi / 180
            put("spark/transform", .vector([ss * cos(sr), ss * sin(sr), -ss * sin(sr), ss * cos(sr), n(.sx), n(.sy)]))
            put("spark/opacity", .number(min(1, max(0, n(.sp)))))
            put("spark/fillColor", .vector([1, 1, 1, 1 - 0.85 * n(.hol)]))
            put("spark/strokeColor", .vector(mix(theme.ink, theme.white, n(.hol))))
            sparkSlots = sparkStart..<out.count
        }
        if cross { put("cross/opacity", .number(n(.xo))) }
        if markPath != nil { put("mark/opacity", .number(n(.ml))) }
        // Pixels: four layers of six squares (warm, cool, then their dim twins), reused by every pixel move.
        if !first, same(Self.pixelKeys) { out.append(contentsOf: lastRow[pixelSlots]) } else {
        let pixelStart = out.count
        var spots: [[(Double, Double, Double)]] = [[], [], [], []], alpha: [Double] = [0, 0, 0, 0], orbit: [RingValue]?
        let turn = max(-0.9, min(0.9, n(.rot))) * P
        if n(.bo) > 0, n(.burst) < 1 {
            for k in 0..<6 {
                let a = (n(.bs) + Double(k) * 60) * Double.pi / 180, reach = 5 + 10 * n(.burst)
                spots[k % 2 == 0 ? 2 : 3].append((n(.bx) + cos(a) * reach, n(.by) + sin(a) * reach, 2.4 * (1 - 0.4 * n(.burst))))
            }
            alpha[2] = (1 - n(.burst)) * n(.bo); alpha[3] = alpha[2]
        }
        if n(.porb) > 0 {
            // Orbit paths depend only on the shape and the phase, so they are kept for the life of the process.
            let key = [g.w, g.h, g.r, ox, oy, turn, n(.tph)]
            if let cached = ringOrbitCache[key] { orbit = cached } else {
                for k in 0..<6 {
                    let f = Self.orbitHome[k] + n(.tph) * Self.orbitSpeed[k], p = g.point(turn + f * P)
                    let lift = 3.2 + 1.2 * sin(2 * Double.pi * (n(.tph) * 2 + Double(k) / 6))
                    spots[k < 3 ? 0 : 1].append((ox + p.x + p.nx * lift, oy + p.y + p.ny * lift, 3))
                }
                let paths: [RingValue] = [.path(squares(spots[0])), .path(squares(spots[1]))]
                if ringOrbitCache.count > 4096 { ringOrbitCache.removeAll() }
                ringOrbitCache[key] = paths; orbit = paths
            }
            alpha[0] = n(.porb); alpha[1] = n(.porb)
        } else if n(.px) > 0 {
            let split = n(.pm) > 0.5
            for k in 0..<12 {
                let p = g.point(turn + (Double(k) / 12 + n(.pstep)) * P), cool = k < 6
                var x = ox + p.x, y = oy + p.y
                if n(.pdis) > 0 {
                    let m = n(.pdis) * (8 + seamRandom(c.seed, 0, 200 + k) * 16), dir = cool ? 1.0 : -1.0
                    x += dir * m; y -= dir * m
                }
                spots[split || k % 2 == 0 ? (cool ? 1 : 0) : (cool ? 3 : 2)].append((x, y, 3.4))
            }
            let base = n(.px) * (1 - n(.pdis))
            alpha[0] = base; alpha[1] = base
            if !split { alpha[2] = base * (1 - 0.75 * n(.pdim)); alpha[3] = alpha[2] }
        }
        for (i, name) in Self.pixels.enumerated() {
            put(name + "/opacity", .number(min(1, max(0, alpha[i]))))
            put(name + "/path", i < 2 && orbit != nil ? orbit?[i] : spots[i].isEmpty ? nil : .path(squares(spots[i])))
        }
        pixelSlots = pixelStart..<out.count
        }
        if !ribbon.isEmpty, whole > 0 {
            let head = ribbonHead(time, lengths, whole), tail = ribbonHead(time - 0.17, lengths, whole)
            for name in ["ribbonW", "ribbonC"] {
                put(name + "/strokeEnd", .number(head)); put(name + "/strokeStart", .number(tail))
                put(name + "/opacity", .number(head - tail > 0.002 ? o : 0))
            }
        }
        if let rc = reach {
            let f = (time - rc.start) / rc.duration, inside = f >= 0 && f <= 1
            let grow = inside ? Seam.out(min(1, (time - rc.start) / 0.06)) : (f > 1 ? 1 : 0), q = inside ? rc.ease(f) : (f > 1 ? 1 : 0)
            let fade = inside ? (q < 0.75 ? 1 : (1 - q) / 0.25) : 0
            for (name, scale) in [("reachInk", 0.3), ("reach", 0.9)] {
                put(name + "/strokeEnd", .number(grow)); put(name + "/strokeStart", .number(min(q, grow)))
                put(name + "/opacity", .number(fade * scale * o))
            }
        }
    }
    func finish() -> RingPlan {
        var p = RingPlan(state: event.state, at: at, label: c.secure ? nil : event.label, rect: wrap)
        let lengths = ribbon.map { seg -> Double in
            var length = 0.0, last = seg.a
            for i in 1...8 {
                let q = Double(i) / 8, u = 1 - q
                let point = CGPoint(x: u * u * seg.a.x + 2 * u * q * seg.c.x + q * q * seg.b.x, y: u * u * seg.a.y + 2 * u * q * seg.c.y + q * q * seg.b.y)
                length += hypot(Double(point.x - last.x), Double(point.y - last.y)); last = point
            }
            return length
        }
        let whole = lengths.reduce(0, +)
        var total = max(t, tl.marks.max() ?? 0)
        if let last = ribbon.last { total = max(total, last.start + last.duration + 0.17) }
        var keys = Set<Int>(tl.marks.filter { $0 <= total + 1e-9 }.map { Int(($0 * 10000).rounded()) })
        var s = 0.0
        // Long plans (thinking, waiting) sample every 75 ms, which keeps a thinking frame near 1.5 ms of planning in the unoptimized
        // host build. Core Animation interpolates between samples; the fastest orbit pixel cuts a corner by at most 0.7 pt.
        let step = total > 1 ? Seam.step * 3 : Seam.step
        while s < total { keys.insert(Int((s * 10000).rounded())); s += step }
        for m in tl.moves where m.duration > 0 {
            for i in 1..<12 { keys.insert(Int(((m.start + m.duration * Double(i) / 12) * 10000).rounded())) }
        }
        keys.insert(Int((total * 10000).rounded()))
        let times = keys.sorted().map { Double($0) / 10000 }
        var names: [String] = [], frames: [[RingValue?]] = []
        frames.reserveCapacity(times.count)
        for time in times {
            var row: [RingValue?] = []
            row.reserveCapacity(max(names.count, 64))
            derive(time, lengths: lengths, whole: whole, into: &row, names: &names)
            frames.append(row)
        }
        let channel = Dictionary(uniqueKeysWithValues: names.enumerated().map { ($1, $0) })
        // Tracks: a property that changes gets one track from the sample before its first change to its last change.
        var statics: [String: RingValue] = [:], tracks: [RingTrack] = []
        for (index, key) in names.enumerated().sorted(by: { $0.element < $1.element }) {
            guard changed[index] else { if let value = frames.first?[index] { statics[key] = value }; continue }
            var values: [RingValue] = [], known: RingValue?
            values.reserveCapacity(frames.count)
            for row in frames { if let value = row[index] { known = value; break } }
            guard let firstKnown = known else { continue }
            for row in frames { let value = row[index] ?? values.last ?? firstKnown; values.append(value) }
            let first = values[0]
            statics[key] = first
            var change = -1, end = -1
            for i in 1..<max(1, values.count) where values[i] != values[i - 1] { if change < 0 { change = i }; end = i }
            guard change > 0 else { continue }
            let from = change - 1
            var kept: [Int] = []
            for i in from...end where i == from || i == end || values[i] != values[i - 1] || values[i] != values[i + 1] { kept.append(i) }
            let begin = times[from], duration = times[end] - begin
            let parts = key.split(separator: "/", maxSplits: 1).map(String.init)
            tracks.append(RingTrack(layer: parts[0], keyPath: parts[1], begin: begin, duration: duration, values: kept.map { values[$0] },
                times: kept.map { duration > 0 ? (times[$0] - begin) / duration : 0 }))
        }
        func props(_ name: String) -> [String: RingValue] {
            statics.filter { $0.key.hasPrefix(name + "/") }.reduce(into: [:]) { $0[String($1.key.dropFirst(name.count + 1))] = $1.value }
        }
        let star: [[Double]] = [[0, 0, -3.4], [1, 1, -1], [1, 3.4, 0], [1, 1, 1], [1, 0, 3.4], [1, -1, 1], [1, -3.4, 0], [1, -1, -1], [3]]
        var layers: [RingLayer] = [RingLayer(name: "cursor", kind: .group, parent: "root", global: true, props: props("cursor")),
            RingLayer(name: "halves", kind: .group, props: props("halves"))]
        if let tint = tintPath {
            layers.append(RingLayer(name: "tint", kind: .gradient, parent: "halves", colors: [theme.warm, theme.cool],
                props: props("tint").merging(["path": .path(tint)]) { $1 }))
        }
        for (name, color, width) in [("kW", theme.ink, 5.0), ("aW", theme.warm, 2.6), ("kC", theme.ink, 5.0), ("aC", theme.cool, 2.6)] {
            layers.append(RingLayer(name: name, parent: "halves", stroke: color, width: width, props: props(name)))
        }
        if let mark = markPath {
            layers.append(RingLayer(name: "mark", parent: "halves", stroke: theme.white, width: 1.5, keyline: true, props: props("mark").merging(["path": .path(mark)]) { $1 }))
        }
        for (i, name) in Self.pixels.enumerated() where statics[name + "/path"] != nil {
            layers.append(RingLayer(name: name, stroke: theme.ink, fill: i % 2 == 0 ? theme.warm : theme.cool, width: 0.8, props: props(name)))
        }
        if !layers.contains(where: { Self.pixels.contains($0.name) }) { tracks.removeAll { Self.pixels.contains($0.layer) } }
        tracks.removeAll { t in Self.pixels.contains(t.layer) && statics[t.layer + "/path"] == nil }
        layers.append(RingLayer(name: "spark", stroke: theme.ink, fill: theme.white, width: 0.9, props: props("spark").merging(["path": .path(star)]) { $1 }))
        if cross {
            layers.append(RingLayer(name: "cross", stroke: theme.white, width: 1.6, keyline: true,
                props: props("cross").merging(["path": .path([[0, -3.2, -3.2], [1, 3.2, 3.2], [0, 3.2, -3.2], [1, -3.2, 3.2]])]) { $1 }))
        }
        if let rc = reach {
            let path: [[Double]] = [[0, Double(rc.a.x), Double(rc.a.y)], [2, Double(rc.c.x), Double(rc.c.y), Double(rc.b.x), Double(rc.b.y)]]
            layers.append(RingLayer(name: "reachInk", parent: "root", global: true, under: true, stroke: theme.ink, width: 2.6, props: props("reachInk").merging(["path": .path(path)]) { $1 }))
            layers.append(RingLayer(name: "reach", parent: "root", global: true, under: true, stroke: theme.cool, width: 1.1, dash: [2, 3], props: props("reach").merging(["path": .path(path)]) { $1 }))
        }
        if let a = ribbon.first?.a, let b = ribbon.last?.b {
            let L = max(0.001, hypot(Double(b.x - a.x), Double(b.y - a.y)))
            var nx = -Double(b.y - a.y) / L, ny = Double(b.x - a.x) / L
            if -nx + ny < 0 { nx = -nx; ny = -ny }
            for (name, sign, color) in [("ribbonW", 1.0, theme.warm), ("ribbonC", -1.0, theme.cool)] {
                var path: [[Double]] = [[0, Double(a.x) + sign * nx * 2.4, Double(a.y) + sign * ny * 2.4]]
                for seg in ribbon {
                    path.append([2, Double(seg.c.x) + sign * nx * 2.4, Double(seg.c.y) + sign * ny * 2.4, Double(seg.b.x) + sign * nx * 2.4, Double(seg.b.y) + sign * ny * 2.4])
                }
                layers.append(RingLayer(name: name, parent: "root", global: true, under: true, stroke: color, width: 1.4, props: props(name).merging(["path": .path(path)]) { $1 }))
            }
        }
        // The label chip fades in only when its text changes; the old chip and its tether fade out in 60 ms.
        let previous = c.secure ? nil : c.previous?.label
        if let label = p.label, !label.isEmpty {
            let chip = ringChip(label, at: at, clip: c.clip)
            p.chip = chip
            let fresh = previous != label
            layers.append(RingLayer(name: "chip", kind: .text, parent: "root", global: true, stroke: theme.white, fill: theme.ink, text: label,
                frame: chip.frame, props: ["opacity": .number(fresh ? 0 : 1)]))
            layers.append(RingLayer(name: "tether", parent: "root", global: true, stroke: theme.ink, width: 1,
                props: ["path": .path(chip.tether), "opacity": .number(fresh ? 0 : 1)]))
            if fresh {
                let begin = previous.map { $0.isEmpty ? 0 : 0.06 } ?? 0
                for name in ["chip", "tether"] { tracks.append(RingTrack(layer: name, keyPath: "opacity", begin: begin, duration: 0.09, values: [.number(0), .number(1)], times: [0, 1])) }
            }
        }
        if let old = previous, !old.isEmpty, old != p.label {
            p.oldLabel = old
            for name in ["oldChip", "oldTether"] { tracks.append(RingTrack(layer: name, keyPath: "opacity", begin: 0, duration: 0.06, values: [.number(1), .number(0)], times: [0, 1])) }
        }
        total = max(total, tracks.map { $0.begin + $0.duration }.max() ?? 0)
        p.layers = layers; p.tracks = tracks; p.total = total; p.glide = glideTime; p.glideEnd = glideEnd; p.fade = theme.fade
        p.phases = phases; p.entrance = entrance; p.variation = variation
        p.shape = Dictionary(uniqueKeysWithValues: RingKey.allCases.map { ($0.name, tl.value($0, total)) })
        let place = channel["cursor/position"] ?? 0
        p.positions = zip(times, frames).compactMap { time, frame in
            if case let .vector(xy)? = frame[place] { return (time, CGPoint(x: xy[0], y: xy[1])) }
            return nil
        }
        // The panel holds the route, every shape extent and the chip.
        var box = (minX: Double.infinity, minY: Double.infinity, maxX: -Double.infinity, maxY: -Double.infinity)
        for (time, point) in p.positions {
            let w = tl.value(.w, time) / 2 + 4, h = tl.value(.h, time) / 2 + 4, ox = tl.value(.ox, time), oy = tl.value(.oy, time)
            box = (min(box.minX, Double(point.x) + ox - w), min(box.minY, Double(point.y) + oy - h), max(box.maxX, Double(point.x) + ox + w), max(box.maxY, Double(point.y) + oy + h))
        }
        p.points = route + (box.minX.isFinite ? [CGPoint(x: box.minX, y: box.minY), CGPoint(x: box.maxX, y: box.maxY)] : [])
        // Waiting stays up, parked, until the next frame or the cap: an approval can take minutes and a still layer costs nothing.
        let quiet = event.state == "waiting" ? max(total, theme.waitingCap) : total + theme.silence
        p.timers = ["done", "handback"].contains(event.state) ? [RingTimer(at: total, action: "park"), RingTimer(at: total, action: "release")]
            : [RingTimer(at: total, action: "park"), RingTimer(at: quiet, action: "fade"), RingTimer(at: quiet + theme.fade, action: "release")]
        // Budget: layers built, drawing layers shown at once, and animated layers (one animation group each) at once.
        let drawing = layers.filter { $0.kind != .group }
        let chipCount = p.label?.isEmpty == false ? 2.0 : 0, oldCount = p.oldLabel == nil ? 0.0 : 2
        var mostVisible = 0.0, mostAnimated = 0.0, clickAnimated = 0.0
        let click = phases["click"] ?? phases["double"] ?? phases["right"]
        let shownLayers = drawing.filter { $0.kind != .text && $0.name != "tether" }.map { layer in
            (global: layer.global, index: channel[layer.name + "/opacity"], fixed: statics[layer.name + "/opacity"]?.number ?? (layer.props["opacity"]?.number ?? 1)) }
        let spans = Dictionary(grouping: tracks, by: { $0.layer }).values.map { list in list.map { ($0.begin, $0.begin + $0.duration) } }
        let opacity = channel["cursor/opacity"]
        for (time, frame) in zip(times, frames) {
            let o = opacity.flatMap { frame[$0]?.number } ?? 1
            var visible = chipCount + (time < 0.06 ? oldCount : 0)
            for layer in shownLayers {
                let alpha = layer.index.flatMap { frame[$0]?.number } ?? layer.fixed
                if alpha * (layer.global ? 1 : o) > 0.01 { visible += 1 }
            }
            mostVisible = max(mostVisible, visible)
            var active = 0
            for list in spans { for span in list where span.0 <= time + 1e-9 && time < span.1 - 1e-9 { active += 1; break } }
            let animated = Double(active)
            mostAnimated = max(mostAnimated, animated)
            if let window = click, time >= window[0] - 1e-9, time <= window[0] + window[1] + 1e-9 { clickAnimated = max(clickAnimated, animated) }
        }
        p.budget = ["layers": Double(layers.count + (tintPath == nil ? 0 : 1)) + oldCount, "visible": mostVisible, "animated": mostAnimated,
            "clickAnimated": clickAnimated, "samples": Double(times.count)]
        return p
    }
}
// Position memory is bound to one target, so a point-free status never leaks onto a different window. A frame that lands
// while the last glide is still moving starts from where the glide is at that moment, and a point-free status plays at the
// glide's destination. A ring that has dissolved or faded out is never continued: the next frame enters again.
struct RingSession {
    var point: CGPoint?, pid: Int32?, window: UInt32?, previous: RingPlan?, began = 0.0
    mutating func reset() { point = nil; pid = nil; window = nil; previous = nil }
    mutating func plan(_ event: RingEvent, theme: RingTheme, now: Double, reduced: Bool, secure: Bool, clip: CGRect, seed: UInt64) -> RingPlan {
        let same = pid == event.pid && window == event.windowId, elapsed = now - began
        let live = same ? previous.flatMap { last in (last.shape["o"] ?? 1) > 0.01 && !["done", "handback"].contains(last.state) ? last : nil } : nil
        var from = same ? point : nil
        if let last = live, elapsed < last.glideEnd { from = last.position(at: elapsed) }
        guard event.at != nil || from != nil else { var p = RingPlan(state: event.state, at: .zero); p.dropped = true; return p }
        let context = RingContext(from: from, destination: same ? point : nil, previous: live, elapsed: elapsed, reduced: reduced, secure: secure,
            clip: clip, seed: seed)
        let plan = RingPlanner(event, theme, context).plan()
        point = plan.at; pid = event.pid; window = event.windowId; previous = plan; began = now
        return plan
    }
}
func ringEvent(_ act: HandAct) -> RingEvent {
    RingEvent(seq: act.seq, state: act.kind, pid: act.pid, windowId: act.windowId, at: act.at, rect: act.rect, label: act.label,
        path: act.path, beats: act.beats, caretX: act.caretX)
}
// END RING PLAN

// BEGIN RING RUNTIME
// The ring's scheduling, a pure state machine the host and the dump both drive. An act waits out its delay. Aim and
// statuses queue behind waiting acts in arrival order, except error, done and handback, which cancel them and draw at once,
// as hide cancels them. Every plan parks (its animations come off), then fades after the silence and releases. Waiting
// stays up until the next frame, up to a 120 s cap. A status with no point to use is dropped and changes nothing. A target
// window that can't be found hides the ring. Nothing repeats: the host keeps one one-shot wake-up for the earliest due item.
struct RingEnvironment {
    var bounds: (Int32, UInt32) -> CGRect?
    var reduced: () -> Bool
    var secure: () -> Bool
}
enum RingEffect { case draw(RingPlan, CGRect), hide, drop(String), park, fade(Double), release }
struct RingRuntime {
    var theme: RingTheme, seed: UInt64
    var character: SpriteCharacter? = nil
    var dissolveAt: CGPoint? = nil   // perch mode: a done with ok bursts at the high-five's palm
    var session = RingSession()
    var pending: [(due: Double, event: RingEvent)] = []
    var timers: [(at: Double, action: String)] = []
    var fade = 0.22, shown = false
    init(theme: RingTheme, seed: UInt64) { self.theme = theme; self.seed = seed }
    var idle: Bool { pending.isEmpty && timers.isEmpty && !shown }
    var next: Double? { (pending.map { $0.due } + timers.map { $0.at }).min() }
    mutating func receive(_ event: RingEvent, delay: Double, now: Double, _ env: RingEnvironment) -> [(Double, RingEffect)] {
        var out = advance(to: now, env)
        let terminal = ["error", "done", "handback"].contains(event.state)
        if terminal { pending.removeAll() }
        if (handKinds.contains(event.state) && delay > 0) || (!terminal && !pending.isEmpty) {
            if pending.count < 64 { pending.append((max(now + delay, pending.map { $0.due }.max() ?? now), event)) }
            return out
        }
        out += draw(event, now, env)
        return out
    }
    mutating func hide(_ now: Double) -> [(Double, RingEffect)] {
        pending.removeAll(); timers.removeAll(); session.reset(); shown = false
        return [(now, .hide)]
    }
    mutating func advance(to now: Double, _ env: RingEnvironment) -> [(Double, RingEffect)] {
        var out: [(Double, RingEffect)] = []
        while let due = next, due <= now {
            if let i = pending.indices.min(by: { pending[$0].due < pending[$1].due }), pending[i].due == due,
                timers.first(where: { $0.at < due }) == nil {
                let item = pending.remove(at: i)
                out += draw(item.event, due, env)
                continue
            }
            guard let j = timers.indices.min(by: { timers[$0].at < timers[$1].at }) else { break }
            let timer = timers.remove(at: j)
            switch timer.action {
            case "park": out.append((timer.at, .park))
            case "fade": out.append((timer.at, .fade(fade)))
            default: shown = false; session.reset(); timers.removeAll(); out.append((timer.at, .release))
            }
        }
        return out
    }
    mutating func draw(_ event: RingEvent, _ now: Double, _ env: RingEnvironment) -> [(Double, RingEffect)] {
        let frameOk = event.ok, (event, palm) = perchDissolve(event, .null, dissolveAt)
        let known = session.pid == event.pid && session.window == event.windowId && session.point != nil
        guard event.at != nil || known else { return [(now, .drop(event.state))] }
        // A repeat of the state the ring already shows at the same point, inside that plan, changes nothing.
        if known, ["thinking", "waiting", "error", "done", "handback"].contains(event.state), let last = session.previous, last.state == event.state, event.at == nil || event.at == last.at,
            event.label == last.label, now - session.began < last.total { return [] }
        guard let bounds = env.bounds(event.pid, event.windowId) else { return hide(now) }
        let clip = palm.isNull ? bounds : bounds.union(palm)
        var plan = session.plan(event, theme: theme, now: now, reduced: env.reduced(), secure: env.secure(), clip: clip, seed: seed)
        guard !plan.dropped else { return [(now, .drop(event.state))] }
        plan.pid = event.pid; plan.window = event.windowId; plan.ok = frameOk
        if let character = character { plan.sprite = SpritePlan.make(plan, character: character, reduced: env.reduced(), secure: env.secure(), clip: clip) }
        let chip = plan.chip.map { [$0.frame.origin, CGPoint(x: $0.frame.maxX, y: $0.frame.maxY)] } ?? []
        var frame = handBox(plan.points + [plan.at] + chip)
        if let sprite = plan.sprite { frame = frame.union(sprite.bounds(plan)) }
        frame = frame.intersection(clip)
        guard !frame.isNull, frame.width >= 1, frame.height >= 1 else { return hide(now) }
        timers = plan.timers.map { (now + $0.at, $0.action) }
        fade = plan.fade; shown = true
        return [(now, .draw(plan, frame))]
    }
}
// END RING RUNTIME

// BEGIN SPRITE
// The character sprite (style "sprite"). The ring planners stay independent of image IO and character state resolution. Nothing
// in this block parses image data beyond a header or calls ImageIO: a sandboxed child of this binary decodes each sheet
// (BEGIN SPRITE DECODE CHILD) and hands back raw sRGB RGBA.
let spriteStates: Set<String> = ["idle", "move", "aim", "click", "double-click", "right-click", "type", "key", "scroll-up", "scroll-down",
    "drag-grab", "drag-carry", "drag-drop", "waiting-approval", "error", "success", "thinking", "handoff", "working"]
// Direction variants: NAME@N, N 0 to 15 clockwise from up. The -far variants are for glides over 60 pt (R3 1.4's running rows).
let spriteDirectional: Set<String> = ["move", "aim", "drag-carry", "move-far", "drag-carry-far"]
// One sheet is at most 1536 by 2288 pixels (8 columns of 192, 11 rows of 208): 13.4 MiB decoded.
let spriteSheetCap = (width: 1536, height: 2288), spriteCellCap = (width: 192.0, height: 208.0)
struct SpriteEntry {
    let sheet: String, row: Int, columns: [Int], ms: [Double], loop: Bool, flip: Bool, hotspot: CGPoint
    let size: CGSize?, scale: Double, then: String?
}
struct SpriteFrame {
    let seq: Int, id: String, sheet: String, extra: String?, cell: CGSize, table: [String: SpriteEntry]
    var perch: PerchTable? = nil, perchSheet: String? = nil, lines: PerchLineSet? = nil
}
func spriteFrame(_ data: [String: Any]) -> SpriteFrame? {
    func n(_ raw: Any?, _ range: ClosedRange<Double>) -> Double? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, range.contains(n.doubleValue) else { return nil }
        return n.doubleValue
    }
    func int(_ raw: Any?, _ range: ClosedRange<Double>) -> Int? {
        guard let v = n(raw, range), v.rounded() == v else { return nil }; return Int(v)
    }
    func bool(_ raw: Any?) -> Bool? {
        guard let v = raw as? NSNumber, CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }; return v.boolValue
    }
    func pair(_ raw: Any?, _ range: ClosedRange<Double>) -> [Double]? {
        guard let a = raw as? [Any], a.count == 2, let x = n(a[0], range), let y = n(a[1], range) else { return nil }; return [x, y]
    }
    func path(_ raw: Any?) -> String? {
        guard let p = raw as? String, p.utf8.count <= 4096, p.hasPrefix("/"), !p.contains("\0") else { return nil }; return p
    }
    guard Set(data.keys).subtracting(["perch", "perchSheet", "lines"]) == ["hand", "nonce", "seq", "id", "sheet", "extra", "cell", "table"],
        let seq = int(data["seq"], 0...9007199254740991), let id = data["id"] as? String,
        id.range(of: "^[a-z0-9-]{1,48}$", options: .regularExpression) != nil,
        let sheet = path(data["sheet"]), data["extra"] is NSNull || path(data["extra"]) != nil,
        let cell = pair(data["cell"], 64...512), cell.allSatisfy({ $0.rounded() == $0 }),
        cell[0] <= spriteCellCap.width, cell[1] <= spriteCellCap.height,
        let raw = data["table"] as? [String: Any], raw["idle"] != nil, raw.count <= 19 + 16 * spriteDirectional.count else { return nil }
    var table: [String: SpriteEntry] = [:]
    for (key, value) in raw {
        let parts = key.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 1 && spriteStates.contains(key) || parts.count == 2 && spriteDirectional.contains(String(parts[0]))
            && Int(parts[1]).map({ (0...15).contains($0) && String($0) == parts[1] }) == true,
            let v = value as? [String: Any] else { return nil }
        let required: Set<String> = ["sheet", "row", "frames", "ms", "loop", "flip", "hotspot"]
        guard required.isSubset(of: Set(v.keys)), Set(v.keys).subtracting(required).isSubset(of: ["size", "scale", "then"]),
            let s = v["sheet"] as? String, ["sheet", "extra"].contains(s), s != "extra" || path(data["extra"]) != nil,
            let row = int(v["row"], 0...63), let loop = bool(v["loop"]), let flip = bool(v["flip"]),
            let hotspot = pair(v["hotspot"], -1024...1024),
            (-cell[0]...2 * cell[0]).contains(hotspot[0]), (-cell[1]...2 * cell[1]).contains(hotspot[1]),
            v["scale"] == nil || n(v["scale"], 0.25...2) != nil,
            v["then"] == nil || (v["then"] as? String).map(spriteStates.contains) == true else { return nil }
        let columns: [Int]
        if let count = int(v["frames"], 1...8) { columns = Array(0..<count) }
        else if let a = v["frames"] as? [Any], (1...16).contains(a.count) {
            columns = a.compactMap { int($0, 0...7) }; guard columns.count == a.count else { return nil }
        } else { return nil }
        let durations = (v["ms"] as? [Any]) ?? Array(repeating: v["ms"] as Any, count: columns.count)
        let ms = durations.compactMap { n($0, (loop ? 40.0 : 20.0)...2000) }
        guard ms.count == columns.count, durations.count == columns.count, ms.reduce(0, +) <= 8000 else { return nil }
        var size: CGSize?
        if v["size"] != nil {
            guard let xy = pair(v["size"], 1...Double(spriteSheetCap.height)), xy.allSatisfy({ $0.rounded() == $0 }),
                xy[0] == cell[0] * 8, xy[0] <= Double(spriteSheetCap.width), xy[1].truncatingRemainder(dividingBy: cell[1]) == 0,
                Double(row + 1) * cell[1] <= xy[1] else { return nil }
            size = CGSize(width: xy[0], height: xy[1])
        }
        table[key] = SpriteEntry(sheet: s, row: row, columns: columns, ms: ms, loop: loop, flip: flip,
            hotspot: CGPoint(x: hotspot[0], y: hotspot[1]), size: size, scale: n(v["scale"], 0.25...2) ?? 1, then: v["then"] as? String)
    }
    guard let extras = perchFrameExtras(data, cell: CGSize(width: cell[0], height: cell[1]), extra: path(data["extra"]) != nil) else { return nil }
    return SpriteFrame(seq: seq, id: id, sheet: sheet, extra: path(data["extra"]), cell: CGSize(width: cell[0], height: cell[1]), table: table,
        perch: extras.table, perchSheet: extras.sheet, lines: extras.lines)
}
enum SpriteLoadError: String, Error { case path, permissions, size, type, decode, alpha, pixels, changed, timeout, child, sandbox, cancelled }
func spriteWarning(_ message: String) { FileHandle.standardError.write(Data(("sleight sprite: " + message + "\n").utf8)) }
// A sheet's format and size from its first bytes, without decoding: PNG's IHDR, or WebP's VP8X, VP8L or VP8 header. An
// animated WebP is refused here; the child refuses an APNG (two images).
func spriteSheetHeader(_ b: [UInt8]) -> (format: String, width: Int, height: Int)? {
    func be32(_ i: Int) -> Int { Int(b[i]) << 24 | Int(b[i + 1]) << 16 | Int(b[i + 2]) << 8 | Int(b[i + 3]) }
    func le(_ i: Int, _ count: Int) -> Int { (0..<count).reduce(0) { $0 | Int(b[i + $1]) << (8 * $1) } }
    func ascii(_ range: Range<Int>) -> String { String(decoding: b[range], as: UTF8.self) }
    if b.count >= 24, b.prefix(8) == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(8) == 13, ascii(12..<16) == "IHDR" {
        return ("png", be32(16), be32(20))
    }
    guard b.count >= 30, ascii(0..<4) == "RIFF", ascii(8..<12) == "WEBP" else { return nil }
    switch ascii(12..<16) {
    case "VP8X": return b[20] & 0x02 != 0 ? nil : ("webp", le(24, 3) + 1, le(27, 3) + 1)
    case "VP8L":
        guard b[20] == 0x2f else { return nil }
        let bits = le(21, 4); return ("webp", (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    case "VP8 ":
        guard b[23] == 0x9d, b[24] == 0x01, b[25] == 0x2a else { return nil }
        return ("webp", le(26, 2) & 0x3fff, le(28, 2) & 0x3fff)
    default: return nil
    }
}
// Live decode children, so a host that exits mid-load (EOF, exit(65), SIGTERM, SIGHUP) kills them instead of leaving
// them to launchd. Writes go under the lock; the exit paths only read the slots, which is safe in a signal handler.
// Loads run one at a time, plus --check-character, so 8 slots is ample; a ninth child is killed at once.
let spriteLiveLock = NSLock(), spriteLiveSlots: UnsafeMutablePointer<pid_t> = {
    let slots = UnsafeMutablePointer<pid_t>.allocate(capacity: 8); slots.initialize(repeating: 0, count: 8); return slots
}()
func spriteKillLive() { for i in 0..<8 where spriteLiveSlots[i] > 0 { kill(spriteLiveSlots[i], SIGKILL) } }
let spriteReaper: Void = {
    atexit { spriteKillLive() }
    for signal in [SIGTERM, SIGHUP] {
        var current = sigaction(); sigaction(signal, nil, &current)
        // Only where nothing else handles the signal: kill the children, then die of it as before.
        guard current.__sigaction_u.__sa_handler == nil || unsafeBitCast(current.__sigaction_u.__sa_handler, to: Int.self) == 0 else { continue }
        Darwin.signal(signal) { received in spriteKillLive(); Darwin.signal(received, SIG_DFL); raise(received) }
    }
}()
func spriteTrack(_ pid: pid_t) -> Bool {
    _ = spriteReaper
    spriteLiveLock.lock(); defer { spriteLiveLock.unlock() }
    guard let i = (0..<8).first(where: { spriteLiveSlots[$0] == 0 }) else { return false }
    spriteLiveSlots[i] = pid; return true
}
func spriteUntrack(_ pid: pid_t) {
    spriteLiveLock.lock(); defer { spriteLiveLock.unlock() }
    for i in 0..<8 where spriteLiveSlots[i] == pid { spriteLiveSlots[i] = 0 }
}
// Runs `--decode-sheet` on the open file and reads exactly w*h*4 bytes within 2 s. The child gets the file as stdin, a pipe
// as stdout and /dev/null as stderr; POSIX_SPAWN_CLOEXEC_DEFAULT keeps every other descriptor (the consent channel's fds 3
// and 4 among them) out of it. The returned buffer is malloc'd; the caller owns it.
func spriteDecodeInChild(fd: Int32, width: Int, height: Int, format: String, cancelled: () -> Bool = { false }) throws -> UnsafeMutableRawPointer {
    guard let executable = Bundle.main.executablePath else { throw SpriteLoadError.child }
    var pipeEnds: [Int32] = [0, 0]
    guard pipe(&pipeEnds) == 0 else { throw SpriteLoadError.child }
    defer { close(pipeEnds[0]) }
    var actions: posix_spawn_file_actions_t? = nil, attributes: posix_spawnattr_t? = nil
    posix_spawn_file_actions_init(&actions); posix_spawnattr_init(&attributes)
    defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
    posix_spawn_file_actions_adddup2(&actions, fd, 0)
    posix_spawn_file_actions_adddup2(&actions, pipeEnds[1], 1)
    posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
    // The child starts with no blocked signals and default actions, whatever the loader thread had, so its RLIMIT_CPU
    // SIGXCPU fires (it inherited a mask that blocked it, measured by the review).
    var noSignals = sigset_t(), allSignals = sigset_t(); sigemptyset(&noSignals); sigfillset(&allSignals)
    posix_spawnattr_setsigmask(&attributes, &noSignals); posix_spawnattr_setsigdefault(&attributes, &allSignals)
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF))
    let argv = [executable, "--decode-sheet", String(width), String(height), format].map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    var pid: pid_t = 0
    let spawned = posix_spawn(&pid, executable, &actions, &attributes, argv, environ)
    close(pipeEnds[1])
    guard spawned == 0 else { throw SpriteLoadError.child }
    guard spriteTrack(pid), let buffer = malloc(width * height * 4) else {
        kill(pid, SIGKILL); var s: Int32 = 0; while waitpid(pid, &s, 0) < 0 && errno == EINTR {}; spriteUntrack(pid); throw SpriteLoadError.child
    }
    // The 2 s deadline is the real bound on the child. Tests may lengthen it (to see the CPU limit act on its own).
    let env = ProcessInfo.processInfo.environment
    let seconds = env["SLEIGHT_CURSOR_TEST"] == "1" ? env["SLEIGHT_CURSOR_DECODE_DEADLINE"].flatMap(Double.init).map { min(max($0, 0.1), 30) } ?? 2 : 2
    let total = width * height * 4, deadline = Date().addingTimeInterval(seconds)
    var got = 0, extra = false, timedOut = false, stopped = false
    var poller = pollfd(fd: pipeEnds[0], events: Int16(POLLIN), revents: 0)
    reading: while true {
        // A newer character frame cancels this load; polls of at most 50 ms notice it.
        if cancelled() { stopped = true; break }
        let left = Int32(max(0, deadline.timeIntervalSinceNow * 1000))
        guard left > 0 else { timedOut = true; break }
        poller.revents = 0
        let ready = poll(&poller, 1, min(left, 50))
        if ready < 0 { if errno == EINTR { continue }; break }
        if ready == 0 { continue }
        if got < total {
            let n = read(pipeEnds[0], buffer + got, min(total - got, 1 << 20))
            if n <= 0 { if n < 0 && errno == EINTR { continue }; break }
            got += n
        } else {
            // Exactly w*h*4: anything past it is a fault, and EOF ends the read.
            var byte: UInt8 = 0
            let n = read(pipeEnds[0], &byte, 1)
            if n < 0 && errno == EINTR { continue }
            extra = n > 0; break reading
        }
    }
    // The reap is bounded too: a child that closes stdout and then doesn't exit gets 0.5 s, then SIGKILL.
    var status: Int32 = 0, reaped = false
    if !(timedOut || extra || stopped) {
        for _ in 0..<50 {
            let r = waitpid(pid, &status, WNOHANG)
            if r == pid { reaped = true; break }
            if r < 0 && errno != EINTR { break }
            usleep(10_000)
        }
    }
    if !reaped { kill(pid, SIGKILL); while waitpid(pid, &status, 0) < 0 && errno == EINTR {} }
    // After the reap, never at function end, so a reused pid is never signalled.
    spriteUntrack(pid)
    let exited = reaped && status & 0x7f == 0, code = (status >> 8) & 0xff
    guard !stopped else { free(buffer); throw SpriteLoadError.cancelled }
    guard !timedOut else { free(buffer); throw SpriteLoadError.timeout }
    guard got == total, !extra, exited, code == 0 else {
        free(buffer)
        if exited, let reason = [65: SpriteLoadError.type, 66: .size, 67: .alpha, 68: .decode, 69: .sandbox][Int(code)] { throw reason }
        throw SpriteLoadError.child
    }
    return buffer
}
struct SpriteCharacter {
    let frame: SpriteFrame, images: [String: CGImage]
    struct Result { let character: SpriteCharacter?, reason: String?, warnings: [String] }
    static func root() -> String {
        let env = ProcessInfo.processInfo.environment
        if env["SLEIGHT_CURSOR_TEST"] == "1", let p = env["SLEIGHT_CURSOR_CHARACTERS_ROOT"], p.hasPrefix("/private/tmp/") { return p }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/sleight/characters").path
    }
    // Every check, with no output. The extra sheet loads only when a table entry uses it.
    static func check(_ frame: SpriteFrame, cancelled: @escaping () -> Bool = { false }) -> Result {
        do {
            var images: [String: CGImage] = [:], warnings = Set<String>()
            let used = Set(frame.allEntries.map { $0.sheet })
            for (key, path) in [("sheet", Optional(frame.sheet)), ("extra", frame.extra), ("perch", frame.perchSheet)] {
                guard let path = path, used.contains(key) else { continue }
                guard !cancelled() else { throw SpriteLoadError.cancelled }
                let loaded = try decode(path, key: key, frame: frame, cancelled: cancelled)
                images[key] = loaded.0; warnings.formUnion(loaded.1)
            }
            return Result(character: SpriteCharacter(frame: frame, images: images), reason: nil, warnings: warnings.sorted())
        } catch { return Result(character: nil, reason: (error as? SpriteLoadError)?.rawValue ?? "decode", warnings: []) }
    }
    // check plus one stderr line (a trace for the dump and direct runs; the relay reads the stdout event instead).
    static func load(_ frame: SpriteFrame, cancelled: @escaping () -> Bool = { false }) -> Result {
        let result = check(frame, cancelled: cancelled)
        if result.reason == SpriteLoadError.cancelled.rawValue { return result }
        if let reason = result.reason { spriteWarning("character refused (\(reason)); using ring") }
        else if !result.warnings.isEmpty { spriteWarning(result.warnings.joined(separator: ", ") + " (warning)") }
        return result
    }
    static func decode(_ path: String, key: String, frame: SpriteFrame, cancelled: @escaping () -> Bool = { false }) throws -> (CGImage, Set<String>) {
        let root = root(), expectedParent = root + "/" + frame.id
        func canonical(_ path: String) -> Bool {
            var bytes = [CChar](repeating: 0, count: Int(PATH_MAX))
            return realpath(path, &bytes) != nil && String(cString: bytes) == path
        }
        guard canonical(path), canonical(root),
            (path as NSString).deletingLastPathComponent == expectedParent else { throw SpriteLoadError.path }
        // Check every directory within the private character bank, not just the leaf filename.
        for directory in [root, expectedParent] {
            var st = stat()
            guard lstat(directory, &st) == 0, st.st_mode & S_IFMT == S_IFDIR, st.st_uid == getuid(), st.st_mode & 0o7022 == 0 else { throw SpriteLoadError.permissions }
        }
        var before = stat()
        guard lstat(path, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_uid == getuid(),
            before.st_mode & 0o7777 == 0o600, before.st_nlink == 1 else { throw SpriteLoadError.permissions }
        guard before.st_size > 0, before.st_size <= 8 * 1024 * 1024 else { throw SpriteLoadError.size }
        // O_NOFOLLOW_ANY (which can't be combined with O_NOFOLLOW: EINVAL) refuses a symlink in any component, so a directory swapped after the realpath check can't redirect
        // the open; F_GETPATH confirms the descriptor is the checked path.
        let fd = open(path, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw SpriteLoadError.path }; defer { close(fd) }
        var opened = stat(), name = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(fd, F_GETPATH, &name) == 0, String(cString: name) == path else { throw SpriteLoadError.path }
        guard fstat(fd, &opened) == 0, opened.st_dev == before.st_dev, opened.st_ino == before.st_ino,
            opened.st_mode == before.st_mode, opened.st_uid == before.st_uid, opened.st_size == before.st_size else { throw SpriteLoadError.changed }
        var head = [UInt8](repeating: 0, count: 64)
        let headCount = pread(fd, &head, 64, 0)
        guard headCount > 0, let header = spriteSheetHeader(Array(head.prefix(headCount))) else { throw SpriteLoadError.type }
        guard (path as NSString).pathExtension.lowercased() == header.format else { throw SpriteLoadError.type }
        let w = header.width, h = header.height
        guard w > 0, h > 0, w <= spriteSheetCap.width, h <= spriteSheetCap.height, w == Int(frame.cell.width) * 8,
            h % Int(frame.cell.height) == 0 else { throw SpriteLoadError.size }
        let entries = frame.allEntries.filter { $0.sheet == key }
        guard entries.allSatisfy({ ($0.row + 1) * Int(frame.cell.height) <= h && ($0.size == nil || $0.size == CGSize(width: w, height: h)) }) else { throw SpriteLoadError.size }
        let buffer = try spriteDecodeInChild(fd: fd, width: w, height: h, format: header.format, cancelled: cancelled)
        // The image wraps the child's bytes without a copy and frees them when it goes (replacement, style change or exit).
        guard let provider = CGDataProvider(dataInfo: nil, data: buffer, size: w * h * 4, releaseData: { _, data, _ in free(UnsafeMutableRawPointer(mutating: data)) }) else {
            free(buffer); throw SpriteLoadError.decode
        }
        let pixels = buffer.assumingMemoryBound(to: UInt8.self)
        var used = Set<Int>(), rows = Set<Int>(), warnings = Set<String>()
        for entry in entries { rows.insert(entry.row); for col in entry.columns { used.insert(entry.row * 8 + col) } }
        let cw = Int(frame.cell.width), ch = Int(frame.cell.height)
        for row in rows {
            for col in 0..<8 {
                var visible = 0, opaque = 0, green = 0
                for y in row * ch..<(row + 1) * ch {
                    for x in col * cw..<(col + 1) * cw {
                        let p = (y * w + x) * 4, a = pixels[p + 3]
                        if a > 0 { visible += 1 }
                        if a == 255 { opaque += 1 }
                        if a > 0, pixels[p + 1] > 100, Int(pixels[p + 1]) > Int(pixels[p]) * 2, Int(pixels[p + 1]) > Int(pixels[p + 2]) * 2 { green += 1 }
                    }
                }
                if used.contains(row * 8 + col) {
                    guard visible >= 50, Double(opaque) < Double(cw * ch) * 0.95 else { throw SpriteLoadError.pixels }
                    if green > 0 { warnings.insert("chroma fringe") }
                } else if visible > 0, !(row == 0 && col == 6) { // Codex v2 permits its optional neutral look pose here.
                    // The host sees only resolved columns, not each row's declared frame count, so this is a warning.
                    warnings.insert("ink in an unused cell")
                }
            }
        }
        var after = stat()
        guard fstat(fd, &after) == 0, after.st_size == opened.st_size,
            after.st_mtimespec.tv_sec == opened.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == opened.st_mtimespec.tv_nsec,
            after.st_ctimespec.tv_sec == opened.st_ctimespec.tv_sec, after.st_ctimespec.tv_nsec == opened.st_ctimespec.tv_nsec else { throw SpriteLoadError.changed }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
            let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { throw SpriteLoadError.decode }
        return (image, warnings)
    }
}
// Loads characters off the caller's thread, one at a time. Each start supersedes the load before it (its child is killed
// within 50 ms and its result dropped), and cancel() supersedes without a new load. done runs on the loader's queue, only
// for the current load; callers recheck isCurrent on their own thread before using the result.
final class SpriteLoader {
    private let lock = NSLock(), queue = DispatchQueue(label: "sleight.sprite.load", qos: .userInitiated)
    private var generation = 0
    @discardableResult func start(_ frame: SpriteFrame, done: @escaping (Int, SpriteCharacter.Result) -> Void) -> Int {
        lock.lock(); generation += 1; let mine = generation; lock.unlock()
        queue.async {
            guard self.isCurrent(mine) else { return }
            let result = SpriteCharacter.load(frame, cancelled: { !self.isCurrent(mine) })
            if self.isCurrent(mine) { done(mine, result) }
        }
        return mine
    }
    func cancel() { lock.lock(); generation += 1; lock.unlock() }
    func isCurrent(_ generation: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return generation == self.generation }
}
struct SpritePose {
    var time: Double, state: String, entry: SpriteEntry, column: Int, direction: Int
}
struct SpriteTrack { let keyPath: String, values: [Any], keyTimes: [Double], discrete: Bool }
struct SpritePlan {
    let poses: [SpritePose], character: SpriteCharacter, duration: Double, reduced: Bool, clip: CGRect
    // The cell, inset by half a texel so linear filtering never samples a neighbor cell.
    func rect(_ pose: SpritePose) -> CGRect {
        let image = character.images[pose.entry.sheet]!, cell = character.frame.cell
        let w = Double(image.width), h = Double(image.height)
        return CGRect(x: (Double(pose.column) * cell.width + 0.5) / w, y: (Double(pose.entry.row) * cell.height + 0.5) / h,
            width: (cell.width - 1) / w, height: (cell.height - 1) / h)
    }
    func origin(_ at: CGPoint, _ entry: SpriteEntry) -> CGPoint {
        // The cell's box trails the ring's point by 18 pt and never covers it, so the hotspot does not move it (PLAN call 1).
        let w = character.frame.cell.width * entry.scale, h = character.frame.cell.height * entry.scale
        let right = at.x + 18 + w <= clip.maxX, below = at.y + 18 + h <= clip.maxY
        return CGPoint(x: right ? at.x + 18 : at.x - 18 - w, y: below ? at.y + 18 : at.y - 18 - h)
    }
    func bounds(_ ring: RingPlan) -> CGRect {
        var out = CGRect.null
        for (_, p) in ring.positions + [(0, ring.at)] {
            for pose in poses {
                out = out.union(CGRect(origin: origin(p, pose.entry), size: CGSize(width: character.frame.cell.width * pose.entry.scale, height: character.frame.cell.height * pose.entry.scale)))
            }
        }
        return out
    }
    var samples: [SpritePose] {
        guard let last = poses.last else { return [] }
        return poses + [SpritePose(time: duration, state: last.state, entry: last.entry, column: last.column, direction: last.direction)]
    }
    // Exactly what installSprite hands Core Animation: key times from 0 to 1, never decreasing. The position track also samples
    // just before each pose, with the entry before it, so a flip or scale change jumps instead of sliding.
    func tracks(_ ring: RingPlan, frame: CGRect) -> [SpriteTrack] {
        let length = max(duration, 0.001), s = samples
        func unit(_ t: Double) -> Double { min(max(t / length, 0), 1) }
        let times = s.map { unit($0.time) }
        var tracks = [
            SpriteTrack(keyPath: "contents", values: s.map { character.images[$0.entry.sheet]! }, keyTimes: times, discrete: true),
            SpriteTrack(keyPath: "contentsRect", values: s.map { NSValue(rect: rect($0)) }, keyTimes: times, discrete: true),
            SpriteTrack(keyPath: "transform", values: s.map { p in
                NSValue(caTransform3D: CATransform3DMakeScale(p.entry.scale * (p.entry.flip ? -1 : 1), p.entry.scale, 1))
            }, keyTimes: times, discrete: true),
        ]
        let before = poses.dropFirst().map { $0.time - 1e-4 }.filter { $0 > 0 }
        let moments = Set(ring.positions.map { $0.0 } + s.map { $0.time } + before + [0, duration]).filter { $0 >= 0 && $0 <= duration }.sorted()
        let points = moments.map { t -> CGPoint in
            let entry = s.last(where: { $0.time <= t })?.entry ?? poses[0].entry
            var p = origin(ring.position(at: t), entry)
            if entry.flip { p.x += character.frame.cell.width * entry.scale }
            return CGPoint(x: p.x - frame.minX, y: p.y - frame.minY)
        }
        tracks.append(SpriteTrack(keyPath: "position", values: points.map { NSValue(point: $0) }, keyTimes: moments.map(unit), discrete: reduced))
        return tracks
    }
    func json(_ ring: RingPlan) -> [String: Any] {
        let tracks = tracks(ring, frame: .zero)
        return ["duration": duration, "reduced": reduced, "layers": 1, "calculationMode": "discrete", "keyPath": "contentsRect",
            "values": samples.map { p -> [Double] in let r = rect(p); return [r.minX, r.minY, r.width, r.height] },
            "times": tracks[1].keyTimes,
            "tracks": tracks.map { ["keyPath": $0.keyPath, "keyTimes": $0.keyTimes, "values": $0.values.count, "discrete": $0.discrete] as [String: Any] },
            "positions": (tracks[3].values as! [NSValue]).map { [$0.pointValue.x, $0.pointValue.y] },
            "placements": poses.map { p -> [Double] in
                let origin = origin(ring.position(at: p.time), p.entry)
                return [origin.x, origin.y, character.frame.cell.width * p.entry.scale, character.frame.cell.height * p.entry.scale]
            },
            "poses": poses.map { p -> [String: Any] in
                let r = rect(p)
                return ["time": p.time, "state": p.state, "row": p.entry.row, "column": p.column, "sheet": p.entry.sheet,
                    "direction": p.direction, "flip": p.entry.flip, "rect": [r.minX, r.minY, r.width, r.height]]
            }]
    }
    static func make(_ ring: RingPlan, character: SpriteCharacter, reduced: Bool, secure: Bool, clip: CGRect) -> SpritePlan {
        let f = character.frame
        // Clockwise from up in screen points (y grows down). -1 means no movement, which uses the state's base entry.
        func direction(_ from: CGPoint, _ to: CGPoint) -> Int {
            guard hypot(to.x - from.x, to.y - from.y) >= 1 else { return -1 }
            let heading = atan2(to.x - from.x, from.y - to.y) * 180 / .pi
            return (Int((heading / 22.5).rounded()) + 16) % 16
        }
        func far(_ from: CGPoint, _ to: CGPoint) -> Bool { hypot(to.x - from.x, to.y - from.y) > 60 }
        let first = ring.positions.first?.1 ?? ring.at
        let d = direction(first, ring.at), glideFar = far(first, ring.at)
        let names = ["double": "double-click", "right": "right-click", "waiting": "waiting-approval", "done": "success", "handback": "handoff", "scroll": "scroll-down"]
        let state = secure && ["type", "key"].contains(ring.state) ? "idle" : names[ring.state] ?? ring.state
        var stages: [(Double, String, Int, Bool)] = [(0, state, d, false)]
        if ring.glideEnd > 0, !reduced { stages = [(0, "move", d, glideFar), (ring.glideEnd, state, d, false)] }
        if ring.state == "drag" {
            stages = stages.filter { $0.1 == "move" }
            for (phase, s) in [("grab", "drag-grab"), ("carry", "drag-carry"), ("drop", "drag-drop")] {
                if let span = ring.phases[phase] {
                    let from = ring.position(at: span[0]), to = ring.position(at: span[0] + span[1])
                    stages.append((span[0], s, direction(from, to), far(from, to)))
                }
            }
            if stages.isEmpty { stages = [(0, "drag-drop", d, false)] }
        }
        stages.sort { $0.0 < $1.0 }
        func entry(_ name: String, _ dir: Int, _ far: Bool) -> SpriteEntry {
            (far ? f.table["\(name)-far@\(dir)"] : nil) ?? f.table["\(name)@\(dir)"] ?? f.table[name] ?? f.table["idle"]!
        }
        var poses: [SpritePose] = []
        for (i, stage) in stages.enumerated() {
            let (start, base, dir, isFar) = stage
            var name = base, current = entry(base, dir, isFar), hopped = false
            let end = i + 1 < stages.count ? stages[i + 1].0 : ring.total
            var time = start, index = 0
            while true {
                poses.append(SpritePose(time: time, state: name, entry: current, column: current.columns[index], direction: dir))
                if reduced { break }
                time += current.ms[index] / 1000; index += 1
                if index == current.columns.count {
                    index = 0
                    if !current.loop {
                        // A one-shot with a follow-up (handoff, then idle) continues once; otherwise it holds its last cell.
                        guard let next = current.then, !hopped else { break }
                        hopped = true; name = next; current = entry(next, -1, false)
                    }
                }
                if time >= end - 1e-9 { break }
                if time >= start + 4.8 - 1e-9 {
                    // Loops park on their first cell at 4.8 s, as the ring parks, not on whichever cell the cut reaches.
                    if current.loop, let last = poses.last, last.column != current.columns[0] || last.entry.row != current.row {
                        poses.append(SpritePose(time: start + 4.8, state: name, entry: current, column: current.columns[0], direction: dir))
                    }
                    break
                }
            }
        }
        // Every discrete track starts at key time 0: before the first stage (a drag's grab starts after the entrance), the
        // first pose shows.
        if let head = poses.first, head.time > 0 { poses.insert(SpritePose(time: 0, state: head.state, entry: head.entry, column: head.column, direction: head.direction), at: 0) }
        poses = poses.filter { $0.time <= ring.total + 1e-9 }
        return SpritePlan(poses: poses, character: character, duration: ring.total, reduced: reduced, clip: clip)
    }
}
// One sprite layer. contents changes only at state/sheet boundaries; contentsRect steps on the GPU's discrete track.
func installSprite(_ sprite: SpritePlan, ring: RingPlan, root: CALayer, frame: CGRect, begin: Double) {
    guard !sprite.poses.isEmpty else { return }
    let layer = CALayer(), cell = sprite.character.frame.cell
    layer.name = "sprite"
    layer.anchorPoint = .zero; layer.bounds = CGRect(origin: .zero, size: cell)
    // Downscaled art (scale under 1, or 1x art on a 1x display) filters linearly; the half-texel inset keeps neighbors out.
    layer.contentsGravity = .resize; layer.minificationFilter = .linear; layer.magnificationFilter = .nearest
    root.addSublayer(layer)
    for track in sprite.tracks(ring, frame: frame) {
        layer.setValue(track.values.last, forKeyPath: track.keyPath)
        guard track.values.count > 1 else { continue }
        let animation = CAKeyframeAnimation(keyPath: track.keyPath)
        animation.values = track.values; animation.keyTimes = track.keyTimes.map { NSNumber(value: $0) }
        animation.calculationMode = track.discrete ? .discrete : .linear; animation.duration = max(sprite.duration, 0.001)
        animation.beginTime = begin; animation.fillMode = .both; animation.isRemovedOnCompletion = false
        layer.add(animation, forKey: track.keyPath)
    }
    // Opacity shares the ring's entrance, reduced-motion crossfade and terminal dissolve.
    if let spec = ring.layers.first(where: { $0.name == "cursor" }) { layer.opacity = Float(spec.props["opacity"]?.number ?? 1) }
    if let opacity = ring.tracks.first(where: { $0.layer == "cursor" && $0.keyPath == "opacity" }) {
        let a = CAKeyframeAnimation(keyPath: "opacity")
        a.values = opacity.values.map { NSNumber(value: $0.number) }; a.keyTimes = opacity.times.map { NSNumber(value: $0) }
        a.duration = opacity.duration; a.beginTime = begin + opacity.begin; a.fillMode = .both; a.isRemovedOnCompletion = false
        layer.opacity = Float(opacity.values.last?.number ?? 1); layer.add(a, forKey: "opacity")
    }
}
// END SPRITE
// The character's result on the hand channel's stdout, so the relay can say why the ring shows alone.
func writeCharacterResult(_ id: String, _ result: SpriteCharacter.Result) {
    guard let nonce = nonceBook.nonce("hand"), let bytes = try? JSONSerialization.data(withJSONObject: ["hand": "character", "nonce": nonce,
        "id": id, "loaded": result.character != nil, "reason": result.reason as Any? ?? NSNull(), "warnings": result.warnings],
        options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(bytes + Data([10]))
}

// BEGIN SPRITE DECODE CHILD
// `consent-host --decode-sheet W H png|webp`: the only code that hands character art to ImageIO. stdin is the checked file and
// stdout a pipe to the parent. It warms ImageIO's readers on built-in 1x1 images, enters a deny-default sandbox, then reads
// the untrusted bytes, decodes one image at the parent's validated size into sRGB premultiplied RGBA and writes those bytes.
// The named profile kSBXProfilePureComputation is killed by SIGKILL at sandbox_init on macOS 27 (measured 2026-10-26), so
// the child passes the same rule as SBPL. Without the warm-up ImageIO crashes inside the sandbox (SIGSEGV, measured).
// Exit codes: 64 usage, 65 type or count, 66 size, 67 no alpha, 68 decode, 69 limits or sandbox refused.
@_silgen_name("sandbox_init") func spriteSandboxInit(_ profile: UnsafePointer<CChar>, _ flags: UInt64, _ error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32
let spriteWarmImages: [[UInt8]] = [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
     0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00,
     0x00, 0x05, 0x00, 0x01, 0x7a, 0x5e, 0xab, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82],
    [0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
     0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00],
]
func spriteDecodeChild(_ args: [String]) -> Never {
    guard args.count == 3, let w = Int(args[0]), let h = Int(args[1]), (1...spriteSheetCap.width).contains(w), (1...spriteSheetCap.height).contains(h),
        let uti = ["png": "public.png", "webp": "org.webmproject.webp"][args[2]] else { exit(64) }
    let env = ProcessInfo.processInfo.environment
    let fault = env["SLEIGHT_CURSOR_TEST"] == "1" ? env["SLEIGHT_CURSOR_DECODE_FAULT"] : nil
    guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { exit(68) }
    func draw(_ image: CGImage, _ w: Int, _ h: Int) -> CGContext? {
        guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue), context.bytesPerRow == w * 4 else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h)); return context
    }
    for bytes in spriteWarmImages {
        if let source = CGImageSourceCreateWithData(Data(bytes) as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) { _ = draw(image, 1, 1) }
    }
    // Limits before the sandbox, both hard so the child can't raise them: 8 descriptors, and 2 s of CPU. The CPU limit is a
    // second line for a buggy decoder: macOS only sends SIGXCPU, which compromised code can ignore. The parent's 2 s
    // deadline and 0.5 s reap are the real bound. No memory limit: macOS 27 refuses RLIMIT_AS, RLIMIT_DATA and RLIMIT_RSS
    // at any value with EINVAL (measured 2026-10-26).
    for (resource, value) in [(RLIMIT_CPU, rlim_t(2)), (RLIMIT_NOFILE, rlim_t(8))] {
        var limit = rlimit(rlim_cur: value, rlim_max: value)
        guard setrlimit(resource, &limit) == 0 else { exit(69) }
    }
    var error: UnsafeMutablePointer<CChar>? = nil
    guard fault != "nosandbox", spriteSandboxInit("(version 1)(deny default)", 0, &error) == 0 else { exit(69) }
    if fault == "limits" {
        var cpu = rlimit(), files = rlimit(); getrlimit(RLIMIT_CPU, &cpu); getrlimit(RLIMIT_NOFILE, &files)
        let text = "cpu=\(cpu.rlim_cur)/\(cpu.rlim_max) nofile=\(files.rlim_cur)/\(files.rlim_max)\n"
        _ = text.withCString { write(1, $0, strlen($0)) }; exit(0)
    }
    if fault == "slow" { usleep(1_000_000) }
    if fault == "spin" { var n = 0; while true { n &+= 1; if n == Int.min { exit(0) } } }
    var data = Data(), chunk = [UInt8](repeating: 0, count: 1 << 16)
    while true {
        let n = read(0, &chunk, chunk.count)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { break }
        data.append(contentsOf: chunk[0..<n])
        if data.count > 8 * 1024 * 1024 { exit(66) }
    }
    let options = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, options), CGImageSourceGetType(source) as String? == uti,
        CGImageSourceGetCount(source) == 1 else { exit(65) }
    guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
        props[kCGImagePropertyPixelWidth] as? Int == w, props[kCGImagePropertyPixelHeight] as? Int == h else { exit(66) }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, options), image.width == w, image.height == h else { exit(68) }
    guard [.premultipliedFirst, .premultipliedLast, .first, .last].contains(image.alphaInfo) else { exit(67) }
    guard let context = draw(image, w, h), let pixels = context.data else { exit(68) }
    var sent = 0, total = w * h * 4
    // Test faults (with SLEIGHT_CURSOR_TEST=1): die or hang halfway; closehang writes everything, closehang0 nothing, then both
    // close stdout and sleep. slow waits 1 s before reading, spin burns CPU, nosandbox exits 69, limits prints the limits.
    if fault == "die" || fault == "hang" { total /= 2 }
    if fault == "closehang0" { total = 0 }
    while sent < total {
        let n = write(1, pixels + sent, total - sent)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { exit(68) }
        sent += n
    }
    if fault == "die" { kill(getpid(), SIGKILL) }
    if fault == "closehang" || fault == "closehang0" { close(1); while true { pause() } }
    if fault == "hang" { while true { pause() } }
    exit(0)
}
// END SPRITE DECODE CHILD

// BEGIN PERCH
// Perch mode (art direction A2): in sprite style with perch on, the character sits on the target window's top edge instead
// of trailing the ring, and says a short line of its own at a few moments. PerchRuntime is a pure state machine (seats,
// moves, reactions, sleep, the hide rules and the lines' caps), driven by the ring's draws, the host's window-list checks
// and its own timers; the host (PerchHost) and --perch-dump both drive it. A draw installs Core Animation keyframes once and
// a park removes them, so a parked perch runs no animation. Nothing here posts input, activates, takes key or writes stdout.

// The perch table the relay sends: every perch state resolved to art the pack has (character.mjs resolvePerchStates).
let perchTableKeys: Set<String> = ["perch", "perch-peek", "perch-hop", "perch-point-left", "perch-point-right", "sleep", "high-five",
    "perch-wait", "startle", "jumping", "running-right", "running-left", "error", "handoff"]
let perchMoments = ["start", "first-click", "typing", "long-wait", "approval", "error", "done", "handback", "wake"]
struct PerchTable { let anchor: CGPoint, table: [String: SpriteEntry] }
struct PerchLineSet { let lang: String?, lines: [String: [String]] }
extension SpriteFrame {
    // Every entry the decode checks: the trail table and, with perch, the perch table (the third sheet's cells among them).
    var allEntries: [SpriteEntry] { Array(table.values) + (perch.map { Array($0.table.values) } ?? []) }
}
// A perch entry: the trail table's rules, with explicit columns, durations, size and scale, and the perch sheet allowed.
func perchEntry(_ raw: Any?, cell: CGSize, sheets: Set<String>) -> SpriteEntry? {
    func n(_ raw: Any?, _ range: ClosedRange<Double>) -> Double? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, range.contains(n.doubleValue) else { return nil }
        return n.doubleValue
    }
    func int(_ raw: Any?, _ range: ClosedRange<Double>) -> Int? { guard let v = n(raw, range), v.rounded() == v else { return nil }; return Int(v) }
    func bool(_ raw: Any?) -> Bool? { guard let v = raw as? NSNumber, CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }; return v.boolValue }
    func pair(_ raw: Any?, _ range: ClosedRange<Double>) -> [Double]? {
        guard let a = raw as? [Any], a.count == 2, let x = n(a[0], range), let y = n(a[1], range) else { return nil }; return [x, y]
    }
    guard let v = raw as? [String: Any], Set(v.keys) == ["sheet", "row", "frames", "ms", "loop", "flip", "hotspot", "size", "scale"],
        let sheet = v["sheet"] as? String, sheets.contains(sheet), let row = int(v["row"], 0...63), let loop = bool(v["loop"]), let flip = bool(v["flip"]),
        let hotspot = pair(v["hotspot"], -1024...1024), (-cell.width...2 * cell.width).contains(hotspot[0]), (-cell.height...2 * cell.height).contains(hotspot[1]),
        let scale = n(v["scale"], 0.25...2), let raw = v["frames"] as? [Any], (1...16).contains(raw.count), let durations = v["ms"] as? [Any],
        let size = pair(v["size"], 1...Double(spriteSheetCap.height)), size.allSatisfy({ $0.rounded() == $0 }), size[0] == Double(cell.width) * 8,
        size[0] <= Double(spriteSheetCap.width), size[1].truncatingRemainder(dividingBy: Double(cell.height)) == 0, Double(row + 1) * Double(cell.height) <= size[1] else { return nil }
    let columns = raw.compactMap { int($0, 0...7) }, ms = durations.compactMap { n($0, (loop ? 40.0 : 20.0)...2000) }
    guard columns.count == raw.count, ms.count == columns.count, durations.count == columns.count, ms.reduce(0, +) <= 8000 else { return nil }
    return SpriteEntry(sheet: sheet, row: row, columns: columns, ms: ms, loop: loop, flip: flip, hotspot: CGPoint(x: hotspot[0], y: hotspot[1]),
        size: CGSize(width: size[0], height: size[1]), scale: scale, then: nil)
}
// A2's line rule, the same as character.mjs characterLineValid on trimmed text. The host draws lines and nothing else.
func perchLineValid(_ s: String) -> Bool {
    guard (1...60).contains(s.count), s.unicodeScalars.count <= 240, s.trimmingCharacters(in: .whitespaces) == s else { return false }
    for scalar in s.unicodeScalars {
        let c = scalar.properties.generalCategory
        if [.control, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned].contains(c) { return false }
        if c == .format && scalar.value != 0x200D { return false }
        if "<>{}`*_[]|".unicodeScalars.contains(scalar) { return false }
    }
    let lower = s.lowercased()
    if lower.contains("://") || lower.contains("www.") || lower.contains("~/") || s.range(of: "/\\p{L}", options: .regularExpression) != nil { return false }
    return lower.range(of: "\\b(system|assistant|ignore|tool)\\b", options: .regularExpression) == nil
}
func perchLineSet(_ raw: Any?) -> PerchLineSet? {
    guard let v = raw as? [String: Any], Set(v.keys).isSubset(of: Set(perchMoments + ["lang"])),
        let bytes = try? JSONSerialization.data(withJSONObject: v), bytes.count <= 4096 else { return nil }
    var lang: String?
    if let raw = v["lang"] {
        guard let s = raw as? String, s.count <= 16, s.range(of: "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$", options: .regularExpression) != nil else { return nil }
        lang = s
    }
    var lines: [String: [String]] = [:]
    for moment in perchMoments {
        guard let raw = v[moment] else { continue }
        guard let list = raw as? [Any], (1...16).contains(list.count) else { return nil }
        let texts = list.compactMap { $0 as? String }.filter(perchLineValid)
        guard texts.count == list.count else { return nil }
        lines[moment] = texts
    }
    return PerchLineSet(lang: lang, lines: lines)
}
// The character frame's optional perch keys. nil for a malformed value (the frame fails as a whole).
func perchFrameExtras(_ data: [String: Any], cell: CGSize, extra: Bool) -> (table: PerchTable?, sheet: String?, lines: PerchLineSet?)? {
    var sheet: String?
    if let raw = data["perchSheet"], !(raw is NSNull) {
        guard let p = raw as? String, p.utf8.count <= 4096, p.hasPrefix("/"), !p.contains("\0") else { return nil }
        sheet = p
    }
    var table: PerchTable?
    if let raw = data["perch"] {
        guard let v = raw as? [String: Any], Set(v.keys) == ["anchor", "table"], let a = v["anchor"] as? [Any], a.count == 2,
            let x = a[0] as? NSNumber, let y = a[1] as? NSNumber, CFGetTypeID(x) != CFBooleanGetTypeID(), CFGetTypeID(y) != CFBooleanGetTypeID(),
            (-Double(cell.width)...2 * Double(cell.width)).contains(x.doubleValue), (-Double(cell.height)...2 * Double(cell.height)).contains(y.doubleValue),
            let t = v["table"] as? [String: Any], Set(t.keys) == perchTableKeys else { return nil }
        let sheets: Set<String> = Set(["sheet"] + (extra ? ["extra"] : []) + (sheet != nil ? ["perch"] : []))
        var entries: [String: SpriteEntry] = [:]
        for (key, value) in t { guard let e = perchEntry(value, cell: cell, sheets: sheets) else { return nil }; entries[key] = e }
        table = PerchTable(anchor: CGPoint(x: x.doubleValue, y: y.doubleValue), table: entries)
    } else if sheet != nil { return nil }
    var lines: PerchLineSet?
    if let raw = data["lines"] { guard let set = perchLineSet(raw) else { return nil }; lines = set }
    return (table, sheet, lines)
}

// Geometry. All in global top-left points. The box is the cell at the pack's scale; the anchor is the seat point inside it.
struct PerchMetrics { let size: CGSize, anchor: CGPoint, scale: Double }
func perchMetrics(_ frame: SpriteFrame) -> PerchMetrics? {
    guard let perch = frame.perch, let e = perch.table["perch"] else { return nil }
    return PerchMetrics(size: CGSize(width: frame.cell.width * e.scale, height: frame.cell.height * e.scale),
        anchor: CGPoint(x: perch.anchor.x * e.scale, y: perch.anchor.y * e.scale), scale: e.scale)
}
// The target window, the windows in front of it (the window list's order), its display and the display's usable top.
struct PerchWorld { var window: CGRect, above: [CGRect], display: CGRect, top: Double, fullScreen: Bool }
struct PerchSeat: Equatable {
    var pid: Int32, window: UInt32, x: Double, edge: Double, peek: Bool, rise: Double, frame: CGRect, display: CGRect, top: Double
}
enum PerchPlace: Equatable { case seat(PerchSeat), hide(String) }
// The edge's uncovered spans: every higher window that crosses the edge line cuts it.
func perchSpans(_ window: CGRect, above: [CGRect]) -> [(Double, Double)] {
    var spans: [(Double, Double)] = [(Double(window.minX), Double(window.maxX))]
    let edge = Double(window.minY)
    for r in above where Double(r.minY) <= edge && Double(r.maxY) > edge {
        spans = spans.flatMap { s -> [(Double, Double)] in
            guard Double(r.maxX) > s.0, Double(r.minX) < s.1 else { return [s] }
            return [(s.0, min(s.1, Double(r.minX))), (max(s.0, Double(r.maxX)), s.1)].filter { $0.1 - $0.0 > 0 }
        }
    }
    return spans
}
// A2's seat: on the edge nearest the target's x, clear of the traffic lights and toolbar controls, away from a target just
// under the edge, on the uncovered span nearest the target, and kept within 60 pt on the same window. Hidden when the
// window is gone, full screen, under 48 pt wide, under 40 pt of headroom or covered along every 96 pt.
func perchPlace(_ world: PerchWorld?, pid: Int32, window: UInt32, target: CGPoint, metrics m: PerchMetrics, previous: PerchSeat?) -> PerchPlace {
    guard let world = world else { return .hide("gone") }
    if world.fullScreen { return .hide("full-screen") }
    let win = world.window, width = Double(win.width), edge = Double(win.minY), tx = Double(target.x), ty = Double(target.y)
    guard width >= 48 else { return .hide("narrow") }
    let headroom = edge - world.top
    guard headroom >= 40 else { return .hide("headroom") }
    let ay = Double(m.anchor.y), peek = width < 96 || headroom < ay
    let rise = peek ? min(48, ay, headroom) : ay
    let need = min(96, width)
    let spans = perchSpans(win, above: world.above).filter { $0.1 - $0.0 >= need - 0.001 }
    guard !spans.isEmpty else { return .hide("covered") }
    func distance(_ s: (Double, Double)) -> Double { tx >= s.0 && tx <= s.1 ? 0 : min(abs(s.0 - tx), abs(s.1 - tx)) }
    let span = spans.min { a, b in distance(a) != distance(b) ? distance(a) < distance(b) : a.1 - a.0 > b.1 - b.0 }!
    let left = Double(m.anchor.x), right = Double(m.size.width) - left, margin = width >= 256 ? 80.0 : 40.0
    var lo = width < 176 ? Double(win.midX) : Double(win.minX) + margin, hi = width < 176 ? Double(win.midX) : Double(win.maxX) - margin
    lo = max(lo, span.0 + left); hi = min(hi, span.1 - right)
    if lo > hi { lo = span.0 + left; hi = span.1 - right }
    if lo > hi { lo = (span.0 + span.1) / 2; hi = lo }
    func clamp(_ v: Double) -> Double { min(max(v, lo), hi) }
    // The dangling legs stay off a target within 56 pt under the edge and 72 pt of the seat.
    func clear(_ x: Double) -> Bool { !(ty >= edge && ty - edge <= 56 && abs(tx - x) < 72 - 0.001) }
    var x = clamp(tx)
    if !clear(x) {
        let toward = tx <= Double(win.midX) ? 1.0 : -1.0
        x = [clamp(tx + toward * 72), clamp(tx - toward * 72)].first(where: clear) ?? x
    }
    if let p = previous, p.window == window, p.pid == pid, abs(p.x - x) <= 60, p.x >= lo - 0.001, p.x <= hi + 0.001, clear(p.x) { x = p.x }
    return .seat(PerchSeat(pid: pid, window: window, x: x, edge: edge, peek: peek, rise: rise, frame: win, display: world.display, top: world.top))
}

// One plan: the box's cells, its top-left positions, opacity and peek mask over time, installed as keyframes.
struct PerchCell { let time: Double, state: String, entry: SpriteEntry, column: Int }
struct PerchPlan {
    var kind: String, seat: PerchSeat, cells: [PerchCell] = [], positions: [(Double, CGPoint)] = [], opacity: [(Double, Double)] = []
    var masked: [(Double, Bool)] = [], duration = 0.0, zs = false, zsStill = false, reduced = false, states: [String] = []
    func position(at t: Double) -> CGPoint {
        guard let first = positions.first else { return .zero }
        if t <= first.0 { return first.1 }
        for (a, b) in zip(positions, positions.dropFirst()) where t <= b.0 {
            let f = b.0 > a.0 ? (t - a.0) / (b.0 - a.0) : 1
            return CGPoint(x: Double(a.1.x) + Double(b.1.x - a.1.x) * f, y: Double(a.1.y) + Double(b.1.y - a.1.y) * f)
        }
        return positions.last!.1
    }
    func cell(at t: Double) -> PerchCell? { cells.last(where: { $0.time <= t + 1e-9 }) ?? cells.first }
    func mask(at t: Double) -> Bool { masked.last(where: { $0.0 <= t + 1e-9 })?.1 ?? masked.first?.1 ?? false }
    // The cell, inset by half a texel, as a contentsRect of its sheet.
    static func rect(_ e: SpriteEntry, _ column: Int, cell: CGSize) -> CGRect {
        let w = Double(e.size?.width ?? cell.width * 8), h = Double(e.size?.height ?? cell.height * Double(e.row + 1))
        return CGRect(x: (Double(column) * Double(cell.width) + 0.5) / w, y: (Double(e.row) * Double(cell.height) + 0.5) / h,
            width: (Double(cell.width) - 1) / w, height: (Double(cell.height) - 1) / h)
    }
    // The animated key paths, each an animation on the box (zs adds one group on the replicated glyph).
    func keyPaths(_ cell: CGSize) -> [String] {
        var out: [String] = []
        if Set(positions.map { "\($0.1.x),\($0.1.y)" }).count > 1 { out.append("position") }
        if Set(cells.map { $0.entry.sheet }).count > 1 { out.append("contents") }
        if Set(cells.map { PerchPlan.rect($0.entry, $0.column, cell: cell) }.map { "\($0)" }).count > 1 { out.append("contentsRect") }
        if Set(cells.map { $0.entry.flip }).count > 1 { out.append("transform") }
        if Set(opacity.map { $0.1 }).count > 1 { out.append("opacity") }
        if Set(masked.map { $0.1 }).count > 1 { out.append("mask.bounds") }
        if zs && !zsStill && !reduced { out.append("zs") }
        return out
    }
}
struct PerchBuilder {
    let table: [String: SpriteEntry], reduced: Bool
    var plan: PerchPlan
    func entry(_ state: String) -> SpriteEntry { table[state] ?? table["perch"]! }
    mutating func add(_ t: Double, _ state: String, _ e: SpriteEntry, _ column: Int) {
        plan.cells.append(PerchCell(time: t, state: state, entry: e, column: column))
        if plan.states.last != state { plan.states.append(state) }
    }
    // One state's cells from `start`. One-shots play once and hold their last cell; loops run to `until`, or park on their first
    // cell at 4.8 s, as the ring parks. `indices` plays a slice of the entry and `stretch` fits it into that many seconds.
    // Reduced motion shows the first cell.
    @discardableResult mutating func play(_ state: String, at start: Double, until: Double? = nil, indices: [Int]? = nil, stretch: Double? = nil) -> Double {
        let e = entry(state), picks = (indices ?? Array(e.columns.indices)).filter { e.columns.indices.contains($0) }
        guard !picks.isEmpty else { return start }
        if reduced { add(start, state, e, e.columns[picks[0]]); return start + (stretch ?? 0) }
        let natural = picks.map { e.ms[$0] }.reduce(0, +) / 1000, factor = stretch.map { natural > 0 ? $0 / natural : 1 } ?? 1
        let loops = e.loop && indices == nil
        var t = start, i = 0
        while true {
            add(t, state, e, e.columns[picks[i]])
            t += e.ms[picks[i]] / 1000 * factor; i += 1
            if i == picks.count { guard loops else { return t }; i = 0 }
            if let until = until { if t >= until - 1e-9 { return until } }
            else if t >= start + 4.8 - 1e-9 {
                if plan.cells.last?.column != e.columns[picks[0]] { add(start + 4.8, state, e, e.columns[picks[0]]) }
                return start + 4.8
            }
        }
    }
    mutating func at(_ t: Double, _ p: CGPoint) { plan.positions.append((t, p)) }
    mutating func mask(_ t: Double, _ on: Bool) { plan.masked.append((t, on)) }
    // A bump: the box rises `height` and settles over 120 ms, folded into the position track.
    mutating func bump(_ t: Double, _ height: Double, at p: CGPoint) {
        guard !reduced else { return }
        at(t, p); at(t + 0.06, CGPoint(x: p.x, y: p.y - height)); at(t + 0.12, p)
    }
}

// Personality lines: the caps, the no-repeat ring, narration first and the click to dismiss, as a pure book.
struct PerchBubble { let text: String, frame: CGRect, tail: CGPoint, side: String }
struct PerchLine { let moment: String, text: String, index: Int, until: Double, bubble: PerchBubble }
struct PerchLineBook {
    var set: PerchLineSet?, enabled = true, seed: UInt64 = 1
    var recent: [String: [Int]] = [:], picks = 0
    var turnOpen = false, said: Set<String> = [], lastOk = false
    var showing: (moment: String, until: Double)?, lastAt = -Double.infinity
    var acts = 0, lastAct = Int.min / 2
    var narrationUntil = -Double.infinity, held: (moment: String, act: Bool)?
    static let priority: Set<String> = ["error", "approval", "done"]
    // The moment a frame is, if any. Turns end at a done without ok (the relay's turn end), a hand back or sleep.
    mutating func moment(_ state: String, ok: Bool, woke: Bool) -> String? {
        if !turnOpen { turnOpen = true; said = []; lastOk = false }
        if handKinds.contains(state) { acts += 1 }
        var moment: String?
        switch state {
        case "aim": moment = said.contains("start") ? nil : "start"
        case "type": moment = said.contains("typing") ? nil : "typing"
        case "waiting": moment = "approval"
        case "error": moment = "error"; lastOk = false
        case "handback": moment = "handback"; turnOpen = false
        case "done" where ok: moment = said.contains("first-click") ? nil : "first-click"; lastOk = true
        case "done": moment = lastOk && !said.contains("done") ? "done" : nil; turnOpen = false
        default: break
        }
        if woke, moment.map({ !PerchLineBook.priority.contains($0) }) ?? true { moment = "wake" }
        if let m = moment, ["start", "typing", "first-click", "done"].contains(m) { said.insert(m) }
        return moment
    }
    // A uniform pick outside the last min(6, count - 1) shown, seeded from the session seed; a single line once per turn.
    mutating func pick(_ moment: String) -> (Int, String)? {
        guard let list = set?.lines[moment], !list.isEmpty else { return nil }
        if list.count < 2 {
            guard !said.contains("single:" + moment) else { return nil }
            said.insert("single:" + moment); return (0, list[0])
        }
        let ring = Array((recent[moment] ?? []).suffix(min(6, list.count - 1)))
        let open = list.indices.filter { !ring.contains($0) }
        let salt = perchMoments.firstIndex(of: moment) ?? 0
        let index = open[min(open.count - 1, Int(seamRandom(seed, picks, 900 + salt) * Double(open.count)))]
        picks += 1; recent[moment] = Array((ring + [index]).suffix(min(6, list.count - 1)))
        return (index, list[index])
    }
    enum Decision { case show, hold, drop }
    // At most one line per 8 s (error, approval and done may replace a line that shows), never lines on two consecutive acts,
    // and never with narration up: then the line waits for it.
    mutating func decide(_ moment: String, now: Double, act: Bool) -> Decision {
        guard enabled, set?.lines[moment] != nil else { return .drop }
        let important = PerchLineBook.priority.contains(moment)
        if let s = showing, now < s.until, !important { return .drop }
        if !important, now - lastAt < 8 - 1e-9 { return .drop }
        if act, acts == lastAct + 1 { return .drop }
        if now < narrationUntil { held = (moment, act); return .hold }
        return .show
    }
}

// Inputs from outside the runtime: the window list, motion, and text measurement (headless in the dump).
struct PerchEnvironment {
    var world: (Int32, UInt32) -> PerchWorld?
    var reduced: () -> Bool
    var measure: (String) -> CGSize
}
enum PerchEffect { case draw(PerchPlan), hide(String, Double), park, still, line(PerchLine), lineOut(Double) }
struct PerchEvent { let state: String, pid: Int32, window: UInt32, at: CGPoint, ok: Bool, drop: Double? }
// The ring's draw as a perch frame: the character reacts when the ring draws, after any act delay.
func perchEvent(_ plan: RingPlan) -> PerchEvent {
    PerchEvent(state: plan.state, pid: plan.pid, window: plan.window, at: plan.at, ok: plan.ok, drop: plan.phases["drop"]?.first)
}
// The high-five once a turn: at the turn's end (a done without ok) after a successful last call, the ring's done burst
// plays at the palm, as a done with ok there. Each call's own done keeps its small burst at the point. The point and a
// clip that holds it (RingRuntime.dissolveAt, which the perch sets only for that frame).
func perchDissolve(_ event: RingEvent, _ clip: CGRect, _ palm: CGPoint?) -> (RingEvent, CGRect) {
    guard event.state == "done", !event.ok, let palm = palm else { return (event, clip) }
    let moved = RingEvent(seq: event.seq, state: event.state, pid: event.pid, windowId: event.windowId, at: palm, rect: nil, label: event.label, ok: true)
    return (moved, clip.union(CGRect(x: palm.x - 60, y: palm.y - 60, width: 120, height: 120)))
}

struct PerchRuntime {
    var frame: SpriteFrame?, seed: UInt64 = 1
    var seat: PerchSeat?, shown = false, asleep = false, paused = false, current = "perch"
    var plan: PerchPlan?, began = 0.0, lastFrame = -Double.infinity
    var timers: [(at: Double, action: String)] = []
    var moving: CGRect?                  // the target window's frame while the person moves it; hidden until it holds still
    var book = PerchLineBook(), line: PerchLine?
    var turnOk: Bool?            // whether the turn's last call so far succeeded (its done with ok) or failed (an error)
    var metrics: PerchMetrics? { frame.flatMap(perchMetrics) }
    var next: Double? { timers.map { $0.at }.min() }
    // How often the host rereads the target window: while it moves, while awake, and slower asleep. nil: nothing perched.
    var poll: Double? { seat == nil ? nil : moving != nil ? 0.25 : asleep ? 2 : 0.5 }
    mutating func load(_ frame: SpriteFrame?) {
        self.frame = frame; book.set = frame?.lines; book.recent = [:]; seat = nil; shown = false; asleep = false; plan = nil; moving = nil; timers = []
        line = nil; book.showing = nil; turnOk = nil
    }
    mutating func timer(_ at: Double, _ action: String) { timers.removeAll { $0.action == action }; timers.append((at, action)) }
    func origin(_ seat: PerchSeat) -> CGPoint {
        CGPoint(x: seat.x - Double(metrics?.anchor.x ?? 0), y: seat.edge - seat.rise)
    }
    func box(_ seat: PerchSeat) -> CGRect { CGRect(origin: origin(seat), size: metrics?.size ?? .zero) }
    // Where the ring's done burst should play: the high-five's palm, while perched in full view.
    // The palm for the ring's burst, only for a turn's end after a successful last call.
    func dissolve(_ event: RingEvent) -> CGPoint? { event.state == "done" && !event.ok && turnOk == true ? palm() : nil }
    func palm() -> CGPoint? {
        guard shown, let seat = seat, !seat.peek, moving == nil, let m = metrics, let e = frame?.perch?.table["high-five"] else { return nil }
        let o = origin(seat), x = e.flip ? Double(m.size.width) - Double(e.hotspot.x) * m.scale : Double(e.hotspot.x) * m.scale
        return CGPoint(x: Double(o.x) + x, y: Double(o.y) + Double(e.hotspot.y) * m.scale)
    }
    mutating func hide(_ now: Double, _ reason: String, keepSeat: Bool = false) -> [(Double, PerchEffect)] {
        let was = shown
        shown = false; asleep = false; plan = nil
        if !keepSeat { seat = nil; moving = nil }
        timers.removeAll { !(keepSeat && $0.action == "return") }
        // Reported even when nothing showed, so a seat refused on the first frame says why (the host has nothing to fade).
        var out: [(Double, PerchEffect)] = [(now, .hide(reason, was ? 0.12 : 0))]
        if line != nil { line = nil; book.showing = nil; out.append((now, .lineOut(0.12))) }
        return out
    }
    // A plan from the current pose: a move (if the seat changed), the startle after sleep, then the frame's states.
    mutating func draw(_ state: String, ok: Bool, at target: CGPoint?, move: String?, from: CGPoint?, woke: Bool, now: Double, env: PerchEnvironment) -> PerchPlan? {
        guard let seat = seat, let table = frame?.perch?.table else { return nil }
        let reduced = env.reduced(), to = origin(seat)
        var b = PerchBuilder(table: table, reduced: reduced, plan: PerchPlan(kind: move ?? "stay", seat: seat, reduced: reduced))
        let forced = seat.peek
        func name(_ s: String) -> String { forced ? "perch-peek" : s }
        var t = 0.0
        let a = from ?? to, d = hypot(Double(to.x - a.x), Double(to.y - a.y))
        let previous = plan?.cell(at: now - began)?.state ?? name(current)
        b.mask(0, forced || previous == "perch-peek")
        switch move {
        case "arrive"?:
            if reduced { b.plan.opacity = [(0, 0), (0.15, 1)]; b.at(0, to) }
            else {
                b.plan.opacity = [(0, 0), (0.08, 1)]
                for i in 0...14 { let f = Double(i) / 14; b.at(0.28 * f, CGPoint(x: to.x, y: Double(to.y) - 80 * (1 - f * f))) }
                b.add(0, name("perch-hop"), b.entry(name("perch-hop")), b.entry(name("perch-hop")).columns[min(1, b.entry(name("perch-hop")).columns.count - 1)])
                t = b.play(name("perch-hop"), at: 0.28, indices: [2, 3])
            }
        case let kind? where reduced:
            // Reduced motion: a 150 ms crossfade, no arc, hop or drop.
            _ = kind; b.plan.kind = "fade"
            b.plan.opacity = [(0, 1), (0.075, 0), (0.15, 1)]; b.at(0, a); b.at(0.075, a); b.at(0.0751, to)
            b.add(0, previous, b.entry(previous), b.entry(previous).columns[0]); t = 0.075
        case "hop"?:
            let hops = max(1, Int((d / 120).rounded(.up)))
            for k in 0..<hops {
                for i in 0...8 {
                    let u = Double(i) / 8, f = (Double(k) + u) / Double(hops)
                    b.at(0.24 * (Double(k) + u), CGPoint(x: Double(a.x) + Double(to.x - a.x) * f, y: Double(a.y) + Double(to.y - a.y) * f - 14 * 4 * u * (1 - u)))
                }
                b.play(name("perch-hop"), at: 0.24 * Double(k), stretch: 0.24)
            }
            t = 0.24 * Double(hops)
        case "run"?:
            let span = min(0.6, d / 600), runner = to.x >= a.x ? "running-right" : "running-left"
            b.at(0, a); b.at(span, to)
            b.play(name(runner), at: 0, until: span)
            t = b.play(name("perch-hop"), at: span, indices: [2, 3])
        case "leap"?:
            // A parabola with its top 60 pt above the higher edge, over 320 + 0.5 per point ms, at most 520.
            let span = min(0.52, 0.32 + 0.0005 * d), top = min(Double(a.y), Double(to.y)) - 60
            var lift = 0.0, high = 400.0
            for _ in 0..<40 {
                let h = (lift + high) / 2
                let lowest = (0...40).map { i -> Double in let u = Double(i) / 40; return Double(a.y) + Double(to.y - a.y) * u - 4 * h * u * (1 - u) }.min()!
                if lowest > top { lift = h } else { high = h }
            }
            for i in 0...26 {
                let u = Double(i) / 26
                b.at(span * u, CGPoint(x: Double(a.x) + Double(to.x - a.x) * u, y: Double(a.y) + Double(to.y - a.y) * u - 4 * lift * u * (1 - u)))
            }
            let jump = b.entry(name("jumping")), marks = [0, 0.2, 0.45, 0.75, 1.0]
            for (i, column) in jump.columns.enumerated() {
                let f = jump.columns.count == 5 ? marks[i] : jump.columns.count > 1 ? Double(i) / Double(jump.columns.count - 1) : 0
                b.add(span * f, name("jumping"), jump, column)
            }
            t = b.play(name("perch-hop"), at: span + 0.07, indices: [2, 3])
        case "far"?:
            // Over 400 pt or onto another display: fade out at the old seat, pop in at the new one. No arc crosses the screen.
            b.plan.opacity = [(0, 1), (0.12, 0), (0.1201, 1)]; b.at(0, a); b.at(0.12, a); b.at(0.1201, to)
            b.add(0, previous, b.entry(previous), b.entry(previous).columns[0])
            t = b.play(name("perch-hop"), at: 0.12, indices: [2, 3])
        case "return"?:
            b.plan.opacity = [(0, 0), (0.06, 1)]; b.at(0, to)
            t = b.play(name("perch-hop"), at: 0, indices: [2, 3])
        default: b.at(0, to)
        }
        if woke {
            b.bump(t, 6, at: to); t = b.play(name("startle"), at: t)
        }
        let peekStates: Set<String> = ["type", "key", "scroll", "drag", "perch-peek"]
        b.mask(t, forced || peekStates.contains(state))
        switch state {
        case "aim":
            let side = Double(target?.x ?? CGFloat(seat.x)) < seat.x ? "perch-point-left" : "perch-point-right"
            current = "perch"; t = b.play(name(side), at: t)
        case "click", "double", "right": current = "perch"; b.bump(t, 3, at: to); t = b.play(name("perch"), at: t)
        case "type", "key", "scroll", "drag", "perch-peek": current = "perch-peek"; t = b.play(name("perch-peek"), at: t)
        case "waiting", "perch-wait": current = "perch-wait"; t = b.play(name("perch-wait"), at: t)
        case "error": current = "perch"; t = b.play(name("error"), at: t); b.mask(t, forced); t = b.play(name("perch"), at: t)
        case "done" where ok:
            // A call's success: a small nod from existing cells (a 3 pt bump and the hop's settle), no palm burst.
            current = "perch"; b.bump(t, 3, at: to); t = b.play(name("perch-hop"), at: t, indices: [2, 3]); t = b.play(name("perch"), at: t)
        case "turn-success": current = "perch"; t = b.play(name("high-five"), at: t); t = b.play(name("perch"), at: t)
        case "done", "handback": current = "perch"; t = b.play(name("handoff"), at: t); t = b.play(name("perch"), at: t)
        case "sleep":
            let e = b.entry(name("sleep")), cycle = e.ms.reduce(0, +) / 1000
            if e.loop && !reduced { b.play(name("sleep"), at: t, until: t + 3 * cycle); b.add(t + 3 * cycle, name("sleep"), e, e.columns[0]); t += 3 * cycle }
            else { t = b.play(name("sleep"), at: t) }
            b.plan.zs = true; b.plan.zsStill = reduced
        default: current = "perch"; t = b.play(name("perch"), at: t)
        }
        if b.plan.positions.isEmpty { b.at(0, to) }
        b.plan.duration = max(t, b.plan.positions.last?.0 ?? 0, b.plan.opacity.last?.0 ?? 0)
        return b.plan
    }
    // The ring drew a frame: seat (on an aim, a new window, or when nothing is perched), move, react, and the frame's line.
    mutating func receive(_ ev: PerchEvent, now: Double, env: PerchEnvironment) -> [(Double, PerchEffect)] {
        var out = advance(to: now, env: env)
        guard let m = metrics else { return out }
        let woke = asleep
        lastFrame = now; asleep = false
        timers.removeAll { ["sleep", "still", "wait-end", "drop", "long-wait"].contains($0.action) }
        let moment = book.moment(ev.state, ok: ev.ok, woke: woke)
        // A turn's end (the relay's done without ok) high-fives when the turn's last call succeeded.
        let state = ev.state == "done" && !ev.ok && turnOk == true ? "turn-success" : ev.state
        if ev.state == "done" { turnOk = ev.ok ? true : nil } else if ev.state == "error" { turnOk = false } else if ev.state == "handback" { turnOk = nil }
        if moving != nil { current = ["type", "key", "scroll", "drag"].contains(ev.state) ? "perch-peek" : ev.state == "waiting" ? "perch-wait" : "perch"; return out }
        var move: String?
        if ev.state == "aim" || seat == nil || seat?.window != ev.window || seat?.pid != ev.pid || !shown {
            switch perchPlace(env.world(ev.pid, ev.window), pid: ev.pid, window: ev.window, target: ev.at, metrics: m, previous: seat) {
            case let .hide(reason): return out + hide(now, reason)
            case let .seat(s):
                if !shown || seat == nil { move = "arrive" }
                else if let old = seat, old.window != s.window || old.pid != s.pid {
                    let d = hypot(Double(origin(s).x - origin(old).x), Double(origin(s).y - origin(old).y))
                    move = old.display == s.display && d <= 400 ? "leap" : "far"
                } else if let old = seat, abs(old.x - s.x) > 0.5 || abs(old.edge - s.edge) > 0.5 {
                    move = abs(old.x - s.x) > 360 ? "run" : "hop"
                }
                seat = s
            }
        }
        let from = shown ? plan?.position(at: now - began) : nil
        guard let next = draw(state, ok: ev.ok, at: ev.at, move: move, from: from, woke: woke, now: now, env: env) else { return out }
        plan = next; began = now; shown = true
        out.append((now, .draw(next)))
        timer(now + next.duration, "park")
        if ev.state == "waiting" { timer(now + 120, "wait-end") } else if !paused { timer(now + 20, "sleep") }
        if ev.state == "drag", let drop = ev.drop { timer(now + drop, "drop") }
        if ["thinking", "waiting"].contains(ev.state) { timer(now + 12, "long-wait") }
        if let moment = moment { out += say(moment, now: now, act: handKinds.contains(ev.state), target: ev.at, env: env) }
        return out
    }
    mutating func say(_ moment: String, now: Double, act: Bool, target: CGPoint?, env: PerchEnvironment) -> [(Double, PerchEffect)] {
        guard shown, let seat = seat else { return [] }
        switch book.decide(moment, now: now, act: act) {
        case .drop, .hold: return []
        case .show:
            guard let (index, text) = book.pick(moment) else { return [] }
            let until = now + min(4, 1.8 + 0.04 * Double(text.count))
            let shown = PerchLine(moment: moment, text: text, index: index, until: until,
                bubble: perchBubble(text, box: box(seat), display: seat.display, top: seat.top, avoid: target, size: env.measure(text)))
            line = shown; book.showing = (moment, until); book.lastAt = now
            if act { book.lastAct = book.acts }
            timer(until, "line-out")
            return [(now, .line(shown))]
        }
    }
    // The bubble was clicked by a person (the host checked the input): that line goes.
    mutating func dismiss(_ now: Double) -> [(Double, PerchEffect)] {
        guard line != nil else { return [] }
        line = nil; book.showing = nil; timers.removeAll { $0.action == "line-out" }
        return [(now, .lineOut(0.12))]
    }
    // A narration bubble (C2) shows until `until`: a line that shows fades in 60 ms, and a line due meanwhile waits for it.
    mutating func narration(until: Double, now: Double) -> [(Double, PerchEffect)] {
        book.narrationUntil = until
        timer(until, "narration-end")
        guard line != nil else { return [] }
        line = nil; book.showing = nil; timers.removeAll { $0.action == "line-out" }
        return [(now, .lineOut(0.06))]
    }
    // The poll: the target window gone, full screen, or moved by the person hides the character, which comes back 500 ms after
    // the frame stops changing.
    mutating func observe(_ now: Double, env: PerchEnvironment) -> [(Double, PerchEffect)] {
        var out = advance(to: now, env: env)
        guard let seat = seat else { return out }
        guard let world = env.world(seat.pid, seat.window) else { return out + hide(now, "gone") }
        if world.fullScreen { return out + hide(now, "full-screen") }
        let still = moving ?? seat.frame
        if world.window != still {
            if shown { out += hide(now, "moved", keepSeat: true) }
            moving = world.window; timer(now + 0.5, "return")
        }
        return out
    }
    mutating func advance(to now: Double, env: PerchEnvironment) -> [(Double, PerchEffect)] {
        var out: [(Double, PerchEffect)] = []
        while let i = timers.indices.min(by: { timers[$0].at < timers[$1].at }), timers[i].at <= now {
            let (at, action) = timers.remove(at: i)
            switch action {
            case "park": out.append((at, .park))
            case "still": out.append((at, .still))
            case "line-out": if line != nil { line = nil; book.showing = nil; out.append((at, .lineOut(0.12))) }
            case "narration-end":
                if let held = book.held { book.held = nil; out += say(held.moment, now: at, act: held.act, target: nil, env: env) }
            case "long-wait": out += say("long-wait", now: at, act: false, target: nil, env: env)
            case "sleep":
                guard shown, !paused, seat != nil else { continue }
                if let p = draw("sleep", ok: false, at: nil, move: nil, from: nil, woke: false, now: at, env: env) {
                    plan = p; began = at; asleep = true; book.turnOpen = false
                    out.append((at, .draw(p)))
                    timer(at + p.duration, "park")
                    if !p.reduced { timer(at + max(p.duration, 6.6), "still") }
                }
            case "wait-end", "drop":
                guard shown, let p = draw("perch", ok: false, at: nil, move: nil, from: nil, woke: false, now: at, env: env) else { continue }
                plan = p; began = at; out.append((at, .draw(p))); timer(at + p.duration, "park")
                if !paused { timer(at + 20, "sleep") }
            case "return":
                guard let seat = seat, let m = metrics else { continue }
                guard let world = env.world(seat.pid, seat.window) else { out += hide(at, "gone"); continue }
                if world.window != moving { moving = world.window; timer(at + 0.5, "return"); continue }
                moving = nil
                // The same spot on the moved window; the point is below the window so nothing dodges it.
                let target = CGPoint(x: seat.x + Double(world.window.minX - seat.frame.minX), y: Double(world.window.maxY) + 100)
                switch perchPlace(world, pid: seat.pid, window: seat.window, target: target, metrics: m, previous: nil) {
                case let .hide(reason): out += hide(at, reason)
                case let .seat(s):
                    self.seat = s
                    if let p = draw(current, ok: false, at: nil, move: "return", from: nil, woke: false, now: at, env: env) {
                        plan = p; began = at; shown = true; out.append((at, .draw(p))); timer(at + p.duration, "park")
                        if !paused { timer(at + 20, "sleep") }
                    }
                }
            default: break
            }
        }
        return out
    }
}
// A2's bubble: centered over the box with its bottom 6 pt above the head (the box top), or beside the box when there is
// under 40 pt above it, kept on the display and off the target. Text is at most 220 pt wide and 2 lines.
func perchBubble(_ text: String, box: CGRect, display: CGRect, top: Double, avoid: CGPoint?, size: CGSize) -> PerchBubble {
    let w = min(220, Double(size.width) + 16), h = min(2, max(1, (Double(size.height) / 13).rounded(.up))) * 13 + 10
    func clampX(_ x: Double) -> Double { min(max(x, Double(display.minX) + 4), Double(display.maxX) - w - 4) }
    var frame = CGRect(x: clampX(Double(box.midX) - w / 2), y: Double(box.minY) - 6 - h, width: w, height: h)
    var tail = CGPoint(x: box.midX, y: box.minY), side = "above"
    let right = CGRect(x: Double(box.maxX) + 6, y: Double(box.minY) + 8, width: w, height: h)
    let left = CGRect(x: Double(box.minX) - 6 - w, y: Double(box.minY) + 8, width: w, height: h)
    func covers(_ r: CGRect) -> Bool { avoid.map { r.insetBy(dx: -8, dy: -8).contains($0) } ?? false }
    if Double(box.minY) - top < 40 || Double(box.minY) - 6 - h < top || covers(frame) {
        let useRight = right.maxX <= display.maxX && !covers(right)
        frame = useRight ? right : left; side = useRight ? "right" : "left"
        tail = CGPoint(x: useRight ? box.maxX - 8 : box.minX + 8, y: box.minY + 8 + CGFloat(h) / 2)
    }
    return PerchBubble(text: text, frame: frame, tail: tail, side: side)
}
func perchMeasure(_ text: String) -> CGSize {
    let r = NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 10.5)])
        .boundingRect(with: CGSize(width: 204, height: 400), options: [.usesLineFragmentOrigin, .usesFontLeading])
    return CGSize(width: ceil(r.width), height: ceil(r.height))
}
// Only a fresh hardware click inside the bubble dismisses it: the shared person-input rule, mouse only.
func perchBubbleClick(_ event: NSEvent?, windowMatches: Bool, now: Double = ProcessInfo.processInfo.systemUptime) -> Bool {
    personActivation(event, windowMatches: windowMatches, keyboard: false, now: now)
}

// The host's side: one drawing panel for the character and its Zs, and the bubble's own small click panel.
final class PerchBubblePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
final class PerchBubbleView: NSView {
    var dismiss: (() -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) {
        guard perchBubbleClick(event, windowMatches: event.window === window && window != nil) else { refuseConsentInput(); return }
        dismiss?()
    }
    override func accessibilityPerformPress() -> Bool { refuseConsentInput(); return false }
}
final class PerchHost {
    weak var host: HandHost?
    var runtime = PerchRuntime()
    var enabled = false, lines = true
    var loaded: SpriteCharacter?
    var panel: HandPanel?, root: CALayer?, boxLayer: CALayer?, maskLayer: CALayer?, zs: CAReplicatorLayer?, frame = CGRect.null
    var bubble: PerchBubblePanel?
    var wake: DispatchWorkItem?
    init(host: HandHost) { self.host = host; runtime.seed = UInt64.random(in: 1...UInt64.max); runtime.book.seed = runtime.seed }
    var active: Bool { enabled && host?.cursorStyle == "sprite" && loaded?.frame.perch != nil }
    // A character load, a style change or the options frame: which runtime gets the character (ring trail or perch).
    func configure(character: SpriteCharacter? = nil, replace: Bool = false, perch: Bool? = nil, lines: Bool? = nil) {
        let was = active, seq = loaded?.frame.seq
        if replace { loaded = character }
        if let perch = perch { enabled = perch }
        if let lines = lines { self.lines = lines; runtime.book.enabled = lines; if !lines { perform(runtime.dismiss(now)) } }
        if active != was || loaded?.frame.seq != seq { takeDown(); runtime.load(active ? loaded?.frame : nil); runtime.book.enabled = self.lines }
        if host?.cursorStyle == "sprite" { host?.ringRuntime.character = active ? nil : loaded }
    }
    var now: Double { CACurrentMediaTime() }
    var environment: PerchEnvironment {
        PerchEnvironment(world: { pid, window in perchWorld(pid: pid, window: window) },
            reduced: { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }, measure: perchMeasure)
    }
    func dissolve(_ event: RingEvent) -> CGPoint? { active ? runtime.dissolve(event) : nil }
    func ringDrew(_ plan: RingPlan) {
        guard active else { return }
        perform(runtime.receive(perchEvent(plan), now: now, env: environment))
    }
    func takeDown() {
        wake?.cancel(); wake = nil
        _ = runtime.hide(now, "hide")
        release(); closeBubble()
    }
    func perform(_ effects: [(Double, PerchEffect)]) {
        for (_, effect) in effects {
            switch effect {
            case let .draw(plan): if host?.captureHeld == true { takeDown(); return }; install(plan)
            case let .hide(_, duration): fadeOut(duration)
            case .park:
                // The Zs finish on their own clock (the still effect); everything else stops here.
                func strip(_ layer: CALayer) { guard layer !== zs else { return }; layer.removeAllAnimations(); layer.sublayers?.forEach(strip) }
                root.map(strip)
            case .still:
                func strip(_ layer: CALayer) { layer.removeAllAnimations(); layer.sublayers?.forEach(strip) }
                root.map(strip); zs?.instanceCount = 1
            case let .line(line): showBubble(line)
            case let .lineOut(duration): closeBubble(fade: duration)
            }
        }
        schedule()
    }
    // One one-shot wake for the earliest timer or the next window check. Nothing is scheduled with nothing perched.
    func schedule() {
        wake?.cancel(); wake = nil
        let due = [runtime.next, runtime.poll.map { now + $0 }].compactMap { $0 }.min()
        guard let at = due else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.wake = nil
            self.perform(self.runtime.observe(self.now, env: self.environment))
        }
        wake = item
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, at - now), execute: item)
    }
    func install(_ plan: PerchPlan) {
        guard let character = loaded, let metrics = runtime.metrics, !plan.cells.isEmpty else { return }
        let cell = character.frame.cell
        var box = CGRect.null
        for (_, p) in plan.positions { box = box.union(CGRect(origin: p, size: metrics.size)) }
        let target = box.insetBy(dx: -24, dy: -44)
        let panel = self.panel ?? makeHandPanel(capture: host?.capture ?? "hidden")
        self.panel = panel; frame = target
        panel.sharingType = handCaptureModes[host?.capture ?? "hidden"] ?? NSWindow.SharingType.none
        panel.setFrame(appKitRect(target), display: false)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        root?.removeFromSuperlayer()
        let root = CALayer(); root.frame = CGRect(origin: .zero, size: target.size); root.isGeometryFlipped = true
        panel.contentView?.layer?.addSublayer(root); self.root = root
        let layer = CALayer(); layer.name = "perch"; layer.anchorPoint = .zero; layer.bounds = CGRect(origin: .zero, size: cell)
        layer.contentsGravity = .resize; layer.minificationFilter = .linear; layer.magnificationFilter = .nearest
        root.addSublayer(layer); boxLayer = layer
        let mask = CALayer(); mask.backgroundColor = CGColor(gray: 0, alpha: 1); mask.anchorPoint = .zero
        let cut = CGRect(x: 0, y: 0, width: Double(cell.width), height: plan.seat.rise / metrics.scale), whole = CGRect(origin: .zero, size: cell)
        mask.bounds = plan.mask(at: plan.duration) ? cut : whole; layer.mask = mask; maskLayer = mask
        let begin = CACurrentMediaTime(), length = max(plan.duration, 0.001)
        func unit(_ t: Double) -> NSNumber { NSNumber(value: min(max(t / length, 0), 1)) }
        func local(_ p: CGPoint, _ e: SpriteEntry) -> NSValue {
            NSValue(point: CGPoint(x: p.x - target.minX + (e.flip ? metrics.size.width : 0), y: p.y - target.minY))
        }
        func add(_ to: CALayer, _ key: String, _ values: [Any], _ times: [Double], discrete: Bool) {
            to.setValue(values.last, forKeyPath: key)
            guard values.count > 1 else { return }
            let a = CAKeyframeAnimation(keyPath: key)
            a.values = values; a.keyTimes = times.map(unit); a.calculationMode = discrete ? .discrete : .linear
            a.duration = length; a.beginTime = begin; a.fillMode = .both; a.isRemovedOnCompletion = false
            to.add(a, forKey: key)
        }
        let cells = plan.cells.isEmpty ? [] : plan.cells + [plan.cells.last!]
        let cellTimes = plan.cells.map { $0.time } + [plan.duration]
        add(layer, "contents", cells.compactMap { character.images[$0.entry.sheet] }, cellTimes, discrete: true)
        add(layer, "contentsRect", cells.map { NSValue(rect: PerchPlan.rect($0.entry, $0.column, cell: cell)) }, cellTimes, discrete: true)
        add(layer, "transform", cells.map { NSValue(caTransform3D: CATransform3DMakeScale($0.entry.scale * ($0.entry.flip ? -1 : 1), $0.entry.scale, 1)) }, cellTimes, discrete: true)
        let flipAt = { (t: Double) in plan.cell(at: t)?.entry ?? cells[0].entry }
        add(layer, "position", plan.positions.map { local($0.1, flipAt($0.0)) }, plan.positions.map { $0.0 }, discrete: plan.reduced)
        if !plan.opacity.isEmpty { add(layer, "opacity", plan.opacity.map { NSNumber(value: $0.1) }, plan.opacity.map { $0.0 }, discrete: false) }
        if Set(plan.masked.map { $0.1 }).count > 1 {
            add(mask, "bounds", plan.masked.map { NSValue(rect: $0.1 ? cut : whole) }, plan.masked.map { $0.0 }, discrete: true)
        }
        zs = nil
        if plan.zs, let last = plan.positions.last?.1 {
            root.addSublayer(perchZs(at: CGPoint(x: last.x - target.minX + metrics.size.width / 2 + 8, y: last.y - target.minY + 10), begin: begin, still: plan.zsStill))
        }
        CATransaction.commit()
        if !panel.isVisible { panel.orderFrontRegardless() }
    }
    // Three z glyphs (7, 9 and 11 pt, white over a 2 pt ink outline) as one replicated layer: one animation group rises 16 pt and
    // drifts 10 pt over 1.8 s, three times, staggered 600 ms. Still: one static z.
    func perchZs(at point: CGPoint, begin: Double, still: Bool) -> CALayer {
        let replicator = CAReplicatorLayer(); replicator.position = point; replicator.instanceCount = still ? 1 : 3
        replicator.instanceDelay = 0.6; replicator.instanceTransform = CATransform3DMakeScale(1.28, 1.28, 1)
        let glyph = CALayer()
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 7, nil)
        var g = CGGlyph(0), u: UniChar = 122
        CTFontGetGlyphsForCharacters(font, &u, &g, 1)
        var flip = CGAffineTransform(scaleX: 1, y: -1)
        if let path = CTFontCreatePathForGlyph(font, g, &flip) {
            let outline = CAShapeLayer(); outline.path = path.copy(strokingWithWidth: 2, lineCap: .round, lineJoin: .round, miterLimit: 2)
            outline.fillColor = CGColor(red: 0x2a / 255, green: 0x22 / 255, blue: 0x38 / 255, alpha: 0.85)
            let fill = CAShapeLayer(); fill.path = path; fill.fillColor = CGColor(gray: 1, alpha: 1)
            glyph.addSublayer(outline); glyph.addSublayer(fill)
        }
        replicator.addSublayer(glyph)
        if still { glyph.position = CGPoint(x: 10, y: -16) }
        else {
            let move = CAKeyframeAnimation(keyPath: "position")
            move.values = [CGPoint.zero, CGPoint(x: 10, y: -16)].map { NSValue(point: $0) }
            let fade = CAKeyframeAnimation(keyPath: "opacity"); fade.values = [0, 1, 1, 0]; fade.keyTimes = [0, 0.15, 0.7, 1]
            let group = CAAnimationGroup(); group.animations = [move, fade]; group.duration = 1.8; group.repeatCount = 3
            group.beginTime = begin; group.fillMode = .both; group.isRemovedOnCompletion = false
            glyph.position = CGPoint(x: 10, y: -16); glyph.add(group, forKey: "zs")
        }
        zs = replicator
        return replicator
    }
    func fadeOut(_ duration: Double) {
        guard let root = root else { release(); return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let a = CABasicAnimation(keyPath: "opacity"); a.fromValue = root.opacity; a.toValue = 0; a.duration = duration
        root.opacity = 0; root.add(a, forKey: "fade")
        CATransaction.commit()
        let mine = root
        DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in if self?.root === mine { self?.release() } }
    }
    func release() {
        root?.removeAllAnimations(); root?.removeFromSuperlayer(); root = nil; boxLayer = nil; maskLayer = nil; zs = nil
        panel?.orderOut(nil); panel?.close(); panel = nil; frame = .null
    }
    // The white comic bubble in its own click panel, the only part of the overlay that takes a click.
    func showBubble(_ line: PerchLine) {
        closeBubble()
        let b = line.bubble, panel = PerchBubblePanel(contentRect: appKitRect(b.frame.insetBy(dx: -7, dy: -7)), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.level = .floating; panel.hasShadow = false; panel.isOpaque = false; panel.backgroundColor = .clear
        panel.sharingType = handCaptureModes[host?.capture ?? "hidden"] ?? NSWindow.SharingType.none
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .stationary]; panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false; panel.animationBehavior = .none
        let view = PerchBubbleView(); view.wantsLayer = true; view.setAccessibilityElement(false)
        view.dismiss = { [weak self] in guard let self = self else { return }; self.perform(self.runtime.dismiss(self.now)) }
        panel.contentView = view
        let local = b.frame.offsetBy(dx: 7 - b.frame.minX, dy: 7 - b.frame.minY)
        let tail = CGPoint(x: b.tail.x - b.frame.minX + 7, y: b.tail.y - b.frame.minY + 7)
        let root = CALayer(); root.frame = CGRect(origin: .zero, size: panel.frame.size); root.isGeometryFlipped = true
        let body = CAShapeLayer(); body.path = perchBubblePath(local, tail: tail, side: b.side)
        body.fillColor = CGColor(gray: 1, alpha: 1); body.strokeColor = CGColor(red: 0x2a / 255, green: 0x22 / 255, blue: 0x38 / 255, alpha: 0.85); body.lineWidth = 1.3
        let text = CATextLayer(); text.frame = local.insetBy(dx: 8, dy: 5); text.isWrapped = true; text.truncationMode = .end
        text.string = NSAttributedString(string: line.text, attributes: [.font: NSFont.systemFont(ofSize: 10.5),
            .foregroundColor: NSColor(red: 0x15 / 255, green: 0x16 / 255, blue: 0x1c / 255, alpha: 1)])
        text.contentsScale = panel.screen?.backingScaleFactor ?? 2
        root.addSublayer(body); root.addSublayer(text); view.layer?.addSublayer(root)
        let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0; fade.toValue = 1; fade.duration = 0.09
        root.add(fade, forKey: "in")
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let rise = CABasicAnimation(keyPath: "transform.translation.y"); rise.fromValue = 4; rise.toValue = 0; rise.duration = 0.09
            root.add(rise, forKey: "rise")
        }
        bubble = panel
        panel.orderFrontRegardless()
    }
    func closeBubble(fade: Double = 0) {
        guard let panel = bubble else { return }
        bubble = nil; panel.ignoresMouseEvents = true
        guard fade > 0, let root = panel.contentView?.layer?.sublayers?.first else { panel.orderOut(nil); panel.close(); return }
        let a = CABasicAnimation(keyPath: "opacity"); a.fromValue = 1; a.toValue = 0; a.duration = fade
        root.opacity = 0; root.add(a, forKey: "out")
        DispatchQueue.main.asyncAfter(deadline: .now() + fade) { panel.orderOut(nil); panel.close() }
    }
}
// The bubble's outline: a rounded rect (radius 10) and a tail 8 pt wide and 6 pt tall toward the mouth.
func perchBubblePath(_ r: CGRect, tail: CGPoint, side: String) -> CGPath {
    let path = CGMutablePath()
    path.addRoundedRect(in: r, cornerWidth: 10, cornerHeight: 10)
    if side == "above" {
        let x = min(max(tail.x, r.minX + 14), r.maxX - 14)
        path.move(to: CGPoint(x: x - 4, y: r.maxY)); path.addLine(to: CGPoint(x: x, y: r.maxY + 6)); path.addLine(to: CGPoint(x: x + 4, y: r.maxY))
    } else {
        let edge = side == "right" ? r.minX : r.maxX, dir: CGFloat = side == "right" ? -1 : 1
        path.move(to: CGPoint(x: edge, y: r.midY - 4)); path.addLine(to: CGPoint(x: edge + dir * 6, y: r.midY)); path.addLine(to: CGPoint(x: edge, y: r.midY + 4))
    }
    return path
}
// The window list, front to back: the target window's frame, the frames in front of it that cross nothing of ours, its
// display (the one holding its top edge's center) and that display's top below the menu bar. Bounds and owners need no grant.
func perchWorld(pid: Int32, window: UInt32) -> PerchWorld? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    let own = ProcessInfo.processInfo.processIdentifier
    var above: [CGRect] = []
    for info in list {
        guard let bounds = info[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { continue }
        let number = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value, owner = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        if number == window {
            guard owner == pid else { return nil }
            let primary = NSScreen.screens.first?.frame.maxY ?? 0, edge = CGPoint(x: rect.midX, y: rect.minY)
            let screens = NSScreen.screens.map { s -> (CGRect, Double) in
                let f = CGRect(x: s.frame.minX, y: primary - s.frame.maxY, width: s.frame.width, height: s.frame.height)
                return (f, Double(f.minY) + Double(s.frame.maxY - s.visibleFrame.maxY))
            }
            guard let screen = screens.first(where: { $0.0.contains(edge) }) ?? screens.first else { return nil }
            return PerchWorld(window: rect, above: above, display: screen.0, top: screen.1,
                fullScreen: abs(rect.width - screen.0.width) < 1 && abs(rect.height - screen.0.height) < 1)
        }
        let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0, alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
        if owner != own, layer >= 0, layer < 1000, alpha > 0 { above.append(rect) }
    }
    return nil
}
// END PERCH

// BEGIN HAND HOST
// The ghost hand (ROADMAP 2.7): a glove that glides to where sleight acts in a background window, flourishes and fades. It only
// draws: the panel never activates, takes key, catches a click or shows in another process's capture unless the user chose
// visible, and it is released after the fade, so an idle host has no window and no scheduled work.
final class HandPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
// Capture: hidden (.none) keeps the panel out of every capture, the user's own screenshots and recordings included, and
// visible (.readOnly) lets them show it. The client passes the user's setting as --capture=hidden|visible; hidden is the default.
let handCaptureModes: [String: NSWindow.SharingType] = ["hidden": NSWindow.SharingType.none, "visible": NSWindow.SharingType.readOnly]
func handCapture(_ args: [String]) -> String? {
    if args.isEmpty { return "hidden" }
    guard args.count == 1, args[0].hasPrefix("--capture="), handCaptureModes[String(args[0].dropFirst(10))] != nil else { return nil }
    return String(args[0].dropFirst(10))
}
func makeHandPanel(capture: String) -> HandPanel {
    let panel = HandPanel(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1), styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered, defer: true)
    panel.level = .floating
    panel.ignoresMouseEvents = true
    panel.hasShadow = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.sharingType = handCaptureModes[capture] ?? NSWindow.SharingType.none
    panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .stationary]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.animationBehavior = .none
    panel.setAccessibilityElement(false)
    let view = NSView()
    view.wantsLayer = true
    view.setAccessibilityElement(false)
    panel.contentView = view
    return panel
}
// Global top-left points to AppKit's bottom-left screen coordinates, which start at the primary display.
func appKitRect(_ rect: CGRect) -> NSRect {
    NSRect(x: rect.minX, y: (NSScreen.screens.first?.frame.maxY ?? 0) - rect.maxY, width: rect.width, height: rect.height)
}
// The target window's bounds while it is on screen and still the frame's pid's. Bounds and owner need no recording grant.
func handWindowBounds(_ windowId: UInt32, pid: Int32) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowId)) as? [[String: Any]],
        let info = list.first, (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowId,
        (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
        (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
        let bounds = info[kCGWindowBounds as String] as? NSDictionary,
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
    return rect
}
func handDemoRect(_ text: String) -> CGRect? {
    let parts = text.split(separator: ",", omittingEmptySubsequences: false).map { Double($0) }
    guard parts.count == 4, let x = parts[0], let y = parts[1], let width = parts[2], let height = parts[3],
        [x, y, width, height].allSatisfy({ $0.isFinite && abs($0) <= 100000 }), width >= 1, height >= 1 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

final class HandHost: NSObject, NSApplicationDelegate {
    var cursorStyle = "glove" { didSet { if cursorStyle != "sprite" { spriteLoader.cancel(); ringRuntime.character = nil; perch.configure(replace: true) } } }
    let spriteLoader = SpriteLoader()
    lazy var perch = PerchHost(host: self)   // perch mode and lines (BEGIN PERCH)
    var ringRuntime = RingRuntime(theme: .seamPlus, seed: 1)
    var ringWake: DispatchWorkItem?
    var ringRoot: CALayer?
    var ringCursor: CALayer?, ringLabel: CALayer?, ringTether: CALayer?
    var panel: HandPanel?
    var hand: CALayer?           // holds the opacity; glove over dabs inside it, siblings with one anchor
    var glove: CALayer?
    var dabs: CALayer?
    var shown = HandState.rest   // the glove's content when the last plan ends
    var fadeTo = CGPoint.zero    // where the idle fade drifts to, global top-left points
    var box = CGRect.null        // the panel's frame, global top-left points
    var windowId: UInt32 = 0
    var pending: [Int: DispatchWorkItem] = [:]
    var fading: DispatchWorkItem?
    var next = 0
    var demo: CGRect?
    var capture = "hidden"
    var consent: ConsentHost?    // the shared host's consent channel and menu, with --consent
    var images: [String: CGImage] = [:]
    var captureHolds: [String: Date] = [:]
    var captureObserver: NSObjectProtocol?
    var captureHeld: Bool { captureHolds = captureHolds.filter { $0.value > Date() }; return !captureHolds.isEmpty }
    var idle: Bool { ringRoot == nil && ringWake == nil && ringRuntime.idle && panel == nil && hand == nil && glove == nil && dabs == nil && pending.isEmpty && fading == nil }

    func image(_ state: HandState) -> CGImage? {
        let scale: CGFloat = (glove?.contentsScale ?? 2) > 1 ? 2 : 1, key = state.rawValue + "@\(Int(scale))"
        if let image = images[key] { return image }
        let image = HandArt.image(state, scale: scale); images[key] = image
        return image
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let demo = demo { play(demo); return }
        consent?.applicationDidFinishLaunching(notification)
        // Only suppresses artwork. No notification can answer a consent card or change a setting.
        let name = "com.sleight.hand.capture.\(ProcessInfo.processInfo.processIdentifier)"
        captureObserver = DistributedNotificationCenter.default().addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] note in
            guard let self = self, let object = note.object as? String else { return }
            let parts = object.split(separator: ":")
            guard parts.count == 2, String(parts[1]).range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { return }
            let token = String(parts[1])
            if parts[0] == "begin" {
                _ = self.captureHeld
                guard self.captureHolds.count < 32 || self.captureHolds[token] != nil else { return }
                self.captureHolds[token] = Date().addingTimeInterval(30); self.hide()
                DistributedNotificationCenter.default().postNotificationName(Notification.Name(name + ".ack"), object: token, userInfo: nil, deliverImmediately: true)
            } else if parts[0] == "end" { self.captureHolds.removeValue(forKey: token) }
        }
        DispatchQueue.global(qos: .utility).async { self.read() }
    }
    // Validation, the nonce binding and the seq order run on this reader thread in frame order. Any bad frame ends the host.
    func read() {
        // A bad hand frame ends the host, except while turbo's consent channel is attached: then only the hand's state goes, the
        // rest of the hand's input is read and dropped, and turbo carries on.
        var buffer = Data(), last = -1, faulted = false
        func fault() {
            faulted = true; buffer.removeAll()
            DispatchQueue.main.async { if self.consent?.consentOpen == true { self.hide(); self.consent?.handGone() } else { exit(65) } }
        }
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty {
                DispatchQueue.main.async { if self.consent?.consentOpen == true { self.hide(); self.consent?.handGone() } else { NSApp.terminate(nil) } }
                return
            }
            if faulted { continue }
            buffer.append(chunk)
            if buffer.count > 131072 { fault(); continue }
            lines: while !faulted, let end = buffer.firstIndex(of: 10) {
                let line = buffer.prefix(upTo: end)
                buffer.removeSubrange(...end)
                guard line.count <= 65536, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                    line.count <= 8192 || data["hand"] as? String == "character" && line.count <= 32768 || data["hand"] as? String == "picker",
                    let frame = handFrame(data) else { fault(); continue lines }
                switch frame {
                case let .picker(nonce, message):
                    guard nonceBook.admit("hand", nonce), message.op != "input-check" else { fault(); continue lines }
                    DispatchQueue.main.async {
                        if message.op == "style", let style = message.data["style"] as? String {
                            self.hide(); self.cursorStyle = style
                            self.ringRuntime = RingRuntime(theme: ringThemes[style] ?? .seamPlus, seed: UInt64.random(in: 1...UInt64.max))
                            self.consent?.cursorPicker.rows = CursorPickerRow.defaults(style)
                        } else if message.op == "options" {
                            self.perch.configure(perch: message.data["perch"] as? Bool, lines: message.data["lines"] as? Bool)
                        } else { self.consent?.cursorPicker.receive(message) }
                    }
                case let .character(nonce, value):
                    guard nonceBook.admit("hand", nonce), value.seq > last else { fault(); continue lines }
                    last = value.seq
                    DispatchQueue.main.async {
                        self.ringRoot?.sublayers?.filter { $0.name == "sprite" }.forEach { $0.removeFromSuperlayer() }
                        self.ringRuntime.character = nil; self.perch.configure(replace: true)
                        guard self.cursorStyle == "sprite" else { self.spriteLoader.cancel(); return }
                        // The decode runs off the main thread. Until it's done the ring draws alone; the sprite joins at
                        // the next frame after it.
                        self.spriteLoader.start(value) { generation, result in
                            DispatchQueue.main.async {
                                guard self.spriteLoader.isCurrent(generation), self.cursorStyle == "sprite" else { return }
                                self.perch.configure(character: result.character, replace: true); writeCharacterResult(value.id, result)
                            }
                        }
                    }
                case let .hide(nonce):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async { self.hide() }
                case let .act(nonce, act):
                    guard nonceBook.admit("hand", nonce), act.seq > last else { fault(); continue lines }
                    last = act.seq
                    DispatchQueue.main.async { if self.cursorStyle == "glove" { self.schedule(act) } else { self.ringFrame(ringEvent(act), delay: act.delay) } }
                case let .aim(nonce, event), let .status(nonce, event):
                    guard nonceBook.admit("hand", nonce), event.seq > last else { fault(); continue lines }
                    last = event.seq
                    DispatchQueue.main.async { if self.cursorStyle != "glove" { self.ringFrame(event, delay: 0) } }
                case let .menu(nonce, enabled, capture, version, permissions, usage):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async {
                        self.capture = capture
                        if let panel = self.panel { panel.sharingType = handCaptureModes[capture] ?? NSWindow.SharingType.none }
                        if !enabled { self.hide() }
                        self.consent?.handState(enabled: enabled, version: version, permissions: permissions, usage: usage)
                    }
                }
            }
        }
    }
    // A frame plays after its delay unless a hide comes first. Past 64 waiting frames, new ones are dropped.
    func schedule(_ act: HandAct) {
        guard !captureHeld, pending.count < 64 else { return }
        let id = next; next += 1
        let item = DispatchWorkItem { [weak self] in
            self?.pending[id] = nil
            if self?.captureHeld == false, let bounds = handWindowBounds(act.windowId, pid: act.pid) { self?.draw(act, clip: bounds) }
        }
        pending[id] = item
        DispatchQueue.main.asyncAfter(deadline: .now() + act.delay, execute: item)
    }
    func hide() {
        pending.values.forEach { $0.cancel() }; pending.removeAll()
        ringWake?.cancel(); ringWake = nil; _ = ringRuntime.hide(0)
        fading?.cancel(); release(); perch.takeDown()
    }
    // A frame during the hold cancels the fade and glides on from where the hand is.
    func draw(_ act: HandAct, clip: CGRect) {
        let start = panel != nil && windowId == act.windowId ? glove.map { layer in
            (point: global((layer.presentation() ?? layer).position), opacity: Double((hand?.presentation() ?? hand)?.opacity ?? 0), state: shown) } : nil
        let plan = handPlan(act, from: start, secure: IsSecureEventInputEnabled())
        guard layout(plan.points, clip: clip), let panel = panel else { return }
        fading?.cancel(); fading = nil
        apply(plan, model: (plan.rest, HandArt.lifted, .rest))
        shown = .rest; fadeTo = plan.fadeTo; windowId = act.windowId
        if !panel.isVisible { panel.orderFrontRegardless() }
        fade(after: plan.total + HandTiming.silence)
    }
    // The ring: the runtime decides, this adapter installs plans on one clipped panel with a flipped root, so all geometry
    // keeps the wire's top-left coordinates. One one-shot wake-up serves the runtime's earliest pending act or timer.
    var ringEnvironment: RingEnvironment {
        RingEnvironment(bounds: { pid, window in handWindowBounds(window, pid: pid) },
            reduced: { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }, secure: { IsSecureEventInputEnabled() })
    }
    func ringFrame(_ event: RingEvent, delay: Double) {
        guard !captureHeld else { return }
        ringRuntime.dissolveAt = perch.dissolve(event)
        ringPerform(ringRuntime.receive(event, delay: delay, now: CACurrentMediaTime(), ringEnvironment))
        ringWakeUp()
    }
    func ringWakeUp() {
        ringWake?.cancel(); ringWake = nil
        guard let next = ringRuntime.next else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.ringWake = nil
            self.ringPerform(self.ringRuntime.advance(to: CACurrentMediaTime(), self.ringEnvironment))
            self.ringWakeUp()
        }
        ringWake = item
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, next - CACurrentMediaTime()), execute: item)
    }
    func ringPerform(_ effects: [(Double, RingEffect)]) {
        for (_, effect) in effects {
            switch effect {
            case let .draw(plan, frame):
                if captureHeld { hide(); return }
                installRing(plan, frame: frame); perch.ringDrew(plan)
            case .hide, .release: release()
            case .drop: break
            case .park:
                func strip(_ layer: CALayer) { layer.removeAllAnimations(); layer.sublayers?.forEach(strip) }
                ringRoot?.sublayers?.forEach(strip)
            case let .fade(duration):
                guard let root = ringRoot else { continue }
                let animation = CABasicAnimation(keyPath: "opacity")
                animation.fromValue = root.opacity; animation.toValue = 0; animation.duration = duration
                animation.timingFunction = CAMediaTimingFunction(name: .easeIn)
                CATransaction.begin(); CATransaction.setDisableActions(true)
                root.opacity = 0; root.add(animation, forKey: "fade")
                CATransaction.commit()
            }
        }
    }
    func installRing(_ plan: RingPlan, frame: CGRect) {
        fading?.cancel(); fading = nil
        let panel = self.panel ?? makeHandPanel(capture: capture)
        let previousBox = box
        self.panel = panel; box = frame
        panel.setFrame(appKitRect(frame), display: false)
        // A changed label carries the old chip and tether over to fade out.
        let carried = plan.oldLabel == nil ? [] : [("oldChip", ringLabel), ("oldTether", ringTether)].compactMap { name, layer in layer.map { (name, $0) } }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (_, layer) in carried { layer.removeFromSuperlayer() }
        ringRoot?.removeAllAnimations(); ringRoot?.removeFromSuperlayer()
        let root = CALayer()
        root.frame = CGRect(origin: .zero, size: frame.size); root.isGeometryFlipped = true
        panel.contentView?.layer?.addSublayer(root)
        ringRoot = root; ringLabel = nil; ringTether = nil
        var layers: [String: CALayer] = ["root": root], specs: [String: RingLayer] = [:]
        for (name, layer) in carried {
            layer.position = CGPoint(x: layer.position.x + previousBox.minX - frame.minX, y: layer.position.y + previousBox.minY - frame.minY)
            root.addSublayer(layer); layers[name] = layer
        }
        func color(_ c: [Double]) -> CGColor { CGColor(red: c[0], green: c[1], blue: c[2], alpha: c[3]) }
        func path(_ commands: [[Double]], global: Bool) -> CGPath {
            let result = CGMutablePath(), dx = global ? Double(frame.minX) : 0, dy = global ? Double(frame.minY) : 0
            func p(_ c: [Double], _ i: Int) -> CGPoint { CGPoint(x: c[i] - dx, y: c[i + 1] - dy) }
            for c in commands {
                switch Int(c[0]) {
                case 0: result.move(to: p(c, 1))
                case 1: result.addLine(to: p(c, 1))
                case 2: result.addQuadCurve(to: p(c, 3), control: p(c, 1))
                case 4: result.addCurve(to: p(c, 5), control1: p(c, 1), control2: p(c, 3))
                default: result.closeSubpath()
                }
            }
            return result
        }
        func value(_ v: RingValue, _ key: String, _ spec: RingLayer?) -> Any {
            let global = spec?.global ?? false
            switch (key, v) {
            case let ("path", .path(commands)): return path(commands, global: global)
            case let ("position", .vector(xy)):
                return NSValue(point: CGPoint(x: xy[0] - (global ? Double(frame.minX) : 0), y: xy[1] - (global ? Double(frame.minY) : 0)))
            case let ("transform", .vector(m)):
                return NSValue(caTransform3D: CATransform3DMakeAffineTransform(CGAffineTransform(a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5])))
            case let ("transform.translation", .vector(xy)): return NSValue(size: NSSize(width: xy[0], height: xy[1]))
            case let (_, .vector(c)) where key.hasSuffix("Color"): return color(c)
            case let (_, .number(n)): return NSNumber(value: n)
            default: return v.json
            }
        }
        let scale = panel.screen?.backingScaleFactor ?? 2
        for spec in plan.layers {
            let layer: CALayer
            switch spec.kind {
            case .group: layer = CALayer()
            case .text:
                let text = CATextLayer()
                text.frame = (spec.frame ?? .zero).offsetBy(dx: -frame.minX, dy: -frame.minY); text.cornerRadius = 8
                text.string = spec.text ?? ""; text.fontSize = 8; text.alignmentMode = .center; text.truncationMode = .end
                text.foregroundColor = spec.stroke.map(color); text.backgroundColor = spec.fill.map(color); text.contentsScale = scale
                layer = text
            case .gradient:
                let gradient = CAGradientLayer(), outline = spec.props["path"].flatMap { v -> CGPath? in
                    if case let .path(c) = v { return path(c, global: spec.global) }; return nil } ?? CGMutablePath()
                let bounds = outline.boundingBoxOfPath
                gradient.frame = bounds; gradient.colors = spec.colors.map(color)
                gradient.startPoint = CGPoint(x: 0, y: 1); gradient.endPoint = CGPoint(x: 1, y: 0)
                let mask = CAShapeLayer()
                var shift = CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY)
                mask.path = outline.copy(using: &shift); mask.fillColor = CGColor(gray: 0, alpha: 1)
                gradient.mask = mask
                layer = gradient
            case .shape:
                let shape = CAShapeLayer()
                shape.lineWidth = spec.width; shape.lineCap = .round; shape.lineJoin = .round
                shape.strokeColor = spec.stroke.map(color); shape.fillColor = spec.fill.map(color)
                if !spec.dash.isEmpty { shape.lineDashPattern = spec.dash.map { NSNumber(value: $0) } }
                layer = shape
            }
            for (key, v) in spec.props where !(spec.kind == .gradient && key == "path") { layer.setValue(value(v, key, spec), forKeyPath: key) }
            if spec.keyline, let shape = layer as? CAShapeLayer {
                shape.shadowPath = shape.path?.copy(strokingWithWidth: shape.lineWidth + 2.4, lineCap: .round, lineJoin: .round, miterLimit: 1)
                shape.shadowColor = color(plan.layers.first { $0.name == "kW" }?.stroke ?? [0, 0, 0, 0.55])
                shape.shadowOpacity = 1; shape.shadowRadius = 0; shape.shadowOffset = .zero
            }
            let parent = layers[spec.parent] ?? root
            if spec.under { parent.insertSublayer(layer, at: 0) } else { parent.addSublayer(layer) }
            layers[spec.name] = layer; specs[spec.name] = spec
        }
        ringCursor = layers["cursor"]; ringLabel = layers["chip"]; ringTether = layers["tether"]
        // One animation, or one group, per layer. The model holds each track's last value, so parking changes nothing on screen.
        let begin = CACurrentMediaTime()
        for (name, tracks) in Dictionary(grouping: plan.tracks, by: { $0.layer }) {
            guard let layer = layers[name] else { continue }
            let animations: [CAKeyframeAnimation] = tracks.map { track in
                let animation = CAKeyframeAnimation(keyPath: track.keyPath)
                animation.values = track.values.map { value($0, track.keyPath, specs[name]) }
                animation.keyTimes = track.times.map { NSNumber(value: $0) }
                animation.duration = max(track.duration, 0.001); animation.beginTime = track.begin
                animation.fillMode = .both; animation.isRemovedOnCompletion = false
                layer.setValue(animation.values?.last, forKeyPath: track.keyPath)
                return animation
            }
            if animations.count == 1, let only = animations.first {
                only.beginTime = begin + only.beginTime; layer.add(only, forKey: "ring")
            } else {
                let group = CAAnimationGroup()
                group.animations = animations; group.beginTime = begin
                group.duration = animations.map { $0.beginTime + $0.duration }.max() ?? 0.001
                group.fillMode = .both; group.isRemovedOnCompletion = false
                layer.add(group, forKey: "ring")
            }
        }
        if let sprite = plan.sprite { installSprite(sprite, ring: plan, root: root, frame: frame, begin: begin) }
        CATransaction.commit()
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    // Every animation of a plan on the glove and the dabs, which run the position track 50 ms behind (the trail).
    func apply(_ plan: HandPlan, model: (CGPoint, Double, HandState)) {
        guard let hand = hand, let glove = glove, let dabs = dabs else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for layer in [hand, glove, dabs] { layer.removeAllAnimations() }
        let begin = CACurrentMediaTime()
        if let animation = plan.position.animation("position", begin: begin, { NSValue(point: self.local($0)) }) {
            glove.add(animation, forKey: "position")
            let trail = animation.copy() as! CAKeyframeAnimation; trail.beginTime = begin + HandTiming.trail
            dabs.add(trail, forKey: "position")
        }
        if let animation = plan.opacity.animation("opacity", begin: begin, { Float($0) }) { hand.add(animation, forKey: "opacity") }
        if let animation = plan.contents.animation("contents", begin: begin, { self.image($0) as Any }) { glove.add(animation, forKey: "contents") }
        for (track, path) in [(plan.scale, "transform.scale"), (plan.rotation, "transform.rotation.z")] {
            if let animation = track.animation(path, begin: begin, { $0 }) { glove.add(animation, forKey: path); dabs.add(animation, forKey: path) }
        }
        if let animation = plan.offset.animation("transform.translation", begin: begin, { NSValue(size: NSSize(width: $0.x, height: $0.y)) }) {
            glove.add(animation, forKey: "transform.translation"); dabs.add(animation, forKey: "transform.translation")
        }
        glove.position = local(model.0); dabs.position = local(model.0); hand.opacity = Float(model.1)
        glove.contents = image(model.2); dabs.contents = image(.dabs)
        CATransaction.commit()
    }
    // Sizes the panel (made on first use) to the points' box plus 48 pt clipped to the window, keeping the hand where it is on
    // screen. It never shows the panel.
    func layout(_ points: [CGPoint], clip: CGRect) -> Bool {
        let frame = handBox(points).intersection(clip)
        guard !frame.isNull, frame.width >= 1, frame.height >= 1, let last = points.last else { return false }
        let panel = self.panel ?? makeHandPanel(capture: capture)
        let screen = NSScreen.screens.first { NSPointInRect(NSPoint(x: last.x, y: appKitRect(CGRect(origin: last, size: .zero)).minY), $0.frame) }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let current = [glove, dabs].map { $0.map { global(($0.presentation() ?? $0).position) } }
        panel.setFrame(appKitRect(frame), display: false)
        box = frame
        if hand == nil {
            let hand = CALayer(), glove = CALayer(), dabs = CALayer()
            hand.opacity = 0
            for layer in [dabs, glove] {
                layer.bounds = CGRect(x: 0, y: 0, width: HandArt.canvas, height: HandArt.canvas); layer.anchorPoint = HandArt.anchor
                hand.addSublayer(layer)
            }
            panel.contentView?.layer?.addSublayer(hand)
            self.hand = hand; self.glove = glove; self.dabs = dabs
        }
        hand?.frame = CGRect(origin: .zero, size: frame.size)
        for (layer, point) in zip([glove, dabs], current) {
            guard let layer = layer else { continue }
            layer.contentsScale = screen?.backingScaleFactor ?? 2
            if let point = point { layer.removeAllAnimations(); layer.position = local(point) }
        }
        CATransaction.commit()
        self.panel = panel
        return true
    }
    func local(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x - box.minX, y: box.maxY - point.y) }
    func global(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x + box.minX, y: box.maxY - point.y) }
    // The idle fade: 300 ms to nothing while drifting 4 pt further back, then the panel is released.
    func fade(after delay: Double) {
        fading?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self, let hand = self.hand, let glove = self.glove else { self?.release(); return }
            let from = self.global((glove.presentation() ?? glove).position)
            var plan = HandPlan(position: HandTrack(from, mix: handMix), opacity: HandTrack(Double((hand.presentation() ?? hand).opacity), mix: handMixDouble),
                contents: HandTrack(self.shown, mix: { $2 < 1 ? $0 : $1 }))
            plan.position.move(to: self.fadeTo, at: 0, over: HandTiming.fade, curve: HandTiming.fadeCurve)
            plan.opacity.move(to: 0, at: 0, over: HandTiming.fade, curve: HandTiming.fadeCurve)
            self.apply(plan, model: (self.fadeTo, 0, self.shown))
            let done = DispatchWorkItem { [weak self] in self?.release() }
            self.fading = done
            DispatchQueue.main.asyncAfter(deadline: .now() + HandTiming.fade + HandTiming.trail, execute: done)
        }
        fading = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }
    func release() {
        ringRoot?.removeAllAnimations(); ringRoot?.removeFromSuperlayer(); ringRoot = nil; ringCursor = nil; ringLabel = nil; ringTether = nil
        panel?.orderOut(nil); panel?.close(); hand?.removeFromSuperlayer()
        panel = nil; hand = nil; glove = nil; dabs = nil; box = .null; fading = nil; shown = .rest
    }
    // --hand-demo X,Y,W,H plays every kind in turn inside that rect (global top-left points) for 30 seconds, then exits. It is
    // the live capture test's subject, and never reads stdin.
    func play(_ rect: CGRect) {
        let kinds = ["click", "double", "right", "key", "type", "drag", "scroll"]
        var step = 0
        let spot = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y) }
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            let kind = kinds[step % kinds.count], at = spot(0.25 + 0.25 * CGFloat(step % 3), 0.3 + 0.2 * CGFloat(step % 2))
            self?.draw(HandAct(seq: step, kind: kind, pid: 0, windowId: 0, at: at, path: kind == "drag" ? [spot(0.7, 0.6)] : [at],
                delay: 0, beats: kind == "type" ? 3 : 1), clip: rect)
            step += 1
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { exit(0) }
    }
}
// END HAND HOST

// BEGIN HAND DUMP
// --hand-dump prints the panel's flags, the art, the frame-to-state mapping, the timing table, each kind's plan and the box
// arithmetic as JSON for tests. Nothing is shown.
func handDump(capture: String) -> [String: Any] {
    let host = HandHost(), route = [CGPoint(x: 100, y: 100), CGPoint(x: 160, y: 200)]
    host.capture = capture
    let rect = { (r: CGRect) in [r.minX, r.minY, r.width, r.height].map { Double($0) } }
    let unclipped = handBox(route)
    _ = host.layout(route, clip: CGRect(x: 60, y: 0, width: 200, height: 200))
    let clipped = host.box
    guard let panel = host.panel, let hand = host.hand else { return [:] }
    let behaviours: [(NSWindow.CollectionBehavior, String)] = [(.canJoinAllSpaces, "canJoinAllSpaces"), (.fullScreenAuxiliary, "fullScreenAuxiliary"),
        (.fullScreenNone, "fullScreenNone"), (.fullScreenPrimary, "fullScreenPrimary"), (.ignoresCycle, "ignoresCycle"), (.managed, "managed"),
        (.moveToActiveSpace, "moveToActiveSpace"), (.participatesInCycle, "participatesInCycle"), (.stationary, "stationary"), (.transient, "transient")]
    let sharing: [NSWindow.SharingType: String] = [.none: "none", .readOnly: "readOnly"]
    // Per state at 2x: pixel size, the most alpha within 1 pt of the hotspot and within 1 pt of a point 4 pt up-left of it
    // (nothing reaches past the tip), and the opaque ivory and blue pixels.
    var art: [String: Any] = [:]
    for state in HandState.allCases {
        guard let image = HandArt.image(state, scale: 2), let small = HandArt.image(state, scale: 1) else { continue }
        let rep = NSBitmapImageRep(cgImage: image)
        func alpha(_ cx: Int, _ cy: Int) -> Double {
            var most = 0.0
            for x in (cx - 2)...(cx + 2) { for y in (cy - 2)...(cy + 2) { most = max(most, Double(rep.colorAt(x: x, y: y)?.alphaComponent ?? 0)) } }
            return most
        }
        var ivory = 0, blue = 0
        for x in 0..<rep.pixelsWide { for y in 0..<rep.pixelsHigh {
            guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), c.alphaComponent > 0.85 else { continue }
            if c.redComponent > 0.85 && c.greenComponent > 0.82 && c.blueComponent > 0.75 { ivory += 1 }
            if c.blueComponent > c.redComponent + 0.2 { blue += 1 }
        } }
        let tip = Int(HandArt.hotspot.x * 2)
        art[state.rawValue] = ["pixels": [[small.width, small.height], [image.width, image.height]], "hotspotAlpha": alpha(tip, tip),
            "beyondTipAlpha": alpha(tip - 8, tip - 8), "ivory": ivory, "blue": blue]
    }
    let t = HandTiming.self
    // Each kind's plan for the route above, entering fresh, and the content sequence it shows.
    var plans: [String: Any] = [:]
    for kind in ["click", "double", "right", "key", "type", "scroll", "drag"] {
        let act = HandAct(seq: 0, kind: kind, pid: 1, windowId: 1, at: route[1], path: kind == "drag" ? [CGPoint(x: 220, y: 200)] : route,
            delay: 0, beats: kind == "type" ? 8 : 1)
        let plan = handPlan(act, from: nil, secure: false), secure = handPlan(act, from: nil, secure: true)
        let states = plan.contents.values.map { $0.rawValue }.enumerated().filter { $0.offset == 0 || plan.contents.values[$0.offset - 1].rawValue != $0.element }.map { $0.element }
        plans[kind] = ["total": plan.total, "secureTotal": secure.total, "states": states,
            "rest": [Double(plan.rest.x), Double(plan.rest.y)], "fadeTo": [Double(plan.fadeTo.x), Double(plan.fadeTo.y)]]
    }
    let continuing = handPlan(HandAct(seq: 0, kind: "click", pid: 1, windowId: 1, at: route[1], path: [route[1]], delay: 0, beats: 1),
        from: (point: route[0], opacity: HandArt.lifted, state: .rest), secure: false)
    let dump: [String: Any] = [
        "panel": [
            "borderless": panel.styleMask.subtracting(.nonactivatingPanel).isEmpty, "nonactivatingPanel": panel.styleMask.contains(.nonactivatingPanel),
            "canBecomeKey": panel.canBecomeKey, "canBecomeMain": panel.canBecomeMain, "ignoresMouseEvents": panel.ignoresMouseEvents,
            "hasShadow": panel.hasShadow, "opaque": panel.isOpaque, "backgroundAlpha": Double(panel.backgroundColor.alphaComponent),
            "level": panel.level.rawValue, "sharingType": sharing[panel.sharingType] ?? "other",
            "collectionBehavior": behaviours.filter { panel.collectionBehavior.contains($0.0) }.map { $0.1 },
            "accessibilityElement": panel.isAccessibilityElement(), "contentAccessibilityElement": panel.contentView?.isAccessibilityElement() ?? true,
            "hidesOnDeactivate": panel.hidesOnDeactivate, "visible": panel.isVisible,
        ],
        "layers": (hand.sublayers ?? []).map { layer in ["isGlove": layer === host.glove, "isDabs": layer === host.dabs,
            "bounds": rect(layer.bounds), "anchor": [Double(layer.anchorPoint.x), Double(layer.anchorPoint.y)]] },
        "timing": ["entry": t.entry, "glideBase": t.glideBase, "glidePerPoint": t.glidePerPoint, "glideMax": t.glideMax, "flourish": t.flourish,
            "scroll": t.scroll, "grab": t.grab, "lift": t.lift, "silence": t.silence, "fade": t.fade, "crossfade": t.crossfade, "trail": t.trail,
            "entryOffset": Double(t.entryOffset), "hold": Double(t.hold), "liftOffset": Double(t.liftOffset), "fadeOffset": Double(t.fadeOffset),
            "scrollDrop": Double(t.scrollDrop), "typeStep": Double(t.typeStep), "pecks": t.pecks, "pressScale": t.pressScale,
            "grabScale": t.grabScale, "tilt": t.tilt, "glides": [0, 100, 400, 1000].map { t.glide(CGFloat($0)) },
            "ease": [0.0, 0.5, 1.0].map { handEase(t.out, $0) }],
        "states": HandArt.states.mapValues { [$0.approach.rawValue, $0.act.rawValue] },
        "art": art.merging(["opacity": HandArt.opacity, "lifted": HandArt.lifted, "canvas": Double(HandArt.canvas),
            "hotspot": [Double(HandArt.hotspot.x), Double(HandArt.hotspot.y)], "anchor": [Double(HandArt.anchor.x), Double(HandArt.anchor.y)],
            "axis": [Double(HandArt.axis.dx), Double(HandArt.axis.dy)]]) { $1 },
        "plans": plans, "continuing": ["total": continuing.total],
        "box": ["unclipped": rect(unclipped), "clipped": rect(clipped)],
        "capture": host.capture,
        "hookup": ["frames": hookupFrameCount, "rendered": (0..<hookupFrameCount).compactMap { glyphImage(hookupFrame(menuGlyph, $0)) }.count,
            "template": (0..<hookupFrameCount).allSatisfy { glyphImage(hookupFrame(menuGlyph, $0))?.isTemplate == true },
            "seconds": (Double(hookupFrameCount) * hookupInterval * 1000).rounded() / 1000],
    ]
    host.release()
    return dump.merging(["idle": host.idle]) { $1 }
}
// END HAND DUMP

// BEGIN PERCH DUMP
// --perch-dump [--reduce-motion] [--seed=N]: PerchRuntime and the ring's RingRuntime on a simulated clock, as the host drives
// them, with window lists the input injects. It builds no application, panel, window or layer and decodes nothing: plans
// come from the character frame's data. Lines: hand frames; {"dumpClock": s}; {"dumpWorld": {"windows": [{"id", "pid",
// "frame": [x, y, w, h], "fullScreen"?}] front to back, "displays"?: [{"frame", "top"}]}} (also a window check at that
// moment); {"dumpNarration": s} (a narration bubble for s seconds); {"dumpPaused": bool}; {"dumpClick": "hardware" |
// "synthetic" | "keyboard" | "old"} (a click on the bubble through the person-input rule).
extension PerchPlan {
    func json(_ cell: CGSize) -> [String: Any] {
        ["kind": kind, "duration": duration, "states": states, "zs": zs, "zsStill": zsStill, "reduced": reduced, "keyPaths": keyPaths(cell),
         "seat": ["x": seat.x, "edge": seat.edge, "peek": seat.peek, "rise": seat.rise, "window": seat.window],
         "cells": cells.map { [$0.time, $0.state, $0.entry.sheet, $0.entry.row, $0.column] as [Any] },
         "rects": cells.map { c -> [Double] in let r = PerchPlan.rect(c.entry, c.column, cell: cell); return [Double(r.minX), Double(r.minY), Double(r.width), Double(r.height)] },
         "positions": positions.map { [$0.0, Double($0.1.x), Double($0.1.y)] }, "opacity": opacity.map { [$0.0, $0.1] },
         "masked": masked.map { [$0.0, $0.1] as [Any] }]
    }
}
func perchDump(reduced: Bool, seed: UInt64) {
    var buffer = Data(), bound: String?, last = -1, clock = 0.0, enabled = true
    var ring = RingRuntime(theme: .seamPlus, seed: seed), perch = PerchRuntime()
    perch.seed = seed; perch.book.seed = seed
    var windows: [(id: UInt32, pid: Int32, frame: CGRect, fullScreen: Bool)] = []
    var displays: [(frame: CGRect, top: Double)] = [(CGRect(x: 0, y: 0, width: 1440, height: 900), 25)]
    func world(_ pid: Int32, _ window: UInt32) -> PerchWorld? {
        guard let i = windows.firstIndex(where: { $0.id == window }), windows[i].pid == pid else { return nil }
        let w = windows[i], edge = CGPoint(x: w.frame.midX, y: w.frame.minY)
        let d = displays.first(where: { $0.frame.contains(edge) }) ?? displays[0]
        return PerchWorld(window: w.frame, above: windows[..<i].map { $0.frame }, display: d.frame, top: d.top, fullScreen: w.fullScreen)
    }
    let env = PerchEnvironment(world: { world($0, $1) }, reduced: { reduced }, measure: perchMeasure)
    let ringEnv = RingEnvironment(bounds: { world($0, $1)?.window }, reduced: { reduced }, secure: { false })
    func write(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { exit(70) }
        FileHandle.standardOutput.write(data + Data([10]))
    }
    func emit(_ effects: [(Double, PerchEffect)]) {
        let cell = perch.frame?.cell ?? .zero
        for (time, effect) in effects {
            switch effect {
            case let .draw(plan): write(plan.json(cell).merging(["effect": "perch", "time": time]) { $1 })
            case let .hide(reason, duration): write(["effect": "perch-hide", "reason": reason, "duration": duration, "time": time])
            case .park: write(["effect": "perch-park", "time": time])
            case .still: write(["effect": "perch-still", "time": time])
            case let .line(line):
                let f = line.bubble.frame
                write(["effect": "line", "moment": line.moment, "text": line.text, "index": line.index, "until": line.until, "time": time,
                    "bubble": ["frame": [f.minX, f.minY, f.width, f.height], "side": line.bubble.side, "tail": [line.bubble.tail.x, line.bubble.tail.y]]])
            case let .lineOut(duration): write(["effect": "line-out", "duration": duration, "time": time])
            }
        }
    }
    func ringEmit(_ effects: [(Double, RingEffect)]) {
        for (time, effect) in effects {
            guard case let .draw(plan, _) = effect else { if case .hide = effect { write(["effect": "ring-hide", "time": time]) }; continue }
            write(["effect": "ring", "state": plan.state, "at": [plan.at.x, plan.at.y], "time": time])
            if enabled { emit(perch.receive(perchEvent(plan), now: time, env: env)) }
        }
    }
    func number(_ raw: Any?) -> Double? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }; return n.doubleValue
    }
    func rect(_ raw: Any?) -> CGRect? {
        guard let a = raw as? [Any], a.count == 4, let x = number(a[0]), let y = number(a[1]), let w = number(a[2]), let h = number(a[3]), w > 0, h > 0 else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }
    while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty {
            if !buffer.isEmpty { exit(65) }
            ringEmit(ring.advance(to: Double.greatestFiniteMagnitude, ringEnv))
            write(["effect": "end", "timers": perch.timers.map { $0.action }.sorted(), "shown": perch.shown, "asleep": perch.asleep,
                "poll": perch.poll as Any? ?? NSNull(), "moving": perch.moving != nil])
            return
        }
        buffer.append(chunk)
        guard buffer.count <= 131072 else { exit(65) }
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
            guard line.count <= 32768, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { exit(65) }
            if Set(data.keys) == ["dumpClock"] {
                guard let value = number(data["dumpClock"]), value >= clock else { exit(65) }
                clock = value
                ringEmit(ring.advance(to: clock, ringEnv)); emit(perch.advance(to: clock, env: env))
                continue
            }
            if Set(data.keys) == ["dumpWorld"] {
                guard let w = data["dumpWorld"] as? [String: Any], let list = w["windows"] as? [[String: Any]] else { exit(65) }
                windows = []
                for item in list {
                    guard let id = number(item["id"]), let pid = number(item["pid"]), let frame = rect(item["frame"]) else { exit(65) }
                    windows.append((UInt32(id), Int32(pid), frame, item["fullScreen"] as? Bool ?? false))
                }
                if let list = w["displays"] as? [[String: Any]] {
                    displays = list.compactMap { d in rect(d["frame"]).flatMap { f in number(d["top"]).map { (f, $0) } } }
                    guard displays.count == list.count, !displays.isEmpty else { exit(65) }
                }
                emit(perch.observe(clock, env: env)); continue
            }
            if Set(data.keys) == ["dumpNarration"] { guard let s = number(data["dumpNarration"]) else { exit(65) }; emit(perch.narration(until: clock + s, now: clock)); continue }
            if Set(data.keys) == ["dumpPaused"] { guard let p = data["dumpPaused"] as? Bool else { exit(65) }; perch.paused = p; continue }
            if Set(data.keys) == ["dumpClick"] {
                guard let kind = data["dumpClick"] as? String, let source = CGEventSource(stateID: .hidSystemState),
                    let cg = CGEvent(keyboardEventSource: source, virtualKey: 49, keyDown: true) else { exit(65) }
                cg.type = kind == "keyboard" ? .keyDown : .leftMouseUp
                cg.setIntegerValueField(.eventSourceUnixProcessID, value: kind == "synthetic" ? 1234 : 0)
                cg.setIntegerValueField(.eventSourceUserData, value: 0)
                cg.timestamp = DispatchTime.now().uptimeNanoseconds - (kind == "old" ? 6_000_000_000 : 0)
                let person = perchBubbleClick(NSEvent(cgEvent: cg), windowMatches: true), had = perch.line != nil
                write(["effect": "click", "kind": kind, "person": person, "dismissed": person && had, "time": clock])
                if person { emit(perch.dismiss(clock)) }
                continue
            }
            guard let frame = handFrame(data), let nonce = data["nonce"] as? String, bound == nil || bound == nonce else { exit(65) }
            bound = nonce
            let event: RingEvent, delay: Double
            switch frame {
            case let .picker(_, message):
                guard message.op == "options" else { continue }
                enabled = message.data["perch"] as? Bool ?? false
                perch.book.enabled = message.data["lines"] as? Bool ?? true
                if !enabled { emit(perch.hide(clock, "off")) }
                write(["effect": "options", "perch": enabled, "lines": perch.book.enabled, "time": clock]); continue
            case let .character(_, value):
                guard value.seq > last else { exit(65) }; last = value.seq
                perch.load(value)
                write(["effect": "character", "id": value.id, "perch": value.perch != nil, "lines": value.lines?.lines.values.map { $0.count }.reduce(0, +) ?? 0,
                    "metrics": perchMetrics(value).map { [Double($0.size.width), Double($0.size.height), Double($0.anchor.x), Double($0.anchor.y)] } as Any? ?? NSNull(), "time": clock])
                continue
            case let .act(_, act): event = ringEvent(act); delay = act.delay
            case let .aim(_, value), let .status(_, value): event = value; delay = 0
            case .hide: ringEmit(ring.hide(clock)); emit(perch.hide(clock, "hide")); continue
            case .menu: continue
            }
            guard event.seq > last else { exit(65) }
            last = event.seq
            ring.dissolveAt = enabled ? perch.dissolve(event) : nil
            if let palm = ring.dissolveAt { write(["effect": "dissolve", "at": [palm.x, palm.y], "time": clock]) }
            ringEmit(ring.receive(event, delay: delay, now: clock, ringEnv))
        }
    }
}
// END PERCH DUMP

// The launch styles in one place: glove, or a ring theme.
let ringThemes: [String: RingTheme] = ["ring": .seamPlus, "seam": .seam, "sprite": .seamPlus]
let cursorStyles = ["--cursor-style=glove"] + ringThemes.keys.sorted().map { "--cursor-style=" + $0 }
// A synchronous, bounded reader for plan tests. It never constructs an application, panel, view or layer. It drives the
// same RingRuntime as the host on a simulated clock. Only a {"dumpClock": seconds} line moves the clock, firing what falls
// due; frames between two clock lines land at the same moment, as a burst from the relay would. At the end of input the clock runs out and an "end"
// line reports whether anything is still pending.
// --time-plans prints each draw as its state and the milliseconds receive took, without the plan.
func ringPlanDump(theme: RingTheme?, reduced: Bool, secure: Bool, clip: CGRect, seed: UInt64, gone: Set<UInt32>, timed: Bool = false, sprite: Bool = false) {
    var buffer = Data(), bound: String?, last = -1, clock = 0.0
    var runtime = RingRuntime(theme: theme ?? .seamPlus, seed: seed)
    // The live host's loader. A finished load joins before the next line; {"dumpAwait":"character"} and the end of input
    // wait for the one in flight (real time, not the simulated clock).
    let loader = SpriteLoader(), finished = DispatchSemaphore(value: 0), slotLock = NSLock()
    var slot: (generation: Int, id: String, result: SpriteCharacter.Result)?, loading = false
    let env = RingEnvironment(bounds: { _, window in gone.contains(window) ? nil : clip }, reduced: { reduced }, secure: { secure })
    func write(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { exit(70) }
        FileHandle.standardOutput.write(data + Data([10]))
    }
    func joinFinished() {
        slotLock.lock(); let ready = slot; slot = nil; slotLock.unlock()
        guard let ready = ready, loader.isCurrent(ready.generation) else { return }
        loading = false; runtime.character = ready.result.character
        // selfMaxRss: this process's peak resident bytes so far (macOS reports bytes), without the decode child's.
        var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
        write(["effect": "character", "id": ready.id, "loaded": ready.result.character != nil, "reason": ready.result.reason as Any? ?? NSNull(),
            "warnings": ready.result.warnings, "time": clock, "selfMaxRss": usage.ru_maxrss])
    }
    func awaitLoad() { while loading { finished.wait(); joinFinished() } }
    func emit(_ effects: [(Double, RingEffect)], ms: Double? = nil) {
        for (time, effect) in effects {
            switch effect {
            case let .draw(plan, _) where timed: write(["effect": "draw", "state": plan.state, "time": time, "planMs": ms ?? -1])
            case let .draw(plan, frame): write(plan.json.merging(["effect": "draw", "time": time, "frame": [frame.minX, frame.minY, frame.width, frame.height]]) { $1 })
            case let .drop(state): write(["effect": "drop", "state": state, "dropped": true, "animations": [], "time": time])
            case .hide: write(["effect": "hide", "state": "hidden", "time": time])
            case .park: write(["effect": "park", "time": time])
            case let .fade(duration): write(["effect": "fade", "duration": duration, "time": time])
            case .release: write(["effect": "release", "time": time])
            }
        }
    }
    while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty {
            if !buffer.isEmpty { exit(65) }
            awaitLoad()
            if theme != nil { emit(runtime.advance(to: Double.greatestFiniteMagnitude, env)) }
            write(["effect": "end", "idle": runtime.idle, "pending": runtime.pending.count, "timers": runtime.timers.count])
            return
        }
        buffer.append(chunk)
        guard buffer.count <= 131072 else { exit(65) }
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
            let received = Date()
            joinFinished()
            guard line.count <= 32768, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                line.count <= 8192 || data["hand"] as? String == "character" else { exit(65) }
            if Set(data.keys) == ["dumpAwait"] { guard data["dumpAwait"] as? String == "character" else { exit(65) }; awaitLoad(); continue }
            if Set(data.keys) == ["dumpClock"] {
                guard let value = data["dumpClock"] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
                    value.doubleValue >= clock else { exit(65) }
                clock = value.doubleValue
                if theme != nil { emit(runtime.advance(to: clock, env)) }
                continue
            }
            guard let frame = handFrame(data), let nonce = data["nonce"] as? String, bound == nil || bound == nonce else { exit(65) }
            bound = nonce
            let event: RingEvent, delay: Double
            switch frame {
            case .picker: write(["effect": "drop", "state": "picker", "dropped": true, "animations": [], "time": clock]); continue
            case let .character(_, value):
                guard value.seq > last else { exit(65) }; last = value.seq
                runtime.character = nil
                guard sprite else {
                    loader.cancel(); loading = false
                    write(["effect": "character", "id": value.id, "loaded": false, "reason": NSNull(), "warnings": [], "time": clock]); continue
                }
                loading = true
                loader.start(value) { generation, result in
                    slotLock.lock(); slot = (generation, value.id, result); slotLock.unlock(); finished.signal()
                }
                // handleMs: what this line cost the dump's thread, the parse included (the live host's main thread does the same).
                write(["effect": "character-start", "id": value.id, "handleMs": Date().timeIntervalSince(received) * 1000, "time": clock]); continue
            case let .act(_, act): event = ringEvent(act); delay = act.delay
            case let .aim(_, value), let .status(_, value): event = value; delay = 0
            case .hide: emit(runtime.hide(clock)); continue
            case .menu: write(["effect": "drop", "state": "menu", "dropped": true, "animations": [], "time": clock]); continue
            }
            guard event.seq > last else { exit(65) }
            last = event.seq
            guard theme != nil else { write(["effect": "drop", "state": event.state, "dropped": true, "animations": [], "time": clock]); continue }
            let started = ProcessInfo.processInfo.systemUptime
            let effects = runtime.receive(event, delay: delay, now: clock, env)
            emit(effects, ms: (ProcessInfo.processInfo.systemUptime - started) * 1000)
        }
    }
}

// No arguments: the consent host. --hand [--capture=…] [--cursor-style=…] [--menu|--consent], --hand-demo X,Y,W,H
// [--capture=…] and --hand-dump [--capture=…]: the hand. With --consent the hand host is the session's shared host: turbo's
// consent channel runs on fds 3 (in) and 4 (out) beside the hand's stdin, and the menu bar glove serves both. --menu is the
// hand-only host: the glove and its hand-only menu, with no consent channel.
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--cursor-menu-dump" { guard arguments.count == 1 else { exit(64) }; cursorMenuDump(); exit(0) }
if arguments.first == "--decode-sheet" { spriteDecodeChild(Array(arguments.dropFirst())) }
// `--check-character`: one character frame on stdin, the same checks and decode child as the live host, one JSON line out
// (loaded, reason, warnings). `sleight-mcp cursor check` runs it so the user sees why a character shows the ring alone.
if arguments.first == "--check-character" {
    guard arguments.count == 1 else { exit(64) }
    var input = Data()
    while input.count <= 32768, case let chunk = FileHandle.standardInput.availableData, !chunk.isEmpty { input.append(chunk) }
    let line = input.split(separator: 10).first ?? Data()
    guard input.count <= 32769, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
        data["nonce"] as? String != nil, case let .character(_, frame)? = handFrame(data) else { exit(65) }
    let result = SpriteCharacter.check(frame)
    let out = try! JSONSerialization.data(withJSONObject: ["id": frame.id, "loaded": result.character != nil,
        "reason": result.reason as Any? ?? NSNull(), "warnings": result.warnings], options: [.sortedKeys])
    FileHandle.standardOutput.write(out + Data([10]))
    exit(0)
}
if arguments.first == "--perch-dump" {
    let flags = Array(arguments.dropFirst()), seeds = flags.filter { $0.hasPrefix("--seed=") }
    guard seeds.count <= 1, flags.allSatisfy({ $0 == "--reduce-motion" || $0.hasPrefix("--seed=") }), Set(flags).count == flags.count else { exit(64) }
    guard let seed = seeds.first.map({ UInt64($0.dropFirst(7)) }) ?? 1 else { exit(64) }
    perchDump(reduced: flags.contains("--reduce-motion"), seed: seed); exit(0)
}
if arguments.first == "--ring-plan-dump" {
    var flags = Array(arguments.dropFirst())
    func take(_ prefix: String) -> String?? {
        let found = flags.filter { $0.hasPrefix(prefix) }
        guard found.count <= 1 else { return nil }
        flags.removeAll { $0.hasPrefix(prefix) }
        return .some(found.first.map { String($0.dropFirst(prefix.count)) })
    }
    guard let rawClip = take("--clip="), let rawSeed = take("--seed="), let rawGone = take("--gone="), let rawStyle = take("--cursor-style=") else { exit(64) }
    let clip: CGRect
    if let raw = rawClip { guard let value = handDemoRect(raw) else { exit(64) }; clip = value } else { clip = CGRect(x: 0, y: 0, width: 1000, height: 1000) }
    let seed: UInt64
    if let raw = rawSeed { guard let value = UInt64(raw) else { exit(64) }; seed = value } else { seed = 1 }
    let gone = Set((rawGone ?? "").split(separator: ",").compactMap { UInt32($0) })
    guard rawGone == nil || gone.count == rawGone!.split(separator: ",", omittingEmptySubsequences: false).count else { exit(64) }
    guard rawStyle == nil || cursorStyles.contains("--cursor-style=" + rawStyle!), Set(flags).count == flags.count,
        flags.allSatisfy({ ["--reduce-motion", "--secure-input", "--time-plans"].contains($0) }) else { exit(64) }
    ringPlanDump(theme: rawStyle.flatMap { ringThemes[$0] }, reduced: flags.contains("--reduce-motion"), secure: flags.contains("--secure-input"),
        clip: clip, seed: seed, gone: gone, timed: flags.contains("--time-plans"), sprite: rawStyle == "sprite")
    exit(0)
}
// --confirm-person <key> [subject]: macOS's own Touch ID or password sheet for one high-stakes settings change, then exit with
// its PersonConfirmResult (0 only when the person passed it). Before the sheet it prints one JSON line, { path, sha256 }.
// Cancel, Ctrl-C, SIGTERM or 60 s withdraw the sheet. It opens no window of its own. --confirm-person-check prints the
// same first line and the reason the sheet would show, then exits, so tests never show a sheet.
var personSignals: [DispatchSourceSignal] = []
if arguments.first == "--confirm-person" || arguments.first == "--confirm-person-check" {
    guard let reason = personConfirmReason(Array(arguments.dropFirst())) else { exit(64) }
    // The first line names the file this process runs (proc_pidpath) and its SHA-256, which the launcher compares with
    // the private copy it wrote before it trusts the answer.
    var own = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(getpid(), &own, UInt32(own.count)) > 0 else { exit(70) }
    let ownPath = String(cString: own)
    guard let ownBytes = FileManager.default.contents(atPath: ownPath),
        let line = try? JSONSerialization.data(withJSONObject: ["path": ownPath,
            "sha256": SHA256.hash(data: ownBytes).map { String(format: "%02x", $0) }.joined()], options: [.sortedKeys, .withoutEscapingSlashes]) else { exit(70) }
    FileHandle.standardOutput.write(line + Data([10]))
    if arguments.first == "--confirm-person-check" { print(reason); exit(0) }
    let cancel = confirmPerson(reason, evaluator: localAuthentication()) { result in exit(result.rawValue) }
    for number in [SIGINT, SIGTERM, SIGHUP] {
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler { cancel() }
        source.resume(); personSignals.append(source)
    }
    dispatchMain()
}
let app = NSApplication.shared
if arguments.isEmpty {
    let host = ConsentHost()
    app.setActivationPolicy(.accessory)
    app.delegate = host
    app.run()
} else {
    let mode = arguments[0]
    var rest = Array(arguments.dropFirst()), demo: CGRect?
    if mode == "--hand-demo" { guard let first = rest.first, let rect = handDemoRect(first) else { exit(64) }; demo = rect; rest.removeFirst() }
    let consent = mode == "--hand" && rest.last == "--consent", menuOnly = mode == "--hand" && rest.last == "--menu"
    if consent { rest.removeLast(); guard fcntl(3, F_GETFD) != -1, fcntl(4, F_GETFD) != -1 else { exit(64) } }
    if menuOnly { rest.removeLast() }
    let styles = rest.filter { $0.hasPrefix("--cursor-style=") }
    guard styles.count <= 1, styles.allSatisfy({ cursorStyles.contains($0) }) else { exit(64) }
    let cursorStyle = styles.first.map { String($0.dropFirst(15)) } ?? "glove"
    rest.removeAll { $0.hasPrefix("--cursor-style=") }
    guard ["--hand", "--hand-demo", "--hand-dump"].contains(mode), let capture = handCapture(rest) else { exit(64) }
    if mode == "--hand-dump" {
        guard let bytes = try? JSONSerialization.data(withJSONObject: handDump(capture: capture), options: [.sortedKeys]) else { exit(70) }
        FileHandle.standardOutput.write(bytes + Data([10]))
        exit(0)
    }
    let hand = HandHost()
    hand.demo = demo; hand.capture = capture; hand.cursorStyle = cursorStyle
    hand.ringRuntime = RingRuntime(theme: ringThemes[cursorStyle] ?? .seamPlus, seed: UInt64.random(in: 1...UInt64.max))
    if consent || menuOnly {
        let host = ConsentHost()
        host.cursorPicker.rows = CursorPickerRow.defaults(cursorStyle)
        host.input = consent ? FileHandle(fileDescriptor: 3, closeOnDealloc: true) : nil
        if consent { host.output = FileHandle(fileDescriptor: 4, closeOnDealloc: true) }
        host.shared = true
        hand.consent = host
    }
    app.setActivationPolicy(.accessory)
    app.delegate = hand
    app.run()
}
